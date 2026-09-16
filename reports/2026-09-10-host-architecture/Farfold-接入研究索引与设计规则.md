# Farfold 接入研究索引与设计规则补全

2026-09-10 · 历史设计研究，保留当时证据；不是当前执行指令。

2026-09-12 状态校正：OpenCode 独立 ACP adapter 已获批准并完成 C 阶段 Dev 工程出口；Pi 固定上游 adapter
有限维护也已获批准，交互、终态、身份及部分公共 Host 接入有定向验证，普通 Pi ACP 工作台尚未接通；E 未开始。
当前正式 0.1.7 支持 Pi、OpenCode、Codex，不能把早期 Pi-only 记录当作今日产品范围。用户已暂停开发和自动续接。
当前事实以[活动计划](../../plans/runtime-neutral-lifemodel.md)和[实施记录](Farfold-实施与验证记录.md)为准。
下文“本轮不采用”“尚未实测”均描述当时的上游候选或决策阶段，不代表后来的已维护适配器状态。

统一 ACP 链路保持不变。开发旧会话不迁移，只保留重要配置；新会话保存恢复必须正常。

## 找到的已有材料

- [早期 Agent 普查](../../research/2026-08-30/runtime-census-and-contract.md)：17 个深度候选及当时 Registry 快照；包含固定版本与 D0–D3 证据分层。历史产品状态已过时，不作为今日支持清单。

- [历史隔离验证](../../research/2026-08-31/d2-minimal-lifemodel-native-acceptance.md)：可追溯早期 OpenCode、Codex、Kimi 的隔离验证。仅借用原生基础接口证据，不恢复 LifeModel 研究或额外 Runtime 开发。

- [12 家工作台对照](../2026-09-09-alignment/Farfold-同类Agent工作台技术路线对照.md)：比较 Host 的 ACP、混合接口、终端三种路线；回答同行怎么做，不是各 Agent 的现行兼容证明。

- [公共职责清单](../2026-09-09-alignment/Farfold-公共架构职责覆盖清单.md)：ACP / Host / 前端边界；本报告扩充其正常和失败流程。

## 旧候选范围

Kimi、Kiro、Cline、Cursor、Mistral Vibe、goose、Gemini、Qwen 在旧报告中有 ACP 或 Registry 入口线索；Hermes、Factory Droid、Copilot SDK、Claude Agent SDK、Amp、OpenHands 则涉及不同官方接口或包装方式。旧报告另含 Pi、OpenCode、Codex。此处只恢复旧目录，不把所有名字标成今日 ACP 兼容，也不把它们加入下一轮开发范围。

## 当前三路的 ACP 补查

### OpenCode

