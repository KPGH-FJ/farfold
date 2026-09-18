# Farfold 产品契约

本文件是 Farfold 唯一的产品契约：页面、术语、旅程与出口标准以此为准。
实现细节与切片进度见 `plans/runtime-neutral-lifemodel.md` 第 00 章。
任何与本契约冲突的代码、文案或计划，以本契约为准修改它们。

## 1. 这是什么

Farfold 是一个独立的多 Agent 桌面应用（macOS）。用户把自己已安装或经 Farfold 安装的
AI 编程 Agent（OpenCode、Codex、Pi 等）接入到一个统一的桌面工作台里：一个会话流、
一套对话界面、跨 Agent 的“需要你 / 在跑”总览、审批与产物（diff/终端输出）查看。

- 目标用户：日常使用 CLI 编程 Agent、同时跑多个任务/多个 Agent 的开发者。
- 价值主张：接入你已有的 Agent 和订阅后，在这里统一调度它们，不损失各 Agent 的能力。
- Farfold 不是编辑器，不是 Agent 本身，不实现 Agent loop，不模仿某个 Agent 自己的 UI。

## 2. 范围

本阶段（阶段 6）做：OpenCode、Codex、Pi 三个 Agent；会话与并行任务；审批与产物；
Settings（Agent 接入 / LifeModel / 通用）。平台仅 macOS arm64。

本阶段不做：编辑器功能；Windows/Linux；LifeModel 的真实采集与注入（只留接口与静态页面）；
多窗口；移动端。

## 3. 五条核心用户旅程（出口标准）

每一片开发的验收都以“安装版 `/Applications/Farfold.app` 上真人走通以下旅程并留截图”为准。
单测、mock、合成 fixture 只是前置条件，不是出口。

- **J1 接入**：全新安装启动 → Settings/空态看到本机已装的 Agent 被自动发现（含版本号）→
  点击连接 → 状态变为“已连接”。若 Agent 未装，可经 Agent 目录一键安装。
- **J2 首条消息**：空态输入一条消息 → 自动创建会话并绑定 Agent+模型 → 看到流式回复与步骤流。
- **J3 审批与产物**：Agent 请求执行命令或写文件 → 审批卡批准（含“批准并记住”）→
  步骤流看到命令输出/文件变更，可点开产物窗格看 diff/终端。
- **J4 并行**：A Agent 会话在跑时切到 B Agent 会话发送新任务 → 侧栏正确显示“在跑/需要你” →
  返回 A 会话，任务仍在继续，历史完好。
- **J5 续接**：退出并重启 Farfold → 会话列表完整 → 打开会话可继续发送（历史经 `session/load`
  回放；Agent 不支持则如实显示“该 Agent 不保留历史”）→ `pgrep` 无残留 Agent 进程。
- **J6 登录**：Codex 已在终端登录则免登录可用；未登录则经 Agent 自带登录流程（浏览器/内嵌终端）
  完成后可用。

## 4. 页面清单（唯一 UI，规格为 `.design/2026-09-16-redesign/F-prototype.html`）

1. **侧栏**：`新对话` `⌘N`、`需要处理`、`已归档`、搜索 `⌘K`、`最近`（按项目分组）、`项目`、底部 `设置`。
2. **顶栏**：会话标题 + 一个“Agent · 模型”切换器（新会话可选，创建后不可改）。
3. **主区**：Transcript（用户消息 / Agent 文本 / 步骤流：read·edit·bash 等，含耗时与
   diff 摘要 / 审批卡：批准、批准并记住、拒绝 / 沉降行 + 5 秒撤销 / 本轮产物行）+
   Composer（多行文本；图片粘贴按 Agent 能力显隐；`@` 文件引用；运行中发送=排队；
   运行中按钮=停止）。
