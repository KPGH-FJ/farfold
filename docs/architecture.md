# 当前源码架构

现状：2026-10-01 工作区源码。本文描述模块职责与数据边界，不表示当前候选已通过安装验收；安装身份和分项结果见 [status.md](status.md)。客户端文件/终端能力（`fs_ops.rs`、`terminal_ops.rs`）已删除。产品要求见 [PRODUCT.md](../PRODUCT.md)。

## 全产品工作台

`App` 统一装配新对话、对话库、对话内容、Agent 发现与设置五类视图。`Sidebar` 提供新对话、全部对话、收藏、探索 Agent、按 Agent 查看及用户分组；状态筛选和搜索由 `ConversationLibrary` 处理。这些入口只改变浏览范围，不改变已有对话的 Agent、模型或工作目录。对话库复用现有索引和内存状态，支持标题/文件夹搜索、Agent/分组/状态筛选、收藏、重命名、批量归档与分组整理；对话顶栏查找只检索当前已呈现内容，没有新增跨历史正文搜索库。

`collections.ts` 将分组定义和对话到分组的关系保存在现有 MetaStore settings 的 `conversationGroups.v1` 中；写入串行，成功后才发布新状态，失败保留最后确认值。删除分组只删除该分组和对应关系，不删除对话。收藏和归档继续使用 `sessions` 索引已有的 `pinned`、`archived` 字段；分组不是目录，也不承载正文。`CollectionActionScope` 防止重复动作，并使迟到结果不回填到已关闭或切换的整理界面。

新对话由 `EmptyState` 与同一个 `Composer` 完成。`drafts.ts` 管理新草稿、会话输入、队列编辑、文件意见和新对话选择；`draft_storage.ts` 将这些未发送内容与整理所需活动元数据一起保存到现有 MetaStore settings 的 `unsentWork.v1`，支持重启恢复。`setup_storage.ts` 另将准备步骤、选择与明确完成标志保存到 `agentSetup.v1`；它不保存认证或真实请求成功状态。`DraftStartup` 在两份记录成功读取前阻止编辑，格式未知或读取失败不会覆盖原值；异步保存串行合并新改动，发送和退出前等待保存及图片读取完成。这里保存的是用户未发送内容，不是 Agent 正文或事件历史。

`pending_conversation.ts` 在首发前保存实际已打开的 Agent、目录、对话和来源；发送结果不确定时保留这个目标，查看与恢复不按当前新稿选择猜测，也不自动重发。接纳后只清理仍属于所提交快照的输入，后续编辑继续保留。`queue_edit.ts` 在本次运行中用原消息对象确认编辑目标；重启保留编辑内容，但不会按索引或相同文字猜测重复消息的归属。

无需先选项目即可新建普通对话。`app_default_working_directory` 在应用数据目录下准备稳定的 `conversations` 子目录，macOS 对应 `~/Library/Application Support/ai.farfold.desktop/conversations`，并校验规范化路径没有指向其他位置。用户可在新对话中明确选择资料文件夹替代它；默认目录不取用户 HOME 或上一次项目，不重写 Agent 配置，也不创建私有 HOME。Agent 准备页的连接检查同样使用此目录；目录准备失败呈现重试，不默默改换位置。

`App` 在切换主要视图时保留开始页和当前对话挂载；Agent 发现、设置与访问过的 API 页也保留。隐藏页面通过 `active` 限制输入、审批快捷键、预开操作及顶层弹窗，未保存的 API 表单只留在内存，暂离后可恢复。返回栈保存原对话 key、设置页签，以及 Agent 页的目标、use/manage 意图、准备上下文、筛选/弹窗状态和原草稿快照；从准备页经 API 设置管理另一 Agent 后，仍能返回原入口。

从已有对话直接管理其 Agent 时，`agent_repair.ts` 传入只读来源、模型与思考上下文；按错误定位账号、模型或程序，完成返回原对话，不改首次准备进度或既有选择。普通探索不携带这个只读上下文；卡片的显式新建与非只读准备完成以 `new-conversation` 表达新建意图，同 Agent 或跨 Agent 都进入新草稿。历史导入的准备返回优先保留原查找。应用新选择前，`draft_choice.ts` 检查是否会覆盖另一个入口留下的草稿，需确认时先保留原稿。后台执行仍由现有会话管理器负责，没有第二套消息、审批或执行实现。

## Agent 与 API 配置

`AgentHub` 使用 `agents.cards` 展示官方目录、本机发现和自定义接入，支持发现/已添加、搜索、来源和安装可用性筛选。首次准备完成记录经保存确认、已连接且没有待处理账号操作的条目才提供新对话入口；未完成时主按钮和设置均续同一准备。首次使用与日常管理共用 `AgentSetup` 的账号/模型/程序页签：未连接进入程序，连接成功读取模型，明确的认证要求进入账号；进行中或结果未知的登录保持可访问。明确完成才保存新建选择并交回原稿，不自动发送；旧会话管理只返回原会话。关闭和暂离不提交新建选择。两种入口共用 `AgentPrerequisites`、`ProgramManager`、`AgentAuthSection` 和来源选择，不复制管理面板。

`setup_storage.ts` 在 MetaStore 的 `agentSetup.v1` 中分别保存准备进度与明确确认的新建选择。探索卡片和输入区切换 Agent 使用已确认选择，准备进度仍按入口隔离；写入成功才发布确认，失败可重试，移除后的迟到写入不能恢复选择。旧记录只能在完成标记、入口与选择一致时迁移，否则回到确认步骤。完成准备不是登录或模型请求的成功凭据。

