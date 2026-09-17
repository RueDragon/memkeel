import React, { useState } from 'react';
import { Modal, Input, Alert, Typography, Button, App as AntApp } from 'antd';
import { useI18n } from '../i18n/index.jsx';

// Confirmation modal for every write. A raw plan (one status transition plus "a quote is
// required") is meaningless to a person, so the modal answers three questions in order:
// what am I deciding on, what happens if I confirm, and what do I have to supply. The
// preview/execute contract stays visible — nothing runs until this dialog is confirmed.
//
// The field and value labels are built inside the component because they are translated, and the
// enum values they replace are the store's own vocabulary, not interface text.
function Section({ title, hint, children }) {
  return (
    <section className="decision-section">
      <div className="decision-section-title">{title}</div>
      {hint && <div className="decision-section-hint">{hint}</div>}
      {children}
    </section>
  );
}

export default function DecisionModal({ decision, onClose }) {
  const { t } = useI18n();
  const { message } = AntApp.useApp();
  const [quote, setQuote] = useState('');
  const [busy, setBusy] = useState(false);

  const FIELD_LABEL = {
    status: t('field.status'), text: t('field.text'), scope: t('field.scope'), kind: t('field.kind'),
    ttl_days: t('field.ttlDays'), decision: t('field.decision'), lifecycle: t('field.lifecycle'),
  };
  const VALUE_LABEL = {
    open: t('value.open'), done: t('value.done'), active: t('value.active'), closed: t('value.closed'),
    candidate: t('value.candidate'), probationary: t('value.probationary'),
    confirmed: t('value.confirmed'), rejected: t('value.rejected'),
  };
  const humanValue = (value) => VALUE_LABEL[String(value)] ?? String(value ?? '—');

  if (!decision) return null;
  const needsQuote = !!decision.needsQuote;
  const evidence = decision.evidence ?? null;
  const quotes = Array.isArray(evidence?.quotes) ? evidence.quotes : [];
  const filled = quote.trim().length;
  const canSubmit = !needsQuote || filled >= 4;

  const submit = async () => {
    setBusy(true);
    try {
      await decision.onConfirm(needsQuote ? quote.trim() : undefined);
      onClose();
    } catch (e) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      width={660}
      title={decision.title ?? t('decision.confirmTitle')}
      onCancel={() => { setQuote(''); onClose(); }}
      onOk={submit}
      okText={decision.okText ?? t('decision.confirmOk')}
      cancelText={t('decision.cancel')}
      confirmLoading={busy}
      okButtonProps={{ disabled: !canSubmit, danger: !!decision.okDanger }}
      destroyOnClose
    >
      {decision.summary && <Alert type="info" showIcon message={decision.summary} style={{ marginBottom: 14 }} />}

      {decision.subject?.text && (
        <Section title={t('decision.subject')}>
          <div className="decision-subject">{decision.subject.text}</div>
          {!!decision.subject.meta?.length && (
            <div className="decision-meta">
              {decision.subject.meta.map(([key, value]) => (
                <span className="decision-meta-item" key={key}><span className="muted">{key}</span> {value}</span>
              ))}
            </div>
          )}
        </Section>
      )}

      {!!decision.effects?.length && (
        <Section title={t('decision.effects')}>
          <ul className="decision-effects">
            {decision.effects.map((text, i) => <li key={i}>{text}</li>)}
          </ul>
        </Section>
      )}

      {!!decision.changes?.length && (
        <Section title={t('decision.changes')}>
          <ul className="decision-changes">
            {decision.changes.map((change, i) => (
              <li key={i} className="mono">
                {FIELD_LABEL[change.field] ?? change.field}{t('punct.labelSeparator')}{humanValue(change.from)} → {humanValue(change.to)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {needsQuote && (
        <Section
          title={t('decision.quoteTitle')}
          hint={t('decision.quoteHint')}
        >
          {quotes.length > 0 && (
            <>
              <div className="decision-section-hint">{t('decision.quoteFound')}</div>
              <div className="decision-quotes">
                {quotes.map((text) => (
                  <Button
                    key={text}
                    size="small"
                    className="decision-quote"
                    title={text}
                    onClick={() => setQuote(text)}
                  >
                    {text.length > 44 ? `${text.slice(0, 44)}…` : text}
                  </Button>
                ))}
              </div>
            </>
          )}
          {!quotes.length && evidence?.path && (
            <div className="decision-section-hint">
              {t('decision.quoteNotFound')}
            </div>
          )}
          {!evidence?.path && (
            <div className="decision-section-hint">
              {t('decision.quoteMissingPath')}
            </div>
          )}

          {evidence?.path && (
            <div className="decision-evidence">
              <Typography.Text type="secondary" className="decision-evidence-path">
                {t('decision.evidencePath')}{evidence.path}{evidence.heading ? `#${evidence.heading}` : ''}
              </Typography.Text>
              {evidence.section
                ? <pre className="decision-evidence-body">{evidence.section}</pre>
                : <div className="muted">{t('decision.evidenceEmpty')}</div>}
            </div>
          )}

          <Input.TextArea
            rows={2}
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            placeholder={t('decision.quotePlaceholder')}
            style={{ marginTop: 8 }}
          />
          {!canSubmit && (
            <div className="decision-section-hint decision-section-hint--warn">
              {t('decision.quoteTooShort', { filled })}
            </div>
          )}
        </Section>
      )}
    </Modal>
  );
}
