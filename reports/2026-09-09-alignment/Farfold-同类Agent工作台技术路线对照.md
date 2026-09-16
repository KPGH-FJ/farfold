# Farfold 同类 Agent 工作台技术路线对照

核查日期：2026-09-09。用于产品与架构对齐，不涉及商业计划书或产品代码改动。

## 判断

**建议 Farfold 优先考虑“自己的工作台 + 公共 ACP 客户端 + 外部 Agent / ACP 适配器”，有多个已落地项目可参考。当前应先把安装、连接、日常交互和恢复做好，再扩展 Agent 数量。用户正在比较路线，本建议尚未定案。**

本轮筛选核对 12 个相关产品，依据官方文档、项目 README，以及部分项目的实际接入源码。它们证明路线已有公开实现；本轮没有逐一安装验收，也不把开源、下载量或产品存在本身当成商业成功或稳定性证明。下表比较外部 Agent 接入，不把支持多个模型等同于支持多个独立 Agent。

## 三种主要做法

1. **统一 ACP**：工作台通过共同协议连接 Agent；Agent 原生支持 ACP 就直接接，否则经过适配器。
2. **混合接口**：工作台按 Agent 选择 ACP、SDK、App Server 或 RPC，再把结果呈现在自己的界面中。
3. **终端托管**：在工作台里运行 Agent 原来的终端程序，主要统一窗口、项目、任务和通知。

这些分类描述主要接入方式，不代表产品只能提供其中一种功能。特别是：Toad 虽然界面在终端里，但它自己通过 ACP 渲染交互；这与直接承载 Agent 原生终端界面不同。