安装前的公开启动模型字段由 `acp_client/recipes.rs` 核实声明，`installation_parameters.rs` 生成通用字段和审阅身份。准备页只读缓存，不因打开页面刷新网络；实际安装在配置锁内取得同一目录快照，核验审阅后才准备工具及程序。身份包含公开分发环境，原用户环境不进入摘要或界面。`AgentInstallOptions` 供首次安装与更新共用；可选空值沿用官方启动设置，公开目录回退只作说明，不覆盖会话选择。输入保存在既有准备进度，确认后的字面参数进入原安装收据；不能完整保留的旧额外参数拒绝更新，失败与取消不改变原目标。当前核实入口仅覆盖 fast-agent 0.10.1 的官方 `--model` 公开名称或模型代号，真实效果见对应候选证据。

`agent_preparation.ts` 通过普通 `threads` 打开独立检查草稿读取模型选项；读取、失败重试与可选短消息测试分别呈现，只有用户明确测试才发送。测试结果要求消息已接纳、回复精确匹配及成功终态，不能将连接或读取选项当作请求可用。程序、账号、服务或显式模型选择变化使旧结果失效；旧准备只能补充省略的默认值，不能覆盖调用方的新选择。模型设置返回同时校验当前入口，迟到结果不回填到另一个选择。它只拥有准备显示和本次操作，不新增执行器或正文存储。

配置动作后的明确读取要求由同一准备控制器持有，目录、新稿与已有未接纳草稿都消费该要求；只有当前明确读取成功并应用原选项后解除，失败、迟到或选择变化继续保留。读取错误与之后真实消息失败分别记录，失败结果不能把额外默认选项写回用户选择。动作审阅与运行使用同一规范化目录，但不改用户显示或保存的路径。准备页通过 `preserveOrigin` 保留原对话，独立准备进度沿既有入口隔离，返回不覆盖其他目录的未完成进度。

模型读取还比较本次明确请求的选项与实际返回值；不一致时保留调用方选择和本次失败，只在明确重试后重新读取。顶层 `modes` 合成的模式在普通选项更新时保留，真实同名或同类别配置优先。新草稿恢复合成模式使用标准 `session/set_mode`，不将它作为任意配置 ID 发送；既有对话的模型、思考和权限恢复保护继续生效。

设置中的 Agent 与账号进入统一 `AgentHub` 的“我的 Agent”，返回时恢复原设置页和此前准备上下文。`AgentAccessSettings` 与专属 `AgentCard` 已删除；自定义命令在 `CustomAgentDialog` 明确提交后登记，取得真实标识再进入共享 `AgentSetup`。登记成功与目录刷新失败分别处理，避免重试重复添加。`ProgramManager` 在共享程序页读取和管理实际安装，命令/参数仍在高级入口；普通使用不要求先选择项目。上述 2026-09-30 增量目前属于源码，安装验收以状态页候选记录为准。

`CredentialSettings` 是独立 API 配置页。`credentials.rs` 在现有 settings 中保存服务身份、提供方说明、基础地址、接口格式、多个模型及 Keychain 引用；Key 不回读界面、不进入数据库或日志。旧记录保留，字段不完整时需补充，不能由名称猜测接口或模型。`credential_editor.ts` 提供与后端一致的基础地址校验和实时保存条件，字段错误通过可访问描述就地呈现；测试成功不是保存的必要条件。旧逐 Agent/env 使用关系仅作为历史兼容项显示和撤销，不再提供新授权向导；旧连接使用状态的内存观察和界面已删除。

`ApiTestPanel` / `api_test.rs` 提供显式读取模型列表与单模型短请求，保存前后均可测试。测试是独立的有界 HTTP 诊断：限制等待、响应大小与并发，不跟随重定向、不自动重试，支持取消；取消不表示服务端已经停止执行。结果不写入持久成功状态，也不等同于通过 Agent 完成工作。

新工作通过 `ServicePicker` 选择沿用 Agent 已有设置，或选择兼容 API 配置及模型。选择携带记录修订，服务地址、接口、密钥或模型集合变化后保留原选择并要求用户重新选择，不自动采用新修订。`acp_client/service_config.rs` 转换已验证的官方启动配置，`service_connection.rs` 隔离来源并校验恢复；两者复用现有管理器，不新增 Agent loop 或模型代理。当前开放 OpenCode 的 Chat Completions/Responses 与 Codex 的 Responses；OpenCode 分别使用官方 `@ai-sdk/openai-compatible` / `@ai-sdk/openai` 配置。Pi、Claude、Cline 及其他当前未声明此能力的接入沿用已有设置，不能由 API 测试支持的格式推导 Agent 配置能力。

真实服务配置证据来自 V0 直连探测，见 [OpenCode](evidence/2026-09-23-service-validation/opencode/README.md) 与 [Codex](evidence/2026-09-23-service-validation/codex/README.md)。另有 [OpenCode 1.18.31 Responses 补验](evidence/2026-09-23-service-validation/opencode/responses-validation.md)：使用与生产相同结构的服务配置，确认新会话直接采用所选模型，并覆盖工具调用、两来源隔离和冷恢复。该补验运行真实 Agent 与本地受控服务，不代表任意外部服务、真实模型能力或安装版跨 Agent 复用已通过；Codex 外部服务的冷恢复同时报告服务失败，仍按失败保留。本轮生产路径的安装版验证另行记录，不能用直连探测或单测代替。前序 [接入与密钥验收](evidence/2026-09-22-agent-access-v2/README.md) 保留为历史证据。

`authentication.ts` 在同一目录/来源状态中区分会话创建与实际请求的认证要求。模型列表可能在未认证时返回，因此 `session_open` 成功只可解除创建阶段要求，不能解除 `session_prompt` 的明确认证失败。实际正常回复才清除请求要求；准备页仍允许用户显式读取模型及发送短测试，但不会自动请求，也不凭模型列表放行已知认证失败的使用选择。

## 从应用入口到 Agent

前端 [main.tsx](../src/main.tsx) 挂载 [App.tsx](../src/App.tsx)。App 组合上述工作台、命令面板和已有对话带入弹窗；没有按 Agent 分开的工作台组件。

