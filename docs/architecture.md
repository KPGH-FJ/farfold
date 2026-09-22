# 当前源码架构

基线：2026-09-21，本轮移除客户端文件/终端能力（fs_ops.rs、terminal_ops.rs 已删除），目录刷新改后台，新增会话选项菜单、斜杠命令、@ 文件选择与项目文件索引。本文描述源码实际路径；产品要求见 [PRODUCT.md](../PRODUCT.md)，偏差见 [status.md](status.md)。

## 从应用入口到 Agent

前端 [main.tsx](../src/main.tsx) 挂载 [App.tsx](../src/App.tsx)。App 组合侧栏、开始页、会话页、设置页和命令面板；没有按 Agent 分开的工作台组件。

Rust [main.rs](../src-tauri/src/main.rs) 调用 [lib.rs](../src-tauri/src/lib.rs)。启动顺序包括应用身份检查、单实例插件、日志初始化、遗留进程清理、MetaStore、ACP 管理器、PTY 与目录/Node 状态。开发身份检查发生在数据初始化之前。

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

| 责任                               | 当前源码入口                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面装配与导航                     | [App.tsx](../src/App.tsx)                                                                                                                                                    |
| Agent 卡片、状态、连接与设置客户端 | [agents.ts](../src/runtime/agents.ts)                                                                                                                                        |
| 会话状态、消息队列、恢复与操作     | [sessions.ts](../src/runtime/sessions.ts)、[session_types.ts](../src/runtime/session_types.ts)                                                                               |
| 侧栏分组与产物归一化               | [sidebar.ts](../src/runtime/sidebar.ts)、[artifacts.ts](../src/runtime/artifacts.ts)                                                                                         |
| 会话、消息输入、模型与审批展示     | [components/](../src/components/)                                                                                                                                            |
| 目录与本机发现                     | [agent_catalog.rs](../src-tauri/src/agent_catalog.rs)、[agent_discovery.rs](../src-tauri/src/agent_discovery.rs)                                                             |
| 安装与 Node 准备                   | [agent_install.rs](../src-tauri/src/agent_install.rs)、[node_runtime.rs](../src-tauri/src/node_runtime.rs)                                                                   |
| 登录、钥匙串与登录终端             | [auth.rs](../src-tauri/src/auth.rs)、[pty.rs](../src-tauri/src/pty.rs)                                                                                                       |
| 连接和生命周期                     | [manager.rs](../src-tauri/src/acp_client/manager.rs)、[supervisor.rs](../src-tauri/src/supervisor.rs)                                                                        |
| 会话命令与协议分发                 | [session.rs](../src-tauri/src/acp_client/session.rs)、[session_commands.rs](../src-tauri/src/acp_client/session_commands.rs)、[pump.rs](../src-tauri/src/acp_client/pump.rs) |
| 项目文件列表与读取                 | [project_index.rs](../src-tauri/src/project_index.rs)                                                                                                                        |
| 元数据与索引合并                   | [meta_store.rs](../src-tauri/src/meta_store.rs)、[session_index.rs](../src-tauri/src/acp_client/session_index.rs)                                                            |
| 日志与诊断                         | [logging.rs](../src-tauri/src/logging.rs)、[tap.rs](../src-tauri/src/acp_client/tap.rs)、[diagnostics.rs](../src-tauri/src/diagnostics.rs)                                   |
| 更新校验与安装                     | [managed_update.rs](../src-tauri/src/managed_update.rs)、[update_feed.rs](../src-tauri/src/update_feed.rs)、[update_metadata.rs](../src-tauri/src/update_metadata.rs)        |
| LifeModel 预留                     | [lifemodel.rs](../src-tauri/src/lifemodel.rs)、[LifeModelSettings.tsx](../src/components/LifeModelSettings.tsx)                                                              |

`event_bus` 是旧计划中的概念名，当前没有该 Rust 模块；事件通过 pump 与每会话 Channel 传递。`src/runtime/` 是前端状态目录，不承担 Agent loop。

