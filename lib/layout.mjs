import path from 'node:path';

// Logical roles are the contract; physical paths are configuration. A config may
// express either the modern `roles` block or the legacy flat keys, and both resolve
// to the same canonical role map. Legacy keys stay readable so existing vaults and
// tests keep working byte-for-byte without a migration.
export const DEFAULT_ROLES = Object.freeze({
  root: '',
  eventsRoot: 'events',
  topicsRoot: 'topics',
  habitsNote: 'habits.md',
  actionsNote: 'actions.md',
  mistakesNote: 'mistakes.md',
  candidatesNote: 'candidates.md',
  experienceNote: 'experience.md',
  inboxRoot: 'digest',
  projectRoot: 'projects',
});

// Maps a canonical role to the legacy config key it used to live under.
const LEGACY_KEYS = Object.freeze({
  eventsRoot: 'eventsRoot',
  topicsRoot: 'projectRoot',
  habitsNote: 'habitsNote',
  actionsNote: 'actionsNote',
  mistakesNote: 'mistakesNote',
  candidatesNote: 'preferenceCandidatesNote',
  experienceNote: 'experienceNote',
  inboxRoot: 'inboxRoot',
  projectRoot: 'projectRoot',
});

const POSIX = (value) => String(value).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');

export function normalizeLayout(config = {}) {
  const configured = config.roles && typeof config.roles === 'object' ? config.roles : {};
  const legacy = config.layout && config.layout !== 'neutral' ? {} : {};
  const roles = { ...DEFAULT_ROLES, ...legacy };
  for (const [role, legacyKey] of Object.entries(LEGACY_KEYS)) {
    const explicit = configured[role];
    if (typeof explicit === 'string' && explicit.trim()) { roles[role] = POSIX(explicit); continue; }
    const fromLegacy = config[legacyKey];
    if (typeof fromLegacy === 'string' && fromLegacy.trim()) roles[role] = POSIX(fromLegacy);
  }
  // topicsRoot is the directory that holds topic pages; callers historically used
  // projectRoot for both workspace notes and topic pages, so both roles receive it.
  if (configured.topicsRoot !== undefined) roles.topicsRoot = POSIX(configured.topicsRoot);
  else if (configured.projectRoot === undefined && roles.projectRoot) roles.topicsRoot = roles.projectRoot;
  if (configured.projectRoot !== undefined) roles.projectRoot = POSIX(configured.projectRoot);
  else if (configured.topicsRoot !== undefined) roles.projectRoot = roles.topicsRoot;
  if (typeof config.memoryRoot === 'string' && config.memoryRoot.trim()) roles.root = POSIX(config.memoryRoot);
  return roles;
}

export function applyLayout(config = {}) {
  const roles = normalizeLayout(config);
  return {
    ...config,
    roles,
    layout: config.layout ?? 'obsidian-notion',
    // Canonical accessors used by new code paths.
    role: (name) => {
      const value = roles[name];
      if (value === undefined) throw new Error(`Unknown memory role: ${name}`);
      return value;
    },
    // Legacy aliases kept populated for backward compatibility.
    workRoot: config.workRoot ?? path.posix.dirname(roles.habitsNote),
    projectRoot: roles.projectRoot,
    inboxRoot: roles.inboxRoot,
    eventsRoot: roles.eventsRoot,
    habitsNote: roles.habitsNote,
    actionsNote: roles.actionsNote,
    mistakesNote: roles.mistakesNote,
    preferenceCandidatesNote: roles.candidatesNote,
    experienceNote: roles.experienceNote,
  };
}

// Resolves a role name to an absolute path inside the vault root.
export function rolePath(config, name) {
  const roles = config.roles ?? normalizeLayout(config);
  const value = roles[name];
  if (value === undefined) throw new Error(`Unknown memory role: ${name}`);
  if (name === 'root' || value === '') return config.vaultRoot;
  return path.join(config.vaultRoot, value.replaceAll('/', path.sep));
}
