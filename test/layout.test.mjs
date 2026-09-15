// Stage-1 acceptance probe (temporary). Proves a neutral-layout vault, with no
// Obsidian CLI and no Obsidian vault, can run bootstrap/record/consolidate/doctor
// end to end through the filesystem storage adapter.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyLayout } from '../lib/layout.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { bootstrap, record, consolidate, loadEvents, loadRoutes, consumptionStatus } from '../lib/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-memory-'));
// The whole file runs against this one directory; drop it when the file's test run ends.
after(() => fs.rmSync(root, { recursive: true, force: true }));
const vaultRoot = path.join(root, 'vault');
const policyRoot = path.join(root, 'policy');
for (const dir of ['events', 'topics', 'projects', 'digest']) fs.mkdirSync(path.join(vaultRoot, dir), { recursive: true });
fs.mkdirSync(policyRoot, { recursive: true });

const projectDir = path.join(root, 'my-project');
fs.mkdirSync(projectDir, { recursive: true });

const config = applyLayout({
  version: '1.0.0',
  memoryRoot: vaultRoot,
  vaultRoot,
  policyRoot,
  vaultName: '',
  obsidianCli: '',
  storage: 'filesystem',
  layout: 'neutral',
  recentDays: 14,
  activeLimit: 6,
  recentLimit: 6,
  budgetBytes: 14000,
  workspaceAliases: {},
  topics: [],
});
fs.writeFileSync(path.join(policyRoot, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

const transport = createTransport(config);

// Seed the habits note and one evidence note the event can point at.
transport.create('habits.md', '# Habits\n\n```json\n{"rules":[{"id":"global-chinese","status":"confirmed","scope":"global","text":"Reply in Chinese"}]}\n```\n');
transport.create('digest/evidence.md', '---\ntype: session-closeout\ndate: 2026-09-14\n---\n# Evidence\n\nNeutral layout smoke evidence.\n');

// First write auto-registers the workspace, then records a fact.
const route = (await import('../lib/core.mjs')).ensureWorkspace(config, transport, projectDir);
const topic = { id: `${route.id}/smoke`, workspace: route.id, title: 'Smoke Topic', aliases: [], path: `topics/${route.id}--smoke.md` };
const persisted = JSON.parse(fs.readFileSync(path.join(policyRoot, 'config.json'), 'utf8'));
persisted.topics.push(topic);
fs.writeFileSync(path.join(policyRoot, 'config.json'), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
config.topics = persisted.topics;

const event = {
  event_id: 'neutral-layout-smoke-0001',
  workspace: route.id,
  topic: topic.id,
  agent: 'probe',
  occurred_at: '2026-09-14T10:00:00+08:00',
  evidence: ['digest/evidence.md'],
  facts: [{ key: 'neutral-layout-works', text: 'Neutral layout runs on the filesystem storage adapter without Obsidian.' }],
  verification: ['Probe wrote, consolidated and reloaded this event through createTransport.'],
};
record(config, transport, event);
const consolidation = consolidate(config, transport);
const startup = bootstrap(config, projectDir, 'neutral layout', route.id);
const summary = {
  root,
  storageKind: config.storage,
  route: route.id,
  routeNoteExists: fs.existsSync(path.join(vaultRoot, route.note)),
  eventCount: loadEvents(config).length,
  pending: consumptionStatus(config, loadEvents(config)).pending,
  consolidation,
  bootstrapBytes: startup.bytes,
  bootstrapHasFact: startup.text.includes('filesystem storage adapter'),
  bootstrapHasHabit: startup.text.includes('Reply in Chinese'),
  filesOnDisk: loadRoutes(config).map((row) => row.note),
};
console.log(JSON.stringify(summary, null, 2));