## 发现、安装与认证

2026-09-22 产品打磨改动：`install_job.rs` 管理逐 Agent 安装的取消、阶段通知与短暂配置切换锁；下载和 npm 在独立暂存目录完成，再启用新目标。取消不启用半成品，失败保留旧启动配置；设置中可返回上次安装。已有连接必须先显式断开，不能由升级操作自动中断。`agent_select_program` 按 catalog 声明选择已有执行程序或已包含在接入包中的程序，不修改用户安装。

`credentials.rs` 在 settings 中仅保存密钥标签、服务说明、Keychain 引用及逐 Agent/env 的显式授权；密钥值仅经 Keychain 读取并在启动时注入。共享授权遇到单独配置或继承环境冲突必须确认来源；后续新增来源冲突、授权密钥读取失败会阻止本次启动。替换密钥先写新条目，再更新引用；删除先撤销授权，清理失败可重试。旧单 Agent Keychain 引用继续支持。保存与撤销不会自动重连，界面不能据此宣称认证或请求成功。

目录内置 OpenCode、Codex、Pi 三个定义，拉取 ACP registry 并缓存 3 小时；不是展示任意 registry Agent 的完整市场。另有自定义可执行命令入口。设置页打开时先返回缓存目录，本机扫描与版本探测在后台进行，完成后推送 `catalog:updated` 事件刷新界面。

| Agent    | 当前启动路径                                                               |
| -------- | -------------------------------------------------------------------------- |
| OpenCode | 本机发现的 `opencode acp`，或 registry 二进制安装                          |
| Codex    | registry 的 `@agentclientprotocol/codex-acp`；发现 CLI 后注入 `CODEX_PATH` |
| Pi       | registry 的 `pi-acp`；发现 CLI 后注入 `PI_ACP_PI_COMMAND`                  |

发现扫描登录 shell PATH、常见用户目录、nvm 与 Homebrew。旧计划提到的遍历 `/Applications/*.app` 尚未实现。连接兼容性由 initialize 决定，不校验已安装 Agent 的二进制摘要。

应用不捆绑三个 Agent 或 Node。npm 所需 Node 优先复用本机 node/npm（源码最低检查为 Node 18），否则下载固定 Node 22 发行包并校验下载摘要；目录不可达时还有固定包版本回退。这与最初“复用已打包 Node”的方案不同，历史后续记录已记载 Node 改动。

环境来自登录 shell 并继承进程环境，没有私有 HOME 或 `env_clear`；登录 shell 环境探测有超时与输出上限，交互式启动脚本不会卡住主线程。登录仅根据 authMethods 分发到 authenticate、声明的 PTY 参数或钥匙串 env 注入，不解析自然语言说明；握手同时带 `_meta["terminal-auth"]`，兼容仍以旧约定下发登录命令的 Agent。`manual_auth.rs` 保存按 Agent/认证方法区分的显式命令、独立参数与可选变量名；不经 shell 拼接。密钥仍在 Keychain，旧引用继续有效。保存配置、命令退出和真实请求成功是不同状态。

## 会话和存储

协议与连接等待使用异步响应通道和有界超时，连接并发去重通过异步锁与就绪状态完成；SQLite、Keychain、文件和进程查询仍隔离在阻塞工作线程。`MetaStore::run` 共享同一数据库连接，不创建第二份存储。前端 `session_projection.ts` 保存纯事件归一化，`sessions.ts` 协调传输和状态；`thread_notifications.ts` 按会话订阅并合并文本显示通知，原事件按到达顺序立即应用。审批/结束/失败立即冲刷，后台窗口有计时兜底。

恢复模型漂移时旧会话仍只读，可显式创建同 Agent/项目的新草稿，不迁移历史或待发消息，不自动发送；该出口不修复外部模型漂移。未支持的询问方式返回取消并保留原请求供查看，暂停队列、显示说明，不伪造已接受。末尾整段粘贴的 `@文件名` 可进入文件选择，文件仍需用户显式选择。

