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

const OBSIDIAN_GUIDE = [
  'Obsidian 是**可选**的：默认的 `filesystem` 后端直接把笔记写成文件，不需要 Obsidian 参与。',
  '',
  '想让 Obsidian 一起工作（CLI 读取与读回校验）时：',
  '',
  '1. 到[官方下载页](https://obsidian.md/download)安装 Obsidian —— 这里只会打开下载页，本页不会安装任何软件。',
  '2. 在 Obsidian 里新建或打开一个库（vault），记下库名。',
  '3. 装好 Obsidian CLI 后，把可执行文件的绝对路径填进 `obsidianCli`，库名填进 `vaultName`。',
  '4. 把「存储后端」改成 `obsidian-cli` 再保存；缺任一项都会被拒绝写入。',
].join('\n');

function bindingTag(binding) {
  if (!binding || !binding.files?.length) return <Tag>无配置文件</Tag>;
  if (binding.present) return <Tag color="green">已绑定</Tag>;
  if (binding.unknown) return <Tag color="orange">未知（文件过大，未读取）</Tag>;
  return <Tag color="red">未绑定</Tag>;
}

function bindingPaths(host) {
  const files = [...(host.mcp?.files ?? []), ...(host.hooks?.files ?? [])];
  const paths = [...new Set(files.map((row) => row.path))];
  return paths.length ? paths.join('、') : host.dir;
}

// 写入后的重启须知：常驻的 MCP 服务进程只在启动时读一次配置，CLI 与 hook runner 每次调用
// 都会重新读，所以只有宿主里常驻的那个进程需要重启，页面不会替你重启。
function RestartNotice({ restart }) {
  if (!restart) return null;
  return (
    <div>
      <Alert type="warning" showIcon message="写入配置后，这些常驻进程需要重启才会读到新配置" description={restart.reason} />
      <ul className="settings-restart-list">
        {restart.processes.map((row) => <li key={row.id}><b>{row.label}</b>：{row.service}</li>)}
      </ul>
      <div>
        <span className="muted">重启后再复核一次绑定：</span>{' '}
        <Text className="mono" copyable={{ text: restart.command }}>{restart.command}</Text>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>{restart.commandHint}</div>
      <div className="muted" style={{ marginTop: 6 }}>
        CLI 与 hook runner 每次调用都会重新读取配置，不需要重启；重启宿主由你自己决定，本页不会自动重启任何进程。
      </div>
    </div>
  );
}

