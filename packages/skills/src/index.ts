/**
 * @guppy/skills — distributed skills for the agent loop.
 *
 * `guppy skill install <name|url|path>` fetches a skill (builtin registry,
 * a URL, or a local `.md` file), validates it, and writes it to the per-user
 * skills dir (`~/.guppy/skills`) so it applies to every repo. `list` shows
 * installed + repo skills; `remove` deletes an installed skill. The session
 * manager loads user-level skills alongside repo skills at run time.
 */

export {
  defaultSkillsDir,
  installSkill,
  removeSkill,
  listInstalledSkills,
  renderSkillMarkdown,
} from './install.js';
export type {
  InstallOptions,
  InstallResult,
  InstalledSkill,
} from './install.js';
export {
  loadRegistry,
  resolveEntrySource,
} from './registry.js';
export type {
  SkillRegistry,
  SkillRegistryEntry,
  LoadedRegistry,
} from './registry.js';
export {
  BUILTIN_REGISTRY,
  BUILTIN_SKILLS,
} from './builtin.js';
export type { BuiltinSkillDef } from './builtin.js';
