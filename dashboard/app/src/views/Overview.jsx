import React, { useMemo } from 'react';
import { Table, Tag, Empty, Button, Space } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import LazyChart from '../components/LazyChart.jsx';
import { spotOnMove } from '../lib/spotlight.js';
import { eventSummary } from '../lib/events.js';

const LIFE_LABEL = { hot: '热', warm: '温', retained: '保留', dormant: '休眠', closed: '关闭' };

function ago(iso) {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const h = Math.floor(ms / 3.6e6);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

export default function Overview({ model, openDetail, onNavigate }) {
  if (!model) return <Empty description="暂无数据" />;
  const { status, facts, contexts, experiences, habits, candidates, actions, conflicts, events, routes, topics } = model;

  const openActions = actions.filter((a) => a.status === 'open');
  const now = Date.now();
  const recentWindow = (row) => now - Date.parse(row.at ?? row.occurred_at ?? 0) < 7 * 864e5;

  // What is actually being tracked right now: workspaces with fresh short-term
  // context, ranked by how much live context they hold. This is the question the old
  // overview answered with a bare number.
  const tracking = useMemo(() => {
    const byWs = new Map();
    for (const c of contexts) {
      const cur = byWs.get(c.workspace) ?? { workspace: c.workspace, total: 0, recent: 0, latest: null, tasks: new Set() };
      cur.total += 1;
      if (recentWindow(c)) cur.recent += 1;
      if (!cur.latest || String(c.at) > cur.latest) cur.latest = c.at;
      if (c.task) cur.tasks.add(c.task);
      byWs.set(c.workspace, cur);
    }
    return [...byWs.values()].sort((a, b) => b.recent - a.recent || b.total - a.total).slice(0, 8);
  }, [contexts]);

  const composition = useMemo(() => ({
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, icon: 'circle', textStyle: { color: '#667085', fontSize: 11 } },
    // One considered palette: a cool ramp plus a single warm note for the odd metric,
    // so the chart blends with the neutrals instead of using ECharts defaults.
    color: ['#2f6fdb', '#5b8fe8', '#8fb2ee', '#c2a24a', '#9aa4b2'],
    series: [{
      type: 'pie', radius: ['52%', '72%'], center: ['50%', '42%'],
      avoidLabelOverlap: true, itemStyle: { borderColor: '#fff', borderWidth: 2 }, label: { show: false },
      data: [
        { name: '长期事实', value: facts.length, target: 'facts' },
        { name: '短期上下文', value: contexts.length, target: 'contexts' },
        { name: '执行经验', value: experiences.length, target: 'experiences' },
        { name: '已确认习惯', value: habits.length, target: 'habits' },
        { name: '候选习惯', value: candidates.length, target: 'habits' },
      ].filter((d) => d.value > 0),
    }],
  }), [facts.length, contexts.length, experiences.length, habits.length, candidates.length]);

  const lifecycle = useMemo(() => {
    const counts = {};
    for (const row of [...contexts, ...experiences]) { const k = row.lifecycle ?? 'unknown'; counts[k] = (counts[k] ?? 0) + 1; }
    const order = ['hot', 'warm', 'retained', 'dormant', 'closed'];
    const keys = order.filter((k) => counts[k]).concat(Object.keys(counts).filter((k) => !order.includes(k)));
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 16, bottom: 8, top: 16, containLabel: true },
      xAxis: { type: 'category', data: keys.map((k) => LIFE_LABEL[k] ?? k) },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{
        type: 'bar', barWidth: '52%',
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: '#5b8fe8' },
              { offset: 1, color: '#2f6fdb' },
            ],
          },
          borderRadius: [7, 7, 0, 0],
        },
        emphasis: { itemStyle: { color: '#255ec4' } },
        data: keys.map((k) => counts[k]),
      }],
    };
  }, [contexts, experiences]);

  // Chart clicks navigate to the owning tab, which turns the charts from decoration
  // into entry points.
  const onCompositionClick = (params) => {
    const target = composition.series[0].data.find((d) => d.name === params.name)?.target;
    if (target) onNavigate?.(target);
  };

  const trackColumns = [
    { title: '工作区', dataIndex: 'workspace', render: (v) => <Tag color="blue">{v}</Tag> },
    { title: '追踪中', dataIndex: 'recent', width: 100, render: (v, r) => (v > 0 ? <Tag color="green">{v} 条近 7 天</Tag> : <span className="muted">近 7 天无更新</span>) },
    { title: '上下文总数', dataIndex: 'total', width: 110 },
    { title: '最近更新', dataIndex: 'latest', width: 130, render: (v) => <span className="muted">{ago(v)}</span> },
    { title: '', key: 'go', width: 60, render: () => <RightOutlined className="muted" /> },
  ];

  return (
    <div>
      <div className="stat-grid">
        <button className="stat-card clickable" onMouseMove={spotOnMove} onClick={() => onNavigate?.('contexts')}>
          <div className="label">追踪中的项目</div>
          <div className="value">{tracking.filter((t) => t.recent > 0).length}</div>
          <div className="foot">近 7 天有活跃上下文</div>
        </button>
        <button className="stat-card clickable" onClick={() => onNavigate?.('facts')}>
          <div className="label">长期事实</div>
          <div className="value">{status.facts}</div>
          <div className="foot">由事件归约</div>
        </button>
        <button className="stat-card clickable" onClick={() => onNavigate?.('habits')}>
          <div className="label">已确认习惯</div>
          <div className="value">{habits.length}</div>
          <div className="foot">候选 {candidates.length}</div>
        </button>
        <button className="stat-card clickable" onClick={() => onNavigate?.('actions')}>
          <div className="label">未完成待办</div>
          <div className="value">{openActions.length}</div>
          <div className="foot">共 {actions.length} 条</div>
        </button>
        <button className={`stat-card clickable${conflicts.length ? ' alert' : ''}`} onMouseMove={spotOnMove} onClick={() => onNavigate?.('conflicts')}>
          <div className="label">未解决冲突</div>
          <div className="value">{conflicts.length}</div>
          <div className="foot">需要人工澄清</div>
        </button>
        <button className="stat-card clickable" onClick={() => onNavigate?.('events')}>
          <div className="label">事件</div>
          <div className="value">{status.events}</div>
          <div className="foot">不可变日志</div>
        </button>
      </div>

      <div className="chart-grid">
        <div className="panel">
          <h3 className="panel-title">正在追踪的项目</h3>
          {tracking.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无短期上下文" style={{ padding: 40 }} />
            : (
              <Table
                size="small"
                rowKey="workspace"
                columns={trackColumns}
                dataSource={tracking}
                pagination={false}
                onRow={(r) => ({ onClick: () => openDetail('workspace', r.workspace), className: 'row-clickable' })}
              />
            )}
        </div>
        <div className="panel">
          <h3 className="panel-title">生命周期分布（近 7 天）</h3>
          {contexts.length + experiences.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无短期记忆" style={{ padding: 40 }} />
            : <LazyChart option={lifecycle} height={260} />}
        </div>
      </div>

      <div className="chart-grid" style={{ marginTop: 12 }}>
        <div className="panel">
          <h3 className="panel-title">记忆构成（点击跳转）</h3>
          <LazyChart option={composition} height={240} onEvents={{ click: onCompositionClick }} />
        </div>
        <div className="panel">
          <h3 className="panel-title">已确认习惯</h3>
          {habits.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已确认习惯" style={{ padding: 40 }} />
            : (
              <ul className="habit-preview">
                {habits.slice(0, 6).map((h) => (
                  <li key={h.id} onClick={() => openDetail('habit', h.id)}>
                    <Tag color="gold">{h.scope}</Tag>
                    <span>{h.text}</span>
                  </li>
                ))}
                {habits.length > 6 && (
                  <li className="more" onClick={() => onNavigate?.('habits')}>
                    还有 {habits.length - 6} 条 <RightOutlined />
                  </li>
                )}
              </ul>
            )}
        </div>
      </div>

      <div className="chart-grid" style={{ marginTop: 12 }}>
        <div className="panel">
          <h3 className="panel-title">未完成待办</h3>
          {openActions.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有未完成待办" style={{ padding: 32 }} />
            : (
              <ul className="habit-preview">
                {openActions.slice(0, 6).map((a) => (
                  <li key={`${a.topic}/${a.id}`} onClick={() => openDetail('action', `${a.topic}/${a.id}`)}>
                    <Tag color="orange">{a.topic}</Tag>
                    <span>{a.text}</span>
                  </li>
                ))}
                {openActions.length > 6 && (
                  <li className="more" onClick={() => onNavigate?.('actions')}>
                    还有 {openActions.length - 6} 条 <RightOutlined />
                  </li>
                )}
              </ul>
            )}
        </div>
        <div className="panel">
          <h3 className="panel-title">最近事件</h3>
          <ul className="habit-preview">
            {events.slice(0, 6).map((e) => {
              // A journal event is a container: the readable line has to be derived from
              // whichever payload it carries, otherwise the row shows only a tag.
              const summary = eventSummary(e);
              return (
                <li key={e.event_id} onClick={() => openDetail('event', e.event_id)}>
                  <Tag>{e.workspace}</Tag>
                  <span className={summary ? 'event-preview' : 'muted'}>{summary || '（无摘要，点开查看）'}</span>
                  <span className="muted nowrap">{ago(e.occurred_at)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