Rust [main.rs](../src-tauri/src/main.rs) 调用 [lib.rs](../src-tauri/src/lib.rs)。入口先启用性能记录并准备 Tauri context 与 TLS provider，再注册单实例、对话框、打开链接和更新插件，以及 PTY/更新状态。setup 中创建数据目录、初始化日志、清理已登记的遗留进程，然后创建 ACP 管理器、MetaStore、LifeModel 默认设置及目录/Node 状态。当前没有旧版开发身份隔离检查；开发与安装共用 `ai.farfold.desktop`，不能据此假定开发模式有独立数据。

主要调用链：

```text
React 页面 / Composer
  → runtime/agents.ts 或 runtime/sessions.ts
  → Tauri invoke 命令
  → acp_client/manager.rs（连接）与 session_commands.rs（会话动作）
  → 官方 agent-client-protocol crate
  → 外部 Agent 进程
  → session pump 原始事件
  → 每会话 Tauri Channel
  → sessions.ts 内存状态归一化
  → 统一 ThreadView / 审批 / 产物窗格
```

## 模块与职责

| 责任                               | 当前源码入口                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面装配与导航                     | [App.tsx](../src/App.tsx)、[Sidebar.tsx](../src/components/Sidebar.tsx)                                                                                                                                                                                                            |
| 对话库与分组元数据                 | [ConversationLibrary.tsx](../src/components/ConversationLibrary.tsx)、[collections.ts](../src/runtime/collections.ts)                                                                                                                                                              |
| 新对话、持久草稿与默认目录         | [EmptyState.tsx](../src/components/EmptyState.tsx)、[drafts.ts](../src/runtime/drafts.ts)、[draft_storage.ts](../src/runtime/draft_storage.ts)、[new_conversation.ts](../src/runtime/new_conversation.ts)、[conversation_directory.rs](../src-tauri/src/conversation_directory.rs) |
| Agent 发现与准备                   | [AgentHub.tsx](../src/components/AgentHub.tsx)、[AgentSetup.tsx](../src/components/AgentSetup.tsx)                                                                                                                                                                                 |
| Agent 卡片、状态、连接与设置客户端 | [agents.ts](../src/runtime/agents.ts)                                                                                                                                                                                                                                              |
| 会话状态、消息队列、恢复与操作     | [sessions.ts](../src/runtime/sessions.ts)、[session_types.ts](../src/runtime/session_types.ts)                                                                                                                                                                                     |
| 侧栏分组与产物归一化               | [sidebar.ts](../src/runtime/sidebar.ts)、[artifacts.ts](../src/runtime/artifacts.ts)                                                                                                                                                                                               |
| 会话、消息输入、模型与审批展示     | [components/](../src/components/)                                                                                                                                                                                                                                                  |
| 目录与本机发现                     | [agent_catalog.rs](../src-tauri/src/agent_catalog.rs)、[agent_discovery.rs](../src-tauri/src/agent_discovery.rs)                                                                                                                                                                   |
| 安装、候选检查与安装记录           | [agent_install.rs](../src-tauri/src/agent_install.rs)、[install_job.rs](../src-tauri/src/install_job.rs)、[installations.rs](../src-tauri/src/installations.rs)、[node_runtime.rs](../src-tauri/src/node_runtime.rs)                                                               |
| 登录、钥匙串与登录终端             | [auth.rs](../src-tauri/src/auth.rs)、[pty.rs](../src-tauri/src/pty.rs)                                                                                                                                                                                                             |
| API 记录、直接测试                 | [credentials.rs](../src-tauri/src/credentials.rs)、[api_test.rs](../src-tauri/src/api_test.rs)                                                                                                                                                                                     |
| 服务配置转换与来源隔离             | [service_config.rs](../src-tauri/src/acp_client/service_config.rs)、[service_connection.rs](../src-tauri/src/acp_client/service_connection.rs)                                                                                                                                     |
| 连接和生命周期                     | [manager.rs](../src-tauri/src/acp_client/manager.rs)、[supervisor.rs](../src-tauri/src/supervisor.rs)                                                                                                                                                                              |
| 会话命令与协议分发                 | [session.rs](../src-tauri/src/acp_client/session.rs)、[session_commands.rs](../src-tauri/src/acp_client/session_commands.rs)、[pump.rs](../src-tauri/src/acp_client/pump.rs)                                                                                                       |
| 项目文件列表与读取                 | [project_index.rs](../src-tauri/src/project_index.rs)                                                                                                                                                                                                                              |
| 元数据与索引合并                   | [meta_store.rs](../src-tauri/src/meta_store.rs)、[session_index.rs](../src-tauri/src/acp_client/session_index.rs)                                                                                                                                                                  |
| 已有对话查找、预览与带入           | [ImportConversations.tsx](../src/components/ImportConversations.tsx)、[history_import.ts](../src/runtime/history_import.ts)、[session_discovery.rs](../src-tauri/src/acp_client/session_discovery.rs)                                                                              |
| 日志与诊断                         | [logging.rs](../src-tauri/src/logging.rs)、[tap.rs](../src-tauri/src/acp_client/tap.rs)、[diagnostics.rs](../src-tauri/src/diagnostics.rs)                                                                                                                                         |
| 更新校验与安装                     | [managed_update.rs](../src-tauri/src/managed_update.rs)、[update_feed.rs](../src-tauri/src/update_feed.rs)、[update_metadata.rs](../src-tauri/src/update_metadata.rs)                                                                                                              |
| LifeModel 预留                     | [lifemodel.rs](../src-tauri/src/lifemodel.rs)、[LifeModelSettings.tsx](../src/components/LifeModelSettings.tsx)                                                                                                                                                                    |
| 登录操作与准备状态                 | [auth_activity.ts](../src/runtime/auth_activity.ts)、[auth_actions.ts](../src/runtime/auth_actions.ts)、[agent_preparation.ts](../src/runtime/agent_preparation.ts)                                                                                                                |
| 未发送意见、队列编辑与首发目标     | [drafts.ts](../src/runtime/drafts.ts)、[queue_edit.ts](../src/runtime/queue_edit.ts)、[pending_conversation.ts](../src/runtime/pending_conversation.ts)、[FileFeedbackDrafts.tsx](../src/components/FileFeedbackDrafts.tsx)                                                        |
| 请求结果与尾程显示                 | [completion.ts](../src/runtime/completion.ts)、[round_result.ts](../src/runtime/round_result.ts)、[artifact_view.ts](../src/runtime/artifact_view.ts)                                                                                                                              |
| 活动元数据与后台归档整理           | [archive_activity.ts](../src/runtime/archive_activity.ts)、[auto_archive.ts](../src/runtime/auto_archive.ts)、[meta_store/archive.rs](../src-tauri/src/meta_store/archive.rs)                                                                                                      |
| 草稿恢复与保存退出                 | [DraftStartup.tsx](../src/components/DraftStartup.tsx)、[draft_exit.rs](../src-tauri/src/draft_exit.rs)                                                                                                                                                                            |

