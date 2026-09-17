#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bootstrap, recall, record, consolidate, refreshIndex, loadRoutes, registerTopic, ensureWorkspace, VERSION } from './lib/core.mjs';
import { inside, inspectLock } from './lib/transport.mjs';
import { createTransport } from './lib/storage/index.mjs';
import { capture, decideHabit, maintain } from './lib/lifecycle.mjs';
import { checkpointHealth } from './lib/checkpoint-audit.mjs';
import { recallLearning, checkOperation, loadEvents } from './lib/core.mjs';
import { applyRetention, loadRetention, retentionCandidates } from './lib/retention.mjs';
import { CONFIG_SCHEMA_VERSION, applyConfigMigration, effectiveConfigView, loadConfig, planConfigMigration, resolveHome, validateConfig } from './lib/config.mjs';
import { bindingDrift, launcherReport, readInstallReceipt } from './lib/install-receipt.mjs';
import { createBackup, freeBytes, readManifest, restoreBackup, reviewRestore, verifyBackup } from './lib/backup.mjs';
import { executeMigration, planMigration } from './lib/migrate.mjs';
import { cleanupPreview, previewExclusions, privacyView } from './lib/privacy.mjs';
import { executeCleanup, planCleanup } from './lib/cleanup.mjs';
import { auditDiagnostics, buildDiagnostics, writeDiagnostics } from './lib/diagnostics.mjs';
import { initStore } from './lib/init.mjs';
import { planCodexBackfill, applyCodexBackfill } from './lib/ingest/backfill.mjs';
import { startServer } from './dashboard.mjs';
import { makeTranslator, renderMessages } from './lib/messages.mjs';

// Every string this CLI prints for a person comes from lib/messages.mjs, so a single locale governs
// the whole surface; that file explains why it is a separate catalogue from the dashboard's.
const t = makeTranslator();

