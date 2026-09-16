[English](README.md) | **简体中文**

# Memkeel

**面向编程 agent 的本地优先记忆账本。** 四种不同的 agent 宿主共享同一个纯 Markdown 存储，
其中每一条记忆都是一个不可变、有证据支撑的事件。

Memkeel 不是聊天机器人的记忆挂件，也不是向量数据库。它是一个小巧的账本，由
**Codex、Claude Code、ZCode 和 dsh** 四个编程 agent 通过同一份共享契约读写。每条记忆
都是一个仅追加的事件，以 JSON 形式记录在 Markdown 笔记内部；Markdown 是事实来源；agent
实际读取的每一种投影（主题页、每日摘要、习惯列表、行动与错误账本）都是从该事件日志
*派生*而来，并且可以从中重建。事实绝不会悄无声息地改变：替换某个值必须通过一条显式的
`supersedes` 链接指向它所替换的事件，因此存储会为每一条断言保留来源与取代链，两个相互
矛盾的断言会成为一处可见的冲突，而不是最后写入者覆盖先前内容。没有需要运行的服务，没有
数据库，没有 API key，也没有守护进程：整个系统就是 Node.js 和磁盘上的文件，因此在终端里、
在离线的检出目录中或在容器内，它的行为完全一致。

- **事件不可变。** 事件仅可追加，绝不原地修改。
- **有证据支撑。** 每个事件都必须引用至少一个已经存在于磁盘上的笔记。
- **纯 Markdown。** 任何 Markdown 文件夹都是合法的存储。Obsidian 是可选增强项。
- **无服务、无数据库。** 只有文件，以及在你需要时的一个只读本地 Web 控制台。
- **来源与取代。** `supersedes` 链接为每个事实键构建可审查的历史。