`event_bus` 是旧计划中的概念名，当前没有该 Rust 模块；事件通过 pump 与每会话 Channel 传递。`src/runtime/` 是前端状态目录，不承担 Agent loop。

## 发现、安装与认证

`acp_client/recipes.rs` 保存经过官方资料核验的程序依赖与组件适用范围，`preparation.rs` 结合实际程序与公开版本形成通用诊断；`dependency_install.rs`、`AgentPrerequisites` 和 `AgentAccountLinks` 消费准备信息。依赖样本包含 Amp CLI 与 Pi，未知组件范围不套用已知要求，低版本诊断不替代 `initialize`。公开账号说明覆盖已声明的 Amp/Qwen、Codex、OpenCode、Claude 与 Cline 路线，部分链接按实际认证方法 ID 限定。OpenCode 指向所选服务说明，Claude 订阅与 Console 分开，Cline/ClinePass 与 ChatGPT 分开；未知方法不套用其他账号入口。外部注册返回只表示继续准备，不置认证成功或权益可用。依赖安装复用配置锁、候选检查和收据，同源有界下载；打开会话在配置锁内核对依赖，启动副本中只追加公开程序路径。

兼容候选通过 `npm_release.rs` 核对官方发行、发布时间、入口与 Node 要求；`node_runtime.rs` 检查实际 Node，`program_launch.rs` 固定其绝对路径与官方程序入口，仅转发参数。`prepare_candidate` 向既有 `installations.v1` 保存未选程序，不改注册目标或关闭连接；程序清单中的明确选用另经现有工作保护与连接检查。收据与包目录检查约束受管安装来源，不建立任意 Agent 的连接版本白名单，也不升级日常外部 CLI。

`AgentAuthSection` 根据实际 `authMethods` 决定单方法直接显示或多方法先选择，再呈现该方法的登录、账号准备和高级配置；选中方法随准备进度保留。`auth_actions.ts` 将明确操作交给每 Agent 一个内存 `AuthActivity` 和可续看的 `BufferedLoginTerminal`，所有权不随页面卸载或隐藏消失。完成及重查调用 `auth_recheck`：持有配置锁，只替换启动目录的已有设置连接，等待旧进程确认结束后握手；其他目录、API 来源及候选连接保持原状。原连接若已经开始工作则拒绝关闭，登录完成与检查未完成分开显示。`auth_blockers.ts` 仍根据同 Agent 的执行、待处理审批/问题、发送及停止未知等真实工作状态保护账号变更，点击时再次检查；普通未发送稿和暂停队列不作阻塞。共享账号变更对 API 任务的影响尚未核实，不凭重连范围缩小就放宽认证准入。同 Agent 操作未结束时阻止另一登录及破坏性程序变更，界面仍可暂离。账号认证只针对已有设置；选用 API 来源时转向 API 设置。命令退出、重新连接、账号权益与真实请求结果保持分离。

`acp_client/handshake.rs` 在官方 SDK 的同一次 `initialize` 响应中形成一个连接所有的 `Handshake`：普通能力仍按官方类型解码，认证声明单独保留有界、已核验的类型与必要字段。公开快照去除终端参数、环境值和执行元数据；执行材料只留在该活连接内。`auth_methods` 按工作目录与来源选择精确连接，没有对应活连接时缓存只作不可执行说明，不能从其他目录或 API 连接借用登录能力。普通认证和退出在执行前再次核验当前声明，失败不回退到持久快照。

旧实验 `env_var` 声明只提供环境变量名称及尚不可自动执行的出口；未知、畸形或重复方法也不能退化为普通 `authenticate`。这属于旧声明的兼容保护，官方已撤下的实验类型不会被当作现行协议或已完成 Key 交付。前端切换 Agent、工作目录或来源后立即失效旧方法；连接状态事件只重新读取声明，不发起连接或认证。用户明确配置的官方命令仍沿已有高级入口执行。

官方服务配置作为独立的通用 `service_configuration` 准备动作返回，不改写 `authMethods`。`acp_client/preparation_actions.rs` 依据配方和既有受管安装记录派生动作，在配置锁内重新比较用户审阅的程序与参数，并预约同 Agent 所有来源的空闲准入。它使用普通电脑环境，不能读取或交付 Farfold 保存的服务密钥。前端通过 `AgentPreparationActions` 审阅副作用，再复用同一个 `AuthActivity`、终端和取消所有权；操作描述独立于后续认证方法列表，退出和重查结果可以继续查看。明确配置操作使原目录进入模型显式重读状态，连接重查或重开界面不自动创建模型读取草稿。以上当前源码的安装验证范围另见 [status.md](status.md)。

