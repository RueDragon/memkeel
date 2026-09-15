import React, { useState } from 'react';
import { Tag, Button, Space, App as AntApp } from 'antd';
import { CheckOutlined, EditOutlined } from '@ant-design/icons';
import DataTable from '../components/DataTable.jsx';
import DecisionModal from '../components/DecisionModal.jsx';
import EditModal from '../components/EditModal.jsx';
import { TopicLink, EventLink } from '../components/Links.jsx';
import { postWrite } from '../lib/api.js';

export default function Actions({ model, openDetail, reload }) {
  const { message } = AntApp.useApp();
  const [decision, setDecision] = useState(null);
  const [tab, setTab] = useState('open');
  const [editTarget, setEditTarget] = useState(null);

  const close = async (row) => {
    try {
      const p = await postWrite('close-action/preview', { topic: row.topic, actionId: row.id });
      setDecision({
        title: '关闭待办',
        summary: p.plan.summary,
        changes: p.plan.changes,
        onConfirm: async () => {
          const res = await postWrite('execute', { action: 'close-action', plan: p.plan, fingerprint: p.fingerprint, token: p.token });
          message.success('已关闭待办');
          reload?.();
          return res;
        },
      });
    } catch (e) { message.error(e.message); }
  };

  const columns = [
    { title: '主题', dataIndex: 'topic', width: 230, render: (v) => <TopicLink value={v} openDetail={openDetail} /> },
    { title: '待办', dataIndex: 'text', width: 580 },
    { title: 'ID', dataIndex: 'id', width: 200, render: (v) => <span className="mono">{v}</span> },
    { title: '状态', dataIndex: 'status', width: 100, render: (v) => (v === 'done' ? <Tag color="green">已完成</Tag> : <Tag color="orange">未完成</Tag>) },
    { title: '来源', dataIndex: 'event_id', width: 110, render: (v) => <EventLink value={v} openDetail={openDetail} label="来源事件" /> },
    {
      title: '操作', key: 'ops', width: 180,
      render: (_v, r) => (
        <Space size={4}>
          {r.status !== 'done' && <Button size="small" type="primary" icon={<CheckOutlined />} onClick={(e) => { e.stopPropagation(); close(r); }}>关闭</Button>}
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
            修正
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
          <Button type={tab === 'open' ? 'primary' : 'default'} onClick={() => setTab('open')}>未完成 {open.length}</Button>
          <Button type={tab === 'done' ? 'primary' : 'default'} onClick={() => setTab('done')}>已完成 {done.length}</Button>
        </Space>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(r) => `${r.topic}/${r.id}`}
          searchPlaceholder="筛选待办…"
          onRowClick={(r) => openDetail('action', `${r.topic}/${r.id}`)}
          pageSize={10}
        />
      </div>
      <DecisionModal decision={decision} onClose={() => setDecision(null)} />
      <EditModal open={!!editTarget} target={editTarget} onClose={() => setEditTarget(null)} onSaved={reload} />
    </div>
  );
}
