# Farfold 多 Runtime 候选普查与合同验证

> 2026-09-12 文档校正：本文件保留当时的研究、交接或验收记录。正文中的“当前”、Pi-only / Pi 唯一 Runtime、未采用适配器、未完成或下一步等描述仅对应原记录时点，不是当前执行指令。正式 0.1.7 已支持 Pi、OpenCode、Codex；OpenCode ACP 的 C 阶段已通过 Dev 工程出口，D Pi 仅部分实现、普通 ACP 工作台未接通，E 未开始。开发和自动续接已按用户要求暂停。最新状态以[唯一活动计划](../../plans/runtime-neutral-lifemodel.md)和[正式使用说明](../../INTERNAL-USE.md)为准；不得按旧报告重做已完成工作或清理当前用户数据。

日期：2026-08-30；D2 更新：2026-08-31
状态：研究报告，不是实施计划
范围：只研究官方 SDK、CLI、RPC、ACP、Server、Plugin、Extension 或 Hook；不修改、fork、patch 后端 Agent，不把 GUI 自动化当作 Runtime 承载面，不在 Farfold 中重写第二套 Agent loop。安装/认证可以经过厂商官方登录 UI。

## 1. 结论先行

多 Runtime 方向在技术上成立；“至少三个非 Pi Runtime 完成同一 D2”的**技术 Gate 已关闭**，但 Farfold 产品实施 Gate 仍未关闭。

