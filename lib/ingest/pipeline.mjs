import crypto from 'node:crypto';

// Importance gate: deterministic and explainable. Keeps the vault from flooding
// with trivial coordination turns ("ok", "继续", "thanks") while never blocking on
// a model. Mirrors the two-signal design: how much was said, and whether it
// carries durable intent (decision, preference, correction, lesson, convention).
const TRIVIAL = new Set([
  'ok', 'okay', 'thanks', 'thank you', 'yes', 'no', 'yep', 'nope', 'sure', 'sounds good', 'lgtm',
  'got it', 'great', 'perfect', 'done', 'cool', 'continue', 'go on', 'next',
  '好', '好的', '谢谢', '是', '不是', '继续', '可以', '行', '收到', '明白', '下一个', '嗯',
]);

const SIGNAL_MARKERS = [
  'decid', 'prefer', 'instead', 'actually', 'remember', 'always', 'never',
  'root cause', 'the bug', 'because', 'lesson', 'gotcha', 'footgun', 'todo', 'important',
  'must ', 'should ', 'convention', 'do not', "don't",
  '决定', '偏好', '以后', '记住', '必须', '不要', '不能', '注意', '约定', '规范', '根因', '结论',
];

const KEEP_THRESHOLD = 0.5;

export function importanceScore(text) {
  const stripped = String(text ?? '').trim();
  const low = stripped.toLowerCase().replace(/[。.!！\s]+$/g, '');
  if (TRIVIAL.has(low)) return 0;
  const words = [...stripped].length;
  const latin = stripped.match(/\b[\p{L}\p{N}]+\b/gu)?.length ?? 0;
  const lengthUnits = Math.max(words, latin);
  if (lengthUnits < 4) return 0;
  let score = Math.min(lengthUnits / 40, 1) * 0.4;
  const hits = SIGNAL_MARKERS.filter((marker) => low.includes(marker)).length;
  score += Math.min(hits * 0.25, 0.6);
  return Math.min(score, 1);
}

export function isImportant(text, threshold = KEEP_THRESHOLD) {
  return importanceScore(text) >= threshold;
}

export function contentHash(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

// Dedup ledger kept beside the other runtime state. Idempotent by content hash, so
// re-running a backfill never writes the same turn twice.
export class DedupLedger {
  constructor(file, initial = []) {
    this.file = file;
    this.seen = new Set(initial);
  }
  has(hash) { return this.seen.has(hash); }
  add(hash) {
    if (this.seen.has(hash)) return false;
    this.seen.add(hash);
    return true;
  }
}
