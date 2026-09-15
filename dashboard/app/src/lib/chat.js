// A checkpoint's event text embeds both the reported request and the last reply,
// separated by fixed markers. Splitting it lets the dashboard show a real user bubble
// and an agent bubble instead of one concatenated paragraph.
//
// lib/hooks.mjs composes it as:
//   任务要求（用户报告）：<prompt>
//   最近回复（未复核，不是当前事实）：<reply>
//   工具概况：<per-tool one-liners>
// Historical imports and manual captures can use another request label, so the known
// variants are stripped instead of leaking the raw label into the bubble.
const REQUEST_LABELS = ['任务要求（用户报告）：', '用户输入：', '用户要求：'];
const REPLY_MARKER = '最近回复（未复核，不是当前事实）：';

export function splitTurnText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { request: '', reply: '', transcript: false };
  const idx = raw.indexOf(REPLY_MARKER);
  if (idx === -1) return { request: '', reply: raw, transcript: false };
  const head = raw.slice(0, idx).trim();
  const label = REQUEST_LABELS.find((item) => head.startsWith(item));
  return {
    request: (label ? head.slice(label.length) : head).trim(),
    // The trailing 工具概况 block stays part of the reply: it is the agent-side
    // provenance of the same turn, and 对话回溯 already renders it that way.
    reply: raw.slice(idx + REPLY_MARKER.length).trim(),
    transcript: true,
  };
}

// Only a real checkpoint transcript becomes bubbles. A context composed by hand (the
// dashboard's 新增记忆) has no reply marker, so it stays plain text instead of being
// mislabelled as something the agent said.
export function isTranscriptText(text) {
  return String(text ?? '').includes(REPLY_MARKER);
}

// One-line preview for surfaces that must stay compact, such as search hits.
export function previewLine(text, max = 120) {
  const { request, reply } = splitTurnText(text);
  const value = [request, reply].filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim()
    || String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
