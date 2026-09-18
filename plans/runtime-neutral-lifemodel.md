# Farfold 当前开发计划：统一 Host、ACP 与完整工作台

> 2026-09-18 更新：阶段 1–5 代码完成后的真实验收失败（UI 与 F-prototype 不一致、本机已装
> Agent 无法发现/连接、工程方言泄漏到 UI、旧内容残留）。用户批准以「Zed 边界 + F-prototype
> 外形 + 多 Agent 桌面」重做，作为**阶段 6**。第 00 章是当前唯一执行入口；第 0 章及以后为历史
> 记录，保留为证据，不再续接。

## 00. 阶段 6：ACP 客户端重做（当前执行入口 · 2026-09-18 用户批准）

### 00.1 为什么重做（一句话版）

阶段 1–5 把 Farfold 做成了 Runtime 的「监管者」：校验二进制 SHA、隔离私有 HOME、自维护
适配器、自建 Turn/事件真相、每个 Runtime 一套 UI。一线 ACP 客户端（Zed、JetBrains）的边界
恰好相反：Agent = `command/args/env`，握手即合法；Agent 拥有认证/模型/工具/历史；客户端
只做一套 Thread UI + 完整客户端能力（fs/terminal/elicitation）。阶段 6 按后者重做。
诊断全文见 2026-09-18 对话记录；本章只保留可执行结论。

### 00.2 已定决策（用户 2026-09-18 确认，开发中不得重议）

| #   | 决策       | 内容                                                                                                                                                                                                                                |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 兼容性     | **不校验 Agent 二进制 SHA/精确版本**。合法性 = ACP `initialize` 握手成功（protocolVersion 1）。registry 条目自带 sha256 时对下载归档校验，仅此而已。                                                                                |
| D2  | 认证       | **复用用户本机 Agent 登录**。不再 `env_clear`/私有 HOME/私有 config。实现协议 `authMethods`：`agent` 型调 `authenticate`，`terminal` 型在 Farfold 内嵌终端跑一次。Farfold 托管 API key 降级为可选 env 注入。                        |
| D3  | Agent 范围 | 本阶段只做 **OpenCode（原生 `opencode acp`）、Codex（官方 `@agentclientprotocol/codex-acp`）、Pi（上游 `pi-acp`）**。不接 Gemini。但接入层必须是通用的：三者只是 registry/自定义条目，不允许出现 Agent 专属 Rust 模块。             |
| D4  | Pi 分发    | **取消捆绑** Pi 二进制。Pi 与其他 Agent 对等，由用户自装或经 registry 安装。Farfold 自维护 `pi-acp-adapter` fork 的私有扩展（`_pi/refresh_profile`、`promptModel`、Extension 通知）按「不支持」处理。                               |
| D5  | 会话真相   | **混合模式**：Farfold `MetaStore` 只存会话索引与用户元数据（agent_id、cwd、native_session_id、标题、置顶、归档、时间）。历史内容靠 `session/load`；支持 `session/list` 的 Agent 做对账。**不再有 Farfold 自己的 Turn/事件账本。**   |
| D6  | 进程模型   | 每 (Agent, 项目目录) 一个 ACP 进程，进程内多会话；空闲回收；启动时清理上次遗留的子进程与临时目录。多会话并发不设全局 Turn 上限。                                                                                                    |
| D7  | UI         | **一套** Thread UI，按 `.design/2026-09-16-redesign/F-prototype.html` 实现；差异由 `agentCapabilities`/`configOptions` 驱动显隐。纸白为默认主题，保留跟随系统。                                                                     |
| D8  | LifeModel  | 本阶段**只留接口与前端设计**：Settings 的 LifeModel 页按 F 稿做出（总开关/Proposal/Canonical/注入预览，用静态数据），Rust 保留 `lifemodel.rs` 数据模型与一个 `context_blocks_for_prompt()` 钩子（返回空）。不做采集、不做真实注入。 |
| D9  | 旧代码     | **彻底删除**，不留兼容层、不留 fail-closed 占位、不迁移旧会话。删除清单见 00.6，每片出口用 `rg` 证明零引用。                                                                                                                        |
| D10 | 平台       | 仅 macOS arm64。                                                                                                                                                                                                                    |
| D11 | SDK        | Rust 用官方 `agent-client-protocol` crate（切片 A 做 spike；失败则保留手写传输但类型对齐 `agent-client-protocol-schema`）。                                                                                                         |
| D12 | Node       | 复用已打包 Node 22（`pi-capability-runtime/runtime/node` 改名为 `node-runtime/`）为 npx 类 Agent 做私有 `npm install`。用户无需装 Node。                                                                                            |
| D13 | 出口标准   | 每片出口 = **安装版 Farfold.app 上由人走通指定旅程并留截图**。单测/mock 只是前置条件，不是出口。                                                                                                                                    |

### 00.3 技术框架

```
前端 React 19（一套）
  Shell: Sidebar(会话流, 需要你/在跑排序, 项目分组) · 顶栏(标题 + Agent·模型切换器) · 状态栏 · ⌘K · ⌘N
  Thread: Transcript(用户/Agent/步骤流/审批卡/沉降行/本轮产物) · Composer(文本+图片+@文件, 队列, Stop)
  产物窗格: diff / 终端 / 日志（链接唤起、×关闭、拖宽）
  Settings: Agent 接入 · LifeModel(静态) · 通用
  空态/开始页: 未接入 → 去设置；已接入 → 发消息即建会话
Rust Host
  agent_catalog   registry.json 拉取缓存 · 本机发现(login-shell PATH + 常见目录 + /Applications) · 自定义 command
  agent_install   registry binary 下载(可选 sha) · npx 私有 npm 安装(自带 Node)
  acp_client      官方 crate · 每(Agent,cwd)一进程 · initialize/authMethods/session new|load|list|prompt|cancel|set_config_option
                  客户端能力: fs/read_text_file, fs/write_text_file, terminal/*, elicitation, auth.terminal, session/request_permission
  event_bus       ACP session/update 原样透传 + 归一化投影 → Tauri Channel（单一事件流）
  meta_store      SQLite: agents, sessions(索引), settings, lifemodel(数据模型保留)
  pty             portable-pty：供 terminal/* 与 terminal 型登录
  shell_env       `$SHELL -ilc env` 抓一次登录环境
  supervisor      进程组、孤儿回收、临时目录清理、结构化日志、诊断导出
```

### 00.4 切片清单（按依赖顺序；每片含目标 / 删除 / 出口）

**片 0 · 治理与契约（半天）**

- 目标：`PRODUCT.md` 重写为 ≤150 行契约：目标用户、5 条核心旅程（接入已装 Agent → 首条消息 →
  审批 → 并行第二会话 → 退出重开续接）、页面清单、**术语表**（用户词 ↔ 工程词：Agent/会话/项目/
  需要你/在跑/已完成；禁止出现在 UI 的词：Runtime、Host、ACP、原生、绑定、代次、投影、占用、
  Working Copy、Session、Turn）、文案原则、出口标准。历史段落移至 `plans/history/product-log.md`。
- `AGENTS.md` 压至 ≤100 行：产品边界 + 开发纪律 + 指向本章；历史 Active Sequence 移至
  `plans/history/agents-log.md`。
- 出口：两个文件行数达标；AGENTS.md 新增「UI 禁用词」纪律与 D13 出口标准。

**片 A · ACP 客户端内核 spike + 事件流（2–3 天）**

- 目标：新增 `acp_client/`（官方 crate），用一个临时 CLI 测试程序对本机 `~/.opencode/bin/opencode acp`
  跑通 initialize → session/new → prompt → 流式 session/update → cancel；确认 `_meta` 扩展帧不被拒。
  建立 `event_bus`（Tauri Channel 单一事件流）与 `shell_env`。
- 删除：无（spike 阶段不删）。
- 出口：spike 记录（成功/失败 + 决策 D11 落定）；三 Agent 的 initialize 响应原文存入 `research/acp-handshakes/`。

**片 B · Agent 目录与接入（3 天）**

- 目标：`agent_catalog` + `agent_install`：拉 registry.json（缓存 3h）；本机发现覆盖 login-shell PATH、
  `~/.opencode/bin`、`~/.local/bin`、`~/.npm-global/bin`、nvm、Homebrew、`/Applications/*.app`
  内 CLI；自定义 `command/args/env`；registry binary 下载与 npx 私有安装。`meta_store` 新 schema
  （`agents`、`sessions`、`settings`），**不写迁移**，旧库直接弃用（首次启动重建）。
- Settings「Agent 接入」页：F 稿 agent-card（未接入：`连接 X`；已接入：版本/状态/三能力开关，其中
  LifeModel 两项本阶段禁用并标「即将推出」）。
- 删除（Rust）：`runtime_registry.rs`、`codex_installation.rs`、`managed_provider.rs`、
  `acp_provider_profile.rs`、`acp_client_resources.rs`、`host_store/system_installation.rs`、
  `host_store/runtime_owned_profile.rs`、`host_store/provider_projection.rs`、
  `host_store/native_model_selection.rs`、`capability_authority.rs`、`runtime_supervisor.rs`（并入
  新 supervisor）。
- 删除（前端）：`RuntimeChooser`、`ManagedRuntimeInstallationDialog`、`CodexInstallationDialog`、
  `OpenCodeProviderSettings`、`ProviderSettings*`、`ProviderAuthPrompt`、`ProviderCatalog`、
  `CustomProviderForm`、`ManagedProviderEditor`、`PiNativeAuthentication`、`CodexConfigureSection`、
  `CodexConnectionPanel`、`runtime/managed-*`、`runtime/provider-*`、`runtime/runtime-capability`、
  `runtime/codex-installation`、`runtime/pi-native-auth`。
- 删除（资源/脚本）：`src-tauri/codex-acp-adapter/`、`src-tauri/pi-acp-adapter/`、
  `resources/pi-runtime/`、`resources/pi-capabilities/`（Node 移入 `resources/node-runtime/`）、
  `scripts/fetch-pi-sidecar.sh`、`prepare-capability-bridge.sh`、`pi-*-wrapper.sh`、全部 `*probe*`/
  `*spike*` 脚本、`tauri.conf.json` 对应 resources 条目、`package.json` 的 `prepare:*` 与
  pi-acp-adapter build/test 步骤。
- 出口（安装版）：Settings 里看到本机 OpenCode 1.15.x / Codex / Pi 被自动发现并显示版本；
  点「连接 Codex」经 registry 安装 `codex-acp` 成功；三者状态均为「已连接」。截图。

**片 C · 认证（1–2 天）**

- 目标：`authMethods` 渲染；`agent` 型 → `authenticate`（Codex ChatGPT 登录跳浏览器）；`terminal` 型
  → 内嵌 PTY 终端（`pty` 模块 + xterm.js）跑登录并在退出码 0 后重连。可选 env 注入（API key）
  存 keychain。
- 删除：`codex_acp/configure*`、`pi_acp/native_auth.rs`、`pi_acp/configure.rs`、前端 `codex-acp-configure*`、
  `runtime/pi-native-auth*`。
- 出口（安装版）：已在终端登录的 Codex 无需再登录即可建会话；退出登录后走 ChatGPT 登录重新接上。截图。

**片 D · 会话与 Thread UI（5–6 天，最大片）**

- 目标：按 F 稿实现一套 Shell + Thread：Sidebar 会话流（项目分组、需要你/在跑排序、⋯ 菜单
  重命名/归档/删除）、顶栏切换器（新会话选 Agent+模型 via configOptions；会话内不可改）、
  Transcript（用户/Agent/步骤流/审批卡/沉降行+5s 撤销/本轮产物行）、Composer（文本、图片粘贴
  按 `promptCapabilities.image` 显隐、`@` 文件引用 → resource_link、运行中排队、Stop）、
  `session/request_permission` 审批卡（批准/批准并记住/拒绝）、空态/开始页、⌘K 命令面板、⌘N、
  状态栏。会话索引写 `meta_store`；历史用 `session/load`；支持 `session/list` 的 Agent 做对账。
  多会话并发：同一 Agent 进程内多 session，切换不打断。
- 删除（Rust）：`session_controller.rs`、`turn_coordinator.rs`、`runtime_event_router.rs`、
  `interaction_registry.rs`、`live_session_projection.rs`、`acp_session_operations.rs`、
  `host_runtime_adapter.rs`、`codex_acp*`、`pi_acp*`、`pi_acp_interactions.rs`、`codex_interactions.rs`、
  `opencode_acp*`、`opencode_question_acp_adapter.rs`、`host_store/session_*`、`turn_changes.rs`、
  `working_copy_manager.rs`、`managed_worktree_removal.rs`、`project_relocation.rs`、`session_attention.rs`、
  `host_store/migrations/`（新 schema 从 v1 起）。
- 删除（前端）：`PiPanel`、`OpenCodePanel`、`CodexPanel*`、`runtime-panel-registry`、`Workspace.tsx`（重写）、
  `WorkspaceHeader`、`SessionStartPanel`、`SessionOpeningPanel`、`SessionContextPanel`、`CodexTranscript`、
  `CodexInteractionPanel`、`CodexAcp*`、`OpenCodePermissionCard`、`PiActivity`、`ProjectReadinessCard`、
  `TurnChangesSection`、`ManagedWorktreeDialog`、`WorkingCopyManagerDialog`、`ExtensionDialog`、
  `ModelPicker`（并入切换器）、`HostShadowQaBadge`、`HostActivationNotice`、`runtime/codex-*`、
  `runtime/pi*`、`runtime/opencode*`、`runtime/conversation*`、`runtime/capabilities*`、`runtime/commands*`、
  `runtime/host-*`（除 `host-storage` 改为 `meta-store`）、`runtime/native-*`、`runtime/use-native-*`、
  `runtime/session-*`、`runtime/turn-changes*`、`runtime/working-copy*`、`runtime/workspace-contract`、
  `runtime/acp-adapter*`；`styles.css` 重写（按 F 稿 token）；所有 `VITE_FARFOLD_*` 引用。
- 出口（安装版）：旅程 1–4 全部走通（三 Agent 各建一会话、发消息、看到流式回复与步骤流、处理一次
  审批、OpenCode 跑任务时切到 Codex 会话并发送、返回时 OpenCode 仍在跑）。截图 ≥6 张。

**片 E · 客户端能力与产物窗格（3–4 天）**

- 目标：`fs/read_text_file`、`fs/write_text_file`（写入经 Farfold，产生 diff 记录）、`terminal/*`
  （PTY 创建/输出/等待/kill/释放）、`elicitation/create`（表单型）。产物窗格：diff（来自 fs 写入与
  `tool_call` diff 内容）、终端输出、日志；步骤流条目可点开产物。
- 删除：无新增删除。
- 出口（安装版）：Agent 经 Farfold 终端跑 `npm test` 并在步骤流看到实时输出；一次文件改动在产物窗格
  看到 diff。截图。

**片 F · 生命周期、诊断与收尾（2 天）**

