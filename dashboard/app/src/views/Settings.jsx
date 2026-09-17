import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Col, Descriptions, Divider, Empty, Form, Input, InputNumber,
  Modal, Row, Select, Space, Tag, Typography,
} from 'antd';
import { CheckCircleOutlined, ReloadOutlined, SaveOutlined, WarningOutlined } from '@ant-design/icons';
import DataTable from '../components/DataTable.jsx';
import DecisionModal from '../components/DecisionModal.jsx';
import Markdown from '../components/Markdown.jsx';
import PageSkeleton from '../components/PageSkeleton.jsx';
import { getSettings, postWrite } from '../lib/api.js';
import { useI18n } from '../i18n/index.jsx';

const { Text } = Typography;

// 设置页 = 这一份 config.json 的编辑器。产品不是桌面应用，所有配置都在这一个 JSON 文件里，
// 页面只做三件事：
//   1. 读出当前配置、配置文件的绝对路径，以及这些路径此刻是否可用；
//   2. 编辑三组字段（存储 / 布局 / 检索与注入参数），保存走「预览 → 签名令牌 → 执行」；
//   3. 只读展示宿主绑定状态与 Obsidian 检测结果，并说明写入后哪些进程需要重启。
// 宿主绑定要改写其他应用的配置文件，所以这里只给命令、不执行；也不会自动重启任何进程。

// The guide is a function of the translator rather than a constant: it is Markdown prose rendered by
// a component, and it stays module-level because the component only consumes it.
const obsidianGuide = (t) => [
  t('settings.guide.optional'),
  '',
  t('settings.guide.intro'),
  '',
  t('settings.guide.step1'),
  t('settings.guide.step2'),
  t('settings.guide.step3'),
  t('settings.guide.step4'),
].join('\n');

// The translator is passed in because this is a plain function, not a component, and so has no hook.
function bindingTag(binding, t) {
  if (!binding || !binding.files?.length) return <Tag>{t('settings.binding.none')}</Tag>;
  if (binding.present) return <Tag color="green">{t('settings.binding.bound')}</Tag>;
  if (binding.unknown) return <Tag color="orange">{t('settings.binding.unknown')}</Tag>;
  return <Tag color="red">{t('settings.binding.unbound')}</Tag>;
}

function bindingPaths(host, t) {
  const files = [...(host.mcp?.files ?? []), ...(host.hooks?.files ?? [])];
  const paths = [...new Set(files.map((row) => row.path))];
  return paths.length ? paths.join(t('settings.listSep')) : host.dir;
}

// 写入后的重启须知：常驻的 MCP 服务进程只在启动时读一次配置，CLI 与 hook runner 每次调用
// 都会重新读，所以只有宿主里常驻的那个进程需要重启，页面不会替你重启。
function RestartNotice({ restart }) {
  const { t, shared } = useI18n();
  if (!restart) return null;
  return (
    <div>
      <Alert type="warning" showIcon message={t('settings.restartNotice')} description={shared(restart.reason)} />
      <ul className="settings-restart-list">
        {restart.processes.map((row) => <li key={row.id}><b>{row.label}</b>{t('punct.labelSeparator')}{shared(row.service)}</li>)}
      </ul>
      <div>
        <span className="muted">{t('settings.recheckBinding')}</span>{' '}
        <Text className="mono" copyable={{ text: restart.command }}>{restart.command}</Text>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>{shared(restart.commandHint)}</div>
      <div className="muted" style={{ marginTop: 6 }}>
        {t('settings.restartExplainer')}
      </div>
    </div>
  );
}

