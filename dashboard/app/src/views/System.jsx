import React from 'react';
import { Descriptions, Table, Card, Empty, Tag, Statistic, Row, Col } from 'antd';
import LazyChart from '../components/LazyChart.jsx';
import { WorkspaceLink } from '../components/Links.jsx';

const KIND_LABEL = { fact: '长期事实', context: '短期上下文', experience: '执行经验' };

export default function System({ model, openDetail }) {
  const { status, access, topics, routes, index } = model ?? {};
  const byKind = access?.byKind ?? {};

  const accessOption = {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, icon: 'circle' },
    series: [{
      type: 'pie', radius: ['48%', '70%'], center: ['50%', '42%'],
      label: { show: false },
      itemStyle: { borderColor: '#fff', borderWidth: 2 },
      data: Object.entries(byKind).map(([k, v]) => ({ name: KIND_LABEL[k] ?? k, value: v })),
    }],
  };

  const topicColumns = [
    { title: '主题', dataIndex: 'id', flex: '0 0 30%', render: (v) => <span className="mono">{v}</span> },
    { title: '工作区', dataIndex: 'workspace', flex: '0 0 20%', render: (v) => <WorkspaceLink value={v} openDetail={openDetail} /> },
    { title: '标题', dataIndex: 'title', flex: 1 },
    { title: '路径', dataIndex: 'path', flex: '0 0 28%', ellipsis: true, render: (v) => <span className="mono muted">{v}</span> },
  ];

  const topColumns = [
    { title: '类型', dataIndex: 'kind', width: 110, render: (v) => <Tag>{KIND_LABEL[v] ?? v}</Tag> },
    { title: '记录', dataIndex: 'id', render: (v, r) => (
      <span
        className="row-clickable mono"
        onClick={() => r.kind && ['fact', 'context', 'experience'].includes(r.kind) && openDetail(r.kind, v)}
      >{v}</span>
    ) },
    { title: '读取次数', dataIndex: 'reads', width: 100, align: 'right' },
    { title: '最近读取', dataIndex: 'lastAccess', width: 180, render: (v) => <span className="nowrap muted">{v ? String(v).replace('T', ' ').slice(0, 16) : '—'}</span> },
  ];

  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <h3 className="panel-title">运行状态</h3>
        <Row gutter={16}>
          <Col span={4}><Statistic title="版本" value={status?.version ?? '—'} /></Col>
          <Col span={4}><Statistic title="事件总数" value={status?.events ?? 0} /></Col>
          <Col span={4}><Statistic title="长期事实" value={status?.facts ?? 0} /></Col>
          <Col span={4}><Statistic title="短期上下文" value={status?.contexts ?? 0} /></Col>
          <Col span={4}><Statistic title="执行经验" value={status?.experiences ?? 0} /></Col>
          <Col span={4}><Statistic title="待归档" value={status?.pending ?? 0} valueStyle={status?.pending ? { color: '#d92d20' } : undefined} /></Col>
        </Row>
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={4}><Statistic title="未解决冲突" value={status?.conflicts ?? 0} valueStyle={status?.conflicts ? { color: '#d92d20' } : undefined} /></Col>
          <Col span={4}><Statistic title="工作区" value={routes?.length ?? 0} /></Col>
          <Col span={4}><Statistic title="主题" value={topics?.length ?? 0} /></Col>
          <Col span={12}>
            <Descriptions size="small" column={1}
              items={[{ key: 'paths', label: '记忆库根目录', children: <span className="mono muted">{model?.status?.vaultRoot ?? '（由运行环境决定）'}</span> }]}
            />
          </Col>
        </Row>
      </div>

      <div className="chart-grid">
        <Card size="small" title="访问构成" className="panel" bordered={false}>
          {Object.keys(byKind).length
            ? <LazyChart option={accessOption} height={250} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有读取记录。打开任一详情后会开始累计。" style={{ padding: 40 }} />}
        </Card>
        <Card size="small" title="索引" className="panel" bordered={false}>
          <Descriptions column={1} size="small"
            items={[
              { key: 'files', label: '索引文件数', children: index?.files ?? '—' },
              { key: 'changed', label: '本次变动', children: index?.changed ?? '—' },
              { key: 'readBytes', label: '读取字节', children: index?.readBytes != null ? `${(index.readBytes / 1024).toFixed(1)} KB` : '—' },
              { key: 'access', label: '访问条目', children: access?.entries ?? 0 },
              { key: 'lastAccess', label: '最近访问', children: access?.lastEntryAt ? String(access.lastEntryAt).replace('T', ' ').slice(0, 16) : '—' },
            ]}
          />
        </Card>
      </div>

      {Array.isArray(access?.top) && access.top.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <h3 className="panel-title">读取排行</h3>
          <Table
            size="middle"
            rowKey={(r) => `${r.kind}/${r.id}`}
            columns={topColumns}
            dataSource={access.top}
            pagination={false}
          />
        </div>
      )}

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">已登记主题</h3>
        <Table
          size="middle"
          tableLayout="fixed"
          rowKey="id"
          columns={topicColumns}
          dataSource={topics ?? []}
          pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'], size: 'small', showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条` }}
          scroll={{ y: 460 }}
          onRow={(r) => ({ onClick: () => openDetail('topic', r.id), className: 'row-clickable' })}
        />
      </div>
    </div>
  );
}
