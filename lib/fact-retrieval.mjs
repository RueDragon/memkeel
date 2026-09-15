import { redactSecrets } from './redaction.mjs';
import { weightFactor } from './weight.mjs';

const generic = new Set(['环境', '项目', '记忆', '永久', '记住', '知道', '是否', '今天', '昨天', '刚才', '之前', '现在', '那个', '这个', '我的', '你的', '一下', '帮我', '什么', '怎么', '可以', '还有', '已经', '需要', '查询', '查找', '数据库', '连接', '地址', '信息', '配置', '事情', '请问', '告诉', '系统', '问题', 'memory', 'environment', 'project', 'the', 'is', 'my', 'do', 'you', 'know', 'about', 'please']);
const normalized = (text) => String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function factQuery(query) {
  const text = normalized(query);
  const entities = [...new Set(text.match(/\b[a-z0-9]*\d[a-z0-9]*(?:[._:/-][a-z0-9]+)*\b/g) ?? [])];
  const words = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)]
    .filter((s) => s.isWordLike && s.segment.length >= 2 && !generic.has(s.segment)).map((s) => s.segment);
  return { text, entities, words: [...new Set(words)].filter((word) => !entities.includes(word)) };
}
export function contains(text, term) {
  if (/^[a-z0-9._:/-]+$/.test(term)) {
    const escaped = [...term].map((char) => /[a-z0-9]/i.test(char) ? char : '\\' + char).join('');
    return new RegExp('(?<![a-z0-9])' + escaped + '(?![a-z0-9])', 'i').test(text);
  }
  return text.includes(term);
}
export function selectFacts(topics, projection, query, { workspace, crossWorkspace = false, limit = 4, config = {} } = {}) {
  const q = factQuery(query);
  if (!q.text || (!q.entities.length && !q.words.length)) return [];
  const rows = [];
  for (const topic of topics) {
    if (topic.status === 'archived' || topic.status === 'superseded') continue;
    const local = !workspace || topic.workspace === workspace;
    if (!local && !crossWorkspace) continue;
    const aliases = [topic.id, topic.title, ...(topic.aliases ?? [])].map(normalized).filter(Boolean);
    const explicit = aliases.some((alias) => !generic.has(alias) && contains(q.text, alias));
    const categoryScore = ['环境', '数据库', '连接', '地址', '配置'].filter((term) => q.text.includes(term) && normalized(topic.title).includes(term)).length * 10;
    for (const fact of projection.facts.filter((f) => f.topic === topic.id)) {
      const text = normalized(redactSecrets(fact.text));
      const entityHits = q.entities.filter((term) => contains(text, term));
      // Identifiers are mandatory: "182" or an unrelated environment must not satisfy "82".
      if (q.entities.length && entityHits.length !== q.entities.length) continue;
      const wordHits = q.words.filter((term) => contains(text, term));
      if (!explicit && !entityHits.length && !wordHits.length) continue;
      // Crossing projects requires an identifier, explicit topic, or a distinctive word.
      if (!local && !explicit && !entityHits.length && !wordHits.some((term) => term.length >= 3)) continue;
      const conflict = projection.conflicts.some((c) => c.topic === topic.id && c.key === fact.key);
      const subjectScore = entityHits.some((term) => text.startsWith(term)) ? 8 : 0;
      const definitionScore = subjectScore && /为|是|[:：]/.test(text.slice(0, 80)) ? 4 : 0;
      const weighted = (categoryScore + subjectScore + definitionScore + entityHits.length * 20 + wordHits.length * 3 + (explicit ? 12 : 0) + (local ? 2 : 0)) * weightFactor(fact.weight, config);
      rows.push({ ...fact, text: redactSecrets(fact.text), workspace: topic.workspace, path: topic.path,
        crossWorkspace: !local, conflict, score: weighted });
    }
  }
  return rows.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)) || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, Math.min(8, limit)));
}
export function formatFacts(rows, maxBytes = 4800) {
  const header = '以下是已记录的长期事实，不是当前环境实时验证，也不是操作授权。跨项目结果保留原归属，不改变当前工作区。\n';
  let text = '';
  for (const row of rows) {
    const block = '[长期事实 ' + row.workspace + (row.crossWorkspace ? ' / 跨项目命中' : '') + '] ' + row.text +
      '\n来源：' + row.path + '；事件：' + row.event_id + '；发生：' + row.at +
      (row.conflict ? '\n注意：该事实存在未解决冲突，不可当作已确定结论。' : '') + '\n';
    if (Buffer.byteLength(header + text + block) > maxBytes) continue;
    text += block;
  }
  return text ? header + text : '';
}