连接按 `(agent_id, cwd)` 管理，一个连接承载多个会话。新建用 session/new，历史恢复用 session/load；能力允许时合并 session/list。前端选 Agent/目录时预开草稿取模型选项（防抖 + 同目标去重，失败不自动重试；发送时按需补开），第一条 prompt 才主动登记索引；丢弃草稿会关闭会话并设置隐藏标记。恢复回来的模型与创建时记录不一致会如实提示，不会默默声称一致。

`configOptions` 全部通过会话选项菜单呈现（模型之外的 select/boolean/未知类型），顶层 `modes` 会合成为一个选项并路由到 `session/set_mode`；`availableCommands` 提供 `/` 补全；`@` 触发项目文件模糊选择，`embeddedContext` 能力为真时文件内容随消息内嵌。

SQLite 当前有四张表：`agents`、`sessions`、`settings`、`dismissed_sessions`。sessions 保存 Agent、目录、Agent 会话 ID、标题、置顶、归档、配置选项和时间；不保存完整对话或轮次账本。`farfold.sqlite3` 是新元数据库，不迁移旧 Host 会话库。

正文、待审批、排队消息和产物在内存中；应用重启依赖 Agent 回放历史。协议事件原样进前端归一化，未知内容可保留为原始块，但不直接落入诊断日志。

Farfold 不声明文件读写与终端两类客户端能力：Agent 用自己的实现干活，Farfold 只转发审批与表单。产物窗格的差异卡与命令卡由 Agent 汇报的 `tool_call`/`tool_call_update` 内容推导（`type:"diff"` 块、execute 类调用输出，或 edit 类调用参数里带的 filePath/content），不再有 Farfold 侧的文件代跑或 PTY 代跑。空闲回收在有未答审批/表单或在途消息时豁免连接。

`work_policy.rs` 在现有 settings 保存版本化默认值及规范化路径覆盖值，一次迁移旧开关。策略更新和新工作准入使用同一项目锁；历史恢复、停止和已有审批不受工作关闭影响。前端 `work_policy.ts` 同步开始页、会话页和设置，保存失败不更新有效策略。

`session_types.ts` 明确区分 draft/established；恢复立即 established，首条消息接纳或结果不确定后固定模型。后端 session pump 串行处理配置与消息，拒绝已有会话模型修改及恢复覆盖。`permissions.ts` 按请求管理独立决定、撤销定时器与重试；后端校验所属会话及选项。

`queue.ts` 定义暂停和准入规则；会话协调在 `sessions.ts`。队列仅在后端确认接纳后移除；关闭、断线、失败、停止或结果不确定均保留队列并暂停。重开开关不自动发送；结果不确定的条目不能自动重试。重连用临时状态接收新历史，成功后替换，失败保留原内容；旧通道的迟到事件被忽略。

## 进程、诊断与更新

管理器执行连接、关闭与空闲回收；supervisor 维护 `pids.json`，用于遗留进程处理和退出清理。启动不再扫描或按前缀删除临时目录；安装器仅删除自己当前创建的明确暂存路径，遗留文件不做全局回收。

新协议日志只记录格式版本、时间、方向、受控事件类型、字节数和错误类别；普通应用日志也不保存自由文本。诊断导出重新验证字段，仅接纳新格式记录、少量类型校验后的设置及 Agent/会话统计；省略启动参数、环境值、完整握手、标题和项目路径。旧日志留在本机，但不导出。更新保留发布元数据与签名校验，默认配置未开放更新源；旧备份/导入恢复界面已不存在。

## LifeModel

只有三个默认关闭的 settings 键和 `context_blocks_for_prompt()` 空返回，前端为静态说明与示例。没有当前可用的 Proposal/Canonical 数据处理闭环，也不能把历史实验模块的能力归到当前版本。
