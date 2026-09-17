import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Layout, Menu, Input, Badge, Tooltip, Button, Spin, Empty, Segmented, App as AntApp } from 'antd';
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
import { useI18n } from './i18n/index.jsx';
import { LOCALES } from './i18n/messages.js';

const { Header, Sider, Content } = Layout;

// Titles and descriptions live here as message keys, not as text and not in the views: the header
// renders them in compact type so each page keeps its full height for content, and the catalogue
// keeps them translatable. The icons stay here because an icon is not language.
const NAV = [
  { key: 'dashboard', icon: <DashboardOutlined /> },
  { key: 'contexts', icon: <ClockCircleOutlined /> },
  { key: 'facts', icon: <DatabaseOutlined /> },
  { key: 'experiences', icon: <BulbOutlined /> },
  { key: 'habits', icon: <StarOutlined /> },
  { key: 'actions', icon: <CheckSquareOutlined /> },
  { key: 'conflicts', icon: <WarningOutlined /> },
  { key: 'events', icon: <ThunderboltOutlined /> },
  { key: 'sessions', icon: <MessageOutlined /> },
  { key: 'reference', icon: <BookOutlined /> },
  { key: 'system', icon: <SettingOutlined /> },
  { key: 'settings', icon: <ControlOutlined /> },
];

export default function App() {
  const { t, locale, setLocale } = useI18n();
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
    // The settings page reads its own payload and needs no model, so it renders even when the shared
    // model failed to load: it is the one place a broken store can be repaired, and hiding it behind
    // the generic failure below would leave its own, more specific error text and hint unreachable.
    if (error && !model && view !== 'settings') {
      return (
        <div className="center-box">
          <Empty description={t('shell.loadFailed', { error })} />
          <Button type="primary" icon={<ReloadOutlined />} onClick={load} style={{ marginTop: 16 }}>{t('shell.retry')}</Button>
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
  const navLabel = (key) => t(`nav.${key}.label`);
  const navDesc = (key) => t(`nav.${key}.desc`);

  return (
    <Layout className="app-shell">
      <Sider width={268} theme="light" className="app-sider" breakpoint="lg" collapsedWidth={0}>
        <div className="brand">
          <div className="brand-mark">AM</div>
          <div className="brand-text">
            <div className="brand-title">Agent Memory</div>
            <div className="brand-sub">{t('shell.brandSub')}</div>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[view]}
          items={NAV.map((n) => {
            const label = navLabel(n.key);
            return {
              key: n.key,
              icon: n.icon,
              label: n.key === 'conflicts' && conflictCount
                ? <span>{label}<Badge count={conflictCount} size="small" style={{ marginLeft: 8 }} /></span>
                : n.key === 'actions' && openActions
                  ? <span>{label}<Badge count={openActions} size="small" style={{ marginLeft: 8, background: '#8a94a6' }} /></span>
                  : label,
            };
          })}
          onClick={({ key }) => setView(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div className="header-left">
            <div className="header-title">{navLabel(current.key)}</div>
            {navDesc(current.key) && <div className="header-desc" title={navDesc(current.key)}>{navDesc(current.key)}</div>}
          </div>
          <div className="header-right">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setComposeOpen(true)}>{t('shell.newMemory')}</Button>
            <Input
              readOnly
              prefix={<SearchOutlined />}
              placeholder={t('shell.searchPlaceholder')}
              onClick={() => setSearchOpen(true)}
              className="search-box"
              suffix={<kbd className="kbd">⌘K</kbd>}
            />
            <Tooltip title={online === false ? t('shell.backendDown') : t('shell.backendUp')}>
              <Badge status={online === false ? 'error' : online ? 'success' : 'default'} text={online === false ? t('shell.offline') : online ? t('shell.online') : t('shell.connecting')} />
            </Tooltip>
            <Segmented
              size="small"
              value={locale}
              onChange={setLocale}
              options={LOCALES.map((code) => ({ value: code, label: t(`locale.${code}`) }))}
              aria-label={t('shell.language')}
            />
            <Tooltip title={t('shell.refresh')}>
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