---

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [角色与布局模型](#角色与布局模型)
- [存储后端](#存储后端)
- [宿主集成](#宿主集成)
- [CLI 参考](#cli-参考)
- [Web 控制台](#web-控制台)
- [原生 hooks](#原生-hooks)
- [事件与证据契约](#事件与证据契约)
- [共享策略块](#共享策略块)
- [测试与泄漏门禁](#测试与泄漏门禁)
- [为什么选择 Obsidian（可选）](#为什么选择-obsidian可选)
- [Docker](#docker)
- [项目布局](#项目布局)
- [许可证与鸣谢](#许可证与鸣谢)

---

## 环境要求

- **Node.js >= 22.18**（`package.json` 中的 `engines`）。同时也支持 Node 24。
- 一个用作存储的 Markdown 文件夹。它不必预先存在 —— `memkeel init` 会创建它。
- 可选：[Obsidian](https://obsidian.md)，外加位于 `PATH` 上的 `obsidian` CLI，仅当你需要
  `obsidian-cli` 存储后端时才需要。
- 可选：npm，仅当你想要使用完整的 `memkeel` 命令名而不是 `node memory.mjs` 时才需要。

仅凭 Node 22.18 或更高版本就够了。带 TypeScript 类型的辅助文件通过 Node 内置的类型剥离
加载，因此**不需要 `--experimental-strip-types` 标志**：

```console
$ node --version
v22.22.3
$ node memory.mjs doctor
```

更早的运行时（例如 Node 22.0–22.17）将无法加载随仓库附带的辅助文件。

## 安装

### 从克隆仓库安装

```bash
git clone https://github.com/RueDragon/memkeel.git
cd memkeel
node memory.mjs help
```

以上就是全部安装过程。Memkeel 的**运行时 npm 依赖为零**：核心库、MCP 服务器、hooks、
CLI 和 Web 服务器全部运行在 Node 标准库之上。已提交的 Web 控制台产物位于
`dashboard/static/`，因此你也不需要构建任何东西就能使用它。

### 作为 npm 包安装（尚未发布）

该包已为 npm 做好准备，但 v1.0.0 通过 GitHub 发布，npm 版本计划在 v1.1 提供。在此之前，
请从克隆的仓库安装。

```bash
npm install -g memkeel   # available from v1.1
memkeel help
```

无论用哪种方式安装，你得到的都是同一个程序。`bin/memkeel.mjs` 是一个薄封装，转发到
`memory.mjs`，因此 `memkeel <command>` 与 `node memory.mjs <command>` 可以互换。
本文档其余部分都使用 `memkeel`；如果你从克隆的仓库运行，且没有把该可执行文件放到
`PATH` 上，请替换为 `node memory.mjs`。

## 快速开始

三条命令就能让你从一无所有，得到一个可用且已接入 agent 的存储。

### 1. 创建存储

```bash
memkeel init
```

`init` 会创建一个空的、但开箱即用的 memory home：一个 `config.json`、共享策略源
（`bootstrap.md`）、事件契约（`event-schema.md`）、存储目录布局
（`events/`、`topics/`、`digest/`、`projects/`）以及一个空的 `habits.md`。它刻意
**不触碰任何 agent** —— 不注册 MCP、不安装 hooks、不写指令文件。请在 `setup` 之前运行它。

其余的投影笔记（`actions.md`、`mistakes.md`、`candidates.md`、`experience.md`）不会预先
创建；它们各自会在 consolidation 第一次有内容要写入时出现。对刚初始化完成的存储运行
`memkeel doctor` 是健康的，并以零退出。

用 `--home <dir>` 或设置 `MEMKEEL_HOME`，可以把它指向默认位置以外的目录。默认的 memory
home 是 `~/.memkeel`，默认存储创建在它下面。

### 2. 绑定你的 agent

```bash
memkeel setup                       # detect installed hosts and bind the ones it finds
memkeel setup --hosts codex,dsh     # only these hosts
memkeel setup --dry-run             # print what would change, write nothing
memkeel setup --check               # report drift, write nothing, exit non-zero on drift
memkeel setup --no-hooks            # register MCP + policy, skip native hooks
memkeel setup --uninstall           # remove the bindings and restore backups
```

`setup` 会为它找到的每个宿主注册 MCP stdio 服务器、安装原生 hooks，并发布共享策略块。
**未安装的宿主会被检测到并跳过，同时给出明确报告**，而不是让整次运行失败。

`setup` 是幂等的：每次写入都会先备份、再回读校验，第二次运行不会产生任何变更。关于每个
宿主具体会得到哪个文件，见[宿主集成](#宿主集成)。

### 3. 验证

```bash
memkeel doctor
```

`doctor` 会报告配置路径、缺失的预期文件、待处理的 capture、检查点健康状况，以及两把写入
锁（存储锁与 hook 队列锁）及其持有者的存活状态。当确实出现问题时，它以非零退出。

然后就可以在任何已绑定的宿主中，或者从 shell 中使用它：

```bash
memkeel bootstrap --cwd "$PWD" --query "release checklist"
memkeel recall --query "storage backend" --workspace my-project
```

---

## 配置

Memkeel 只读取**一个 JSON 文件**：`~/.memkeel/config.json`。

memory home 由一条所有命令共用的优先级决定：

1. `--home <dir>`
2. `MEMKEEL_HOME`
3. 每用户默认位置 `~/.memkeel`

同一目录下还存放 `bootstrap.md`、`event-schema.md`、`backups/` 和 `state/`。

完整 schema 见 [`config.example.json`](config.example.json)。把它复制为
`<memory home>/config.json` 并编辑，或者让 `memkeel init` 为你写入。下面三条命令只读检查，
不会写入任何东西：

```bash
memkeel config validate           # 一次列出全部字段错误；不合法时以非零退出
memkeel config show --effective   # 实际生效的归一化取值，以及每个值的来源
memkeel config migrate --dry-run  # 旧格式文档的升级计划
memkeel config migrate --apply    # 写入该计划：先备份，再回读校验
```

`config validate`、`config show` 与 `config migrate --dry-run` 都不写入。唯一会写的是
`config migrate --apply`：计划为空时它什么都不做；迁移结果校验不通过时它拒绝写入；写入前先把
读到的原始字节复制到 `<memory home>/backups/config-migrations/`；回读不一致时自动回滚。

`config show` 默认对路径脱敏；加 `--reveal-paths` 可输出完整路径。

| 键 | 含义 |
| --- | --- |
| `version` | 写入该文件的发布版本。迁移绝不会改写它。 |
| `configSchema` | 该文档的结构版本。由 `memkeel config migrate` 补写或更新。 |
| `memoryRoot` | memory root（存储根目录）的绝对路径。 |
| `layout` | 布局模型。`neutral` 是现代默认值；更早的扁平布局仍然可读。 |
| `roles` | 逻辑角色 → 相对路径的映射。见下文。 |
| `storage` | `filesystem`（默认）或 `obsidian-cli`。 |
| `vaultRoot` | Markdown 存储的绝对路径。相对角色基于它解析。 |
| `vaultName` | Obsidian vault 名称。仅由 `obsidian-cli` 使用。 |
| `obsidianCli` | `obsidian` CLI 的绝对路径。仅由 `obsidian-cli` 使用。 |
| `policyRoot` | memory home 的绝对路径。由 `--home` / `MEMKEEL_HOME` 自动设置。 |
| `activeLimit` | bootstrap 摘要中列出多少个活跃项目。 |
| `recentLimit` | bootstrap 摘要中列出多少组近期变更。 |
| `recentDays` | “近期变更”窗口的天数宽度（默认 14）。 |
| `budgetBytes` | 注入的 bootstrap 摘要的字节预算（默认 14000）。 |
| `workspaceAliases` | 每个 workspace id 的额外路径别名，用于 worktree 和被移动过的检出目录。 |
| `hook.codexDeferAdvisory` | 把 Codex 工具建议延迟到下一个 prompt（`true`，默认值）。只有 `false` 会关闭；模型列表被有意忽略。 |
| `topics` | 已注册的主题路由：`{ id, workspace, title, aliases, path }`。 |
| `catalogTopics` | 供历史 ingest 和主题目录使用的分组元数据。 |

`config.example.json` 使用了文档化的占位符，例如 `C:/Users/<you>/agent-memory` 和
`C:/Users/<you>/.memkeel`。请把它们替换为你机器上的真实路径。

## 角色与布局模型

代码依赖**逻辑角色**，而绝不依赖硬编码的物理路径。角色是一个名称，例如 `eventsRoot`；
它的值是一条相对于 `vaultRoot` 的路径。正是这层间接性，让同一份构建可以服务于一个
neutral 文件夹、一个已有既定风格的 vault，或一棵 Obsidian 专用的目录树，而无需改动代码。

默认（neutral）角色：

| 角色 | 默认值 | 内容 |
| --- | --- | --- |
| `root` | `''` | 存储根目录本身。 |
| `eventsRoot` | `events` | 不可变的事件日志，按天/工作区/agent 每天一个文件，外加 `events/Evidence/`。 |
| `topicsRoot` | `topics` | 生成的主题页（每个主题的当前状态）。 |
| `projectRoot` | `projects` | 工作区注册笔记（`workspace-<id>.md`）和主题描述符。 |
| `habitsNote` | `habits.md` | 已确认的习惯，外加一个由事件确认规则组成的管理块。 |
| `actionsNote` | `actions.md` | 生成的未完成行动账本。 |
| `mistakesNote` | `mistakes.md` | 生成的已确认错误增量。 |
| `candidatesNote` | `candidates.md` | 生成的待定偏好候选。 |
| `experienceNote` | `experience.md` | 生成的经验 / 短期上下文目录。 |
| `inboxRoot` | `digest` | 每日摘要和长文笔记。 |

有两条规则保证这一切是安全的：

1. **只使用管理块。** 生成的内容位于 `<!-- AUTO-MANAGED:START -->` 与
   `<!-- AUTO-MANAGED:END -->` 注释之间。consolidation 只替换该块，绝不触碰它周围的
   正文，因此你可以在这些笔记中手写其他任何内容。
2. **日志是写入路径。** 任何生成内容都由日志重建。手工编辑一个生成页面会在下一次
   consolidation 时被覆盖 —— 请改为记录一个事件。

旧式的扁平配置（顶层的 `eventsRoot`、`projectRoot`、`habitsNote`、`inboxRoot` 等）仍然会
解析为同一份角色映射，因此既有存储无需迁移即可逐字节保持不变地继续工作。

## 存储后端

每个后端都实现同样的五个动词 —— `read`、`create`、`append`、`replace`、`verify` —— 因此
调用方永远不需要根据当前启用的是哪一个来分支（`lib/storage/adapter.mjs`）。由 `storage`
来选择；当该键缺失时，若配置了 `obsidianCli` 则隐含 `obsidian-cli`，否则使用
`filesystem`。

### `filesystem`（默认）

针对 `vaultRoot` 的普通文件 IO。**零外部依赖**，可无头运行，适用于任何操作系统、容器
内部，以及一个从未接触过 Obsidian 的普通 Markdown 文件夹。

- `create` 拒绝覆盖已存在的笔记，随后写入并回读字节。
- `append` 是精确或回滚：文件会被回读，任何不一致都会恢复为之前的字节。
- `replace` 由期望值守卫，会在 `backups/replacements/` 下写入一个带时间戳、含前后哈希的
  备份，并重新检查目标在预检与写入之间没有发生变化。

### `obsidian-cli`（可选）

通过 `obsidianCli` 和 `vaultName` 驱动一个已安装的 Obsidian 实例。笔记内容仍然以字节形式
直接写入 vault 路径，然后通过 CLI 回读来确认 —— CLI 是*校验*通道，而不是写入通道。精确的
管理块替换还会额外生成一个 Git 补丁，用 `git apply --check` 预检它，并且只发布校验通过的
结果。

两个后端共享[事件与证据契约](#事件与证据契约)中描述的写入路径，其中包括笔记内容绝不
通过 CLI 参数列表传递这一规则。

## 宿主集成

Memkeel 与四种宿主通信：**Codex**、**Claude Code**、**ZCode** 和 **dsh**。`memkeel setup`
只在其配置目录存在时才绑定一个宿主，并报告每一个被跳过的宿主。

| 宿主 | MCP 服务器注册位置 | hooks 安装位置 | 共享策略发布位置 |
| --- | --- | --- | --- |
| Codex | `<CODEX_HOME or ~/.codex>/config.toml` → `[mcp_servers.agent_memory]` | `<codex home>/hooks.json` | `<codex home>/AGENTS.md` |
| Claude Code | `~/.claude.json` → `mcpServers.agent_memory` | `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` | `<claude config dir>/CLAUDE.md`（原生 `@` 导入） |
| ZCode | `~/.zcode/cli/config.json` → `mcp.servers.agent_memory` | `~/.zcode/cli/config.json`（`hooks.events.*`） | `~/.zcode/AGENTS.md` |
| dsh | `~/.dsh/profiles/<profile>/cordis.patch.yml` | 同一文件，外加 `<memory home>/dsh-hooks.json` | `~/.dsh/AGENTS.md` |

各宿主的说明：

- **Codex。** `setup` 会写入一个 `[mcp_servers.agent_memory]` TOML 段，其中包含当前的
  `process.execPath` 和 `mcp-server.mjs` 的绝对路径。Codex 保留自己的 hook 信任边界；
  任何东西都不会绕过它。
- **Claude Code。** MCP 条目写入 `~/.claude.json`，共享策略以原生 `@` 导入行的形式发布在
  管理标记内部，而不是内联副本。
- **ZCode。** MCP 条目和 hook 表都位于 `~/.zcode/cli/config.json`。`setup` 还会关闭宿主
  自带的记忆功能（`memory.use`、`features.memory`），因为同时运行两者会导致上下文重复。
  只有只读工具被预先批准；写入走宿主正常的审批流程。
- **dsh。** MCP 和 hooks 以带标记的块注入到 profile 的 `cordis.patch.yml` 中，对每个实际
  存在的 profile（headless / web / desktop）各一份。hooks 由零依赖的
  `dsh-memory-plugin.mjs` 桥接提供，因此 dsh 复用宿主自身的协议对象，而不是安装重复的
  peer 包。

MCP 暴露两个工具：

- **`agent_memory_read`** —— 只读：`help`、`status`、`bootstrap`、`recall`、
  `experience_recall`、`context_recall`、`check_operation`。它不能写入、capture、确认
  一个习惯或执行 shell 命令。
- **`agent_memory`** —— 用途受限的写入：`capture`、`record`、`consolidate`、
  `maintenance`、`register`、`habit_decide`。**两个工具都不暴露 shell 或任意文件写入
  能力**，也都不放宽宿主沙箱。

在修改 hook 或 MCP 配置之后，请重启已有的宿主会话；正在运行的会话不会在会话中途读取
用户级条目。

要撤销全部改动，运行 `memkeel setup --uninstall`。它会移除自己拥有的 MCP 条目、hook 声明
和策略块，从 `state/setup-receipt.json` 恢复，并且不触碰任何不属于它的配置。

## CLI 参考

每条命令都接受可选的 `--home <dir>`，用于指向另一个 memory home。

### 设置

| 命令 | 作用 |
| --- | --- |
| `init [--store DIR] [--obsidian-cli PATH] [--vault-name NAME]` | 创建一个空的、开箱即用的 memory home 和存储：目录布局、`config.json`、策略源、事件契约以及一个空的 `habits.md`。不触碰任何 agent。`--store` 设置存储根目录；Obsidian 相关标志用于预填可选的 `obsidian-cli` 后端。 |
| `setup [--hosts codex,claude,zcode,dsh] [--dry-run] [--check] [--no-hooks] [--uninstall] [--force]` | 把存储绑定到已安装的宿主：注册 MCP 服务器、安装原生 hooks、发布共享策略。`--dry-run` 打印将要发生的变更；`--check` 报告漂移但不写入，并在存在漂移时以非零退出；`--no-hooks` 跳过 hook 安装；`--uninstall` 移除绑定并恢复备份。未安装的宿主会被检测到并**跳过**，同时给出清晰报告。如果某个宿主已有一个指向别处的 `agent_memory` MCP 服务器，该宿主会被**拒绝**而不是被静默重新绑定；请检查它，或加上 `--force` 重新运行。 |

### 配置

| 命令 | 作用 |
| --- | --- |
| `config validate` | 只读。校验整份文档，一次列出全部字段问题，并给出未知字段与旧写法的提示；不合法时以非零退出。它与设置页共用同一个校验器，因此 `memkeel config validate` 与控制台结论一致。 |
| `config show [--effective] [--reveal-paths]` | 只读。打印程序实际会使用的归一化取值，并标明每个值的来源：文件、旧扁平键，或默认值。默认对路径脱敏，加 `--reveal-paths` 输出完整路径。 |
| `config migrate [--dry-run]` | 只读。打印旧格式文档的升级计划：schema 号、折进 `roles` 的旧扁平角色键、从现有那一项推导出的存储根，以及缺失的默认值。不写入也不创建任何东西。 |
| `config migrate --apply` | 写入该计划。计划为空时不做任何事；写入前先校验迁移后的文档；把原始字节复制到 `<memory home>/backups/config-migrations/`；回读不一致时自动回滚。重复执行是幂等的，`--dry-run --apply` 同时给出会以矛盾为由拒绝。 |

### 读取

| 命令 | 作用 |
| --- | --- |
| `bootstrap --cwd PATH --query TEXT [--workspace ID] [--json] [--all] [--audit]` | 启动摘要：已确认的习惯、活跃项目、近期变更、匹配的任务指引以及实时的短期上下文，压缩到 `budgetBytes` 以内。只读；`--audit` 会有意持久化诊断信息。 |
| `recall --query TEXT [--workspace ID\|NAME\|PATH] [--history]` | 主题与事实查找。优先使用由事件支撑的当前事实，其次是已注册的规范主题，再次是按 BM25 排序的证据。`--history` 会扩大到来源信息和归档材料。 |
| `experience-recall` / `context-recall` | 检索执行经验或短期任务上下文。任何读取都不会增加使用计数，也不会写入缓存。 |
| `check-operation --file INPUT.json` | 针对拟执行操作的有限静态预检（kind、command、shell、cwd、boundary）。返回匹配到的经验和警告 —— **不是**许可，也不保证该命令是安全的。 |
| `audit` | 按类型报告笔记索引，并列出未分类的历史来源。历史断言需要有意的提升（promotion）才能生效。 |
| `doctor` | 健康检查：配置与预期文件、待处理的 capture、检查点健康状况，以及两把写入锁及其持有者的存活状态。 |

### 写入

| 命令 | 作用 |
| --- | --- |
| `register --topic WORKSPACE/KEY --workspace ID --title TEXT [--alias TEXT]` | 添加一条主题路由。不能覆盖已存在的主题，也绝不会提升一条历史断言。 |
| `record --file EVENT.json` \| `record --stdin` | 追加一个不可变事件，并同步 consolidate 它。 |
| `capture --file INPUT.json` \| `capture --stdin` | 接收 `{event, evidence_text}`，写入证据笔记、记录事件，并通过回读消费它。 |
| `habit-decide --file INPUT.json` \| `habit-decide --stdin` | 以 `confirmed` 或 `rejected` 关闭一个偏好候选，并附上一段必须存在于证据笔记中的精确用户原话。 |
| `consolidate` | 消费待处理事件并重建管理投影。`pending` 是剩余的积压量；`pendingBefore` 是本轮开始时的积压量。 |
| `retain --candidates` / `retain --file DECISIONS.json` / `retain` | 保留（retention）账本。`--candidates` 以只读方式列出尚未决断的自动检查点；decisions 文件用于应用软删除；不带参数的 `retain` 打印该账本。 |
| `maintenance [--rebuild]` | 恢复被中断的 capture、排空排队的检查点、结算权重、把符合条件的候选提升为*试用*状态、执行 consolidate，并刷新索引和目录。`--rebuild` 会重新生成缺失的带标记投影。 |
| `index [--force]` | 在 memory home 下重建增量词法索引。 |
| `ingest-plan [--since ISO] [--limit N] [--root DIR] [--auto-register]` | 只读报告：哪些历史 agent 轮次可以被回填。 |
| `ingest-apply [...]` | 把这些历史轮次写为已报告的任务上下文。 |

## Web 控制台

```bash
npm run dashboard          # or: node dashboard.mjs
# Agent Memory dashboard: http://127.0.0.1:3247
```

该控制台是一个以读为主的本地 UI，建立在 CLI 和 MCP 所使用的同一批投影之上。
**不需要构建步骤**，因为构建产物已提交在 `dashboard/static/` 下。

视图包括事实、上下文、经验、习惯与候选、行动、冲突、事件流、工作区路由、主题、
系统/健康页面，以及一个**会话回放**视图：它把每个 agent 会话渲染成按时间顺序排列的
聊天记录（用户轮次在右、agent 轮次在左，以 Markdown 渲染），并带有两个标签页：归档的
检查点摘要和宿主的真实记录。读取记录是只读的，绝不会写入记忆。

可写操作 —— 关闭一个行动、确认或拒绝一项偏好、撰写一条事实、行动、上下文或经验、
修订或废止一条已有记录 —— 都要经过两步式的预览/执行握手：服务器返回一个计划，外加一个
与当前状态指纹绑定的 token；如果日志在此期间发生了变动，执行会**失效关闭**。每次修订都是
一次携带 `supersedes` 的追加，因此控制台绝不直接编辑 Markdown。

服务器**仅绑定回环地址**（`127.0.0.1`），并接受 `--port` 覆盖端口。

修改前端的贡献者需要重新构建产物：

```bash
npm --prefix dashboard/app install
npm run dashboard:build    # writes dashboard/static/
npm run dashboard:dev      # Vite dev server proxying /api to the running console
```

## 原生 hooks

`setup` 会为每个受支持的宿主安装 hooks，让记忆无需被要求就能工作。执行器是
`hook-runner.mjs`，由宿主通过 stdin 上的 JSON payload 调用。事件及其行为：

| 事件 | 行为 |
| --- | --- |
| `SessionStart` | 每个会话注入一次首个 bootstrap 摘要。 |
| `UserPromptSubmit` | 注入最多四条与 prompt 相关的长期事实，以及匹配的短期上下文、经验和排队的检查点；当某个宿主的 `SessionStart` 衔接点是分离的时，同步执行首次 bootstrap。 |
| `PreToolUse` | 针对拟执行操作运行有限的执行经验检查。对于确定无疑的违规，它可以返回 **deny** 决策，否则注入一条建议。记忆工具自身会被跳过。 |
| `PostToolUse` / `PostToolUseFailure` | 在一次失败之后或经过若干次搜索步骤之后，提示记录一条经验 —— 目的是在压缩丢失它之前，capture 下一条路径或一条已被排除的路线。 |
| `Stop` / `PreCompact` / `SessionEnd` | 排队一个有限的、已脱敏的检查点（用户的请求加上截断的回复摘录），用于持久化 capture。 |
| `SessionEnd` | 如果宿主没有发送 assistant 文本，还会复用当前轮次的回复，而不是替换一个内容更丰富的检查点。 |

值得了解的保证：

- **hooks 从不授予许可。** 它们注入上下文，也可以拒绝；但它们绝不会放宽宿主的沙箱或
  审批模式。
- **读取从不强化。** 没有任何读取路径会提升一个习惯或延长某个上下文的生命周期。
- **脱敏会被应用**到 hook 输出、bootstrap、recall 和检查点写入中，并且 capture 会拒绝
  可识别的凭据。历史日志不会被读取路径改写。
- **不记录的指令会被遵守。** 一条明确表示不要记录的 prompt 会在该轮次抑制检查点 capture
  （`state.readOnly`），既不创建事件，也不创建工作区笔记。
- **失败保持可见。** 失败的检查点会把它 payload 和最后一次错误保留在 hook 队列中并被
  重试；缺失的工作区永远不会被计为一次成功的收尾。

在 Codex 上，工具建议对**所有模型**一律延迟，而不是在序列中途注入：Codex 会把额外的 hook
上下文变成一条 developer 消息，而这条消息可能落在一次工具调用与其结果之间，把 `tool_calls`
与工具回复拆开 —— 这种顺序会被严格的 provider 拒绝。因此这些文本会等待，并搭上下一个
prompt。deny 决策绝不延迟。模型名无法说明转发方是否接受交错的工具消息，所以旧模型列表一律
忽略；唯一的关闭方式是 `hook.codexDeferAdvisory: false`。

## 事件与证据契约

权威契约是 [`event-schema.md`](event-schema.md)，`setup` 会把它发布到 memory home，以便
agent 在本地读取它。简版如下：

```json
{
  "event_id": "20260907-codex-example-01",
  "workspace": "my-project",
  "topic": "my-project/channel-config",
  "agent": "codex",
  "occurred_at": "2026-09-07T16:00:00+08:00",
  "evidence": ["digest/existing-source.md"],
  "facts": [{ "key": "specific-contract", "text": "A verified conclusion." }],
  "verification": ["Exactly what was checked and what was not."],
  "actions": [{ "id": "verify-specific-case", "status": "open", "text": "One next action." }]
}
```

实现所强制执行的规则：

- **必填字段：** `event_id`、`workspace`、`topic`、`agent`、`occurred_at`、`recorded_at`，
  以及至少一条 `evidence` 条目。
- **证据必须存在于磁盘上。** 每条都是指向一个已存在笔记的、相对于存储根目录的路径，
  可选带一个 `#heading`。事件不能引用不存在的笔记，也绝不能引用它自身。
- **主题必须先注册**到该工作区，通过 `register` 完成。
- **不可变性。** 事件只被追加，从不被编辑。用不同内容复用同一个 `event_id` 会报错；
  用完全相同的内容复用它是一次幂等重试 —— 这正是被中断的写入可以安全重复的原因。
- **修改事实必须使用 `supersedes`。** 对于同一个 `topic` + `key`，若出现不同断言却没有它，
  就会被记录为一次**冲突**：当前值被保留，分歧被显现出来。单凭时间戳永远不会胜出，而解决
  冲突的方式是显式取代其中一方。
- **废止。** 一条替代记录可以把自身标记为 `status: "invalidated"`，从而把该记录从当前
  视图中移除，而不破坏证据链。
- **可选数组：** `experiences`、`contexts`、`preferences`（仅候选）、`habit_decisions`、
  `mistakes`。
- **事件没有大小上限。** 长篇正文应当放进 `digest/longform/` 下的笔记，并配一个很小的
  指针事件；注入的边界控制在读取侧。
- **密钥会被拒绝。** 可识别的凭据和私钥会在写入时被拒绝。

磁盘上的日志：按记录的日期、工作区和 agent，每个文件位于
`events/<YYYY-MM-DD>-<workspace>-<agent>.md`，每个事件都存储为一个带分隔符的块：

````markdown
<!-- EVENT:20260907-codex-example-01 -->
```json
{ "event_id": "20260907-codex-example-01", "...": "..." }
```
<!-- END-EVENT -->
````

如果一份日志中存在不配对的块、某个事件的标记与其 `event_id` 不一致，或者某个已消费的事件
发生了变化或消失，存储会失效关闭，而不是提供一个只解析了一半的历史。

### 工程说明：内容以字节写入

笔记内容以字节形式直接写入目标路径，然后通过回读来校验。它**绝不**通过 CLI 参数列表
传递。Obsidian CLI 会解码每个参数中的两字符序列 `\n` 和 `\t`，并且无法转义这些字母
前面的字面反斜杠，因此像 `C:\temp\new\file.md` 这样的 Windows 路径会变成
`C:<TAB>emp<LF>ew\file.md`，从而损坏日志。读取是字节保真的，因此 CLI 保持为校验通道，
而文件系统保持为写入通道。出于同样的原因，追加是精确或回滚：否则一次损坏的追加就会让
整个存储的 `loadEvents` 失效。

## 共享策略块

agent 所遵循的行为存放在一个文件中：`<memory home>/bootstrap.md`（本仓库中的
[`bootstrap.md`](bootstrap.md) 是种子副本）。`setup` 会把它发布到每个宿主的指令文件中，
位于管理标记内部：

```markdown
<!-- AGENT-POLICY:START -->
Source: <memory home>/bootstrap.md; sha256: <hash>; adapter: codex.
...policy text...
<!-- AGENT-POLICY:END -->
```

- 标记之外的文本始终会被保留。
- 每个块都记录源路径、源哈希和适配器名称，因此漂移是可见的。
- Claude Code 收到的是策略文件的原生 `@` 导入，而不是内联副本。
- 发布器校验的是源哈希，**而不是**运行时的模型行为。已有会话可能需要开启一个新任务，
  才会加载变更后的指令。
- 请维护策略源，而永远不要维护生成出来的宿主块。

已确认的习惯只有一个数据源：由 `roles.habitsNote` 指定的那份笔记中、位于其管理标记之间的
那块经过校验的 JSON。只有已确认、且作用域与触发条件都匹配的偏好才会生效；一次性请求仅限
当前会话，而推断出的候选绝不会自行变成强制规则。

## 测试与泄漏门禁

```bash
npm test          # node --test test/*.test.mjs
npm run check     # node scripts/check-syntax.mjs
npm run leak-scan # node scripts/leak-scan.mjs  （工作区）
npm run pack-scan # node scripts/pack-scan.mjs  （真实 npm pack 产物）
```

- **`npm test`** 在布局模型、存储适配器、事件校验、排序、搜索、保留策略、转录记录、
  控制台写入、dsh 插件桥以及泄漏门禁自身之上运行单元与集成测试套件（26 个测试文件）。
- **`npm run check`** 对每个第一方 `.mjs` 文件运行 `node --check`。随仓库附带的代码和已
  提交的控制台产物会被跳过，因为它们不该由我们来修。
- **`npm run leak-scan`** 扫描工作区（含自身源码），检查通用凭据、私人路径与非公共仓库
  特征。维护者专属的字面词表应保存为仓库外的 JSON 字符串数组，由 `MEMKEEL_LEAK_TERMS_FILE`
  指定；禁止提交该文件，也禁止把私人词写进扫描器自身的规则表。诊断只输出文件、行号与规则
  id，绝不输出匹配值——公开仓库的 CI 日志本身就是公开的。
- **`npm run pack-scan`** 执行 `npm pack`，解开真实 tarball，核对每个待发布文件都已声明在
  `package.json` 的 `files` 中，并用同一套规则扫描产物。工作区干净并不代表真正会被发布的
  内容干净。

检查范围有三层，任何一层的结果都不能代表另外两层：

| 范围 | 命令 | 覆盖 |
|---|---|---|
| 源码 | `npm run leak-scan` | 工作区，规则表 + 仓库外词表 |
| 分发包 | `npm run pack-scan` | 真实 tarball 的文件清单与文本内容 |
| 历史 | 未自动化 | 旧提交、悬空对象、fork 与已下载副本 |

**覆盖范围有明确边界，且会打印出来。** 按非文本跳过的文件（`.png`、`.woff2`、`.pdf`、
压缩包等二进制）不会被读取，符号链接也不会被跟随；运行时会给出一共跳过了多少个。私人库的
截图或内部页面的 PDF 是能通过这道门禁的。因此"干净"只能理解为"在读到的文本里没有命中"，
绝不等于"发布内容不含个人信息"。

### 升级与部署注意事项

- **`setup` 会保留一份带版本号的安装记录**，位于 `<memory home>/state/setup-receipt.json`：逐文件
  记录安装前的原始字节与它写入的字节。`setup --uninstall` 依赖它恢复，并会拒绝安装之后被改动过的
  文件，所以请把它当作私密数据、不要手工编辑。安装被中断不会致命 —— 重新运行 `setup` 即可补齐。
  每次运行还会说明自己做了什么：`first-install`、`no-change`、`upgrade`、`rebind`、`refresh`
  或 `uninstall`。
- **`memkeel doctor` 检查的不只是存储，还有安装本身。** 它会报告这次是 `--home` /
  `MEMKEEL_HOME` / 默认值中的哪一个决定了 memory home、安装记录的状态、记录中的绑定是否仍指向该
  home，以及启动程序与它调用的脚本是否还存在。漂移是最安静的那种故障：存储换了位置而宿主没有重新
  绑定，agent 就只是"什么都记不住"。
- Codex 默认对全部模型延后 advisory 注入，旧模型列表（包括空列表）不再生效。
  只有显式设置 `hook.codexDeferAdvisory: false` 才会关闭保护。
- 安装时会将记忆目录的绝对路径写入 MCP 和 Hook 启动参数。升级旧绑定先执行
  `setup --dry-run` 检查，确认后使用 `setup --force` 重新绑定。
- 安装被拒绝时返回非零退出码；`--check` 发现配置漂移也会失败。
- 卸载依据 `state/setup-receipt.json` 恢复原文件，包括原生记忆开关。检测到后续用户
  修改时拒绝覆盖。没有安装记录的旧版本需从原 setup 备份手动恢复。
- 安装记录和备份可能包含宿主原有凭据，必须保持私密。
- 设置页修改路径仅切换存储位置，不搬迁数据。迁移时先停止写入、备份记忆目录与存储，
  复制并校验数据后修改路径，再运行 `doctor`。读写验证完成前保留旧存储。
- CI 覆盖 Windows、Linux、macOS 和 Node 22/24。npm 发布及公开 Git 历史重写属于
  单独的维护者操作，不会在升级时自动执行。
## 为什么选择 Obsidian（可选）

存储就是一个装满 Markdown 文件的文件夹，契约仅此而已。任何编辑器都可以用。

Obsidian 是一种*增强*，而不是必需项：

- 使用 **`filesystem`** 后端（默认）时，Memkeel 完全不需要 Obsidian。
- 使用 **`obsidian-cli`** 后端时，写入仍然以字节形式落到磁盘，CLI 只用于确认 vault 视图，
  因此 Obsidian 的缓存永远不会成为事实来源。
- 如果你本来就生活在某个 vault 中，把 `vaultRoot` 指向它，并填写 `roles` 以匹配你自己的
  目录结构。管理块会让生成内容与你的正文保持分离。
- 如果你不使用 Obsidian，就保留 `storage: "filesystem"`，并忘掉最后两个键。

不用 Obsidian 所放弃的，只是 CLI 回读确认这一步，以及你个人依赖的那些 vault 便利功能。
事件模型中的任何部分都不依赖它。

## Docker

该镜像只运行 **`filesystem`** 后端：没有 Obsidian，没有 GUI，也没有外部服务。

```bash
docker build -t memkeel .

# 首次运行：创建 memory home，并把存储指向挂载的卷。
docker run --rm -v memkeel-home:/memkeel -v "$PWD/store:/store" memkeel init --store /store

# 之后默认命令就是健康检查。
docker run --rm -v memkeel-home:/memkeel -v "$PWD/store:/store" memkeel
```

| 卷 | 容器内路径 | 用途 |
| --- | --- | --- |
| memory home | `/memkeel` | `config.json`、`bootstrap.md`、`event-schema.md`、`state/`、`backups/`。 |
| Markdown 存储 | `/store` | `vaultRoot`：事件日志和每一种投影。请把它放在真实卷上 —— 这就是数据。 |

请同时挂载两者。memory home 存放配置和派生状态；存储存放你丢了会心疼的 Markdown。镜像中
`MEMKEEL_HOME` 被设置为 `/memkeel`。

`init` 是幂等的，而且必须告诉它存储在哪里：不带 `--store /store` 时它会把存储建在 home 卷
里面，`/store` 挂载就白挂了。memory home 存在之后，默认命令是 `node memory.mjs doctor`，
也可以用其他命令覆盖，例如：

```bash
docker run --rm -v memkeel-home:/memkeel -v "$PWD/store:/store" memkeel \
  bootstrap --cwd /store --query "release checklist"
```

Windows PowerShell 下卷参数的引号写法不同，`$PWD` 要写成 `${PWD}`：

```powershell
docker build -t memkeel .
docker run --rm -v memkeel-home:/memkeel -v "${PWD}/store:/store" memkeel init --store /store
docker run --rm -v memkeel-home:/memkeel -v "${PWD}/store:/store" memkeel
```

macOS 上直接使用上面的 bash 写法即可；Docker Desktop 的卷语法相同。

### 这个镜像是什么，不是什么

它是**命令行与存储工具，不是服务**。默认命令是健康检查，所以非零退出码是**关于你存储的结论**，
而不是"进程崩了"。这正是它不附带 compose 文件的原因：`docker compose up` 会把一个完全健康的
容器报成不断重启。如果你确实想把控制台暴露出来，请自己写 compose，并给控制台一条自己的常驻命令
（`node memory.mjs dashboard --port 3247`），而不是复用 `doctor`。

hooks 在容器中没有意义（那里没有 agent 宿主），因此容器里跳过 `setup`，改在真正运行 agent
的机器上绑定宿主。绝不要把配置、存储、安装记录或 token 烘焙进镜像。

### 已验证与未验证的部分

上面这些命令由测试套件针对**发布包**（而不是仓库检出）验证：`npm pack` 后解包到一个空目录，
再依次跑 `init` → `config validate` → `doctor` → `bootstrap`，并从解包副本发起一次真实的控制台
请求。另有一个测试断言 Dockerfile 里每个 COPY 源路径都存在、且**没有**复制 `dashboard/app`，
因此镜像发布的内容与 `npm pack` 发布的内容一致。

**未验证的是容器本身**：本机没有容器运行时，因此没有执行过镜像构建，也没有在容器里跑过。
请把"文件集合与命令契约"当作已验证，把"镜像构建"当作未验证。

## 项目布局

```text
memkeel/
├── bin/memkeel.mjs          # npm bin shim -> memory.mjs
├── memory.mjs               # CLI entry point (all commands, help text, option parsing)
├── mcp-server.mjs           # MCP stdio server: agent_memory_read + agent_memory
├── hook-runner.mjs          # Native hook entry point (JSON payload on stdin)
├── dsh-memory-plugin.mjs    # Zero-dependency dsh hook bridge
├── setup.mjs                # `memkeel setup`: MCP + hooks + policy per host
├── dashboard.mjs            # Local read-mostly console HTTP server
├── integrate-mcp.mjs        # Standalone MCP registration (legacy convenience wrapper)
├── integrate-hooks.mjs      # Standalone hook installation (legacy convenience wrapper)
├── publish.mjs              # Publish the shared policy block to host instruction files
├── bootstrap.md             # The shared policy source (published into each host)
├── event-schema.md          # The authoritative event/evidence contract
├── config.example.json      # Config schema with placeholders
├── lib/
│   ├── core.mjs             # Bootstrap, recall, event load/validate, projections
│   ├── layout.mjs           # Role resolution (modern roles + legacy flat keys)
│   ├── lifecycle.mjs        # capture, habit decisions, maintenance
│   ├── checkpoints.mjs      # Durable drain of queued hook checkpoints
│   ├── hooks.mjs            # Per-event hook behaviour
│   ├── preferences.mjs      # Habit rules, candidates, validated JSON block
│   ├── experience.mjs       # Experiences, contexts, promotion rules
│   ├── retention.mjs        # Soft-drop ledger with substance guardrail
│   ├── weight.mjs           # Read-driven weight settlement (ranking only)
│   ├── access-log.mjs       # The one derived log a read may write
│   ├── transport.mjs        # Path safety, atomic JSON, writer locks, Obsidian transport
│   ├── digest.mjs           # Daily digest projection
│   ├── dashboard-*.mjs      # Read models and the preview/execute write handshake
│   ├── storage/             # adapter.mjs, filesystem.mjs, index.mjs (backend factory)
│   ├── search/              # bm25.mjs, tiered-read.mjs, index-bridge.mjs
│   └── ingest/              # Pipeline, sources and history backfill
├── dashboard/
│   ├── app/                 # React + Vite + Ant Design + TanStack Table + ECharts sources
│   └── static/              # Committed production bundle (no build step needed)
├── test/                    # node --test suite
├── scripts/                 # check-syntax.mjs, leak-scan.mjs
├── examples/neutral-vault/  # A tiny example store for inspection
└── vendor/obsidian-mind/    # Vendored MIT helpers (see THIRD_PARTY.md)
```

## 许可证与鸣谢

MIT。见 [LICENSE](LICENSE)。

Memkeel 在 `vendor/obsidian-mind/` 下附带了一小部分来自
[`breferrari/obsidian-mind`](https://github.com/breferrari/obsidian-mind) 的 MIT 许可代码，
并保留了它的许可证。完整的归属说明 —— 包括 Web 控制台的前端运行时依赖 —— 见
[THIRD_PARTY.md](THIRD_PARTY.md)。
