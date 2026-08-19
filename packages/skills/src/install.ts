/**
 * Distributed skills — install, list, and remove skills for every repo.
 *
 * Installed skills live in the per-user directory (`~/.guppy/skills`, or
 * `$GUPPY_SKILLS_DIR`) so they follow the user across repos — the distributed
 * counterpart to the per-repo `<repo>/.guppy/skills` authoring flow. The
 * session manager loads both, with repo skills winning name collisions.
 *
 * A skill file is the same markdown + front-matter format `saveSkill` writes,
 * plus two provenance keys the installer appends:
 *
 *   ---
 *   name: code-review
 *   description: Self-review checklist before declaring a task done
 *   tags: review, quality
 *   source: builtin
 *   installed-at: 2026-08-19T...
 *   ---
 *   <prompt body>
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSkillMarkdown, isValidSkillName, slug, skillId, type ParsedSkill } from '@guppy/context-engine';
import type { Skill } from '@guppy/contracts';
import { loadRegistry, resolveEntrySource, type SkillRegistryEntry } from './registry.js';

/** Per-user skills dir; override with `GUPPY_SKILLS_DIR` (hermetic tests, CI). */
export function defaultSkillsDir(): string {
  return process.env['GUPPY_SKILLS_DIR'] ?? join(homedir(), '.guppy', 'skills');
}

export interface InstallOptions {
  /** Target directory (default: the per-user skills dir). */
  dir?: string;
  /** Registry manifest: URL, path, or inline JSON (default: the builtin registry). */
  registry?: string;
  /** Overwrite an already-installed skill with the same name. */
  force?: boolean;
}

export interface InstallResult {
  skill: Skill;
  /** Absolute path of the written file. */
  file: string;
  /** Where the skill came from (`builtin`, a URL, or a path). */
  source: string;
  /** ISO install timestamp. */
  installedAt: string;
}

export interface InstalledSkill {
  skill: Skill;
  /** Absolute path of the skill file. */
  file: string;
  /** Provenance: `builtin`, a URL, or a path. */
  source?: string;
  /** Provenance: ISO install timestamp. */
  installedAt?: string;
}