const argv = process.argv.slice(2);
const first = argv.shift() ?? 'help';
const command = ['--help', '-h'].includes(first) ? 'help' : first;
// `config` and `backup` take a positional action (validate / show / migrate, create / verify) before
// their flags, which the generic flag loop below would otherwise reject as an unexpected argument.
const SUBCOMMAND_HOSTS = new Set(['config', 'backup', 'privacy']);
const subcommand = SUBCOMMAND_HOSTS.has(command) && argv.length && !argv[0].startsWith('--') ? argv.shift() : '';
const options = {};
while (argv.length) {
  const key = argv.shift();
  if (!key.startsWith('--')) throw new Error(t('cli.error.unexpectedArgument', { argument: key }));
  options[key.slice(2)] = argv[0] && !argv[0].startsWith('--') ? argv.shift() : true;
}
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
if (options.home === true) throw new Error(t('cli.error.homeNeedsDirectory'));
// One precedence for every entry point: --home, then MEMKEEL_HOME, then the per-user default.
const { home: policyRoot, source: homeSource } = resolveHome({ home: typeof options.home === 'string' ? options.home : '' });
const configPath = path.join(policyRoot, 'config.json');
if (command === 'help') {
  console.log(`Agent Memory ${VERSION}\nbootstrap --cwd PATH --query TEXT [--workspace ID] [--json] [--all] [--audit]\nrecall --query TEXT [--workspace ID|NAME|PATH] [--history]\nworkspace-add --cwd DIR  (register the project at DIR as a workspace so it can hold topics and events)\nregister --topic WORKSPACE/KEY --workspace ID --title TEXT [--alias TEXT]\nrecord --file EVENT.json | record --stdin\ncapture --file INPUT.json | capture --stdin  (input: {event, evidence_text})\nhabit-decide --file INPUT.json | habit-decide --stdin\nconsolidate  (pending means remaining; pendingBefore means starting backlog)
retain --candidates [--since ISO] [--limit N]  (read-only: automatic checkpoints still undecided)
retain --file DECISIONS.json | retain --stdin  ({decisions:[{event_id, decision: drop|keep, reason}]}; soft drop, consolidates)
retain  (print the current retention ledger)\nmaintenance [--rebuild]  (recover captures, consume, refresh index and catalog)\nindex [--force]\ndashboard [--port N]  (start the read-only local management UI)\ningest-plan [--since ISO] [--limit N] [--root DIR] [--auto-register]  (read-only history backfill report)\ningest-apply [--since ISO] [--limit N] [--root DIR] [--auto-register]  (write backfilled turns as reported contexts)\ninit [--store DIR] [--obsidian-cli PATH] [--vault-name NAME]  (create an empty memory home and store; touches no agent)\nsetup [--hosts codex,claude,zcode,dsh] [--dry-run] [--check] [--uninstall] [--no-hooks]  (bind the memory system into installed agents)\nconfig validate|show|migrate [--dry-run|--apply] [--reveal-paths]  (read-only by default: validate the config, print the effective values and where each came from, or print the upgrade plan; migrate --apply writes it after a backup and a readback)\nbackup create --out DIR | backup verify --dir DIR  (write a private archive of the journal and the non-rebuildable state, or verify one against its checksums)\nrestore --dir DIR --into DIR [--execute]  (read-only plan by default: check traversal, symlinks, conflicts, free space and format before anything is written; --execute restores into a new directory and repoints its config)\nmigrate --to DIR [--execute]  (read-only plan by default: copy the home and store to a new location, verify every file, then repoint the copy; the source is never modified or deleted)\nprivacy show|exclusions [--preview FILE]|cleanup [--execute] [--host H] [--workspace W] [--cwd DIR]|export --out FILE  (show/exclusions/cleanup plan are read-only: print the effective collection policy and who decided it, evaluate exclusion rules against sample values, or list every path a retention cleanup would remove; cleanup --execute removes exactly those paths - only setup snapshots, config migration backups and stale runtime session state inside the memory home, never the ledger, never your own archives; export writes one redacted diagnostic file, withholding session text, evidence bodies, full paths and credentials)\naudit\ndoctor\nbootstrap/recall are read-only; --audit explicitly persists bootstrap diagnostics.\nMCP: agent_memory_read for reads; agent_memory for authorized writes.\nNew notes and appends are written as bytes and read back for verification; the default backend needs no external service.\nPolicy config: ${configPath}`);
} else if (command === 'init') {
  const store = options.store ?? path.join(policyRoot, 'store');
  console.log(JSON.stringify(initStore({ home: policyRoot, store: String(store), obsidianCli: options['obsidian-cli'] ?? '', vaultName: options['vault-name'] ?? '' }), null, 2));
} else if (command === 'setup') {
  const passthrough = [path.join(scriptDir, 'setup.mjs')];
  if (options.hosts) passthrough.push('--hosts', String(options.hosts));
  for (const name of ['dry-run', 'check', 'uninstall', 'no-hooks', 'no-policy', 'all-hosts', 'force']) if (options[name]) passthrough.push(`--${name}`);
  passthrough.push('--home', policyRoot);
  process.exit(spawnSync(process.execPath, passthrough, { stdio: 'inherit' }).status ?? 1);
} else if (command === 'config') {
  // These commands read one JSON file and never build a transport, so an invalid document
  // cannot create a directory or change a host binding.
  const action = subcommand || 'validate';
  // `--dry-run` is the default, so it is accepted for the plan's spelling of the command; asking
  // for both would be contradictory rather than "apply wins".
  if (!['validate', 'show', 'migrate'].includes(action) || ((options.apply || options['dry-run']) && action !== 'migrate') || (options.apply && options['dry-run'])) {
    console.error(t('cli.usage.config'));
    process.exit(2);
  }
  const base = { home: policyRoot, homeSource, file: configPath };
  // A missing or unparseable document is a result to report, not a crash: this command exists
  // to explain what is wrong with the configuration, including that there is not one.
  let raw = null;
  let readError = null;
  if (!fs.existsSync(configPath)) readError = t('cli.config.missing', { path: configPath });
  else {
    try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (error) { readError = t('cli.config.unparsable', { path: configPath, error: error.message }); }
  }
  if (readError) {
    if (action === 'validate') {
      console.log(JSON.stringify({ ...base, schemaVersion: CONFIG_SCHEMA_VERSION, ok: false, issues: [{ field: 'config', message: readError }], notes: [] }, null, 2));
    } else {
      console.error(t('cli.error.noUsableConfig', { error: readError }));
    }
    process.exitCode = 1;
  } else if (action === 'validate') {
    const report = validateConfig(raw);
    console.log(JSON.stringify({ ...base, schemaVersion: CONFIG_SCHEMA_VERSION, ok: report.ok, issues: report.issues, notes: report.notes }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else if (action === 'show') {
    const view = effectiveConfigView(raw, { revealPaths: Boolean(options['reveal-paths']) });
    console.log(JSON.stringify({ ...base, schemaVersion: CONFIG_SCHEMA_VERSION, effective: view.entries, rolesRoot: view.role, deprecatedKeys: view.deprecated,
      maskNote: t(options['reveal-paths'] ? 'cli.config.maskRevealed' : 'cli.config.maskRedacted') }, null, 2));
  } else if (options.apply) {
    // The only write in this command, and only when it is asked for by name. `--apply` carries its
    // own safety: an empty plan writes nothing, the migrated document is validated before it is
    // written, the exact bytes read are backed up first, and the result is read back and rolled
    // back on any mismatch.
    try {
      const outcome = applyConfigMigration(policyRoot);
      console.log(JSON.stringify({ ...base, fromSchema: raw.configSchema ?? null, toSchema: CONFIG_SCHEMA_VERSION,
        applied: outcome.applied, backup: outcome.backup, changes: outcome.changes,
        ...(outcome.applied ? {} : { reason: outcome.reason }) }, null, 2));
    } catch (error) {
      console.error(t('cli.error.configMigrateApply', { error: error.message }));
      process.exitCode = 1;
    }
  } else {
    const plan = planConfigMigration(raw);
    console.log(JSON.stringify({ ...base, fromSchema: plan.fromSchema, toSchema: plan.toSchema, changes: plan.changes,
      applied: false, dryRun: true, note: t('cli.config.migratePlan') }, null, 2));
  }
} else if (command === 'privacy') {
  // `show`, `exclusions` and a bare `cleanup` are read-only: they answer "what would be collected,
  // and who decided that" without writing a file. They run before the home check so the defaults are
  // reportable on a machine that has no home yet — exactly when a user is deciding whether to create
  // one. Two actions do write: `export` writes one file at a path the user names, and
  // `cleanup --execute` removes the retention targets its own plan listed.
  const action = subcommand || 'show';
  if (!['show', 'exclusions', 'cleanup', 'export'].includes(action)) {
    console.error(t('cli.usage.privacy'));
    process.exit(2);
  }
  let loaded = {};
  if (fs.existsSync(configPath)) { try { loaded = loadConfig(policyRoot).config; } catch { loaded = {}; } }
  const context = {
    host: typeof options.host === 'string' ? options.host : undefined,
    workspace: typeof options.workspace === 'string' ? options.workspace : undefined,
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
  };
  if (action === 'show') console.log(JSON.stringify(renderMessages({ home: policyRoot, ...privacyView(loaded, context) }, t), null, 2));
  else if (action === 'cleanup') {
    // Preview by default, like `restore --execute`: the plan names every path it would remove, so the
    // destructive step is a separate word on the command line rather than a property of the command.
    const plan = planCleanup(loaded);
    if (!options.execute) {
      console.log(JSON.stringify(renderMessages({ home: policyRoot, ...cleanupPreview(loaded, context), plan }, t), null, 2));
      if (plan.issues.length) process.exitCode = 1;
    } else {
      const result = executeCleanup(loaded, plan);
      console.log(JSON.stringify(renderMessages({ home: policyRoot, executedPlan: { at: plan.at, targets: plan.targets.length, bytes: plan.bytes }, ...result }, t), null, 2));
      if (result.errors.length) process.exitCode = 1;
    }
  } else if (action === 'export') {
    if (options.out === true || typeof options.out !== 'string') { console.error(t('cli.error.privacyExportNeedsOut')); process.exit(2); }
    // Rendered before it is audited and written: this bundle is a readable artifact for a person, so
    // a message reference must never reach the file. Auditing the rendered bytes is also the stronger
    // check, because those are the bytes that leave.
    const bundle = renderMessages(buildDiagnostics(loaded, { version: VERSION }), t);
    // Audit the real bytes before they are written, not after: an export that promises to be free of
    // paths and credentials should be checked against what it actually contains, and a failed check
    // must leave nothing behind.
    const audit = auditDiagnostics(bundle, { home: policyRoot, store: loaded.vaultRoot });
    if (!audit.clean) {
      console.error(t('cli.error.privacyExportAudit', { labels: audit.leaks.map((leak) => leak.label).join(t('cli.listSep')) }));
      process.exitCode = 1;
    } else {
      try {
        const written = writeDiagnostics(String(options.out), bundle);
        console.log(JSON.stringify({ file: written.file, bytes: written.bytes, audit, counts: bundle.counts,
          excluded: bundle.excluded, note: bundle.note }, null, 2));
      } catch (error) {
        // A refusal to overwrite is an ordinary outcome, not a crash: report it as a message rather
        // than letting a stack trace stand in for an explanation.
        console.error(t('cli.error.privacyExport', { error: error.message }));
        process.exitCode = 1;
      }
    }
  } else {
    // `--preview` takes a JSON file of sample values, so a rule can be evaluated against the real
    // paths it is supposed to govern instead of being trusted because it looks right.
    if (options.preview === true) { console.error(t('cli.error.privacyPreviewNeedsFile')); process.exit(2); }
    let samples = {};
    if (typeof options.preview === 'string') samples = JSON.parse(fs.readFileSync(options.preview, 'utf8'));
    console.log(JSON.stringify(renderMessages({ home: policyRoot, ...previewExclusions(loaded, samples) }, t), null, 2));
  }
} else if (command === 'backup' || command === 'restore') {
  // These commands work on an archive, not on this machine's store, so they run before the "is there
  // a memory home here" check: restoring onto a machine that has no home is the whole point.
  try {
    const action = command === 'restore' ? 'restore' : subcommand;
    if (command === 'backup' && !['create', 'verify'].includes(action)) {
      console.error(t('cli.usage.backup'));
      process.exit(2);
    }
    if (action === 'create') {
      const { config } = loadConfig(policyRoot);
      const result = createBackup(config, { out: options.out, version: VERSION });
      console.log(JSON.stringify({ dir: result.dir, files: result.files, bytes: result.bytes, notCarried: result.notCarried,
        manifest: result.manifest.counts,
        note: t('cli.backup.note') }, null, 2));
    } else if (action === 'verify') {
      if (!options.dir) { console.error(t('cli.usage.backupVerify')); process.exit(2); }
      const report = verifyBackup(String(options.dir));
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    } else {
      if (!options.dir) { console.error(t('cli.usage.restore')); process.exit(2); }
      const manifest = readManifest(String(options.dir));
      // The space check needs a destination to measure; without --into the plan is still reported.
      const review = reviewRestore(manifest, { into: options.into, free: options.into ? freeBytes(String(options.into)) : null });
      if (!options.execute) {
        console.log(JSON.stringify({ ...review, dryRun: true, executed: false, files: manifest.files.length,
          note: t('cli.restore.plan') }, null, 2));
        if (!review.ok) process.exitCode = 1;
      } else {
        // Integrity first, then safety: an archive whose bytes do not match its own manifest must not
        // be half-written into the destination and only then discovered to be broken.
        const integrity = verifyBackup(String(options.dir));
        if (!integrity.ok) {
          console.error(t('cli.error.restoreIntegrity', { problems: integrity.problems.map((problem) => problem.message).join(t('cli.listSep')) }));
          process.exitCode = 1;
        } else if (!review.ok) {
          console.error(t('cli.error.restoreIssues', { issues: review.issues.map((issue) => issue.message).join(t('cli.listSep')) }));
          process.exitCode = 1;
        } else {
          const result = restoreBackup(String(options.dir), { into: options.into, manifest });
          console.log(JSON.stringify({ ...result, verified: integrity.counts,
            note: t('cli.restore.done') }, null, 2));
        }
      }
    }
  } catch (error) {
    console.error(t('cli.error.commandFailed', { command, error: error.message }));
    process.exitCode = 1;
  }
} else if (!fs.existsSync(configPath)) {
  // Every other command needs an existing memory home. Reporting it here with one actionable
  // line beats the raw ENOENT stack trace a first-run user otherwise gets - which is exactly
  // what the container's default `doctor` did against an empty volume.
  console.error(t('cli.error.noMemoryHome', { home: policyRoot, command }));
  process.exit(1);
} else {
  const { config } = loadConfig(policyRoot);
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
      if (!options.file && !options.stdin) throw new Error(t('cli.error.supplyFileOrStdin'));
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
    else if (command === 'migrate') {
      // Read-only by default, like restore: the plan names the source, the destination, the counts,
      // the configuration keys that would be rewritten and the workspace aliases in effect.
      const plan = planMigration(config, { to: options.to });
      if (!options.execute) {
        console.log(JSON.stringify({ ...plan, dryRun: true, executed: false, copied: 0,
          note: t('cli.migrate.plan') }, null, 2));
        if (!plan.ok) process.exitCode = 1;
      } else {
        console.log(JSON.stringify(executeMigration(config, plan, { version: VERSION }), null, 2));
      }
    }
    else if (command === 'maintenance') console.log(JSON.stringify(maintain(config, transport, { rebuild: Boolean(options.rebuild) }), null, 2));
    else if (command === 'index') console.log(JSON.stringify(refreshIndex(config, { force: Boolean(options.force) }).io, null, 2));
    else if (command === 'dashboard') { const port = options.port ? Number(options.port) : undefined; startServer(port ? { port } : {}).then(({ url }) => console.log(t('cli.dashboard.started', { url }))); }
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
      // The restore chain, the home that was actually chosen, whether the recorded bindings still
      // point at that home, and whether the scripts they invoke still exist. A legacy or malformed
      // receipt is what makes a later `setup --uninstall` fail closed; an unexpected home is the
      // usual reason a command "loses" a store; a moved checkout leaves every host pointing at
      // files that are gone, which looks like a broken memory rather than a moved install.
      const install = readInstallReceipt(policyRoot);
      const drift = bindingDrift(install, policyRoot);
      const launcher = launcherReport({ command: process.execPath, files: ['mcp-server.mjs', 'hook-runner.mjs', 'dsh-memory-plugin.mjs'].map((name) => path.join(sourceRoot, name)) });
      const receipt = { exists: install.exists, malformed: install.malformed, format: install.format, version: install.version, legacy: install.legacy, at: install.at, memoryHome: install.memoryHome, files: Object.keys(install.files).length };
      const check = { version: VERSION, effectiveHome: { path: policyRoot, source: homeSource }, missing, captures, checkpoints: checkpointHealth(config, loadEvents(config)), lock, checkpointLock,
        receipt, bindingDrift: drift, launcher,
        routes: loadRoutes(config).map((row) => row.id), engine: 'obsidian-mind/af615d1 applyInjectionBudget (read-only adapter)', hostIntegration: 'File verification is not a host new-session smoke test.' };
      console.log(JSON.stringify(check, null, 2));
      // `unknown` drift is not unhealthy: a legacy receipt simply cannot answer the question, and
      // saying "ok" would be a guess while failing the run would be noise. Actual drift is not
      // healthy either, but it is not fatal to the store - it is reported for the user to fix.
      if (missing.length || lock.stale || checkpointLock.stale || check.captures.pending.length || !check.checkpoints.healthy || receipt.malformed || !launcher.ok) process.exitCode = 1;
    } else throw new Error(t('cli.error.unknownCommand', { command }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
