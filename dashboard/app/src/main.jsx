import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import App from './App.jsx';
import { I18nProvider, useI18n } from './i18n/index.jsx';
import './styles.css';

const THEME = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#2f6fdb',
    colorInfo: '#2f6fdb',
    colorError: '#c9372c',
    colorTextBase: '#16181d',
    colorBgLayout: '#f4f5f7',
    colorBorderSecondary: '#eef0f3',
    borderRadius: 10,
    borderRadiusLG: 14,
    fontFamily: "'Geist Variable', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    fontSize: 13,
    controlHeight: 34,
    boxShadowSecondary: '0 2px 6px rgba(22,24,29,.06), 0 24px 48px -24px rgba(31,55,98,.28)',
    motionEaseOut: 'cubic-bezier(.32,.72,0,1)',
    motionDurationMid: '0.28s',
  },
  components: {
    Layout: { headerBg: 'rgba(255,255,255,.82)', bodyBg: '#f4f5f7', siderBg: '#ffffff' },
    Table: {
      headerBg: '#fafbfc',
      headerColor: '#3d434e',
      headerSplitColor: 'transparent',
      rowHoverBg: '#eaf1fd',
      cellPaddingBlock: 11,
    },
    Menu: {
      itemBorderRadius: 9,
      itemSelectedBg: '#eaf1fd',
      itemSelectedColor: '#255ec4',
      itemHeight: 38,
      itemMarginInline: 8,
    },
    Card: { paddingLG: 18 },
    Tabs: { titleFontSize: 13 },
  },
};

const ANTD_LOCALES = { 'zh-Hans': zhCN, en: enUS };

// The antd locale has to follow the language switch, and ConfigProvider has to sit above the tree,
// so the choice is read here rather than inside App.
function Root() {
  const { locale } = useI18n();
  return (
    <ConfigProvider locale={ANTD_LOCALES[locale] ?? zhCN} theme={THEME}>
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </React.StrictMode>,
);
