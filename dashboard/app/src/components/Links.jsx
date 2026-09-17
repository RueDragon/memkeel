import React from 'react';
import { Tag, Button } from 'antd';
import { useI18n } from '../i18n/index.jsx';

// Small navigation primitives shared by every table so a workspace, topic or event
// reference always behaves the same: click it, land on that record's detail.
// Without these, references were dead text and the user had to remember ids and
// search manually.

export function WorkspaceLink({ value, openDetail }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <Tag
      color="blue"
      style={{ cursor: 'pointer' }}
      onClick={(e) => { e.stopPropagation(); openDetail('workspace', value); }}
    >
      {value}
    </Tag>
  );
}

export function TopicLink({ value, openDetail }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <Tag
      color="geekblue"
      style={{ cursor: 'pointer' }}
      onClick={(e) => { e.stopPropagation(); openDetail('topic', value); }}
    >
      {value}
    </Tag>
  );
}

export function EventLink({ value, openDetail, label }) {
  // The default label is resolved here rather than in the parameter list, because a parameter
  // default cannot call a hook — and it has to be a hook, or the label would not follow the
  // language switch along with every caller that passes its own label.
  const { t } = useI18n();
  if (!value) return <span className="muted">—</span>;
  return (
    <Button
      type="link"
      size="small"
      style={{ padding: 0 }}
      onClick={(e) => { e.stopPropagation(); openDetail('event', value); }}
    >
      {label ?? t('link.viewEvent')}
    </Button>
  );
}
