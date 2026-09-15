import path from 'node:path';

const kinds = new Set(['prevention', 'path-finding', 'search-route', 'negative-search', 'workflow', 'verification', 'costly-exploration']);
const operations = new Set(['shell', 'search', 'edit', 'build', 'vault-write', 'other']);
const dayMs = 86400000;
export const memoryNote = (config) => config.experienceNote ?? `${path.posix.dirname(config.habitsNote)}/Agent 经验与短期上下文.md`;
export function validateLearning(event, config) {
  for (const key of ['experiences', 'contexts']) {
    if (event[key] !== undefined && (!Array.isArray(event[key]) || event[key].length > 5)) throw new Error(`${key} must be an array of at most 5 items`);
    const ids = new Set();
    for (const row of event[key] ?? []) {
      if (!/^[a-z0-9-]{1,100}$/.test(row.id ?? '') || ids.has(row.id)) throw new Error('Invalid or duplicate learning id');
      ids.add(row.id);
      if (typeof row.text !== 'string' || !row.text.trim() || row.text.length > 1600) throw new Error('Learning requires bounded text');
      if (row.supersedes !== undefined && typeof row.supersedes !== 'string') throw new Error('Invalid supersedes');
      if (row.status !== undefined && !['active', 'closed', 'invalidated'].includes(row.status)) throw new Error('Invalid learning status');
      if (row.expires && (!/^\d{4}-\d\d-\d\d$/.test(row.expires) || Number.isNaN(Date.parse(row.expires)))) throw new Error('Invalid expiry');
      if (key === 'experiences') {
        if (!kinds.has(row.kind) || !['global', event.workspace].includes(row.scope)) throw new Error('Experience requires kind and explicit scope');
        if (!Array.isArray(row.triggers) || !row.triggers.length || row.triggers.some((s) => typeof s !== 'string' || !s.trim())) throw new Error('Experience requires triggers');
        if (row.operations && (!Array.isArray(row.operations) || row.operations.some((s) => !operations.has(s)))) throw new Error('Invalid operation trigger');
        if (!row.verification || typeof row.verification !== 'string') throw new Error('Experience requires actual verification');
        if (row.kind === 'negative-search' && (!row.boundary || !row.expires)) throw new Error('Negative search requires boundary and expiry');
        if (row.kind === 'path-finding' && !row.location) throw new Error('Path finding requires location');
      } else {
        if (!row.task || typeof row.task !== 'string') throw new Error('Context requires task identity');
        if (row.ttl_days !== undefined && (!Number.isInteger(row.ttl_days) || row.ttl_days < 1 || row.ttl_days > 90)) throw new Error('Context TTL must be 1-90 days');
        if (row.certainty && !['reported', 'verified'].includes(row.certainty)) throw new Error('Invalid context certainty');
      }
    }
  }
}

