import React from 'react';
import { Card, Table, Tag, Typography, Descriptions } from 'antd';
import { useI18n } from '../i18n/index.jsx';

const { Paragraph, Title } = Typography;

// A single reference page for every label the console renders. When the UI shows a
// status word or tag, the reader should be able to look up what it means without
// reading the source.
//
// The `key` fields are the store's own tokens — hot, warm, supersedes, fact — and are deliberately
// not translated: they are what the data actually says, and explaining them is the entire point of
// this page. Only the explanations are interface text. The tables are built inside the component
// because they are translated and t() only exists during a render.

export default function Reference() {
  const { t } = useI18n();

  const lifecycle = [
    { key: 'hot', color: 'red', desc: t('ref.lifecycle.hot') },
    { key: 'warm', color: 'orange', desc: t('ref.lifecycle.warm') },
    { key: 'retained', color: 'blue', desc: t('ref.lifecycle.retained') },
    { key: 'dormant', color: 'default', desc: t('ref.lifecycle.dormant') },
    { key: 'closed', color: 'default', desc: t('ref.lifecycle.closed') },
  ];

  const preference = [
    { key: 'candidate', color: 'gold', desc: t('ref.preference.candidate') },
    { key: 'probationary', color: 'orange', desc: t('ref.preference.probationary') },
    { key: 'confirmed', color: 'green', desc: t('ref.preference.confirmed') },
    { key: 'rejected', color: 'default', desc: t('ref.preference.rejected') },
  ];

  const actionStatus = [
    { key: 'open', color: 'orange', desc: t('ref.action.open') },
    { key: 'done', color: 'green', desc: t('ref.action.done') },
  ];

  const factState = [
    { key: t('ref.fact.conflict'), color: 'red', desc: t('ref.fact.conflict.desc') },
    { key: 'supersedes', color: 'geekblue', desc: t('ref.fact.supersedes.desc') },
  ];

  const payload = [
    { key: 'fact', color: 'blue', desc: t('ref.payload.fact') },
    { key: 'context', color: 'cyan', desc: t('ref.payload.context') },
    { key: 'experience', color: 'geekblue', desc: t('ref.payload.experience') },
    { key: 'action', color: 'green', desc: t('ref.payload.action') },
    { key: 'preference', color: 'gold', desc: t('ref.payload.preference') },
    { key: 'mistake', color: 'red', desc: t('ref.payload.mistake') },
  ];

  const tagTable = (title, rows, note) => (
    <Card size="small" title={title} className="panel" bordered={false} style={{ marginBottom: 12 }}>
      {note && <Paragraph type="secondary" style={{ marginTop: 0 }}>{note}</Paragraph>}
      <Table
        size="small"
        rowKey="key"
        pagination={false}
        columns={[
          { title: t('ref.col.tag'), dataIndex: 'key', width: 140, render: (v, r) => <Tag color={r.color}>{v}</Tag> },
          { title: t('ref.col.meaning'), dataIndex: 'desc' },
        ]}
        dataSource={rows}
      />
    </Card>
  );

  return (
    <div>
      <Card size="small" title={t('ref.title.layers')} className="panel" bordered={false} style={{ marginBottom: 12 }}>
        <Descriptions column={1} size="small" bordered
          items={[
            { key: 'event', label: t('ref.layer.event.label'), children: t('ref.layer.event.body') },
            { key: 'fact', label: t('ref.layer.fact.label'), children: t('ref.layer.fact.body') },
            { key: 'context', label: t('ref.layer.context.label'), children: t('ref.layer.context.body') },
            { key: 'experience', label: t('ref.layer.experience.label'), children: t('ref.layer.experience.body') },
            { key: 'habit', label: t('ref.layer.habit.label'), children: t('ref.layer.habit.body') },
          ]}
        />
      </Card>

      {tagTable(t('ref.section.lifecycle.title'), lifecycle, t('ref.section.lifecycle.note'))}
      {tagTable(t('ref.section.preference.title'), preference, t('ref.section.preference.note'))}
      {tagTable(t('ref.section.action.title'), actionStatus)}
      {tagTable(t('ref.section.fact.title'), factState, t('ref.section.fact.note'))}
      {tagTable(t('ref.section.payload.title'), payload, t('ref.section.payload.note'))}
    </div>
  );
}
