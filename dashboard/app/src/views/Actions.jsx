import React, { useState } from 'react';
import { Tag, Button, Space, App as AntApp } from 'antd';
import { CheckOutlined, EditOutlined } from '@ant-design/icons';
import DataTable from '../components/DataTable.jsx';
import DecisionModal from '../components/DecisionModal.jsx';
import EditModal from '../components/EditModal.jsx';
import { TopicLink, EventLink } from '../components/Links.jsx';
import { postWrite } from '../lib/api.js';
import { useI18n } from '../i18n/index.jsx';

export default function Actions({ model, openDetail, reload }) {
  const { t } = useI18n();
  const { message } = AntApp.useApp();
  const [decision, setDecision] = useState(null);
  const [tab, setTab] = useState('open');
  const [editTarget, setEditTarget] = useState(null);

  const close = async (row) => {
    try {
      const p = await postWrite('close-action/preview', { topic: row.topic, actionId: row.id });
      setDecision({
        title: t('actions.closeTitle'),
        summary: p.plan.summary,
        changes: p.plan.changes,
        onConfirm: async () => {
          const res = await postWrite('execute', { action: 'close-action', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success(t('actions.closed'));
          reload?.();
          return res;
        },
      });
    } catch (e) { message.error(e.message); }
  };

  const columns = [
    { title: t('col.topic'), dataIndex: 'topic', width: 230, render: (v) => <TopicLink value={v} openDetail={openDetail} /> },
    { title: t('kind.actions'), dataIndex: 'text', width: 580 },
    { title: t('col.id'), dataIndex: 'id', width: 200, render: (v) => <span className="mono">{v}</span> },
    { title: t('field.status'), dataIndex: 'status', width: 100, render: (v) => (v === 'done' ? <Tag color="green">{t('value.done')}</Tag> : <Tag color="orange">{t('value.open')}</Tag>) },
    { title: t('col.source'), dataIndex: 'event_id', width: 110, render: (v) => <EventLink value={v} openDetail={openDetail} label={t('link.sourceEvent')} /> },
    {
      title: t('col.ops'), key: 'ops', width: 180,
      render: (_v, r) => (
        <Space size={4}>
          {r.status !== 'done' && <Button size="small" type="primary" icon={<CheckOutlined />} onClick={(e) => { e.stopPropagation(); close(r); }}>{t('action.close')}</Button>}
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              setEditTarget({
                type: 'action', text: r.text, eventId: r.event_id,
                previewRoute: 'revise-action/preview', payload: { topic: r.topic, actionId: r.id },
              });
            }}
          >
            {t('action.revise')}
          </Button>
        </Space>
      ),
    },
  ];

  const all = model?.actions ?? [];
  const open = all.filter((a) => a.status === 'open');
  const done = all.filter((a) => a.status !== 'open');
  const rows = tab === 'open' ? open : done;

  return (
    <div className="table-view">
      <div className="panel">
        <Space style={{ marginBottom: 12 }}>
          <Button type={tab === 'open' ? 'primary' : 'default'} onClick={() => setTab('open')}>{t('value.open')} {open.length}</Button>
          <Button type={tab === 'done' ? 'primary' : 'default'} onClick={() => setTab('done')}>{t('value.done')} {done.length}</Button>
        </Space>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => `${r.topic}/${r.id}`}
          searchPlaceholder={t('actions.filter')}
          onRowClick={(r) => openDetail('action', `${r.topic}/${r.id}`)}
          pageSize={10}
        />
      </div>
      <DecisionModal decision={decision} onClose={() => setDecision(null)} />
      <EditModal open={!!editTarget} target={editTarget} onClose={() => setEditTarget(null)} onSaved={reload} />
    </div>
  );
}