标准终端认证保留原命令/参数再追加声明参数，允许空附加参数；任意方法 ID 不能代替协议类型。`acp_client/auth_compat.rs` 只为核验过身份和入口的 Qwen 终端扩展提供官方交互设置及“返回检查”。终端所有权保留至确认回收，流程结束后安全重新连接；认证向单一空闲的已有设置连接发送，不广播到服务连接。Qwen 既有模型提供方配置优先级使通用服务覆盖尚不可保证，故未开放其 Farfold 共享 API 配置。

`acp_client/auth_route.rs` 统一登录方法的显示、执行和协议准入。标准终端声明保持优先；旧扩展必须符合结构并匹配实际执行文件及脚本入口，已核实的伴随程序和 Kilo 固定声明补充留在接入层。无法核验时返回通用原因，保留其他方法、手动配置和重查；不解析描述文字猜命令，不在读取凭据后才发现目标不符。

登录、退出、手动运行及官方配置先取得已有 `AuthActivity` 所有权，再等待同目标模型准备稿真实关闭。`session_draft_cleanup.ts` 的严格模式保留失败稿和原目标供重试，只在确认关闭后移除；普通非账号清理维持原语义。开始前的取消意图留在该活动中，不因取消通知失败后的展示状态变化而再次启动。另一目录或 API 来源的准备稿不由此自动关闭，后端账号工作保护仍生效。

`install_job.rs` 管理逐 Agent 安装和候选检查的取消、阶段通知与配置锁。安装先在独立暂存目录准备；安装、已有程序选择及保留的回退命令共用 `check_and_select`，经官方 initialize 检查并确认候选进程回收后，才用 MetaStore 事务一起写入启动目标、上一选择和安装收据。候选不改当前握手，选用成功后清空旧能力，正式连接重新获取。取消、失败或回收结果未知不选用；未知时保留仍可能在用的目录和对应连接 owner，阻止重复启动。npm stderr 持续排空，只将受控错误码和退出状态转成提示，不展示原始安装输出。

`installations.rs` 在现有 settings 保存安装收据。选择精确到安装实例；程序版本与接入组件版本分别记录和显示。只允许卸载归属明确、未选择且未被接入或候选检查使用的实例；外部安装和缺少可信收据的旧安装不能自动删除。移除接入保留程序、用户配置、历史与已知实例，并撤销该接入的旧密钥授权。升级不会自动断开已有任务，也不等于升级了独立的 Agent 程序。

`credentials.rs` 保存完整服务记录及原有 Keychain 引用。替换密钥先写新 Keychain 条目，再提交引用；失败保留已保存版本，删除清理失败可重试。服务地址或接口变化要求重新填写 Key；旧全局授权仍存在时先撤销，防止将已有密钥默默送到新地址。新工作明确选择服务才生成该连接的环境，保存本身不自动分发或重连。旧单 Agent Keychain 与逐变量授权继续兼容，但不是新服务配置的主流程。

目录保留 OpenCode、Codex、Pi 三个本机发现定义，并展示官方 ACP registry 缓存内身份有效的全部条目；通用条目使用 `registry:<id>`，三个既有身份保持不变。发布信息包括版本、简介、HTTPS 官方说明/仓库链接与图标；界面分别呈现来源、是否已添加和当前设备是否有支持的安装路径，不把目录收录或已安装等同于真实任务可用。简介在 `agents.ts` 转换工程词，来源链接以统一说明按钮呈现。另有用户明确配置的自定义命令入口。

设备适用性与 Farfold 安装能力分别计算：官方提供当前设备分发方式，不代表 Farfold 已实现该分发的安装。当前可执行路径为 `darwin-aarch64` HTTPS `.tar.gz` / `.tgz` / `.tar.bz2` / `.zip` 二进制归档、npx，以及目录声明的具名精确版本 uvx 包；其他归档或包规格保留声明并如实说明当前安装限制。没有本地安装路径时仍可查看官方说明或添加已有程序。参数与公开环境声明保持原义并拒绝覆盖 HOME；通用条目复用下载、归档校验、候选检查及原子选择。`catalog_list` 只读缓存，本机扫描和目录刷新在后台进行，完成推送 `catalog:updated`；3 小时 TTL 决定刷新，网络失败保留最后成功目录。

`uv_runtime.rs` 准备通用 uv/Python 安装工具；目录类型和包语法校验留在 `agent_catalog/uvx.rs`。依赖动作需用户明确点击，与 Agent 包安装分开，且首次未注册条目也可执行。工具下载使用已核实官方归档/摘要，有界展开、检查后在共享发布锁与安装任务提交保护下保留。每次 Agent 安装建立独立受管 venv，禁用安装器隐式下载 Python，通过实际包元数据验证入口后复用候选连接、回收与选用流程。venv 保持原绝对路径，卸载 Agent 不删除共享工具或用户配置。`requiredForInstall`/`requiredForUse` 区分两类依赖；安装工具不会成为已安装 Agent 的使用前提。

| Agent    | 当前启动路径                                                               |
| -------- | -------------------------------------------------------------------------- |
| OpenCode | 本机发现的 `opencode acp`，或 registry 二进制安装                          |
| Codex    | registry 的 `@agentclientprotocol/codex-acp`；发现 CLI 后注入 `CODEX_PATH` |
| Pi       | registry 的 `pi-acp`；发现 CLI 后注入 `PI_ACP_PI_COMMAND`                  |

发现扫描登录 shell PATH、常见用户目录、nvm 与 Homebrew，按真实路径去重；nvm 目录按数值版本排序并有界扫描多份安装。旧计划提到的遍历 `/Applications/*.app` 尚未实现。连接兼容性由 initialize 决定，不校验已安装 Agent 的二进制摘要。

