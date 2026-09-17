import React from 'react';
import { Descriptions, Table, Card, Empty, Tag, Statistic, Row, Col } from 'antd';
import LazyChart from '../components/LazyChart.jsx';
import { WorkspaceLink } from '../components/Links.jsx';
import { useI18n } from '../i18n/index.jsx';

// The payload-kind labels moved inside the component: they are translated now, and the three names
// are the ones the search palette and the reference page already use.
export default function System({ model, openDetail }) {
  const { t } = useI18n();
  const KIND_LABEL = {
    fact: t('search.kind.fact'), context: t('search.kind.context'), experience: t('search.kind.experience'),
  };
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
    { title: t('col.topic'), dataIndex: 'id', flex: '0 0 30%', render: (v) => <span className="mono">{v}</span> },
    { title: t('col.workspace'), dataIndex: 'workspace', flex: '0 0 20%', render: (v) => <WorkspaceLink value={v} openDetail={openDetail} /> },
    { title: t('sys.col.title'), dataIndex: 'title', flex: 1 },
    { title: t('sys.col.path'), dataIndex: 'path', flex: '0 0 28%', ellipsis: true, render: (v) => <span className="mono muted">{v}</span> },
  ];

  const topColumns = [
    { title: t('field.kind'), dataIndex: 'kind', width: 110, render: (v) => <Tag>{KIND_LABEL[v] ?? v}</Tag> },
    { title: t('sys.col.record'), dataIndex: 'id', render: (v, r) => (
      <span
        className="row-clickable mono"
        onClick={() => r.kind && ['fact', 'context', 'experience'].includes(r.kind) && openDetail(r.kind, v)}
      >{v}</span>
    ) },
    { title: t('sys.col.reads'), dataIndex: 'reads', width: 100, align: 'right' },
    { title: t('sys.col.lastAccess'), dataIndex: 'lastAccess', width: 180, render: (v) => <span className="nowrap muted">{v ? String(v).replace('T', ' ').slice(0, 16) : '—'}</span> },
  ];

  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <h3 className="panel-title">{t('sys.runtime')}</h3>
        <Row gutter={16}>
          <Col span={4}><Statistic title={t('sys.version')} value={status?.version ?? '—'} /></Col>
          <Col span={4}><Statistic title={t('sys.events')} value={status?.events ?? 0} /></Col>
          <Col span={4}><Statistic title={t('search.kind.fact')} value={status?.facts ?? 0} /></Col>
          <Col span={4}><Statistic title={t('search.kind.context')} value={status?.contexts ?? 0} /></Col>
          <Col span={4}><Statistic title={t('search.kind.experience')} value={status?.experiences ?? 0} /></Col>
          <Col span={4}><Statistic title={t('sys.pending')} value={status?.pending ?? 0} valueStyle={status?.pending ? { color: '#d92d20' } : undefined} /></Col>
        </Row>
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={4}><Statistic title={t('sys.conflicts')} value={status?.conflicts ?? 0} valueStyle={status?.conflicts ? { color: '#d92d20' } : undefined} /></Col>
          <Col span={4}><Statistic title={t('col.workspace')} value={routes?.length ?? 0} /></Col>
          <Col span={4}><Statistic title={t('col.topic')} value={topics?.length ?? 0} /></Col>
          <Col span={12}>
            <Descriptions size="small" column={1}
              items={[{ key: 'paths', label: t('sys.vaultRoot'), children: <span className="mono muted">{model?.status?.vaultRoot ?? t('sys.vaultRootEnv')}</span> }]}
            />
          </Col>
        </Row>
      </div>

      <div className="chart-grid">
        <Card size="small" title={t('sys.accessBreakdown')} className="panel" bordered={false}>
          {Object.keys(byKind).length
            ? <LazyChart option={accessOption} height={250} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sys.noReads')} style={{ padding: 40 }} />}
        </Card>
        <Card size="small" title={t('sys.index')} className="panel" bordered={false}>
          <Descriptions column={1} size="small"
            items={[
              { key: 'files', label: t('sys.indexFiles'), children: index?.files ?? '—' },
              { key: 'changed', label: t('sys.changed'), children: index?.changed ?? '—' },
              { key: 'readBytes', label: t('sys.readBytes'), children: index?.readBytes != null ? `${(index.readBytes / 1024).toFixed(1)} KB` : '—' },
              { key: 'access', label: t('sys.accessEntries'), children: access?.entries ?? 0 },
              { key: 'lastAccess', label: t('sys.lastAccessAt'), children: access?.lastEntryAt ? String(access.lastEntryAt).replace('T', ' ').slice(0, 16) : '—' },
            ]}
          />
        </Card>
      </div>

      {Array.isArray(access?.top) && access.top.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <h3 className="panel-title">{t('sys.readRanking')}</h3>
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
        <h3 className="panel-title">{t('sys.registeredTopics')}</h3>
        <Table
          size="middle"
          tableLayout="fixed"
          rowKey="id"
          columns={topicColumns}
          dataSource={topics ?? []}
          pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'], size: 'small', showTotal: (total, range) => t('dataTable.total', { from: range[0], to: range[1], total }) }}
          scroll={{ y: 460 }}
          onRow={(r) => ({ onClick: () => openDetail('topic', r.id), className: 'row-clickable' })}
        />
      </div>
    </div>
  );
}
