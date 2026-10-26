#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { record, consolidate } from '../lib/core.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { generatorSmoke } from '../lib/knowledge/generator-smoke.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--home') throw new Error('Usage: node scripts/accept-knowledge-local.mjs --home HOME');
const original = loadConfig(args[1]).config;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-local-accept-'));
const identity = `accept-${Date.now()}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relative = `${original.projectRoot}/knowledge-upgrade-acceptance/${identity}`;
const config = { vaultRoot: original.vaultRoot, memoryRoot: original.vaultRoot, vaultName: original.vaultName,
  obsidianCli: original.obsidianCli, storage: original.storage, policyRoot: scratch,
  eventsRoot: `${relative}/events`, projectRoot: relative,
  habitsNote: `${relative}/habits.md`, actionsNote: `${relative}/actions.md`, mistakesNote: `${relative}/mistakes.md`,
  preferenceCandidatesNote: `${relative}/candidates.md`, experienceNote: `${relative}/experience.md`,
  topics: [{ id: 'synthetic/quoting', workspace: 'synthetic', title: 'Synthetic quoting', path: `${relative}/topic.md` }] };
fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify(config));
const transport = createTransport(config);
const evidence = `${relative}/proof.md`;
transport.create(evidence, 'Public synthetic evidence: script files preserve arguments.');
transport.create(config.habitsNote, '# Synthetic habits\n```json\n{"rules":[]}\n```');
record(config, transport, { event_id: identity, workspace: 'synthetic', topic: 'synthetic/quoting', agent: 'codex',
  occurred_at: new Date().toISOString(), recorded_at: new Date().toISOString(), evidence: [evidence],
  facts: [{ key: 'quoting', text: '\u591a\u5c42\u5d4c\u5957\u5f15\u53f7\u53ef\u80fd\u6539\u53d8\u53c2\u6570\uff0c\u811a\u672c\u6587\u4ef6\u4f20\u8f93\u4fdd\u6301\u53c2\u6570\u3002' }] });
consolidate(config, transport);
const run = (command, extra = [], expected = 0) => {
  const result = spawnSync(process.execPath, [path.join(root, 'bin/memkeel.mjs'), 'knowledge', command,
    '--home', scratch, '--workspace', 'synthetic', ...extra], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(result.status, expected, result.stderr);
  return JSON.parse(result.stdout);
};
const first = run('index', ['--execute']);
const second = run('index', ['--execute']);
assert.equal(second.stats.embedded, 0);
const recall = run('recall', ['--query', '\u5982\u4f55\u907f\u514d\u547d\u4ee4\u5f15\u53f7\u7834\u574f\u53c2\u6570']);
assert.equal(recall.degraded, null); assert.equal(recall.fused.length, 1);
const proposalFile = path.join(scratch, 'proposal.json');
fs.writeFileSync(proposalFile, JSON.stringify({ claim: 'Script files may avoid quoting errors', kind: 'explanation',
  support: [{ id: `${identity}/quoting`, quote: config.topics.length && '\u591a\u5c42\u5d4c\u5957\u5f15\u53f7' }] }));
run('observation', ['--topic', 'synthetic/quoting', '--proposal', proposalFile, '--execute']);
run('page', ['--topic', 'synthetic/quoting', '--execute']);
const pagePath = `${relative}/knowledge-upgrade/synthetic--quoting.md`;
const diskFile = path.join(config.vaultRoot, pagePath);
fs.appendFileSync(diskFile, '\nManual acceptance text\n');
run('page', ['--topic', 'synthetic/quoting', '--execute']);
assert.ok(transport.verify(pagePath).includes('Manual acceptance text'));
const inspection = run('inspect');
assert.equal(inspection.pages[0].state, 'fresh');
assert.equal(inspection.observations[0].usable, true);
const model = await generatorSmoke({ model: 'qwen/qwen3.5-9b' });
console.log(JSON.stringify({ status: 'passed', scratchHome: scratch, vaultAcceptanceRoot: relative,
  storage: config.storage, index: { units: first.units, dimension: first.dimension, reused: second.stats.reused },
  pageReadback: 'verified', manualContent: 'preserved', candidateAuthority: inspection.observations[0].authority,
  modelStatus: model.status, formalHomeModified: false }, null, 2));