应用不捆绑 Agent 或 Node。npm 所需 Node 优先复用本机 node/npm（源码最低检查为 Node 18），否则下载固定 Node 22 发行包并校验下载摘要。目录采用同一 camelCase 缓存结构；旧缓存没有的新来源字段在后续成功刷新后补齐。无缓存且刷新失败时显示错误与重试，本机发现和已登记 Agent 仍可呈现。这与最初“复用已打包 Node”的方案不同，历史后续记录已记载 Node 改动。

自定义接入用 SQLite 随机 ID 和仅新增 INSERT，名称与同一解释器不再决定身份；旧 ID、历史与 Keychain 引用保留。新增、程序替换、环境更新和握手保存为独立操作；程序替换原子清空能力，握手按实际启动配置条件写入，迟到旧握手不能覆盖新程序。配置锁由实际后台操作或登录进程持有，不随界面取消等待提前释放。

环境来自登录 shell 并继承进程环境，没有私有 HOME 或 `env_clear`；登录 shell 环境探测有超时与输出上限，交互式启动脚本不会卡住主线程。登录根据 authMethods 分发到 authenticate 或声明的 PTY 参数，不解析自然语言说明；API Key 类型在设置中转到独立 API 配置页，不宣称完成账号登录。认证要求仅来自明确的 AuthRequired，并按 Agent、项目、服务来源隔离，不由登录方式数量推断；握手同时带 `_meta["terminal-auth"]`，兼容仍以旧约定下发登录命令的 Agent。`manual_auth.rs` 保存按 Agent/认证方法区分的显式命令、独立参数与可选变量名；不经 shell 拼接。密钥仍在 Keychain，旧引用继续有效。保存配置、命令退出和真实请求成功是不同状态。

## 会话和存储

恢复保护由 `acp_client/model_guard.rs` 统一判定。现有 `sessions.config_options` 保存 `_farfoldConfig:2` 的完整 `choices` 集合：模型与推理选项按唯一 ID 保存类型、类别和值，同类别允许多个不同 ID。比较按 ID、类型和值，已保存 ID 后来改变或省略界面类别不解除保护；界面仍遵循 Agent 的显示顺序。`model_guard/format.rs` 严格读取新版及旧 v1/键值格式；未知版本、重复 ID 和旧键值中无法判断角色的记录不能静默丢弃或猜测。打开历史不自动迁移原记录，没有新表或另一份基线。

首次实际接纳消息才记录，记录失败不把已发消息误报为未发；显式选项确认后更新，恢复和普通通知只更新当前值。打开、通知、发送拒绝使用同一 `configCheck`，以 `protectedIds` 向界面传递原记录与当前声明的保护范围；前端负责提示和操作限制，后端每次发送仍校验。缺少旧推理记录可显式确认完整当前集合，已知漂移、未记录的新增模型及未知原模型不能通过确认绕过。已选 API 继续要求唯一且精确匹配的服务模型；多类别支持不扩大密钥交付范围。元数据保存使用现有 MetaStore，不写入 Agent 请求或私有配置。

协议与连接等待使用异步响应通道和有界超时，连接并发去重通过异步锁与就绪状态完成；SQLite、Keychain、文件和进程查询仍隔离在阻塞工作线程。`MetaStore::run` 共享同一数据库连接，不创建第二份存储。前端 `session_projection.ts` 保存纯事件归一化，`sessions.ts` 协调传输和状态；`thread_notifications.ts` 按会话订阅并合并文本显示通知，原事件按到达顺序立即应用。审批/结束/失败立即冲刷，后台窗口有计时兜底。

恢复模型漂移时旧会话仍只读，可显式创建同 Agent/项目的新草稿，不迁移历史或待发消息，不自动发送；该出口不修复外部模型漂移。未支持的询问方式返回取消并保留原请求供查看，暂停队列、显示说明，不伪造已接受。末尾整段粘贴的 `@文件名` 可进入文件选择，文件仍需用户显式选择。

连接按 Agent、工作目录、用途和有效服务配置修订区分；同一来源的连接可承载多个会话，不同服务/模型不能误复用。默认已有设置和候选检查仍在同一管理器中，由各自 owner 负责生命周期。新建用 session/new，历史恢复用 session/load；显式带入历史时按能力查询 session/list。本地会话索引刷新不等待 Agent 连接或历史查询。前端选 Agent/目录时预开草稿取模型选项（防抖 + 同目标去重，失败不自动重试；发送时按需补开），第一条 prompt 才主动登记新对话索引；显式带入的历史另由成功预览后的提交登记。丢弃草稿会关闭会话并设置隐藏标记。恢复回来的模型与创建时记录不一致会如实提示，不会默默声称一致。 Farfold 已有对话名称优先，Agent 标题只填补空名称；恢复先读本地名称，自动索引更新在 SQLite 内原子填空，并保留当前收藏/归档，避免回放或迟到更新覆盖手动整理。使用原有 title 字段，不增加标题账本。

服务来源保存在现有 `sessions.config_options` 的 `_farfoldService` 中，不新增表或会话账本。新对话选择服务后，由官方 `OPENCODE_CONFIG_CONTENT` 或 `CODEX_CONFIG` / `MODEL_PROVIDER` 环境入口交付配置，密钥只通过独立环境变量引用；不写用户配置文件、不更改 HOME。保存服务身份及地址/接口指纹、所选模型，连接复用另纳入当前密钥和配置修订。恢复遵循原记录，缺少旧记录不能猜成用户选定的新 API；地址、接口、模型移除或服务删除会阻止继续发送，不能静默改用别的来源。更换 Key 不强行终止已运行进程，新连接才取新值。配置交付后核对 Agent 实际选择的模型；通用模型/推理恢复保护仍独立生效。

