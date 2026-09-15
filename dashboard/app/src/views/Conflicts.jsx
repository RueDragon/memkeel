import React from 'react';
import { Alert } from 'antd';
import DataTable from '../components/DataTable.jsx';
import { TopicLink } from '../components/Links.jsx';

export default function Conflicts({ model, openDetail }) {
  const columns = [
    { title: '主题', dataIndex: 'topic', width: 200, render: (v) => <TopicLink value={v} openDetail={openDetail} /> },
    { title: '键', dataIndex: 'key', width: 190, render: (v) => <span className="mono">{v}</span> },
    { title: '当前保留', key: 'current', width: 380, render: (_v, r) => r.current?.text ?? r.current?.event_id ?? '—' },
    { title: '不同说法', key: 'incoming', width: 380, render: (_v, r) => r.incoming?.text ?? r.incoming?.event_id ?? '—' },
  ];
  return (
    <div className="table-view">
      {(model?.conflicts?.length ?? 0) === 0
        ? <Alert type="success" showIcon message="当前没有未解决冲突" />
        : (
          <div className="panel">
            <DataTable
              columns={columns}
              data={model.conflicts}
              rowKey={(r) => `${r.topic}/${r.key}/${r.event_id}`}
              searchPlaceholder="筛选冲突…"
              onRowClick={(r) => openDetail('conflict', [r.topic, r.key, r.event_id].join('/'))}
              pageSize={10}
            />
          </div>
        )}
    </div>
  );
}
