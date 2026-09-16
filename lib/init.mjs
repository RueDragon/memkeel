import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLES } from './layout.mjs';
import { CONFIG_SCHEMA_VERSION } from './config.mjs';
import { atomicJson } from './transport.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Creates an empty, ready-to-use memory home plus store. Nothing is published into
// any agent host here: that is `setup.mjs`'s job, so a user can initialise a store
// without touching any agent configuration.
//
// Everything is idempotent. Existing files are reported, never overwritten.
export function initStore({ home, store, obsidianCli = '', vaultName = '' }) {
  const created = [];
  const existing = [];

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, 'backups'), { recursive: true });

  // The policy documents live in the memory home; `setup` publishes them onward.
  for (const name of ['bootstrap.md', 'event-schema.md']) {
    const target = path.join(home, name);
    if (fs.existsSync(target)) { existing.push(target); continue; }
    fs.copyFileSync(path.join(packageRoot, name), target);
    created.push(target);
  }

  const configPath = path.join(home, 'config.json');
  if (fs.existsSync(configPath)) existing.push(configPath);
  else {
    atomicJson(configPath, {
      version: '1.0.0',
      configSchema: CONFIG_SCHEMA_VERSION,
      memoryRoot: store,
      layout: 'neutral',
      roles: { ...DEFAULT_ROLES, root: store },
      storage: obsidianCli ? 'obsidian-cli' : 'filesystem',
      vaultRoot: store,
      vaultName,
      obsidianCli,
      policyRoot: home,
      activeLimit: 6,
      recentLimit: 6,
      recentDays: 14,
      budgetBytes: 14000,
      workspaceAliases: {},
      hook: { codexDeferAdvisory: true },
      topics: [],
      catalogTopics: [],
    });
    created.push(configPath);
  }

  // Directory roles only, plus the habits note that `doctor` requires. The other
  // note-shaped roles (actions, mistakes, candidates, experience) are created by the
  // consolidator on first use, so a fresh store holds no empty placeholders that look
  // like reviewed content.
  const dirs = [store, path.join(store, DEFAULT_ROLES.eventsRoot), path.join(store, DEFAULT_ROLES.topicsRoot), path.join(store, DEFAULT_ROLES.inboxRoot), path.join(store, DEFAULT_ROLES.projectRoot)];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) existing.push(dir);
    else { fs.mkdirSync(dir, { recursive: true }); created.push(dir); }
  }

  // Manual habits belong above the managed marker; the block after it is regenerated
  // from confirmed decisions, so seeding it empty is the correct initial state.
  const habits = path.join(store, DEFAULT_ROLES.habitsNote);
  if (fs.existsSync(habits)) existing.push(habits);
  else {
    fs.mkdirSync(path.dirname(habits), { recursive: true });
    fs.writeFileSync(habits, [
      '---',
      'type: habits',
      'scope: global',
      '---',
      '',
      '# Habits',
      '',
      'Only confirmed habits bind an agent, and each one needs an explicit user quote.',
      'Write manual rules above the managed marker.',
      '',
      '<!-- AUTO-MANAGED:START -->',
      '```json',
      '{ "version": 1, "rules": [] }',
      '```',
      '<!-- AUTO-MANAGED:END -->',
      '',
    ].join('\n'), 'utf8');
    created.push(habits);
  }

  return { home, store, configPath, created, existing };
}
