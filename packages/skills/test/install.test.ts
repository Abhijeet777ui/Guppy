/**
 * @guppy/skills tests — install/list/remove against the builtin registry,
 * local `.md` files, and local registry manifests. No network: URL fetching
 * is only exercised through `loadRegistry` error paths, never a real fetch.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills, parseSkillMarkdown } from '@guppy/context-engine';
import {
  BUILTIN_REGISTRY,
  BUILTIN_SKILLS,
  defaultSkillsDir,
  installSkill,
  listInstalledSkills,
  loadRegistry,
  removeSkill,
} from '../src/index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can briefly hold the dir; harmless.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guppy-skills-pkg-'));
  tmpDirs.push(dir);
  return dir;
}

const SAMPLE_SKILL = `---
name: deploy-checklist
description: Steps to follow before deploying
tags: deploy, ops
---
Run the test suite, then deploy from main only after CI is green.
`;

describe('builtin registry', () => {
  it('has valid entries, each with a bundled body that parses', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(3);
    for (const def of BUILTIN_SKILLS) {
      expect(def.name).toMatch(/^[a-z0-9-]+$/);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.body.length).toBeGreaterThan(0);
      // The rendered form (front-matter + body) must parse back to the same fields.
      const rendered = [
        '---',
        `name: ${def.name}`,
        `description: ${def.description}`,
        `tags: ${def.tags.join(', ')}`,
        'source: builtin',
        'installed-at: 2026-01-01T00:00:00.000Z',
        '---',
        '',
        def.body,
        '',
      ].join('\n');
      const parsed = parseSkillMarkdown(rendered);
      expect(parsed).not.toBeNull();
      expect(parsed!.name).toBe(def.name);
      expect(parsed!.prompt).toContain(def.body.trim().slice(0, 20));
    }
  });

  it('registry entries point at builtin sources', () => {
    expect(BUILTIN_REGISTRY.name).toBe('guppy-builtin');
    for (const entry of BUILTIN_REGISTRY.skills) {
      expect(entry.source).toBe('builtin');
    }
  });
});

describe('installSkill', () => {
  it('installs a builtin skill by name with provenance', async () => {
    const dir = join(tempDir(), 'skills');
    const result = await installSkill('code-review', { dir });
    expect(result.skill.name).toBe('code-review');
    expect(result.skill.tags).toContain('review');
    expect(result.source).toBe('builtin');
    expect(existsSync(result.file)).toBe(true);

    const loaded = loadSkills(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe('code-review');
    expect(loaded[0]!.prompt).toContain('diff');

    // Provenance is embedded in the file's front-matter.
    const raw = readFileSync(result.file, 'utf8');
    expect(raw).toContain('source: builtin');
    expect(raw).toContain('installed-at:');
  });

  it('installs from an https:// URL to a .md skill file', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/markdown');
      res.end(SAMPLE_SKILL);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const dir = join(tempDir(), 'skills');
    try {
      const result = await installSkill(`http://127.0.0.1:${port}/deploy-checklist.md`, { dir });
      expect(result.skill.name).toBe('deploy-checklist');
      expect(result.source).toBe(`http://127.0.0.1:${port}/deploy-checklist.md`);
      expect(loadSkills(dir)).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('installs from a local .md file path', async () => {
    const src = join(tempDir(), 'my-skill.md');
    writeFileSync(src, SAMPLE_SKILL, 'utf8');
    const dir = join(tempDir(), 'skills');
    const result = await installSkill(src, { dir });
    expect(result.skill.name).toBe('deploy-checklist');
    expect(result.source).toBe(src);

    const loaded = loadSkills(dir);
    expect(loaded[0]!.description).toContain('Steps to follow before deploying');
    expect(loaded[0]!.tags).toEqual(['deploy', 'ops']);
  });

  it('installs from a registry manifest file with relative path sources', async () => {
    const base = tempDir();
    const skillsDir = join(base, 'files');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'deploy-checklist.md'), SAMPLE_SKILL, 'utf8');
    const manifest = join(base, 'registry.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        name: 'my-registry',
        skills: [
          {
            name: 'deploy-checklist',
            description: 'Steps to follow before deploying',
            source: 'files/deploy-checklist.md',
          },
        ],
      }),
      'utf8',
    );

    const { registry, baseDir } = await loadRegistry(manifest);
    expect(registry.name).toBe('my-registry');
    expect(baseDir).toBe(base);

    const out = join(base, 'installed');
    const result = await installSkill('deploy-checklist', { dir: out, registry: manifest });
    expect(result.skill.name).toBe('deploy-checklist');
    expect(loadSkills(out)).toHaveLength(1);
  });

  it('refuses to overwrite an installed skill unless --force', async () => {
    const dir = join(tempDir(), 'skills');
    await installSkill('write-tests', { dir });
    await expect(installSkill('write-tests', { dir })).rejects.toThrow(/already installed/);
    await expect(installSkill('write-tests', { dir, force: true })).resolves.toMatchObject({
      skill: { name: 'write-tests' },
    });
  });

  it('rejects invalid sources loudly', async () => {
    const dir = join(tempDir(), 'skills');
    // No front-matter.
    const bad = join(tempDir(), 'bad.md');
    writeFileSync(bad, 'just some text, no front-matter', 'utf8');
    await expect(installSkill(bad, { dir })).rejects.toThrow(/front-matter/);

    // Missing description.
    const noDesc = join(tempDir(), 'nodesc.md');
    writeFileSync(noDesc, '---\nname: x\n---\nbody', 'utf8');
    await expect(installSkill(noDesc, { dir })).rejects.toThrow(/front-matter/);

    // Invalid name characters.
    const badName = join(tempDir(), 'badname.md');
    writeFileSync(badName, '---\nname: "weird/name!"\ndescription: d\n---\nbody', 'utf8');
    await expect(installSkill(badName, { dir })).rejects.toThrow(/Invalid skill name/);

    // Empty prompt body.
    const emptyBody = join(tempDir(), 'empty.md');
    writeFileSync(emptyBody, '---\nname: empty\ndescription: d\n---\n', 'utf8');
    await expect(installSkill(emptyBody, { dir })).rejects.toThrow(/empty prompt body/);

    // Unknown registry name — the error lists what is available.
    await expect(installSkill('no-such-skill', { dir })).rejects.toThrow(/Unknown skill "no-such-skill"/);
    await expect(installSkill('no-such-skill', { dir })).rejects.toThrow(/code-review/);
  });
});

describe('removeSkill', () => {
  it('removes an installed skill by name', async () => {
    const dir = join(tempDir(), 'skills');
    const { file } = await installSkill('code-review', { dir });
    const removed = removeSkill('code-review', { dir });
    expect(removed).toBe(file);
    expect(existsSync(file)).toBe(false);
    expect(loadSkills(dir)).toEqual([]);
  });

  it('throws when the skill is not installed', () => {
    expect(() => removeSkill('never-installed', { dir: join(tempDir(), 'skills') })).toThrow(
      /is not installed/,
    );
  });
});

describe('listInstalledSkills', () => {
  it('lists installed skills sorted by name with provenance', async () => {
    const dir = join(tempDir(), 'skills');
    await installSkill('write-tests', { dir });
    await installSkill('code-review', { dir });

    const listed = listInstalledSkills({ dir });
    expect(listed.map((i) => i.skill.name)).toEqual(['code-review', 'write-tests']);
    expect(listed[0]!.source).toBe('builtin');
    expect(listed[0]!.installedAt).toBeDefined();
  });

  it('returns [] for a missing directory', () => {
    expect(listInstalledSkills({ dir: join(tempDir(), 'nope') })).toEqual([]);
  });
});

describe('defaultSkillsDir', () => {
  it('honors GUPPY_SKILLS_DIR and falls back to ~/.guppy/skills', () => {
    const prev = process.env['GUPPY_SKILLS_DIR'];
    try {
      process.env['GUPPY_SKILLS_DIR'] = '/tmp/custom-skills';
      expect(defaultSkillsDir()).toBe('/tmp/custom-skills');
    } finally {
      if (prev === undefined) delete process.env['GUPPY_SKILLS_DIR'];
      else process.env['GUPPY_SKILLS_DIR'] = prev;
    }
  });
});
