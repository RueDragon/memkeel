// The dashboard receives raw journal events: one event may carry facts, contexts,
// experiences, actions, preferences, mistakes or habit decisions, and not every kind
// carries display text. Any surface that lists events therefore has to derive its own
// one-line summary. The precedence below mirrors the daily digest headline (conclusion
// first, then the checkpoint task), so the console and the digest describe one event the
// same way; this is the frontend twin of the digest's renderEvent().
const MAX = 160;

function oneLine(value, max = MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function first(rows, pick) {
  return (Array.isArray(rows) ? rows : []).find((row) => row && pick(row));
}

export function eventSummary(event, max = MAX) {
  if (!event) return '';
  const fact = first(event.facts, (row) => row.text);
  if (fact) return oneLine(fact.text, max);
  const context = first(event.contexts, (row) => row.task || row.text);
  if (context) return oneLine(context.task || context.text, max);
  const experience = first(event.experiences, (row) => row.text);
  if (experience) return oneLine(experience.text, max);
  const action = first(event.actions, (row) => row.text);
  if (action) return oneLine(action.text, max);
  const preference = first(event.preferences, (row) => row.text);
  if (preference) return oneLine(preference.text, max);
  const decision = first(event.habit_decisions, (row) => row.preference_id);
  if (decision) return oneLine(`习惯处理 ${decision.preference_id} = ${decision.status ?? ''}`, max);
  const mistake = first(event.mistakes, (row) => row.symptom);
  if (mistake) return oneLine(mistake.symptom, max);
  const verification = (Array.isArray(event.verification) ? event.verification : []).find(Boolean);
  if (verification) return oneLine(verification, max);
  return '';
}

// Payload kinds present on an event, in the same order and wording the events table tags
// them, so a row can say what it holds without opening it.
const KIND_LABELS = [
  ['facts', '结论'], ['contexts', '上下文'], ['experiences', '经验'],
  ['actions', '待办'], ['preferences', '偏好'], ['mistakes', '错误'],
];

export function eventKinds(event) {
  if (!event) return [];
  return KIND_LABELS.filter(([key]) => (event[key] ?? []).length).map(([, label]) => label);
}