- 目标：`supervisor`：进程组 kill、启动时回收上次遗留进程（pidfile）与 `/tmp/farfold-*`；空闲进程
  回收；结构化日志（`~/Library/Logs/Farfold/`）+ Settings「通用」页的「导出诊断」；崩溃恢复：重启后
  会话索引存在但 `session/load` 失败 → 会话行标「无法恢复」而非空会话。Settings「通用」：外观、
  自动归档、更新、版本。LifeModel 页静态实现（D8）。
- 删除：`update_recovery.rs`/`managed_update.rs` 中与旧 Host 数据备份耦合的部分（保留 Tauri updater）；
  根目录 `Farfold-Gate0-深度审计.html`、`P6-QA.md`、`design-qa.md`、`phase3-component-*.json`、
  `.trae-cn/`、`output/`、`agent-reports/`、`.design_library/`（设计稿 `.design/` 保留并入库）。
- 出口（安装版）：旅程 5（退出重开续接）走通；杀掉 Farfold 后 `pgrep opencode|codex|pi` 无残留；
  诊断包可导出。全仓 `rg -i "runtime|host|acp|原生|绑定|代次|投影|占用|Working Copy"` 在
  `src/components` 用户可见字符串中为 0 命中。

### 00.5 依赖与并行

```
0 ──► A ──► B ──► C ──► D ──► E ──► F
            │              ▲
            └── Settings UI 可与 A 并行（静态数据）
```

C 与 D 的前半（Sidebar/空态/Settings 壳）可并行；E 依赖 D 的步骤流。总计约 17–20 个工作日。

### 00.6 删除总账（阶段末必须为零引用）

Rust：43 个顶层模块中预计保留 `lib.rs`、`main.rs`、`host_ids.rs`（精简）、`lifemodel.rs`、
`transport_security.rs`、`ui_transport.rs`、`performance_trace.rs`、`update_*`（精简）、
`host_store.rs`（重写为 meta_store）、`host_store/records.rs`、`lifemodel_gateway.rs`、
`portable_export.rs`/`portable_import_activation.rs`（若仍需要备份导入，否则删）；其余全部删除。
前端：`src/runtime/` 预计保留 `lifemodel*`、`theme*`、`message-link*`、`performance-trace`、
`event-buffer`；`src/components/` 保留 `Sidebar`（重写）、`Composer`（重写）、`CommandPalette`
（重写）、`MessageContent`、`SessionDeletionDialog`、`SessionTitle`、`UpdateDialog`、`LifeModelPanel`
（改为 Settings 页）、`HostRecoveryScreen`（改名 `StorageRecoveryScreen`）、`WorkspaceError`。
每片出口用 `rg` 输出证明被删模块零引用，并在本章下追加「片 X 删除记录」。

### 00.7 风险与对策

| 风险                                                         | 对策                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 官方 Rust crate 与 Tauri/tokio 集成或 `_meta` 容忍度不达预期 | 片 A spike 先行；失败则手写传输 + schema crate 类型，不阻塞后续                             |
| `session/list` 覆盖不全                                      | D5 混合模式；UI 如实显示「该 Agent 不保留历史」                                             |
| terminal 型登录 UX（PTY + xterm.js 是新子系统）              | 片 C 先做 `agent` 型；terminal 型允许退化为「在系统终端打开命令」的兜底按钮                 |
| `terminal/*` 客户端能力工作量                                | 片 E 先 `fs` 后 `terminal`；`terminal` 未完成前 initialize 不声明该能力，Agent 走自身 shell |
| 治理文档反噬                                                 | 片 0 先行；AGENTS.md 加「UI 禁用词」与 D13                                                  |
| 删除后测试覆盖归零                                           | 每片以 3–5 条产品行为测试（真实 ACP 进程的集成测试，非 mock）替代，加安装版旅程截图         |
| Pi 上游 `pi-acp` 能力不足                                    | 按「不支持」显示；不再 fork                                                                 |

### 00.8 阶段纪律（替代旧 §0.4/§0.5，所有 Agent 必读）

1. 任何 Agent 专属逻辑出现在 `acp_client`/Thread UI 之外即为违规；差异只能来自 capabilities/configOptions。
2. UI 字符串不得含术语表禁用词；PR 前 `rg` 自查。
3. 不新增 `env`/`VITE_` 开关；不新增 SHA/版本 pin；不新增 fail-closed 占位。
4. 单片代码 ≤ 1.5k 行/文件；新增模块超限即拆。
5. 每片出口先跑安装版旅程再写记录；记录只写「做了什么、旅程截图路径、删除证明」，不写授权流水。
6. 遇到需要保留旧模块的诱因（「以后可能用」「有测试依赖」）一律删除并删测试；D9 不可协商。

### 00.9 执行方式

每片开始前进入 Plan 模式列出本片改动/删除的精确文件清单，用户批准后执行。片 0 与片 A 可合并为
第一次 Plan。本章下按片追加「完成记录」，格式：提交号 · 旅程截图路径 · 删除证明命令与输出摘要 ·
未达项。

---

## 0. （历史）重启：5 阶段 ACP 统一与 F-prototype 落地

### 0.0.1 阶段 1 完成记录（2026-09-17）

阶段 1 代码切片全部完成（A–G）。提交：`0a0d7c9`/`7f47537`（切片 B adapter 边界加固）、
`2699757`（切片 C：ACP ready/认证选模闭环 + 统一 `Workspace.tsx` + `OpenCodePanel`）、
`15fa78b`（切片 D：删除 OpenCode Server HTTP/SSE 旧路径，-8040 行）、
`91db7f3`（切片 E：修复 ACP transcript follow-scroll 依赖遗漏，`it.fails` 已转绿）、
`9286168`（切片 G：`RUNTIME_PANELS` 注册表收口统一 shell）。切片 F 的恢复闭环
（`session/load` 绑定校验、`require_opencode_recovery`/`stop_session_for_host_recovery`/
`finish_opencode_recovery`、冷启动 `restoreState` 恢复入口）在既有 ACP 实现中已满足，无新增代码。

验证：`cargo test` 535 通过/0 失败/33 忽略；`cargo clippy --all-targets` 与 `cargo fmt` 干净；
`pnpm typecheck` 通过；Vitest 397/397（无 expected-fail）；Pi ACP sidecar 192/192。

**已知缺口（必须在阶段 1 出口复核前补上）**：按 §0.3"先建后删"纪律，旧 Server 路径已在切片 D
删除，但**真实安装 Farfold.app 的 OpenCode ACP 完整闭环验收尚未执行**（安装/认证/选模/发送/
审批/停止/退出/续接）。当前全部为合成/单测证据，不能宣称产品可用。持久化的 Server 适配器
绑定会话现在 fail-closed 报"已移除的 Server 适配器"，不可续接，需归档后新建 ACP 会话。
LifeModel 注入未接入 ACP prompt（`context_text` 保留为 dead-code 待后续切片）。

### 0.0.2 阶段 2 完成记录（2026-09-17）

阶段 2（统一 Host 状态契约 + Adapter 注册表分发）全部切片完成。提交：
`cb20d81`（切片 1–3：`host_runtime_adapter.rs` 注册表 + `HostRuntimeAdapter` trait；
OpenCode ACP 完整实现；Pi RPC/Pi ACP/Codex Direct/Codex ACP 行为零变化 wrapper；
`session_controller` 的 open/create/stop 全部改走 `adapter_for_binding`/`adapter_for_create`/
`adapter_for_runtime_stop` 分发；`AcpRuntimeAdapter` 转同步签名，`OpenCodeAcpAdapter`
真实承担 spawn+initialize、`session/new`/`load`/`close`、prompt、cancel、config option
与客户端应答 dispatch），`8243b3d`（切片 4–7：统一 `host_turn_submit`/`host_turn_abort`
命令——代次由后端从 Runtime 读取，不再信任客户端 `runtimeGeneration`；OpenCode 保留
managed-provider 绑定字段，Pi ACP 代次/turnId 由活动 Turn 与连接推导；前端
`host-turn.ts` 统一入口，OpenCode/Pi ACP 面板已切换；删除调已删命令的
`reconcileOpenCodeHostSession`；`HostSessionStartOptions` 移除 Server adapterId；
bundled `opencode-runtime` 资源、fetch 脚本、prepare 入口退役，`OPENCODE_RUNTIME`
仅保留为持久化 Server 绑定的 fail-closed 身份）。

验证：`cargo test` 535 通过/0 失败/33 忽略；`cargo clippy --all-targets` 与 `cargo fmt`
干净；`pnpm typecheck` 通过；Vitest 396/396。

**行为保持**：Pi RPC/Codex Direct 的 turn 旧命令保留至阶段 4/5；`pi_acp_intervene` 等
runtime 特有命令不进共享面；`opencode-server-http-sse-v1` 持久绑定继续 fail-closed
（提示归档后新建），不做迁移；真实安装包验收为独立遗留项（见 §0.0.1）。

### 0.0.3 阶段 3 完成记录（2026-09-17）

阶段 3（统一 Workspace 前端收口）代码切片完成。先经 Plan 模式产出详案并经用户批准
（四项决策确认：占位+删旧 Workspace；最小删除——孤儿模块留阶段 4/5；通用 Transcript
推迟到阶段 4；出口含真实安装验收）。

- **契约硬化**：`Workspace.tsx` 的 `panelMeta`/`panelActions` 改为按 Runtime product
  键控的稳定槽位（Map），修复了「多 shared panel 会互相覆盖全局单槽 meta/actions」的
  潜在缺陷；侧栏 `onSelect` 合并为单一路径（修复 shared 会话不切换 runtime 的缺陷）；
  删除 `ownShellPanels`/`sharedShell` 判别与 `shell-inactive`/`aria-hidden` 分支；
  `archive`/`restore`/`togglePinned` 按会话自身 Runtime 路由到 panel action，未注册时
  走 `updateHostSessionMetadata` 共享 fallback；`RuntimeWorkspaceProps.onSelectHostSession`
  与 own-shell `hostChannel` 入参移除，`RuntimePanelProps` 新增 `product`。
- **占位 panel**：新增 `MigratingRuntimePanel`（零 IPC、不写 session focus——会话实际
  未打开不能伪造 mark_opened），Pi/Codex 注册为它；如实显示「迁移中」、保留会话记录
  可置顶/归档/删除、新建/打开/发送不可用；含三路 runtime 切换 select。
- **删除**：`PiWorkspace.tsx`（-3786 行）、`CodexWorkspace.tsx`（-919 行）及其两个测试
  文件；净 -4930/+132 行。**覆盖损失**：`CodexWorkspace-scroll.test.ts` 的
  follow-scroll 回归随删除失去保护，阶段 4 新 Codex panel 必须补等价用例。
- **保留（阶段 4/5 删除预算内）**：`pi.ts`/`pi-acp.ts`/`conversation.ts`/`capabilities.ts`/
  `commands.ts`、全部 `codex-*`/`codex-acp-*` 契约层、`CodexTranscript`、`ProviderSettings`
  等孤儿模块——按用户批准的最小删除边界，它们仍有引用计数为零但属下阶段地基/参考。

验证：`pnpm typecheck` 通过；Vitest 403/403（新增占位+shell 9 项）；Pi ACP sidecar
192/192；`cargo test` 535 通过/0 失败/33 忽略（零回归，本阶段未改 Rust）；
`cargo clippy --all-targets` 与 `cargo fmt` 干净；`pnpm tauri:build:internal` 产出
ad-hoc 签名 `Farfold.app` 并直接启动验证无崩溃。

**已知缺口（阶段 3 出口未完成项）**：新构建的 `Farfold.app` 已启动但**交互验收旅程
（OpenCode ACP 安装/认证/选模/发送/审批/停止/退出/续接 + Pi/Codex 占位核验）尚未走完**，
仍是 §0.0.1 遗留的同一缺口；`/Applications/Farfold.app` 未替换（等用户决定安装槽位）。
占位期 Pi/Codex 会话在 UI 完全不可打开（后端与数据不动，阶段 4/5 恢复）。
LifeModel 注入仍未接入 ACP prompt。

**评审修正（同日）**：复审发现 session 请求槽为全局广播、所有常驻 panel 都能消费，
且 `onRequestedHostSessionHandled` 无差别清空——OpenCode 忙时跨 Runtime 点击会被
占位 panel 抢走并静默丢弃，占位 panel 也会记住并展示异 Runtime 会话（原测试还把该
错误固化为规格）。已修：请求只路由给会话所属 Runtime 的 panel；确认按 session id
作用域清除，在途旧请求不覆盖新请求；占位 panel 增加 `runtimeProductId === product`
双保险与冷恢复 `restoredHostSession` 展示（Pi/Codex 冷恢复不再丢失会话上下文与侧栏
高亮，且不触发真实打开）；`archive`/`restore` fallback 失败经 `setError` 可见；
`shellActions` 改为每渲染同步 + 卸载清理，消除清空窗口；OpenCode 请求 effect 补回
`onRequestedHostSessionHandled` 依赖。Vitest 406/406、`pnpm typecheck` 通过。
占位页禁用 Provider 设置按钮属当前有意行为（无运行时配置可打开），待复核确认。

### 0.0.4 阶段 4 完成记录（2026-09-17）

阶段 4（Codex ACP 迁移 + Direct 全路径删除）代码切片完成，分四片提交：

- **4.A Adapter 生产化**（`69ef975`）：`codex-acp-adapter` 升 v0.2.0——`adapter.mjs`
  五个能力开关全开、移除网络黑洞代理；`core.mjs` `_meta` 契约放宽为生产描述，
  `_codex/account/read`/`_codex/thread/list` 诊断读放宽为真实回执；manifest 与
  Rust pin SHA 全套更新，`adapter.mjs` 的 `core.mjs` 兄弟 SHA 校验同步；打包进
  `tauri.conf.json` resources。`profile.rs` restore 断言放宽为生产 contract。
- **4.B 生产 facade**（`cf8d427`）：`codex_acp/operations.rs` `Entry::Production`
  gate 放开；新增 `Connect`（首 profile 创建 + 已持久化 profile 精确恢复 + 同
  profile/scope 幂等 + 拒绝静默替换不同 live 连接）、`Interact`（交互按 key 经
  InteractionRegistry 服务端解析，校验 binding/generation/pending/session 归属）、
  `Steer`（保留原生 turn 身份）；`ProductionOps` 收拢闭包过 Clippy。
- **4.C 前端统一 shell**（`2ba9d68`）：新 `CodexPanel`（694 行）接入统一 Workspace
  shell 与 `runtime-panel-registry`；新增 `codex-acp-operations.ts` 生产操作包装；
  SessionStart 改 Connect-first 流程；workspace 快照支持未绑定页且能力如实投影
  （合成 receipt 不再开通生产操作）；新增 `CodexPanel-scroll.test.ts` 滚动跟随
  回归（补齐 §0.0.3 记录的覆盖损失）；迁移占位文案全部替换为如实 ACP 状态说明。