// Replaying or retrieving an event is not reinforcement. Only an explicit new
// evidence-backed revision changes the active record and its retention clock.
export function learningProjection(events) {
  const entries = new Map(); const conflicts = [];
  for (const event of events) for (const type of ['experiences', 'contexts']) for (const row of event[type] ?? []) {
    const key = `${type}/${event.topic}/${row.id}`;
    const old = entries.get(key);
    if (old && old.event_id !== event.event_id && row.supersedes !== old.event_id) {
      conflicts.push({ key, current: old.event_id, incoming: event.event_id }); continue;
    }
    entries.set(key, { ...row, type, workspace: event.workspace, topic: event.topic, event_id: event.event_id,
      at: event.occurred_at, evidence: event.evidence });
  }
  return { entries: [...entries.values()], conflicts };
}
export function retention(row, now = new Date()) {
  if (['closed', 'invalidated'].includes(row.status)) return row.status;
  if (row.expires && new Date(now).toISOString().slice(0, 10) > row.expires) return 'expired';
  if (row.type !== 'contexts') return 'retained';
  const age = (new Date(now) - new Date(row.at)) / dayMs;
  if (age < -1) return 'future';
  if (age > (row.ttl_days ?? 30)) return 'dormant';
  return age > 7 ? 'warm' : 'hot';
}
function terms(text) {
  return [...new Set([String(text).toLowerCase().trim(), ...[...new Intl.Segmenter('zh', { granularity: 'word' }).segment(String(text).toLowerCase())]
    .filter((s) => s.isWordLike && s.segment.length > 1).map((s) => s.segment)])].filter(Boolean);
}
export function selectLearning(events, { workspace, query = '', operation, type = 'experiences', task, history = false, limit = 5, now = new Date(), excludeEventIds } = {}) {
  if (!workspace && type === 'contexts') return [];
  const q = terms(query);
  return learningProjection(events).entries.filter((r) => r.type === type && (r.scope === 'global' || r.workspace === workspace))
    .filter((r) => !excludeEventIds?.has(r.event_id))
    .filter((r) => history || ['retained', 'hot', 'warm'].includes(retention(r, now)))
    .filter((r) => !task || r.task === task)
    .map((r) => {
      const target = `${r.task ?? ''} ${r.topic} ${r.text} ${(r.triggers ?? []).join(' ')} ${r.location ?? ''}`.toLowerCase();
      const score = q.reduce((n, t) => n + (target.includes(t) ? 1 : 0), 0) + (operation && r.operations?.includes(operation) ? 3 : 0) + (task && task === r.task ? 10 : 0);
      return { ...r, score, lifecycle: retention(r, now), needsReverify: true };
    }).filter((r) => r.score > 0 || (type === 'contexts' && !query.trim()))
    .sort((a, b) => b.score - a.score || Date.parse(b.at) - Date.parse(a.at)).slice(0, Math.min(10, Math.max(1, limit)));
}
export function learningBody(events, now) {
  const projection = learningProjection(events);
  return `历史证据，不是授权或实时事实。休眠不删除；读取不增加使用次数；没有按频率自动确认习惯。\n\n${projection.entries.map((r) => `## ${r.type} / ${r.id}\n- 工作区：${r.workspace}；主题：${r.topic}；生命周期：${retention(r, now)}\n- ${r.text}\n- 事件：${r.event_id}；发生：${r.at}；使用前复核。\n- 证据：${r.evidence.map((s) => `[[${s.replace(/\.md(?=#|$)/, '')}]]`).join('；')}`).join('\n\n') || '- 无记录。'}\n\n## 待核对冲突\n${projection.conflicts.map((c) => `- ${c.key}：保留 ${c.current}，${c.incoming} 未声明 supersedes。`).join('\n') || '- 无。'}`;
}

export function operationCheck(operation = {}, experiences = []) {
  const command = String(operation.command ?? '').slice(0, 24000);
  const kind = operation.kind ?? 'other';
  const matched = []; const warnings = [];
  const add = (id, reason, fix) => matched.push({ id, reason, fix });
  const powershell = operation.shell?.toLowerCase().includes('pwsh') || /powershell|pwsh|\$(?:env:|[a-z]+)|Get-ChildItem/i.test(command);
  let script = command;
  const encoded = command.match(/-(?:EncodedCommand|enc)\s+["']?([A-Za-z0-9+/=]+)/i)?.[1];
  if (encoded) script = Buffer.from(encoded, 'base64').toString('utf16le');
  if (powershell) {
    // Skip single-quoted literals and comments; inspect nested double-quoted scripts.
    const inspect = script.replace(/'[^']*(?:''[^']*)*'/g, "''").replace(/#[^\r\n]*/g, '');
    if (/\$(?:HOME|Host|Error|PSVersionTable)\s*(?:\+?=|\+\+|--)/i.test(inspect) || /foreach\s*\(\s*\$(?:HOME|Host|Error|PSVersionTable)\s+in\b/i.test(inspect))
      add('powershell-automatic-variable', 'PowerShell 自动变量被当作业务变量写入。', '使用 taskRoot、resultRows 等普通变量名。');
    if (/\bforeach\s*\([^)]*\)\s*\{[^{}]*\}\s*\|/is.test(inspect))
      add('powershell-statement-pipe', 'foreach 语句直接接管道会产生 EmptyPipeElement。', '用 @(foreach (...) {...}) | ... 或 ForEach-Object。');
  }
  if (/\bgit\s+apply\b/i.test(command) && !/--check\b/.test(command) && !operation.preflightPassed)
    warnings.push('git apply 必须先对相同补丁完成 --check；预检失败不得继续。');
  if (kind === 'search' && !operation.boundary) warnings.push('先声明实际 cwd 与搜索边界；当前工作区未找到不等于本机不存在。');
  if (experiences.some((r) => r.location)) warnings.push('历史路径尚未在本次操作中验证；先检查存在性、版本和目标特征，再扩大搜索。');
  return { allowed: matched.length === 0, enforcement: 'bounded-static-check-not-permission', matched, warnings, experiences, mustVerify: true };
}
