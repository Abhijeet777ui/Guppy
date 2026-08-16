/**
 * Repo skills — the loader + producer behind the `skills` story.
 *
 * A skill is a markdown file in `<repo>/.guppy/skills/<name>.md` with a small
 * front-matter block and a prompt body:
 *
 *   ---
 *   name: run-tests
 *   description: How to run the test suite in this repo
 *   tags: test, typescript
 *   ---
 *   Always run `npm test` and wait for green before declaring done.
 *
 * `loadSkills` reads the directory (missing/malformed files are skipped);
 * `saveSkill` writes a validated file and returns the in-memory `Skill`. The
 * context engine's `selectSkills` then picks the relevant ones per task.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill, ULID } from '@guppy/contracts';

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  );
}

/** Stable, name-derived id (branded as ULID; deterministic across loads). */
function skillId(name: string): ULID {
  return `skill-${slug(name)}` as ULID;
}

interface ParsedSkill {
  name: string;
  description: string;
  prompt: string;
  tags: string[];
}

/** Parse a `.md` skill file: `---` front-matter (`key: value` lines) + body. */
function parseSkillMarkdown(content: string): ParsedSkill | null {
  const lines = content.split(/\r?\n/);
  if (lines.length < 2 || lines[0]!.trim() !== '---') return null;

  const fields: Record<string, string> = {};
  let i = 1;
  let closed = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') {
      i++;
      closed = true;
      break;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  if (!closed) return null;

  const name = fields['name'];
  const description = fields['description'];
  if (!name || !description) return null;

  return {
    name,
    description,
    prompt: lines.slice(i).join('\n').trim(),
    tags: (fields['tags'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
  };
}

/** Read all valid skills from a directory. Missing dirs → []. */
export function loadSkills(skillsDir: string): Skill[] {
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try {
      const parsed = parseSkillMarkdown(readFileSync(join(skillsDir, entry.name), 'utf-8'));
      if (!parsed) continue;
      skills.push({
        id: skillId(parsed.name),
        name: parsed.name,
        description: parsed.description,
        prompt: parsed.prompt,
        tags: parsed.tags,
        version: 1,
      });
    } catch {
      // Skip unreadable/malformed files.
    }
  }
  return skills;
}

/**
 * Write a validated skill file and return the in-memory `Skill`. Throws on an
 * invalid name or a missing description.
 */
export function saveSkill(
  skillsDir: string,
  input: { name: string; description: string; prompt?: string; tags?: string[] },
): Skill {
  const name = input.name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(name)) {
    throw new Error(`Invalid skill name ${JSON.stringify(name)} — use letters, digits, spaces, - and _`);
  }
  const description = input.description.trim().replace(/\s+/g, ' ');
  if (description === '') throw new Error('saveSkill requires a description');
  const prompt = (input.prompt ?? '').trim();
  const tags = (input.tags ?? []).map((t) => t.trim()).filter((t) => t !== '');

  mkdirSync(skillsDir, { recursive: true });
  const content = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    tags.length > 0 ? `tags: ${tags.join(', ')}` : null,
    '---',
    '',
    prompt,
    '',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
  writeFileSync(join(skillsDir, `${slug(name)}.md`), content, 'utf-8');

  return { id: skillId(name), name, description, prompt, tags, version: 1 };
}