- **4.D Direct 删除 + fail-closed**（`c7a1679`）：删 `codex_runtime/transport/
sessions/models/turns` 五个 Rust 模块及 8 个 Direct 命令、`runtime_supervisor_reset`；
  删前端 `codex-connection/-turn/-conversation/-session` 模块与 Direct 交互字段。
  `adapter_for_binding` 中 `codex-app-server` 绑定改为显式「已移除」错误；
  `adapter_for_create` 中 Codex 创建改为「须经 ACP 自有连接」错误。共享 Host
  生命周期（归档/删除/导入激活/managed update/安装 recheck/supervisor/投影）
  改为观察 ACP owned 连接状态；`interaction_registry` 删 Direct `codex` 字段与
  `observe_codex`；`codex_interactions` 作为 ACP 共享协议契约保留；新装登记
  `adapter_id` 改 `codex-acp-stdio-v1`；ACP 视图仅在 Host 报告 reply 开放时
  暴露原生交互 payload，关闭态保持无内容投影。净 −5608 行。

验证：Vitest 397/397；`cargo test` 518/518（32 忽略）；`cargo clippy
--all-targets` 与 `cargo fmt` 干净；固定二进制冒烟 5/5 通过（in-tree
`capability-bridge/runtime/node` + npm vendor `codex` 0.143.0 arm64，SHA 与
pin 一致，真实握手/首轮/恢复成功）；`pnpm tauri:build:internal` 产出
ad-hoc 签名 `Farfold.app`，`codex-acp-adapter` 已打包进 Resources。

**已知缺口**：真实账号登录/模型目录/任务闭环的**交互验收尚未执行**（用户统一
验收待阶段 5 完成后进行）；`tsc -b` 曾捕获 ACP 转写 `userMessage` 死分支
（`AcpContentItem` 无此类型，已删，限制说明已覆盖「用户输入可能未恢复」）。
Pi 会话仍为迁移占位（阶段 5 恢复）。

### 0.0.5 阶段 5 完成记录（2026-09-18）

阶段 5（Pi ACP 迁移 + 统一 shell + RPC 删除 + 文件拆分）代码切片完成，分五片提交：

- **5.A PiPanel 统一 shell**（`3f7aa44`）：新 `PiPanel` 移植旧 `PiWorkspace` 的
  ACP 半边——ACP 状态、workspace 读、Host 会话生命周期、typed Host Turn 命令、
  ACP 事件投影、LifeModel source 采集；`pi-rpc-jsonl` 陈旧绑定在 UI fail-closed
  不再静默迁移；`MigratingRuntimePanel` 文案同步如实化。
- **5.B Pi RPC 后端删除**（`941f440`）：删 `pi_runtime`/`pi_capabilities` 生产
  实现与 RPC 命令面；`PI_RUNTIME` 退役，`PI_ACP_RUNTIME`（`pi-acp-stdio-v1` /
  `bundled-pi-acp` / `pi-acp@0.84.3`）成为唯一 Pi 身份；Host 生命周期（归档/
  删除/导入激活/project relocation/session_open/managed_provider/capability
  authority/supervisor/interaction_registry/live_session_projection/turn_
  coordinator/lifemodel source 重读）全部改经 ACP owned 连接；修复一处归档守卫
  把 `bundled-pi-acp` 会话误判为 RPC 的既有 bug；project readiness 内聚进
  `runtime_host`。持久化的旧 `pi-rpc-jsonl` 绑定仅作历史可读 fail-closed，
  新建会话一律 ACP。净 −6002 行。
- **5.C 前端 RPC 收口**（`0c3efb8`）：删 `runtime/pi.ts` RPC 调用面、
  `capabilities.ts` settle/login 旧路径、`reconcilePiHostSession`/
  `stopHostPiRuntime`；`activatePiSession` 改 `applyAcpStatus`；
  `parseLifeModelSources` 改为消费 ACP `Entries`（leafId + native entry id +
  时间戳 + user 角色 + 文本缺一不可入源）；`MigratingRuntimePanel` 退役；
  全部迁移测试改写为 ACP-only fixture（25 个激活用例等）。
- **5.D pi_acp.rs 机械拆分**（`d9b8a62`）：7,706 行单文件按 `codex_acp/`
  模式拆为 `pi_acp.rs` 根（共享类型/连接/ACP 事件映射/再导出，403 行）+
  `admission`/`configure`/`interactions`/`sessions`/`turns`/`workspace`/
  `native_auth` 子模块（最大 619 行），测试独立为 `pi_acp/tests/`
  五文件（最大 1.6k 行），全部文件满足 ≤2k 行约束；根 re-export 保持
  `crate::pi_acp::X` 调用路径稳定，命令注册指向所属子模块；`include_bytes!`
  适配器资源路径按新模块深度修正；仅机械移动，无语义变更。
- **5.E 验证**（`2b6ec37`）：发现两个 fixed-Pi 冒烟测试把未 canonicalize 的
  `temp.path()`（macOS `/var` 符号链接）传给 `prepare_owned`，真实 adapter
  的 `assertPrivateAuthProfile` 祖先目录遍历据此拒绝 `session/new`——拆分
  前已存在的测试缺陷，已修复为 canonical 路径。

验证：`cargo test` 465/465（32 忽略）；Vitest 71 文件 375/375；`tsc -b`
干净；`cargo clippy --all-targets` 与 `cargo fmt` 干净；固定二进制冒烟
9/9 + contract 1/1 通过（`pi-capability-runtime/runtime/node` SHA =
`5d9d3872…` = NODE_SHA256 pin；`resources/pi-runtime/pi` SHA =
`e844dc14…` = PI_RUNTIME_BINARY_SHA256 pin；真实 adapter 握手、
session/new、config apply、native auth、prompt、冷恢复、workspace
entries/state/messages/models/thinking_levels/commands/stats 全 section
读成功，无任何真实模型请求）；`npm run tauri:build:internal` 产出
ad-hoc 签名 `Farfold.app`（213MB），`pi-acp-adapter/index.js`、
`codex-acp-adapter/`、`pi-runtime/pi`（SHA 复验一致）、
`pi-capability-runtime/runtime/node`（SHA 复验一致）全部打包；
`pi-capability-runtime` 资源收窄为仅 `runtime/`（剔除 RPC 时代
`bridge.mjs` + node_modules，bundle −135MB）。

**已知缺口**：真实账号登录/模型目录/任务闭环的**交互验收尚未执行**（用户统一
验收在此记录之后进行）；遗留 `pi-rpc-jsonl` 持久化绑定只读 fail-closed，不做
迁移；打包仍带 RPC 时代 `pi-capability-wrapper.sh`/`pi-sidecar-wrapper.sh`
密封脚本资源（有测试断言存在，未动）。

### 0.1 用户要求（2026-09-17 对齐）

1. **统一 ACP**：以 ACP 作为 Runtime 与 Farfold Host 的唯一集成面，不再保留 Direct / Server / JSONL RPC 旧路径。
2. **依次推进**：先建成一个 Runtime 的完整 ACP 闭环作为模板，再复制到第二个、第三个。
3. **删除/退役旧代码**：当前产品开发阶段无用户试用，旧实现可以删除；删除前必须先验证同一 Runtime 的 ACP 路径真实可用。
4. **F-prototype 落地**：用一个统一 Workspace shell 替代 `PiWorkspace` / `OpenCodeWorkspace` / `CodexWorkspace`。
5. **不犯旧问题**：把此前开发中发现的问题写入纪律，每个 Agent 必须遵守。
6. **关键节点防幻觉**：每个阶段出口必须检查真实证据，不允许用合成/测试通过冒充产品可用。
7. **先计划后开发**：每个大阶段开始前，必须先进入 Plan 模式，产出该阶段的详细计划，用户批准后方可进入 Normal 模式开发。

### 0.2 5 阶段路线

| 阶段  | 目标                               | 主要产出                                                                          | 允许删除的旧代码                                                            | 验收标准                                                                               |
| ----- | ---------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **1** | OpenCode ACP 成为唯一模板          | `RuntimeAdapter` trait、`HostEvent` 统一事件、OpenCode ACP 完整闭环               | `opencode_runtime.rs`、`opencode_protocol.rs`、旧 `opencode.ts`             | 在干净 `Farfold.app` 上一次真实任务完整闭环（安装/认证/选模/发送/审批/停止/退出/续接） |
| **2** | 统一 Host 状态契约                 | `host_store` 统一 `Session`/`Turn`/`Event`、`use-host-workspace` 唯一入口         | 各 Runtime 旧 session/turn DTO、冗余表结构                                  | OpenCode 在统一 Host 上仍通过完整流程；新增 Runtime 只需实现 `RuntimeAdapter`          |
| **3** | 统一 Workspace 前端（F-prototype） | 唯一 `Workspace.tsx`、通用 `Sidebar`/`Transcript`/`Composer`、`RuntimePanel` 插件 | `PiWorkspace.tsx`、`OpenCodeWorkspace.tsx`、`CodexWorkspace.tsx`            | OpenCode 在新 UI 下完整可用；Codex/Pi 显示"迁移中"占位                                 |
| **4** | Codex ACP 迁移                     | `codex_acp/` 对齐 OpenCode 模板、接入新 Workspace                                 | `codex_runtime.rs`、Codex Direct 路径、旧 `codex-*` 前端模块                | Codex 在新 UI 下完整可用；滚动缺口修复                                                 |
| **5** | Pi ACP 迁移                        | `pi_acp` 补齐、接入新 Workspace                                                   | `pi_runtime.rs`、JSONL RPC 路径、旧 `pi.ts`/`conversation.ts`/`commands.ts` | Pi 在新 UI 下可用；三路 ACP 都在统一 Workspace 中                                      |

### 0.3 旧代码删除/退役规则

1. **先建后删**：旧路径只能在同一 Runtime 的新 ACP 路径真实跑通后删除。
2. **按 Runtime 删**：允许删除 OpenCode Server 旧路径，但不得同时删除 Pi RPC 或 Codex Direct。
3. **不保留兼容层**：旧路径删除后不再恢复；历史会话若无法迁移则明确提示"无法恢复"，不伪造空会话。
4. **以最新为准**：删除后若发现新 ACP 仍缺某项能力，按"不支持"处理，不回退旧路径。

### 0.4 已知开发问题与禁止项（提醒 Agent）

从 2026-08 至 2026-09 的开发中暴露以下问题，后续 Agent 必须避免：

1. **合成证据冒充真实验收**：单元测试、静态 mock、fixture 通过不等于产品可用。阶段出口必须在真实安装 `Farfold.app` 上验证。
2. **双轨路径无限并行**：不得在未删除旧路径的情况下继续加新路径。新 Runtime 接入必须以一换一。
3. **文件膨胀**：`pi_acp.rs` 已膨胀到 7.7k 行。新 adapter 必须按 `admission`/`configure`/`sessions`/`threads`/`turns`/`workspace` 子模块拆分，不允许单文件超过 2k 行。
4. **三个独立 Workspace 重复实现**：前端不得为每个 Runtime 复制 `Sidebar`/`Composer`/`Transcript`/`WorkspaceHeader`。
5. **不统一的 effect 依赖**：`CodexWorkspace-scroll.test.ts` 的 `it.fails` 证明滚动 effect 依赖遗漏。任何 UI 状态更新必须显式声明在依赖数组中。
6. **能力推断错误**：不能把 `account ready` 推断为 `model ready`，不能把 `ACK` 推断为 `settled`，不能把 `stop requested` 推断为 `task stopped`。
7. **侵入 Host 的 Runtime 特殊语义**：Runtime 特有能力（如 Pi steer/follow_up）只由 adapter 翻译，不得污染 `turn_coordinator` 或 `session_controller`。
8. **添加环境变量 / URL 绕过**：生产 gate 必须 fail-closed，不得用 `env` 或 `VITE_` 开关绕过。

### 0.5 关键节点幻觉检查点

每个 Agent 在以下节点必须自检，并在修改说明中回答：

- [ ] 当前切片是否只涉及一个 Runtime 或一个前端模块？
- [ ] 当前修改是否让旧路径产生新依赖？
- [ ] 新增的能力是否有真实 ACP 协议或官方 CLI 支持？
- [ ] 测试通过是合成证据还是真实安装应用证据？
- [ ] 是否引入了新的 `env`/`URL`/`cfg(test)` 绕过生产 gate？
- [ ] `host_ids` 是否正确区分 `runtime_product_id`/`installation_id`/`build_id`/`adapter_id`/`connection_id`？
- [ ] 是否把 `ACK`、`ready`、`observed` 误当作 `settled` 或 `verified`？
- [ ] 新增代码是否超过 2k 行而没有拆模块？
- [ ] 是否保留了 `it.fails` 或 TODO 而不报缺口？
- [ ] 是否在 `AGENTS.md` 或 active plan 中记录了该阶段的 first failure 与修复方式？

### 0.6 每个大阶段的 Plan 模式要求

- 每个阶段开始前，Agent 必须先进入 **Plan 模式**。
- Plan 阶段任务：
  1. 读取本计划第 0 章与第 0.x 节。
  2. 探索当前代码状态，标出需要改动/删除/保留的具体文件。
  3. 输出该阶段的切片清单、依赖关系、风险点、验收标准。
  4. 用户批准后再切换回 Normal 模式执行。

### 0.7 阶段 1 的第一片（建议入口）

阶段 1 再拆为 3 个可验收小切片：

1. **OpenCode ACP 认证/选模闭环**：安装/认证/完整 catalog/显式模型选择。
2. **OpenCode ACP 发送/停止闭环**：`session/prompt` → 流式事件 → `session/cancel` → 终态结算。
3. **OpenCode ACP 恢复闭环**：退出 → 重启 → `session/load` → 续接同一 Session。

完成第 3 片且真实安装应用验收后，方可删除 OpenCode Server 旧路径，进入阶段 2。

### 0.8 已核验的 OpenCode ACP 协议面（计划更正 · 2026-09-17）

阶段 1 详案原本假设 OpenCode ACP 暴露 `account/login`、`account/apiKey`、`account/deviceCode`、`models/list`。
**代码核查证明这些端点属于 Codex，不属于 OpenCode。** 已在实现前更正，未写入任何生产代码。

证据：

- `account/*` 只出现在 `src-tauri/src/codex_runtime.rs` 与 `src-tauri/src/codex_acp.rs`（如 `_codex/account/read`、`account/login/start`）。
- `src-tauri/src/opencode_acp.rs` 全文只使用 7 个 ACP 方法：`session/update`、`session/prompt`、`session/cancel`、
  `session/set_config_option`、`session/new`、`session/load`、`session/close`，外加 `initialize` 与入站 `session/request_permission`。
- 仓库中不存在任何 `models/list` 调用。

OpenCode 的真实认证/选模机制：

1. **认证 = Farfold 写私有配置文件**，不是 ACP RPC。`acp_provider_profile.rs` 把 endpoint + API key 写入私有
   `config/opencode.json` 与 `xdg-config/opencode/opencode.json`，再用 `env_clear` + 私有 `HOME`/`XDG_*` 启动 sidecar。
2. **目录/选模 = `configOptions`**。`session/new` 与 `session/load` 的响应带 `configOptions`；`type: "select"` 项即模型列表。
   切换模型用 `session/set_config_option`，其响应回带更新后的 `configOptions`。
3. **确认 = `acp_config_options_select_target()`**，校验 native `configOptions.currentValue` 等于 Farfold 期望的
   `runtime_model_id`，否则拒绝并不写 projection。

