/**
 * Skills loader + producer + selection tests.
 *
 * Covers the checklist's unit acceptance: loader (valid/invalid/empty dirs),
 * the saveSkill producer round-trip, and selection (a skill is packed into
 * the context when the task description matches its description/tags).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, ulid, type Skill, type Task } from '@guppy/contracts';
import { ContextEngine, loadSkills, saveSkill } from '../src/index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir; harmless.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-skills-'));
  tmpDirs.push(dir);
  return dir;
}

const VALID_SKILL = `---
name: run-tests
description: Always run npm test and wait for green before declaring done
tags: test, typescript
---
Run \`npm test\` from the repo root and only declare done once the suite is green.
`;

function makeTask(description: string): Task {
  return {
    id: ulid(),
    description,
    repoPath: '/tmp/fake',
    tags: [],
    verificationLevel: 3,
    createdAt: now(),
    metadata: {},
  };
}

describe('loadSkills', () => {
  it('loads valid markdown skill files', () => {
    const dir = join(tempDir(), 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run-tests.md'), VALID_SKILL, 'utf8');

    const skills = loadSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'run-tests',
      description: 'Always run npm test and wait for green before declaring done',
      tags: ['test', 'typescript'],
      version: 1,
    });
    expect(skills[0]!.prompt).toContain('npm test');
    expect(skills[0]!.id).toBe('skill-run-tests');
  });

  it('returns [] for a missing directory', () => {
    expect(loadSkills(join(tempDir(), 'does-not-exist'))).toEqual([]);
  });

  it('returns [] for an empty directory', () => {
    const dir = join(tempDir(), 'empty');
    mkdirSync(dir, { recursive: true });
    expect(loadSkills(dir)).toEqual([]);
  });

  it('skips malformed and non-markdown files without throwing', () => {
    const dir = join(tempDir(), 'mixed');
    mkdirSync(dir, { recursive: true });
    // Missing front-matter
    writeFileSync(join(dir, 'no-frontmatter.md'), 'just a body\n', 'utf8');
    // Missing description
    writeFileSync(join(dir, 'no-desc.md'), '---\nname: x\n---\nbody\n', 'utf8');
    // Unclosed front-matter
    writeFileSync(join(dir, 'unclosed.md'), '---\nname: y\ndescription: d\n', 'utf8');
    // Not markdown
    writeFileSync(join(dir, 'notes.txt'), VALID_SKILL, 'utf8');

    expect(loadSkills(dir)).toEqual([]);
  });
});

describe('saveSkill (producer)', () => {
  it('writes a file that loadSkills reads back identically', () => {
    const dir = join(tempDir(), 'roundtrip');
    const skill = saveSkill(dir, {
      name: 'my-skill',
      description: 'Some repo ritual',
      prompt: 'Do the ritual.',
      tags: ['ritual'],
    });

    expect(skill).toMatchObject({
      id: 'skill-my-skill',
      name: 'my-skill',
      tags: ['ritual'],
    });

    const reloaded = loadSkills(dir);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toEqual(skill);
  });

  it('rejects invalid names and empty descriptions', () => {
    const dir = join(tempDir(), 'invalid');
    expect(() => saveSkill(dir, { name: '../evil', description: 'd' })).toThrow(/Invalid skill name/);
    expect(() => saveSkill(dir, { name: 'ok', description: '   ' })).toThrow(/requires a description/);
  });
});

describe('ContextEngine skill selection', () => {
  it('packs a skill into the context when the task matches its tags', () => {
    const dir = join(tempDir(), 'selection');
    const skill = saveSkill(dir, {
      name: 'clamp-fix',
      description: 'The correct clamp implementation uses Math.min(Math.max(v, min), max)',
      tags: ['clamp', 'math'],
    });

    const engine = new ContextEngine();
    const result = engine.selectContext({
      task: makeTask('Fix the failing clamp test in src/math.ts.'),
      availableFiles: [],
      testResults: [],
      errors: [],
      memories: [],
      skills: [skill],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.map((s) => s.id)).toContain('skill-clamp-fix');
  });

  it('does not pack an irrelevant skill', () => {
    const skill: Skill = {
      id: 'skill-deploy' as any,
      name: 'deploy',
      description: 'How to ship the docs site',
      prompt: 'Run npm run deploy.',
      tags: ['deploy', 'docs'],
      version: 1,
    };

    const engine = new ContextEngine();
    const result = engine.selectContext({
      task: makeTask('Fix the failing clamp test in src/math.ts.'),
      availableFiles: [],
      testResults: [],
      errors: [],
      memories: [],
      skills: [skill],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills).toHaveLength(0);
  });
});
