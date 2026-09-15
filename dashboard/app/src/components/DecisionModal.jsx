import React, { useState } from 'react';
import { Modal, Input, Alert, Typography, Button, App as AntApp } from 'antd';

// Confirmation modal for every write. A raw plan (one status transition plus "a quote is
// required") is meaningless to a person, so the modal answers three questions in order:
// what am I deciding on, what happens if I confirm, and what do I have to supply. The
// preview/execute contract stays visible — nothing runs until this dialog is confirmed.
const FIELD_LABEL = {
  status: '状态', text: '内容', scope: '范围', kind: '类型', ttl_days: '保留天数',
  decision: '决定', lifecycle: '生命周期',
};

const VALUE_LABEL = {
  open: '未完成', done: '已完成', active: '进行中', closed: '已关闭',
  candidate: '候选', probationary: '试用中', confirmed: '已确认', rejected: '已拒绝',
};

const humanValue = (value) => VALUE_LABEL[String(value)] ?? String(value ?? '—');

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
  const { message } = AntApp.useApp();
  const [quote, setQuote] = useState('');
  const [busy, setBusy] = useState(false);

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
      title={decision.title ?? '确认操作'}
      onCancel={() => { setQuote(''); onClose(); }}
      onOk={submit}
      okText={decision.okText ?? '确认执行'}
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: !canSubmit, danger: !!decision.okDanger }}
      destroyOnClose
    >
      {decision.summary && <Alert type="info" showIcon message={decision.summary} style={{ marginBottom: 14 }} />}

      {decision.subject?.text && (
        <Section title="你要决定的对象">
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
        <Section title="确认后会发生什么">
          <ul className="decision-effects">
            {decision.effects.map((text, i) => <li key={i}>{text}</li>)}
          </ul>
        </Section>
      )}

      {!!decision.changes?.length && (
        <Section title="将写入的记录">
          <ul className="decision-changes">
            {decision.changes.map((change, i) => (
              <li key={i} className="mono">
                {FIELD_LABEL[change.field] ?? change.field}：{humanValue(change.from)} → {humanValue(change.to)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {needsQuote && (
        <Section
          title="需要你本人的原话"
          hint="系统只把你亲口说过的话当作授权：这句话必须逐字出现在下面的证据笔记里，服务端会逐字核对，对不上就拒绝（这是为了防止 agent 自己给自己授权）。"
        >
          {quotes.length > 0 && (
            <>
              <div className="decision-section-hint">证据笔记里找到这几句可以当授权的原话，点一下即填入：</div>
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
              没能从证据笔记里自动摘出原话，请打开下面这条笔记，复制你当时说过的那一句。
            </div>
          )}
          {!evidence?.path && (
            <div className="decision-section-hint">
              原话要逐字出现在该候选来源事件的证据笔记里；路径可在来源事件详情中查看（这条预览没带回来，通常是服务端还没重启）。
            </div>
          )}

          {evidence?.path && (
            <div className="decision-evidence">
              <Typography.Text type="secondary" className="decision-evidence-path">
                证据笔记：{evidence.path}{evidence.heading ? `#${evidence.heading}` : ''}
              </Typography.Text>
              {evidence.section
                ? <pre className="decision-evidence-body">{evidence.section}</pre>
                : <div className="muted">这条笔记里没有找到该来源事件的段落，请直接打开上面的笔记查找。</div>}
            </div>
          )}

          <Input.TextArea
            rows={2}
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            placeholder="点上面的一句，或原样粘贴你授权该偏好时说的话"
            style={{ marginTop: 8 }}
          />
          {!canSubmit && (
            <div className="decision-section-hint decision-section-hint--warn">
              还不能执行：至少需要 4 个字的原话（当前 {filled} 字）。
            </div>
          )}
        </Section>
      )}
    </Modal>
  );
}
