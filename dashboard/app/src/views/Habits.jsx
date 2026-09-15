import React, { useState } from 'react';
import { Tabs, Tag, Button, Space, Table, Empty, App as AntApp } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { postWrite } from '../lib/api.js';
import DecisionModal from '../components/DecisionModal.jsx';

const STATUS_TEXT = { candidate: '候选', probationary: '试用中', confirmed: '已确认', rejected: '已拒绝' };
const STATUS_COLOR = { candidate: 'orange', probationary: 'gold', confirmed: 'green', rejected: 'red' };
// Long form for the modal: "候选" alone does not tell a person whether confirming is even
// still possible, which is what made the old dialog confusing.
const STATUS_HINT = {
  candidate: '候选（还没有决定）',
  probationary: '试用中（已注入，但不是强制规则）',
  confirmed: '已确认（已是强制规则）',
  rejected: '已拒绝',
};
const DECIDED = ['confirmed', 'rejected'];

export default function Habits({ model, openDetail, reload }) {
  const { message } = AntApp.useApp();
  const [decision, setDecision] = useState(null);

  // Revoking a confirmed, event-backed preference appends a rejected decision that
  // supersedes the prior one. Hand-written baseline rules have no event to supersede,
  // so the server refuses them with an explicit reason.
  const revoke = async (rule) => {
    try {
      const p = await postWrite('revoke-habit/preview', { preferenceId: rule.id });
      setDecision({
        title: '撤销偏好',
        summary: p.plan.summary,
        changes: p.plan.changes,
        onConfirm: async () => {
          const res = await postWrite('execute', { action: 'revoke-habit', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success('已撤销偏好');
          reload?.();
          return res;
        },
      });
    } catch (e) { message.error(e.message); }
  };

  const decide = async (rule, verdict) => {
    try {
      const p = await postWrite('habit-decision/preview', { candidateEvent: rule.source_event, preferenceId: rule.id, decision: verdict });
      const confirming = verdict === 'confirmed';
      setDecision({
        title: confirming ? '确认这条偏好' : '拒绝这条偏好',
        okText: confirming ? '确认并生效' : '确认拒绝',
        summary: p.plan.summary,
        // What is being decided, and what changes afterwards. The raw plan is a single
        // status transition; on its own it said nothing about either question.
        subject: {
          text: rule.text,
          meta: [
            ['ID', rule.id],
            ['范围', rule.scope ?? '—'],
            ['当前状态', STATUS_HINT[rule.status] ?? (rule.status ?? '—')],
          ],
        },
        effects: confirming
          ? [
            '这条偏好会从「候选」升为「已确认」，从下一次会话开始作为强制规则被注入。',
            '确认必须引用你本人的原话，证据笔记里可用的句子会列在下面。',
          ]
          : [
            '这条偏好会记为「已拒绝」，不会被注入为规则。',
            '来源事件、证据笔记和这条记录都保留，历史不会被删除。',
          ],
        changes: p.plan.changes,
        needsQuote: p.plan.requiresUserQuote,
        evidence: p.evidence ?? null,
        onConfirm: async (quote) => {
          const finalPreview = p.plan.requiresUserQuote
            ? await postWrite('habit-decision/preview', { candidateEvent: rule.source_event, preferenceId: rule.id, decision: verdict, userQuote: quote })
            : p;
          const res = await postWrite('execute', {
            action: 'habit-decision',
            plan: finalPreview.plan.plan ?? finalPreview.plan,
            fingerprint: finalPreview.fingerprint,
            token: finalPreview.token,
          });
          message.success(verdict === 'confirmed' ? '已确认偏好' : '已拒绝偏好');
          reload?.();
          return res;
        },
      });
    } catch (e) { message.error(e.message); }
  };

  // flex ratios make Ant divide the container proportionally, so the table always
  // fills the pane with no horizontal scroll regardless of window width.
  const baseColumns = [
    { title: 'ID', dataIndex: 'id', flex: '0 0 30%', render: (v) => <span className="mono">{v}</span> },
    { title: '内容', dataIndex: 'text', flex: 1 },
    { title: '范围', dataIndex: 'scope', flex: '0 0 16%', render: (v) => <Tag>{v}</Tag> },
  ];
  // model.candidates is every proposal together with its current decision status, so the
  // 状态 column is what tells the rows apart; already-decided rows must not offer 确认/拒绝
  // again (that produced a plan reading "confirmed → confirmed").
  const candidateColumns = [
    baseColumns[0],
    baseColumns[1],
    {
      title: '状态', dataIndex: 'status', flex: '0 0 13%',
      render: (v) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{STATUS_TEXT[v] ?? v}</Tag>,
    },
    {
      title: '操作', key: 'ops', flex: '0 0 20%',
      render: (_v, r) => {
        if (DECIDED.includes(r.status)) {
          return <span className="muted">{r.status === 'confirmed' ? '已确认（详情里可撤销）' : '已拒绝'}</span>;
        }
        return (
          <Space>
            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={(e) => { e.stopPropagation(); decide(r, 'confirmed'); }}>确认</Button>
            <Button size="small" danger icon={<CloseOutlined />} onClick={(e) => { e.stopPropagation(); decide(r, 'rejected'); }}>拒绝</Button>
          </Space>
        );
      },
    },
  ];
  // Confirmed and probationary rows get a revoke action; only event-backed rules can
  // be revoked, so the button is offered and the server explains when it cannot.
  const confirmedColumns = [
    baseColumns[0],
    baseColumns[1],
    baseColumns[2],
    {
      title: '操作', key: 'ops', flex: '0 0 14%',
      render: (_v, r) => (
        <Button size="small" icon={<CloseOutlined />} onClick={(e) => { e.stopPropagation(); revoke(r); }}>撤销</Button>
      ),
    },
  ];

  const renderTable = (rows, columns) => {
    if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" style={{ padding: 40 }} />;
    return (
      <Table
        size="middle"
        tableLayout="fixed"
        // One proposal can reach the journal from two source events, so the candidate list
        // legitimately holds the same rule id twice. Keying rows on id alone gave React
        // duplicate keys, which makes row updates unreliable, so key on the source event too.
        rowKey={(r) => `${r.source_event ?? ''}/${r.id}`}
        columns={columns}
        dataSource={rows}
        // defaultPageSize, not pageSize: a plain pageSize in this config overrides the
        // table's own pagination state, which silently disabled the size changer.
        pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'], size: 'small', showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条` }}
        scroll={{ y: 520 }}
        onRow={(r) => ({ onClick: () => openDetail('habit', r.id), className: 'row-clickable' })}
      />
    );
  };

  const tabs = [
    { key: 'confirmed', label: `已确认 ${model?.habits?.length ?? 0}`, children: renderTable(model?.habits ?? [], confirmedColumns) },
    { key: 'probationary', label: `试用中 ${model?.probationary?.length ?? 0}`, children: renderTable(model?.probationary ?? [], confirmedColumns) },
    { key: 'candidates', label: `候选 ${model?.candidates?.length ?? 0}`, children: renderTable(model?.candidates ?? [], candidateColumns) },
  ];

  return (
    <div className="table-view">
      <div className="panel">
        <Tabs items={tabs} />
      </div>
      <DecisionModal decision={decision} onClose={() => setDecision(null)} />
    </div>
  );
}
