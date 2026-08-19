/**
 * Context Engine — Dynamic context selection with cache-aware packing
 * Core differentiator: "What should the agent see right now?"
 */

import type {
  Context,
  FileContent,
  TestResult,
  ErrorInfo,
  Memory,
  Skill,
  Task,
  ULID,
  Timestamp,
  Result,
} from '@guppy/contracts';
import { now, ok } from '@guppy/contracts';
import { encoding_for_model } from 'tiktoken';

export { loadSkills, saveSkill, parseSkillMarkdown, slug, skillId, isValidSkillName } from './skills.js';
export type { ParsedSkill } from './skills.js';

export interface ContextEngineConfig {
  maxTokens: number;
  systemPromptTokens: number;
  cacheBoundaryTokens: number; // Anthropic: ~1024, OpenAI: ~1024
  repoMapTokens: number;
}

export interface RepoMap {
  files: Map<string, FileSummary>;
  dependencies: Map<string, string[]>;
  symbols: Map<string, SymbolInfo>;
}

export interface FileSummary {
  path: string;
  language: string;
  lines: number;
  exports: string[];
  imports: string[];
  hash: string;
}

export interface SymbolInfo {
  name: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'const';
  file: string;
  line: number;
  signature: string;
}

const DEFAULT_CONFIG: ContextEngineConfig = {
  maxTokens: 100_000,
  systemPromptTokens: 8_000,
  cacheBoundaryTokens: 1_024,
  repoMapTokens: 10_000,
};

export class ContextEngine {
  private config: ContextEngineConfig;
  private repoMap: RepoMap | null = null;
  /** tiktoken encoder is expensive to construct — cache it across calls. */
  private cachedEncoder: ReturnType<typeof encoding_for_model> | null = null;

