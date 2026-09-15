import { atomicJson } from './transport.mjs';
import path from 'node:path';

// Catalog topics come from config (`config.catalogTopics`), so the core ships with
// no project-specific data. Each entry is { id, workspace, title, aliases?, pattern?, flags? }.
// `pattern` is a regex *source string* because a JSON config cannot hold a RegExp; it is
// compiled here. An entry without a usable pattern simply matches nothing.
export function catalogTopics(config) {
  const rows = Array.isArray(config?.catalogTopics) ? config.catalogTopics : [];
  return rows.flatMap((row) => {
    if (!row || !row.id || !row.workspace || !row.title) return [];
    let pattern = null;
    if (typeof row.pattern === 'string' && row.pattern.length) {
      try { pattern = new RegExp(row.pattern, typeof row.flags === 'string' ? row.flags : 'i'); }
      catch { pattern = null; }
    }
    return [{
      id: row.id,
      workspace: row.workspace,
      title: row.title,
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      pattern,
    }];
  });
}
export function groupLegacySources(config, index, definitions = catalogTopics(config)) {
  const rows = Object.values(index.entries).filter((row) => [config.inboxRoot, config.projectRoot].some((root) => row.path.startsWith(root + '/')) && !['daily-digest', 'memory-events', 'memory-evidence', 'topic-state', 'evidence-catalog'].includes(row.meta.type));
  return definitions.map(({ pattern, ...topic }) => ({ ...topic, authority: 'evidence-only', sources: rows.filter((row) => pattern?.test(row.title))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.path.localeCompare(b.path))
    .map((row) => ({ path: row.path, date: row.date, declaredWorkspace: row.workspace, scopeWarning: Boolean(row.workspace && row.workspace !== topic.workspace) })) })).filter((topic) => topic.sources.length);
}
export function publishCatalog(config, transport, index) {
  const topics = groupLegacySources(config, index);
  const note = `${config.projectRoot}/Agent 主题来源索引.md`;
  const body = `本索引完成存量的逻辑聚类，不删除原文，不把未核验记录提升为当前事实。注册并核实的主题状态页优先于本索引。\n\n${topics.map((topic) => `## ${topic.title}\n工作区：${topic.workspace}；来源 ${topic.sources.length} 条；状态：待按任务核验，不是权威当前结论。\n\n${topic.sources.map((source) => `- [[${source.path.replace(/\.md$/, '')}]]；${source.date ?? '无明确日期'}${source.scopeWarning ? `；原文工作区标记为 ${source.declaredWorkspace}，须核对归属` : ''}`).join('\n\n')}`).join('\n\n')}`;
  transport.managed(note, '---\ntype: evidence-catalog\nscope: global\n---\n# Agent 主题来源索引', body);
  atomicJson(path.join(config.policyRoot, 'state/legacy-catalog.json'), { at: new Date().toISOString(), note, topics });
  return { note, groups: topics.length, references: topics.reduce((count, topic) => count + topic.sources.length, 0), policy: 'Logical grouping only; no deletion or automatic fact promotion.' };
}
