import React, { useEffect, useState } from 'react';
import { Modal, Spin, Empty, Tag, Button, Space, Divider, App as AntApp } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import { getDetail, getRevisions, postWrite } from '../lib/api.js';
import DecisionModal from './DecisionModal.jsx';
import EditModal from './EditModal.jsx';
import { EventLink } from './Links.jsx';
import { ChatExchange, ChatThread } from './ChatBubbles.jsx';
import { isTranscriptText } from '../lib/chat.js';

const KIND_LABEL = {
  fact: '长期事实', context: '短期上下文', experience: '执行经验',
  habit: '偏好', action: '待办', event: '事件', workspace: '工作区', topic: '主题', conflict: '冲突',
};

const FIELD_LABEL = {
  id: 'ID', topic: '主题', workspace: '工作区', agent: 'Agent', text: '内容',
  event_id: '事件 ID', at: '时间', occurred_at: '发生时间', recorded_at: '记录时间',
  status: '状态', weight: '权重', lifecycle: '生命周期', scope: '范围',
  triggers: '触发词', source_event: '来源事件', certainty: '确定性', task: '任务',
  evidence: '证据', supersedes: '替代', key: '键', conflict: '冲突', open: '未完成',
  kind: '类型', type: '类型', expires: '过期', operations: '触发操作', verification: '验证方式',
  boundary: '边界', location: '位置', decision_event: '决定事件', decision: '决定',
  ttl_days: '保留天数', prompt: '当前任务', lastAssistant: '最近回复', turns: '检查点',
};

const BOOL_LABEL = { true: '是', false: '否' };

// Structured values (facts / actions / experiences / evidence lists) are the bulky
// part of an event. Rendering them as inline tags let long JSON strings push past the
// modal edge, so arrays of objects become wrapping rows and plain arrays become
// wrapping chips with a hard width bound.
function renderValue(value) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (typeof value === 'boolean') return <Tag color={value ? 'red' : 'default'}>{BOOL_LABEL[String(value)]}</Tag>;

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
    if (!keep?.text) { message.error('该侧没有可采纳的内容'); return; }
    if (!lose?.event_id) { message.error('该侧缺少来源事件，无法声明替代'); return; }
    try {
      const p = await postWrite('revise-fact/preview', {
        topic: record.topic,
        key: record.key,
        text: keep.text,
        expectedEvent: record.current?.event_id,
        supersedeEvent: lose.event_id,
      });
      setDecision({
        title: winner === 'incoming' ? '采纳不同说法' : '保留当前说法',
        summary: p.plan.summary,
        changes: [
          { field: '保留', from: record.current?.text, to: keep.text },
          { field: 'supersedes', from: lose.event_id, to: '由新事件显式替代' },
        ],
        onConfirm: async () => {
          // The server built the plan against the exact supersede target, so execute
          // exactly what it returned; no client-side retargeting.
          const res = await postWrite('execute', { action: 'revise-fact', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success('已裁决冲突');
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
        title: '撤销偏好',
        summary: p.plan.summary,
        changes: p.plan.changes,
        onConfirm: async () => {
          const res = await postWrite('execute', { action: 'revoke-habit', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success('已撤销偏好');
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
        title: '关闭待办',
        summary: p.plan.summary,
        changes: p.plan.changes,
        onConfirm: async () => {
          const res = await postWrite('execute', { action: 'close-action', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success('已关闭待办');
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
        title: verdict === 'confirmed' ? '确认偏好' : '拒绝偏好',
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
          message.success(verdict === 'confirmed' ? '已确认偏好' : '已拒绝偏好');
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
        title={detail ? `${KIND_LABEL[detail.type] ?? detail.type} 详情` : ''}
        destroyOnClose
        className="detail-modal"
      >
        {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          : !record ? <Empty description="未找到记录" />
          : (
            <>
              {(action || habit || confirmedHabit || editable) && (
                <>
                  <Space wrap>
                    {action && <Button type="primary" icon={<CheckOutlined />} onClick={closeAction}>关闭待办</Button>}
                    {habit && <Button type="primary" icon={<CheckOutlined />} onClick={() => decideHabit('confirmed')}>确认偏好</Button>}
                    {habit && <Button danger icon={<CloseOutlined />} onClick={() => decideHabit('rejected')}>拒绝偏好</Button>}
                    {confirmedHabit && <Button danger icon={<StopOutlined />} onClick={revokeHabit}>撤销偏好</Button>}
                    {editable && <Button icon={<EditOutlined />} onClick={() => setEditTarget(editable)}>修正</Button>}
                    {editable && <Button danger icon={<StopOutlined />} onClick={() => setEditTarget({ ...editable, retire: true })}>停用</Button>}
                  </Space>
                  <Divider style={{ margin: '14px 0' }} />
                </>
              )}
              {isConflict ? (
                <>
                  <div className="conflict-sides">
                    <div className="conflict-side">
                      <div className="conflict-head">当前保留</div>
                      <p>{record.current?.text ?? '—'}</p>
                      {record.current?.event_id && (
                        <EventLink value={record.current.event_id} openDetail={openDetail} label="查看来源事件" />
                      )}
                      <Button size="small" onClick={() => resolveConflict('current')} style={{ marginTop: 8 }}>
                        保留当前说法
                      </Button>
                    </div>
                    <div className="conflict-side">
                      <div className="conflict-head">不同说法</div>
                      <p>{record.incoming?.text ?? '—'}</p>
                      <EventLink value={record.event_id} openDetail={openDetail} label="查看来源事件" />
                      <Button size="small" type="primary" onClick={() => resolveConflict('incoming')} style={{ marginTop: 8 }}>
                        采纳不同说法
                      </Button>
                    </div>
                  </div>
                  <div className="muted" style={{ marginTop: 10 }}>
                    裁决会追加一条带 supersedes 的新事实，明确哪一侧生效；两条原事件都保留。
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
                      <dd>{renderValue(v)}</dd>
                    </React.Fragment>
                  ))}
                  </dl>
                  {revisions && revisions.length > 1 && (
                    <>
                      <Divider style={{ margin: '16px 0 10px' }}>变更历史（{revisions.length} 次）</Divider>
                      <div className="revision-list">
                        {revisions.map((rev, i) => (
                          <div className={`revision-item${rev.event_id === record.event_id ? ' revision-item--current' : ''}`} key={rev.event_id}>
                            <div className="revision-head">
                              <span className="muted">{String(rev.at).replace('T', ' ').slice(0, 16)}</span>
                              <Tag>{rev.agent}</Tag>
                              {i === revisions.length - 1 && <Tag color="green">当前</Tag>}
                              {rev.status !== 'active' && <Tag color="default">{rev.status}</Tag>}
                            </div>
                            <p>{rev.text}</p>
                            <div className="muted mono" style={{ fontSize: 11 }}>
                              {rev.event_id}
                              {rev.supersedes ? ` ← 替代 ${rev.supersedes}` : ''}
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