因此：不新增 `account/*` 或 `models/list`；不实现 browser/device 登录（无真实协议证据前按"Runtime/协议不支持"标记）；
`ready` 需同时满足"安装已核验 + 私有配置已写入 + native `configOptions` 已确认目标模型"。
`opencode auth login` 属于 OpenCode 自己的 CLI 交互流程，不是 ACP stdio 端点，Host 内不得当作 ACP 能力使用。

## 0A. 当前执行入口（历史 · 2026-09-16 停点）

当前停点（2026-09-16，用户额度暂停）：用户要求就近暂停，本任务立即停在上一片已复核、下一片尚未实施的边界。只读history/正文已获协调FE25/25、Rust Turn facade12/12认可；Composer发送/活动Stop片仅同步授权文档，并以确定性源码依赖测试复现滚动effect只依赖conversation、未依赖ACP transcript（1项失败），未改生产代码。回归以显式it.fails保留为已知未修缺口，不计修复完成；续接先去掉expected-failure并最小补滚动，再按下段已批准有限范围实施。暂停后不继续开发/全量检查/构建安装/真实调用，不自启下一片；等待用户恢复。详细首败与精确续接项见实施记录末节。

最新授权（2026-09-16）：只读正文协调独立FE25/25、Rust Turn facade12/12通过。继续Composer发送/活动Stop静态mock有限片：复用现有CodexWorkspace/Composer、共享Session草稿、typed backend/Turn facade及Host唯一泵；生产Host/Adapter/UI capabilities全关，无env/URL绕过。精确原persisted Session/scope/草稿一次dispatch，同步防重复，切Session/代次退休回执；后续编辑不得被晚成功清除，失败/unknown不自动重发或虚报未发送。Stop用原Host/native Turn，ACK只已请求，Host snapshot/终态才控制活动；关页/返回不Stop/重发。先确定性复现ACP正文未触发follow滚动，再最小补齐，保留用户上滚/Direct语义。定向行为测试与真实组件静态mock覆盖上述竞态，不开reply/steer，不做真实Runtime/profile/账号目录模型、构建安装、现有DB/生产Adapter/schema/pin/旧controller变更。首次profile/真实restore、生产异步调度及跨代unknown对账仍后续，完成交协调复核。

最新结果（2026-09-16）：只读history/安全实时正文有限片完成，交协调复核。沿原read_turn_history、共享router非消费snapshot及读取前cursor，复用backend/view和单CodexTranscript的独立typed ACP展示；不伪装Direct DTO或复制旧reducer。原scope/Session/thread/tree/Turn/item及sequence校验、重复去重、有界缓存、迟到读取退休；缺口/断线/换代如实不完整。历史Host Turn ID不可恢复，不造映射；缺用户输入/command/output/diff明确展示。前端406/406、定向Rust67/67、生产lib Clippy及类型/格式/diff通过；真实组件静态mock验证活动输出、关闭返回不Stop、gap、终态历史不重发及切Session迟到拒绝，旧Direct模型/草稿保持。首次三项红测及最小修正详见记录。Composer发送/Stop/reply/steer和生产gate全关；无真实Runtime/profile/账号模型/既有DB/安装/生产Adapter/schema/pin/旧controller变化。首次profile/真实restore、生产异步调度、reply/steer与跨代unknown对账、安装验收仍缺，等待复核，不自行开下一片。

最新授权（2026-09-16）：Turn facade/唯一Host泵协调独立FE14/14、Rust facade11/11通过（协调首次filter匹配0项不计覆盖）。下一有限片接只读history/typed事件到现有正文，复用read_turn_history、shared router非消费snapshot、原backend/view和单CodexTranscript；必要时抽小展示数据结构，不伪装Direct DTO/复制旧reducer。可加原Session history的硬关闭Host operation。原scope/thread/tree/Turn/item及有界sequence关联快照/实时，重复不重复显示，gap/断线/换代不声称完整或settle，不重发prompt；缺command/output/diff如实标注。先只读正文/状态，不开Composer发送/Stop/reply/steer。若router身份/cursor不足则报告窄边界/缺口，不建持久账本。定向tests+真实组件mock，无真实Runtime/profile/账号目录模型/既有DB/安装/生产Adapter/schema/pin/旧controller变化；首次profile/异步生产调度/真实restore及跨代unknown对账仍后续，完成交复核。

最新结果（2026-09-16）：闭态Turn发送/活动Stop/Host事件消费有限片完成，交协调复核。原operations facade只收scope、Host Session、有界text及Stop原Host/native Turn，目标/immutable选择/Provider observation和双Turn/WC排他仍由原共享权威核对。原poll事件路由/终态结算机械抽到Connection，复用公共ACP泵；一连接一个消费所有者，UI/raw reader不能另drain，早到事件等已核验receipt身份后处理。页面不在也结算；ACK不结算，错scope/断开/超时/退休保持原unknown占用，交互仍走旧注册路由但不开reply/steer。前端392/392，E+共享Rust145通过/5既有忽略，Pi/OpenCode64通过/17既有忽略，Node23/23，最后补来源/跨代占用断言后facade11/11，生产lib Clippy、app/node类型、格式/diff通过。首败与固定协议不读实时model/effort边界保留在记录。生产Host/Adapter/UI全关，无真实Runtime/profile/账号模型/既有DB/安装/生产Adapter/schema/pin/旧controller变化，仅合成server测试夹具加迟到ACK模式。正文UI/完整history/reply/steer、首次profile/真实restore与生产异步调度仍未完成，不能靠当前同步synthetic facade宣称生产调度完成；等待复核。

最新授权（2026-09-16）：final navigation协调独立13/13与前轮Rust focus6/6通过，可记闭态Session/UI/shared navigation合同已核验，不宣称最后读后CAS/安装可用。下一有限片只做已有共享Host Turn发送/活动Stop/事件终态消费typed操作接线，先Rust facade与必要typed backend、无网络合成验收，暂不改正文UI。复用start_turn/interrupt_turn/poll_turn_events、TurnCoordinator、Session占用和RuntimeEventRouter；必须唯一连接事件消费者、页面不在也能结算，不用UI轮询伪装Host闭环。只接收原scope/Host Session/有界text及Stop原Host/native Turn，原target/model/provider由共享权威核验。ACK不结算，未知不释放重发；保留已有交互路由但不开reply/steer。不改schema/Adapter/pin，不做真实profile/native/账号模型、完整history/UI、安装或生产异步调度。若共享泵需结构重写或固定Adapter缺合同先带事实回报。生产全部关闭，完成交复核。

最新收尾结果（2026-09-16）：finalContext 已观察新导航却应用旧focus快照的两个 current=true 反例已复现（9通过/2失败）并最小修正。替换UI导航前，精确比较 final raw 的项目/Session/updated_at 与本次focus已提交tuple；不同Session和同Session更高时间均拒绝旧结果，不回滚合法提交、不重试focus/native或刷新token。entry+metadata定向13/13；静态夹具同步维护成功focus的当前Session。仅前端有限补丁，生产全关，无Rust/Adapter/schema/真实调用/现有数据/安装变化，交协调复核。详细首败与验证见实施记录末节。

最新收尾复核（2026-09-16）：协调认可持久guard方向并独立entry+metadata11/11，要求同片窄前端反例：A合法commit后B再commit，A的finalContext已观察新raw tuple仍不可replace旧导航。current=true验证另一Session和同Session更高updated_at；复现后仅精确比较final raw与本次focus提交tuple。不回滚合法commit、不重发focus/native、不换token追赶、不扩导航系统，定向通过后交回，生产全关。

最新修正结果（2026-09-16）：持久focus有限修正完成，交协调复核。ACP改由原硬关闭operations facade受保护focus，不再走无guard的host_session_focus；Session操作前捕获raw app_state期望（缺行与含None的行分开），晚回执不刷新令牌。既有共享mark-opened Immediate事务内比较导航期望、原target/immutable model/owned generation与launch；原controller/connection锁贯穿当前scope/native双身份/actual核对至提交。冲突不改app_state或last_opened，旧Pi/OpenCode/Direct无guard语义保持。原0/1覆盖红测转绿；共享store/Runtime/E组合242通过/22既有忽略，前端382/382，生产lib Clippy与类型/格式/diff通过。临时夹具补测误触已有immutable触发器的首败保留，未削弱schema；无新schema/计数器/导航状态机/补偿写或真实profile/native账号模型/现有DB/安装/Adapter/pin变化。仅保证Host已观察冲突；合法提交后才到达的新意图不回滚，迟到UI回执仍退休。详细边界和证据见实施记录末节，等待复核。

最新复核与修正授权（2026-09-16）：协调entry+metadata独立9/9，但不批准完整activation合同：mark_opened先commit后JS校验，旧focus能覆盖新重启恢复目标。仅批准同片最小修正：先红测A旧期望/B已提交/A晚focus不得覆盖，再在既有共享Immediate事务加入可选typed guard，ACP沿原硬关闭operations facade受保护focus。比较原始app_state项目/会话/updated_at（含缺行/None），不拿归一化restore当令牌；当前scope/handle/native双身份/immutable选择与持久owned代次须提交前验证。无新schema/计数表/导航状态机/补偿写，旧无guard语义不变；仅保证Host已观察冲突，不声称未送达用户意图的跨进程CAS。其余代码保留，生产全关，无真实数据/profile/native/账号模型/安装；修正完成再复核。

最新结果（2026-09-16）：闭态Session入口/shared navigation有限片已实现，交协调复核。现有CodexWorkspace/SessionStartPanel复用已登记安装与WC、当次私有choice和共享session-opening/草稿；新增只读精确owned launch上下文，绝不创建/恢复profile。一次typed start/open后重读shared index/原tree/actual与scope，再沿原focus导航激活，不伪造Direct DTO、不二次native open。切Session/项目/代次/选择退休迟到结果，失败不自动再试。普通capabilities全部false，只有静态mock组件可操作。前端380/380、E operations/workspace/threads44/44、生产lib Clippy通过；收尾复用opening文案后定向22/22和类型/格式/diff通过。首次profile/真实启动恢复与异步生产调度、Turn/history/events/reply/Stop/steer仍缺；无真实Runtime/账号模型/既有DB/安装/Adapter/schema/pin或旧controller改动。共享focus是既有metadata写入，不是native代次与SQLite原子CAS；迟到聚焦回执不应用UI，不声称撤销已提交的focus元数据。此限制及首败/静态验证详见实施记录，等待复核。

最新授权（2026-09-16）：workspace接纳协调独立6/6复核通过，连同此前Session前端11/11、operations21/21进入闭态Session入口/shared navigation有限片。复用CodexWorkspace/SessionStartPanel、共享Project-WC选择与原session-opening/navigation/草稿；新建贯通精确已有owned scope/launch关系、WC和当次choice，原open仅Host Session ID。typed receipt后重读共享binding/index精确核对再激活，不伪造Direct DTO、不二次native open/start；切Session/项目/WC/代次/选择退休晚回执，未知不重试/fallback。必要上下文仅typed只读既有精确关系，不启动profile。真实组件只由静态mock IPC操作，生产Host/Adapter/capabilities仍关，无env/URL开关。禁止首次profile/真实restore账号目录模型任务/安装/schema/Adapter/pin与Turn/history/events/reply/Stop/steer。若导航需实质重构或WC需另系统，停在小接线层报告；完成交复核。

最新结果（2026-09-16）：workspace 接纳有限复核已修正并提交协调。真实临时 Git root/外部 linked worktree 无 managed 行的合法语义保留；仅已有 managed 行要求 worktree/ready、项目/分支/来源一致且来源非自身，无 removal。本次已观察的来源元数据加入既有内存投影，登记前及原子事务内同 helper 重读比较，记录消失/来源变化不能降级成外部 worktree；native 已 Start 后仍沿原 unknown 保留身份，不重试。不新增持久标记/schema，不推断历史托管状态。新增6项及 operations/threads/shared workspace-removal-records 定向61/61，生产lib Clippy、Rust2024格式/diff通过；两次确定性红测和命令检查差错详见实施记录。无前端/Adapter/pin、真实Runtime/profile/账号模型、现有DB或安装变更；生产全关，等待复核，不自行开始下一片。

最新澄清（2026-09-16）：协调确认保留合法外部worktree，不收窄E入口。此前把Worktree等同managed的假设已纠正；无m的root/外部worktree按既有语义保留，有m才要求worktree/ready/记录归属分支一致且无removal。实际临时Git root/linked成功对照、冲突及状态反例、start前零调用与start后unknown竞态完成后复核；不新增标记/schema/历史托管推断或Git策略。

最新复核跟进（2026-09-16）：协调前端session/backend11/11及operations21/21通过，暂不开放下一片；仅检查registered workspace对缺managed记录/非ready/root冲突/removal的接纳。真实schema为root|worktree、managed状态creating|ready|orphaned，failed属removal；外部linked worktree也用worktree，因此无m不能直接归因为数据损坏。先临时库确定性验证并核清本闭态E入口是否收窄，不扩大worktree平台/改schema/修用户数据，生产保持关闭。

最新结果（2026-09-16）：恢复的Session facade有限片完成，交协调复核。唯一typed Host operation新增start（共享WorkingCopy ID+当次明确选择）/open（FarFold Session ID），复用threads/open_registered_thread/原子登记、共享Host ID派生与事务内已有workspace核对；刷新清Host选择，不借Adapter残留selection。错误/迟到不重试不fallback，receipt只含原身份和选择，不开放任务。typed client/backend已有scope/绑定/视图寿命检查；普通Workspace、新建选择器、激活/导航路径未接，能力全关。前端372/372；共享store/相关Runtime组合229通过/22既有忽略；Clippy收尾后定向39/39与生产lib Clippy、类型/格式/diff通过。无真实Runtime/profile/账号目录模型/既有DB/安装、Adapter/schema/pin或旧controller变更。首次profile/生产异步调度、普通UI激活与Turn/history/events/reply/Stop/steer仍待后续有限片，具体剩余路径见实施记录末节。

最新恢复授权（2026-09-16）：原子登记经协调threads11/11、shared records7/7独立复核通过。恢复此前有限Session facade：已有测试owned连接，以共享Project/WorkingCopy ID和当次明确选择新建/登记，实际model-provider-effort/thread/tree核对；旧会话只按FarFold Session ID重读原记录并原resume，无覆盖/Turn重发。复用已修复事务与unknown边界，不另造状态机/工作台。生产gate/UI/Adapter能力仍关，不做首次profile/异步生产调度/真实请求/安装/既有数据迁移/Adapter或schema变更；完成交复核。

最新修复结果（2026-09-16）：原子登记有限修复已完成，交协调复核。Codex immutable selection进入既有共享Immediate事务，与本次Project/WorkingCopy/Session/locator写入同成同败；复用事务内target/model helper，旧无selection接口语义不变。前置参数拒绝不污染连接，native已Start后的存储/事务失败保留bound身份与actual诊断并设threads.unknown，后续工作拒绝且不抹诊断，Stop可用。原红测已绿，新增6项覆盖冲突/旧行不变/代次身份/幂等/后续阻断；会话定向11/11，共享store+Pi ACP+OpenCode ACP+旧Codex Session+E集合221通过/22既有忽略，生产lib Clippy/格式/diff通过。补测首轮4/2揭示被拒admission清诊断，已修正并保留记录。不涉及schema/Adapter/pin、真实数据/账号模型/安装，也不宣称跨进程孤儿恢复；新Session facade待此修复通过后再恢复。

