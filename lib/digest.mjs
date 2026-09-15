const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

export function digestTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无效时间（需核对原始事件）';
  const p = Object.fromEntries(clock.formatToParts(date).map(({ type, value }) => [type, value]));
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second + ' +08:00';
}

const singleLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const code = (value) => String.fromCharCode(96) + value + String.fromCharCode(96);
function excerpt(value, limit = 360) {
  const chars = Array.from(singleLine(value));
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('') + '…（摘要已截断，详见证据）';
}

function renderEvent(event, topics, dropped) {
  const topic = topics.find((row) => row.id === event.topic);
  const task = event.contexts?.[0]?.task;
  const title = task ? event.workspace + ' · ' + task : topic?.title ?? event.topic;
  const lines = ['### ' + excerpt(title, 100),
    '- 发生：' + digestTime(event.occurred_at) + '；录入：' + digestTime(event.recorded_at) + '；来源：' + event.agent];
  const start = lines.length;
  if ((event.facts ?? []).length) lines.push('#### 结论');
  for (const fact of event.facts ?? []) lines.push('- ' + singleLine(fact.text));
  if ((event.verification ?? []).length) lines.push('#### 验证');
  for (const text of event.verification ?? []) lines.push('- ' + singleLine(text));
  for (const action of event.actions ?? []) lines.push('- 待办 ' + action.status + '：' + singleLine(action.text) + ' (' + action.id + ')');
  for (const rule of event.preferences ?? []) lines.push('- 候选习惯：' + rule.id + '；' + rule.scope + '；' + singleLine(rule.text));
  for (const decision of event.habit_decisions ?? []) lines.push('- 习惯处理：' + decision.preference_id + ' = ' + decision.status + '；用户原话：' + singleLine(decision.user_quote));
  for (const mistake of event.mistakes ?? []) lines.push('- 已确认错误：' + singleLine(mistake.symptom) + '；修正：' + singleLine(mistake.correction) + '；预防：' + singleLine(mistake.prevention));
  for (const context of event.contexts ?? []) {
    const certainty = context.certainty === 'verified' ? '已验证记录，复用前仍需核对' : '对话报告，未复核';
    // Checkpoints repeat the prompt; keep the task separate from the bounded reply.
    const marker = '最近回复（未复核，不是当前事实）：';
    const text = String(context.text);
    const reply = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text;
    lines.push('#### ' + (event.agent === 'dsh' && !event.facts?.length ? '自动对话检查点' : '短期上下文'));
    lines.push('- 任务：' + singleLine(context.task) + '；状态：' + (context.status ?? 'active') + '；保留期：' + (context.ttl_days ?? 30) + ' 天');
    lines.push('- 摘要（' + certainty + '）：' + excerpt(reply || text));
    if (context.supersedes && !dropped?.has(context.supersedes)) lines.push('- 更新自事件：' + code(context.supersedes));
  }
  for (const experience of event.experiences ?? []) {
    lines.push('- 执行经验（' + experience.kind + '，使用前复核）：' + excerpt(experience.text));
    if (experience.location) lines.push('- 历史路径（重新确认存在性）：' + singleLine(experience.location));
    if (experience.boundary) lines.push('- 搜索边界：' + singleLine(experience.boundary));
    if (experience.expires) lines.push('- 经验有效期至：' + experience.expires);
    lines.push('- 经验验证：' + singleLine(experience.verification));
  }
  if (lines.length === start) lines.push('#### 记录说明\n- 本事件未提供可展示的摘要，请查看来源证据。');
  const sources = [...new Set(event.evidence ?? [])];
  lines.push('#### 来源与审计');
  lines.push('- 证据：' + (sources.length ? sources.map((source) => '[[' + source.replace(/\.md(?=#|$)/, '') + ']]').join('；') : '无'));
  lines.push('- 事件编号：' + code(event.event_id));
  return lines.join('\n');
}

/**
 * Thread key for automatic conversation checkpoints. One session that asked
 * several questions used to render as one flat ### section per turn, so a single
 * conversation filled the digest with siblings that shared no visible parent.
 * Events sharing a `session-...` context id now collapse under one thread node.
 * Ordinary events (no such context) return undefined and render as before.
 */
function threadKey(event) {
  const context = (event.contexts ?? [])[0];
  const id = typeof context?.id === 'string' ? context.id : '';
  return /^session-[A-Za-z0-9_-]+$/.test(id) ? event.topic + '\u0000' + id : undefined;
}

function replyOf(context) {
  const marker = '最近回复（未复核，不是当前事实）：';
  const text = String(context.text ?? '');
  return text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text;
}

/** One turn of a conversation thread: the child node under its session parent. */
function renderTurn(event, ordinal, total, dropped) {
  const context = (event.contexts ?? [])[0] ?? {};
  const certainty = context.certainty === 'verified' ? '已验证记录，复用前仍需核对' : '对话报告，未复核';
  const lines = [
    `#### 第 ${ordinal}/${total} 轮 · ${digestTime(event.occurred_at).slice(11, 19)}`,
    '- 任务：' + singleLine(context.task ?? '（未记录）'),
    `- 摘要（${certainty}）：` + excerpt(replyOf(context) || context.text),
  ];
  // A retained turn may supersede a turn that a nightly retention pass dropped;
  // pointing at a node the reader cannot find is worse than saying nothing.
  if (context.supersedes && !dropped?.has(context.supersedes)) lines.push('- 更新自事件：' + code(context.supersedes));
  return lines.join('\n');
}

/** One session with several turns: a parent heading plus one child per turn. */
function renderThread(group, topics, dropped) {
  const first = group.events[0];
  const last = group.events[group.events.length - 1];
  const topic = topics.find((row) => row.id === first.topic);
  const fingerprint = String(first.contexts?.[0]?.id ?? '').replace(/^session-/, '').slice(0, 8);
  const lines = [
    `### ${excerpt(topic?.title ?? first.topic, 100)} · 会话线 ${code(fingerprint)}（${group.events.length} 轮）`,
    `- 工作区：${first.workspace}；来源：${first.agent}；首轮 ${digestTime(first.occurred_at)}；末轮 ${digestTime(last.occurred_at)}`,
    '- 自动对话检查点，未复核，不是当前事实；后续轮次可能取代同一会话线的前轮。',
  ];
  for (const [index, event] of group.events.entries()) lines.push('', renderTurn(event, index + 1, group.events.length, dropped));
  const sources = [...new Set(group.events.flatMap((event) => event.evidence ?? []))];
  lines.push('', '#### 来源与审计',
    '- 证据：' + (sources.length ? sources.map((source) => '[[' + source.replace(/\.md(?=#|$)/, '') + ']]').join('；') : '无'),
    '- 事件编号：' + group.events.map((event) => code(event.event_id)).join('；'));
  return lines.join('\n');
}

export function dailyDigestBody(events, topics = [], { dropped } = {}) {
  const rows = [...events].sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at) || a.event_id.localeCompare(b.event_id));
  const groups = [];
  const byKey = new Map();
  for (const event of rows) {
    const key = threadKey(event);
    if (key === undefined) { groups.push({ events: [event] }); continue; }
    let group = byKey.get(key);
    if (group === undefined) { group = { events: [] }; byKey.set(key, group); groups.push(group); }
    group.events.push(event);
  }
  const intro = '时间统一显示为北京时间（Asia/Shanghai，UTC+08:00），按录入日期归档。以下为当时的事件记录，不代表当前最终结论；短期对话摘要不自动升级为已验证事实。同一会话的多轮自动检查点合并为一条会话线，逐轮列为子节点。';
  // A single-checkpoint "thread" carries no structure worth a parent node.
  const body = groups.map((group) => (group.events.length > 1 ? renderThread(group, topics, dropped) : renderEvent(group.events[0], topics, dropped))).join('\n\n');
  return intro + '\n\n## 当日事件\n\n' + (body || '- 当日没有已记录事件。');
}


