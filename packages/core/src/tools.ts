/**
 * Guppy's native tool set.
 *
 * The model gets a small, safe set of workspace tools. Every tool executes
 * through Guppy's own WorkspaceManager (path containment enforced there), so
 * the agent cannot escape the worktree. No pi, no prime.
 */

import type { ULID } from '@guppy/contracts';
import type { WorkspaceManager } from '@guppy/workspace';
import type { ToolDefinition } from './openai-client.js';

export interface ToolExecution {
  output: string;
  error?: string;
  /** Set when the tool mutated a file, so the runtime can emit FileChanged. */
  fileChanged?: { path: string; operation: 'create' | 'modify' | 'delete' };
  /** Set when a tool mutated several files at once (e.g. apply_patch). */
  filesChanged?: Array<{ path: string; operation: 'create' | 'modify' | 'delete' }>;
}

export interface GuppyTool {
  name: string;
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, workspaceId: ULID): Promise<ToolExecution>;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

export function buildGuppyTools(workspaceManager: WorkspaceManager): GuppyTool[] {
  return [
    {
      name: 'read_file',
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from the workspace.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Repo-relative file path.' } },
            required: ['path'],
          },
        },
      },
      async execute(args, workspaceId) {
        const path = stringArg(args, 'path');
        if (!path) return { output: '', error: 'read_file requires a string `path`' };
        const result = await workspaceManager.readFile(workspaceId, path);
        if (!result.ok) return { output: '', error: result.error.message };
        return { output: result.value };
      },
    },
    {
      name: 'write_file',
      definition: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Create or overwrite a file in the workspace.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Repo-relative file path.' },
              content: { type: 'string', description: 'Full file content.' },
            },
            required: ['path', 'content'],
          },
        },
      },
      async execute(args, workspaceId) {
        const path = stringArg(args, 'path');
        const content = stringArg(args, 'content');
        if (!path) return { output: '', error: 'write_file requires a string `path`' };
        const result = await workspaceManager.writeFile(workspaceId, path, content);
        if (!result.ok) return { output: '', error: result.error.message };
        return { output: `wrote ${path}`, fileChanged: { path, operation: 'modify' } };
      },
    },
    {
      name: 'list_files',
      definition: {
        type: 'function',
        function: {
          name: 'list_files',
          description: 'List workspace files matching a glob pattern.',
          parameters: {
            type: 'object',
            properties: {
              pattern: {
                type: 'string',
                description: 'Glob pattern (default `**/*`).',
              },
            },
          },
        },
      },
      async execute(args, workspaceId) {
        const pattern = stringArg(args, 'pattern') || '**/*';
        const result = await workspaceManager.listFiles(workspaceId, pattern);
        if (!result.ok) return { output: '', error: result.error.message };
        const paths = result.value.map((f) => f.path);
        return { output: JSON.stringify(paths, null, 2) };
      },
    },
    {
      name: 'run_command',
      definition: {
        type: 'function',
        function: {
          name: 'run_command',
          description: 'Run a command in the workspace (e.g. tests or a build).',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'array',
                items: { type: 'string' },
                description: 'Command argv, e.g. ["npm","test"].',
              },
            },
            required: ['command'],
          },
        },
      },
      async execute(args, workspaceId) {
        const command = Array.isArray(args['command']) &&
          (args['command'] as unknown[]).every((c) => typeof c === 'string')
          ? (args['command'] as string[])
          : [];
        if (command.length === 0) {
          return { output: '', error: 'run_command requires a non-empty string[] `command`' };
        }
        const result = await workspaceManager.exec(workspaceId, command);
        if (!result.ok) return { output: '', error: result.error.message };
        const { exitCode, stdout, stderr } = result.value;
        const output = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() || `(exit ${exitCode})`;
        if (exitCode !== 0) return { output, error: `command exited with code ${exitCode}` };
        return { output };
      },
    },
    {
      name: 'search',
      definition: {
        type: 'function',
        function: {
          name: 'search',
          description: 'Search file contents with ripgrep (regex-capable). Returns `path:line:match` lines.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search pattern (ripgrep regex syntax).' },
              path: { type: 'string', description: 'Optional subdirectory to search (default: whole workspace).' },
              glob: { type: 'string', description: 'Optional file glob, e.g. "*.ts".' },
            },
            required: ['query'],
          },
        },
      },
      async execute(args, workspaceId) {
        const query = stringArg(args, 'query');
        if (!query) return { output: '', error: 'search requires a string `query`' };
        const result = await workspaceManager.search(workspaceId, query, {
          ...(stringArg(args, 'path') ? { path: stringArg(args, 'path') } : {}),
          ...(stringArg(args, 'glob') ? { glob: stringArg(args, 'glob') } : {}),
        });
        if (!result.ok) return { output: '', error: result.error.message };
        return { output: result.value };
      },
    },
    {
      name: 'apply_patch',
      definition: {
        type: 'function',
        function: {
          name: 'apply_patch',
          description: 'Apply a unified diff to one or more workspace files. Prefer this over write_file for targeted edits.',
          parameters: {
            type: 'object',
            properties: {
              patch: {
                type: 'string',
                description: 'Unified diff with ---/+++ headers and @@ hunks; use /dev/null for new or deleted files.',
              },
            },
            required: ['patch'],
          },
        },
      },
      async execute(args, workspaceId) {
        const patch = stringArg(args, 'patch');
        if (!patch) return { output: '', error: 'apply_patch requires a string `patch`' };
        const result = await workspaceManager.applyPatch(workspaceId, patch);
        if (!result.ok) return { output: '', error: result.error.message };
        return {
          output: `patched ${result.value.files.length} file(s): ${result.value.files.map((f) => f.path).join(', ')}`,
          filesChanged: result.value.files,
        };
      },
    },
    {
      name: 'git_status',
      definition: {
        type: 'function',
        function: {
          name: 'git_status',
          description: 'Show uncommitted changes in the worktree (git repositories only).',
          parameters: { type: 'object', properties: {} },
        },
      },
      async execute(_args, workspaceId) {
        const result = await workspaceManager.gitStatus(workspaceId);
        if (!result.ok) return { output: '', error: result.error.message };
        return { output: result.value };
      },
    },
    {
      name: 'git_diff',
      definition: {
        type: 'function',
        function: {
          name: 'git_diff',
          description: 'Show the current uncommitted diff in the worktree (git repositories only).',
          parameters: { type: 'object', properties: {} },
        },
      },
      async execute(_args, workspaceId) {
        const result = await workspaceManager.gitDiff(workspaceId);
        if (!result.ok) return { output: '', error: result.error.message };
        return { output: result.value };
      },
    },
  ];
}
