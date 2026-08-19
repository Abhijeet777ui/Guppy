/**
 * Skill registries — where `guppy skill install` resolves skills from.
 *
 * A registry is a JSON manifest:
 *
 *   {
 *     "name": "my-skills",
 *     "skills": [
 *       { "name": "code-review", "description": "...", "tags": ["review"], "source": "https://example.com/code-review.md" }
 *     ]
 *   }
 *
 * `source` is one of:
 *   - `builtin`        — a skill bundled with guppy (only in the builtin registry)
 *   - `https://...`    — a URL to a `.md` skill file
 *   - a path           — a local `.md` file; relative paths resolve against the
 *                        registry manifest's own directory, so a registry can
 *                        be a folder of skill files with a manifest.
 *
 * `loadRegistry(ref)`:
 *   - omitted        -> the builtin registry bundled with guppy
 *   - https://...    -> fetched over the network (bounded timeout)
 *   - a path         -> read from disk (JSON)
 *   - inline JSON    -> parsed directly (handy for scripts)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface SkillRegistryEntry {
  name: string;
  description: string;
  tags?: string[];
  version?: number;
  /** `builtin` | `https://...` | path to a `.md` skill file. */
  source: string;
}

export interface SkillRegistry {
  name?: string;
  skills: SkillRegistryEntry[];
}

export interface LoadedRegistry {
  registry: SkillRegistry;
  /** Directory relative sources resolve against (undefined for builtin/URL registries). */
  baseDir?: string;
}

const FETCH_TIMEOUT_MS = 15_000;

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function parseManifest(text: string, label: string): SkillRegistry {
  const parsed = JSON.parse(text) as Partial<SkillRegistry>;
  if (!Array.isArray(parsed.skills) || parsed.skills.length === 0) {
    throw new Error(`Registry ${label} has no "skills" array`);
  }
  for (const entry of parsed.skills) {
    if (typeof entry?.name !== 'string' || entry.name === '') {
      throw new Error(`Registry ${label} has an entry without a "name"`);
    }
    if (typeof entry?.description !== 'string' || entry.description === '') {
      throw new Error(`Registry ${label} entry "${entry?.name ?? '?'}" has no "description"`);
    }
    if (typeof entry?.source !== 'string' || entry.source === '') {
      throw new Error(`Registry ${label} entry "${entry.name}" has no "source"`);
    }
  }
  return {
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    skills: parsed.skills,
  };
}

/**
 * Load a registry manifest. `ref` omitted -> builtin; https:// -> fetch;
 * an existing path -> read from disk; otherwise treated as inline JSON.
 */
export async function loadRegistry(ref?: string): Promise<LoadedRegistry> {
  if (ref === undefined || ref === '') {
    return { registry: (await import('./builtin.js')).BUILTIN_REGISTRY };
  }
  if (/^https?:\/\//.test(ref)) {
    const text = await fetchText(ref);
    return { registry: parseManifest(text, ref) };
  }
  if (existsSync(ref)) {
    const text = readFileSync(ref, 'utf8');
    return {
      registry: parseManifest(text, ref),
      baseDir: dirname(resolve(ref)),
    };
  }
  // Not a URL and not a path — try inline JSON (for scripts).
  try {
    return { registry: parseManifest(ref, 'inline') };
  } catch {
    throw new Error(`Cannot load registry from ${JSON.stringify(ref)}: not a URL, file, or JSON manifest`);
  }
}

/** Resolve an entry's `source` to concrete markdown. Returns the content + provenance. */
export async function resolveEntrySource(
  entry: SkillRegistryEntry,
  baseDir?: string,
): Promise<{ content: string; source: string }> {
  if (entry.source === 'builtin') {
    const { builtinSkillBody } = await import('./builtin.js');
    const body = builtinSkillBody(entry.name);
    if (body === null) {
      throw new Error(`Registry entry "${entry.name}" is marked builtin but has no bundled body`);
    }
    return { content: body, source: 'builtin' };
  }
  if (/^https?:\/\//.test(entry.source)) {
    return { content: await fetchText(entry.source), source: entry.source };
  }
  if (isAbsolute(entry.source)) {
    return { content: readFileSync(entry.source, 'utf8'), source: entry.source };
  }
  if (baseDir) {
    const file = resolve(baseDir, entry.source);
    return { content: readFileSync(file, 'utf8'), source: file };
  }
  throw new Error(
    `Registry entry "${entry.name}" has a relative source "${entry.source}" but the registry has no file location to resolve against`,
  );
}