  constructor(config: Partial<ContextEngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Main Entry Point
  // ---------------------------------------------------------------------------

  selectContext(input: ContextSelectionInput): Result<Context, Error> {
    const {
      task,
      availableFiles,
      testResults,
      errors,
      memories,
      skills,
      previousContext,
    } = input;

    const selectedFiles = this.selectFiles(task, availableFiles, testResults, errors, previousContext);
    const selectedMemories = this.selectMemories(task, memories, errors);
    const selectedSkills = this.selectSkills(task, skills, availableFiles);

    const filesTokenCount = this.estimateTokens(selectedFiles.map(f => f.content).join('\n'));
    const memoriesTokenCount = this.estimateTokens(JSON.stringify(selectedMemories));
    const skillsTokenCount = this.estimateTokens(JSON.stringify(selectedSkills));
    const testTokensCount = this.estimateTokens(JSON.stringify(testResults));
    const errorsTokenCount = this.estimateTokens(JSON.stringify(errors));

    const availableForContext = this.config.maxTokens - this.config.systemPromptTokens;

    // Pack with cache awareness
    const packed = this.packWithCacheAwareness({
      task,
      files: selectedFiles,
      testResults,
      errors,
      memories: selectedMemories,
      skills: selectedSkills,
      repoMap: this.repoMap,
      availableTokens: availableForContext,
    });

    const context: Context = {
      taskId: task.id,
      sessionId: ulid(),
      files: packed.files,
      testResults: packed.testResults,
      errors: packed.errors,
      memories: packed.memories,
      skills: packed.skills,
      tokensUsed: packed.totalTokens,
      maxTokens: this.config.maxTokens,
      selectedAt: now(),
      selectionReasoning: packed.reasoning,
    };

    return ok(context);
  }

  // ---------------------------------------------------------------------------
  // File Selection
  // ---------------------------------------------------------------------------

  private selectFiles(
    task: Task,
    availableFiles: FileContent[],
    testResults: TestResult[],
    errors: ErrorInfo[],
    previousContext?: Context
  ): FileContent[] {
    const scored = availableFiles.map(file => ({
      file,
      score: this.scoreFile(file, task, testResults, errors, previousContext),
    }));

    scored.sort((a, b) => b.score - a.score);

    // Always include files with errors
    const errorFiles = new Set(errors.map(e => e.file).filter(Boolean));
    const mustInclude = availableFiles.filter(f => errorFiles.has(f.path));

    // Add high-scoring files until token budget
    let tokens = this.estimateTokens(mustInclude.map(f => f.content).join('\n'));
    const selected = [...mustInclude];

    for (const { file, score } of scored) {
      if (selected.some(f => f.path === file.path)) continue;
      if (score < 0.3) break; // Threshold

      const fileTokens = this.estimateTokens(file.content);
      if (tokens + fileTokens > this.config.maxTokens * 0.7) break;

      selected.push(file);
      tokens += fileTokens;
    }

    return selected;
  }

  private scoreFile(
    file: FileContent,
    task: Task,
    testResults: TestResult[],
    errors: ErrorInfo[],
    previousContext?: Context
  ): number {
    let score = 0;

    // Direct error relevance
    if (errors.some(e => e.file === file.path)) score += 10;

    // Test failure relevance
    const failedTests = testResults.filter(t => t.status === 'failed');
    for (const test of failedTests) {
      if (test.file && this.pathsRelated(file.path, test.file)) score += 5;
      if (test.output?.includes(file.path)) score += 3;
    }

    // Task keyword matching
    const taskKeywords = this.extractKeywords(task.description);
    const fileKeywords = this.extractKeywords(file.content);
    const overlap = taskKeywords.filter(k => fileKeywords.includes(k)).length;
    score += overlap * 2;

    // Previous context continuity
    if (previousContext?.files.some(f => f.path === file.path)) score += 3;

    // File type relevance
    if (file.path.endsWith('.test.ts') || file.path.endsWith('.spec.ts')) score += 2;
    if (file.path.includes('test') || file.path.includes('spec')) score += 1;

    // Recency in conversation (would be tracked in real impl)
    // score += recencyScore;

    return score;
  }

  private pathsRelated(path1: string, path2: string): boolean {
    const dir1 = path1.split('/').slice(0, -1).join('/');
    const dir2 = path2.split('/').slice(0, -1).join('/');
    return dir1 === dir2 || dir1.startsWith(dir2) || dir2.startsWith(dir1);
  }

  private extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      // Strip markdown/punctuation too: a task mentioning \u0060clamp\u0060
      // (backticked) must produce the keyword "clamp", not "\u0060clamp\u0060",
      // or skill/tag matching silently misses every backticked identifier.
      .split(/[\s\(\)\{\}\[\];,.\u0060]+/)
      .filter(w => w.length > 3)
      .slice(0, 50);
  }

  // ---------------------------------------------------------------------------
  // Memory & Skill Selection
  // ---------------------------------------------------------------------------

