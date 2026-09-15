import React, { useEffect, useRef, useState } from 'react';
import { Modal, Input, List, Tag, Empty, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { previewLine } from '../lib/chat.js';

const KIND_LABEL = {
  fact: '长期事实', context: '短期上下文', experience: '执行经验',
  habit: '偏好', action: '待办', event: '事件', workspace: '工作区', topic: '主题',
};

const KIND_COLOR = {
  fact: 'blue', context: 'cyan', experience: 'geekblue',
  habit: 'gold', action: 'green', event: 'default', workspace: 'purple', topic: 'magenta',
};

// One search box over every memory surface. Results carry their type so a click can
// route straight to the right detail view, which is what a new user expects.
export default function SearchPalette({ open, onClose, onPick, searchFn }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!open) { setQuery(''); setHits([]); }
  }, [open]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) { setHits([]); return; }
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchFn(query.trim());
        setHits(data.hits ?? []);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => timer.current && clearTimeout(timer.current);
  }, [query, searchFn]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={640}
      styles={{ body: { padding: 0 } }}
      destroyOnClose
    >
      <Input
        autoFocus
        size="large"
        variant="borderless"
        prefix={<SearchOutlined />}
        placeholder="搜索事实、上下文、习惯、待办、事件、工作区…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ padding: '12px 16px' }}
      />
      <div style={{ maxHeight: 420, overflow: 'auto', borderTop: '1px solid #eceef1' }}>
        {loading ? <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
          : !query.trim() ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入关键词开始搜索" style={{ padding: 28 }} />
          : hits.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配结果" style={{ padding: 28 }} />
          : (
            <List
              dataSource={hits}
              renderItem={(h) => {
                // A context hit's snippet is the raw checkpoint text; strip the embedded
                // request/reply labels so the result reads as a sentence, and keep the
                // untouched snippet in the tooltip.
                const snippet = previewLine(h.snippet);
                return (
                <List.Item
                  className="row-clickable"
                  onClick={() => onPick(h.type, h.id)}
                  style={{ padding: '10px 16px' }}
                >
                  <List.Item.Meta
                    title={<span>{h.title}</span>}
                    description={<span className="muted" title={h.snippet}>{snippet}</span>}
                  />
                  <Tag color={KIND_COLOR[h.type]}>{KIND_LABEL[h.type] ?? h.type}</Tag>
                </List.Item>
                );
              }}
            />
          )}
      </div>
    </Modal>
  );
}
