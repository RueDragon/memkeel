import React, { useEffect, useState } from 'react';
import { Modal, Spin, Empty, Tag, Button, Space, Divider, App as AntApp } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import { getDetail, getRevisions, postWrite } from '../lib/api.js';
import DecisionModal from './DecisionModal.jsx';
import EditModal from './EditModal.jsx';
import { EventLink } from './Links.jsx';
import { ChatExchange, ChatThread } from './ChatBubbles.jsx';
import { isTranscriptText } from '../lib/chat.js';
import { useI18n } from '../i18n/index.jsx';

// KIND_LABEL, FIELD_LABEL and BOOL_LABEL moved inside the component: they are translated now, and
// almost every entry in them was already named elsewhere in the catalogue.

// Structured values (facts / actions / experiences / evidence lists) are the bulky
// part of an event. Rendering them as inline tags let long JSON strings push past the
// modal edge, so arrays of objects become wrapping rows and plain arrays become
// wrapping chips with a hard width bound.
//
// The boolean labels are passed in rather than read from module scope, because they are translated
// now and this helper is not a component. Only booleans need labels here; objects render as JSON, and
// the helper does not recurse.
function renderValue(value, boolLabel) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (typeof value === 'boolean') return <Tag color={value ? 'red' : 'default'}>{boolLabel[String(value)]}</Tag>;

  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">—</span>;
    const allPlain = value.every((v) => typeof v !== 'object' || v === null);
    if (allPlain) {
      return (
        <div className="value-chips">
          {value.map((v, i) => <span className="value-chip" key={i}>{String(v)}</span>)}
        </div>
      );
    }
    return (
      <div className="value-list">
        {value.map((v, i) => (
          <pre className="json-block json-block--item" key={i}>{JSON.stringify(v, null, 2)}</pre>
        ))}
      </div>
    );
  }

  if (typeof value === 'object') return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
  return <span className="detail-value">{String(value)}</span>;
}

