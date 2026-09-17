import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Form, Select, Input, InputNumber, Radio, Alert, App as AntApp } from 'antd';
import { getComposeOptions, postWrite } from '../lib/api.js';
import { useI18n } from '../i18n/index.jsx';

// Composer for brand-new memory records. It never writes on its own: it first asks
// the server for a validated plan, shows exactly what event will be appended, and
// only then executes. Evidence is mandatory because every event must cite a source.
export default function ComposeModal({ open, onClose, onCreated }) {
  const { t } = useI18n();
  const { message } = AntApp.useApp();
  const KIND_OPTIONS = [
    { value: 'fact', label: t('search.kind.fact') },
    { value: 'action', label: t('kind.actions') },
    { value: 'context', label: t('search.kind.context') },
    { value: 'experience', label: t('search.kind.experience') },
  ];
  const [form] = Form.useForm();
  const [options, setOptions] = useState(null);
  const [kind, setKind] = useState('fact');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open && !options) {
      getComposeOptions().then(setOptions).catch((e) => message.error(e.message));
    }
  }, [open, options, message]);

  // The map parameter used to be named t, which is this codebase's name for the translator; it is
  // renamed here, and t joins the dependencies because the label is translated. The label also had
  // hardcoded full-width brackets, which neither i18n scan can see — brackets are not ideographs, and
  // a template literal is blanked out before the JSX scan runs — but which look wrong in English.
  const topicOptions = useMemo(() => (options?.topics ?? []).map((topic) => ({
    value: topic.id, label: t('compose.topicLabel', { title: topic.title, id: topic.id }),
  })), [options, t]);

  const evidenceOptions = useMemo(() => (options?.evidence ?? []).map((e) => ({
    value: e.path, label: e.path,
  })), [options]);

  const submit = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const preview = await postWrite('compose-event/preview', { ...values, kind });
      Modal.confirm({
        title: t('compose.confirmTitle'),
        content: (
          <div>
            <Alert type="info" showIcon message={preview.plan.summary} style={{ marginBottom: 10 }} />
            <div className="muted">{t('compose.appendNote')}</div>
          </div>
        ),
        okText: t('compose.confirmOk'),
        cancelText: t('decision.cancel'),
        onOk: async () => {
          await postWrite('execute', {
            action: 'compose-event',
            plan: preview.plan,
            fingerprint: preview.fingerprint,
            token: preview.token,
          });
          message.success(t('compose.created'));
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
      title={t('shell.newMemory')}
      onCancel={onClose}
      onOk={submit}
      okText={t('compose.previewOk')}
      cancelText={t('decision.cancel')}
      confirmLoading={busy}
      width={620}
      destroyOnClose
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 14 }}
        message={t('compose.notice')}
      />
      <Form form={form} layout="vertical" initialValues={{ kind: 'fact', ttlDays: 7, certainty: 'reported' }}>
        <Form.Item label={t('field.kind')} name="kind" required>
          <Radio.Group options={KIND_OPTIONS} onChange={(e) => setKind(e.target.value)} optionType="button" />
        </Form.Item>
        <Form.Item label={t('col.topic')} name="topic" rules={[{ required: true, message: t('compose.topicRequired') }]}>
          <Select
            showSearch
            placeholder={t('compose.topicPlaceholder')}
            options={topicOptions}
            loading={!options}
            optionFilterProp="label"
          />
        </Form.Item>

        {(kind === 'fact') && (
          <Form.Item label={t('compose.factKey')} name="key" rules={[{ required: true, message: t('compose.factKeyRequired') }]}
            extra={t('compose.factKeyExtra')}>
            <Input placeholder="stable-key" />
          </Form.Item>
        )}
        {(kind === 'action') && (
          <Form.Item label={t('compose.actionId')} name="key" extra={t('compose.actionIdExtra')}>
            <Input placeholder="todo-id" />
          </Form.Item>
        )}
        {kind === 'context' && (
          <>
            <Form.Item label={t('compose.task')} name="task" rules={[{ required: true, message: t('compose.taskRequired') }]}>
              <Input placeholder={t('compose.taskPlaceholder')} />
            </Form.Item>
            <Form.Item label={t('compose.ttl')} name="ttlDays">
              <InputNumber min={1} max={90} />
            </Form.Item>
            <Form.Item label={t('compose.certainty')} name="certainty">
              <Radio.Group optionType="button">
                <Radio.Button value="reported">reported</Radio.Button>
                <Radio.Button value="verified">verified</Radio.Button>
              </Radio.Group>
            </Form.Item>
          </>
        )}
        {kind === 'experience' && (
          <>
            <Form.Item label={t('compose.triggers')} name="triggers" rules={[{ required: true, message: t('compose.triggersRequired') }]}
              extra={t('compose.triggersExtra')}>
              <Input placeholder="trigger-a, trigger-b" />
            </Form.Item>
            <Form.Item label={t('compose.verification')} name="verification" rules={[{ required: true, message: t('compose.verificationRequired') }]}>
              <Input placeholder={t('compose.verificationPlaceholder')} />
            </Form.Item>
            <Form.Item label={t('compose.experienceScope')} name="scope">
              <Radio.Group optionType="button" defaultValue="path-finding">
                <Radio.Button value="path-finding">{t('compose.pathFinding')}</Radio.Button>
                <Radio.Button value="negative-search">{t('compose.negativeSearch')}</Radio.Button>
              </Radio.Group>
            </Form.Item>
          </>
        )}

        <Form.Item label={t('field.text')} name="text" rules={[{ required: true, message: t('compose.textRequired') }]}>
          <Input.TextArea rows={3} placeholder={t('compose.textPlaceholder')} />
        </Form.Item>
        <Form.Item label={t('compose.evidence')} name="evidence" rules={[{ required: true, message: t('compose.evidenceRequired') }]}
          extra={t('compose.evidenceExtra')}>
          <Select
            mode="multiple"
            showSearch
            placeholder={t('compose.evidencePlaceholder')}
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
