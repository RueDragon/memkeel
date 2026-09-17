import React from 'react';
import { Alert } from 'antd';
import DataTable from '../components/DataTable.jsx';
import { TopicLink } from '../components/Links.jsx';
import { useI18n } from '../i18n/index.jsx';

export default function Conflicts({ model, openDetail }) {
  const { t } = useI18n();
  const columns = [
    { title: t('col.topic'), dataIndex: 'topic', width: 200, render: (v) => <TopicLink value={v} openDetail={openDetail} /> },
    { title: t('col.key'), dataIndex: 'key', width: 190, render: (v) => <span className="mono">{v}</span> },
    { title: t('col.currentRetained'), key: 'current', width: 380, render: (_v, r) => r.current?.text ?? r.current?.event_id ?? '—' },
    { title: t('col.incomingClaim'), key: 'incoming', width: 380, render: (_v, r) => r.incoming?.text ?? r.incoming?.event_id ?? '—' },
  ];
  return (
    <div className="table-view">
      {(model?.conflicts?.length ?? 0) === 0
        ? <Alert type="success" showIcon message={t('conflicts.empty')} />
        : (
          <div className="panel">
            <DataTable
              columns={columns}
              data={model.conflicts}
              rowKey={(r) => `${r.topic}/${r.key}/${r.event_id}`}
              searchPlaceholder={t('conflicts.filter')}
              onRowClick={(r) => openDetail('conflict', [r.topic, r.key, r.event_id].join('/'))}
              pageSize={10}
            />
          </div>
        )}
    </div>
  );
}