export default function DetailDrawer({ detail, onClose, model, onChanged, openDetail }) {
  const { t } = useI18n();
  const KIND_LABEL = {
    fact: t('search.kind.fact'), context: t('search.kind.context'), experience: t('search.kind.experience'),
    habit: t('kind.preferences'), action: t('kind.actions'), event: t('search.kind.event'),
    workspace: t('col.workspace'), topic: t('col.topic'), conflict: t('ref.fact.conflict'),
  };
  const FIELD_LABEL = {
    id: t('col.id'), topic: t('col.topic'), workspace: t('col.workspace'), agent: t('col.agent'), text: t('field.text'),
    event_id: t('col.eventId'), at: t('col.at'), occurred_at: t('col.occurredAt'), recorded_at: t('detail.field.recordedAt'),
    status: t('field.status'), weight: t('detail.field.weight'), lifecycle: t('col.lifecycle'), scope: t('field.scope'),
    triggers: t('compose.triggers'), source_event: t('link.sourceEvent'), certainty: t('compose.certainty'), task: t('compose.task'),
    evidence: t('detail.field.evidence'), supersedes: t('detail.field.supersedes'), key: t('col.key'), conflict: t('ref.fact.conflict'), open: t('value.open'),
    kind: t('field.kind'), type: t('field.kind'), expires: t('detail.field.expires'), operations: t('detail.field.operations'), verification: t('compose.verification'),
    boundary: t('detail.field.boundary'), location: t('detail.field.location'), decision_event: t('detail.field.decisionEvent'), decision: t('field.decision'),
    ttl_days: t('field.ttlDays'), prompt: t('detail.field.prompt'), lastAssistant: t('detail.field.lastAssistant'), turns: t('detail.field.turns'),
  };
  const BOOL_LABEL = { true: t('bool.yes'), false: t('bool.no') };
  const { message } = AntApp.useApp();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(false);
  const [decision, setDecision] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [revisions, setRevisions] = useState(null);

  useEffect(() => {
    if (!detail) { setRecord(null); return; }
    let alive = true;
    setLoading(true);
    getDetail(detail.type, detail.id)
      .then((data) => { if (alive) setRecord(data); })
      .catch((e) => { if (alive) message.error(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // Intentionally keyed on the detail target only. Depending on the Ant message
    // instance re-runs this effect on every render, which left the drawer spinning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.type, detail?.id]);

  // Revision history is a second, lazy read. It needs the topic, which only the loaded
  // record carries, so it runs after the detail resolves and only for records that have
  // a supersede chain.
  useEffect(() => {
    if (!record || !detail) { setRevisions(null); return undefined; }
    const query = detail.type === 'fact' ? { topic: record.topic, key: record.key, type: 'facts' }
      : detail.type === 'context' ? { topic: record.topic, id: record.id, type: 'contexts' }
      : detail.type === 'experience' ? { topic: record.topic, id: record.id, type: 'experiences' }
      : null;
    if (!query) { setRevisions(null); return undefined; }
    let alive = true;
    getRevisions(query).then((data) => { if (alive) setRevisions(data.revisions ?? []); }).catch(() => { if (alive) setRevisions(null); });
    return () => { alive = false; };
  }, [record?.event_id, detail?.type, detail?.id]);

  const action = detail?.type === 'action' && record && record.status !== 'done' ? record : null;
  const habit = detail?.type === 'habit' && record && ['candidate', 'probationary', undefined, null].includes(record.status) ? record : null;
  // A confirmed preference cannot be re-decided (there is no candidate left to vote
  // on), so revoking it is a separate supersede of the prior decision.
  const confirmedHabit = detail?.type === 'habit' && record?.status === 'confirmed' ? record : null;

  // Builds the edit target for each memory type. Facts key on topic+key and contexts /
  // experiences on their id; all of them carry the source event so the backend can
  // refuse a revision computed against a value that already moved.
  const editFor = () => {
    // Both guards are required: closing the drawer sets detail to null first, while the
    // loaded record stays in state until its effect clears it, so a render with
    // detail === null and a record present is normal — and this runs on every render.
    if (!record || !detail) return null;
    if (detail.type === 'fact') {
      return {
        type: 'fact', text: record.text, eventId: record.event_id, previewRoute: 'revise-fact/preview',
        payload: { topic: record.topic, key: record.key },
      };
    }
    if (detail.type === 'context') {
      return {
        type: 'context', text: record.text, eventId: record.event_id, previewRoute: 'revise-learning/preview',
        payload: { type: 'contexts', topic: record.topic, id: record.id },
      };
    }
    if (detail.type === 'experience') {
      return {
        type: 'experience', text: record.text, eventId: record.event_id, previewRoute: 'revise-learning/preview',
        payload: { type: 'experiences', topic: record.topic, id: record.id },
      };
    }
    if (detail.type === 'action') {
      return {
        type: 'action', text: record.text, eventId: record.event_id, previewRoute: 'revise-action/preview',
        payload: { topic: record.topic, actionId: record.id },
      };
    }
    return null;
  };
  const editable = editFor();

  // Conflict resolution is not an edit of either side: it appends a new fact that
  // names which side wins, via supersedes. Choosing the newer claim supersedes the
  // currently retained event; keeping the current claim supersedes the incoming one.
  // Either way both original events remain in the journal.
  const resolveConflict = async (winner) => {
    const keep = winner === 'incoming' ? record.incoming : record.current;
    const lose = winner === 'incoming' ? record.current : record.incoming;
    if (!keep?.text) { message.error(t('detail.noContent')); return; }
    if (!lose?.event_id) { message.error(t('detail.noSourceEvent')); return; }
    try {
      const p = await postWrite('revise-fact/preview', {
        topic: record.topic,
        key: record.key,
        text: keep.text,
        expectedEvent: record.current?.event_id,
        supersedeEvent: lose.event_id,
      });
      setDecision({
        title: winner === 'incoming' ? t('detail.keepIncoming') : t('detail.keepCurrent'),
        summary: p.plan.summary,
        changes: [
          { field: t('detail.keepField'), from: record.current?.text, to: keep.text },
          { field: 'supersedes', from: lose.event_id, to: t('detail.supersedeNote') },
        ],
        onConfirm: async () => {
          // The server built the plan against the exact supersede target, so execute
          // exactly what it returned; no client-side retargeting.
          const res = await postWrite('execute', { action: 'revise-fact', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success(t('detail.resolved'));
          onChanged?.();
          onClose();
          return res;
        },
      });
    } catch (e) { message.error(e.message); }
  };

  const revokeHabit = async () => {
    try {
      const p = await postWrite('revoke-habit/preview', { preferenceId: confirmedHabit.id });
      setDecision({
        title: t('habits.revoke'),
        summary: p.plan.summary,
        changes: p.plan.changes,
        onConfirm: async () => {
          const res = await postWrite('execute', { action: 'revoke-habit', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success(t('habits.revoked'));
          onChanged?.();
          onClose();
          return res;
        },
      });
    } catch (e) { message.error(e.message); }
  };

  const closeAction = async () => {
    try {
      const p = await postWrite('close-action/preview', { topic: action.topic, actionId: action.id });
      setDecision({
        title: t('actions.closeTitle'),
        summary: p.plan.summary,
        changes: p.plan.changes,
        onConfirm: async () => {
          const res = await postWrite('execute', { action: 'close-action', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success(t('actions.closed'));
          onChanged?.();
          onClose();
          return res;
        },
      });
    } catch (e) { message.error(e.message); }
  };

  const decideHabit = async (verdict) => {
    try {
      const p = await postWrite('habit-decision/preview', { candidateEvent: habit.source_event, preferenceId: habit.id, decision: verdict });
      setDecision({
        title: verdict === 'confirmed' ? t('detail.confirmHabit') : t('detail.rejectHabit'),
        summary: p.plan.summary,
        changes: p.plan.changes,
        needsQuote: p.plan.requiresUserQuote,
        onConfirm: async (quote) => {
          const finalPreview = p.plan.requiresUserQuote
            ? await postWrite('habit-decision/preview', { candidateEvent: habit.source_event, preferenceId: habit.id, decision: verdict, userQuote: quote })
            : p;
          const res = await postWrite('execute', {
            action: 'habit-decision',
            plan: finalPreview.plan.plan ?? finalPreview.plan,
            fingerprint: finalPreview.fingerprint,
            token: finalPreview.token,
          });
          message.success(verdict === 'confirmed' ? t('habits.confirmed') : t('habits.rejected'));
          onChanged?.();
          onClose();
          return res;
        },
      });
    } catch (e) { message.error(e.message); }
  };

  // Event contexts, a context's own transcript and a session's replay all carry the same
  // request/reply text. Render them as the shared chat bubbles and keep those raw fields
  // out of the flat key/value grid; everything else still falls through to it.
  const eventContexts = detail?.type === 'event' && Array.isArray(record?.contexts) && record.contexts.length > 0
    ? record.contexts : null;
  const contextTranscript = detail?.type === 'context' && record && isTranscriptText(record.text) ? record : null;
  const sessionRecord = detail?.type === 'session' && record ? record : null;
  const chatFields = new Set();
  if (eventContexts) chatFields.add('contexts');
  if (contextTranscript) { chatFields.add('text'); chatFields.add('task'); }
  if (sessionRecord) ['prompt', 'lastAssistant', 'turns'].forEach((key) => chatFields.add(key));
  const entries = record
    ? Object.entries(record).filter(([k]) => k !== 'raw' && !chatFields.has(k))
    : [];
  // A conflict has two sides that should be read side by side, not as a flat key/value
  // dump. Render those two texts explicitly and let the rest fall through.
  const isConflict = detail?.type === 'conflict' && record;

  return (
    <>
      <Modal
        open={!!detail}
        onCancel={onClose}
        footer={null}
        width={640}
        centered
        title={detail ? `${KIND_LABEL[detail.type] ?? detail.type}${t('detail.suffix')}` : ''}
        destroyOnClose
        className="detail-modal"
      >
        {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          : !record ? <Empty description={t('detail.notFound')} />
          : (
            <>
              {(action || habit || confirmedHabit || editable) && (
                <>
                  <Space wrap>
                    {action && <Button type="primary" icon={<CheckOutlined />} onClick={closeAction}>{t('actions.closeTitle')}</Button>}
                    {habit && <Button type="primary" icon={<CheckOutlined />} onClick={() => decideHabit('confirmed')}>{t('detail.confirmHabit')}</Button>}
                    {habit && <Button danger icon={<CloseOutlined />} onClick={() => decideHabit('rejected')}>{t('detail.rejectHabit')}</Button>}
                    {confirmedHabit && <Button danger icon={<StopOutlined />} onClick={revokeHabit}>{t('habits.revoke')}</Button>}
                    {editable && <Button icon={<EditOutlined />} onClick={() => setEditTarget(editable)}>{t('action.revise')}</Button>}
                    {editable && <Button danger icon={<StopOutlined />} onClick={() => setEditTarget({ ...editable, retire: true })}>{t('action.retire')}</Button>}
                  </Space>
                  <Divider style={{ margin: '14px 0' }} />
                </>
              )}
              {isConflict ? (
                <>
                  <div className="conflict-sides">
                    <div className="conflict-side">
                      <div className="conflict-head">{t('col.currentRetained')}</div>
                      <p>{record.current?.text ?? '—'}</p>
                      {record.current?.event_id && (
                        <EventLink value={record.current.event_id} openDetail={openDetail} label={t('detail.viewSourceEvent')} />
                      )}
                      <Button size="small" onClick={() => resolveConflict('current')} style={{ marginTop: 8 }}>
                        {t('detail.keepCurrent')}
                      </Button>
                    </div>
                    <div className="conflict-side">
                      <div className="conflict-head">{t('col.incomingClaim')}</div>
                      <p>{record.incoming?.text ?? '—'}</p>
                      <EventLink value={record.event_id} openDetail={openDetail} label={t('detail.viewSourceEvent')} />
                      <Button size="small" type="primary" onClick={() => resolveConflict('incoming')} style={{ marginTop: 8 }}>
                        {t('detail.keepIncoming')}
                      </Button>
                    </div>
                  </div>
                  <div className="muted" style={{ marginTop: 10 }}>
                    {t('detail.conflictNote')}
                  </div>
                </>
              ) : (
                <>
                  {eventContexts && <ChatThread rows={eventContexts} host={record.agent} />}
                  {contextTranscript && (
                    <div className="detail-chat">
                      <ChatExchange
                        task={contextTranscript.task}
                        text={contextTranscript.text}
                        host={contextTranscript.agent}
                        head={(
                          <>
                            <span className="muted">{contextTranscript.id}</span>
                            {contextTranscript.certainty && <Tag color="blue">{contextTranscript.certainty}</Tag>}
                            {contextTranscript.lifecycle && <Tag>{contextTranscript.lifecycle}</Tag>}
                          </>
                        )}
                      />
                    </div>
                  )}
                  {sessionRecord && (
                    <div className="detail-chat">
                      <ChatExchange
                        request={sessionRecord.prompt}
                        reply={sessionRecord.lastAssistant}
                        host={sessionRecord.host}
                      />
                      <ChatThread rows={sessionRecord.turns} host={sessionRecord.host} />
                    </div>
                  )}
                  <dl className="detail-grid">
                  {entries.map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt>{FIELD_LABEL[k] ?? k}</dt>
                      <dd>{renderValue(v, BOOL_LABEL)}</dd>
                    </React.Fragment>
                  ))}
                  </dl>
                  {revisions && revisions.length > 1 && (
                    <>
                      <Divider style={{ margin: '16px 0 10px' }}>{t('detail.history', { n: revisions.length })}</Divider>
                      <div className="revision-list">
                        {revisions.map((rev, i) => (
                          <div className={`revision-item${rev.event_id === record.event_id ? ' revision-item--current' : ''}`} key={rev.event_id}>
                            <div className="revision-head">
                              <span className="muted">{String(rev.at).replace('T', ' ').slice(0, 16)}</span>
                              <Tag>{rev.agent}</Tag>
                              {i === revisions.length - 1 && <Tag color="green">{t('detail.current')}</Tag>}
                              {rev.status !== 'active' && <Tag color="default">{rev.status}</Tag>}
                            </div>
                            <p>{rev.text}</p>
                            <div className="muted mono" style={{ fontSize: 11 }}>
                              {rev.event_id}
                              {rev.supersedes ? t('detail.replacedBy', { id: rev.supersedes }) : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}
      </Modal>
      <DecisionModal decision={decision} onClose={() => setDecision(null)} />
      <EditModal
        open={!!editTarget}
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={onChanged}
      />
    </>
  );
}


