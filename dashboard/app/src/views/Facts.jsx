import React, { useState } from 'react';
import { Tag, Button, Space, App as AntApp } from 'antd';
import { EditOutlined, StopOutlined } from '@ant-design/icons';
import DataTable from '../components/DataTable.jsx';
import EditModal from '../components/EditModal.jsx';
import { TopicLink, EventLink } from '../components/Links.jsx';

export default function Facts({ model, openDetail, reload }) {
  const { message } = AntApp.useApp();
  const [editTarget, setEditTarget] = useState(null);

  // Row-level retire. It opens the same editor in retire mode so the confirmation and
  // supersede semantics are identical to the drawer, not a second code path.
  const retire = (row) => setEditTarget({
    type: 'fact', text: row.text, eventId: row.event_id, retire: true,
    previewRoute: 'revise-fact/preview', payload: { topic: row.topic, key: row.key },
  });
  // Six columns chosen so the whole row is visible at a typical pane width without
  // horizontal scrolling. Full text, weight and the source event live in the detail
  // drawer that opens on row click.
  const columns = [
    { title: '主题', dataIndex: 'topic', width: 175, render: (v) => <TopicLink value={v} openDetail={openDetail} /> },
    { title: '键', dataIndex: 'key', width: 135, render: (v) => <span className="mono">{v}</span> },
    { title: '结论', dataIndex: 'text', width: 330 },
    { title: '时间', dataIndex: 'at', width: 140, render: (v) => <span className="nowrap muted">{String(v).replace('T', ' ').slice(0, 16)}</span> },
    { title: '冲突', dataIndex: 'conflict', width: 80, render: (v) => (v ? <Tag color="red">存在</Tag> : <span className="muted">无</span>) },
    {
      title: '操作', key: 'ops', width: 150,
      render: (_v, r) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={(e) => {
              e.stopPropagation();
              setEditTarget({
                type: 'fact', text: r.text, eventId: r.event_id,
                previewRoute: 'revise-fact/preview', payload: { topic: r.topic, key: r.key },
              });
            }}
          >
            修正
          </Button>
          <Button size="small" danger icon={<StopOutlined />} onClick={(e) => { e.stopPropagation(); retire(r); }}>停用</Button>
        </Space>
      ),
    },
  ];
  return (
    <div className="table-view">
      <div className="panel">
        <DataTable
          columns={columns}
          data={model?.facts ?? []}
          rowKey={(r) => `${r.topic}/${r.key}`}
          searchPlaceholder="筛选事实…"
          onRowClick={(r) => openDetail('fact', `${r.topic}/${r.key}`)}
          pageSize={10}
        />
      </div>
      <EditModal open={!!editTarget} target={editTarget} onClose={() => setEditTarget(null)} onSaved={reload} />
    </div>
  );
}