4. **产物窗格**：diff / 终端输出 / 日志；链接唤起、×关闭、可拖宽。
5. **状态栏**：选中 Agent 事件流 · 需要你数 · token 用量 · 版本。
6. **Settings**：`Agent 接入`（每个 Agent 一张卡：名称/简介/状态；未接入→`连接 X`；
   已接入→版本、断开、`在此项目上工作`/`贡献 LifeModel`/`使用 LifeModel` 三开关）、
   `LifeModel`（总开关、Proposal 队列、Canonical、注入预览；本阶段静态）、`通用`
   （外观、自动归档、更新、诊断导出、版本）。
7. **空态/开始页**：未接入 Agent → 引导去 Settings 连接；已接入 → “今天想推进什么？”+
   可直接输入的 Composer（发消息即建会话）。

差异只能来自 Agent 通过 ACP 声明的能力（`agentCapabilities`、`configOptions`、
`authMethods`），不得按 Agent 写死 UI 分支。

## 5. 术语表（UI 用词 ↔ 工程词）

| UI 用词       | 对应工程概念                                    |
| ------------- | ----------------------------------------------- |
| Agent         | runtime / agent server                          |
| 会话          | session / thread                                |
| 项目          | 工作目录（cwd）                                 |
| 模型          | configOptions 中的 model                        |
| 需要你        | attention required（审批/结果未知）             |
| 在跑          | turn running                                    |
| 已完成        | settled（收到 stopReason）                      |
| 结果未知      | unknown outcome                                 |
| 停止          | cancel（请求中）；“已停止”仅在 Agent 确认后显示 |
| 接入 / 已连接 | 安装 + initialize 握手成功                      |
| 登录          | authMethods（agent / terminal 两种）            |
| 产物          | 文件改动 diff、终端输出、日志                   |

**UI 禁用词**（不得出现在任何用户可见字符串）：Runtime、Host、ACP、原生、绑定、代次、
投影、占用、Working Copy、Session、Turn、构建、引用、对账、沉降、上游、sidecar、
adapter、JSON、握手、 envelope。内部标识符可用工程词，注释与日志可用 ACP 术语。

## 6. 文案原则

- 说用户能听懂的话：发生了什么、需要你做什么、结果如何。不暴露内部状态机。
- 诚实但简洁：不确定就说“结果未知”；Agent 不支持的能力显示“该 Agent 不支持”，不隐藏、
  不编造、不给“暂不支持”的防御性长句。
- 一句一事；按钮用动词（连接、发送、停止、批准、拒绝、重命名、归档、删除、重试）。
- 默认中文界面；新字符串集中管理，便于日后 i18n。

## 7. 能力呈现原则

- “已连接”仅表示 initialize 握手成功；“可用”还需要登录状态与模型就绪。
- 审批中的会话必须出现在“需要你”，直到用户处理或 Agent 终止该轮。
- 停止按钮发出 cancel；“停止中…”直到收到 stopReason 才变“已停止”；失败显示重试。
- 未知结果永不当作成功显示；重启后无法恢复的会话显示“无法恢复”，不显示为空会话。

## 8. 架构边界（开发者约束）

- Agent = `{id, command, args, env}`。合法性 = ACP `initialize` 成功。不校验二进制 SHA、
  不 pin 版本（registry 条目自带的归档 sha256 校验除外）。
- Agent 拥有自己的 HOME、凭据、配置、模型目录、会话历史。Farfold 不 env_clear、不私有 HOME、
  不替 Agent 写配置文件。
- Farfold 存储仅限：会话索引与用户元数据、Settings、LifeModel 数据、安装缓存。
  不建 Turn/事件账本。
- 使用官方 SDK（Rust `agent-client-protocol`）与官方/上游适配器；不 fork Agent。
- 只执行 registry 条目或用户显式配置的命令；不从项目目录读取 Agent 启动配置。

## 9. 演进

阶段 6 之后（不在本契约承诺内）：LifeModel 采集与注入、更多 Agent（registry 已支持通用
接入）、远程/SSH 项目、更新与遥测策略细化。LifeModel 总开关与注入点已预留接口。