  private selectMemories(task: Task, memories: Memory[], errors: ErrorInfo[]): Memory[] {
    const taskKeywords = this.extractKeywords(task.description);
    const errorMessages = errors.map(e => e.message).join(' ');

    return memories
      .map(m => ({
        memory: m,
        relevance: this.calculateMemoryRelevance(m, taskKeywords, errorMessages),
      }))
      .filter(({ relevance }) => relevance > 0.4)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 10)
      .map(({ memory }) => memory);
  }

  private calculateMemoryRelevance(memory: Memory, taskKeywords: string[], errorText: string): number {
    let relevance = 0;
    const memoryText = `${memory.summary} ${JSON.stringify(memory.detail)}`.toLowerCase();

    for (const kw of taskKeywords) {
      if (memoryText.includes(kw)) relevance += 0.1;
    }

    if (errorText && memoryText.includes(errorText.toLowerCase().slice(0, 50))) {
      relevance += 0.5;
    }

    // Boost recent memories
    const ageHours = (Date.now() - memory.createdAt) / (1000 * 60 * 60);
    if (ageHours < 24) relevance += 0.2;
    if (ageHours < 1) relevance += 0.3;

    return Math.min(relevance, 1);
  }

  private selectSkills(task: Task, skills: Skill[], availableFiles: FileContent[]): Skill[] {
    const filePaths = new Set(availableFiles.map(f => f.path));
    const taskKeywords = this.extractKeywords(task.description);

    return skills
      .map(s => ({
        skill: s,
        relevance: this.calculateSkillRelevance(s, taskKeywords, filePaths),
      }))
      .filter(({ relevance }) => relevance > 0.3)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 5)
      .map(({ skill }) => skill);
  }

  private calculateSkillRelevance(skill: Skill, taskKeywords: string[], filePaths: Set<string>): number {
    let relevance = 0;
    const skillText = `${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase();

    for (const kw of taskKeywords) {
      if (skillText.includes(kw)) relevance += 0.15;
    }

    // Tag matching
    for (const tag of skill.tags) {
      if (taskKeywords.includes(tag)) relevance += 0.2;
    }

    return Math.min(relevance, 1);
  }

  // ---------------------------------------------------------------------------
  // Cache-Aware Packing
  // ---------------------------------------------------------------------------

  private packWithCacheAwareness(input: PackInput): PackResult {
    const {
      task,
      files,
      testResults,
      errors,
      memories,
      skills,
      repoMap,
      availableTokens,
    } = input;

    // Build sections in priority order for cache efficiency
    // Static sections first (system prompt, repo map) - these benefit from prefix caching
    // Dynamic sections last (current files, errors, test results)

    const sections: PackSection[] = [
      {
        name: 'repo-map',
        priority: 1, // Static - cache friendly
        tokens: repoMap ? this.estimateTokens(this.formatRepoMap(repoMap)) : 0,
        content: repoMap ? this.formatRepoMap(repoMap) : '',
        include: !!repoMap && this.config.repoMapTokens < availableTokens * 0.2,
      },
      {
        name: 'skills',
        priority: 2, // Semi-static
        tokens: this.estimateTokens(this.formatSkills(skills)),
        content: this.formatSkills(skills),
        include: skills.length > 0,
      },
      {
        name: 'memories',
        priority: 3, // Dynamic but stable
        tokens: this.estimateTokens(this.formatMemories(memories)),
        content: this.formatMemories(memories),
        include: memories.length > 0,
      },
      {
        name: 'task',
        priority: 4, // Always include
        tokens: this.estimateTokens(task.description),
        content: `TASK: ${task.description}`,
        include: true,
      },
      {
        name: 'errors',
        priority: 5, // High priority, dynamic
        tokens: this.estimateTokens(this.formatErrors(errors)),
        content: this.formatErrors(errors),
        include: errors.length > 0,
      },
      {
        name: 'tests',
        priority: 6, // High priority, dynamic
        tokens: this.estimateTokens(this.formatTestResults(testResults)),
        content: this.formatTestResults(testResults),
        include: testResults.length > 0,
      },
      {
        name: 'files',
        priority: 7, // Most dynamic, largest
        tokens: this.estimateTokens(this.formatFiles(files)),
        content: this.formatFiles(files),
        include: files.length > 0,
      },
    ];

    // Sort by priority (static first for cache)
    sections.sort((a, b) => a.priority - b.priority);

    // Pack within token budget
    let totalTokens = 0;
    const included: PackSection[] = [];
    const excluded: string[] = [];
    // Mirror of the packing decision: only the files actually included in the
    // packed context should be returned, otherwise `context.files` disagrees
    // with `tokensUsed` (and blows the budget it claims to respect).
    let packedFiles: FileContent[] = [];

    for (const section of sections) {
      if (!section.include) {
        excluded.push(section.name);
        continue;
      }

      if (totalTokens + section.tokens <= availableTokens) {
        included.push(section);
        totalTokens += section.tokens;
        if (section.name === 'files') packedFiles = files;
      } else if (section.name === 'files' && totalTokens < availableTokens * 0.9) {
        // Truncate large file sections to fit the remaining budget.
        const remaining = availableTokens - totalTokens;
        const truncated = this.truncateFiles(files, remaining);
        if (truncated.length > 0) {
          const content = this.formatFiles(truncated);
          const tokens = this.estimateTokens(content);
          included.push({ ...section, tokens, content });
          totalTokens += tokens;
          packedFiles = truncated;
        } else {
          excluded.push(section.name);
        }
      } else {
        excluded.push(section.name);
      }
    }

    // Align to cache boundary
    const alignedTokens = Math.ceil(totalTokens / this.config.cacheBoundaryTokens) * this.config.cacheBoundaryTokens;

    return {
      files: packedFiles,
      testResults,
      errors,
      memories,
      skills,
      totalTokens: alignedTokens,
      reasoning: `Included: ${included.map(s => s.name).join(', ')}. Excluded: ${excluded.join(', ')}. Cache-aligned to ${alignedTokens} tokens.`,
    };
  }

  private truncateFiles(files: FileContent[], maxTokens: number): FileContent[] {
    // Keep most relevant files, truncate content of less relevant
    const sorted = [...files].sort((a, b) => b.content.length - a.content.length);
    let tokens = 0;
    const result: FileContent[] = [];

    for (const file of sorted) {
      const fileTokens = this.estimateTokens(file.content);
      if (tokens + fileTokens <= maxTokens) {
        result.push(file);
        tokens += fileTokens;
      } else if (tokens < maxTokens * 0.8) {
        // Truncate this file
        const remaining = maxTokens - tokens;
        // Estimate chars from tokens (rough inverse of estimateTokens)
        const chars = Math.floor(remaining * 3.5);
        const truncatedContent = file.content.slice(0, chars) + '\n... [truncated]';
        // Verify token count
        const truncatedTokens = this.estimateTokens(truncatedContent);
        if (tokens + truncatedTokens <= maxTokens) {
          result.push({
            ...file,
            content: truncatedContent,
          });
        }
        break;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  private formatRepoMap(repoMap: RepoMap): string {
    const lines = ['=== REPOSITORY MAP ==='];
    for (const [path, summary] of repoMap.files) {
      lines.push(`${path} (${summary.lines} lines) exports: ${summary.exports.join(', ') || 'none'}`);
    }
    return lines.join('\n');
  }

  private formatSkills(skills: Skill[]): string {
    if (skills.length === 0) return '';
    return ['=== SKILLS ===', ...skills.map(s => `- ${s.name}: ${s.description}`)].join('\n');
  }

  private formatMemories(memories: Memory[]): string {
    if (memories.length === 0) return '';
    return ['=== MEMORIES ===', ...memories.map(m => `- [${m.type}] ${m.summary}`)].join('\n');
  }

  private formatErrors(errors: ErrorInfo[]): string {
    if (errors.length === 0) return '';
    return ['=== ERRORS ===', ...errors.map(e => `- ${e.file}:${e.line} ${e.message}`)].join('\n');
  }

  private formatTestResults(tests: TestResult[]): string {
    if (tests.length === 0) return '';
    return ['=== TEST RESULTS ===', ...tests.map(t => `- ${t.name}: ${t.status}`)].join('\n');
  }

  private formatFiles(files: FileContent[]): string {
    if (files.length === 0) return '';
    return ['=== FILES ===', ...files.map(f => `--- ${f.path} ---\n${f.content}`)].join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private estimateTokens(text: string): number {
    try {
      if (!this.cachedEncoder) {
        this.cachedEncoder = encoding_for_model('gpt-4');
      }
      return this.cachedEncoder.encode(text).length;
    } catch {
      // Fallback to rough estimate if tiktoken fails
      return Math.ceil(text.length / 3.5);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setRepoMap(repoMap: RepoMap): void {
    this.repoMap = repoMap;
  }

  getRepoMap(): RepoMap | null {
    return this.repoMap;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContextSelectionInput {
  task: Task;
  availableFiles: FileContent[];
  testResults: TestResult[];
  errors: ErrorInfo[];
  memories: Memory[];
  skills: Skill[];
  previousContext?: Context;
}

interface PackInput {
  task: Task;
  files: FileContent[];
  testResults: TestResult[];
  errors: ErrorInfo[];
  memories: Memory[];
  skills: Skill[];
  repoMap: RepoMap | null;
  availableTokens: number;
}

interface PackSection {
  name: string;
  priority: number;
  tokens: number;
  content: string;
  include: boolean;
}

interface PackResult {
  files: FileContent[];
  testResults: TestResult[];
  errors: ErrorInfo[];
  memories: Memory[];
  skills: Skill[];
  totalTokens: number;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function ulid(): ULID {
  return crypto.randomUUID() as ULID;
}