- 共同的最小合同可以定义为：发现与版本、认证状态、能力协商、创建/恢复原生 Session、发送输入、流式事件、工具与审批、取消、完成信号、持久历史读取、错误与退出。
- [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) 已覆盖其中相当一部分：`initialize`、`session/new`、可选 `session/load`/`session/resume`、`session/prompt`、`session/update`、`session/request_permission` 和 `session/cancel`。它适合作为一类 Adapter 的底座，不是所有 Runtime 的总抽象，也不保证每个实现的持久化、认证、扩展和事件语义相同。
- 2026-08-30 获取的 [ACP Registry](https://agentclientprotocol.com/get-started/registry) 有 39 个条目；Registry 是候选发现与分发清单，不是兼容性认证。里面还混有官方 Runtime、社区 Adapter、包装器、服务型 Agent 和通用框架。
- 第一优先深验组应保持承载面多样性：Pi RPC、Hermes TUI Gateway、Codex App Server、OpenCode HTTP/SSE、Kimi Code 原生 ACP。只验证多个 ACP 包装器不足以证明 Farfold 的抽象有效。
- 本轮已经让本机 OpenCode 1.15.13、Codex App Server 0.143.0（固定 `gpt-5.4`）与 Kimi Code 0.39.1 ACP（配置用户授权的 GLM 5.3 Flash）完成隔离 D2。三个 Runtime 分别覆盖 HTTP/SSE、JSON-RPC App Server 与 ACP，达到 3/3。
- 三个已通过 Runtime 都证明 LifeModel 不必修改后端：OpenCode 可用 per-turn `system`，Codex 可用 `turn/start.additionalContext`，Kimi 可用 ACP embedded `resource`；三者也都能通过官方 history/read/load 面核对持久消息。
- 这关闭的是 Runtime/LifeModel seam 的技术校准，不是 D3 产品可用性。用户已于 2026-08-31 批准 Runtime-neutral 产品合同、D1 薄 seam 与 OpenCode 首个 Adapter 方向；当前已发布实现仍是 Pi-only，OpenCode 的第三方条款与固定版本复核是进入 D3 的独立门。

## 2. 研究问题与判定规则

### 2.1 Runtime 与 Framework 的边界

本报告中的“可承载 Runtime”必须满足：Farfold 通过一个官方外部边界启动或连接它，由它自己拥有 Agent loop、工具执行、权限语义、上下文管理和原生 Session。

以下情况不自动算 Runtime：

- 只有模型 API，要求 Farfold 自己编排工具循环；
- 只有 Agent building blocks，必须由 Farfold 组装一个新 Agent；
- 只有一次性文本输出，没有可靠的长会话、事件与取消；
- 只能嵌入对方 GUI；
- 必须修改、注入补丁或依赖未公开内部实现。

官方 SDK 只要封装并运行厂商已有 Agent loop，可以成为 Adapter 边界；通用 Agent SDK 若要求 Farfold 定义 loop，则只列入 Framework 研究池。

### 2.2 证据等级

| 等级 | 含义                                                           | 可以支持的结论                |
| ---- | -------------------------------------------------------------- | ----------------------------- |
| D0   | 官方文档或官方 Registry 声明                                   | 值得进入合同验证              |
| D1   | 固定版本的 schema、`--help`、握手或只读调用成功                | 该版本的进程/协议入口真实存在 |
| D2   | 隔离目录中完成双轮任务、流式、工具、审批、取消、恢复和历史核对 | 可以进入产品 Adapter 设计     |
| D3   | 同一构建在正式安装的 Farfold.app 中完成真实用户回路            | 可以主张产品可用              |

任何 D0 都不得写成 D2；浏览器、CLI 或测试夹具证据不得写成 D3。

### 2.3 合同硬门

每个候选在进入产品代码之前，都必须在固定版本上回答：

1. 如何发现可执行文件或服务，如何验证版本和来源？
2. 认证由谁拥有，Farfold 能否只显示状态而不接触凭据？
3. Session ID 的作用域是什么；能否 list/load/resume/fork/delete？
4. 输入是单次命令还是长驻双向协议？发送成功与 Agent 完成如何区分？
5. 哪些事件持久，哪些只是 delta；重连后如何补齐？
6. 工具调用、diff、计划、提问、权限请求如何呈现和响应？
7. cancel/abort 后的终态是什么；进程退出与 turn 失败如何区分？
8. 能否通过官方接口读取完整、稳定、可归因的历史？
9. 能否通过官方接口注入一小段用户确认过的 LifeModel 上下文，而不改 Runtime？
10. 多个 Farfold Session 或多个窗口并发时，Runtime 是否提供隔离或锁？

若 3、4、5、6、7 中任一项在实际 PoC 不成立，该候选不进入基础 Runtime 等级。若 8 不成立，只能使用 Runtime，不能向 LifeModel 贡献。若 9 不成立，只能使用 Runtime，不能消费 LifeModel。

## 3. 当前 Farfold 的事实基线

当前正式产品仍是 Pi-only，这一点必须和未来方向分开：

- `AGENTS.md:8-23` 与 `PRODUCT.md:1-34` 明确写着当前 Pi 是唯一 Runtime，Gate 0 不含 LifeModel/Proposal。
- `src-tauri/src/lib.rs:9-27` 只注册一个 `PiCapabilities` 和一个 `PiRuntime`，所有 Tauri 命令均为 `pi_*`。
- `src-tauri/src/pi_runtime.rs:19-63` 的生命周期只有一个进程槽；`84-149` 是封闭的 `PiCommand` 枚举。
- `src/runtime/pi.ts:218-328` 是直接调用 `pi_runtime_*` 的前端 facade，不存在 Runtime registry、adapter dispatcher 或 runtime-neutral session owner。
- `src-tauri/src/pi_runtime.rs:1055-1078` 启动固定 Pi sidecar 的 `--mode rpc`；当前安装版本为 0.84.3。
- `src-tauri/src/pi_runtime.rs:733-744` 的内存事件队列最多 512 条并丢弃最老事件；它适合 UI live feed，不可单独作为 LifeModel 的持久来源。
- 当前桥接只暴露 `get_messages`，没有暴露上游 Pi 的完整持久 entry 读取面。LifeModel 贡献能力不能建立在 UI 已消费的消息片段上。

2026-08-30 的交付身份核验：

- Git HEAD：`fbbefbf4015a9b0ccc087b011b31dde5eb9aacbd`；本地 `main` 比 `origin/main` ahead 1，且已有大量用户未提交修改。本研究未改动这些文件。
- `/Applications/Farfold.app`：bundle id `ai.farfold.desktop`，deep strict codesign 验证通过。
- 主可执行文件 SHA-256：`cd360b96e136778a32b925b5c6cfd7ea527b643dafa23746d669f0aa0a9a3b23`。

## 4. 共同合同不应等于“万能 runtime_id”

建议先研究下面的概念边界，而不是先把所有字段塞进一个 Runtime 表：

| 概念                  | 所有者            | 说明                                                                |
| --------------------- | ----------------- | ------------------------------------------------------------------- |
| `RuntimeKind`         | Farfold           | `pi`、`codex`、`hermes` 等产品类型；稳定、低基数                    |
| `RuntimeInstallation` | Farfold           | 用户机器上的一个可执行文件/服务实例、版本、来源、健康状态           |
| `RuntimeConnection`   | Adapter           | 一次进程或网络连接；可重建，不是用户历史身份                        |
| `NativeSessionRef`    | Runtime + Adapter | Runtime 原生 Session ID、工作目录和必要的 opaque locator            |
| `FarfoldSession`      | Farfold           | UI 中的会话容器，创建时绑定一个 `RuntimeKind` 与 `NativeSessionRef` |
| `CapabilitySnapshot`  | Adapter           | 该版本在握手时真实声明并经 PoC 验证的能力，不是静态愿望清单         |
| `SourceEnvelope`      | LifeModel ingest  | 指向原生持久记录的来源封装；与运行连接 ID 解耦                      |

`runtime_id` 只能用于标识一个明确层级。若同时拿它表示 Runtime 产品、安装实例、进程、用户账号和 Session，会导致重装、升级、并发和恢复时不可解释。

## 5. 深度候选矩阵

状态词：

- **A：优先深验**——官方边界足以覆盖基础合同的大部分；
- **B：次轮深验**——边界存在，但预览、包装层或关键能力仍需确认；
- **C：邻接/Framework**——可能有价值，但不应先按可切换 Runtime 实施；
- 所有 A/B 仍需 D2，当前没有自动通过。

| 候选                 | 官方承载面                                                                                                                                                                                 | Session / stream / permission / cancel                                                           | LifeModel 贡献与消费初判                                              | 状态与主要风险                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Pi 0.84.3            | 现有 RPC sidecar；Pi extension API                                                                                                                                                         | 当前产品已覆盖 prompt、steer、follow-up、abort、切换与 live events                               | 贡献必须补官方持久 entries；消费可研究 extension/context seam         | **A，基线**。已 D1；产品本身有 D3，但新的通用合同没有 D2                                                                     |
| Hermes               | [ACP、TUI Gateway JSON-RPC stdio/ws、HTTP+SSE](https://github.com/NousResearch/hermes-agent/blob/main/docs/features/programmatic-api.md)                                                   | TUI Gateway 文档列出 session/history、prompt、steer、follow_up、abort、工具/审批与 UI 方法       | `session.history` 有希望做来源；消费通道需固定版本 PoC                | **A**。协议最接近当前 Pi，但仍是不同语义                                                                                     |
| OpenAI Codex 0.143.0 | [Codex App Server](https://learn.chatgpt.com/docs/app-server) JSON-RPC/JSONL stdio 或 websocket                                                                                            | 双轮、delta、审批回调、interrupt、read/resume 已实测                                             | `thread/read` 达 C1；`additionalContext.application` 达 U1            | **A，D2（固定 `gpt-5.4`）**。默认 `gpt-5.6-sol` 与旧 CLI 不兼容；schema 含尚未实现方法；`thread/delete` 暴露本地 DB 迁移缺陷 |
| OpenCode CLI 1.15.13 | [本地 HTTP Server + OpenAPI](https://opencode.ai/docs/server/)                                                                                                                             | 双轮、SSE、权限拒绝/批准、abort、消息读取与重启恢复已实测                                        | Session messages 达 C1；per-turn `system` 达 U1                       | **A，D2**。本机另有 Desktop 1.17.9；测试使用 CLI arm64 固定 hash。Provider catalog 与实时可用模型必须分开判断                |
| Kimi Code CLI 0.39.1 | [官方 ACP](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp) JSON-RPC stdio                                                                                                    | 双轮、thought/message stream、权限拒绝/允许、cancel、load replay 与 delete 已实测                | `session/load` 达 C1；embedded `resource` 达 U1                       | **A，D2（GLM 5.3 Flash）**。Kimi managed Provider 持续 HTTP 500；外部 Provider 可用性必须与 Runtime 能力分开显示             |
| Kiro CLI             | [ACP JSON-RPC stdio](https://kiro.dev/docs/cli/acp/)；另有 [headless stream-json](https://kiro.dev/docs/cli/headless/)                                                                     | 官方列出 new/load/prompt/cancel、model/mode、text/tool/turn-end，另有 `_kiro.dev/*` 扩展         | load replay 可能作为来源；消费通道需验证 `/context` 或其他公开扩展    | **A/B**。ACP 清晰，但认证、版本分发和扩展稳定性需 D2                                                                         |
| Cline 3.0.60         | [CLI `--acp`](https://github.com/cline/cline/blob/main/docs/cli/cli-reference.mdx)                                                                                                         | 官方 CLI 有 ACP、JSON、resume ID、SQLite session、system override、hook 与权限配置               | 持久 Session 候选较好；消费可研究单次 system override，不得改共享配置 | **A/B**。CLI 文档显示默认自动批准，Farfold 必须显式安全配置并核验 ACP 默认                                                   |
| Cursor Agent         | [官方 ACP](https://cursor.com/docs/cli/acp)                                                                                                                                                | stdio JSON-RPC，公开 new/load/prompt/update/request_permission/cancel 与 auth                    | load/replay 可能贡献；消费通道未证明                                  | **B**。闭源、用户安装、认证和版本漂移风险较高                                                                                |
| Factory Droid        | [Headless / stream-jsonrpc](https://docs.factory.ai/cli/features/headless-mode)                                                                                                            | 长驻 stdin/stdout、继续/分叉 Session、结构化工具与权限限制                                       | 历史读取和上下文注入需 PoC                                            | **A/B**。闭源与账号依赖；不能把 append-system 当成跨版本保证                                                                 |
| GitHub Copilot SDK   | [SDK](https://github.com/github/copilot-sdk) + [streaming events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events)                                 | 持久/临时事件有明确区分；resume/list/delete、工具、权限、完成信号；无内建 Session lock           | 持久 event log 可贡献；systemMessage 可研究消费                       | **A/B**。当前 public preview；并发必须由 Farfold 串行化；认证与许可单独审查                                                  |
| Claude Agent SDK     | [官方 Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)                                                                                                                   | SDK 承载 Claude Code agent loop，支持 resume/fork、tools/hooks/subagents/MCP/permissions         | 消息流可研究为来源；system prompt/context 配置可研究消费              | **B**。不是通用模型 API；第三方产品认证与商业条款是硬 Gate                                                                   |
| Amp SDK / amp-acp    | [官方 SDK](https://ampcode.com/docs/sdk)；Registry 另有社区/包装 ACP                                                                                                                       | stream input/output、多轮、thread continuity、工具与可委托权限                                   | thread 信息可贡献；prompt/options 可研究消费                          | **B**。需区分 Amp 官方 SDK 与 Registry 中 `amp-acp` 包装器的信任边界                                                         |
| Mistral Vibe 2.24.1  | [官方仓库](https://github.com/mistralai/mistral-vibe) 的 `vibe-acp` 与 programmatic streaming JSON                                                                                         | ACP 入口存在；程序模式有工具限制、预算、JSON/NDJSON，但一次性模式不等于可恢复长驻会话            | 贡献/消费都需 ACP D2；一次性模式不足                                  | **B**。优先验证 ACP，不以 `--prompt` 代替交互合同                                                                            |
| goose 1.48.0         | [官方 ACP 指南](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/acp-clients.md)                                                                                    | `goose acp`；原生 session history；沿用 provider/model/extensions                                | ACP load/replay 可研究贡献；消费通道未证明                            | **B**。扩展/tool 行为可能随用户配置显著变化                                                                                  |
| Gemini CLI 0.57.0    | Registry 提供 `--acp`；[官方 headless](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md) 有 streaming JSON                                                       | headless 有 init/message/tool_use/tool_result/result；ACP 的恢复、审批需对 Registry 固定版本实测 | headless 历史不足；ACP replay/上下文能力待验                          | **B**。不能用旧 issue 推断当前 ACP 版本                                                                                      |
| Qwen Code 0.22.3     | Registry ACP；[headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)；[HTTP + SSE daemon](https://github.com/QwenLM/qwen-code/blob/main/docs/users/qwen-serve.md) | headless 可 resume，JSONL 持久；daemon 明确标为 Stage 1 experimental                             | 有来源与单次 append-system 候选；daemon 生产可靠性未满足              | **B**。ACP、headless、daemon 三条面不能混成一个已验证能力                                                                    |
| OpenHands            | [Software Agent SDK / REST Agent Server](https://docs.openhands.dev/sdk/index)                                                                                                             | Server 提供远程执行、隔离 workspace 和双向 WebSocket conversation                                | API/事件可能覆盖贡献与消费                                            | **C/B**。若连接完整 Agent Server，可当外部 Runtime；若 Farfold 组装 SDK agent loop，则属于 Framework，违背边界               |

### 5.1 还应进入次轮文档审计的候选

ACP Registry 的其余条目不应被忽略，但本轮只有 Registry 级证据，暂不写成熟结论：Agoragentic、Auggie、Autohand、CodeBuddy、Cortex Code、Corust、crow-cli、DeepAgents、Devin、DimCode、Dirac、fast-agent、GLM Agent、Google Antigravity、Grok Build、Harn、Junie、Kilo、Minion Code、Nova、Poolside、Qoder、siGit、Stakpak、VT Code。

它们进入深验前至少要完成：官方产品/仓库归属确认、许可证与再分发条件、macOS arm64 分发、认证所有权、原生 Session 行为和维护活跃度。

### 5.2 明确放在邻接池，不先按 Runtime 开发

| 项目类型             | 例子                                  | 原因                                                        |
| -------------------- | ------------------------------------- | ----------------------------------------------------------- |
| 通用 Agent Framework | LangGraph/LangChain、smolagents 等    | Farfold 需要定义/托管 Agent loop；这会变成第二套 Agent 平台 |
| 评测或 batch harness | mini-swe-agent 等                     | 一次性任务/benchmark 不是面向用户的持久 Runtime             |
| 纯 CLI 文本自动化    | 只有 `--json` 最终输出的工具          | 缺少双向审批、取消、恢复或可靠完成语义                      |
| IDE Extension UI     | 只能嵌入 VS Code/JetBrains 面板的产品 | 与“Farfold 自己拥有完整 UI/UX”冲突                          |
| 归档或维护状态不明   | 例如需要重新核验的 Roo 相关仓库       | 不应建立长期 Adapter 承诺                                   |

## 6. ACP Registry 全量快照

来源：[官方 Registry 页面](https://agentclientprotocol.com/get-started/registry) 与其公开的 [`registry.json`](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)。获取日期 2026-08-30；JSON SHA-256：`dd45b377a81b2db686c6148ddb87a98dae9573a79d7dcea2fceab580473be4da`。以下 39 项只是当日发现快照，版本会漂移。

| ID                 |       版本 | Registry 许可证字段/性质 |
| ------------------ | ---------: | ------------------------ |
| agoragentic-acp    |      1.3.0 | MIT                      |
| amp-acp            |      0.9.0 | Apache-2.0               |
| antigravity-acp    |      1.0.0 | proprietary              |
| auggie             |     0.36.0 | proprietary              |
| autohand           |      0.2.1 | Apache-2.0               |
| claude-acp         |     0.70.0 | proprietary wrapper      |
| cline              |     3.0.60 | Apache-2.0               |
| codebuddy-code     |    2.142.0 | Proprietary              |
| codex-acp          |      1.7.0 | Apache-2.0 adapter       |
| cortex-code        |     1.0.73 | proprietary              |
| corust-agent       |      0.6.0 | GPL-3-or-later           |
| crow-cli           |     0.1.24 | Apache-2.0               |
| cursor             | 2026.08.11 | proprietary              |
| deepagents         |      0.1.7 | MIT                      |
| devin              |   3000.6.7 | proprietary              |
| dimcode            |     0.3.22 | proprietary              |
| dirac              |      0.5.1 | Apache-2.0               |
| factory-droid      |    0.208.1 | proprietary              |
| fast-agent         |     0.10.1 | Apache-2.0               |
| gemini             |     0.57.0 | Apache-2.0               |
| github-copilot-cli |     1.0.82 | proprietary              |
| glm-acp-agent      |      1.7.0 | Apache-2.0               |
| goose              |     1.48.0 | Apache-2.0               |
| grok-build         |     1.0.13 | proprietary              |
| harn               |   0.10.122 | Apache-2.0               |
| junie              |   3032.2.0 | proprietary              |
| kilo               |      7.5.6 | MIT                      |
| kimi               |     1.49.0 | MIT                      |
| minion-code        |     0.1.44 | AGPL-3.0                 |
| mistral-vibe       |     2.24.1 | Apache-2.0               |
| nova               |     1.1.37 | proprietary              |
| opencode           |    1.18.25 | MIT                      |
| pi-acp             |     0.0.33 | MIT adapter              |
| poolside           |     1.0.16 | proprietary              |
| qoder              |     0.2.14 | proprietary              |
| qwen-code          |     0.22.3 | Apache-2.0               |
| sigit              |      1.5.2 | Apache-2.0               |
| stakpak            |     0.3.88 | Apache-2.0               |
| vtcode             |    0.96.14 | MIT                      |

注意：Registry 网页在抓取时显示的 CodeBuddy 版本与 JSON 快照存在一个 patch 级差异；本表以当次下载的 JSON 为准。这正是为什么 Farfold 不能把在线 Registry 的“latest”直接当成可复现依赖。

## 7. 本轮实际合同探测

### 7.1 Pi 0.84.3：D1 通过

使用正式安装包中的 sidecar，在临时 session 目录启动：

```text
pi --mode rpc --session-dir <temporary-directory> --no-approve
```

只发送 `get_state`，不调用模型、不写用户项目。收到成功 response，状态字段包括 `sessionId`、`sessionFile`、`messageCount`、`model`、`thinkingLevel`、`isStreaming`、`isCompacting`、`steeringMode`、`followUpMode`。临时目录未产生 Session 文件。

结论只到 D1：进程、RPC 与状态入口真实。它不证明通用 Adapter、双轮、审批、恢复和 LifeModel 读写。

### 7.2 Codex CLI 0.143.0：D2 通过，但暴露版本与清理风险

根据 [OpenAI Docs 的 App Server](https://learn.chatgpt.com/docs/app-server)，以 stdio 启动固定版本，只创建 `cwd=/tmp/farfold-codex-poc.../project` 的合成线程，不读取已有任务：

- 使用 `gpt-5.4` 完成两轮，持久 history 中依次得到 `farfoldProbeValue`、`farfoldProbeValue`；
- `turn/start.additionalContext["lifemodel.synthetic"]={kind:"application", value:"preferredLabel=VERDANT"}` 后，回复为 `VERDANT`；
- `thread/read(includeTurns=true)` 得到三轮六个持久 item；App Server 退出并重启后，`thread/resume` 成功，前后 item 摘要完全一致；
- 长输出 turn 被 `turn/interrupt` 终止为 `interrupted`；
- 宿主收到 `item/commandExecution/requestApproval`，拒绝路径返回 `DENIED`；另一次批准路径只在精确临时目录创建文件，随后删除；
- 事件面实测包括 `turn/started`、`item/started`、`item/agentMessage/delta`、`item/completed`、`turn/completed`、token usage 与 approval resolved。

同时发现三个必须写进 Adapter capability snapshot 的版本事实：

1. 默认模型被配置为 `gpt-5.6-sol`，服务端拒绝旧 CLI；显式固定该版本支持的 `gpt-5.4` 后才成功。宿主必须验证 Runtime 版本—模型兼容，不能只展示模型名。
2. 生成的 schema 含 `thread/items/list`，运行时却返回“not supported yet”。schema 声明不能代替方法级 PoC。
3. `thread/delete` 先移除 rollout，再因本地 state DB 缺少 `agent_jobs` 表失败，留下 stale index；这不否定 core D2，但产品接入前必须在新版 CLI 复验删除/迁移与失败原子性。

结论：双轮、流、审批、取消、恢复、持久历史、C1 与 U1 均有运行证据；固定模型与清理缺陷是产品 Gate，不得隐藏。

### 7.3 OpenCode CLI 1.15.13：D2 通过

用户提醒本机已有 OpenCode 后，确认 `/Applications/OpenCode.app` 为签名、notarized 的 Desktop 1.17.9，同时发现实际 CLI `/Users/tw/.opencode/bin/opencode` 为 1.15.13 arm64，SHA-256 为 `1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0`。D2 使用 CLI 与隔离的 XDG data/cache/state/config，不修改全局配置：

- `serve` 健康检查与 OpenAPI 成功，使用 `opencode/big-pickle` 完成真实双轮，回复依次为 `17` 与 `farfoldProbeValue`；
- Session message API 返回 user/assistant/user/assistant 四条持久消息；服务重启前后规范化摘要均为 `79f2bf98a78c3c87eec7fca9d9b36eb2a3923139332f910d1f934895d10157bc`；
- SSE 观察到 message delta、status、idle、error 与 tool event；异步 prompt 后调用 abort，得到 `MessageAbortedError` 与 idle 终态；
- 第一次 Read 权限由宿主拒绝，tool 进入 error；Agent 重试后宿主批准 once，Read 完成并回复 `FARFOLD_READ_OK`；
- per-turn `system` 携带 `preferredLabel=VERDANT`，回复为 `VERDANT`，因此达到 U1；持久 message API 与重启恢复达到 C1。

额外风险：prompt 内 `tools.read=true` 会覆盖 Session 的 ask 策略；Farfold 必须按该版本的实际优先级计算 UI，而不是假设 Session policy 总是最终权威。Server 若不是严格私有的 localhost 子进程，还必须设置官方认证。Provider catalog 中出现模型也不等于账号有额度或该模型实时可用。

### 7.4 Kimi Code CLI 0.39.1：D2 通过；托管模型路径未通过

旧报告的 Kimi CLI/Wire 已不是当前首选维护线。官方仓库说明 Kimi CLI 正在迁移到 Kimi Code；本轮固定官方 npm 包 `@moonshot-ai/kimi-code@0.39.1`，以临时 `KIMI_CODE_HOME` 启动 `kimi acp`。

真实 `initialize` 返回 ACP v1、`agentInfo=Kimi Code CLI 0.39.1`，并声明：

- `loadSession=true`；
- `sessionCapabilities` 含 list/resume/close/delete/fork/additionalDirectories；
- prompt 支持 image 与 `embeddedContext=true`；
- MCP HTTP/SSE；
- 唯一 auth method 为 terminal device-code `login`。

device-code 授权成功写入了隔离凭据，但 Kimi 托管服务在配置 provisioning 与真实模型请求中持续返回 HTTP 500；因此本轮**没有**证明 Kimi 自有托管模型路径可用。随后按 Kimi 官方 provider 配置面接入用户授权的 BigModel OpenAI-compatible GLM 5.3 Flash，不修改 Kimi 源码或 Agent loop，完成同一 D2 剧本：

- 双轮可见回复为 `farfoldProbeValue` 与 `17`，ACP 连续发出 `agent_thought_chunk`、`agent_message_chunk` 与 usage 更新；
- ACP embedded `resource` 携带 `preferredLabel=VERDANT`，可见回复为 `LABEL=VERDANT`，达到 U1；
- 进程重启后 `session/load` replay 7 个 user/agent message chunk，规范化摘要为 `01f7c042c7c4079cb51b982beed605316fb6afc63bf7d88ca4119e4b7e6b1e52`；继续追问时仍返回 `17`，达到 C1；回复同时带回前一轮 `LABEL=VERDANT`，说明 embedded context 会进入原生 Session 语境，不能假设它是临时且不可恢复的；
- `session/cancel` 的终态是 `cancelled`；
- Bash 临时写入触发 `session/request_permission`。选择 `reject_once` 后 tool failed、文件不存在且 Agent 回复 `DENIED`；选择 `allow_once` 后 tool completed、文件内容与回复均为 `FARFOLD_KIMI_WRITE_OK`；
- 四个探针 Session 均经 `session/close`、`session/delete` 删除，无清理错误。

结论：Kimi ACP + 外部 Provider 的 Base、C1、U1 均达到 D2；能力归属必须拆开显示为 `Runtime=Kimi Code`、`Provider=BigModel`。Kimi managed OAuth/provider 仍是单独的 `provider_unavailable` 风险，不能被这次外部 Provider 成功掩盖。

## 8. 下一轮隔离 PoC 规范

### 8.1 至少三个非 Pi，且协议必须多样

当前组合与状态：

1. Codex App Server：D2；
2. OpenCode HTTP/SSE：D2；
3. Kimi Code 原生 ACP：D2（GLM 5.3 Flash；Kimi 托管 Provider 另行标记不可用）；
4. Hermes TUI Gateway 保留为下一种非 ACP、Pi-like gateway 对照。

用户已授权安装/登录候选 Runtime。所有测试仍使用临时项目、隔离数据目录、合成内容、最小工具权限和固定版本；不复用真实工作 Session 或真实 LifeModel 数据。

### 8.2 一致测试剧本

每个 Runtime 执行同一个无副作用剧本：

1. 发现、版本、握手、能力快照；
2. 建立临时 Session，发送“记住代号 ALPHA-17”，等待明确 turn complete；
3. 第二轮询问代号，验证同一 Session 连续性；
4. 启动一个允许取消的等待型任务，发送 cancel，验证终态和可继续性；
5. 触发只读工具审批，拒绝一次、批准一次，核对 Runtime 自身语义；
6. 停进程、重启、resume/load，再询问代号；
7. 通过官方历史面读取完整持久记录，与 UI events 做差分；
8. 尝试一次明确、可见、可移除的 synthetic LifeModel context 输入；
9. 删除临时 Session，验证持久文件和 Runtime 列表行为；
10. 记录协议日志的 schema 与 hash，但不保存凭据、reasoning 私密内容或真实用户数据。

### 8.3 通过标准

- 0 个“stdin write 成功即视为 turn 完成”的误判；
- 0 个未响应的权限请求；
- cancel 在超时内到达可识别终态，随后 Session 可继续或明确不可继续；
- 重启后原生 Session 只能由原 Runtime 恢复，Farfold 不伪造上下文；
- 持久历史能区分 user、assistant、tool、approval、error 和 incomplete；
- Adapter 在未知事件上保留原始 envelope 并降级展示，不静默丢失；
- 合成 secret 不得进入日志、报告或 LifeModel proposal；
- 每个候选输出 capability snapshot 与不支持项，不通过“共同字段默认 true”补齐。

## 9. 研究 Gate 状态

| Gate                     | 当前状态            | 证据/缺口                                                    |
| ------------------------ | ------------------- | ------------------------------------------------------------ |
| 当前 Farfold/Pi 真相刷新 | 通过                | source、HEAD、安装包身份、Pi 版本已复核                      |
| 候选尽可能找全           | 部分通过            | ACP 39 项全量快照 + 17 项深表；非 ACP 长尾仍可持续补充       |
| 官方接口文档门           | 通过到 shortlist 级 | 主要候选有官方入口；产品条款与固定版本仍需逐项冻结           |
| 至少 3 个非 Pi D2        | **通过（3/3）**     | Codex App Server、OpenCode HTTP/SSE、Kimi Code ACP           |
| LifeModel 来源/消费合同  | **通过到 C1/U1**    | 三个非 Pi 均以官方持久历史和官方上下文入口通过合成验证       |
| 产品合同                 | **已批准**          | OpenCode 首选与 D1→D4 顺序已冻结；开始写产品代码仍需明确指令 |

## 10. 可审计来源

- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP Session setup and replay](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP Registry](https://agentclientprotocol.com/get-started/registry)
- [Pi coding agent repository](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- [Hermes programmatic API](https://github.com/NousResearch/hermes-agent/blob/main/docs/features/programmatic-api.md)
- [Codex App Server — OpenAI Docs](https://learn.chatgpt.com/docs/app-server)
- [OpenCode Server](https://opencode.ai/docs/server/)
- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)
- [Kimi Code ACP](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)
- [Kimi Code Provider configuration](https://moonshotai.github.io/kimi-code/en/configuration/providers)
- [智谱 BigModel API 文档](https://open.bigmodel.cn/docs/api)
- [Kiro ACP](https://kiro.dev/docs/cli/acp/)
- [Cline CLI](https://github.com/cline/cline/blob/main/docs/cli/cli-reference.mdx)
- [Cursor ACP](https://cursor.com/docs/cli/acp)
- [Factory headless mode](https://docs.factory.ai/cli/features/headless-mode)
- [GitHub Copilot SDK sessions](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Amp SDK](https://ampcode.com/docs/sdk)
- [Mistral Vibe](https://github.com/mistralai/mistral-vibe)
- [goose ACP](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/acp-clients.md)
- [Gemini CLI headless](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)
- [Qwen Code headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)
- [OpenHands Software Agent SDK](https://docs.openhands.dev/sdk/index)
