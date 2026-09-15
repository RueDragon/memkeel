import React from 'react';
import { Tag, Button } from 'antd';

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

export function EventLink({ value, openDetail, label = '查看事件' }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <Button
      type="link"
      size="small"
      style={{ padding: 0 }}
      onClick={(e) => { e.stopPropagation(); openDetail('event', value); }}
    >
      {label}
    </Button>
  );
}
