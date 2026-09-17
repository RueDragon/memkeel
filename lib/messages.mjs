// Message catalogue for everything the CLI prints for a person to read.
//
// This is deliberately a second catalogue rather than a share of the dashboard's. The published
// package ships `lib/` and the built `dashboard/static/`, but not `dashboard/app/`, so in an
// installed copy the dashboard catalogue does not exist on disk at all - the bundle has its strings
// compiled in. A CLI message therefore has to live somewhere that survives `npm install`, and the
// discipline that keeps the two catalogues honest (equal key sets, no blank strings, every
// referenced key present) is enforced by test/cli-messages.test.mjs rather than by sharing a file.
//
// Only text printed for a person belongs here. The JSON payloads the commands emit are an
// interface: their field names are part of the contract and are never translated, and text that
// lands in the store - note bodies, event bodies, evidence text - is data, not interface copy.
export const LOCALES = ['en', 'zh-Hans'];
export const DEFAULT_LOCALE = 'en';

export const MESSAGES = {
  en: {
    'cli.listSep': '; ',
    'cli.usage.config': 'Usage: memkeel config validate|show|migrate [--dry-run|--apply] [--reveal-paths] [--home DIR]',
    'cli.usage.privacy': 'Usage: memkeel privacy show|exclusions [--preview FILE]|cleanup [--execute] [--host H] [--workspace W] [--cwd DIR]|export --out FILE',
    'cli.usage.backup': 'Usage: memkeel backup create --out DIR | memkeel backup verify --dir DIR',
    'cli.usage.backupVerify': 'Usage: memkeel backup verify --dir DIR',
    'cli.usage.restore': 'Usage: memkeel restore --dir DIR --into DIR [--execute]',
    'cli.error.unexpectedArgument': 'Unexpected argument: {argument}',
    'cli.error.homeNeedsDirectory': '--home requires a directory',
    'cli.error.supplyFileOrStdin': 'Supply --file or --stdin with a short evidence-backed JSON event',
    'cli.error.unknownCommand': 'Unknown command: {command}',
    'cli.error.noUsableConfig': 'No usable config: {error}',
    'cli.error.configMigrateApply': 'config migrate --apply: {error}',
    'cli.error.privacyExportNeedsOut': 'privacy export requires --out FILE',
    'cli.error.privacyExportAudit': 'privacy export: the redaction self-check failed, so nothing was written: {labels}',
    'cli.error.privacyExport': 'privacy export: {error}',
    'cli.error.privacyPreviewNeedsFile': 'privacy exclusions --preview requires a JSON file',
    'cli.error.restoreIntegrity': 'restore: the archive failed verification, so nothing was written: {problems}',
    'cli.error.restoreIssues': 'restore: {issues}',
    'cli.error.commandFailed': '{command}: {error}',
    'cli.error.noMemoryHome': 'No memory home at {home}.\nRun `memkeel init` first, then retry `{command}`.',
    'cli.config.missing': '{path} does not exist; run `memkeel init` first.',
    'cli.config.unparsable': '{path} could not be parsed: {error}',
    'cli.config.maskRevealed': 'Paths are printed in full.',
    'cli.config.maskRedacted': 'Paths are redacted; add --reveal-paths to print them in full.',
    'cli.config.migratePlan': 'Read-only plan: nothing was written and no directory was created.',
    'cli.backup.note': 'A backup is sensitive data too: it carries the event ledger and may carry raw bytes of host configuration. Treat it as a private directory and rely on disk encryption and directory permissions.',
    'cli.restore.plan': 'Read-only plan: nothing was written. Add --execute to run it.',
    'cli.restore.done': 'Restored into a new directory and repointed config.json at it. The index and the projections are derived data and are not carried by a backup: run memkeel index and memkeel consolidate on the new store.',
    'cli.migrate.plan': 'Read-only plan: nothing was copied and nothing was written. Add --execute to run it.',
    'cli.dashboard.started': 'Memkeel dashboard: {url}',
    'cli.cleanup.group.setupSnapshots': 'Snapshot directories under backups/ that setup created',
    'cli.cleanup.group.configMigrations': 'Configuration-change backups under backups/config-migrations/',
    'cli.cleanup.group.sessionState': 'Stale session runtime state under state/hook-sessions/',
    'cli.cleanup.group.bootstrapDiagnostics': 'The startup diagnostic at state/last-bootstrap.json',
    'cli.cleanup.keepSetupSnapshots': 'keeping the most recent {keep} setup snapshots',
    'cli.cleanup.keepConfigMigrations': 'keeping the most recent {keep} config-migration backups',
    'cli.cleanup.sessionStale': 'session state not updated for more than {days} days',
    'cli.cleanup.diagnosticsStale': 'startup diagnostic not updated for more than {days} days',
    'cli.cleanup.rejectedOutsideHome': 'the target is not inside the memory home, so it was refused',
    'cli.cleanup.unknownGroup': 'unknown group {group}',
    'cli.cleanup.outsideHome': 'the target is outside the memory home',
    'cli.cleanup.protectedRollback': 'an operational rollback directory is not subject to retention cleanup',
    'cli.cleanup.planNote': 'Read-only plan: no file was deleted. Add --execute to run it.',
    'cli.cleanup.notCovered.ledger': 'The event ledger and the store: retention never deletes an immutable record.',
    'cli.cleanup.notCovered.ownArchives': 'Archives you wrote yourself with `backup create --out DIR` - that directory is yours and this program does not know where it is.',
    'cli.cleanup.notCovered.replacements': 'backups/{protected}: it looks like a backup by its path but is not one; it is the rollback store an in-flight atomic write depends on.',
    'cli.cleanup.notCovered.copied': 'Backups, snapshots and external sync copies that were already copied elsewhere.',
    'cli.cleanup.notCovered.hostSessions': 'The host\u2019s own session record files.',
    'cli.cleanup.notCovered.dormant': 'Short-term context older than contextDays: the projection marks it dormant, and the events themselves remain.',
  },
  'zh-Hans': {
    'cli.listSep': '；',
    'cli.usage.config': '用法：memkeel config validate|show|migrate [--dry-run|--apply] [--reveal-paths] [--home DIR]',
    'cli.usage.privacy': '用法：memkeel privacy show|exclusions [--preview FILE]|cleanup [--execute] [--host H] [--workspace W] [--cwd DIR]|export --out FILE',
    'cli.usage.backup': '用法：memkeel backup create --out DIR | memkeel backup verify --dir DIR',
    'cli.usage.backupVerify': '用法：memkeel backup verify --dir DIR',
    'cli.usage.restore': '用法：memkeel restore --dir DIR --into DIR [--execute]',
    'cli.error.unexpectedArgument': '无法识别的参数：{argument}',
    'cli.error.homeNeedsDirectory': '--home 需要一个目录',
    'cli.error.supplyFileOrStdin': '请用 --file 或 --stdin 提供一段简短、有证据的 JSON 事件',
    'cli.error.unknownCommand': '未知命令：{command}',
    'cli.error.noUsableConfig': '配置不可用：{error}',
    'cli.error.configMigrateApply': 'config migrate --apply：{error}',
    'cli.error.privacyExportNeedsOut': 'privacy export 需要 --out FILE',
    'cli.error.privacyExportAudit': 'privacy export：脱敏自检未通过，未写出任何文件：{labels}',
    'cli.error.privacyExport': 'privacy export：{error}',
    'cli.error.privacyPreviewNeedsFile': 'privacy exclusions --preview 需要一个 JSON 文件',
    'cli.error.restoreIntegrity': 'restore：归档未通过校验，未写入任何内容：{problems}',
    'cli.error.restoreIssues': 'restore：{issues}',
    'cli.error.commandFailed': '{command}：{error}',
    'cli.error.noMemoryHome': '在 {home} 没有找到 memory home。\n请先运行 `memkeel init`，再重试 `{command}`。',
    'cli.config.missing': '{path} 不存在；先运行 `memkeel init`。',
    'cli.config.unparsable': '{path} 无法解析：{error}',
    'cli.config.maskRevealed': '路径原样输出。',
    'cli.config.maskRedacted': '路径已脱敏；加 --reveal-paths 输出完整路径。',
    'cli.config.migratePlan': '只读计划：没有写入任何文件，也没有创建任何目录。',
    'cli.backup.note': '备份也是敏感数据：它含事件账本，也可能含宿主配置的原始字节。请把它当成私密目录，并依赖系统磁盘加密与目录权限。',
    'cli.restore.plan': '只读计划：没有写入任何文件。加 --execute 执行。',
    'cli.restore.done': '已恢复到新目录，并把 config.json 的路径改指到新位置。索引与投影属于派生数据、未随备份携带：请在新库上运行 memkeel index 与 memkeel consolidate。',
    'cli.migrate.plan': '只读计划：没有复制、也没有写入任何文件。加 --execute 执行。',
    'cli.dashboard.started': 'Memkeel 面板：{url}',
    'cli.cleanup.group.setupSnapshots': 'backups/ 下由 setup 生成的快照目录',
    'cli.cleanup.group.configMigrations': 'backups/config-migrations/ 下的配置改动备份文件',
    'cli.cleanup.group.sessionState': 'state/hook-sessions/ 下的旧会话运行时状态',
    'cli.cleanup.group.bootstrapDiagnostics': 'state/last-bootstrap.json 启动诊断',
    'cli.cleanup.keepSetupSnapshots': '保留最近 {keep} 份 setup 快照',
    'cli.cleanup.keepConfigMigrations': '保留最近 {keep} 份配置迁移备份',
    'cli.cleanup.sessionStale': '会话状态超过 {days} 天未更新',
    'cli.cleanup.diagnosticsStale': '启动诊断超过 {days} 天未更新',
    'cli.cleanup.rejectedOutsideHome': '目标不在 memory home 之内，已拒绝',
    'cli.cleanup.unknownGroup': '未知分组 {group}',
    'cli.cleanup.outsideHome': '目标在 memory home 之外',
    'cli.cleanup.protectedRollback': '操作性的回滚目录不参与保留清理',
    'cli.cleanup.planNote': '只读计划：没有删除任何文件。加 --execute 执行。',
    'cli.cleanup.notCovered.ledger': '事件账本与存储内容：保留策略不删除不可变记录。',
    'cli.cleanup.notCovered.ownArchives': '你自己用 `backup create --out DIR` 写出的归档 —— 那个目录属于你，本程序不知道它在哪里。',
    'cli.cleanup.notCovered.replacements': 'backups/{protected}：按路径看像备份，其实是原子写入的回滚目录，任何一个正在进行的写入都可能依赖它。',
    'cli.cleanup.notCovered.copied': '已经复制出去的备份、快照与外部同步副本。',
    'cli.cleanup.notCovered.hostSessions': '宿主自己的会话记录文件。',
    'cli.cleanup.notCovered.dormant': '超过 contextDays 的短期上下文：它们由投影标记为休眠，事件本身仍在。',
  },
};