最新修复授权（2026-09-16）：协调独立复现原子登记红测0/1，批准把immutable selection写入既有共享Immediate登记事务，复用校验/helper、不新表/schema/状态机；无selection的Pi/OpenCode/Direct语义不变。native已Start但事务失败时保留原bound身份和选择，沿threads.unknown阻断后续start/resume/admission/Turn/再登记，允许Stop；前置参数拒绝与事务失败分开。不称跨进程孤儿恢复已实现。原红测、全回滚/旧行不变/代次及身份/幂等/后续阻断合同与受影响共享store/Runtime/E回归完成后交复核；本轮不恢复新Session facade接线。

最新停点（2026-09-16）：Session facade 预查触发授权中的原子登记门槛。临时SQLite触发器在model metadata UPDATE注入失败，证明既有register_thread已提交Session+locator但selection缺失，thread unknown=false、operation pending=false，原native身份仍bound。新增安全回归0通过/1失败（有意保留红测）；既有生命周期1/1、operations13/13通过。仅增测试与文档，未接新facade/backend/UI、未改生产逻辑。需协调决定共享事务与原身份失败边界的最小修复，再继续本片；不重试native start、不另造状态机、不影响真实数据/应用。

最新授权（2026-09-16）：Refresh/Select 经协调独立前端19/19、Rust operations13/13复核通过。下一有限片只做共享Host新Session建立/原绑定打开typed facade及无网络合成贯通，复用threads/register_thread/open_registered_thread与共享Project/WorkingCopy/locator/immutable选择。新建必须携带本次显式选择，不借Adapter残留selection；路径/身份只从Host元数据取得，打开从FarFold Session ID重新读原target/selection并原resume，无覆盖/新thread/重发。先验证原子登记及部分失败保留unknown；若既有接口有缺口，以确定性测试报告，不另造状态机。生产门禁关闭；不做Turn/history/events/reply/steer、首次profile/真实启动/账号模型/现有库迁移/安装/Adapter/schema/pin。完成提交复核。

最新结果（2026-09-16）：admission Refresh/Select 私有接线有限片完成，提交协调复核。复用现有 Host admission/Configure 占用及工作台 model/effort 控件，完整 scope/epoch/hash/catalog/native model/effort/expected provider 核对；pending/Unknown、过期和已绑定 Session 改选拒绝，Refresh 不恢复旧选择，失败清当前可用性。公开私有投影不含 actual/thread 信息，不推定任务 ready。前端70文件366/366；扩大 E Rust61通过/5显式忽略；最后新增操作用例及枚举装箱后 operations13/13、生产lib Clippy通过。扩大E发生在末次新增用例和装箱之前，不称最终整套重跑。生产Host/Adapter/UI门禁未开放，只有静态mock控件可操作；未改Adapter/schema/pin、真实profile/账号目录模型任务、现有库或安装应用。下一有限片须复核后再定，详细首次失败、mock流程和保护证据见实施记录末节。

最新授权（2026-09-16）：lease夹具协调精确1/1复核通过，继续admission Refresh/Select有限接线。复用同typed Host operation facade、既有Runtime admission/Configure占用/immutable Session选择及工作台模型字段，合成/mock贯穿；只暴露refresh/select，不带restore/preflight/thread/Turn。完整scope/epoch/hash、可见model/native ID、effort和显式expected provider精确绑定；Configure pending/Unknown、跨代/过期拒绝，失败清当前可用性，已绑定Session不改选，账号/选择成功不冒充actual或task ready。生产Host/Adapter/UI仍关闭，不改Adapter/schema/pin、不首次profile/真实restore/异步启动/账号目录模型任务/安装；完成交协调复核。

最新诊断结果（2026-09-16）：已证明lease单测“parent drop即系统最后引用消失”的共享进程前提错误。受控pre_exec在同inode/FD_CLOEXEC=1下复现errno35，exec后子进程仍活着但原锁可获；一次固定128样本普通spawn另出现15次同errno/合法元数据。原58/1/3现场具体child PID未捕获，仍保留。仅该单测改为fresh exec后建临时锁、exact单项执行，父测试核对确实跑1项；原断言不削弱，生产不unlock/retry/改timeout。一次扩大E回归59通过/5显式忽略（原3真实检查+2诊断探针）；测试夹具修复提交协调复核，不开始新功能。完整诊断、限制和检查见实施记录末节。

当前有限诊断（2026-09-16）：协调复核发现/重新附着源码及前端27/27未见新阻断，但不称Rust集中全绿。仅调查原58/1/3中的lease失败，记录准确元数据/flock errno并对临时目录、自有子进程做有界FD/并发spawn探针；不循环刷绿、不改timeout/retry/锁断言、不以显式unlock掩盖。确定性夹具缺陷可最小修复；涉及生产lease安全语义须带证据先报。下一功能片继续暂停。

最新结果（2026-09-16）：同进程 Configure 发现/重新附着有限片已实施，提交协调复核。沿既有 Host Flow/占用返回有界原 kind/op/login/phase/in-flight，返回页面先关闭新认证，发现原操作后 fresh status；在途只显式重查，未知/缺身份不猜测、不重试，旧URL/code不恢复。新增前端13项、Rust3项及真实组件mock流程；最终前端68文件352/352、Host operations10/10、Configure定向、类型/clippy/格式通过。扩大E Rust首跑58通过/1个既有lease测试失败/3忽略；该锁释放后重获失败单独诊断复跑通过，但根因未知且本片未改锁路径，不能称整套全绿。生产gate/能力仍关闭，无Adapter/schema/pin、真实profile/native/account/model、安装或既有数据变化。首次profile、真实restore/异步调度、目录/选模和任务接线仍待后续批准；本片不进入下一片。

最新授权（2026-09-16）：Configure UI/client 经协调独立15/15复核通过。下一有限片只做同进程、同连接 pending Configure 发现与重新附着：复用 Host 私有 control/占用，返回有界 kind/原 operation/login/phase，再核对原操作。先测离开后后台继续或终态、同代返回、跨代迟到和发现/开始竞争。返回先阻断新认证；Unknown/缺身份/未知kind不猜测不重试，指令只来自 fresh 原操作回执。生产能力/gate全关，仅cfg(test)/静态mock；不改Adapter/schema/pin，不访问真实profile/native/account，不安装，不加认证历史或第二状态机。进程重启/首次profile/真实冷恢复不在本片，完成提交复核。

**最新授权（2026-09-13）：用户明确选择第二种模型/认证方案并要求推进实施。保持同一 Host/ACP/Pi Adapter，SDK 只辅助认证/目录，Pi 执行 Agent；稳定自有 profile/启动身份与每轮 typed managed-version/native-observation 来源分离。此结构决定已批准，不重复询问。先落稳定引用、版本投影/秘密冲突、模型至任务接纳的原子绑定及原会话恢复合同，再接认证与现有工作台；具体增量独立复核，旧 Pi 与正式数据保留，D 安装/真实 Provider 出口不降低。**

**执行状态：2026-09-12 用户已明确恢复 D 开发，随后撤回换任务建议，原任务在本检出继续。此前暂停与文档校正保留为历史。恢复核对期间仅只读，未新增实现或验证；从下述 D 位置接续，不重建已删除的交接文档、不重复已通过且未受影响的验证。**

**当前位置：2026-09-13，D 接入公共 Host。普通启动/续接、隔离 Provider profile、原生 Session 登记、任务/停止/未知恢复、交互/插话和配置已有定向合同及有限复审。Provider 原生回执与投影有固定 Pi + 本机模拟 HTTP 单次请求、落盘及冷恢复证据，不是外部 Provider 或安装 UI 验收。PiWorkspace 已接既有 ACP 会话的快照、事件、任务、交互及配置，相关 66 项测试与 13 类隔离冒烟、空闲退出恢复 P2 修正已有限通过。普通 managed ACP 新建及共享 Provider 表单现已接线，另有 59 项定向测试和新建/失败恢复冒烟；协调发现的旧列表回执 P2 已确定性复现、修正并有限增量复核通过。本片有限工程通过；完整模型/认证能力保留、工作台及同候选安装出口未完成。用户已批准固定 pi-acp 有限维护，不从零重写、不改 Pi 本体。旧 Pi 保留，E 未启动，正式应用不替换。**

C1–C5 工程出口完成（协调复审通过）。已安装 `/Applications/Farfold Dev.app` 最终候选 `85e50b52`；仅限 OpenCode Dev 工程验收，不是用户验收、三路完成或正式升级。
A 的三路能力与差距已有基线；B 的公共状态与事件隔离已有修正和定向验证，但不能据此宣布整个公共 Host 已完成。
OpenCode 是第一条完整验证路径，后续顺序为 Pi、Codex。正式应用尚未替换，本轮改动不是已交付新版。

| 当前事项        | 证据与结论                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 安装与身份   | 普通安装选择、缺失不新建、取消、重试修复及原会话恢复已在 Dev 实测；版本、摘要、原子安装和失败清理合同通过                                                                             |
| C2 Provider     | 公开 Zen managed 连接真实成功、独立模型失败、保存/应用/请求验证分层及绑定版本已核对；未调用私人 Provider                                                                              |
| C3 原生交互     | 多题、Other、多选、once/reject/always、模式切换、停止、取消中退出和故障恢复已实测；always 重启作用域按原生行为保留                                                                    |
| C4 成果与工作台 | 原生文件/命令、真实 diff、打开/定位、外部编辑及二进制/大文件/越界/冲突/非 Git 可见状态通过；公共 fs/terminal 仅合同证据，OpenCode 未实际调用 Host 回调                                |
| C5 恢复与入口   | 最终候选同一会话三次冷启动身份/草稿一致，不重发；ACP 与旧 Server 切换通过。已删实验写控制、重复面板和旧 Server 新建，保留旧已绑定会话打开                                             |
| 候选与检查      | 集中候选 `d515def7` 后仅两处前端修正至 `85e50b52`，受影响流程已复测，未变证据按批准规则复用；266 前端、390 后端通过，16 后端忽略；格式、类型、构建、clippy、签名及 Dev 数据完整性通过 |
| 正式版与后续    | 正式执行文件仍 `c7750c44`，未替换。Pi/Codex ACP 尚未迁移，F/G 去随包、三路交付与正式配对恢复未执行                                                                                    |

### 当前步骤与下一步

最新结果（2026-09-16）：Configure 私有展示/client 有限片已提交复核。现有 CodexWorkspace backend 接 typed Configure IPC，原 CodexConnectionPanel 增加 ACP 私有呈现，复用 ProviderAuthPrompt 与既有样式；全scope/operation/login校验、取消立即撤下指令、Unknown不复活、视图/代次撤销与迟到回执丢弃已有定向与真实组件mock测试。两个负向红测确认并修正新操作借旧终态、撤销指令复活缺口；截图发现按钮结构未匹配既有样式后补齐结构。最终前端67文件339项、typecheck/格式/diff、Host operation8/8通过。生产ACP capability仍全false，无登录/Key控件；浏览器仅隔离fixture，无真实请求/构建安装/数据迁移。等待协调复核，首次profile/真实restore/异步调度、认证重新附着、catalog/model/任务等仍是后续工作，不能称ACP可用。

最新授权（2026-09-16）：Host operation 片经协调独立8/8复核通过，继续现有 CodexWorkspace typed backend/view 的 Configure 私有临时状态与操作合同。复用现有账户/认证组件；核对完整scope、operation/login身份、取消/未知、视图或连接撤销及迟到回执，做无网络mock-IPC真实组件测试。生产ACP能力全关闭，URL/code/Key仅mock fixture演练，不自动开浏览器、不持久化秘密、不推定账号/模型ready。无Adapter/schema/pin、新生产gate、真实profile/native启动、模型/目录、安装或旧路径删除。首次profile/真实restore/异步调度等后续独立推进，本片完成提交复核。

最新结果（2026-09-16）：typed Host operation 有限片已实施并提交协调复核。新增单一命令涵盖原 owned profile restore、原连接 Stop、Configure；生产在 state/profile/凭据/native 访问前无条件拒绝，合成入口仅 cfg(test)。恢复只从共享持久元数据解析路径，取得原 lease 后复核旧 generation，再由原 Host authority 推进代次；没有首次 profile 创建或普通 UI 动作开放。新增合同 8 项，E Rust56/3 ignored、前端定向17、类型/clippy/格式/diff通过。首次 fixture 占位 Key 与 Unknown 回执预期错误已按实际模拟合同修正并留档，未改 Adapter/schema/pin/已安装应用或已有库。下一步等待协调复核；首次创建、认证 UI、catalog/model、thread/Turn/history/reply/Stop/steer 接线与真实/安装验收仍未完成。

最新授权（2026-09-16）：协调批准下一有限片——共享 owned connection/profile 生命周期及 Configure 的 typed Host 操作 facade/命令注册与无网络 synthetic IPC 合同。沿用 Runtime/HostSessionController；生产在原生启动、profile/凭据访问及任何副作用前硬拒绝，测试注入仅 cfg(test)，无环境变量/前端绕过。保留完整 scope/lease/代次、Configure occupancy、取消/迟到/未知语义，临时秘密只留私有回执。Adapter/schema/pin、真实 profile/启动/登录/目录/模型、安装及旧 controller 删除不开放。完成后提交协调复核，不自动进入下一片。

补充复核（2026-09-16）：执行任务在协调补完后独立核对 backend/view、同组件生命周期及实际 Tauri 注册；定向前端 28/28、Rust workspace 4/4、tsc 与 diff check 通过。本轮未新增生产修改，未重跑安装或完整浏览器验收；未发现阻断当前关闭态范围的问题。已将下一片“共享 owned connection/profile 生命周期与 Configure 的 typed Host 分发、仅合成验证”作为待审建议提交；尚未批准或实施。认证、目录/选模、thread/Turn/history、reply/Stop/steer 仍缺普通 Host/UI 接线，不是只待用户登录。

最新结果（2026-09-16）：同一 CodexWorkspace 的最小 typed backend/view facade 已完成并提交复审。持久 adapter binding 唯一路由 backend；旧 Direct 仍调用原命令/DTO，新 ACP 只消费上一片关闭态 snapshot 与有界 typed event 摘要。Session/scope/thread/tree/Turn/request 身份、view lifetime 与 ACP read cleanup 阻断跨目标迟到回执及返回同一绑定前的旧快照重现，不 fallback。ACP create/login/catalog/send/reply/Stop/steer 仍全部关闭；关闭态 interaction 在进入共享面板前剥离 raw command/cwd/path/diff，Direct 原 payload 不变。新增专用 6/6，相关前端 17/17，集中前端 65 files/326、Pi Adapter192、Codex Node23、E Rust48/3 ignored、type/format/diff 均通过；真实组件浏览器在新读取挂起时只显示“状态尚未核对”，释放后才显示当前身份。本片未改 Adapter/schema/Rust 生产路径，未登录/发模型请求、构建安装、迁移已有库或删除旧 controller。判断：E 仍缺生产 Host 的 auth/catalog/model/thread/Turn/history/reply/Stop/steer 接线，并非只差用户在场验收；下一有限片须先复审该操作边界。

