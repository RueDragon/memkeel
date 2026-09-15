import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditMemorySkill } from '../lib/entry-audit.mjs';
import { sha } from '../lib/transport.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-entry-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const policy = path.join(home, '.memkeel');
  fs.mkdirSync(path.join(policy, 'state'), { recursive: true });
  fs.mkdirSync(path.join(policy, 'backups'), { recursive: true });
  return { home, policy };
}
test('retired definitions do not activate a skill, active definitions are detected in ZCode too', (t) => {
  const { home, policy } = fixture(t);
  const dir = path.join(home, '.zcode/skills/obsidian-memory-first');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.retired.md'), 'archived');
  assert.equal(auditMemorySkill(home, policy).retired, true);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'active');
  const result = auditMemorySkill(home, policy);
  assert.equal(result.retired, false);
  assert.equal(result.activeDefinitions.length, 1);
});
test('retirement authorizes only exact skill files with verified archives', (t) => {
  const { home, policy } = fixture(t);
  const source = path.join(home, '.codex/skills/obsidian-memory-first/SKILL.md');
  const backup = path.join(policy, 'backups/skill.md');
  fs.writeFileSync(backup, 'old skill');
  const manifest = { files: [{ source, backup, sha256: sha('old skill') }] };
  fs.writeFileSync(path.join(policy, 'state/retired-memory-skill.json'), JSON.stringify(manifest));
  assert.deepEqual(auditMemorySkill(home, policy).archivedSources, [path.resolve(source).toLowerCase()]);
  fs.writeFileSync(backup, 'modified');
  assert.equal(auditMemorySkill(home, policy).retired, false);
  manifest.files[0] = { source: path.join(home, 'user-notes.md'), backup, sha256: sha('modified') };
  fs.writeFileSync(path.join(policy, 'state/retired-memory-skill.json'), JSON.stringify(manifest));
  assert.equal(auditMemorySkill(home, policy).archivedSources.length, 0);
});
test('retirement rejects archive paths outside the backup directory', (t) => {
  const { home, policy } = fixture(t);
  const backup = path.join(home, 'outside.md'); fs.writeFileSync(backup, 'old');
  fs.writeFileSync(path.join(policy, 'state/retired-memory-skill.json'), JSON.stringify({ files: [{
    source: path.join(home, '.agents/skills/obsidian-memory-first/SKILL.md'), backup, sha256: sha('old') }] }));
  assert.equal(auditMemorySkill(home, policy).retired, false);
});
test('publishing twice preserves host rules, yields four adapters and never regenerates retired skills', (t) => {
  const { home, policy } = fixture(t);
  fs.writeFileSync(path.join(policy, 'bootstrap.md'), '# Shared Agent Policy v1.0.0\nNo separate memory skill prerequisite.\n');
  fs.mkdirSync(path.join(home, '.zcode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zcode/AGENTS.md'), 'Keep ZCode local log paths.\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), DSH_HOME: path.join(home, '.dsh') };
  const guard = 'import os from "node:os"; if(os.homedir() !== ' + JSON.stringify(home) + ') throw Error("Unsafe test home"); await import(' + JSON.stringify(new URL('../publish.mjs', import.meta.url).href) + ');';
  const run = (...args) => spawnSync(process.execPath, ['--input-type=module', '-e', guard, '--', ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).map(r => r.agent), ['codex', 'zcode', 'claude', 'dsh']);
  const second = run(); assert.equal(second.status, 0, second.stderr);
  assert.ok(JSON.parse(second.stdout).every(r => !r.changed));
  const check = run('--check'); assert.equal(check.status, 0, check.stderr);
  assert.ok(JSON.parse(check.stdout).every(r => r.matches));
  assert.match(fs.readFileSync(path.join(home, '.zcode/AGENTS.md'), 'utf8'), /Keep ZCode local log paths/);
  for (const dir of ['.agents', '.codex', '.zcode', '.claude', '.dsh']) {
    assert.equal(fs.existsSync(path.join(home, dir, 'skills/obsidian-memory-first/SKILL.md')), false);
  }
});
