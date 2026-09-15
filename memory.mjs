#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bootstrap, recall, record, consolidate, refreshIndex, loadRoutes, registerTopic, ensureWorkspace, VERSION } from './lib/core.mjs';
import { inside, inspectLock } from './lib/transport.mjs';
import { createTransport } from './lib/storage/index.mjs';
import { capture, decideHabit, maintain } from './lib/lifecycle.mjs';
import { checkpointHealth } from './lib/checkpoint-audit.mjs';
import { recallLearning, checkOperation, loadEvents } from './lib/core.mjs';
import { applyRetention, loadRetention, retentionCandidates } from './lib/retention.mjs';
import { applyLayout } from './lib/layout.mjs';
import { initStore } from './lib/init.mjs';
import { planCodexBackfill, applyCodexBackfill } from './lib/ingest/backfill.mjs';
import { startServer } from './dashboard.mjs';

const argv = process.argv.slice(2);
const first = argv.shift() ?? 'help';
const command = ['--help', '-h'].includes(first) ? 'help' : first;
const options = {};
while (argv.length) {
  const key = argv.shift();
  if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
  options[key.slice(2)] = argv[0] && !argv[0].startsWith('--') ? argv.shift() : true;
}
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const policyRoot = options.home ?? process.env.MEMKEEL_HOME ?? path.join(os.homedir(), '.memkeel');
const configPath = path.join(policyRoot, 'config.json');
if (command === 'help') {
  console.log(`Agent Memory ${VERSION}\nbootstrap --cwd PATH --query TEXT [--workspace ID] [--json] [--all] [--audit]\nrecall --query TEXT [--workspace ID|NAME|PATH] [--history]\nworkspace-add --cwd DIR  (register the project at DIR as a workspace so it can hold topics and events)\nregister --topic WORKSPACE/KEY --workspace ID --title TEXT [--alias TEXT]\nrecord --file EVENT.json | record --stdin\ncapture --file INPUT.json | capture --stdin  (input: {event, evidence_text})\nhabit-decide --file INPUT.json | habit-decide --stdin\nconsolidate  (pending means remaining; pendingBefore means starting backlog)
retain --candidates [--since ISO] [--limit N]  (read-only: automatic checkpoints still undecided)
retain --file DECISIONS.json | retain --stdin  ({decisions:[{event_id, decision: drop|keep, reason}]}; soft drop, consolidates)
retain  (print the current retention ledger)\nmaintenance [--rebuild]  (recover captures, consume, refresh index and catalog)\nindex [--force]\ndashboard [--port N]  (start the read-only local management UI)\ningest-plan [--since ISO] [--limit N] [--root DIR] [--auto-register]  (read-only history backfill report)\ningest-apply [--since ISO] [--limit N] [--root DIR] [--auto-register]  (write backfilled turns as reported contexts)\ninit [--store DIR] [--obsidian-cli PATH] [--vault-name NAME]  (create an empty memory home and store; touches no agent)\nsetup [--hosts codex,claude,zcode,dsh] [--dry-run] [--check] [--uninstall] [--no-hooks]  (bind the memory system into installed agents)\naudit\ndoctor\nbootstrap/recall are read-only; --audit explicitly persists bootstrap diagnostics.\nMCP: agent_memory_read for reads; agent_memory for authorized writes.\nNew notes and appends are written as bytes and read back for verification; the default backend needs no external service.\nPolicy config: ${configPath}`);
} else if (command === 'init') {
  const store = options.store ?? path.join(policyRoot, 'store');
  console.log(JSON.stringify(initStore({ home: policyRoot, store: String(store), obsidianCli: options['obsidian-cli'] ?? '', vaultName: options['vault-name'] ?? '' }), null, 2));
} else if (command === 'setup') {
  const passthrough = [path.join(scriptDir, 'setup.mjs')];
  if (options.hosts) passthrough.push('--hosts', String(options.hosts));
  for (const name of ['dry-run', 'check', 'uninstall', 'no-hooks', 'no-policy', 'all-hosts', 'force']) if (options[name]) passthrough.push(`--${name}`);
  passthrough.push('--home', policyRoot);
  process.exit(spawnSync(process.execPath, passthrough, { stdio: 'inherit' }).status ?? 1);
} else if (!fs.existsSync(configPath)) {
  // Every other command needs an existing memory home. Reporting it here with one actionable
  // line beats the raw ENOENT stack trace a first-run user otherwise gets - which is exactly
  // what the container's default `doctor` did against an empty volume.
  console.error(`No memory home at ${policyRoot}.\nRun \`memkeel init\` first, then retry \`${command}\`.`);
  process.exit(1);
} else {
  const config = applyLayout({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), policyRoot });
  const transport = createTransport(config);
  try {
    let result;
    if (command === 'bootstrap') {
      result = bootstrap({ ...config, persistBootstrapAudit: Boolean(options.audit), ...(options.all ? { activeLimit: 20, recentLimit: 12 } : {}) }, options.cwd ?? process.cwd(), options.query ?? '', options.workspace);
      console.log(options.json ? JSON.stringify(result, null, 2) : result.text);
    } else if (command === 'recall') {
      result = recall(config, options.query ?? '', options.workspace, Boolean(options.history));
      console.log(JSON.stringify(result, null, 2));
    } else if (['experience-recall', 'context-recall'].includes(command)) {
      console.log(JSON.stringify(recallLearning(config, { ...options, type: command === 'context-recall' ? 'contexts' : 'experiences' }), null, 2));
    } else if (command === 'check-operation') {
      const input = JSON.parse(fs.readFileSync(options.file ?? 0, 'utf8').replace(/^\uFEFF/, ''));
      console.log(JSON.stringify(checkOperation(config, input), null, 2));
    } else if (['record', 'capture', 'habit-decide'].includes(command)) {
      if (!options.file && !options.stdin) throw new Error('Supply --file or --stdin with a short evidence-backed JSON event');
      const input = JSON.parse(fs.readFileSync(options.stdin ? 0 : options.file, 'utf8').replace(/^\uFEFF/, ''));
      if (command === 'capture') result = capture(config, transport, input.event, input.evidence_text);
      else if (command === 'habit-decide') result = decideHabit(config, transport, input);
      else result = { ...record(config, transport, input), consolidation: consolidate(config, transport) };
      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'workspace-add') {
      // A brand-new store has no routes, so this is how a user registers their first
      // one without waiting for a hook checkpoint. The id is derived from the project
      // root and a path hash, so equal directory names stay isolated.
      console.log(JSON.stringify(ensureWorkspace(config, transport, options.cwd ?? process.cwd()), null, 2));
    } else if (command === 'register') console.log(JSON.stringify(registerTopic(config, { id: options.topic, workspace: options.workspace, title: options.title, alias: options.alias }), null, 2));
    else if (command === 'consolidate') console.log(JSON.stringify(consolidate(config, transport), null, 2));
    else if (command === 'retain') {
      const events = loadEvents(config);
      if (options.candidates) {
        const since = typeof options.since === 'string' ? new Date(options.since) : null;
        const limit = options.limit ? Number(options.limit) : 200;
        const rows = retentionCandidates(config, events)
          .filter((row) => !since || Date.parse(row.at) >= since.getTime())
          .slice(0, limit);
        result = { candidates: rows.length, rows };
      } else if (options.file || options.stdin) {
        const input = JSON.parse(fs.readFileSync(options.stdin ? 0 : options.file, 'utf8').replace(/^\uFEFF/, ''));
        // Rebuild, not a plain pass: an already-consumed day has no pending events,
        // so an ordinary consolidate would leave the dropped entry visible in the
        // digest until some later event happened to re-render that day.
        result = { ...applyRetention(config, input, events), consolidation: consolidate(config, transport, { rebuild: true }) };
      } else {
        const { decisions } = loadRetention(config);
        result = { version: 1, decisions: Object.entries(decisions).map(([event_id, row]) => ({ event_id, ...row })) };
      }
      console.log(JSON.stringify(result, null, 2));
    }
    else if (command === 'maintenance') console.log(JSON.stringify(maintain(config, transport, { rebuild: Boolean(options.rebuild) }), null, 2));
    else if (command === 'index') console.log(JSON.stringify(refreshIndex(config, { force: Boolean(options.force) }).io, null, 2));
    else if (command === 'dashboard') { const port = options.port ? Number(options.port) : undefined; startServer(port ? { port } : {}).then(({ url }) => console.log('Memkeel dashboard: ' + url)); }
    else if (command === 'ingest-plan') {
      const since = typeof options.since === 'string' ? new Date(options.since) : null;
      const limit = options.limit ? Number(options.limit) : Infinity;
      console.log(JSON.stringify(planCodexBackfill(config, { root: options.root, since, limit, autoRegister: Boolean(options["auto-register"]) }), null, 2));
    } else if (command === 'ingest-apply') {
      const since = typeof options.since === 'string' ? new Date(options.since) : null;
      const limit = options.limit ? Number(options.limit) : Infinity;
      console.log(JSON.stringify(applyCodexBackfill(config, transport, { root: options.root, since, limit, autoRegister: Boolean(options["auto-register"]) }), null, 2));
    }
    else if (command === 'audit') {
      const index = refreshIndex(config);
      const rows = Object.values(index.entries).filter((row) => row.path.startsWith(config.inboxRoot));
      const types = {};
      for (const row of rows) types[row.meta.type ?? 'untyped'] = (types[row.meta.type ?? 'untyped'] ?? 0) + 1;
      console.log(JSON.stringify({ types, canonicalTopics: config.topics, untyped: rows.filter((row) => !row.meta.type).map((row) => row.path),
        policy: 'Legacy sources are retained. Untyped does not imply lost or safe to auto-delete. Historical claims require deliberate promotion.' }, null, 2));
    } else if (command === 'doctor') {
      const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
      // The Obsidian CLI is optional: the default backend is the plain filesystem, so
      // an unconfigured path must not be reported as a missing file.
      const paths = [configPath, path.join(policyRoot, 'bootstrap.md'), ...(config.obsidianCli ? [config.obsidianCli] : []), path.join(sourceRoot, 'vendor/obsidian-mind/session-start.ts'),
        inside(config.vaultRoot, config.habitsNote), ...config.topics.map((topic) => inside(config.vaultRoot, topic.path))];
      const missing = paths.filter((file) => !fs.existsSync(file));
      const plansFile = path.join(policyRoot, 'state', 'captures.json');
      const plans = fs.existsSync(plansFile) ? JSON.parse(fs.readFileSync(plansFile, 'utf8')) : {};
      const existingEvents = new Set(loadEvents(config).map((event) => event.event_id));
      const captures = { pending: Object.keys(plans).filter((id) => !existingEvents.has(id)) };
      // Both writer locks are reported with holder liveness. A lock that is merely in use is
      // not an unhealthy state (a drain can hold the hook-queue lock for minutes), while one
      // whose holder is gone is; that queue lock used to be invisible here entirely, which is
      // how a killed drain blocked every later checkpoint for seven hours unnoticed.
      const lock = inspectLock(path.join(policyRoot, 'state'));
      const checkpointLock = inspectLock(path.join(policyRoot, 'state/hook-queue'));
      const check = { version: VERSION, missing, captures, checkpoints: checkpointHealth(config, loadEvents(config)), lock, checkpointLock,
        routes: loadRoutes(config).map((row) => row.id), engine: 'obsidian-mind/af615d1 applyInjectionBudget (read-only adapter)', hostIntegration: 'File verification is not a host new-session smoke test.' };
      console.log(JSON.stringify(check, null, 2));
      if (missing.length || lock.stale || checkpointLock.stale || check.captures.pending.length || !check.checkpoints.healthy) process.exitCode = 1;
    } else throw new Error(`Unknown command: ${command}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