最新授权（2026-09-16）：协调独立前端16/16、workspace Rust4/4通过，继续同一 CodexWorkspace 的最小 typed backend/view facade 提取：旧 Direct 机械包装不改协议，新 ACP 只读安全状态/typed事件，所有动作全关闭；复用正文/交互组件，拒绝跨目标迟到回执及fallback。无Adapter/schema/旧controller修改、真实请求或安装；若需实质重写，止于最小view-model mapper并报告。完成后须区分“仍缺生产Host接线”与“只待用户在场真实验收”。

最终收尾（2026-09-16，覆盖下一段当时的回归停点）：协调另行批准仅修 Pi 探针测试的 stdout 分帧；大目录分块先稳定红测，再保留跨 chunk 余段、完整行解析和 EOF/坏帧显式失败。只改测试读取器，生产 Pi/超时/重试不变。最终前端 63 files/320 tests、Pi Adapter192、E 定向48/3 ignored、类型/格式通过；本片同源码全 Rust516/31 ignored及clippy此前通过。关闭态最小 facade/state 已提交复审，未扩大为完整 ACP auth/Turn/interaction 工作台；下一片仍须协调确认，安装/真实认证与模型入口保持关闭。

收尾回归提醒（2026-09-16）：最小工作台片的定向/浏览器检查通过，但最后全量前端为 315 passed/1 failed：既有 Pi Provider 探针测试解析 stdout 未完成末行，出现截断 JSON；随后一次定向 4/4，不算根因修复。未改 Pi 生产代码或该 fixture，详细失败与分帧风险已交协调复审；不得记为全量最终绿。Rust 516/31 ignored、Pi Adapter192、Codex Node23 与类型/格式/clippy 通过。

最新停点（2026-09-16）：按本片第 9 条止于最小工作台 facade/state 层并提交复审。已注册共享 ACP 只读 Tauri 状态入口，现有 CodexWorkspace 按持久 adapter 分流；新建/ACP 原绑定呈现关闭原因，旧 Direct 原会话继续原路径，无 fallback。Host 原绑定打开亦明确阻断 ACP，未接生产 launch/auth/model/Turn/interaction 操作。安全缓存状态、跨 Session 迟到回执与闭态/旧路 mock 浏览器核验通过；旧 DTO/事件/交互按钮控制仍耦合，完整登录/目录选择/正文与审批、Plan 问题、Stop/steer UI 未接，须复审后再分片提取，不称工作台整体完成。无安装、真实登录/模型、现有库迁移或旧 Codex 删除；详细分层证据及首次失败见实施记录末节。

最新授权（2026-09-16）：admission 片经协调独立 Host 8/8、Node 7/7 复审通过，继续 ordinary workbench 的关闭态/合成接线。复用现有 CodexWorkspace 与共享 Host，按持久 Session adapter ID 分流，ACP 不回落旧 direct；新 ACP Session、真实认证/模型/任务、安装/现有库迁移仍关闭。若完整复用需实质重写，先止于最小 facade/state 层并回报剩余路径；不另建实验工作台。本片完成后提交复审。

最新结果（2026-09-16）：E 0.1.5 synthetic account/model admission 有限片完成，提交协调复审。fresh account、完整有界分页目录、显式可见 model id/effort/expected provider、实际 start 三元组与每轮 Host/Adapter preflight 分开验证；原 shared Session 的 schema15 附属不可变 metadata 保存明确选择/实际确认和原身份，Turn 复用 native_observation 同表，不创建 managed Provider。按协调批准的固定接口边界：read 只证身份/provider/idle，model/effort 用原 start/resume snapshot；冷恢复无模型覆盖，actual 与持久选择/当前目录不一致或旧 Session 缺 metadata 均阻断。Rust 512/31 ignored、前端 308、Pi Adapter 192、Node 23、E 含固定空 profile 显式 47 项通过；详细首次失败、修复与限定见实施记录。可复审下一受限工作台接线片，但真实登录/Key/模型、生产任务、普通 UI 本轮注册、安装及旧 Codex 删除仍未做；已安装应用和 schema14 数据不变。

最新授权（2026-09-16）：交互片协调独立复跑 Host 10/10、Node typed boundary 9/9 通过。继续有限 synthetic account/model admission：fresh account/read、account/updated 失效、完整有界分页目录、显式可见 model id/effort、原 native model/provider/effort 核对及发送前再检查；复用原 shared native observation 表，不创建 managed Provider。固定接口缺失如实阻断/回报。生产入口、真实登录/Key/模型、普通 UI、安装和现有库迁移仍关闭；本片完成后再复审是否可接工作台。

最新结果（2026-09-16）：E Adapter 0.1.4 已完成本片 synthetic command/file approvals、Plan-observed questions 与同 Turn steer，接入原共享 interaction registry/Session operations/TurnCoordinator/event router。完整 scope、Host Session/Turn、native thread/tree/Turn/item/原 request ID 保持独立；sent 保持 Responding，只有原 native resolved 结束请求，Stop/expiry/离开 Plan 仅撤销可回复状态。steer 不创建新 prompt，迟到/重复/跨代/超时不改下一轮。Rust 504 passed/31 ignored、前端 308、Pi Adapter 192、E 显式检查 39、Node 合同 16 通过；真实固定检查仍只隔离空 profile 只读。详细能力、限制和固定摘要见实施记录。本片提交协调复审；下一安全有限范围为账号/模型 admission，先于工作台接线，不自动开启真实登录/模型或安装。生产 task/login/model/interaction/steer、普通 UI、旧 Codex 删除仍关闭，现有安装及 schema14 数据未变。

最新授权（2026-09-16）：协调独立复跑 E 26/26（3 ignored）及 Node 7/7 后通过 Turn/Stop 片。续做有限 synthetic command/file approval、Plan-only requestUserInput 和同 active Turn steer，复用共享 interaction registry/AcpSessionOperations/TurnCoordinator/event router；保留原 request/Turn/item/完整 scope，用户决定答案，不将 sent/ACK 当 resolved。Default questions、follow-up、真实 task/login/model/interaction/steer、普通 UI、安装与旧 Codex 删除保持关闭；固定真实仅空 profile 只读/本地拒绝。详细能力、首次失败及后续 admission 门槛写既有实施记录。

最新结果（2026-09-16）：E Adapter 0.1.3 的 synthetic Turn/Stop 有限片已接共享 TurnCoordinator、AcpSessionOperations 和 event router/既有 observers，原 thread/tree/Host Session/Host Turn/profile/build/代次/worktree 分别校验。正文/思考流与 native item ID/type/status 受限投影；命令、输出、文件 paths/diffs/errors 和未知原包仍私有有界。停止 ACK 不释放，只有原 native completed/failed/interrupted 释放；断线/超时保持未知，旧终态撞上下一活动轮也不混入。完成态冷恢复经 fresh list/read/resume 后只读完整历史、不重发；跨代未知任务的自动核对/释放未实现。集中 Rust 494、前端 308、Pi Adapter 192 已过，E 显式固定空 profile + synthetic 检查与首次失败见实施记录。可提交本片协调复审，再决定下一有限 synthetic interactions 片；真实 task/login/model、普通 UI、安装与删旧 Codex 仍关闭，E 整阶段未完成。

最新有限片授权（2026-09-16，覆盖下述历史停点）：profile/thread 协调复审通过，继续 synthetic Turn/start、item/text/reasoning 事件、可信终态、interrupt 与原身份冷读恢复。复用共享 TurnCoordinator/AcpSessionOperations/event router；停止 ACK 不释放占用，断线/超时保持未知，迟到事件不可污染下一轮。生产 task/login/model 硬禁用，真实固定 0.143.0 仍只空隔离 profile 只读；不做审批/提问/steer/review、UI 注册、安装、删旧 Codex 或现有库迁移。首次失败和分层证据写入既有实施记录。

最新有限片授权（2026-09-16）：Configure 协调复审通过，继续公共 owned-profile 精确持久恢复、认证私有/已验证 thread 事件分类及 synthetic thread list/read/start/resume。为复用现有权威扩展 schema，仅临时测试库迁移；固定真实程序只在本片无认证/配置/历史的隔离 profile 做空态 list/read。生产 login/thread mutation 保持禁用，不接 Turn/model/tools/交互、不注册普通 UI、不安装或删旧 Codex。新结构取舍、现存数据改动或必须真实认证时先报告。

本片当前结果：按协调明确的身份决定，schema15 扩展现有 profile 附属 launch metadata/持久 generation 和 shared locator；`sessions.native_session_id` 保留 thread.id，`codex_tree_session_id` 保存 opaque tree sessionId，不另建 Codex Session 表。原 Pi locator 路径值/唯一性保持，新 kind 不进入路径恢复。Adapter 0.1.2 的认证/通用错误/未知原包只在有界私有内存保留，已校验 thread 元数据独立投影；Host 登记、fresh list/read 后原双身份/cwd/profile/worktree 冷恢复已有合成闭环。真实固定程序只验证空 profile 的持久恢复、空列表与本地拒绝登录/start；生产真实 start/resume/login 仍关闭，含 auth/config/history 的真实恢复仍拒绝。完整 Turn/event、工具/交互与普通 UI/安装未接，下一有限片可在复审后做 synthetic Turn/event mapping，不得直接开启真实任务或删除旧 Codex。详细检查与首次失败记录集中于实施记录末节。

当前有限片（2026-09-16）：已获准继续 E 共享连接生命周期/Configure 与合成认证闭环。固定真实 Codex 0.143.0 仅无登录 account/list 读取，用户休息期间不启动网页登录、设备码、API key 登录或模型请求。秘密和登录指令仅临时操作回执，不进入普通 Session/未知事件、数据库或日志；适配器维护改动同步固定各模块摘要。native Session/Turn、安装替换及旧 Codex 删除不在本片，完成后分层回报与复审。

本片工程结果：共享 AcpRuntime/HostSessionController 与 connection-level Configure 已接通；browser/device/key/cancel/logout、早到/迟到完成、外部账号变更、停止与跨代回执隔离通过无网络合成 App Server。Adapter 0.1.1 固定入口及 core/configure 三个摘要，生产入口硬禁用认证；固定真实程序仅空账号/列表、生命周期及本地拒绝登录检查。全前端 308 项通过；最终全 Rust 478 项通过/30 ignored，E 定向 11 项通过/2 ignored，两个固定程序集成此前均显式通过；clippy 样式首败修正后通过。当前仍为 headless 工程片，不是 E 安装出口。认证后暂隔离所有非认证 unsolicited 原生载荷以防通用错误回显秘密，这不代表完整任务事件保留；下一有限原生 Session 工程片须先闭合持久自有 profile 恢复和认证私有/任务事件通道，再迁移任务能力。尚不注册普通工作台、不发真实请求、不删旧 Codex，详见实施记录末节。

最新工程结果（2026-09-16）：Pi RPC 新建 helper、派发命令与入口已精确移除，既有原绑定恢复保留，受影响回归通过。E 沿明确确认的公共 Host/ACP→独立 Adapter→固定 Codex 0.143.0 路线建立只读骨架（adapter 0.1.0 / `4fee9653`）；共享 ACP 初始化、未登录 account/read、空 thread/list 经真实固定程序通过，错身份/崩溃/超时迟到/未知事件合成检查通过。认证类型含 browser/API key/device code，但操作及普通 Tauri/工作台入口均未接通；thread/turn/原生历史及 profile 冷恢复也未迁移。它不构成旧 Codex 完整控制等价替换或 E 出口，因此旧 Codex 控制器暂不删，新 adapter 不调用旧控制器、不提供 fallback。下一片从共享 Host 操作/生命周期及 Adapter 认证合同开始，再接原生 Session/Turn 与工作台，阶段出口仍须安装实测。本片未登录/发模型请求/打包/安装，正式/Dev/D QA/P6 应用及数据保持；详细证据见现有实施记录末节。

2026-09-16 后续开发已获授权：先精确移除 D 已替代的 Pi RPC 新建入口，保留既有 RPC 会话的原绑定打开/恢复及所有 QA/日用数据并补受影响回归；随后进入 E 的固定 Codex 0.143.0 接口与当前源码审计、有限工程片。首片仅隔离自有环境、合成协议与固定程序无模型核验，不登录、不导入默认认证/历史、不发模型请求、不打包或替换应用。固定版本、必需接口或共享 ACP/原生 App Server 边界出现结构取舍时先报告，不用旧路径冒充 E 出口。此授权覆盖下段当时的 E 停点。

2026-09-16 D mandatory 验收出口完成（按批准的证据复用与固定 Pi 限制，覆盖下方当时 partial 停点）：同一已安装 D QA `80fc988c`、原 managed file Session、普通智谱 GLM-4.6V，最终独立 `sleep 120` 片在同一 Host Turn 内接纳 steer 与 follow_up，原生顺序 BASE→bash正常结束→STEER→FOLLOWUP，3次响应、单Turn绑定、最终settlement、零文件变化；安装路径冷恢复完整历史且不重发，31个保护文件恢复前后全同，退出无sleep/D QA/ACP残留。先前sleep20片为2响应的有效bash，但验收操作未赶上窗口，未发任何干预，不归为产品失败；延长片有新的明确授权，不隐去该停点。此前空自定义tool identity仅保留为Provider/native解码层单次未归因输出，源码与原生历史无证据证明它是Farfold能力损失，不外推根因已修复。14项矩阵及分层理由见现有实施记录末节。当前停在E入口：本片没有生产代码修改、重建、旧入口删除或正式/Dev/P6替换；D出口后旧路径清理仍未执行，须保留自身验证，E不自动开始。schema14/quick_check正常，5Session/12Provider Turn/全库1变更路径。不得把此内部mandatory出口写成全Provider/OAuth覆盖或正式升级。

2026-09-16 最新最小修复片（覆盖下段当时停点）：独立安装 D QA 已更新为 `80fc988c`，空 managed Session 的原身份 trust 重启、`/session` 当前连接控制文本展示均通过零模型安装复测。前者使用独立、私有、精确 stable ownership/bootstrap 的 pre-file 证明；模型派发或模型/profile/auth 变更前消耗，旧空会话不补造证明，已有文件仍按原生原分支恢复。后者沿现有 Host workspace 只读入口，不创建 Provider Turn，不混入原生历史或镜像重复文本。随后唯一获准 HOLD 尝试得到两次 GLM-4.6V 响应，但原生 toolCall 的 name/id 为空，Pi 返回 `Tool  not found`，没有进入 hold；未发送 steer/follow_up，也未重试。根因未确认，不能把模型/工具失败写成缺少注册或活动队列通过。D 仍 partial，旧 Pi 不删除，E 不启动；四请求上限剩余部分不是失败后重试授权。已完成原/文件两历史 Session 冷恢复、不重发、28 个保护文件字节不变及正常退出；schema14/quick_check 正常、Session5/Provider Turn10/变更路径仍1，正式/Dev不变。详细首次失败、检查、安装保护与更新14项矩阵见现有实施记录。下一安全工作是这次空工具身份的零模型协议/fixture 定位，任何新增真实尝试须按失败停点重新安排，不自行替换 Provider、模型或 Runtime。