`configOptions` 由一套能力驱动控件呈现：模型在新稿或准备页选择；思考选项在输入区域附近，既有对话仍受固定规则约束；权限使用独立通用控件；其他 select/boolean/未知类型保留会话选项菜单。顶层 `modes` 合成为选项并路由到 `session/set_mode`，不会仅凭工作模式名称当成权限。恢复的权限需要当前连接的明确确认，未知/缺失/迟到结果不能开放发送。`availableCommands` 提供 `/` 补全；`@` 触发项目文件选择，只有 `embeddedContext` 能力支持时才将用户选中的文件内容内嵌发送。

SQLite 当前有四张表：`agents`、`sessions`、`settings`、`dismissed_sessions`。sessions 保存 Agent、目录、Agent 会话 ID、标题、置顶、归档、配置选项和时间；不保存完整对话或轮次账本。`farfold.sqlite3` 是新元数据库，不迁移旧 Host 会话库。

主题以 MetaStore 的 `themeMode` 为准；仅在该键不存在时读取旧 localStorage 值，保存成功才删除旧键。初始化迁移合并为单次在途读取，正常运行不双写。

`archive_activity.ts` 只保存每段对话最新活动时间和是否已观察到明确结束，不保存轮次或事件账本。它与草稿、队列和意见在同一 `unsentWork.v1` 快照中提交；待提交或保存失败的活动不能作为归档依据。发送前先保存未结束状态，收到有回答/工具结果的正常结束，或已知失败/停止，且无尾程和待处理请求后才记录结束。编辑未发送内容更新活动时间；手动恢复归档重新等待完整期限，浏览、改名和分组不重新计时。

`auto_archive.ts` 订阅现有会话、草稿和活动变化，并周期性检查已确认记录；只整理超过期限、非收藏、无未发送内容、无活动和待处理事项的对话。当前未加载到内存的对话可凭已保存的明确状态参与，未知旧历史保持原位；每次异步写前重新判断，错误可重试。前端归档准入与后端 `meta_store/archive.rs` 的同事务未发送内容检查共同保护正文草稿、图片、队列、文件意见及首发待确认目标；整理只改变现有索引的归档标志，不启动 Agent、不执行模型请求，不属于 Agent loop。

审批和表单按请求 ID 分别保存，表单值与状态归请求所有；`interaction_actions.ts` 共用归属、重复提交和四态回复处理。远端单请求取消、轮次终态、会话/连接结束同步清理；点击停止本身不提前失效。快捷键仅由当前可见会话授权，设置、命令面板、编辑控件和输入法组词不能触发背景审批。

Agent 正文、待审批和产物派生数据只在内存中，重启后由官方历史回放恢复；用户未发送队列与编辑内容单独随草稿持久化，并以暂停状态恢复。协议事件原样进入归一化，未知内容可保留为原始块，不复制进 MetaStore 或诊断日志。

`completion.ts` 保留请求结束原因与失败类别，`round_result.ts` 另行判断已收到回答、工具结果、仍在等待工具或没有结果。`end_turn` 本身不是“已取得结果”；输入参数、计划、思考和工具句柄也不能冒充输出。明确失败、停止、未知、没有结果或仅有在途工具会暂停后续队列；只有正常终态且有回答或工具结果才允许继续，失败工具仍在自己的卡片中显示失败。迟到工具结果按已有内存工具 ID 更新原轮次的结果与产物，不改变旧终态或自动解除队列暂停。

`MessageContent` 按消息对象弱引用缓存同步 Markdown 解析树；文本变化替换该条派生产物，组件状态仍归 React。此缓存避免切换会话重复解析历史，不构成总内存上限；收益与内存须由安装版实测。

历史事件缺少原始时间时，消息时间及工具计时保持未知；工具不会将回放接收间隔显示为执行耗时。只有实时观测到开始和结束的工具才显示本地观测时长，首次只收到完成事件也显示“耗时未知”。这不新增时间账本或数据库字段。

Farfold 不声明文件读写与终端两类客户端能力：Agent 用自己的实现干活，Farfold 只转发审批与表单。产物窗格的差异卡与命令卡由 Agent 汇报的 `tool_call`/`tool_call_update` 内容推导（`type:"diff"` 块、execute 类调用输出，或 edit 类调用参数里带的 filePath/content），不再有 Farfold 侧的文件代跑或 PTY 代跑。空闲回收在有未答审批/表单或在途消息时豁免连接。

产物顶栏入口查看全对话；本轮入口只使用结束时捕获的既有工具项 ID 选取文件和输出，范围失效不借用全对话结果。迟到差异可更新原轮次计数与内容，回放后没有对应内存范围时保留未知。`artifact_view.ts` / `FileArtifactView` 提供文件选择、差异、Markdown 阅读与 HTML 静态预览；工具日志只来自 Agent 已汇报内容。未明确保证完整内容与起始行的差异/参数按片段显示，反馈行号也限定为片段坐标。具备完整 HTML 文档结构的返回内容可预览，但不反推磁盘文件完整；空 sandbox 与 CSP 保持禁止脚本、网络和导航。

`fileFeedbackDrafts` 按对话、文件路径和返回内容标识保存未提交意见及行选择，内容标识不包含产物正文；切换同路径版本不会串用行号或擦掉另一个版本的意见。`FileFeedbackDrafts` 提供已保存意见入口，版本不可定位时仍可查看、复制或加入原对话输入再编辑，不猜测文件当前状态。加入输入框通过 `take` 同次更新输入和移除对应意见，随同一持久快照提交，不自动发送。

`work_policy.rs` 继续在现有 settings 保存版本化默认值及规范化路径覆盖值，并迁移旧开关。策略更新和新工作准入使用同一项目锁；历史恢复、停止和已有审批不受工作关闭影响。开始页与会话页通过 `work_policy.ts` 遵守原有关闭记录，Composer 提供明确恢复工作权限的操作，保存失败不更新有效策略。Agent 准备流程不再以项目选择或项目开关作为前置步骤。

