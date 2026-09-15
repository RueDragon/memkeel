import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, Alert, Radio, App as AntApp } from 'antd';
import { previewRevision } from '../lib/api.js';

// One editor for every memory type. It never edits Markdown or rewrites an event:
// it appends a superseding event. `mode` picks the preview route, and the retire
// option appends a replacement that marks the record inactive instead of deleting it.
//
// The original record is immutable, so the UI is explicit about that: the helper text
// states that history is preserved and that this creates a new revision.
export default function EditModal({ open, onClose, target, onSaved }) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState('revise');

  useEffect(() => {
    if (!open || !target) return;
    setIntent(target.retire ? 'retire' : 'revise');
    form.setFieldsValue({ text: target.text ?? '' });
  }, [open, target, form]);

  if (!target) return null;
  const typeLabel = { fact: '长期记忆', context: '短期记忆', experience: '执行经验', action: '待办' }[target.type] ?? target.type;

  const submit = async () => {
    const values = await form.validateFields();
    const retire = intent === 'retire';
    setBusy(true);
    try {
      const { preview, execute } = await previewRevision(target.previewRoute, {
        ...target.payload,
        text: retire ? undefined : values.text,
        retire,
        expectedEvent: target.eventId,
      });
      Modal.confirm({
        title: retire ? `停用${typeLabel}` : `修正${typeLabel}`,
        content: (
          <div>
            <Alert type={retire ? 'warning' : 'info'} showIcon message={preview.plan.summary} style={{ marginBottom: 10 }} />
            <div className="muted">
              将追加一条新的不可变事件并用它替代当前值；原记录仍保留在事件流中，可追溯。
            </div>
          </div>
        ),
        okText: retire ? '确认停用' : '确认修正',
        cancelText: '取消',
        okButtonProps: { danger: retire },
        onOk: async () => {
          await execute();
          message.success(retire ? '已停用' : '已修正');
          onSaved?.();
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
      title={`${intent === 'retire' ? '停用' : '修正'}${typeLabel}`}
      onCancel={onClose}
      onOk={submit}
      okText={intent === 'retire' ? '停用' : '预览修正'}
      cancelText="取消"
      confirmLoading={busy}
      width={620}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="不会修改或删除原记录。保存时会追加一条新事件，并用它覆盖当前值。"
      />
      <Form form={form} layout="vertical">
        <Form.Item label="操作" name="intent">
          <Radio.Group value={intent} onChange={(e) => setIntent(e.target.value)} optionType="button">
            <Radio.Button value="revise">修正内容</Radio.Button>
            <Radio.Button value="retire">停用（从当前视图移除）</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {intent === 'revise' ? (
          <Form.Item label="新的内容" name="text" rules={[{ required: true, message: '请输入新内容' }]}>
            <Input.TextArea rows={4} placeholder="修订后的结论" />
          </Form.Item>
        ) : (
          <Alert type="warning" showIcon message="停用后该记录不再出现在当前视图，历史与来源事件仍然保留。" />
        )}
      </Form>
    </Modal>
  );
}