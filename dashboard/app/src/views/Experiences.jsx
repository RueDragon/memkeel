import React, { useState } from 'react';
import { Tag, Button, Space } from 'antd';
import { EditOutlined, StopOutlined } from '@ant-design/icons';
import DataTable from '../components/DataTable.jsx';
import EditModal from '../components/EditModal.jsx';
import { WorkspaceLink, EventLink } from '../components/Links.jsx';

const LIFE_COLOR = { hot: 'red', warm: 'orange', retained: 'blue', dormant: 'default', closed: 'default', invalidated: 'default' };

export default function Experiences({ model, openDetail, reload }) {
  const [editTarget, setEditTarget] = useState(null);
  const targetFor = (r, retire) => ({
    type: 'experience', text: r.text, eventId: r.event_id, retire,
    previewRoute: 'revise-learning/preview', payload: { type: 'experiences', topic: r.topic, id: r.id },
  });
  const columns = [
    { title: 'ID', dataIndex: 'id', width: 250, render: (v) => <span className="mono">{v}</span> },
    { title: '工作区', dataIndex: 'workspace', width: 180, render: (v) => <WorkspaceLink value={v} openDetail={openDetail} /> },
    { title: '操作 / 边界', dataIndex: 'text', width: 580 },
    { title: '生命周期', dataIndex: 'lifecycle', width: 100, render: (v) => <Tag color={LIFE_COLOR[v]}>{v}</Tag> },
    { title: '时间', dataIndex: 'at', width: 160, render: (v) => <span className="nowrap muted">{String(v).replace('T', ' ').slice(0, 16)}</span> },
    { title: '来源', dataIndex: 'event_id', width: 110, render: (v) => <EventLink value={v} openDetail={openDetail} label="来源事件" /> },
    {
      title: '操作', key: 'ops', width: 150,
      render: (_v, r) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={(e) => { e.stopPropagation(); setEditTarget(targetFor(r, false)); }}>修正</Button>
          <Button size="small" danger icon={<StopOutlined />} onClick={(e) => { e.stopPropagation(); setEditTarget(targetFor(r, true)); }}>停用</Button>
        </Space>
      ),
    },
  ];
  return (
    <div className="table-view">
      <div className="panel">
        <DataTable
          columns={columns}
          data={model?.experiences ?? []}
          rowKey={(r) => r.id}
          searchPlaceholder="筛选经验…"
          onRowClick={(r) => openDetail('experience', r.id)}
          pageSize={10}
        />
      </div>
      <EditModal open={!!editTarget} target={editTarget} onClose={() => setEditTarget(null)} onSaved={reload} />
    </div>
  );
}
