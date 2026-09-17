// Thin client over the dashboard HTTP surface. Every call here maps to an endpoint
// in dashboard.mjs; nothing in the UI talks to Markdown or the filesystem directly.

async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const message = body?.error || `HTTP ${res.status}`;
    const error = new Error(message);
    // A refusal may carry structured issues beside the sentence the server assembled from them, so a
    // caller that renders text in the reader's language is not forced to show the server's wording.
    if (Array.isArray(body?.issues) && body.issues.length) error.issues = body.issues;
    throw error;
  }
  return body;
}

export function getHealth() {
  return jsonFetch('/health');
}

export function getOverview() {
  return jsonFetch('/api/overview');
}

export function getDetail(type, id) {
  return jsonFetch('/api/detail?type=' + encodeURIComponent(type) + '&id=' + encodeURIComponent(id));
}

export function getSessions() {
  return jsonFetch('/api/sessions');
}

export function getTranscript({ key, host, sessionId }) {
  const params = new URLSearchParams();
  if (key) params.set('key', key);
  if (host) params.set('host', host);
  if (sessionId) params.set('sessionId', sessionId);
  return jsonFetch('/api/transcript?' + params.toString());
}

export function getRevisions({ topic, key, id, type }) {
  const params = new URLSearchParams();
  if (topic) params.set('topic', topic);
  if (key) params.set('key', key);
  if (id) params.set('id', id);
  if (type) params.set('type', type);
  return jsonFetch('/api/revisions?' + params.toString());
}

export function search(query) {
  return jsonFetch('/api/search?q=' + encodeURIComponent(query));
}

export function postWrite(route, body) {
  return jsonFetch('/api/write/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export function getComposeOptions() {
  return jsonFetch('/api/compose-options');
}

// The settings page reads the one config file the program uses: current values, the
// resolved path, whether those paths validate right now, the read-only host binding
// status and the Obsidian detection result.
export function getSettings() {
  return jsonFetch('/api/settings');
}

// Runs one of the revision previews (revise-fact / revise-learning / revise-action /
// revoke-habit) and returns the plan plus a bound execute callback. Every revision
// goes through the same preview-then-execute contract as the other writes.
export async function previewRevision(previewRoute, payload) {
  const preview = await postWrite(previewRoute, payload);
  return {
    preview,
    execute: () => postWrite('execute', {
      action: preview.plan?.kind,
      plan: preview.plan,
      fingerprint: preview.fingerprint,
      token: preview.token,
    }),
  };
}

// Preview then execute in one helper. The caller supplies the preview route and the
// plan builder; this only wires the token handshake the server requires.
export async function previewAndExecute(previewRoute, payload) {
  const preview = await postWrite(previewRoute, payload);
  return {
    preview,
    execute: () => postWrite('execute', {
      action: preview.plan?.kind ?? preview.plan?.plan?.['kind'] ?? undefined,
      plan: preview.plan?.plan ?? preview.plan,
      fingerprint: preview.fingerprint,
      token: preview.token,
    }),
  };
}

