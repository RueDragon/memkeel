import React from 'react';
import { Card, Table, Tag, Typography, Descriptions } from 'antd';

const { Paragraph, Title } = Typography;

// A single reference page for every label the console renders. When the UI shows a
// status word or tag, the reader should be able to look up what it means without
// reading the source.

const lifecycle = [
  { key: 'hot', color: 'red', desc: '最近 7 天内写入或更新，视为当前活跃状态。' },
  { key: 'warm', color: 'orange', desc: '7 到 30 天之间，仍在参考窗口内，但不作为当前状态。' },
  { key: 'retained', color: 'blue', desc: '超过 30 天，转为休眠区；仍可检索，仅供追溯。' },
  { key: 'dormant', color: 'default', desc: '已休眠，不参与默认检索结果，只在历史模式可见。' },
  { key: 'closed', color: 'default', desc: '显式关闭，不再参与任何默认视图。' },
];

const preference = [
  { key: 'candidate', color: 'gold', desc: '系统从普通事件里发现的可能偏好，未生效，不会约束任何行为。' },
  { key: 'probationary', color: 'orange', desc: '自动学习到的高置信候选。作为提示展示，但不是强制规则。' },
  { key: 'confirmed', color: 'green', desc: '由你本人原话明确确认，才会注入为强制规则。' },
  { key: 'rejected', color: 'default', desc: '已被你拒绝，不再提示。' },
];

const actionStatus = [
  { key: 'open', color: 'orange', desc: '未完成。会出现在「待办」的未完成页。' },
  { key: 'done', color: 'green', desc: '已完成。关闭时追加一条带原证据的新事件，不改写历史。' },
];

const factState = [
  { key: '冲突', color: 'red', desc: '同一事实键出现不同说法且未声明 supersedes，双方并存，等待澄清。' },
  { key: 'supersedes', color: 'geekblue', desc: '显式声明「本条替代某条旧结论」。只有声明后新值才会取代旧值。' },
];

const payload = [
  { key: 'fact', color: 'blue', desc: '长期事实，跨会话稳定成立。' },
  { key: 'context', color: 'cyan', desc: '短期上下文，带 TTL 的进行中状态。' },
  { key: 'experience', color: 'geekblue', desc: '执行经验，执行同类操作前触发。' },
  { key: 'action', color: 'green', desc: '待办。' },
  { key: 'preference', color: 'gold', desc: '偏好候选或决定。' },
  { key: 'mistake', color: 'red', desc: '已确认的错误与预防措施。' },
];

function tagTable(title, rows, note) {
  return (
    <Card size="small" title={title} className="panel" bordered={false} style={{ marginBottom: 12 }}>
      {note && <Paragraph type="secondary" style={{ marginTop: 0 }}>{note}</Paragraph>}
      <Table
        size="small"
        rowKey="key"
        pagination={false}
        columns={[
          { title: '标签', dataIndex: 'key', width: 140, render: (v, r) => <Tag color={r.color}>{v}</Tag> },
          { title: '含义', dataIndex: 'desc' },
        ]}
        dataSource={rows}
      />
    </Card>
  );
}

export default function Reference() {
  return (
    <div>
      <Card size="small" title="记忆分层" className="panel" bordered={false} style={{ marginBottom: 12 }}>
        <Descriptions column={1} size="small" bordered
          items={[
            { key: 'event', label: '事件', children: '不可变的追加日志，是记忆库唯一真源。任何记录、修改、关闭都是新增一条事件，从不改写历史。' },
            { key: 'fact', label: '长期事实', children: '由事件归约出的稳定结论。冲突时双方并存，需显式 supersedes 才替换。' },
            { key: 'context', label: '短期上下文', children: '某次会话的进行中状态，带 TTL，过期后转为休眠。' },
            { key: 'experience', label: '执行经验', children: '执行同类操作前触发的已验证路径或边界。' },
            { key: 'habit', label: '偏好与习惯', children: '只有 confirmed 状态会作为强制规则注入。自动学习最高只能到 probationary。' },
          ]}
        />
      </Card>

      {tagTable('生命周期（短期记忆 / 执行经验）', lifecycle, '由写入时间推导，决定一条记录是否还被视为「当前」。')}
      {tagTable('偏好状态', preference, '自动学习永远不会把你没说过的话变成强制规则。')}
      {tagTable('待办状态', actionStatus)}
      {tagTable('事实冲突', factState, '系统默认保留双方，不会擅自覆盖。')}
      {tagTable('事件载荷类型', payload, '事件流里每条事件可能携带的载荷种类。')}
    </div>
  );
}