[官方原生 ACP；可以选定程序路径以 ACP 模式启动](https://opencode.ai/docs/acp/)。文档支持工具、权限和原生配置；明确部分内置 undo/redo 命令不支持。本机程序复用有明确文档路径。固定 1.15.13 的 ACP service 源码存在取消不支持路径，是历史阻塞证据；当前选定的 1.18.30 源码已有 `session.abort` 支撑的 cancel 路径，permission 映射为 once / always / reject。1.18.30 初始化能力未声明 elicitation；Farfold 当前也未协商 `clientCapabilities.elicitation`。源码追踪确认 OpenCode 本体存在 `Question.Service`、plan 工具提问和 HTTP/TUI question 入口，但 ACP agent/service 只桥接 `requestPermission`，未导出 question/elicitation。因此通用结构化原生提问是当前固定 ACP 组合未保留的能力缺口，不等于断言 OpenCode 产品本体没有任何提问能力。旧 HTTP/SSE 验收不替代 ACP 验收。

#### OpenCode question 候选决策条目（2026-09-11）

实际核查范围：

- `npm view opencode-ai version` 返回 `1.18.30`；压缩核对 `versions` 尾部为 `1.18.15` 到 `1.18.30`，未出现高于
  `1.18.30` 的正式包版本。npm 中存在大量 `0.0.0-snapshot-*`，不作为正式固定 Agent 版本候选。
- ACP Registry `opencode/agent.json` 返回 `version: 1.18.30`，官方分发 archive 指向
  `https://github.com/anomalyco/opencode/releases/download/v1.18.30/...`，即 Registry 仍固定 1.18.30。
- `npm search --json opencode acp agentclientprotocol` 当前命中包含 `@agentclientprotocol/claude-agent-acp`、
  `@agentclientprotocol/codex-acp`、`@agentclientprotocol/sdk`、`@wrongstack/acp`、`opencode-acp`、`@tanstack/ai-acp`、
  `acp-probe`、`grix-connector`、`pi-acp` 等；其中 `opencode-acp` 的描述为 Active Context Pruning / OpenCode plugin，
  不是 Agent Client Protocol 的 OpenCode question adapter。本轮未找到可直接采用的成熟外部 OpenCode ACP question/elicitation adapter。
- GitHub tags REST API 在本机核查时返回 403，未作为版本结论来源；当前版本结论以 npm official 包与 ACP Registry 为准。
- 固定 1.18.30 源码核查：`packages/opencode/src/acp/service.ts` 与 `agent.ts` 初始化和 Agent 方法不声明 /
  不实现 elicitation 或 question；`permission.ts` 只桥接 `requestPermission`。同一源码中
  `packages/opencode/src/question/index.ts`、`tool/plan.ts`、`server/routes/instance/httpapi/groups/question.ts` 和 native app
  question dock 证明 OpenCode 本体有 question 服务与 HTTP/TUI 入口。

独立 ACP adapter 可行性：

在“不修改 OpenCode 本体、Host 仍只连接公共 ACP”的前提下，理论上可以自维护一个 OpenCode ACP adapter：由 adapter
作为唯一 Agent 侧进程，内部启动 / 连接 OpenCode 受支持接口，并把 OpenCode question HTTP/TUI 语义转换成 ACP
elicitation。这样 Host 不直接调用 OpenCode HTTP，不形成 Host 原生旁路；但 adapter 必须独占并记录同一 OpenCode native
Session，将 prompt、permission、question、cancel、resume、provider config 都绑定到同一 installation / runtime connection / native
session / generation。只要 question 通过另一条未绑定的 HTTP 会话或轮询通道进入，就不满足本阶段身份一致要求。

维护与复用：

- 需自维护：adapter 进程生命周期、OpenCode HTTP/server 启动参数、native session 映射、question list/reply/reject 到 ACP
  elicitation 的转换、pending question 与 pending permission 的同代次取消、错误/断线 unknown 规则、版本固定与安装摘要。
- 可复用：Host RuntimeBinding / installation / connection / native session 身份、Provider 投影和活动任务绑定、RuntimeEventRouter、
  InteractionRegistry、前端专属交互容器、turn admission/abort/recovery 合同。
- 最小验证：固定 1.18.30 + fixture Provider 下触发 `plan_exit` question；adapter 通过 ACP elicitation 上报；用户 accept/decline/cancel
  分别回到 OpenCode question reply/reject；同一任务中再触发 bash permission，确认 question 与 permission 不串会话、不串 generation；
  abort 同时取消 pending question/permission；冷启动 resume 后不会把旧 question 绑定到新 native session。之后才进入 installed app 和真实 Provider。

历史建议（已被后续批准独立 adapter 的决定取代，不再执行）：

本轮不采用自维护 adapter 作为 C3 默认路径。理由是当前官方 `opencode acp` 已满足 prompt / stream / permission / cancel
的固定程序证据，而 question 需要引入一层新的长期维护适配器和 OpenCode HTTP 语义桥接，风险超过 C3 的有限缺口补证范围。推荐当前 C3
记录为“官方 ACP 下 OpenCode question 未保留，需架构取舍”；若用户明确接受维护成本，再以独立 adapter 方案开一个受限设计 / spike，不把它混入现有 Host
原生旁路，也不降低既有 permission/cancel 能力。

C4 可并行与需等待范围：

- 可在 question 待定时推进：公共工作台只消费 Host 当前连接 / 操作 / 终态、Provider 投影和活动任务绑定、安装引用与失败清理、permission
  卡片状态、cancel/unknown/recovery、成果定位、旧入口删除前的 evidence gate。
- 必须等 question 架构取舍：OpenCode plan-to-build 这类原生 question 的 UI 承诺、ACP elicitation 表单能力、question 与 permission
  统一取消、冷启动后 pending question 恢复、是否引入自维护 adapter 及其版本/安装策略。

### Codex

[新维护位置 agentclientprotocol/codex-acp；适配器启动 App Server，允许指定 Codex 程序](https://github.com/agentclientprotocol/codex-acp)。默认 npm 包依赖一份 Codex；可以用 CODEX_PATH 指定现有程序。main 清单为适配器 1.11.0 / Codex ^0.153.4。当前 Farfold 固定 0.143.0；未证明兼容新适配器。选发布版与对应 Codex 组合，不能直接接 latest 后称为已验证。

### Pi

[Registry 为 svkozak/pi-acp，固定条目 pi-acp@0.0.33；启动本机 Pi RPC，可指定程序路径](https://github.com/agentclientprotocol/registry/blob/main/pi-acp/agent.json)。此包不嵌入 Pi SDK；README 要求已装 Pi 0.80.4+。extension select/confirm 有映射，input/editor 不支持并取消；模型选择调用 Pi RPC。已找到符合本机复用方向的候选；与固定 Pi 0.84.3 的完整行为仍未实测。无 ACP 文件/终端委托，传入 MCP 不接入 Pi；不得承诺原生交互完整保留；发布包还缺少原生 steer / follow_up 消息路径。

Pi 详细源码：[启动](https://github.com/svkozak/pi-acp/blob/main/src/pi-rpc/process.ts#L118)、[交互与取消](https://github.com/svkozak/pi-acp/blob/main/src/acp/session.ts)、[限制](https://github.com/svkozak/pi-acp/blob/main/README.md)。Registry 包安装不包含安装 Pi 本体，已核验发布包 integrity 及六个关键文件；运行行为尚未实测。详见本报告三路能力与状态补充。

## 正常与失败规则

| 流程                | 正常路径                                                                                                                 | 失败 / 冲突                                                                                            | 状态                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 01 · 安装来源       | Host 先列出已知位置和用户选定路径的安装；显示版本和来源；缺失时提供按需安装。复用程序和复用账号分别记录。                | 找不到则允许指定路径；多版本保留明确选择；不扫描读取任意账号数据。只启动选定的入口。                   | 已对齐：本机优先 + 按需安装，主包不带 Agent。       |
| 02 · 固定接入组合   | 每个安装引用明确的 Agent、适配器与依赖版本；握手确认协议和能力。                                                         | 未知版本显示未验证；明确缺少必要接口则阻止开始并说明升级 / 更换选定版本路径；不偷偷走原生旁路。        | 待事实核查：三路的确切支持组合。                    |
| 03 · 启动与清理     | Host 持有自己启动的进程，设置项目、配置目录和生命周期；ACP 成功握手后进入可工作状态。                                    | 启动超时先确认并清理本次拥有的失败进程；保留诊断。不能按程序名杀其他工具启动的进程。                   | 建议规则；未进入实现。                              |
| 04 · 添加共享连接   | 一次保存端点、协议、地区 / 套餐、凭据引用与模型映射；逐 Agent 生成受管理配置。                                           | 保存、应用、需要重启、请求验证分别显示；任一路失败不显示全部成功，失败路不影响其他已生效路。           | 已对齐体验；具体配置接口按接入包确定。              |
| 05 · 配置归属       | Farfold 管理自己的共享连接与投影；既有原生账号可作为独立连接保留。导入已有连接须说明范围，之后一个字段只有一个写入来源。 | 检测到用户外部修改受管理字段时暂停覆盖，显示两份差异供选择；未管理字段保留，不双向无限同步。           | 建议默认；是否同步外部全局配置未获决定，默认不做。  |
| 06 · 选择与生效     | 全局默认只影响新任务；会话选定的连接与模型保留。任务开始绑定生效配置版本。                                               | 任务中改设置进入待应用，不能悄悄更换当前模型或账号。原生进程配置无法隔离时，分连接运行或禁用并行切换。 | 作用域需按 Agent 核实；用户无需重复输入密钥。       |
| 07 · 模型目录       | 品牌层归组，服务地区 / 套餐和账号连接分开；真实模型 ID、接口和能力作为底层记录。                                         | 同名不自动删；只归并有等价依据的条目。无映射时显示来源；禁止把国际站 key 自动投到另一端点。            | 建议规则；用户报告的 GLM 重复尚未运行复现。         |
| 08 · 凭据维护       | 轮换共享连接凭据后逐目标应用；保留每一路的生效版本；原生登录按原生生命周期维护。                                         | 失效、限额、网络故障分开显示。日志、导出和错误不带密钥；移除连接不等于注销供应商账号。                 | 实施时列精确配置保留与删除清单。                    |
| 09 · 创建与发送     | 选项目 / 工作副本、Agent 安装和连接，创建原生会话并保存身份后发送。共用准入限制和同工作副本互斥。                        | 创建失败保留草稿；发送后断线且接受情况未知时不自动重发。先检查原生状态，避免同任务重复修改文件。       | 沿用当前最多两条活动任务的约束；未提出扩大并发。    |
| 10 · 运行状态       | 统一显示：启动中、就绪、执行中、等待用户、取消中、已结束、失败或状态待确认；保留原生原因。                               | 未知不是失败也不是已完成；新一代连接不能接受旧一代响应改变当前任务状态。                               | 用户用语为设计稿，不新增第二个 Agent 决策循环。     |
| 11 · 权限与提问     | Agent 发起，Host 绑定到会话 / 任务 / 请求，前端显示原生选项，经 ACP 回答。                                               | 取消、退出或请求失效后旧按钮失效；不自动批准、不用普通聊天冒充原生提问。原生不提供的能力如实缺省。     | 必要能力由现有已接受行为表决定。                    |
| 12 · 取消与中断     | 用户停止后显示取消中，直到原生终态或可核实退出；记录已发生的文件变化。                                                   | 超时显示状态待确认，可提供结束自有进程的明确操作；取消不等于撤销磁盘修改。                             | 建议规则；不同 Agent 的完成信号需对应。             |
| 13 · 事件与恢复     | 公共通道保留顺序、来源与连接代次；有界输出，断线后用真实快照和原生记录恢复显示。                                         | 发现缺口就标明并补读支持内容；不编造遗漏工具输出，不把持久化失败报成保存成功。                         | 保留现有事件可靠性基础；替换原生解析。              |
| 14 · 产物审阅       | 工具卡片展示 Agent 上报，文件面板展示真实工作区差异并注明比较基线；只读预览与已审阅分开。                                | 非 Git、未跟踪、大文件、二进制、冲突与外部编辑分别处理；未知归因不标成全部由 Agent 修改。              | 建议首轮只读预览 / diff；编辑、提交、撤销另行决定。 |
| 15 · 本机回调       | 按协商能力承接 ACP 文件与终端请求；校验路径和拥有关系，结束时释放自己创建的资源。                                        | 不支持则不宣告支持；输出截断保留提示；不能把 Host 观察或回调冒充对原生工具的完整沙箱。                 | 依据所选适配器实际请求决定必做回调。                |
| 16 · 新会话续接     | 新架构产生的会话保存安装、项目、连接与原生会话引用；重启后重新发现并续接。                                               | 认证过期先恢复连接；版本或目录变化先解释原因。打不开不悄悄新建空白会话。                               | 必须保留日常恢复能力；不要求迁移旧开发记录。        |
| 17 · 窗口与退出     | 建议应用内 Host；关闭窗口保留应用时可继续，完整退出先处理正在执行任务。                                                  | 强退 / 崩溃 / 休眠后按未知状态恢复；不承诺完整退出后后台继续，不因此引入另一套控制中心。               | 关闭窗口是否默认后台继续仍为产品选择。              |
| 18 · 更新与安装失败 | 安装内容先暂存校验，再启用选定版本；Agent / 适配器更新与主应用更新分别管理。                                             | 失败保留当前可用安装，升级不影响活动进程；用户自行升级后重新校验。应用更新保护重要配置与新产生的数据。 | 不自动升级用户全局程序；更新建议不是本轮执行。      |
| 19 · 开发旧数据     | 本次切换不迁移开发旧会话；先列重要 Provider、端点、模型和必要设置，保留后验证可读取与可用性。                            | 删除范围限制在明确的 Farfold 开发记录；不连带删除项目文件、独立原生历史或其他工具配置。                | 已对齐方向；本轮没有执行清理。                      |

## 未来验证要求

一次录入后逐路确认实际连接与模型；断线不重发任务；权限请求不串会话；取消结果可确认；差异有基线与来源；安装应用冷启动恢复新会话；升级和清理保住配置。本轮没有运行这些验收。
