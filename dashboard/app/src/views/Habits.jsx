import React, { useState } from 'react';
import { Tabs, Tag, Button, Space, Table, Empty, App as AntApp } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { postWrite } from '../lib/api.js';
import DecisionModal from '../components/DecisionModal.jsx';
import { useI18n } from '../i18n/index.jsx';

const STATUS_COLOR = { candidate: 'orange', probationary: 'gold', confirmed: 'green', rejected: 'red' };
const DECIDED = ['confirmed', 'rejected'];

export default function Habits({ model, openDetail, reload }) {
  const { t } = useI18n();
  const { message } = AntApp.useApp();
  // The status names moved inside the component because they are translated, and the short and long
  // forms are deliberately separate keys: 候选 is a word, while 候选（还没有决定）explains to a person
  // what confirming would even mean. The two have to be free to diverge per language.
  const STATUS_TEXT = {
    candidate: t('value.candidate'), probationary: t('value.probationary'),
    confirmed: t('value.confirmed'), rejected: t('value.rejected'),
  };
  const STATUS_HINT = {
    candidate: t('habits.hint.candidate'), probationary: t('habits.hint.probationary'),
    confirmed: t('habits.hint.confirmed'), rejected: t('value.rejected'),
  };
  const [decision, setDecision] = useState(null);

  // Revoking a confirmed, event-backed preference appends a rejected decision that
  // supersedes the prior one. Hand-written baseline rules have no event to supersede,
  // so the server refuses them with an explicit reason.
  const revoke = async (rule) => {
    try {
      const p = await postWrite('revoke-habit/preview', { preferenceId: rule.id });
      setDecision({
        title: t('habits.revoke'),
        summary: p.plan.summary,
        changes: p.plan.changes,
        onConfirm: async () => {
          const res = await postWrite('execute', { action: 'revoke-habit', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success(t('habits.revoked'));
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
        title: confirming ? t('habits.confirmTitle') : t('habits.rejectTitle'),
        okText: confirming ? t('habits.confirmOk') : t('habits.rejectOk'),
        summary: p.plan.summary,
        // What is being decided, and what changes afterwards. The raw plan is a single
        // status transition; on its own it said nothing about either question.
        subject: {
          text: rule.text,
          meta: [
            ['ID', rule.id],
            [t('field.scope'), rule.scope ?? '—'],
            [t('habits.currentStatus'), STATUS_HINT[rule.status] ?? (rule.status ?? '—')],
          ],
        },
        effects: confirming
          ? [
            t('habits.effect.confirm.first'),
            t('habits.effect.confirm.second'),
          ]
          : [
            t('habits.effect.reject.first'),
            t('habits.effect.reject.second'),
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
          message.success(verdict === 'confirmed' ? t('habits.confirmed') : t('habits.rejected'));
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
    { title: t('field.text'), dataIndex: 'text', flex: 1 },
    { title: t('field.scope'), dataIndex: 'scope', flex: '0 0 16%', render: (v) => <Tag>{v}</Tag> },
  ];
  // model.candidates is every proposal together with its current decision status, so the
  // 状态 column is what tells the rows apart; already-decided rows must not offer 确认/拒绝
  // again (that produced a plan reading "confirmed → confirmed").
  const candidateColumns = [
    baseColumns[0],
    baseColumns[1],
    {
      title: t('field.status'), dataIndex: 'status', flex: '0 0 13%',
      render: (v) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{STATUS_TEXT[v] ?? v}</Tag>,
    },
    {
      title: t('col.ops'), key: 'ops', flex: '0 0 20%',
      render: (_v, r) => {
        if (DECIDED.includes(r.status)) {
          return <span className="muted">{r.status === 'confirmed' ? t('habits.decidedConfirm') : t('value.rejected')}</span>;
        }
        return (
          <Space>
            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={(e) => { e.stopPropagation(); decide(r, 'confirmed'); }}>{t('habits.confirm')}</Button>
            <Button size="small" danger icon={<CloseOutlined />} onClick={(e) => { e.stopPropagation(); decide(r, 'rejected'); }}>{t('habits.reject')}</Button>
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
      title: t('col.ops'), key: 'ops', flex: '0 0 14%',
      render: (_v, r) => (
        <Button size="small" icon={<CloseOutlined />} onClick={(e) => { e.stopPropagation(); revoke(r); }}>{t('habits.revokeAction')}</Button>
      ),
    },
  ];

  const renderTable = (rows, columns) => {
    if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('habits.empty')} style={{ padding: 40 }} />;
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
        pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'], size: 'small', showTotal: (total, range) => t('dataTable.total', { from: range[0], to: range[1], total }) }}
        scroll={{ y: 520 }}
        onRow={(r) => ({ onClick: () => openDetail('habit', r.id), className: 'row-clickable' })}
      />
    );
  };

  const tabs = [
    { key: 'confirmed', label: t('habits.tab.confirmed', { n: model?.habits?.length ?? 0 }), children: renderTable(model?.habits ?? [], confirmedColumns) },
    { key: 'probationary', label: t('habits.tab.probationary', { n: model?.probationary?.length ?? 0 }), children: renderTable(model?.probationary ?? [], confirmedColumns) },
    { key: 'candidates', label: t('habits.tab.candidates', { n: model?.candidates?.length ?? 0 }), children: renderTable(model?.candidates ?? [], candidateColumns) },
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
