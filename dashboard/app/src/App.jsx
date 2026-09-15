import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Input, Badge, Tooltip, Button, Spin, Empty, App as AntApp } from 'antd';
import {
  DashboardOutlined, ClockCircleOutlined, DatabaseOutlined, BulbOutlined,
  StarOutlined, CheckSquareOutlined, WarningOutlined, ThunderboltOutlined,
  SettingOutlined, SearchOutlined, ReloadOutlined, BookOutlined, MessageOutlined,
  ControlOutlined,
} from '@ant-design/icons';
import { getOverview, getHealth, search as apiSearch } from './lib/api.js';
import Overview from './views/Overview.jsx';
import Contexts from './views/Contexts.jsx';
import Facts from './views/Facts.jsx';
import Experiences from './views/Experiences.jsx';
import Habits from './views/Habits.jsx';
import Actions from './views/Actions.jsx';
import Conflicts from './views/Conflicts.jsx';
import Events from './views/Events.jsx';
import Sessions from './views/Sessions.jsx';
import System from './views/System.jsx';
import Settings from './views/Settings.jsx';
import Reference from './views/Reference.jsx';
import DetailDrawer from './components/DetailDrawer.jsx';
import SearchPalette from './components/SearchPalette.jsx';
import ComposeModal from './components/ComposeModal.jsx';
import PageSkeleton from './components/PageSkeleton.jsx';
import { PlusOutlined } from '@ant-design/icons';

const { Header, Sider, Content } = Layout;

// Title and description live here, not in the views: the header renders them in
// compact type so each page keeps its full height for content.
const NAV = [
  { key: 'dashboard', icon: <DashboardOutlined />, label: '总览', desc: '近期在追踪什么、有哪些已确认习惯、哪些待办未清、哪里存在冲突。图表可点击跳转。' },
  { key: 'contexts', icon: <ClockCircleOutlined />, label: '短期记忆', desc: '带 TTL 的任务上下文，记录某次会话的进行中状态。热 7 天、温 30 天，之后转为休眠仅供追溯。点击工作区或来源事件可跳转。' },
  { key: 'facts', icon: <DatabaseOutlined />, label: '长期记忆', desc: '跨会话稳定成立的事实结论，由事件归约而来。冲突时双方并存，不会自动覆盖，需显式 supersedes。点击主题可跳转，点击整行查看完整内容与来源事件。' },
  { key: 'experiences', icon: <BulbOutlined />, label: '执行经验', desc: '在执行同类操作前触发的经验条目，记录已验证的路径、边界与失败教训。点击工作区或来源事件可跳转。' },
  { key: 'habits', icon: <StarOutlined />, label: '偏好与习惯', desc: '已确认的偏好才会作为强制规则注入。自动学习最高只能提升到试用中，正式确认必须由你本人的原话授权。' },
  { key: 'actions', icon: <CheckSquareOutlined />, label: '待办', desc: '由事件归约出的未完成事项。关闭待办会追加一条带原证据的新事件，不会改写历史。点击主题或来源事件可跳转。' },
  { key: 'conflicts', icon: <WarningOutlined />, label: '冲突', desc: '同一事实键出现不同说法且未声明 supersedes 时，双方都会保留，等待人工澄清。点击整行并排查看两种说法。' },
  { key: 'events', icon: <ThunderboltOutlined />, label: '事件流', desc: '不可变事件日志，是记忆库的唯一真源。点击工作区与主题可跳转，点击整行查看完整载荷。' },
  { key: 'sessions', icon: <MessageOutlined />, label: '对话回溯', desc: '按终端查看跨 Agent 会话，点开会话可以看当前轮次的任务、回复、工具调用和每次自动检查点的原始上下文。' },
  { key: 'reference', icon: <BookOutlined />, label: '说明', desc: '界面里出现的所有标签、状态与枚举的完整解释。拿不准某个颜色或词是什么意思时查这里。' },
  { key: 'system', icon: <SettingOutlined />, label: '系统', desc: '记忆库的运行状态、索引与访问统计。访问记录用于给真正被读取的记录加权，不会自动确认偏好。' },
  { key: 'settings', icon: <ControlOutlined />, label: '设置', desc: '编辑那一份 config.json：存储后端与目录、记忆库布局与角色路径、检索与注入参数。保存走预览与签名令牌；宿主绑定是 CLI 专属，这里只做只读体检，写入后需要重启宿主里的常驻 MCP 进程。' },
];

