import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, Alert, Radio, App as AntApp } from 'antd';
import { previewRevision } from '../lib/api.js';
import { useI18n } from '../i18n/index.jsx';

// One editor for every memory type. It never edits Markdown or rewrites an event:
// it appends a superseding event. `mode` picks the preview route, and the retire
// option appends a replacement that marks the record inactive instead of deleting it.
//
// The original record is immutable, so the UI is explicit about that: the helper text
// states that history is preserved and that this creates a new revision.
export default function EditModal({ open, onClose, target, onSaved }) {
  const { t } = useI18n();
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
  // The four memory-type names are taken from the navigation catalogue rather than kept a second
  // time here, so a type is spelled the same way in the sidebar, the header and this dialog.
  const typeLabel = {
    fact: t('nav.facts.label'), context: t('nav.contexts.label'),
    experience: t('nav.experiences.label'), action: t('nav.actions.label'),
  }[target.type] ?? target.type;
  const retireVerb = t('action.retire');
  const reviseVerb = t('action.revise');

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
        title: `${retire ? retireVerb : reviseVerb}${typeLabel}`,
        content: (
          <div>
            <Alert type={retire ? 'warning' : 'info'} showIcon message={preview.plan.summary} style={{ marginBottom: 10 }} />
            <div className="muted">
              {t('edit.appendNote')}
            </div>
          </div>
        ),
        okText: retire ? t('edit.confirmRetire') : t('edit.confirmRevise'),
        cancelText: t('decision.cancel'),
        okButtonProps: { danger: retire },
        onOk: async () => {
          await execute();
          message.success(retire ? t('edit.retired') : t('edit.revised'));
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
      title={`${intent === 'retire' ? retireVerb : reviseVerb}${typeLabel}`}
      onCancel={onClose}
      onOk={submit}
      okText={intent === 'retire' ? retireVerb : t('edit.previewRevise')}
      cancelText={t('decision.cancel')}
      confirmLoading={busy}
      width={620}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message={t('edit.immutableNotice')}
      />
      <Form form={form} layout="vertical">
        <Form.Item label={t('col.ops')} name="intent">
          <Radio.Group value={intent} onChange={(e) => setIntent(e.target.value)} optionType="button">
            <Radio.Button value="revise">{t('edit.reviseContent')}</Radio.Button>
            <Radio.Button value="retire">{t('edit.retireOption')}</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {intent === 'revise' ? (
          <Form.Item label={t('edit.newContent')} name="text" rules={[{ required: true, message: t('edit.contentRequired') }]}>
            <Input.TextArea rows={4} placeholder={t('edit.contentPlaceholder')} />
          </Form.Item>
        ) : (
          <Alert type="warning" showIcon message={t('edit.retireNotice')} />
        )}
      </Form>
    </Modal>
  );
}
