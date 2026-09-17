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
    'cli.cleanupPreview.contextsTarget': 'Short-term task context (contexts)',
    'cli.cleanupPreview.contextsRule': 'beyond {days} days it goes dormant and stays reachable in history only',
    'cli.cleanupPreview.contextsEffect': 'the events are not removed; they simply stop being injected by default',
    'cli.cleanupPreview.backupsTarget': 'Backup archives',
    'cli.cleanupPreview.backupsRule': 'only the most recent {keep} are kept',
    'cli.cleanupPreview.backupsEffect': 'it only cleans setup snapshots and config-migration backups inside the memory home; archives you wrote yourself with backup create --out are out of scope and this command never touches them',
    'cli.cleanupPreview.runtimeTarget': 'Session runtime state and the startup diagnostic',
    'cli.cleanupPreview.runtimeRule': 'cleaned once not updated for more than {days} days',
    'cli.cleanupPreview.runtimeEffect': 'state/hook-sessions/ and state/last-bootstrap.json; both are rebuildable runtime state and neither is part of the ledger',
    'cli.cleanupPreview.notCovered.ledger': 'Events already written to the ledger (immutable, append-only).',
    'cli.cleanupPreview.notCovered.copied': 'Backups, snapshots and external sync copies that were already copied elsewhere.',
    'cli.cleanupPreview.notCovered.hostSessions': 'The host\u2019s own session record files - the host manages them and this program only reads them.',
    'cli.cleanupPreview.notCovered.replacements': 'backups/replacements/: the rollback store for atomic writes; it looks like a backup by its path but is not one, and a write in flight may depend on it.',
    'cli.cleanupPreview.note': 'Read-only preview: no file was deleted.',
    'cli.exclusions.pathsNote': 'matches the directory itself and every path inside it',
    'cli.exclusions.exactNote': 'an exact whole-value match (case per platform rules)',
    'cli.exclusions.note': 'A rule that matched nothing is not an error: it only means the samples given this time did not fall under it.',
    'cli.privacy.vocab.notCollected.label': 'Not collected',
    'cli.privacy.vocab.notCollected.meaning': 'This conversation was never written down. No queue entry, no checkpoint, no evidence, no access log.',
    'cli.privacy.vocab.notCollected.reversible': 'nothing to reverse',
    'cli.privacy.vocab.retained.label': 'Soft delete / excluded from retrieval',
    'cli.privacy.vocab.retained.meaning': 'The original record is still complete in the ledger; it simply stops entering the default digest and ordinary recall. Its history and provenance stay traceable.',
    'cli.privacy.vocab.retained.reversible': 'yes - the record is still there, and restoring retrieval only means changing the policy back',
    'cli.privacy.vocab.physical.label': 'Physical deletion',
    'cli.privacy.vocab.physical.meaning': 'Erasing events that were already written from the ledger. This program does not offer it: the ledger is append-only and its events are checksummed immutable records, so deleting in place would break its own integrity and could not recall the backups or external sync copies that already exist.',
    'cli.privacy.vocab.physical.reversible': 'no',
    'cli.privacy.decision.global': 'the global collection switch is off (collection.enabled = false)',
    'cli.privacy.decision.excluded': 'an exclusion rule matched: {kind} = {rule}',
    'cli.privacy.decision.workspace': 'collection is off for the workspace {workspace}',
    'cli.privacy.decision.host': 'collection is off for the host {host}',
    'cli.privacy.decision.collecting': 'collection is on',
    'cli.privacy.permanentDeletion': 'Physical deletion is not implemented and is not something a configuration switch could provide: the ledger is append-only and its events are checksummed; deleting in place would break its integrity and could not recall the backups or external sync copies that already exist. Use "not collected" to stop writes, retention to let derived material expire, and exclude sensitive directories before collection begins.',

    // The configuration surfaces. `memkeel config` and the settings page both show these, and the
    // settings page renders them through `shared()`, so the keys live here rather than in the panel
    // catalogue. Labels are separate keys from the sentences that quote them: several sentences
    // quote the same label, and a label spelled inside each sentence would have several homes.
    'cli.config.field.storage': 'storage backend (storage)',
    'cli.config.field.memoryRoot': 'memoryRoot (the memory store root)',
    'cli.config.field.vaultRoot': 'vaultRoot (the Obsidian vault root)',
    'cli.config.field.vaultName': 'vaultName (the Obsidian vault name)',
    'cli.config.field.obsidianCli': 'obsidianCli (the Obsidian CLI path)',
    'cli.config.field.layout': 'layout (the layout)',
    'cli.config.field.activeLimit': 'activeLimit (active projects injected)',
    'cli.config.field.recentLimit': 'recentLimit (recent changes injected)',
    'cli.config.field.recentDays': 'recentDays (recent-changes window in days)',
    'cli.config.field.budgetBytes': 'budgetBytes (injection budget in bytes)',
    'cli.config.role.eventsRoot': 'Event directory',
    'cli.config.role.topicsRoot': 'Topic directory',
    'cli.config.role.projectRoot': 'Project directory',
    'cli.config.role.habitsNote': 'Preferences note',
    'cli.config.role.actionsNote': 'Actions note',
    'cli.config.role.mistakesNote': 'Mistakes note',
    'cli.config.role.candidatesNote': 'Candidates note',
    'cli.config.role.experienceNote': 'Experience note',
    'cli.config.role.inboxRoot': 'Inbox directory',
    'cli.config.number.activeLimit.label': 'Active projects injected',
    'cli.config.number.activeLimit.hint': 'How many active projects are injected at most (unlimited when unset)',
    'cli.config.number.recentLimit.label': 'Recent changes injected',
    'cli.config.number.recentLimit.hint': 'How many recent changes are injected at most (unlimited when unset)',
    'cli.config.number.recentDays.label': 'Recent-changes window in days',
    'cli.config.number.recentDays.hint': 'How many days back recent changes are read (14 days at runtime by default)',
    'cli.config.number.budgetBytes.label': 'Injection budget in bytes',
    'cli.config.number.budgetBytes.hint': 'Total budget for the injected text; low-priority sections are collapsed when it is exceeded',
    'cli.config.layout.neutral': 'Neutral default (logical role names, bound to no private directory layout)',
    'cli.config.layout.obsidian-notion': 'Obsidian / Notion preset (an existing private layout)',
    'cli.config.storage.filesystem': 'Filesystem (the default; needs no external service)',
    'cli.config.storage.obsidian-cli': 'Obsidian CLI (requires both obsidianCli and vaultName)',
    'cli.config.value.unset': '(not set)',
    'cli.config.value.empty': '(empty)',
    'cli.config.storeRoot.empty': '{label} must not be empty',
    'cli.config.storeRoot.notAbsolute': '{label} must be an absolute path: {value}',
    'cli.config.storeRoot.insideCheckout': '{label} must not point at this program\u2019s own checkout ({root}); the store has to live outside it',
    'cli.config.storeRoot.unreadable': '{label} could not be read: {error}',
    'cli.config.storeRoot.notADirectory': '{label} exists but is not a directory: {target}',
    'cli.config.storeRoot.notWritable': '{label} is not writable: {target}',
    'cli.config.storeRoot.cannotCreate': '{label} could not be created: {target}',
    'cli.config.storeRoot.parentUnreadable': 'The parent path of {label} could not be read: {error}',
    'cli.config.storeRoot.parentNotDirectory': 'The parent path of {label} is not a directory, so {target} cannot be created',
    'cli.config.storeRoot.parentNotWritable': 'The parent directory of {label} is not writable, so {target} cannot be created',
    'cli.config.storeRoot.createFailed': '{label} could not be created: {error}',
    'cli.config.storage.invalid': 'The storage backend must be filesystem or obsidian-cli (currently: {value})',
    'cli.config.layout.invalid': 'The layout must be neutral or obsidian-notion (currently: {value})',
    'cli.config.obsidianCli.required': 'Choosing obsidian-cli storage requires obsidianCli (the path to the Obsidian CLI executable)',
    'cli.config.vaultName.required': 'Choosing obsidian-cli storage requires vaultName (the Obsidian vault name)',
    'cli.config.note.vaultRootDerived': 'vaultRoot is empty, so it is resolved from memoryRoot at runtime.',
    'cli.config.role.required': 'roles.{role} ({label}) must not be empty',
    'cli.config.changeField.role': 'roles.{role} ({label})',
    'cli.config.note.memoryRootAbsent': 'The memory store root does not exist yet; saving will create it and validate the role paths.',
    'cli.config.role.outsideRoot': 'roles.{role} ({label}) must stay inside the memory store root ({error})',
    'cli.config.number.notInteger': '{label} ({key}) must be an integer between {min} and {max}; currently: {value}',
    'cli.config.error.noChanges': 'The configuration is unchanged, so there is nothing to write',
    'cli.config.summary.update': 'Configuration changes: {n}',
    'cli.config.version.notString': 'version must be a string (currently: {value})',
    'cli.config.schema.notInteger': 'configSchema must be an integer (currently: {value})',
    'cli.config.schema.newer': 'configSchema {version} is newer than this build supports ({supported}); upgrade memkeel instead of downgrading the configuration',
    'cli.config.note.schemaMissing': 'configSchema is missing (this build is schema {version}); run `memkeel config migrate` to see the upgrade plan.',
    'cli.config.note.unknownKey': 'The unknown field {key} is kept as it is but has no effect; correct it if it is a typo.',
    'cli.config.note.deprecatedKey': 'The top-level {key} is the old spelling; migrating to {target} is recommended (it still reads today).',
    'cli.config.roots.disagree': 'memoryRoot and vaultRoot point at different directories ({a} / {b}): notes resolve against vaultRoot while the store root is memoryRoot. Make them agree, or delete one so it can be derived from the other.',
    'cli.config.roots.bothEmpty': 'memoryRoot and vaultRoot are both empty, so the memory store root cannot be determined.',
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
    'cli.cleanupPreview.contextsTarget': '短期任务上下文（contexts）',
    'cli.cleanupPreview.contextsRule': '超过 {days} 天转为休眠、仅历史可查',
    'cli.cleanupPreview.contextsEffect': '不移除事件；只是不再进入默认注入',
    'cli.cleanupPreview.backupsTarget': '备份归档',
    'cli.cleanupPreview.backupsRule': '仅保留最近 {keep} 份',
    'cli.cleanupPreview.backupsEffect': '只清理 memory home 内的 setup 快照与 config-migrations 备份；你自己用 backup create --out 写出的归档不在范围内，也永远不会被本命令碰到',
    'cli.cleanupPreview.runtimeTarget': '会话运行时状态与启动诊断',
    'cli.cleanupPreview.runtimeRule': '超过 {days} 天未更新即清理',
    'cli.cleanupPreview.runtimeEffect': 'state/hook-sessions/ 与 state/last-bootstrap.json；两者都是可重建的运行时状态，不属于账本',
    'cli.cleanupPreview.notCovered.ledger': '已写入账本的事件（不可变、只追加）。',
    'cli.cleanupPreview.notCovered.copied': '已经复制出去的备份、快照与外部同步副本。',
    'cli.cleanupPreview.notCovered.hostSessions': '宿主自己的会话记录文件——它们由宿主管理，本程序只读不写。',
    'cli.cleanupPreview.notCovered.replacements': 'backups/replacements/：原子写入的回滚目录，按路径看像备份、其实不是，任何一个正在进行的写入都可能依赖它。',
    'cli.cleanupPreview.note': '只读预览：没有删除任何文件。',
    'cli.exclusions.pathsNote': '匹配该目录本身及其内部的所有路径',
    'cli.exclusions.exactNote': '整值精确匹配（大小写按平台规则）',
    'cli.exclusions.note': '未命中的规则不是错误：它只说明本次给出的样本没有落在该规则下。',
    'cli.privacy.vocab.notCollected.label': '不采集',
    'cli.privacy.vocab.notCollected.meaning': '这段会话根本没有被写入。没有队列条目、没有检查点、没有证据、没有访问日志。',
    'cli.privacy.vocab.notCollected.reversible': '无需恢复',
    'cli.privacy.vocab.retained.label': '软删除 / 不参与检索',
    'cli.privacy.vocab.retained.meaning': '原始记录仍然完整存在于账本里，只是不再进入默认摘要与普通召回。历史与来源仍可追溯。',
    'cli.privacy.vocab.retained.reversible': '可以——记录一直在，恢复检索只是改回策略',
    'cli.privacy.vocab.physical.label': '物理删除',
    'cli.privacy.vocab.physical.meaning': '把已写入的事件从账本中真正抹掉。本程序不提供：账本是只追加的、事件带校验的不可变记录，就地删除会破坏它自身的完整性，也无法收回已经产生的备份与外部同步副本。',
    'cli.privacy.vocab.physical.reversible': '不可以',
    'cli.privacy.decision.global': '全局采集开关已关闭（collection.enabled = false）',
    'cli.privacy.decision.excluded': '排除规则命中：{kind} = {rule}',
    'cli.privacy.decision.workspace': '工作区 {workspace} 的采集开关已关闭',
    'cli.privacy.decision.host': '宿主 {host} 的采集开关已关闭',
    'cli.privacy.decision.collecting': '采集开启',
    'cli.privacy.permanentDeletion': '物理删除未实现，且不是配置开关能提供的能力：账本只追加，事件带校验；就地删除会破坏其完整性，也无法收回已产生的备份与外部同步副本。请用「不采集」阻止写入，用保留策略让派生材料过期，并在采集前就把敏感目录排除。',
    'cli.config.field.storage': '存储后端 storage',
    'cli.config.field.memoryRoot': 'memoryRoot（记忆库根目录）',
    'cli.config.field.vaultRoot': 'vaultRoot（Obsidian 库根目录）',
    'cli.config.field.vaultName': 'vaultName（Obsidian 库名称）',
    'cli.config.field.obsidianCli': 'obsidianCli（Obsidian CLI 路径）',
    'cli.config.field.layout': 'layout（布局）',
    'cli.config.field.activeLimit': 'activeLimit（活跃项目注入条数）',
    'cli.config.field.recentLimit': 'recentLimit（近期变化注入条数）',
    'cli.config.field.recentDays': 'recentDays（近期变化天数窗口）',
    'cli.config.field.budgetBytes': 'budgetBytes（注入预算字节）',
    'cli.config.role.eventsRoot': '事件目录',
    'cli.config.role.topicsRoot': '主题目录',
    'cli.config.role.projectRoot': '项目目录',
    'cli.config.role.habitsNote': '偏好笔记',
    'cli.config.role.actionsNote': '待办笔记',
    'cli.config.role.mistakesNote': '错误笔记',
    'cli.config.role.candidatesNote': '候选笔记',
    'cli.config.role.experienceNote': '经验笔记',
    'cli.config.role.inboxRoot': '收集箱目录',
    'cli.config.number.activeLimit.label': '活跃项目注入条数',
    'cli.config.number.activeLimit.hint': '活跃项目状态最多注入几条（缺省不限制）',
    'cli.config.number.recentLimit.label': '近期变化注入条数',
    'cli.config.number.recentLimit.hint': '近期变化最多注入几条（缺省不限制）',
    'cli.config.number.recentDays.label': '近期变化天数窗口',
    'cli.config.number.recentDays.hint': '近期变化的回溯天数（运行时缺省 14 天）',
    'cli.config.number.budgetBytes.label': '注入预算（字节）',
    'cli.config.number.budgetBytes.hint': '注入正文的总预算，超出会折叠低优先级段落',
    'cli.config.layout.neutral': '中性默认（逻辑角色名，不绑定任何私有目录结构）',
    'cli.config.layout.obsidian-notion': 'Obsidian / Notion 预设（既有私有布局）',
    'cli.config.storage.filesystem': '文件系统（默认，不需要任何外部服务）',
    'cli.config.storage.obsidian-cli': 'Obsidian CLI（必须同时填写 obsidianCli 与 vaultName）',
    'cli.config.value.unset': '（未设置）',
    'cli.config.value.empty': '（空）',
    'cli.config.storeRoot.empty': '{label}不能为空',
    'cli.config.storeRoot.notAbsolute': '{label}必须是绝对路径：{value}',
    'cli.config.storeRoot.insideCheckout': '{label}不能指向本项目仓库目录（{root}），记忆库要放在仓库之外',
    'cli.config.storeRoot.unreadable': '{label}无法访问：{error}',
    'cli.config.storeRoot.notADirectory': '{label}已存在但不是目录：{target}',
    'cli.config.storeRoot.notWritable': '{label}不可写：{target}',
    'cli.config.storeRoot.cannotCreate': '{label}无法创建：{target}',
    'cli.config.storeRoot.parentUnreadable': '{label}的上级路径无法访问：{error}',
    'cli.config.storeRoot.parentNotDirectory': '{label}的上级路径不是目录，无法创建 {target}',
    'cli.config.storeRoot.parentNotWritable': '{label}的上级目录不可写，无法创建 {target}',
    'cli.config.storeRoot.createFailed': '{label}创建失败：{error}',
    'cli.config.storage.invalid': '存储后端只能是 filesystem 或 obsidian-cli（当前：{value}）',
    'cli.config.layout.invalid': '布局只能是 neutral 或 obsidian-notion（当前：{value}）',
    'cli.config.obsidianCli.required': '选择 obsidian-cli 存储后必须填写 obsidianCli（Obsidian CLI 可执行文件路径）',
    'cli.config.vaultName.required': '选择 obsidian-cli 存储后必须填写 vaultName（Obsidian 库名称）',
    'cli.config.note.vaultRootDerived': 'vaultRoot 为空，运行时按 memoryRoot 解析。',
    'cli.config.role.required': 'roles.{role}（{label}）不能为空',
    'cli.config.changeField.role': 'roles.{role}（{label}）',
    'cli.config.note.memoryRootAbsent': '记忆库根目录还不存在，保存时会自动创建并校验角色路径。',
    'cli.config.role.outsideRoot': 'roles.{role} ({label}) 必须位于记忆库根目录内 ({error})',
    'cli.config.number.notInteger': '{label}（{key}）必须是 {min} 到 {max} 之间的整数，当前：{value}',
    'cli.config.error.noChanges': '配置没有变化，无需写入',
    'cli.config.summary.update': '配置改动：{n} 项',
    'cli.config.version.notString': 'version 必须是字符串（当前：{value}）',
    'cli.config.schema.notInteger': 'configSchema 必须是整数（当前：{value}）',
    'cli.config.schema.newer': 'configSchema {version} 比本程序支持的 {supported} 更新；请升级 memkeel，而不是把配置降级。',
    'cli.config.note.schemaMissing': '缺少 configSchema（当前 schema 为 {version}）；运行 memkeel config migrate 查看升级计划。',
    'cli.config.note.unknownKey': '未知字段 {key} 会被原样保留，但不生效；如果是拼写错误请改正。',
    'cli.config.note.deprecatedKey': '顶层 {key} 是旧写法，建议迁移到 {target}（当前仍兼容读取）。',
    'cli.config.roots.disagree': 'memoryRoot 与 vaultRoot 指向不同目录（{a} / {b}）：笔记按 vaultRoot 解析，存储根是 memoryRoot。请让两者一致，或删掉其中一个让它从另一个推导。',
    'cli.config.roots.bothEmpty': 'memoryRoot 与 vaultRoot 都为空，无法确定记忆库根目录。',
  },
};

// A message reference is how library code names prose without choosing a language: `message()` wraps
// a key and its parameters, and the presentation layer renders it with `renderMessages` and its own
// translator. lib/ therefore stays language-neutral, and the CLI, the dashboard and the diagnostics
// export each render the same reference into whichever locale they are serving.
// The prefix is a marker, not a claim about which surface renders the text: references under it are
// rendered by the CLI and by the settings page, which both read this catalogue.
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
  // Only plain objects are walked. Anything else - a Date, a Map, a class instance - is returned as
  // it is, because rebuilding it from its entries would silently replace it with an empty object,
  // and this renderer is meant to be reused on payloads that carry dates.
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
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
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in params)) return match;
    const value = params[name];
    // A parameter may itself be a reference. Several sentences quote the same label as a table
    // entry, and resolving it here is what lets the label keep one home instead of being spelled
    // again inside every sentence. Stringifying it instead would print "[object Object]".
    if (isMessageReference(value)) return translate(locale, value.key, value.params);
    return String(value);
  });
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