function ObsidianGuide({ obsidian }) {
  const { t, shared } = useI18n();
  if (!obsidian) return null;
  const rows = obsidian.detected ?? [];
  const found = rows.filter((row) => row.exists);
  return (
    <div>
      <Alert
        type={obsidian.installed ? 'success' : 'info'}
        showIcon
        message={obsidian.installed ? t('settings.detected') : t('settings.notDetected')}
        description={(
          <div>
            <div>
              {obsidian.installed
                ? t('settings.detectCaveat')
                : t('settings.detectNoImpact')}
            </div>
            {!!found.length && (
              <ul className="settings-paths">
                {found.map((row) => (
                  <li key={row.path}>
                    <Tag color="green">{t('settings.exists')}</Tag>
                    <span className="muted">{shared(row.label)}</span>{' '}
                    <Text className="mono" type="secondary">{row.path}</Text>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      />
      <div style={{ marginTop: 10 }}>
        <Markdown>{obsidianGuide(t)}</Markdown>
      </div>
      <details className="settings-details">
        <summary className="muted">{t('settings.detectedPaths', { n: rows.length })}</summary>
        <ul className="settings-paths">
          {rows.map((row) => (
            <li key={row.path}>
              <Tag color={row.exists ? 'green' : 'default'}>{row.exists ? t('settings.exists') : t('settings.notFound')}</Tag>
              <span className="muted">{shared(row.label)}</span>{' '}
              <Text className="mono" type="secondary">{row.path}</Text>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// 每个可编辑字段「值从哪来」。上面表单里显示的是程序此刻解析出来的生效值，这一块回答的是**为什么是它** ——
// 你写在 config.json 里的，还是程序回退的。只有来源是「默认回退」的字段，改动才会真正改变行为；
// 来源由后端 provenance 给出，页面不自己判断，也不在这里编造默认值（若干回退是散文式描述而非单一字面量，
// 在下游再写一份数字就会和校验器形成第二个真相源）。
function ProvenanceList({ settings }) {
  const { t, shared } = useI18n();
  const provenance = settings?.provenance;
  if (!provenance) return null;
  const rows = [
    ...['storage', 'memoryRoot', 'vaultRoot', 'vaultName', 'obsidianCli', 'layout'].map((key) => [key, key]),
    ...(settings.numberFields ?? []).map((field) => [field.key, t('settings.fieldLabel', { key: field.key, label: shared(field.label) })]),
    ...(settings.roleFields ?? []).map((field) => [`roles.${field.key}`, t('settings.fieldLabel', { key: field.key, label: shared(field.label) })]),
  ];
  const valueOf = (key) => (key.startsWith('roles.')
    ? settings.groups?.roles?.[key.slice('roles.'.length)]
    : settings.groups?.[key]);
  return (
    <div>
      <div className="muted">
        {t('settings.provIntro1')}
        <b>{t('settings.provFromFile')}</b>
        {t('settings.provIntro2')}
        <b>{t('settings.provFromDefault')}</b>
        {t('settings.provIntro3')}
      </div>
      <ul className="settings-paths" style={{ marginTop: 8 }}>
        {rows.map(([key, label]) => (
          <li key={key}>
            <Tag color={provenance[key] === 'config-file' ? 'blue' : 'default'}>
              {provenance[key] === 'config-file' ? t('settings.provFromFile') : t('settings.provFromDefault')}
            </Tag>
            <span className="mono">{label}</span>
            <span className="muted"> = {String(valueOf(key) ?? '')}</span>
          </li>
        ))}
      </ul>
      <div className="muted" style={{ marginTop: 8 }}>
        {t('settings.provReadOnly')}
        <span className="mono">topics</span>
        {t('settings.provListSep')}
        <span className="mono"> collection</span>
        {t('settings.provListSep')}
        <span className="mono">workspaceAliases</span>
        {t('settings.provReadOnlyTail', { title: t('settings.unchangedKeysTitle') })}
      </div>
    </div>
  );
}

// 采集策略是**只读展示**：关闭采集会影响 hook、ingest 与访问日志，所以这一页报告「现在生效的是什么、
// 由哪一层决定的」，而不是给一个看起来像开关、实际只管渲染的控件。数据来自后端的 privacyView()，
// 与 `memkeel privacy show` 打印的是同一个函数，两边不可能说法不一致。
function CollectionPolicy({ collection }) {
  const { t, shared } = useI18n();
  if (!collection) return null;
  const decision = collection.decision ?? {};
  const scopes = collection.scopes ?? {};
  const hosts = scopes.hosts ?? [];
  const workspaces = scopes.workspaces ?? [];
  const exclusions = scopes.exclusions ?? [];
  const scoped = collection.context?.scoped === true;
  const stateTag = (state) => (
    <Tag color={state === 'off' ? 'red' : 'green'}>{state === 'off' ? t('settings.coll.off') : t('settings.coll.on')}</Tag>
  );
  return (
    <div>
      <Alert
        type={decision.collecting ? 'success' : 'warning'}
        showIcon
        message={scoped
          ? (decision.collecting ? t('settings.coll.scopedOn') : t('settings.coll.scopedOff'))
          : (decision.collecting ? t('settings.coll.defaultOn') : t('settings.coll.defaultOff'))}
        description={(
          <div>
            <div>{shared(decision.reason)}</div>
            <div className="muted" style={{ marginTop: 4 }}>
              {t('settings.coll.decidedBy', { layer: decision.decidedBy })}
            </div>
            {!scoped && (
              <div className="muted" style={{ marginTop: 4 }}>
                {t('settings.coll.noContext')}
              </div>
            )}
          </div>
        )}
      />
      <Descriptions
        column={1}
        size="small"
        style={{ marginTop: 10 }}
        items={[
          { key: 'global', label: t('settings.coll.global'), children: stateTag(scopes.global) },
          {
            key: 'hosts',
            label: t('settings.coll.hostLevel'),
            children: hosts.length
              ? hosts.map((row) => <Tag key={row.host} color={row.state === 'off' ? 'red' : 'green'}>{row.host}{t('punct.labelSeparator')}{row.state === 'off' ? t('settings.coll.off') : t('settings.coll.on')}</Tag>)
              : <span className="muted">{t('settings.coll.notSet')}</span>,
          },
          {
            key: 'workspaces',
            label: t('settings.coll.workspaceLevel'),
            children: workspaces.length
              ? workspaces.map((row) => <Tag key={row.workspace} color={row.state === 'off' ? 'red' : 'green'}>{row.workspace}{t('punct.labelSeparator')}{row.state === 'off' ? t('settings.coll.off') : t('settings.coll.on')}</Tag>)
              : <span className="muted">{t('settings.coll.notSet')}</span>,
          },
          {
            key: 'exclusions',
            label: t('settings.coll.exclusions'),
            children: exclusions.length
              ? exclusions.map((row) => <div key={`${row.kind}:${row.rule}`} className="mono">{row.kind} = {row.rule}</div>)
              : <span className="muted">{t('settings.coll.none')}</span>,
          },
        ]}
      />
      <Divider plain style={{ margin: '10px 0' }}>{t('settings.coll.deleteDivider')}</Divider>
      <ul className="settings-paths">
        {shared(collection.vocabulary ?? []).map((row) => (
          <li key={row.state}>
            <Tag color={row.supported ? 'green' : 'default'}>{row.supported ? t('settings.coll.provided') : t('settings.coll.notProvided')}</Tag>
            <b>{row.label}</b>{t('punct.labelSeparator')}{row.meaning}
          </li>
        ))}
      </ul>
      <div className="muted" style={{ marginTop: 8 }}>{shared(collection.permanentDeletion)}</div>
      <div className="muted" style={{ marginTop: 8 }}>
        {t('settings.coll.readOnlyNote1')}
        <Text className="mono">collection</Text>
        {t('settings.coll.readOnlyNote2')}
        <Text className="mono">memkeel privacy show</Text>
        {t('settings.coll.readOnlyNote3')}
        <Text className="mono">memkeel privacy export --out FILE</Text>
        {t('settings.coll.readOnlyNote4')}
      </div>
    </div>
  );
}

export default function Settings({ reload }) {
  const { t } = useI18n();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSettings();
      setSettings(data);
      // 表单回填的就是程序现在解析出来的值，不另外发明默认值。
      form.setFieldsValue({
        storage: data.groups.storage,
        memoryRoot: data.groups.memoryRoot,
        vaultRoot: data.groups.vaultRoot,
        vaultName: data.groups.vaultName,
        obsidianCli: data.groups.obsidianCli,
        layout: data.groups.layout,
        roles: { ...data.groups.roles },
        activeLimit: data.groups.activeLimit,
        recentLimit: data.groups.recentLimit,
        recentDays: data.groups.recentDays,
        budgetBytes: data.groups.budgetBytes,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => { load(); }, [load]);

  const submit = async (values) => {
    setBusy(true);
    try {
      const preview = await postWrite('update-config/preview', {
        ...values,
        roles: values.roles ?? {},
      });
      setDecision({
        title: t('settings.saveTitle'),
        summary: preview.plan.summary,
        changes: preview.plan.changes,
        okText: t('settings.confirmWrite'),
        onConfirm: async () => {
          const result = await postWrite('execute', {
            action: 'update-config',
            plan: preview.plan,
            fingerprint: preview.fingerprint,
            token: preview.token,
          });
          message.success(t('settings.written'));
          await load();
          reload?.();
          if (result?.restartRequired) {
            Modal.info({
              title: t('settings.writtenRestart'),
              width: 640,
              okText: t('settings.acknowledge'),
              content: <RestartNotice restart={settings?.restart} />,
            });
          }
          return result;
        },
      });
    } catch (e) {
      // A refusal carries the issues it was built from as well as a sentence; those render in the
      // reader's language, which the server cannot choose on the page's behalf.
      const issues = Array.isArray(e.issues) ? shared(e.issues) : [];
      message.error(issues.length ? <>{issues.map((line, i) => <div key={i}>{line}</div>)}</> : shared(e.message));
    } finally {
      setBusy(false);
    }
  };

  if (loading && !settings) return <PageSkeleton />;
  if (error && !settings) {
    return (
      <div className="center-box">
        <Empty description={t('settings.loadFailed', { error })} />
        <div className="muted" style={{ marginTop: 10, maxWidth: 620, textAlign: 'center' }}>
          {t('settings.loadFailedHint')}
        </div>
        <Button type="primary" icon={<ReloadOutlined />} onClick={load} style={{ marginTop: 16 }}>{t('shell.retry')}</Button>
      </div>
    );
  }

  const validation = settings.validation ?? { ok: true, issues: [], notes: [] };
  const hostColumns = [
    { title: t('settings.host.col.host'), dataIndex: 'label', width: 140 },
    {
      title: t('settings.host.col.installed'),
      dataIndex: 'installed',
      width: 110,
      render: (value) => (value ? <Tag color="green">{t('settings.host.installed')}</Tag> : <Tag>{t('settings.host.notDetected')}</Tag>),
    },
    { title: t('settings.host.col.mcp'), key: 'mcp', width: 170, render: (_value, row) => bindingTag(row.mcp, t) },
    { title: t('settings.host.col.hooks'), key: 'hooks', width: 170, render: (_value, row) => bindingTag(row.hooks, t) },
    {
      title: t('settings.host.col.files'),
      dataIndex: 'dir',
      render: (_value, row) => <span className="mono muted">{bindingPaths(row, t)}</span>,
    },
  ];

  return (
    <Form form={form} layout="vertical" onFinish={submit} requiredMark>
      {!settings.exists && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <h3 className="panel-title">{t('settings.firstRun.title')}</h3>
          <div>
            <Alert
              type="info"
              showIcon
              message={t('settings.firstRun.alert')}
              description={(
                <div>
                  <div style={{ marginTop: 4 }}>
                    <b>{t('settings.firstRun.homeTitle')}</b>{t('punct.labelSeparator')}<span className="mono">config.json</span>{t('settings.firstRun.homeBody')}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <b>{t('settings.firstRun.storeTitle')}</b>{t('punct.labelSeparator')}{t('settings.firstRun.storeBody')}
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    {t('settings.firstRun.why')}
                  </div>
                </div>
              )}
            />
            <Divider plain style={{ margin: '12px 0' }}>{t('settings.firstRun.order')}</Divider>
            <ol className="settings-paths">
              <li>
                <b>{t('settings.firstRun.step1Title')}</b>{t('punct.labelSeparator')}{t('settings.firstRun.step1a')}
                <span className="mono"> config.json</span>{t('settings.firstRun.step1b')}<span className="mono">{t('settings.firstRun.initCmd')}</span>{t('settings.firstRun.step1c')}
              </li>
              <li>
                <b>{t('settings.firstRun.step2Title')}</b>{t('punct.labelSeparator')}{t('settings.firstRun.step2')}
              </li>
              <li>
                <b>{t('settings.firstRun.step3Title')}</b>{t('punct.labelSeparator')}{t('settings.firstRun.step3')}<Text className="mono" copyable={{ text: settings.setup?.dryRun ?? '' }}>{settings.setup?.dryRun}</Text>
              </li>
              <li>
                <b>{t('settings.firstRun.step4Title')}</b>{t('punct.labelSeparator')}{t('settings.firstRun.step4a')}<Text className="mono" copyable={{ text: settings.setup?.check ?? '' }}>{settings.setup?.check}</Text>{t('settings.firstRun.step4b')}<span className="mono">memkeel doctor</span>{t('settings.firstRun.step4c')}
              </li>
            </ol>
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 10 }}
              message={t('settings.firstRun.noWrite')}
              description={t('settings.firstRun.manual')}
            />
          </div>
        </div>
      )}
      <div className="panel">
        <h3 className="panel-title">{t('settings.config.title')}</h3>
        <div>
          <Descriptions
            column={1}
            size="small"
            items={[
              {
                key: 'path',
                label: t('settings.config.path'),
                children: (
                  <Text className="mono" copyable={{ text: settings.configPath }}>{settings.configPath}</Text>
                ),
              },
              {
                key: 'exists',
                label: t('settings.config.status'),
                children: settings.exists
                  ? <Tag color="green">{t('settings.config.exists')}</Tag>
                  : <Tag color="red">{t('settings.config.missing')}</Tag>,
              },
              {
                key: 'state',
                label: t('settings.config.validation'),
                children: validation.ok
                  ? <Tag icon={<CheckCircleOutlined />} color="green">{t('settings.config.passed')}</Tag>
                  : <Tag icon={<WarningOutlined />} color="red">{t('settings.config.issues', { n: validation.issues.length })}</Tag>,
              },
              {
                key: 'preserved',
                label: t('settings.unchangedKeysTitle'),
                children: settings.preservedKeys?.length
                  ? <span className="mono muted">{settings.preservedKeys.join(t('settings.listSep'))}</span>
                  : <span className="muted">{t('settings.config.none')}</span>,
              },
            ]}
          />
          {!settings.readable && (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 10 }}
              message={t('settings.config.readFailed')}
              description={settings.readError}
            />
          )}
          {!validation.ok && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 10 }}
              message={t('settings.config.invalid')}
              description={(
                <ul className="settings-paths">
                  {shared(validation.issues ?? []).map((row) => <li key={`${row.field}:${row.message}`}>{row.message}</li>)}
                </ul>
              )}
            />
          )}
          {!!validation.notes?.length && (
            <div className="muted" style={{ marginTop: 8 }}>{shared(validation.notes ?? []).join(' ')}</div>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">{t('settings.storage.title')}</h3>
        <div>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="storage"
                label={t('settings.storage.backend')}
                rules={[{ required: true, message: t('settings.storage.choose') }]}
                extra={t('settings.storage.extra')}
              >
                <Select options={shared(settings.storageOptions ?? [])} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="memoryRoot"
                label={t('settings.storage.memoryRoot')}
                rules={[{ required: true, message: t('settings.storage.memoryRootRequired') }]}
                extra={t('settings.storage.memoryRootExtra')}
              >
                <Input className="mono" placeholder="C:/Users/<you>/agent-memory" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="vaultRoot"
                label={t('settings.storage.vaultRoot')}
                rules={[{ required: true, message: t('settings.storage.vaultRootRequired') }]}
                extra={t('settings.storage.vaultRootExtra')}
              >
                <Input className="mono" placeholder="C:/Users/<you>/agent-memory" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="vaultName" label={t('settings.storage.vaultName')} extra={t('settings.storage.vaultNameExtra')}>
                <Input placeholder="my-vault" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="obsidianCli" label={t('settings.storage.cli')} extra={t('settings.storage.cliExtra')}>
                <Input className="mono" placeholder="C:/Users/<you>/bin/obsidian.exe" />
              </Form.Item>
            </Col>
          </Row>
          <Divider plain style={{ margin: '4px 0 12px' }}>{t('settings.storage.obsidianDivider')}</Divider>
          <ObsidianGuide obsidian={settings.obsidian} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">{t('settings.layout.title')}</h3>
        <div>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                name="layout"
                label={t('settings.layout.label')}
                rules={[{ required: true, message: t('settings.layout.choose') }]}
                extra={t('settings.layout.extra')}
              >
                <Select options={shared(settings.layoutOptions ?? [])} />
              </Form.Item>
            </Col>
            {shared(settings.roleFields ?? []).map(({ key, label }) => (
              <Col span={8} key={key}>
                <Form.Item
                  name={['roles', key]}
                  label={t('settings.fieldLabel', { key, label })}
                  rules={[{ required: true, message: t('settings.form.required', { key }) }]}
                >
                  <Input className="mono" />
                </Form.Item>
              </Col>
            ))}
          </Row>
          <div className="muted">{t('settings.layout.insideRoot')}</div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">{t('settings.params.title')}</h3>
        <div>
          <Row gutter={16}>
            {shared(settings.numberFields ?? []).map((field) => (
              <Col span={6} key={field.key}>
                <Form.Item
                  name={field.key}
                  label={t('settings.fieldLabel', { key: field.key, label: field.label })}
                  extra={field.hint}
                  rules={[{ required: true, message: t('settings.form.required', { key: field.key }) }]}
                >
                  <InputNumber
                    min={field.min}
                    max={field.max}
                    precision={0}
                    style={{ width: '100%' }}
                    placeholder={`${field.min} – ${field.max}`}
                  />
                </Form.Item>
              </Col>
            ))}
          </Row>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">{t('settings.provenance.title')}</h3>
        <div>
          <ProvenanceList settings={settings} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">{t('settings.collection.title')}</h3>
        <div>
          <CollectionPolicy collection={settings.collection} />
        </div>
      </div>

      <div className="settings-actions">
        <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={busy}>{t('settings.actions.preview')}</Button>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>{t('settings.actions.reload')}</Button>
        <span className="muted">{t('settings.actions.hint')}</span>
      </div>

      <div className="panel">
        <h3 className="panel-title">{t('settings.hosts.title')}</h3>
        <div>
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message={shared(settings.setup.note)} />
          <DataTable
            columns={hostColumns}
            data={settings.hostBindings ?? []}
            rowKey="id"
            searchable={false}
            pageSize={10}
            scrollY={240}
          />
          <Divider plain style={{ margin: '12px 0' }}>{t('settings.hosts.commands')}</Divider>
          <Space direction="vertical" size={4}>
            <div>
              <span className="muted">{t('settings.hosts.bind')}</span>{' '}
              <Text className="mono" copyable={{ text: settings.setup.apply }}>{settings.setup.apply}</Text>{' '}
              <span className="muted">{t('settings.hosts.checkoutFallback', { path: settings.setup.checkoutFallback })}</span>
            </div>
            <div>
              <span className="muted">{t('settings.hosts.review')}</span>{' '}
              <Text className="mono" copyable={{ text: settings.setup.check }}>{settings.setup.check}</Text>
            </div>
            <div>
              <span className="muted">{t('settings.hosts.dryRun')}</span>{' '}
              <Text className="mono" copyable={{ text: settings.setup.dryRun }}>{settings.setup.dryRun}</Text>
            </div>
          </Space>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">{t('settings.restart.title')}</h3>
        <div>
          <RestartNotice restart={settings.restart} />
        </div>
      </div>

      <DecisionModal decision={decision} onClose={() => setDecision(null)} />
    </Form>
  );
}
