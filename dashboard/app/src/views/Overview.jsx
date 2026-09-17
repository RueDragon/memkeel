import React, { useMemo } from 'react';
import { Table, Tag, Empty, Button, Space } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import LazyChart from '../components/LazyChart.jsx';
import { spotOnMove } from '../lib/spotlight.js';
import { eventSummary } from '../lib/events.js';
import { useI18n } from '../i18n/index.jsx';

// The relative-time helper takes a translator rather than closing over one: it is a module-level
// function, so it has no hook to read, and it is called from two places in the render.
function ago(iso, t) {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const h = Math.floor(ms / 3.6e6);
  if (h < 1) return t('ago.justNow');
  if (h < 24) return t('ago.hours', { h });
  const d = Math.floor(h / 24);
  return t('ago.days', { d });
}

export default function Overview({ model, openDetail, onNavigate }) {
  const { t } = useI18n();
  const LIFE_LABEL = {
    hot: t('life.hot'), warm: t('life.warm'), retained: t('life.retained'),
    dormant: t('life.dormant'), closed: t('life.closed'),
  };
  if (!model) return <Empty description={t('ov.empty')} />;
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
        { name: t('search.kind.fact'), value: facts.length, target: 'facts' },
        { name: t('search.kind.context'), value: contexts.length, target: 'contexts' },
        { name: t('search.kind.experience'), value: experiences.length, target: 'experiences' },
        { name: t('ov.confirmedHabits'), value: habits.length, target: 'habits' },
        { name: t('ov.candidateHabits'), value: candidates.length, target: 'habits' },
      ].filter((d) => d.value > 0),
    }],
    // t is a dependency because these labels are translated: without it a language switch would leave
    // the chart named in the previous language, since the memo would not re-run.
  }), [facts.length, contexts.length, experiences.length, habits.length, candidates.length, t]);

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
  }, [contexts, experiences, t]);

  // Chart clicks navigate to the owning tab, which turns the charts from decoration
  // into entry points.
  const onCompositionClick = (params) => {
    const target = composition.series[0].data.find((d) => d.name === params.name)?.target;
    if (target) onNavigate?.(target);
  };

  const trackColumns = [
    { title: t('col.workspace'), dataIndex: 'workspace', render: (v) => <Tag color="blue">{v}</Tag> },
    { title: t('ov.col.tracking'), dataIndex: 'recent', width: 100, render: (v, r) => (v > 0 ? <Tag color="green">{t('ov.recent', { v })}</Tag> : <span className="muted">{t('ov.noRecent')}</span>) },
    { title: t('ov.col.contextsTotal'), dataIndex: 'total', width: 110 },
    { title: t('ov.col.latest'), dataIndex: 'latest', width: 130, render: (v) => <span className="muted">{ago(v, t)}</span> },
    { title: '', key: 'go', width: 60, render: () => <RightOutlined className="muted" /> },
  ];

  return (
    <div>
      <div className="stat-grid">
        <button className="stat-card clickable" onMouseMove={spotOnMove} onClick={() => onNavigate?.('contexts')}>
          <div className="label">{t('ov.card.tracking')}</div>
          <div className="value">{tracking.filter((t2) => t2.recent > 0).length}</div>
          <div className="foot">{t('ov.card.trackingFoot')}</div>
        </button>
        <button className="stat-card clickable" onClick={() => onNavigate?.('facts')}>
          <div className="label">{t('search.kind.fact')}</div>
          <div className="value">{status.facts}</div>
          <div className="foot">{t('ov.card.factsFoot')}</div>
        </button>
        <button className="stat-card clickable" onClick={() => onNavigate?.('habits')}>
          <div className="label">{t('ov.confirmedHabits')}</div>
          <div className="value">{habits.length}</div>
          <div className="foot">{t('ov.card.candidatesFoot', { n: candidates.length })}</div>
        </button>
        <button className="stat-card clickable" onClick={() => onNavigate?.('actions')}>
          <div className="label">{t('ov.openActions')}</div>
          <div className="value">{openActions.length}</div>
          <div className="foot">{t('ov.card.actionsFoot', { n: actions.length })}</div>
        </button>
        <button className={`stat-card clickable${conflicts.length ? ' alert' : ''}`} onMouseMove={spotOnMove} onClick={() => onNavigate?.('conflicts')}>
          <div className="label">{t('sys.conflicts')}</div>
          <div className="value">{conflicts.length}</div>
          <div className="foot">{t('ov.card.conflictsFoot')}</div>
        </button>
        <button className="stat-card clickable" onClick={() => onNavigate?.('events')}>
          <div className="label">{t('search.kind.event')}</div>
          <div className="value">{status.events}</div>
          <div className="foot">{t('ov.card.eventsFoot')}</div>
        </button>
      </div>

      <div className="chart-grid">
        <div className="panel">
          <h3 className="panel-title">{t('ov.section.tracking')}</h3>
          {tracking.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ov.emptyTracking')} style={{ padding: 40 }} />
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
          <h3 className="panel-title">{t('ov.section.lifecycle')}</h3>
          {contexts.length + experiences.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ov.emptyLifecycle')} style={{ padding: 40 }} />
            : <LazyChart option={lifecycle} height={260} />}
        </div>
      </div>

      <div className="chart-grid" style={{ marginTop: 12 }}>
        <div className="panel">
          <h3 className="panel-title">{t('ov.section.composition')}</h3>
          <LazyChart option={composition} height={240} onEvents={{ click: onCompositionClick }} />
        </div>
        <div className="panel">
          <h3 className="panel-title">{t('ov.confirmedHabits')}</h3>
          {habits.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ov.emptyHabits')} style={{ padding: 40 }} />
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
                     {t('ov.more', { n: habits.length - 6 })} <RightOutlined />
                  </li>
                )}
              </ul>
            )}
        </div>
      </div>

      <div className="chart-grid" style={{ marginTop: 12 }}>
        <div className="panel">
          <h3 className="panel-title">{t('ov.openActions')}</h3>
          {openActions.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('ov.emptyActions')} style={{ padding: 32 }} />
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
                     {t('ov.more', { n: openActions.length - 6 })} <RightOutlined />
                  </li>
                )}
              </ul>
            )}
        </div>
        <div className="panel">
          <h3 className="panel-title">{t('ov.section.recentEvents')}</h3>
          <ul className="habit-preview">
            {events.slice(0, 6).map((e) => {
              // A journal event is a container: the readable line has to be derived from
              // whichever payload it carries, otherwise the row shows only a tag.
              // The translator is passed through so the summary follows the language switch; without
              // it eventSummary falls back to the default locale.
              const summary = eventSummary(e, undefined, t);
              return (
                <li key={e.event_id} onClick={() => openDetail('event', e.event_id)}>
                  <Tag>{e.workspace}</Tag>
                  <span className={summary ? 'event-preview' : 'muted'}>{summary || t('ov.noSummary')}</span>
                  <span className="muted nowrap">{ago(e.occurred_at, t)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