// A message reference is how library code names prose without choosing a language: `message()` wraps
// a key and its parameters, and the presentation layer renders it with `renderMessages` and its own
// translator. lib/ therefore stays language-neutral, and the CLI, the dashboard and the diagnostics
// export each render the same reference into whichever locale they are serving.
const MESSAGE_PREFIX = 'cli.';

export function msg(key, params) {
  return params ? { key, params } : { key };
}

export function isMessageReference(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof value.key === 'string' && value.key.startsWith(MESSAGE_PREFIX);
}

export function renderMessages(value, t) {
  if (Array.isArray(value)) return value.map((row) => renderMessages(row, t));
  if (isMessageReference(value)) return t(value.key, value.params);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, row]) => [name, renderMessages(row, t)]));
  }
  return value;
}

// Same contract as the dashboard catalogue: fall back to the default locale, then to the key itself,
// so a missing translation shows up as a visible key rather than as a blank line.
export function translate(locale, key, params) {
  const table = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
  const template = table[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// Returns the language subtag, so 'zh_CN.UTF-8' and 'zh-Hans' both reduce to 'zh'.
function languageOf(value) {
  return String(value ?? '').trim().toLowerCase().split(/[.@]/)[0].split(/[_-]/)[0];
}

// One precedence: MEMKEEL_LOCALE, then the conventional locale variables, then English. An
// unrecognised or unset environment therefore yields English, which is what the CLI has always
// printed for errors and what the packaged tests assert.
export function detectLocale(env = process.env) {
  const explicit = languageOf(env.MEMKEEL_LOCALE);
  if (LOCALES.some((locale) => languageOf(locale) === explicit) && explicit) return explicit === 'zh' ? 'zh-Hans' : explicit;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    if (languageOf(env[name]) === 'zh') return 'zh-Hans';
  }
  return DEFAULT_LOCALE;
}

export function makeTranslator(locale = detectLocale()) {
  return (key, params) => translate(locale, key, params);
}