2026-09-16 最新安装工作流验收：同一 `d8a3425d` 安装版完成原 Session 真实正文流 Stop、获准新增的隔离 managed-worktree Session 单次 write/Host 单文件归属/diff/预览/访达定位、零模型 Extension 四表单与超时撤销、原/文件两 Session 精确冷恢复。4 次模型请求预算已用完：Stop 1、文件原生工具循环 2、拟转向在原任务结束后变为普通消息 1；未发送 follow_up，不称活动干预通过。新增两个安装缺口：空 managed Session 尚无原生 JSONL，切项目 trust 的同身份恢复失败；`/session` 仅发标准 ACP 文本，而 Pi 工作台只接 `_pi/event` 且终态刷新原生历史，统计输出不可见。本轮未修生产代码、不重试、不换配置、不增加调用。原配置与历史前缀保留，23 个保护文件在最终冷恢复前后不变；schema14/quick_check 正常，原 Session 4 个 binding/0 paths，文件 Session 5 个 binding（含 3 个零模型命令）/唯一证据路径，两个零调用准备 Session 单列保留。D 尚未完成；下一步先闭合上述空会话恢复与命令呈现边界，再安排仍缺安装证据的活动 steer/follow_up，不把它们归入获准的 compact 限制。旧 Pi 保留，E 未进入，正式/Dev 未变；详见实施记录最新安装验收节。

2026-09-16 当前进展（覆盖下方此前阻断状态）：用户批准保持固定 Pi 0.84.3，保留手动压缩并如实标明此操作不支持 Stop。既有 Adapter/Host 已闭合 `/compact` 的 actual-model/idle preflight、活动互斥、changing/unknown、原生结束与回执一致性；界面禁用手动压缩 Stop，竞态请求返回 unsupported，不发送原生 abort、不伪造 cancelled 或普通 Provider 验证。Adapter 189、前端 304、Rust 464 项通过；一次固定 Pi/维护 ACP 的 localhost 压缩确认受限 Stop、正常终态及原身份冷恢复不重发。独立签名候选 `d8a3425d` 已安装至 `/Applications/Farfold D QA.app`，普通恢复与再次冷恢复通过，schema14、原 Session/profile/凭据/三轮历史保留；9 个受保护文件内容未变，本片外部模型请求 0。正式版/Dev 未变，旧启动超时仍未知。本片工程修复及独立安装恢复完成；下一步仍是 D 剩余安装原生工作流验收，不把此前真实 Provider 成功外推为本候选完整验收，不删除旧 Pi、不进入 E。详细证据集中在实施记录最新节；以下停点为历史。

2026-09-16 最新阻断更新：用户随后授权继续修复 `/compact`，在生产修改前核对取消合同发现固定 Pi 0.84.3 的新原生限制。一次隔离 localhost 手动压缩中，RPC `abort` 返回 success，但 `isCompacting` 仍 true；释放本机模型响应后压缩正常完成，`compaction_end.aborted=false`。固定原生 RPC 的 abort 没有调用独立 `abortCompaction()`，不能靠现有取消 ACK 保证压缩已停止。已加入可复现探针并回报协调，原模型 preflight 红测仍保留；没有改生产实现、固定 Pi、真实凭据或安装应用。下一步先明确该原生接口限制的处理决策，再推进既有 Adapter 的模型/生命周期修复；不得把 ACK 或强杀伪装成取消成功。D/C 安装门槛仍未满足，E 未启动。详见实施记录最新“固定 Pi 手动压缩取消限制”节。

2026-09-16 最新停点：额外获准的一次真实 GLM-4.6V 长响应已在活动思考流中使用 Stop，UI 确认停止、原生 `aborted`；取消后冷恢复原 Session/模型/三轮历史，Turn 绑定仍为 3，零工具、零文件变更、无重发。固定 Pi RPC 与维护 ACP 的新增 localhost 对照通过原生 write、工具事件/diff、活动 steer、follow_up 和最终 settlement。能力矩阵发现新的必需边界失败：`/compact` 在 Adapter 中直接调用原生 compaction，绕过普通 prompt 的 actual-model preflight；合成失败测试确认携带不匹配 expected model 时仍 accepted、compaction 调用 1、state 读取 0。按本轮“新材料缺口先回报”约束，保留红色回归，不改生产实现、不安装候选；`/Applications/Farfold D QA.app` 仍不存在。下一步先在已批准 Host/ACP/Adapter 结构内闭合 compaction 的模型、活动/停止及回执边界，再补相应固定 Pi 验证，之后恢复同候选安装验收。完整分层矩阵见实施记录末节；D 未完成，旧 Pi 保留，E 未启动，历史启动超时仍根因未知。

2026-09-16 后续受控验收：沿用现有 performance trace 补入版本检查阶段、线程、child PID/内核状态和退出/输出元数据，定向成功/失败/5秒超时回收与脱敏检查通过，超时阈值和重试策略不变。独立 D QA 新候选 `048004abdd83587a0de15a3418bb5dbec4075c294769421b5d4b7a6f0266c96b` 严格签名通过；一次受控 UI 续接成功，随后将已保存的新 System-role 版本应用到原 Session，投影确认 `saved / applied / not_requested` 后发送本片唯一一次真实 `glm-4.6v` 请求。UI 返回 `FARFOLD-D-SYSTEM-ROLE-OK`，当前版本精确达到 `verified_success`；原生历史保留旧 error 和新 stop，零工具调用、零文件变更。正常退出后同候选冷恢复原 Farfold/native Session、新版本模型与两轮历史，Turn 绑定仍为 2，无重发。本次版本检查成功约 330ms/346ms；未复现超时，所以旧三次失败的根因仍未知。任务快速终态，活动 Stop 尚未实测；继续其余原生能力对照与 D 安装出口，D 整阶段仍未完成，E 未启动。详细证据见实施记录。

2026-09-15：无 managed key 首次使用的共享 Host/ACP 工程闭环已接通。稳定 Pi profile 可在无 bootstrap 时建立原生 Session，合成 Provider 认证后仍处于待明确选模；该状态冷启动保持原 native Session 且不放行任务。只有显式选择、实际 idle 模型及目录精确一致后才进入 ready，随后固定 Pi 完成一次本机模拟模型请求、停止及原 Session/模型冷恢复且不重发。Pi 本身没有统一账号；认证对象是模型 Provider，按 Provider 能力采用 API key 或 OAuth，已有可用凭据时不重复要求认证。Pi 首次 assistant 前不会把自定义 entry 写入 JSONL，因此 Adapter 只在该前置阶段持有私有、原子、profile-scoped 的身份/状态引用；产生原生历史后恢复仍以原分支为准。独立 D QA 随后保存并应用普通智谱开放平台 `zai` / `glm-4.6v`，建立了精确 managed Provider、profile、Farfold/native Session 绑定；首次且唯一一次真实请求到达外部 Provider 后返回 HTTP 400“角色信息不正确”。该失败已记为 `verified_failure`，不是请求成功或套餐/额度验证。终态后没有活动 Turn 可 Stop；正常退出应用已终止 Pi Runtime，冷启动恢复同一 Farfold/native Session、同一模型及失败历史且未重发。下一步先定位该单次失败的协议事实并取得重新请求授权，再完成成功请求、活动任务 Stop、完整原生能力对照与 D 安装出口；当前不宣布 D 完成。源码 schema14 只迁移独立 D QA 数据域，正式应用、既有 Dev、日常凭据和历史不改变，旧 Pi 保留，E 未启动。详见实施记录。

2026-09-16：普通智谱 400 的角色根因已在固定 Pi 0.84.3 SDK 映射与严格本机模拟服务中确认：该普通 Chat Completions 端点需要 `system`，不能发送 `developer`。源码现在在前端和 Host 保存边界对精确普通智谱端点固定关闭 developer role，并提供显式 UI 迁移，把既有不安全版本复制为新的不可变兼容版本；旧版本、旧 Turn 绑定与 secret 均不覆盖。前端定向 13 项、managed Provider Rust 14 项、Adapter 185/185 及固定 Pi 完整本机 SSE/冷恢复测试通过；重建的独立 D QA 候选二进制 SHA-256 为 `4e1cd9afd8908e59aa92f3a546ff2259a87310400f74469d4d7423a6b7e1749f`，adhoc 深度签名验证通过。候选 UI 已创建新版本，但首次应用时 Pi 尚未由该 Runtime connection 启动，随后原会话冷启动连续三次在模型请求前被独立的 `Pi Runtime version check timed out` 阻断；相同固定二进制直接检查、签名 Farfold 父进程 smoke、Tauri blocking worker 及简单并发隔离检查均未复现。失败现场缺 child PID/state/阶段记录，超时根因仍未知，因此不延长 timeout、不增加 retry、不提交猜测性修复。数据库保持新版本 `saved / pending / not_requested`，没有应用到运行中的原 Session，也没有第二次外部请求。D 仍未完成，E 保持关闭。

独立 `Farfold D QA` 候选继续从构建目录运行：bundle id `ai.farfold.desktop.dpiqa`、独立 schema14 数据域、正式版与既有 Dev 未替换。原 `zai-coding-cn` Coding Plan 连接保留；新增普通开放平台 `zai` 连接使用官方 base URL 与 `glm-4.6v`，凭据只经 secure field 保存。应用后投影为 `saved/applied`，真实请求后为 `verified_failure`；Host 只有一条 Turn Provider 绑定和零变更路径。没有自动换端点、换模型或重试，是否产生账单无法从 Farfold 证据确认。请求前只将 21 个无人占用、可重建的旧 Pi 版本探针项移入用户废纸篓（28K，可恢复）；当前 QA 包、数据库、profile、credential、截图、源码、计划、恢复材料及其他应用/数据均保留。

2026-09-13 最新执行状态：汇报用暂停已由用户明确解除，在原任务和原检出继续 D。从下述已验证授权/读取/来源停点接通受控文件更新、同一连接空闲刷新及应用/选择；不重复已通过且未受影响的检查，不改变日常应用与真实数据。

源码 schema 13 精确授权、同会话多版本受控写入/刷新/选择及原身份恢复已有有限证据；Provider 表单已接当前会话应用，未知状态误显示旧成功的 P2 已复现修正。临时认证及 SDK logout 已接同一 Host/ACP，合成原生 key 保存/移除与固定 Pi 同进程刷新、原身份/历史保留及零模型调用通过。认证后重读原生模型目录；明确选择并实际确认原生模型后，任务接纳复用 schema12 同表来源记录，不生成托管验证。固定 Pi/隔离 bundle 完成一次本机模拟原生模型请求及原会话冷恢复，工作台选择/发送有 mock-IPC 冒烟，增量代码有限复审通过。仅观察到模型仍不能放行；未知状态仍拒绝发送。继续无 managed key 首次使用、实际账号 OAuth、完整工作台与 D 安装真实 Provider 出口；这些尚未完成。SDK commit 不代表请求验证，不更新日常应用或真实数据库，首次失败与复测见实施记录。

2026-09-13 D：实际来源捕获、派发前复核及 typed 回执分支已有有限复审。冷恢复新增启动前官方解析、原分支与文件保护；固定 Pi 空消息分支误接受默认模型的 P2 已复现修正，隔离 bundle 失败保护/修复恢复及已有消息冷恢复通过。后续明确原生模型选择/接纳增量沿用这些守卫；未知格式和静态目录无法确认的模型仍拒绝，不称完整原生能力保留、账号保证或外部写入 CAS。未更新安装应用或真实数据库，检查与首次失败详见实施记录。