/** The canonical on-disk skill format: front-matter (+ provenance) + body. */
export function renderSkillMarkdown(parsed: ParsedSkill, provenance: { source: string; installedAt: string }): string {
  const tags = parsed.tags.filter((t) => t !== '');
  return [
    '---',
    `name: ${parsed.name}`,
    `description: ${parsed.description.replace(/\s+/g, ' ')}`,
    tags.length > 0 ? `tags: ${tags.join(', ')}` : null,
    `source: ${provenance.source}`,
    `installed-at: ${provenance.installedAt}`,
    '---',
    '',
    parsed.prompt,
    '',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

interface ResolvedSkill {
  /** Raw markdown to parse (URL/path sources). */
  content?: string;
  /** Pre-parsed skill (builtin sources carry their fields directly). */
  parsed?: ParsedSkill;
  provenance: string;
}

/**
 * Resolve `source` (a URL, local `.md` path, or registry name) to skill
 * content. Builtin registry entries short-circuit to a parsed skill; URL and
 * path sources return raw markdown for the caller to validate.
 */
async function resolveSkillContent(
  source: string,
  opts: { registry?: string; dir: string },
): Promise<ResolvedSkill> {
  // A direct URL to a skill file.
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Failed to fetch ${source}: HTTP ${res.status} ${res.statusText}`);
    return { content: await res.text(), provenance: source };
  }
  // A local skill file.
  if (existsSync(source)) {
    return { content: readFileSync(source, 'utf8'), provenance: source };
  }
  // Otherwise: a registry entry name (builtin registry by default).
  const { registry, baseDir } = await loadRegistry(opts.registry);
  const wanted = source.trim().toLowerCase();
  const entry: SkillRegistryEntry | undefined = registry.skills.find(
    (e) => e.name.toLowerCase() === wanted || slug(e.name) === slug(source),
  );
  if (!entry) {
    const available = registry.skills.map((e) => e.name).join(', ');
    throw new Error(
      `Unknown skill "${source}"${registry.name ? ` in registry "${registry.name}"` : ''}. Available: ${available || '(none)'}. ` +
        'Install by name, by URL (https://...), or by path to a .md file.',
    );
  }
  if (entry.source === 'builtin') {
    const { builtinSkillBody } = await import('./builtin.js');
    const body = builtinSkillBody(entry.name);
    if (body === null) {
      throw new Error(`Registry entry "${entry.name}" is marked builtin but has no bundled body`);
    }
    return {
      parsed: {
        name: entry.name,
        description: entry.description,
        prompt: body,
        tags: entry.tags ?? [],
      },
      provenance: 'builtin',
    };
  }
  const resolved = await resolveEntrySource(entry, baseDir);
  return { content: resolved.content, provenance: resolved.source };
}

/**
 * Install a skill into `dir` (default: the per-user skills dir). `source` is a
 * registry name, an `https://` URL to a `.md` skill file, or a local path to
 * one. Returns the installed skill + file path; throws on invalid content,
 * unknown names, or an existing same-name skill (unless `--force`).
 */
export async function installSkill(source: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const dir = opts.dir ?? defaultSkillsDir();
  const resolved = await resolveSkillContent(source, {
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    dir,
  });
  const { provenance } = resolved;

  const parsed = resolved.parsed ?? parseSkillMarkdown(resolved.content ?? '');
  if (!parsed) {
    throw new Error(`Not a valid skill file: missing "---" front-matter with name and description keys`);
  }
  if (!isValidSkillName(parsed.name)) {
    throw new Error(
      `Invalid skill name ${JSON.stringify(parsed.name)} in the source file — use letters, digits, spaces, - and _`,
    );
  }
  if (parsed.prompt === '') {
    throw new Error(`Skill "${parsed.name}" has an empty prompt body — nothing to teach the agent`);
  }

  const file = join(dir, `${slug(parsed.name)}.md`);
  if (existsSync(file) && !opts.force) {
    throw new Error(`Skill "${parsed.name}" is already installed at ${file} — pass --force to overwrite`);
  }

  const installedAt = new Date().toISOString();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, renderSkillMarkdown(parsed, { source: provenance, installedAt }), 'utf8');

  return {
    skill: {
      id: skillId(parsed.name),
      name: parsed.name,
      description: parsed.description,
      prompt: parsed.prompt,
      tags: parsed.tags,
      version: 1,
    },
    file,
    source: provenance,
    installedAt,
  };
}

/**
 * Remove an installed skill by name (slug-matched). Throws when it is not
 * installed in `dir`; the caller can decide whether that is fatal.
 */
export function removeSkill(name: string, opts: { dir?: string } = {}): string {
  const dir = opts.dir ?? defaultSkillsDir();
  const file = join(dir, `${slug(name)}.md`);
  if (!existsSync(file)) {
    throw new Error(`Skill "${name}" is not installed in ${dir} (tried ${file})`);
  }
  rmSync(file);
  return file;
}

/** List installed skills in `dir`, sorted by name, with provenance. */
export function listInstalledSkills(opts: { dir?: string } = {}): InstalledSkill[] {
  const dir = opts.dir ?? defaultSkillsDir();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const installed: InstalledSkill[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = join(dir, entry.name);
    try {
      const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'));
      if (!parsed) continue;
      installed.push({
        skill: {
          id: skillId(parsed.name),
          name: parsed.name,
          description: parsed.description,
          prompt: parsed.prompt,
          tags: parsed.tags,
          version: 1,
        },
        file,
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.installedAt ? { installedAt: parsed.installedAt } : {}),
      });
    } catch {
      // Skip unreadable/malformed files.
    }
  }
  return installed.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
}
