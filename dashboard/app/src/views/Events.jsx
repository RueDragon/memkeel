import React from 'react';
import { Tag } from 'antd';
import DataTable from '../components/DataTable.jsx';
import { TopicLink, WorkspaceLink } from '../components/Links.jsx';

export default function Events({ model, openDetail }) {
  const columns = [
    { title: '事件 ID', dataIndex: 'event_id', width: 260, render: (v) => <span className="mono">{v}</span> },
    { title: '工作区', dataIndex: 'workspace', width: 150, render: (v) => <WorkspaceLink value={v} openDetail={openDetail} /> },
    { title: '主题', dataIndex: 'topic', width: 220, render: (v) => <TopicLink value={v} openDetail={openDetail} /> },
    { title: 'Agent', dataIndex: 'agent', width: 100 },
    { title: '发生时间', dataIndex: 'occurred_at', width: 160, render: (v) => <span className="nowrap muted">{String(v).replace('T', ' ').slice(0, 16)}</span> },
    {
      title: '载荷', key: 'payload', width: 240,
      render: (_v, r) => {
        const tags = [];
        if (r.facts?.length) tags.push(['事实', r.facts.length, 'blue']);
        if (r.contexts?.length) tags.push(['上下文', r.contexts.length, 'cyan']);
        if (r.experiences?.length) tags.push(['经验', r.experiences.length, 'geekblue']);
        if (r.actions?.length) tags.push(['待办', r.actions.length, 'green']);
        if (r.preferences?.length) tags.push(['偏好', r.preferences.length, 'gold']);
        if (r.mistakes?.length) tags.push(['错误', r.mistakes.length, 'red']);
        if (!tags.length) return <span className="muted">—</span>;
        return tags.map(([label, n, color]) => <Tag key={label} color={color}>{label} {n}</Tag>);
      },
    },
  ];
  return (
    <div className="table-view">
      <div className="panel">
        <DataTable
          columns={columns}
          data={model?.events ?? []}
          rowKey={(r) => r.event_id}
          searchPlaceholder="筛选事件…"
          onRowClick={(r) => openDetail('event', r.event_id)}
          pageSize={10}
        />
      </div>
    </div>
  );
}
