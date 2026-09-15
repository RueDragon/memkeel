// Tiered read: L0 list -> outline -> full. The point is that a caller can stop at
// the cheapest tier that answers the question instead of always paying for whole
// note bodies. Each tier is a pure function over text already held in memory, so
// reading more never re-reads the filesystem.

const HEADING = /^(#{1,6})\s+(.+)$/gm;

function firstMeaningfulLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('---') || /^[a-z_-]+:\s/.test(trimmed)) continue;
    if (trimmed.startsWith('```') || trimmed.startsWith('<!--')) continue;
    return trimmed.replace(/^[-*]\s+/, '');
  }
  return '';
}

function truncate(text, limit) {
  const chars = Array.from(String(text));
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit).join('')}…`;
}

// L0: one line per hit. Costs almost nothing, enough to decide what to open.
export function l0(hits, { excerptChars = 120 } = {}) {
  return hits.map((hit, index) => ({
    rank: index + 1,
    id: hit.id,
    score: Number(hit.score?.toFixed?.(4) ?? hit.score ?? 0),
    label: hit.label ?? hit.id,
    path: hit.path ?? '',
    excerpt: truncate(hit.excerpt ?? firstMeaningfulLine(hit.text ?? ''), excerptChars),
  }));
}

// Outline: headings only, so a caller can see the shape of a note before reading it.
export function outline(text) {
  const headings = [...String(text ?? '').matchAll(HEADING)].map((match) => ({
    level: match[1].length,
    title: match[2].trim(),
  }));
  return headings;
}

// Full: the body the caller explicitly opened, bounded so one note cannot flood a prompt.
export function full(text, { maxBytes = 12000 } = {}) {
  const raw = String(text ?? '');
  if (Buffer.byteLength(raw) <= maxBytes) return raw;
  let result = '';
  for (const char of raw) {
    if (Buffer.byteLength(result + char) > maxBytes) break;
    result += char;
  }
  return `${result}\n…（已按 ${maxBytes} 字节截断，需要更多内容请直接打开来源文件）`;
}

// Renders a chosen tier for the prompt. `tier` is one of l0|outline|full.
export function render(hits, tier = 'l0', { excerptChars, maxBytes } = {}) {
  if (tier === 'l0') {
    const rows = l0(hits, { excerptChars });
    if (!rows.length) return '没有匹配的记忆。';
    return rows.map((row) => `${row.rank}. [${row.id}] ${row.label}（score ${row.score}）\n   ${row.excerpt}\n   来源：${row.path}`).join('\n');
  }
  if (tier === 'outline') {
    return hits.map((hit) => {
      const headings = outline(hit.text).map((h) => `${'  '.repeat(h.level - 1)}- ${h.title}`).join('\n');
      return `## ${hit.label ?? hit.id}\n${headings || '- （无标题结构）'}\n来源：${hit.path}`;
    }).join('\n\n') || '没有匹配的记忆。';
  }
  if (tier === 'full') {
    return hits.map((hit) => `## ${hit.label ?? hit.id}\n${full(hit.text, { maxBytes })}\n来源：${hit.path}`).join('\n\n') || '没有匹配的记忆。';
  }
  throw new Error(`Unknown read tier: ${tier}`);
}
