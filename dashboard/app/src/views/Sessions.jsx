import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Tag, Empty, Spin, Input, Segmented, Tooltip, Badge, Tabs, Alert, Button } from 'antd';
import { SearchOutlined, RobotOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { getSessions, getDetail, getTranscript } from '../lib/api.js';
import Markdown from '../components/Markdown.jsx';
import ScrollToTop from '../components/ScrollToTop.jsx';
import { splitTurnText } from '../lib/chat.js';

const HOST_COLOR = { codex: 'blue', zcode: 'geekblue', dsh: 'cyan', claude: 'purple' };
const STATUS_META = {
  active: { label: '进行中', color: 'green' },
  captured: { label: '已入档', color: 'blue' },
  idle: { label: '空闲', color: 'default' },
  skipped: { label: '跳过', color: 'orange' },
};

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

function clamp(text, max = 90) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// Renders the host's real on-disk conversation. The summary tab shows what the hook
// archived; this tab shows the source transcript the summary was derived from.
function TranscriptView({ loading, data }) {
  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>;
  if (!data) return null;
  if (!data.available) {
    return (
      <Alert
        type="warning"
        showIcon
        message="无法读取真实对话记录"
        description={data.reason || '未知原因'}
      />
    );
  }
  return (
    <>
      <div className="muted transcript-source">
        <span>来源文件：{data.source}</span>
        {data.mtime && <span> · 更新于 {String(data.mtime).replace('T', ' ').slice(0, 19)}</span>}
        <span> · 共 {data.turns.length} 条消息</span>
      </div>
      {data.turns.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该文件没有可展示的对话消息" style={{ padding: 24 }} />
        : (
          <div className="transcript-stream">
            {data.turns.map((t, i) => (
              <div key={i} className={`chat-row chat-row--${t.role === 'user' ? 'user' : 'agent'}`}>
                {t.role === 'user'
                  ? <>
                      <div className="chat-bubble chat-bubble--user chat-bubble--static"><Markdown>{t.text}</Markdown></div>
                      <span className="chat-avatar">我</span>
                    </>
                  : <>
                      <span className="chat-avatar chat-avatar--agent">AI</span>
                      <div className="chat-bubble chat-bubble--agent chat-bubble--static"><Markdown>{t.text}</Markdown></div>
                    </>}
              </div>
            ))}
          </div>
        )}
    </>
  );
}

export default function Sessions({ openDetail }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [host, setHost] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState('summary');
  const [transcript, setTranscript] = useState(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const detailRef = useRef(null);

  useEffect(() => {
    let alive = true;
    getSessions()
      .then((res) => { if (alive) setData(res); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selectedKey) { setDetail(null); return; }
    let alive = true;
    setDetailLoading(true);
    getDetail('session', selectedKey)
      .then((res) => { if (alive) setDetail(res); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [selectedKey]);

  // The checkpoint list reads chronologically, so open at the newest entry by
  // scrolling to the bottom; scrolling up walks back through the history.
  useEffect(() => {
    if (tab !== 'summary') return undefined;
    const el = detailRef.current;
    if (!el || !detail) return undefined;
    const id = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(id);
  }, [detail?.key, detail?.turns?.length, tab]);

  useEffect(() => { setTab('summary'); setTranscript(null); }, [selectedKey]);

  // The real transcript is fetched lazily: only when the 真实对话 tab is opened
  // for a selected session, so browsing the list stays cheap.
  useEffect(() => {
    if (tab !== 'transcript' || !detail) return undefined;
    let alive = true;
    setTranscriptLoading(true);
    setTranscript(null);
    getTranscript({ key: detail.key, host: detail.host, sessionId: detail.sessionId })
      .then((res) => { if (alive) setTranscript(res); })
      .catch((e) => { if (alive) setTranscript({ available: false, reason: e.message, turns: [] }); })
      .finally(() => { if (alive) setTranscriptLoading(false); });
    return () => { alive = false; };
  }, [tab, detail?.key, detail?.host, detail?.sessionId]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = keyword.trim().toLowerCase();
    return data.sessions.filter((row) => {
      if (host !== 'all' && row.host !== host) return false;
      if (!needle) return true;
      return [row.summary, row.prompt, row.lastAssistant, row.workspace, row.model, row.cwd]
        .some((v) => String(v ?? '').toLowerCase().includes(needle));
    });
  }, [data, host, keyword]);

  if (error && !data) return <Empty description={`加载失败：${error}`} />;
  if (!data) return <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>;

  const hostOptions = [
    { label: '全部', value: 'all' },
    ...data.hosts.map((h) => ({ label: `${h.id} ${h.sessions}`, value: h.id })),
  ];

  return (
    <div className="table-view">
      <div className="panel" style={{ flex: '1 1 auto', minHeight: 0 }}>
        <div className="session-layout">
          <aside className="session-rail">
            <Segmented
              block
              value={host}
              options={hostOptions}
              onChange={(value) => setHost(value)}
              style={{ marginBottom: 10 }}
            />
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索任务、回复、工作区…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ marginBottom: 10 }}
            />
            <div className="session-list">
              {filtered.length === 0
                ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配会话" style={{ padding: 32 }} />
                : filtered.map((row) => {
                    const meta = STATUS_META[row.status] ?? { label: row.status, color: 'default' };
                    return (
                      <button
                        key={row.key}
                        type="button"
                        className={`session-item${selectedKey === row.key ? ' selected' : ''}`}
                        onClick={() => setSelectedKey(row.key)}
                      >
                        <div className="session-item-top">
                          <Tag color={HOST_COLOR[row.host] ?? 'default'}>{row.host}</Tag>
                          <span className="muted">{row.workspace || '未知工作区'}</span>
                          <span className="muted session-time">{ago(row.updatedAt)}</span>
                        </div>
                        <div className="session-item-summary" title="本会话第一条消息">
                          <span className="session-item-first">开场</span>{clamp(row.summary || row.prompt || '（无任务文本）')}
                        </div>
                        <div className="session-item-meta">
                          <Badge color={meta.color} text={meta.label} />
                          <span>{row.checkpointCount} 个检查点</span>
                          <span>{row.turn} 轮</span>
                          {row.failedTools > 0 && <span className="danger-text">{row.failedTools} 次失败</span>}
                        </div>
                      </button>
                    );
                  })}
            </div>
          </aside>

          <section className="session-detail" ref={detailRef}>
            {detailLoading ? <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
              : !detail ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择左侧会话查看概要" style={{ padding: 60 }} />
              : (
                <>
                  <header className="session-detail-head">
                    <div className="session-detail-title">
                      <Tag color={HOST_COLOR[detail.host] ?? 'default'}>{detail.host}</Tag>
                      <strong>{detail.id}</strong>
                      <Badge color={(STATUS_META[detail.status] ?? {}).color ?? 'default'} text={(STATUS_META[detail.status] ?? {}).label ?? detail.status} />
                      {detail.readOnly && <Tag color="red">只读</Tag>}
                    </div>
                    <div className="muted session-detail-sub">
                      <ClockCircleOutlined /> {ago(detail.updatedAt)}
                      {detail.workspace && <span> · {detail.workspace}</span>}
                      {detail.model && <span> · {detail.model}</span>}
                      {detail.cwd && <Tooltip title={detail.cwd}><span> · {detail.cwd}</span></Tooltip>}
                    </div>
                    {detail.firstTask && (
                      <div className="session-first-task">
                        <span className="session-first-label">本会话第一条消息</span>
                        <span>{clamp(detail.firstTask, 240)}</span>
                      </div>
                    )}
                    <div className="session-detail-stats">
                      <span>{detail.turn} 轮提问</span>
                      <span>{detail.toolCalls} 次工具调用</span>
                      <span>{detail.failedTools} 次失败</span>
                      <span>{(detail.factRecall?.matched?.length ?? 0)} 条事实命中</span>
                      <span>{detail.turns.length} 个检查点</span>
                    </div>
                  </header>

                  <Tabs
                    activeKey={tab}
                    onChange={setTab}
                    items={[
                      { key: 'summary', label: '概要记录' },
                      { key: 'transcript', label: '真实对话' },
                    ]}
                    className="session-tabs"
                  />
                  {tab === 'transcript' ? <TranscriptView loading={transcriptLoading} data={transcript} /> : (
                  <>

{detail.prompt && (
  <div className="session-block">
    <h4>当前任务</h4>
    <div className="chat-row chat-row--user">
      <button type="button" className="chat-bubble chat-bubble--user" onClick={() => openDetail?.('context', detail.id)}>
        <Markdown>{detail.prompt}</Markdown>
      </button>
      <span className="chat-avatar">我</span>
    </div>
  </div>
)}
{detail.lastAssistant && (
  <div className="session-block">
    <h4>最近回复（未复核）</h4>
    <div className="chat-row chat-row--agent">
      <span className="chat-avatar chat-avatar--agent">{detail.host}</span>
      <button type="button" className="chat-bubble chat-bubble--agent" onClick={() => openDetail?.('session', detail.id)}>
        <Markdown>{detail.lastAssistant}</Markdown>
      </button>
    </div>
  </div>
)}
{detail.routeError && (
  <div className="session-block danger">
    <h4>工作区路由错误</h4>
    <pre className="session-raw">{detail.routeError}</pre>
  </div>
)}

<div className="session-turns">
  <h4>自动检查点回溯（按时间正序，最新在最下）</h4>
  {detail.turns.length === 0
    ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该会话还没有入档检查点" style={{ padding: 24 }} />
    : detail.turns.map((turn) => {
        const parsed = splitTurnText(turn.text);
        const request = turn.task || parsed.request;
        const reply = parsed.reply || (turn.task ? turn.text : '');
        return (
          <div key={turn.event_id} className="chat-exchange">
            <div className="chat-exchange-head">
              <span className="muted">{String(turn.occurred_at).replace('T', ' ').slice(0, 19)}</span>
              <Tag color="blue">{turn.certainty || 'reported'}</Tag>
              {turn.lifecycle && <Tag>{turn.lifecycle}</Tag>}
              {turn.supersedes && <Tooltip title={`替代 ${turn.supersedes}`}><Tag color="orange">替代</Tag></Tooltip>}
            </div>
            {request && (
              <div className="chat-row chat-row--user">
                <button type="button" className="chat-bubble chat-bubble--user" onClick={() => openDetail?.('event', turn.event_id)}>
                  <Markdown>{request}</Markdown>
                </button>
                <span className="chat-avatar">我</span>
              </div>
            )}
            {reply && (
              <div className="chat-row chat-row--agent">
                <span className="chat-avatar chat-avatar--agent">{detail.host}</span>
                <button type="button" className="chat-bubble chat-bubble--agent" onClick={() => openDetail?.('event', turn.event_id)}>
                  <Markdown>{reply}</Markdown>
                </button>
              </div>
            )}
          </div>
        );
      })}
</div>
                  {detail.observations.length > 0 && (
                    <div className="session-block">
                      <h4>最近工具观察</h4>
                      <div className="session-tools">
                        {detail.observations.slice(-12).reverse().map((row, i) => (
                          <Tag key={i} color={row.failed ? 'red' : 'default'}>{row.tool}</Tag>
                        ))}
                      </div>
                    </div>
                  )}
                  </>
                  )}
                </>
              )}
            <ScrollToTop targetRef={detailRef} />
          </section>
        </div>
      </div>
    </div>
  );
}




