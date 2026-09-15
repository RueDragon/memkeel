import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Form, Select, Input, InputNumber, Radio, Alert, App as AntApp } from 'antd';
import { getComposeOptions, postWrite } from '../lib/api.js';

const KIND_OPTIONS = [
  { value: 'fact', label: '长期事实' },
  { value: 'action', label: '待办' },
  { value: 'context', label: '短期上下文' },
  { value: 'experience', label: '执行经验' },
];

// Composer for brand-new memory records. It never writes on its own: it first asks
// the server for a validated plan, shows exactly what event will be appended, and
// only then executes. Evidence is mandatory because every event must cite a source.
export default function ComposeModal({ open, onClose, onCreated }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [options, setOptions] = useState(null);
  const [kind, setKind] = useState('fact');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !options) {
      getComposeOptions().then(setOptions).catch((e) => message.error(e.message));
    }
  }, [open, options, message]);

  const topicOptions = useMemo(() => (options?.topics ?? []).map((t) => ({
    value: t.id, label: `${t.title}（${t.id}）`,
  })), [options]);

  const evidenceOptions = useMemo(() => (options?.evidence ?? []).map((e) => ({
    value: e.path, label: e.path,
  })), [options]);

  const submit = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const preview = await postWrite('compose-event/preview', { ...values, kind });
      Modal.confirm({
        title: '确认新增',
        content: (
          <div>
            <Alert type="info" showIcon message={preview.plan.summary} style={{ marginBottom: 10 }} />
            <div className="muted">将追加一条不可变事件；不会修改任何既有记录。</div>
          </div>
        ),
        okText: '确认写入',
        cancelText: '取消',
        onOk: async () => {
          await postWrite('execute', {
            action: 'compose-event',
            plan: preview.plan,
            fingerprint: preview.fingerprint,
            token: preview.token,
          });
          message.success('已新增记录');
          form.resetFields();
          onCreated?.();
          onClose();
        },
      });
    } catch (e) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="新增记忆"
      onCancel={onClose}
      onOk={submit}
      okText="预览写入"
      cancelText="取消"
      confirmLoading={busy}
      width={620}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 14 }}
        message="写入会以追加事件的方式落库，需要引用一条已有笔记作为证据。"
      />
      <Form form={form} layout="vertical" initialValues={{ kind: 'fact', ttlDays: 7, certainty: 'reported' }}>
        <Form.Item label="记录类型" name="kind" required>
          <Radio.Group options={KIND_OPTIONS} onChange={(e) => setKind(e.target.value)} optionType="button" />
        </Form.Item>
        <Form.Item label="主题" name="topic" rules={[{ required: true, message: '请选择主题' }]}>
          <Select
            showSearch
            placeholder="选择主题"
            options={topicOptions}
            loading={!options}
            optionFilterProp="label"
          />
        </Form.Item>

        {(kind === 'fact') && (
          <Form.Item label="事实键" name="key" rules={[{ required: true, message: '请输入稳定键名' }]}
            extra="小写字母、数字、连字符，例如 channel-config-width">
            <Input placeholder="stable-key" />
          </Form.Item>
        )}
        {(kind === 'action') && (
          <Form.Item label="待办 ID（可选）" name="key" extra="留空会按内容自动生成">
            <Input placeholder="todo-id" />
          </Form.Item>
        )}
        {kind === 'context' && (
          <>
            <Form.Item label="任务" name="task" rules={[{ required: true, message: '请输入任务名' }]}>
              <Input placeholder="例如 跨 Agent 记忆系统开源化" />
            </Form.Item>
            <Form.Item label="TTL（天）" name="ttlDays">
              <InputNumber min={1} max={90} />
            </Form.Item>
            <Form.Item label="确定性" name="certainty">
              <Radio.Group optionType="button">
                <Radio.Button value="reported">reported</Radio.Button>
                <Radio.Button value="verified">verified</Radio.Button>
              </Radio.Group>
            </Form.Item>
          </>
        )}
        {kind === 'experience' && (
          <>
            <Form.Item label="触发词" name="triggers" rules={[{ required: true, message: '请输入触发词' }]}
              extra="逗号分隔，例如 channelconfig, 通道配置">
              <Input placeholder="trigger-a, trigger-b" />
            </Form.Item>
            <Form.Item label="验证方式" name="verification" rules={[{ required: true, message: '请输入验证方式' }]}>
              <Input placeholder="如何验证这条经验成立" />
            </Form.Item>
            <Form.Item label="经验子类型" name="scope">
              <Radio.Group optionType="button" defaultValue="path-finding">
                <Radio.Button value="path-finding">路径发现</Radio.Button>
                <Radio.Button value="negative-search">否定搜索</Radio.Button>
              </Radio.Group>
            </Form.Item>
          </>
        )}

        <Form.Item label="内容" name="text" rules={[{ required: true, message: '请输入内容' }]}>
          <Input.TextArea rows={3} placeholder="要记录的结论或上下文" />
        </Form.Item>
        <Form.Item label="证据笔记" name="evidence" rules={[{ required: true, message: '请选择至少一条证据' }]}
          extra="事件必须引用一条真实存在的笔记路径">
          <Select
            mode="multiple"
            showSearch
            placeholder="选择证据笔记"
            options={evidenceOptions}
            loading={!options}
            optionFilterProp="label"
            maxTagCount="responsive"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
