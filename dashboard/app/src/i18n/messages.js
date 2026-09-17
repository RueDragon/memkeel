// The message catalogue. Stable keys, one table per locale, no runtime dependencies — deliberately
// plain data so a test can import it in Node and check that no locale is missing a key, without a
// JSX parser or a build step.
//
// Keys are dotted and named for what they are, not for where they appear, so a string can move
// between components without being renamed. Only interface text lives here: text that comes out of
// the store (event bodies, fact text, topic titles, user replies) is evidence and is never translated.

export const LOCALES = ['zh-Hans', 'en'];
export const DEFAULT_LOCALE = 'zh-Hans';

export const MESSAGES = {
  'zh-Hans': {
    'nav.dashboard.label': '总览',
    'nav.dashboard.desc': '近期在追踪什么、有哪些已确认习惯、哪些待办未清、哪里存在冲突。图表可点击跳转。',
    'nav.contexts.label': '短期记忆',
    'nav.contexts.desc': '带 TTL 的任务上下文，记录某次会话的进行中状态。热 7 天、温 30 天，之后转为休眠仅供追溯。点击工作区或来源事件可跳转。',
    'nav.facts.label': '长期记忆',
    'nav.facts.desc': '跨会话稳定成立的事实结论，由事件归约而来。冲突时双方并存，不会自动覆盖，需显式 supersedes。点击主题可跳转，点击整行查看完整内容与来源事件。',
    'nav.experiences.label': '执行经验',
    'nav.experiences.desc': '在执行同类操作前触发的经验条目，记录已验证的路径、边界与失败教训。点击工作区或来源事件可跳转。',
    'nav.habits.label': '偏好与习惯',
    'nav.habits.desc': '已确认的偏好才会作为强制规则注入。自动学习最高只能提升到试用中，正式确认必须由你本人的原话授权。',
    'nav.actions.label': '待办',
    'nav.actions.desc': '由事件归约出的未完成事项。关闭待办会追加一条带原证据的新事件，不会改写历史。点击主题或来源事件可跳转。',
    'nav.conflicts.label': '冲突',
    'nav.conflicts.desc': '同一事实键出现不同说法且未声明 supersedes 时，双方都会保留，等待人工澄清。点击整行并排查看两种说法。',
    'nav.events.label': '事件流',
    'nav.events.desc': '不可变事件日志，是记忆库的唯一真源。点击工作区与主题可跳转，点击整行查看完整载荷。',
    'nav.sessions.label': '对话回溯',
    'nav.sessions.desc': '按终端查看跨 Agent 会话，点开会话可以看当前轮次的任务、回复、工具调用和每次自动检查点的原始上下文。',
    'nav.reference.label': '说明',
    'nav.reference.desc': '界面里出现的所有标签、状态与枚举的完整解释。拿不准某个颜色或词是什么意思时查这里。',
    'nav.system.label': '系统',
    'nav.system.desc': '记忆库的运行状态、索引与访问统计。访问记录用于给真正被读取的记录加权，不会自动确认偏好。',
    'nav.settings.label': '设置',
    'nav.settings.desc': '编辑那一份 config.json：存储后端与目录、记忆库布局与角色路径、检索与注入参数。保存走预览与签名令牌；宿主绑定是 CLI 专属，这里只做只读体检，写入后需要重启宿主里的常驻 MCP 进程。',
    // Shared field and payload vocabulary. These repeat across views, which is why they are keyed by
    // meaning rather than per screen.
    'col.topic': '主题',
    'col.workspace': '工作区',
    'col.key': '键',
    'col.eventId': '事件 ID',
    'col.agent': 'Agent',
    'col.occurredAt': '发生时间',
    'col.payload': '载荷',
    'col.currentRetained': '当前保留',
    'col.incomingClaim': '不同说法',
    'kind.facts': '事实',
    'kind.contexts': '上下文',
    'kind.experiences': '经验',
    'kind.actions': '待办',
    'kind.preferences': '偏好',
    'kind.mistakes': '错误',
    'col.id': 'ID',
    'col.task': '任务',
    'col.contextText': '上下文',
    'col.lifecycle': '生命周期',
    'col.at': '时间',
    'col.source': '来源',
    'col.ops': '操作',
    'col.experienceText': '操作 / 边界',
    'link.sourceEvent': '来源事件',
    'action.revise': '修正',
    'action.retire': '停用',
    'contexts.filter': '筛选上下文…',
    'experiences.filter': '筛选经验…',
    'conflicts.empty': '当前没有未解决冲突',
    'conflicts.filter': '筛选冲突…',
    'events.filter': '筛选事件…',
    'shell.brandSub': '跨 Agent 记忆库',
    'shell.newMemory': '新增记忆',
    'shell.searchPlaceholder': '搜索记忆…',
    'shell.backendDown': '后端未连接',
    'shell.backendUp': '后端正常',
    'shell.offline': '离线',
    'shell.online': '在线',
    'shell.connecting': '连接中',
    'shell.refresh': '刷新数据',
    'shell.loadFailed': '加载失败：{error}',
    'shell.retry': '重试',
    'shell.language': '语言',
    'locale.zh-Hans': '中文',
    'locale.en': 'English',
  },
  en: {
    'nav.dashboard.label': 'Overview',
    'nav.dashboard.desc': 'What is being tracked, which habits are confirmed, what is still open, and where two accounts conflict. Charts link through.',
    'nav.contexts.label': 'Short-term',
    'nav.contexts.desc': 'Task contexts with a TTL, recording the in-progress state of a session. Hot for 7 days, warm for 30, then dormant and kept only for traceability. Workspaces and source events link through.',
    'nav.facts.label': 'Long-term',
    'nav.facts.desc': 'Conclusions that hold across sessions, reduced from events. When two disagree both are kept, and neither overwrites the other without an explicit supersedes. Topics link through; a row opens the full text and its source events.',
    'nav.experiences.label': 'Experiences',
    'nav.experiences.desc': 'Entries triggered before similar work, recording verified paths, boundaries and failure lessons. Workspaces and source events link through.',
    'nav.habits.label': 'Preferences',
    'nav.habits.desc': 'Only confirmed preferences are injected as rules. Automatic learning can raise a candidate to probationary at most; confirmation requires your own words.',
    'nav.actions.label': 'Open work',
    'nav.actions.desc': 'Unfinished items reduced from events. Closing one appends a new event carrying the original evidence; history is never rewritten. Topics and source events link through.',
    'nav.conflicts.label': 'Conflicts',
    'nav.conflicts.desc': 'When one fact key has two accounts and no supersedes, both are kept until a person resolves it. A row shows the two accounts side by side.',
    'nav.events.label': 'Events',
    'nav.events.desc': 'The immutable event log, and the only source of truth. Workspaces and topics link through; a row opens the full payload.',
    'nav.sessions.label': 'Transcripts',
    'nav.sessions.desc': 'Cross-agent sessions by terminal. Opening one shows the current turn\u2019s task, reply and tool calls, and the raw context of each automatic checkpoint.',
    'nav.reference.label': 'Reference',
    'nav.reference.desc': 'Every label, status and enum that appears in the interface, explained. Look here when a colour or a word is unclear.',
    'nav.system.label': 'System',
    'nav.system.desc': 'Runtime state, index and access statistics. Access records weight what is actually read; they never confirm a preference.',
    'nav.settings.label': 'Settings',
    'nav.settings.desc': 'Edit the one config.json: storage backend and directories, memory layout and role paths, retrieval and injection parameters. Saving goes through a preview and a signed token. Host binding belongs to the CLI; this page only reports, and writing needs the host\u2019s resident MCP process restarted.',
    // Shared field and payload vocabulary. These repeat across views, which is why they are keyed by
    // meaning rather than per screen.
    'col.topic': 'Topic',
    'col.workspace': 'Workspace',
    'col.key': 'Key',
    'col.eventId': 'Event ID',
    'col.agent': 'Agent',
    'col.occurredAt': 'Occurred',
    'col.payload': 'Payload',
    'col.currentRetained': 'Kept',
    'col.incomingClaim': 'Other account',
    'kind.facts': 'facts',
    'kind.contexts': 'contexts',
    'kind.experiences': 'experiences',
    'kind.actions': 'open work',
    'kind.preferences': 'preferences',
    'kind.mistakes': 'mistakes',
    'col.id': 'ID',
    'col.task': 'Task',
    'col.contextText': 'Context',
    'col.lifecycle': 'Lifecycle',
    'col.at': 'Time',
    'col.source': 'Source',
    'col.ops': 'Actions',
    'col.experienceText': 'What it does / limits',
    'link.sourceEvent': 'Source event',
    'action.revise': 'Revise',
    'action.retire': 'Retire',
    'contexts.filter': 'Filter contexts…',
    'experiences.filter': 'Filter experiences…',
    'conflicts.empty': 'No unresolved conflicts',
    'conflicts.filter': 'Filter conflicts…',
    'events.filter': 'Filter events…',
    'shell.brandSub': 'Cross-agent memory',
    'shell.newMemory': 'New memory',
    'shell.searchPlaceholder': 'Search memory\u2026',
    'shell.backendDown': 'Backend unreachable',
    'shell.backendUp': 'Backend healthy',
    'shell.offline': 'Offline',
    'shell.online': 'Online',
    'shell.connecting': 'Connecting',
    'shell.refresh': 'Refresh data',
    'shell.loadFailed': 'Failed to load: {error}',
    'shell.retry': 'Retry',
    'shell.language': 'Language',
    'locale.zh-Hans': '中文',
    'locale.en': 'English',
  },
};

export const STORAGE_KEY = 'memkeel.locale';

/** Resolve a key for one locale, falling back to the default locale and then to the key itself. */
export function translate(locale, key, params) {
  const table = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
  let text = table[key];
  if (text === undefined) text = MESSAGES[DEFAULT_LOCALE][key];
  // Returning the key makes a missing string visible in the interface instead of blank or undefined,
  // which is what the completeness test exists to prevent.
  if (text === undefined) return key;
  if (params) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/** Best-effort initial locale: an explicit choice wins, then the browser, then the default. */
export function detectLocale(stored, navigatorLanguage) {
  if (stored && LOCALES.includes(stored)) return stored;
  const wanted = String(navigatorLanguage ?? '').toLowerCase();
  if (wanted.startsWith('zh')) return 'zh-Hans';
  if (wanted.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}