function ObsidianGuide({ obsidian }) {
  if (!obsidian) return null;
  const rows = obsidian.detected ?? [];
  const found = rows.filter((row) => row.exists);
  return (
    <div>
      <Alert
        type={obsidian.installed ? 'success' : 'info'}
        showIcon
        message={obsidian.installed ? '检测到 Obsidian（或配置里的 obsidianCli）' : '没有检测到 Obsidian'}
        description={(
          <div>
            <div>
              {obsidian.installed
                ? '检测只说明“看起来装过”，不代表 CLI 一定能用；真要用 obsidian-cli 后端，请把 CLI 路径指准。'
                : '没有检测到也不影响使用：默认的文件系统后端完全不需要 Obsidian。想用再按下面的步骤装。'}
            </div>
            {!!found.length && (
              <ul className="settings-paths">
                {found.map((row) => (
                  <li key={row.path}>
                    <Tag color="green">存在</Tag>
                    <span className="muted">{row.label}</span>{' '}
                    <Text className="mono" type="secondary">{row.path}</Text>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      />
      <div style={{ marginTop: 10 }}>
        <Markdown>{OBSIDIAN_GUIDE}</Markdown>
      </div>
      <details className="settings-details">
        <summary className="muted">查看全部检测位置（{rows.length}）</summary>
        <ul className="settings-paths">
          {rows.map((row) => (
            <li key={row.path}>
              <Tag color={row.exists ? 'green' : 'default'}>{row.exists ? '存在' : '未找到'}</Tag>
              <span className="muted">{row.label}</span>{' '}
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
  const provenance = settings?.provenance;
  if (!provenance) return null;
  const rows = [
    ...['storage', 'memoryRoot', 'vaultRoot', 'vaultName', 'obsidianCli', 'layout'].map((key) => [key, key]),
    ...(settings.numberFields ?? []).map((field) => [field.key, `${field.key}（${field.label}）`]),
    ...(settings.roleFields ?? []).map((field) => [`roles.${field.key}`, `${field.key}（${field.label}）`]),
  ];
  const valueOf = (key) => (key.startsWith('roles.')
    ? settings.groups?.roles?.[key.slice('roles.'.length)]
    : settings.groups?.[key]);
  return (
    <div>
      <div className="muted">
        上面各字段显示的是程序此刻解析出来的生效值。下面标出每个值来自哪里：<b>文件设置</b> 表示
        config.json 里写了这一项，<b>默认回退</b> 表示文件没写、程序用了自己的选择。单位写在字段名后面。
      </div>
      <ul className="settings-paths" style={{ marginTop: 8 }}>
        {rows.map(([key, label]) => (
          <li key={key}>
            <Tag color={provenance[key] === 'config-file' ? 'blue' : 'default'}>
              {provenance[key] === 'config-file' ? '文件设置' : '默认回退'}
            </Tag>
            <span className="mono">{label}</span>
            <span className="muted"> = {String(valueOf(key) ?? '')}</span>
          </li>
        ))}
      </ul>
      <div className="muted" style={{ marginTop: 8 }}>
        这一块只读。没有列在这里的键（例如 <span className="mono">topics</span>、
        <span className="mono"> collection</span>、<span className="mono">workspaceAliases</span>）本页不改动，
        见上面的「本页不改动的键」。
      </div>
    </div>
  );
}

// 采集策略是**只读展示**：关闭采集会影响 hook、ingest 与访问日志，所以这一页报告「现在生效的是什么、
// 由哪一层决定的」，而不是给一个看起来像开关、实际只管渲染的控件。数据来自后端的 privacyView()，
// 与 `memkeel privacy show` 打印的是同一个函数，两边不可能说法不一致。
function CollectionPolicy({ collection }) {
  if (!collection) return null;
  const decision = collection.decision ?? {};
  const scopes = collection.scopes ?? {};
  const hosts = scopes.hosts ?? [];
  const workspaces = scopes.workspaces ?? [];
  const exclusions = scopes.exclusions ?? [];
  const scoped = collection.context?.scoped === true;
  const stateTag = (state) => (
    <Tag color={state === 'off' ? 'red' : 'green'}>{state === 'off' ? '关闭' : '开启'}</Tag>
  );
  return (
    <div>
      <Alert
        type={decision.collecting ? 'success' : 'warning'}
        showIcon
        message={scoped
          ? (decision.collecting ? '该上下文会被采集' : '该上下文不会被采集')
          : (decision.collecting ? '默认判定：采集' : '默认判定：不采集')}
        description={(
          <div>
            <div>{decision.reason}</div>
            <div className="muted" style={{ marginTop: 4 }}>
              由「{decision.decidedBy}」这一层决定。优先级只让采集变得更少：全局关闭是硬停，任何更窄的开关都不能把它重新打开。
            </div>
            {!scoped && (
              <div className="muted" style={{ marginTop: 4 }}>
                本页没有具体会话上下文，所以判定按「未指定宿主 / 工作区」计算；工作区级与宿主级的关闭只在对应上下文中生效，
                具体范围见下面的作用域列表。
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
          { key: 'global', label: '全局 enabled', children: stateTag(scopes.global) },
          {
            key: 'hosts',
            label: '宿主级',
            children: hosts.length
              ? hosts.map((row) => <Tag key={row.host} color={row.state === 'off' ? 'red' : 'green'}>{row.host}：{row.state === 'off' ? '关闭' : '开启'}</Tag>)
              : <span className="muted">未单独设置</span>,
          },
          {
            key: 'workspaces',
            label: '工作区级',
            children: workspaces.length
              ? workspaces.map((row) => <Tag key={row.workspace} color={row.state === 'off' ? 'red' : 'green'}>{row.workspace}：{row.state === 'off' ? '关闭' : '开启'}</Tag>)
              : <span className="muted">未单独设置</span>,
          },
          {
            key: 'exclusions',
            label: '排除规则',
            children: exclusions.length
              ? exclusions.map((row) => <div key={`${row.kind}:${row.rule}`} className="mono">{row.kind} = {row.rule}</div>)
              : <span className="muted">无</span>,
          },
        ]}
      />
      <Divider plain style={{ margin: '10px 0' }}>三种「删除」不是一回事</Divider>
      <ul className="settings-paths">
        {(collection.vocabulary ?? []).map((row) => (
          <li key={row.state}>
            <Tag color={row.supported ? 'green' : 'default'}>{row.supported ? '已提供' : '不提供'}</Tag>
            <b>{row.label}</b>：{row.meaning}
          </li>
        ))}
      </ul>
      <div className="muted" style={{ marginTop: 8 }}>{collection.permanentDeletion}</div>
      <div className="muted" style={{ marginTop: 8 }}>
        本页只展示、不修改采集开关。改完 <Text className="mono">collection</Text> 后可用{' '}
        <Text className="mono">memkeel privacy show</Text> 复核，或用{' '}
        <Text className="mono">memkeel privacy export --out FILE</Text> 导出一份脱敏诊断。
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
      message.error(e.message);
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
    { title: '宿主', dataIndex: 'label', width: 140 },
    {
      title: '安装',
      dataIndex: 'installed',
      width: 110,
      render: (value) => (value ? <Tag color="green">已安装</Tag> : <Tag>未检测到</Tag>),
    },
    { title: 'MCP 绑定', key: 'mcp', width: 170, render: (_value, row) => bindingTag(row.mcp) },
    { title: 'hooks 绑定', key: 'hooks', width: 170, render: (_value, row) => bindingTag(row.hooks) },
    {
      title: '相关配置文件',
      dataIndex: 'dir',
      render: (_value, row) => <span className="mono muted">{bindingPaths(row)}</span>,
    },
  ];

  return (
    <Form form={form} layout="vertical" onFinish={submit} requiredMark>
      {!settings.exists && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <h3 className="panel-title">第一次使用：先建立存储</h3>
          <div>
            <Alert
              type="info"
              showIcon
              message="这个程序把两样东西分开放在两个目录里，先分清它们，后面每一步都会更清楚"
              description={(
                <div>
                  <div style={{ marginTop: 4 }}>
                    <b>memory home（配置与运行时状态）</b>：<span className="mono">config.json</span>、共享策略源、
                    安装记录、待补证据的 capture、检查点队列。它记录的是「程序怎么工作」。
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <b>store（你的记忆）</b>：事件账本、主题页、笔记与证据。它记录的是「你想记住什么」。
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    两者可以指向同一个目录，但分开更清楚 —— 备份、迁移与目录权限都是按这两个根分别计算的，混在一起会让「我备份的是配置还是记忆」变成一个需要猜的问题。
                  </div>
                </div>
              )}
            />
            <Divider plain style={{ margin: '12px 0' }}>建议顺序</Divider>
            <ol className="settings-paths">
              <li>
                <b>创建存储</b>：在下面填好 memoryRoot 与 vaultRoot 并保存，程序会创建目录并写出
                <span className="mono"> config.json</span>。也可以改用命令行 <span className="mono">memkeel init --store 目录</span>。
                这一页不会替你凭空创建目录，保存之前它什么都不会写。
              </li>
              <li>
                <b>选择宿主</b>：决定要接入哪些 agent（Codex / Claude Code / ZCode / dsh）。不接也能用命令行，
                接入只是让它们在会话开始时自动读到记忆。
              </li>
              <li>
                <b>预览绑定</b>：绑定会改写其他应用的配置文件，所以先看会改什么 ——{' '}
                <Text className="mono" copyable={{ text: settings.setup?.dryRun ?? '' }}>{settings.setup?.dryRun}</Text>
              </li>
              <li>
                <b>检查健康</b>：确认绑定与存储都读得到 ——{' '}
                <Text className="mono" copyable={{ text: settings.setup?.check ?? '' }}>{settings.setup?.check}</Text>
                ，然后 <span className="mono">memkeel doctor</span>。
              </li>
            </ol>
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 10 }}
              message="本页不会写宿主配置，也不会重启任何进程"
              description="第 3、4 步的命令需要你在终端里确认执行。写入宿主配置是不可逆的一步（会改到 Codex、Claude Code 等应用的配置文件），所以它必须由你亲自触发，而不是打开一个页面就发生。"
            />
          </div>
        </div>
      )}
      <div className="panel">
        <h3 className="panel-title">配置文件</h3>
        <div>
          <Descriptions
            column={1}
            size="small"
            items={[
              {
                key: 'path',
                label: '配置文件路径',
                children: (
                  <Text className="mono" copyable={{ text: settings.configPath }}>{settings.configPath}</Text>
                ),
              },
              {
                key: 'exists',
                label: '文件状态',
                children: settings.exists
                  ? <Tag color="green">存在</Tag>
                  : <Tag color="red">不存在（保存时会创建）</Tag>,
              },
              {
                key: 'state',
                label: '存储路径校验',
                children: validation.ok
                  ? <Tag icon={<CheckCircleOutlined />} color="green">通过</Tag>
                  : <Tag icon={<WarningOutlined />} color="red">{validation.issues.length} 项待处理</Tag>,
              },
              {
                key: 'preserved',
                label: '本页不改动的键',
                children: settings.preservedKeys?.length
                  ? <span className="mono muted">{settings.preservedKeys.join('、')}</span>
                  : <span className="muted">无</span>,
              },
            ]}
          />
          {!settings.readable && (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 10 }}
              message="当前无法直接读取这个配置文件"
              description={settings.readError}
            />
          )}
          {!validation.ok && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 10 }}
              message="当前配置存在问题，保存前必须先修好这几项"
              description={(
                <ul className="settings-paths">
                  {validation.issues.map((row) => <li key={`${row.field}:${row.message}`}>{row.message}</li>)}
                </ul>
              )}
            />
          )}
          {!!validation.notes?.length && (
            <div className="muted" style={{ marginTop: 8 }}>{validation.notes.join(' ')}</div>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">存储</h3>
        <div>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="storage"
                label="存储后端 storage"
                rules={[{ required: true, message: '请选择存储后端' }]}
                extra="filesystem 直接把笔记写成文件；obsidian-cli 需要额外两个字段。"
              >
                <Select options={settings.storageOptions} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="memoryRoot"
                label="memoryRoot（记忆库根目录）"
                rules={[{ required: true, message: '请填写 memoryRoot' }]}
                extra="记忆库必须放在仓库之外；目录不存在时保存会自动创建。"
              >
                <Input className="mono" placeholder="C:/Users/<you>/agent-memory" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="vaultRoot"
                label="vaultRoot（Obsidian 库根目录）"
                rules={[{ required: true, message: '请填写 vaultRoot' }]}
                extra="所有笔记路径都相对它解析；和 memoryRoot 相同即可。"
              >
                <Input className="mono" placeholder="C:/Users/<you>/agent-memory" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="vaultName" label="vaultName（Obsidian 库名称）" extra="用 obsidian-cli 时必填。">
                <Input placeholder="my-vault" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="obsidianCli" label="obsidianCli（Obsidian CLI 可执行文件路径）" extra="用 obsidian-cli 时必填，填绝对路径。">
                <Input className="mono" placeholder="C:/Users/<you>/bin/obsidian.exe" />
              </Form.Item>
            </Col>
          </Row>
          <Divider plain style={{ margin: '4px 0 12px' }}>Obsidian（可选）</Divider>
          <ObsidianGuide obsidian={settings.obsidian} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">布局</h3>
        <div>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                name="layout"
                label="layout（布局）"
                rules={[{ required: true, message: '请选择布局' }]}
                extra="角色是逻辑名，程序按角色找目录，所以换物理结构不需要改代码。"
              >
                <Select options={settings.layoutOptions} />
              </Form.Item>
            </Col>
            {(settings.roleFields ?? []).map(({ key, label }) => (
              <Col span={8} key={key}>
                <Form.Item
                  name={['roles', key]}
                  label={`${key}（${label}）`}
                  rules={[{ required: true, message: `请填写 ${key}` }]}
                >
                  <Input className="mono" />
                </Form.Item>
              </Col>
            ))}
          </Row>
          <div className="muted">所有角色都必须落在 memoryRoot 之内；用 `..` 或符号链接绕出去会被拒绝。</div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">检索与注入参数</h3>
        <div>
          <Row gutter={16}>
            {(settings.numberFields ?? []).map((field) => (
              <Col span={6} key={field.key}>
                <Form.Item
                  name={field.key}
                  label={`${field.key}（${field.label}）`}
                  extra={field.hint}
                  rules={[{ required: true, message: `请填写 ${field.key}` }]}
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
        <h3 className="panel-title">生效值与来源（只读）</h3>
        <div>
          <ProvenanceList settings={settings} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">采集与隐私（只读）</h3>
        <div>
          <CollectionPolicy collection={settings.collection} />
        </div>
      </div>

      <div className="settings-actions">
        <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={busy}>预览并保存</Button>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>重新读取</Button>
        <span className="muted">保存前先给你看将要改动的字段，确认后才写入磁盘。</span>
      </div>

      <div className="panel">
        <h3 className="panel-title">宿主绑定状态（只读）</h3>
        <div>
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message={settings.setup.note} />
          <DataTable
            columns={hostColumns}
            data={settings.hostBindings ?? []}
            rowKey="id"
            searchable={false}
            pageSize={10}
            scrollY={240}
          />
          <Divider plain style={{ margin: '12px 0' }}>等价命令（复制到终端执行）</Divider>
          <Space direction="vertical" size={4}>
            <div>
              <span className="muted">绑定 / 重新绑定：</span>{' '}
              <Text className="mono" copyable={{ text: settings.setup.apply }}>{settings.setup.apply}</Text>{' '}
              <span className="muted">（从源码目录直接跑：{settings.setup.checkoutFallback}）</span>
            </div>
            <div>
              <span className="muted">只读复核：</span>{' '}
              <Text className="mono" copyable={{ text: settings.setup.check }}>{settings.setup.check}</Text>
            </div>
            <div>
              <span className="muted">先看会改什么：</span>{' '}
              <Text className="mono" copyable={{ text: settings.setup.dryRun }}>{settings.setup.dryRun}</Text>
            </div>
          </Space>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h3 className="panel-title">写入后需要重启的进程</h3>
        <div>
          <RestartNotice restart={settings.restart} />
        </div>
      </div>

      <DecisionModal decision={decision} onClose={() => setDecision(null)} />
    </Form>
  );
}