`session_types.ts` 明确区分 draft/established；恢复立即 established，首条消息接纳或结果不确定后固定模型。后端 session pump 串行处理配置与消息，拒绝已有会话模型修改及恢复覆盖。审批状态由现有会话状态和 `interaction_actions.ts` 协调，`permission_shortcuts.ts` 限制可见界面的快捷操作；后端校验所属会话及选项。

`queue.ts` 定义暂停和准入规则；会话协调在 `sessions.ts`。队列仅在后端确认接纳后移除；关闭、断线、失败、停止或结果不确定均保留队列并暂停。重开开关不自动发送；结果不确定的条目不能自动重试。重连用临时状态接收新历史，成功后替换，失败保留原内容；旧通道的迟到事件被忽略。

## 已有对话查找与带入

`ImportConversations` / `history_import.ts` 调用 `session_discover`，复用当前管理器发送官方 `session/list`。连接目录与可选查找目录过滤分别传递；不限定位置时使用 Agent 官方默认范围，不能宣称全局。用户可明确选择原文件夹重新查找；Agent 和位置共同区分本次运行的查找草稿，返回已查范围可恢复其结果、游标、搜索词和选择，不混用另一范围。切换前释放实际预览，并使旧请求的迟到结果失效；标题/目录搜索只过滤当前已加载结果。`cursor` / `nextCursor` 保留官方分页语义。未声明列表能力返回 `unsupported`，有效空列表与请求/格式错误保持区分，不以 Farfold 索引伪造官方结果。目录存在性、已加入/已打开状态只辅助选择；`canLoad` 仅表示声明加载能力。

`session_import_preview` 基于同一个 `session/load` 和每会话 Channel 加载内容；`history_import.ts` 将收到的 `update` 交给既有 `session_projection.ts`，正文仅保留在临时内存。后端在既有打开预留锁和 SessionEntry 中记录临时 `previewToken`：已有打开的目标拒绝预览，预览期间普通打开不能替换其路由，预览不能发送消息或修改配置。关闭与提交都校验确切的 token；迟到或错误的关闭不能结束之后打开的正式会话。该 token 只管理本次打开的归属，不形成持久定位体系或第二份会话账本。

界面仅在对应回放完整结束，且包含用户或 Agent 的可读文字/附件后允许加入。`session_import_commit` 验证仍拥有成功预览，再由 `MetaStore::import_session` 在同一事务中按 Agent 与原会话 ID 查重、写入索引并撤销隐藏标记；已有索引保留用户标题、收藏等元数据。提交失败不留下新成功索引，预览失败本身不登记；界面提交后先关闭自己的预览，再通过普通打开路径进入对话。

带入不复制 Agent 历史，不读取私有日志或凭据，不猜测原模型、推理等级及 API 来源。新索引没有已知配置时保留未知，现有恢复保护照常生效；成功查看历史不等于可以继续发送。当前实现与合成进程测试覆盖这些接口和竞争保护，真实 Agent、安装版内容回放及继续工作的证据仍须按具体 Agent/服务分别记录。

## 进程、诊断与更新

管理器按连接实例拥有独立关闭信号和完成通知；life 中的短临界区统一请求准入与空闲回收。请求在入队前取得持有权和绝对截止时间，过期不发送；有副作用的请求超时仅结束等待，其隔离占位保留至真实终态。打开会话先注册临时路由吸收回放，仅成功交付后成为可操作会话。`process.rs` 从官方 SDK 配置取得原 command/args/env，通过同一锁定的 `async-process` 启动并持有确切 Child，再接官方 ByteStreams；仅补 SDK 启动配置缺少的真实 `current_dir`，保留进程组、三管道和既有回收。普通连接使用已验证的工作目录，安装候选检查继续使用应用数据目录；不改父进程目录或 HOME，目录消失时失败而不回退。它单独排空 stderr，TERM 宽限 2 秒；用户关闭及正常退出总等待 5 秒。结果未确认时保持 closing 和原 owner，不能重复启动同键连接。`supervisor` 的 pids.json 记录 macOS 出生身份，仅对已验证记录进行启动恢复；旧不可信记录不授权终止。正常退出等待实际 owner，不再按进程名或 PID 差集归属。启动不再扫描或按前缀删除临时目录；安装器仅删除自己当前创建的明确暂存路径，遗留文件不做全局回收。

新协议日志只记录格式版本、时间、方向、受控事件类型、字节数和错误类别；普通应用日志也不保存自由文本。`diagnostics.ts` / `diagnostics.rs` 使用问题说明→完整预览→本机导出的流程，导出必须匹配仍有效的 `previewId`，使用这份已生成快照，不临时加入新记录。自动收集项按白名单重验，只含受限日志、设置、版本和统计，排除启动参数、环境值、完整握手、标题、工作路径、正文和密钥；旧日志不导出。用户自填问题说明会明确提示按原样入包，不自动上传。

`DraftStartup` / `draft_exit.rs` 协调正常退出与更新重启：暂停队列，等待未发送内容与准备进度保存后，用匹配的退出 token 确认；保存失败保留应用，旧确认不能授权新退出或穿过安装过程。`managed_update.rs` 的进程内准入锁让更新安装与连接、登录、安装等实际活动互斥，安装成功后保留重启所有权直至保存重启；等待界面结束不提前释放真实操作。

更新检查显式记录未检查、检查中、存在更新、确认最新、检查失败。每次检查先清除旧候选，仅已配置且检查成功可显示最新；错误经统一文案转换。更新源仍未配置，本轮没有增加发布设施，不能据此声明线上更新验证通过。

## LifeModel

只有三个默认关闭的 settings 键和 `context_blocks_for_prompt()` 空返回，前端为静态说明与示例。没有当前可用的 Proposal/Canonical 数据处理闭环，也不能把历史实验模块的能力归到当前版本。