1. D 首片固定组合与路线材料见[实施记录](../reports/2026-09-10-host-architecture/Farfold-实施与验证记录.md#2026-09-12-d-首片pi-候选核验与路线决策)。用户已另行明确批准推荐的有限扩展路线，维护决策门槛解除，不重复询问同一批准。
2. 完整摘要、必需项对应、两候选证据复用和协调结论见[实施与验证记录的 C 阶段集中出口核对](../reports/2026-09-10-host-architecture/Farfold-实施与验证记录.md#2026-09-12-c-阶段集中出口核对)。保留原 Dev 配对备份与必要 QA 证据，不清理未归属数据。
3. 新 OpenCode 会话保持前端 → 公共 Host → 公共 ACP → 独立 adapter → 固定 OpenCode；官方 HTTP 只在 adapter 内部，不 patch/fork Runtime，不增加 Host 原生 fallback。既有 Server 会话继续按原 binding 打开。
4. 在固定 `pi-acp` 源码上分片扩展并独立复审；先隔离合同/原生对照，再接普通 Host/UI/Provider，D 出口通过后才删除已替代路径并进入 E。复用 C 未变证据，不重复候选损失探针。

恢复实施已获明确授权，执行任务按已批准范围连续推进；重大能力损失、架构改变、正式数据/分发边界取舍仍交用户决定。

## 1. 目标与边界

- 一个自有工作台，复用公共界面、Host 服务和 ACP 客户端；专属交互按 Agent 能力保留。
- 主链路：工作台 → 应用内 Host → 公共 ACP 客户端 → 原生 ACP / 适配器 → Agent。
- Agent 仍拥有原生循环、会话、工具决策、权限语义和模型调用；不改 Runtime、不另建 Agent 循环，不用原生旁路掩盖 ACP 缺口。
- 本机已有优先复用，缺失时按需安装；最终主包不携带 Agent 本体。固定程序/适配器版本、来源与摘要，保护用户全局安装。
- Provider 一次配置，兼容 Agent 按各自受支持方式复用；保留地区、套餐、真实端点与模型身份，不承诺订阅/额度池互通。
- 身份保持分离：Agent 产品、安装、构建、连接、原生会话、任务、请求、连接代次；保持两活动任务与同 Working Copy 排他约束。
- 只覆盖 OpenCode、Pi、Codex；第四 Agent、LifeModel、跨 Agent 协作、远程 Host、账号池和商业分发不进入本轮。
- 旧开发会话按已明确范围不迁移；重要 Provider 配置、新会话与日用数据必须保护。不得清理未归属文件、外部项目或 Runtime 数据。

## 2. 七个阶段与退出条件

| 阶段                                   | 工作与复用重点                                                   | 进入下一步的条件                                                                          |
| -------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A：现状与能力基线                      | 复用已有三路研究，只补版本过时或缺失证据，核对工作区改动归属     | 已接受能力 → ACP 支持/缺口/证据 → 公共接口约束有明确映射；不把未知当支持                  |
| B：公共 Host / ACP                     | 统一连接、任务、请求、代次与终态；明确文件、终端和交互职责       | 旧事件/回执不污染新任务；确认取消释放占用，断线保持未知且不重发；相关合同测试通过         |
| **C：OpenCode 完整流程（Dev 已完成）** | **C1–C5 串联前端、Host、ACP、安装、Provider、交互、成果和恢复**  | 2026-09-12 工程出口及协调复审通过；集中候选后小范围修正按第 4 节复测/复用，不冒充正式交付 |
| D：Pi 接入                             | 复用同一机制，保留插话、follow-up、扩展交互                      | 已接受能力逐项对照通过；缺口未解决则标未迁移，不能以旧原生路径宣布 ACP 完成               |
| E：Codex 接入                          | 用 A 中核查的固定组合复用同一机制                                | 提问、停止、配置、恢复和成果等支持项有该组合证据，不外推旧 App Server 验收                |
| F：三路安装与去随包                    | 复用 C1 安装服务，核验缺失/多版本/移动/升级，移除过渡随包资源    | 主包不带 Agent 仍可首次使用；安装有修复出口，重要配置和需保护数据可恢复                   |
| G：整体验收与交付                      | 同候选三路任务、交互、恢复、Provider、审阅、并发、配对恢复与清理 | 自动检查、原生对照、安装应用及用户验收分层记录；未知项不隐去，正式替换按保护边界执行      |

B 的共性缺陷在 C 验证中发现时回到同一公共实现修正，不增加另一个工作包或复制 Agent 专属控制中心。

## 3. C 阶段的五个步骤

| 步骤                       | 需要完成的用户流程与关键失败行为                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| C1 安装与连接              | 本机发现/多版本选择，缺失按需安装，版本与摘要校验，普通入口启动、身份绑定及恢复；取消、失败清理、损坏修复和重复操作可靠               |
| C2 Provider 与任务绑定     | 一次保存、应用到 OpenCode、模型选择与任务绑定；区分保存/应用/请求验证，防旧回执、错误目标及活动任务改配置                             |
| C3 任务与原生交互          | 发送、流式、工具状态、权限、提问、允许/拒绝/取消；旧请求失效，运行中停止及取消后下一轮可用，断线不盲目重发                            |
| C4 文件、Git、终端与工作台 | 代码展示、文件定位、真实 diff/基线和成果审阅；区分 Agent 报告与磁盘事实，覆盖外部编辑、非 Git、大/二进制文件、路径边界和终端输出/清理 |
| C5 恢复与入口统一          | 冷启动恢复、继续工作、侧栏返回；打不开不新建空会话，取消中退出重开不丢身份、不混旧事件；收敛实验和重复入口                            |

C1–C5 均于 2026-09-12 完成 Dev 工程出口。每步的实际改动、验证、未解问题和回退点见实施记录；不是五次完整打包验收。
必需能力、24 项公共职责及详细异常标准见[规格第 10 节](../reports/2026-09-10-host-architecture/Farfold-下一阶段规格.md#10-已批准职责与验收细则)，不凭概览缩减范围。

## 4. 测试与验收节奏

- 日常只检查受影响逻辑与相关行为；取消、任务绑定、代次隔离、数据保护等关键规则修改后及时验证。
- 一条流程接通后做简短集成/冒烟。C1–C5 不默认逐步全量构建、打包、真实模型调用或桌面全套回归。
- C、D、E 阶段出口集中真实 Agent、真实 Provider、同一候选安装应用完整验收；F 验安装变更，G 验三路最终候选及仓库要求的全套检查。
- 已通过项无相关变更就引用原证据；修复先复测失败项及影响范围。跨模块风险、删除旧路径、证据失效才扩大回归。
- 测试按有限清单连续执行；独立失败记录后继续无关项，共同基础失效或数据风险才暂停相关范围。不无条件重试到绿。
- 模拟服务验证协议和故障，不代替真实使用；测试成功必须核对预期输出、状态和副作用，不能只看没卡住。
- 必需原生能力未通过不能删除旧可用路径；Agent 不用的 Host 回调可用合同测试，但须标未验证实际调用。
- 旧入口删除后补受影响检查；阶段末完整验收和正式应用/数据配对恢复门槛不降低。保留首次失败和未知项，日志脱敏，不重复输出长日志。

## 5. 当前风险与决策门槛

- Pi 原候选缺口已有固定源码和真实无模型证据；用户已批准有限维护路线。交互/终态/身份、普通 Host 与请求投影已有定向验证；既有 ACP 会话工作台、managed 新建和同会话多版本应用有隔离浏览器接线证据，不可称 Dev 产品可用或 D 完成。原生模型/OAuth、完整工作台及安装出口仍待完成，不能借旧桥宣告迁移。当前持续实施。
- Codex ACP 与已接受 App Server 版本组合不同；先核查固定组合，不改用户全局 CLI 来凑兼容。
- OpenCode C 工程出口已通过；当前仅文本输入，不宣告图片/附件、OAuth、完整 slash/compact/扩展/MCP 管理。公共 fs/terminal 合同证据不等于固定 OpenCode 实际调用。
- Turn diff 是记录基线与当前磁盘的比较，不保存终止时文件正文；审阅标记不是对后来磁盘变化的永久批准。
- 旧 Pi 启动超时仍为未解释观察；后续成功不能证明已根治。
- 一次 ACP EOF fixture 波动复测通过，但根因仍未确认；不写成已根治。
- 撤销/提交、完整交互 shell 界面不在默认范围；基础终端、输出、文件审阅和代码展示必备。扩大范围前明确方案。

## 6. 文档入口与更新规则

| 查什么                                    | 唯一对应位置                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前顺序、进度、下一步、阶段门槛          | 本文件                                                                                                                                                                                  |
| 做什么、由谁负责、详细正常/失败行为与验收 | [下一阶段规格](../reports/2026-09-10-host-architecture/Farfold-下一阶段规格.md)                                                                                                         |
| 三路候选与能力证据                        | [接入研究索引](../reports/2026-09-10-host-architecture/Farfold-接入研究索引与设计规则.md)、[能力保留矩阵](../reports/2026-09-10-host-architecture/Farfold-三路ACP能力保留与状态流程.md) |
| 每轮做了什么、测试与复审证据              | [实施与验证记录](../reports/2026-09-10-host-architecture/Farfold-实施与验证记录.md)                                                                                                     |
| 整理前旧计划、旧验收与交付记录            | [历史归档](archive/runtime-neutral-lifemodel-through-2026-09-11.md)                                                                                                                     |
| 已安装应用的正式交付事实                  | [INTERNAL-USE](../INTERNAL-USE.md)                                                                                                                                                      |

执行任务每轮先读本计划与当前步骤所需规格/源码，不必通读历史归档。长日志与已完成过程移入记录，本页只更新状态、剩余问题、下一步及证据链接。
已存在研究只修订过时/缺失部分，不另起重复报告或第二份活动计划。保持本文件简短；职责细则归规格，具体实现记录归日志。
执行任务负责按计划实现；协调任务独立审阅代码与证据，通过后再推进依赖步骤，不把审查发现自动扩成新范围。

### 片 0 完成记录（2026-09-18）

- `PRODUCT.md` 重写为 112 行契约（旅程 J1–J6、页面清单、术语表+UI 禁用词、文案/能力呈现原则、架构边界）；原文归档 `plans/history/product-log.md`。
- `AGENTS.md` 压至 73 行（读序、产品边界、阶段 6 十条纪律、开发规则、Checks）；原 Active Sequence 归档 `plans/history/agents-log.md`。

### 片 A 完成记录（2026-09-18）

- **D11 落定：用官方 `agent-client-protocol@2.2.0`**（`agent-client-protocol-tokio` 只兼容 0.x，弃用）。本机 OpenCode 1.15.13 `acp`、registry `codex-acp@1.12.0`、`pi-acp@0.0.33` 三 Agent 全链路跑通 initialize→session/new→prompt→update→stopReason。
- 握手能力：三者均支持 loadSession；opencode sessionCaps=list/resume/close，codex=list/delete/additionalDirectories/resume/close（+wire 上 fork/subagents），pi=list/delete；三者 promptCapabilities 均含 image；authMethods：opencode=opencode-login(terminal)、codex=api-key+chat-gpt+logout、pi=terminal `--terminal-login`；configOptions 三者同构（id/name/category/type/options）。
- 新增：`shell_env.rs`（`$SHELL -ilc env` 缓存）、`acp_client/` 骨架、`bin/acp_spike.rs`；握手原文存 `research/acp-handshakes/`。
- 注意：typed API 会丢弃未知字段（codex `_meta`、`sessionCaps.fork/subagents`）→ 片 B 在 `with_debug`/`on_receive_dispatch` 加 raw tap 兜底。

### 片 B 详案（2026-09-18 plan，自查后执行）

- **修正**：放弃捆绑 Node（裸二进制 112MB 无 npm）。`node_runtime.rs`：优先用 login-shell PATH 的 node+npm；否则下载官方 `node-v22.x-darwin-arm64.tar.gz`（固定版本，校验 nodejs.org SHASUMS256）+ `npm-<v>.tgz` 中的 npm-cli.js 到 `app_data/node/`。resources 删除 pi-runtime/pi-capabilities/codex-acp-adapter/pi-acp-adapter（包体 -320MB）。
- **B1 Rust**：新增 `meta_store.rs`（新库 `farfold.sqlite3`：agents/sessions/settings 三表）、`agent_catalog.rs`（三 Agent 定义 + registry 拉取缓存）、`agent_discovery.rs`（login-shell PATH + ~/.opencode/bin 等 + 手动浏览）、`agent_install.rs`（registry binary 下载校验 sha + npx 私有安装；codex→CODEX_PATH、pi→PI_ACP_PI_COMMAND 注入已发现二进制）、`acp_client` 完整化（connect/disconnect/status + with_debug raw tap 写 `~/Library/Logs/Farfold/acp-*.jsonl`）、`node_runtime.rs`、重写 `lib.rs run()` 与 `ui_transport.rs`（新命令：catalog_list/catalog_scan/agent_install/agent_register/agent_add_custom/agent_connect/agent_disconnect/agent_remove）。
- **B1 删除**：acp__、capability_authority、codex__、host_store/ 全部、interaction_registry、live_session_projection、managed_provider、opencode__、pi_acp_、pi_acp_interactions、project_file_reference、runtime_event_router、runtime_host、runtime_registry、runtime_supervisor、session_controller、turn_coordinator、lifemodel.rs（修正 00.6：数据模型设计另存，F 片重建最小模块）、update_recovery（与 host_store 耦合部分）、scripts/ 除 sign-update-metadata.* 外全部、main.rs 旧 sidecar 分支。保留：host_ids（若被用）、performance_trace、transport_security、update_*、managed_update、shell_env、acp_client、meta_store。
- **B2 前端**：删除全部旧组件/runtime 模块；新 `Workspace` 壳（侧栏骨架 + 空态 + Settings 三页：Agent 接入可用、LifeModel/通用静态）；`runtime/agents.ts` API；styles.css 重写起步（F 稿纸白 token）。
- **出口**：cargo/pnpm 全绿；安装版 Settings 自动列出本机 OpenCode/Codex/Pi 并「连接」成功显示版本。

### 片 B 完成记录（2026-09-18）

- 提交 `见 git log`：Rust 237+ 文件删除（31 旧模块 + 两个自维护 adapter + 全部 pin/fetch 资源，包体 -320MB）；新增 meta_store/agent_catalog/agent_discovery/agent_install/node_runtime/acp_client manager；前端 174 文件删除，新壳 + Settings「Agent 接入」真数据：自动发现本机 OpenCode 1.15.13、Codex 0.143.0、Pi 0.80.2，registry 可安装版本展示。
- 修正记录：`lifemodel.rs` 随 host_store 一并删除（00.6 原计划保留——其 2682 行与 host_store 深度耦合，数据模型设计需时从 git 历史提取，片 F 重建最小模块）；npm 复用 node dist 自带 npm-cli（不再单独下载 npm 包）；主题默认改为纸白（原 system 跟随会进深色）。
- 截图：/tmp/farfold-shots/b2-empty.png、b2-settings.png。安装版运行正常。

### 片 C 详案（2026-09-18 plan，自查后执行）

- 握手事实：codex authMethods=[api-key(agent型,env:CODEX_API_KEY/OPENAI_API_KEY), chat-gpt(agent型浏览器流)]+logout；pi=[terminal型 args=["--terminal-login"]]；opencode=[opencode-login 无type，描述为"Run opencode auth login in the terminal"]→按协议默认 agent 型，但实际需客户端推导命令 `opencode auth login`。
- Rust：`pty.rs`（portable-pty：spawn/write/resize/await_exit，输出经事件通道）、`auth.rs`（auth_methods/auth_run：agent型→authenticate；terminal型→推导命令进 PTY——pi→`pi-acp --terminal-login`，opencode→`opencode auth login`，无args且无推导规则→报错；api-key→`auth_set_api_key` 存 macOS keychain `security` CLI，agents 行记 env 名列表，spawn 时注入不存 sqlite）、`settings_get/settings_set`（修 B2 localStorage 遗留）、logout（codex）。
- 前端：AgentCard 已连接时展开「登录」区：chat-gpt→「开始登录」按钮+状态；terminal→内嵌 xterm 面板；api-key→密码输入+保存；opencode→「在终端登录」内嵌 PTY。依赖：`portable-pty`、`@xterm/xterm`、`@xterm/addon-fit`。
- 出口：codex 已登录场景免登录；pi 终端登录 PTY 可交互；api-key 保存后注入生效。截图。

### 片 C 完成记录（2026-09-19）

- 提交 `见 git log`：新增 `pty.rs`（portable-pty PtyManager：spawn/write/resize/await/close，输出经 Channel 推 base64 块，退出即 SIGHUP，退出后 await 立即返回）、`auth.rs`（auth_methods/auth_run/auth_set_api_key/agent_logout/settings_get/set）；manager 加 `clientCapabilities.auth.terminal`、Logout 命令、spawn 时 `__keychain__` 占位解析注入；前端 `InlineTerminal`（xterm 懒加载+fit+双向输入+退出码提示+自动重连）、`AgentAuthSection`（agent 型「开始登录」+浏览器提示、terminal 型内嵌终端、api-key 密码框+保存后重连、opencode 走推导命令的终端入口、`退出登录`）；`agent.<id>.work` 迁入 settings 表并惰性迁移 localStorage 旧值。
- 环境限制记录：本机无辅助功能权限，合成点击不可用；截图构建带 TEMP-QA 前端补丁（默认进设置、自动连接已注册 Agent、pi 卡置顶+自动开终端），截图后全部还原并重装净版；三个 Agent 行按 `install_from_registry`/`register_discovered` 同形直写 sqlite 种子（codex-acp@1.12.0、pi-acp@0.0.33 经 npm 私有安装进 app_data）。
- 截图：/tmp/farfold-shots/c-settings-agents.png（OpenCode 已连接+「在终端登录」入口）、c-codex-auth.png（Codex 已连接+API Key/ChatGPT/退出登录登录区）、c-pi-terminal.png（Pi 已连接+内嵌终端运行 `pi-acp --terminal-login`，pi TUI 输出可见）。
- 删除证明：`rg "codex_acp|pi_acp|native_auth|configure" src-tauri/src src/` → 0 命中；禁用词自查 `rg -i "Runtime|Host|ACP|原生|绑定|代次|投影|占用|Working Copy|Session|Turn" src/components` → 仅 `noSessions` 标识符命中（非用户可见字符串）。
- 余留：api-key 保存→注入链路有 keychain 往返单测覆盖，但未在 UI 上人工输入验证；浏览器流（chat-gpt 开始登录）与退出登录按钮未实际点击（无输入权限）。
