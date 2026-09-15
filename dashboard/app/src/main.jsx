import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
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
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);