export default function App() {
  const { message } = AntApp.useApp();
  const [view, setView] = useState('dashboard');
  const [model, setModel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [online, setOnline] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [detail, setDetail] = useState(null); // { type, id }
  const [composeOpen, setComposeOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getOverview();
      setModel(data);
      setOnline(true);
    } catch (e) {
      setError(e.message);
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getHealth().then(() => setOnline(true)).catch(() => setOnline(false));
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openDetail = useCallback((type, id) => setDetail({ type, id }), []);

  const contextValue = useMemo(() => ({
    model, reload: load, openDetail,
  }), [model, load, openDetail]);

  const renderView = () => {
    if (loading && !model) return <PageSkeleton />;
    if (error && !model) {
      return (
        <div className="center-box">
          <Empty description={`加载失败：${error}`} />
          <Button type="primary" icon={<ReloadOutlined />} onClick={load} style={{ marginTop: 16 }}>重试</Button>
        </div>
      );
    }
    const props = { model, ...contextValue, onNavigate: setView };
    switch (view) {
      case 'contexts': return <Contexts {...props} />;
      case 'facts': return <Facts {...props} />;
      case 'experiences': return <Experiences {...props} />;
      case 'habits': return <Habits {...props} />;
      case 'actions': return <Actions {...props} />;
      case 'conflicts': return <Conflicts {...props} />;
      case 'events': return <Events {...props} />;
      case 'sessions': return <Sessions {...props} />;
      case 'reference': return <Reference {...props} />;
      case 'system': return <System {...props} />;
      case 'settings': return <Settings {...props} />;
      default: return <Overview {...props} />;
    }
  };

  const conflictCount = model?.conflicts?.length ?? 0;
  const openActions = (model?.actions ?? []).filter((a) => a.status === 'open').length;
  const current = NAV.find((n) => n.key === view) ?? NAV[0];

  return (
    <Layout className="app-shell">
      <Sider width={268} theme="light" className="app-sider" breakpoint="lg" collapsedWidth={0}>
        <div className="brand">
          <div className="brand-mark">AM</div>
          <div className="brand-text">
            <div className="brand-title">Agent Memory</div>
            <div className="brand-sub">跨 Agent 记忆库</div>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[view]}
          items={NAV.map(({ desc, ...n }) => ({
            ...n,
            label: n.key === 'conflicts' && conflictCount
              ? <span>{n.label}<Badge count={conflictCount} size="small" style={{ marginLeft: 8 }} /></span>
              : n.key === 'actions' && openActions
                ? <span>{n.label}<Badge count={openActions} size="small" style={{ marginLeft: 8, background: '#8a94a6' }} /></span>
                : n.label,
          }))}
          onClick={({ key }) => setView(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div className="header-left">
            <div className="header-title">{current.label}</div>
            {current.desc && <div className="header-desc" title={current.desc}>{current.desc}</div>}
          </div>
          <div className="header-right">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setComposeOpen(true)}>新增记忆</Button>
            <Input
              readOnly
              prefix={<SearchOutlined />}
              placeholder="搜索记忆…"
              onClick={() => setSearchOpen(true)}
              className="search-box"
              suffix={<kbd className="kbd">⌘K</kbd>}
            />
            <Tooltip title={online === false ? '后端未连接' : '后端正常'}>
              <Badge status={online === false ? 'error' : online ? 'success' : 'default'} text={online === false ? '离线' : online ? '在线' : '连接中'} />
            </Tooltip>
            <Tooltip title="刷新数据">
              <Button type="text" icon={<ReloadOutlined />} onClick={load} loading={loading} />
            </Tooltip>
          </div>
        </Header>
        <Content className="app-content">
          <div className="view-enter" key={view}>
            {renderView()}
          </div>
        </Content>
      </Layout>
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPick={(type, id) => { setSearchOpen(false); openDetail(type, id); }}
        searchFn={apiSearch}
      />
      <DetailDrawer
        detail={detail}
        onClose={() => setDetail(null)}
        model={model}
        onChanged={load}
        openDetail={openDetail}
      />
      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} onCreated={load} />
    </Layout>
  );
}