| 产品                                                                           | 主要做法                         | 已核实的接入方式                                                                | 对 Farfold 的参考意义                                     |
| ------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [Zed](https://zed.dev/docs/ai/external-agents)                                 | 外部 Agent 统一 ACP              | 外部进程通过 ACP 接入；支持 Registry 安装和自定义启动命令                       | 公共客户端、能力差异、安装入口、协议日志                  |
| [JetBrains AI Assistant](https://www.jetbrains.com/help/ai-assistant/acp.html) | 外部 Agent 统一 ACP              | Registry 安装/更新；自定义 Agent；检测本机已装的兼容 Agent 后添加配置           | 本机发现和按需安装并存的完整使用流程                      |
| [Codeg](https://docs.codeg.app/reference/architecture)                         | 统一 ACP                         | 自己的工作台运行真实 Agent CLI，通过 ACP 通信，必要时使用适配器                 | 与 Farfold 接近的工作台和公共接入边界                     |
| [Kandev](https://github.com/kdlbs/kandev)                                      | 结构化交互统一 ACP，另有终端入口 | 原生 ACP 或 ACP 适配器；另外允许 CLI passthrough 运行原生终端交互               | 公共 ACP 传输与 Agent 集成配置的分工                      |
| [Aizen](https://github.com/vivy-company/aizen)                                 | ACP Agent 工作台                 | 官方说明支持 Claude、Codex、OpenCode、Gemini 等 ACP Agent；同时提供终端和浏览器 | macOS 工作台、项目环境、聊天与工具并列组织                |
| [Toad](https://github.com/batrachianai/toad)                                   | 统一 ACP                         | 自己实现终端交互界面，通过 ACP 连接不同 Agent；已有安装可跳过安装步骤           | 同一协议驱动统一交互，不依赖 Agent 自己的 UI              |
| [Harnss](https://github.com/OpenSource03/harnss)                               | 混合接口                         | Claude 用 Agent SDK；Codex 用 App Server；其他兼容 Agent 走 ACP                 | 共享工作台也可以容纳多个接入引擎                          |
| [Verde](https://github.com/JonathanRiche/verde)                                | 混合接口，另有终端入口           | Codex App Server、Claude Agent SDK、OpenCode Server、Pi RPC；Cursor 等走 ACP    | 原生接口路线的能力保留与维护责任                          |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban)                          | 公共执行器 + 多种适配            | 共同执行器接口，独立 Agent 实现，部分复用 ACP harness                           | 公共生命周期与专属适配；已宣布 sunsetting，作历史实现参考 |
| [Superset](https://github.com/superset-sh/superset)                            | 以 CLI / 终端工作流为主          | 在独立 Git worktree 中运行 CLI Agent，统一终端、审查和任务入口                  | 工作环境与进程管理；不是相同的统一聊天接入路线            |
| [cmux](https://github.com/manaflow-ai/cmux)                                    | 终端托管                         | Ghostty 终端运行各 Agent；通过终端通知和 hooks 等提供状态提示                   | 窗口、通知与终端体验                                      |
| [Claude Squad](https://github.com/smtg-ai/claude-squad)                        | 终端托管                         | tmux 会话运行 Agent，Git worktree 隔离任务                                      | 简单的多 Agent 进程与任务组织                             |

## Farfold 先借鉴什么

**以 Zed / JetBrains 的接入与安装方式为主参考，以 Codeg / Kandev 的公共工作台实现为代码参考，Aizen 作为 macOS 产品组织参考。**这是根据 Farfold 当前目标作出的选择，不是对这些产品整体优劣的排名。

目标链路：

> Farfold 自有工作台 → 公共 Host 管理与 ACP 客户端 → 原生 ACP Agent / ACP 适配器 → Agent 本体。

两种程序来源接入同一条链路：用户本机已有的兼容安装；用户在 Farfold 中选择后按需安装。主安装包不附带 Agent 本体，是本次已确认的 Farfold 目标，并非声称所有同行都采用相同打包方式。

先完成四件事：

1. **能开始**：发现本机程序、选择安装、识别版本与启动依赖、完成登录和连接。
2. **能工作**：消息、工具过程、权限与提问、停止等必要操作通过公共 ACP 路径运行；明确 Agent 能力差异。
3. **能回来**：保存安装/连接与原生 Session 的对应关系，重启后能够恢复；失败能定位到安装、启动、协议或 Agent 执行环节。
4. **能维护**：区分本机安装与 Farfold 管理安装，提供兼容版本与升级路径；更新后验证关键任务，避免静默覆盖用户环境。

先以 Pi、OpenCode、Codex 验证这条完整链路，再扩大支持名单。“采用 ACP”本身不等于这些 Agent 的必要功能已经迁移完成。现有 Farfold 代码与本次目标架构应分别记录。

## Provider 配置单独保留

统一 ACP 解决工作台如何与 Agent 通信；它不会自动把同一份 Provider 配置应用到所有 Agent。Zed 官方明确说明，外部 Agent 的模型、Provider 与认证通常仍由 Agent 自己管理，Zed 保存的模型密钥不会自动成为外部 Agent 的凭据。

因此，Farfold 的“兼容 Provider 配置一次、多 Agent 复用”仍是一项单独的目标。可以复用公共配置管理，但必须按 Agent 支持的原生配置方式应用，专属账号例外保留。不能把它算作切换到 ACP 后自然得到的功能。[依据](https://zed.dev/docs/ai/external-agents)

## 核查依据与边界

- Zed、JetBrains：本轮重新读取官方外部 Agent 文档；JetBrains 明确记载本机检测、Registry 安装和更新。不能据此推断它们会无提示地自动接管任意本机安装。
- Codeg：本轮重新读取官方架构说明；本对话此前已检查其公共连接上下文、ACP 注册与连接模块，确认仍有 Agent 专属配置与行为分支。
- Kandev：本轮读取 README 和源码 `apps/backend/internal/agentctl/server/adapter/transport/acp/adapter.go`，确认共同的 ACP 客户端连接；README 同时明确区分结构化 ACP 与 CLI passthrough。
- Harnss：官方 README 的引擎表明确列出 Agent SDK、App Server 与 ACP 三条路径。
- Vibe Kanban：本轮读取 README 与源码 `crates/executors/src/executors/acp/harness.rs`、`claude.rs`、`codex.rs` 等，确认公共执行器与独立实现并存；停止维护声明见 README。
- Aizen、Toad、Verde、Superset、cmux、Claude Squad：本轮核对官方项目说明/README；未把说明中的全部能力逐项作运行验收。
- ACP 官方客户端目录只用于发现候选项目，不将“被收录”本身作为全部功能走 ACP 或产品成熟度的证明：[客户端目录](https://agentclientprotocol.com/get-started/clients)。

这份对照是架构研究记录，不是新的实施计划；本轮不改应用代码、Runtime 安装或用户配置。
