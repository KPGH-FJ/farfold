# Farfold 历史计划与交付记录（截至 2026-09-11 整理前）

只保存历史证据，不作为实施授权或当前状态。旧记录中的“当前”“下一步”均指记录当时。
唯一活动计划：[当前开发计划](../runtime-neutral-lifemodel.md)。不要求执行任务每轮通读。

## 0. 2026-09-10 下一阶段开发顺序（历史实施记录）

以下 S0–S5 是 2026-09-10 前后的历史实施顺序与证据记录，不与 0A 草案竞争。当前工作应以 0A 为准；
旧段落中的版本、schema 或已授权表述如与 0A 冲突，按 0A 的当前审阅状态解释。

目标：在不修改 Agent 本体、不新增 Agent 循环、不用原生旁路掩盖 ACP 缺口的前提下，将 Pi、
OpenCode、Codex 三路已经接受的基础能力收敛到同一工作台、公共 Host、公共 ACP、安装管理和
Provider 投影框架。现有 0.1.7 交付事实保留；新阶段不迁移旧开发会话，但必须保护重要 Provider
配置，新产生会话必须可靠恢复。

### S0 — 规格、遗漏审查与能力基线

边界：同步 AGENTS、PRODUCT、唯一计划和规格；把十项关键遗漏落到能力矩阵、阶段和验收，不新增
机器可读治理系统。独立复核 Pi ACP 候选、OpenCode 固定版本取消路径、Codex ACP SDK / 适配器 /
Agent 组合；报告线索只作为入口，不能直接当实施结论。

验证：规格与计划互不竞争；前端能力合同不能把握手、源码字段或安装摘要显示成原生能力已保留。

删除：只删除被同切片验证替代的显示或控制路径；不清理用户数据、项目、认证或外部 Runtime 配置。

### S1 — 公共 Host 身份和能力合同

边界：统一 Runtime / 安装 / 连接 / 原生会话 / 任务 / 请求身份；继续保留两条活动任务和同 Working Copy
排他。能力按安装、正常任务、插话、停止、权限 / 提问、Provider、恢复、成果审阅等维度表达，
并区分已验收、部分可用、适配缺口、官方受限、未知和暂不支持。

验证：行为测试覆盖错误身份、旧 generation、迟到事件、重复回复、结果未知、配置版本绑定和恢复失败。
安装应用只在完成相应工作流后记录，不由静态能力标签替代。

删除：移除长期并存的旧状态源和固定认证式文案；保留必要历史交付证据。

### S2 — 本机优先安装与统一连接投影

边界：主应用不携带新增 Agent 本体；Pi / OpenCode 现有 0.1.7 随包事实保留为过渡状态，
S2 目标终态是三路均本机优先、按需发现 / 下载 / 校验 / 连接，主应用包不再携带 Agent 本体。
Codex 继续复用用户选定官方 0.143.0。新增 ACP 路径时，每个连接记录程序、适配器、依赖、
配置目录、摘要和验证结果。Provider 一次录入后仅写 Farfold 管理字段，逐 Agent 投影并记录
连接实例、配置版本、保存、应用、请求验证与部分失败。

验证：外部移动 / 升级程序、缺失依赖、配置目录不可写、凭据失败、模型映射冲突和活动任务隔离均有出口。
Pi / OpenCode 后续移出主包时，必须核对已有会话和 Provider 配置仍可恢复、缺失安装能按需获取并校验
版本 / 摘要 / 依赖、安装包内无 Agent 本体、同一候选应用中三路真实任务和恢复通过。

删除：替代原有重复 Provider 表单或安装检测入口后，删除旧入口；不得删除外部全局配置或认证。

### S3 — 一路完整 ACP 用户流程

边界：按能力覆盖和风险选择第一路，不预设原生 ACP 一定优于现有路径。首路必须覆盖新建、发送、流式、
权限 / 提问、停止、恢复、Provider 应用、成果定位和失败恢复；保持工作台—Host—公共 ACP—原生 ACP
或适配器—Agent 链路。

验证：同一安装候选完成原生对照、真实模型任务、停止 / 交互、断线不重发、三次冷启动、配置隔离、
成果审阅和配对恢复。若该路的 ACP 候选会丢失已接受原生能力，先记录缺口与维护成本，再决定是否推进。

删除：该路通过后删除对应旧控制路径，不能长期保留 ACP 和原生双控制权。

### S4 — 其余两路复用公共机制

边界：复用 S1–S3 的 Host、连接、状态和交互容器；专属能力留在适配器。Pi 不丢 steer / follow_up /
Extension UI；OpenCode 必须闭合取消；Codex 冻结 ACP SDK、适配器和 Agent 组合并保留已接受冷历史限制。

验证：三路同构建安装应用验收，含并发、同目录拒绝、未知结果恢复、20 次冷恢复性能采样和正式 / QA
身份隔离。用户验收与 Agent 工程证据分开。

删除：每路通过即删除被替代的控制路径、状态源和入口文案；清理前列清单并保护用户数据与凭据。

### S5 — 交付恢复与收尾

边界：只交付内部 macOS 版本；公共更新、远程 Host、账号池、第四 Runtime 和 LifeModel 深度能力仍延后。

验证：应用 / 数据配对备份、实际恢复、SQLite quick_check、原生历史和认证摘要保护、包内无凭据、安装
摘要和严格签名。保留未归因启动超时等观察，不用后续成功重试覆盖失败样本。

删除：仅删除已替代 QA 暂存和无依赖恢复副本；当前日用应用、最新 QA / Dev 证据、外部 CLI、项目和认证保留。

### 当前工作包与退出条件

| 工作包                               | 负责流程                                                      | 主要模块                                                                                      | 依赖                                 | 退出条件                                                                                        | 旧路径删除时点                                                  |
| ------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| WP-A Provider 版本与任务保障         | 设置保存、目标应用、任务按启动配置执行                        | `host_store/provider_projection`、`turn_coordinator`、OpenCode / Pi 提交 API、Provider 设置页 | schema 10、现有 Runtime 原生配置入口 | 旧回执拒绝、错误目标 / 模型绑定拒绝、归属变更失效；至少一路 UI→Host→原生配置→任务绑定闭合       | 对应 Runtime 的旧重复 Provider 入口被同流程替代并安装验收后删除 |
| WP-B OpenCode 首路完整 Provider 流程 | API key 保存、重连、模型选择、发送任务、失败恢复              | `OpenCodeProviderSettings`、`OpenCodeWorkspace`、`opencode_protocol`、Host projection         | WP-A、可启动 OpenCode、可用测试模型  | 同一候选应用中保存配置后任务提交带已应用版本；请求验证和失败状态分开记录                        | OpenCode 旧 Provider 文案 / 状态源通过后删除                    |
| WP-C 首路 ACP 候选冻结               | 选择 Pi / OpenCode / Codex 中风险最低且不损失已接受能力的一路 | 公共 ACP client、目标 Runtime Adapter、能力矩阵                                               | 官方固定版本源码与本机分发核验       | 新建、流式、交互、停止、恢复、Provider 和成果定位真实通过；不能用旁路补 cancel/interaction 缺口 | 首路 ACP 通过后删除该路被替代控制路径                           |
| WP-D 本机优先安装管理                | 发现本机 Agent、按需安装、摘要校验、移动 / 升级恢复           | 安装管理 Host、Runtime registry、更新 / 恢复                                                  | 固定下载源、sha256、依赖探测         | 主包无 Agent 本体仍能首次启动；Pi/OpenCode/Codex 均可定位、校验、恢复                           | 随包 Pi/OpenCode 资源在替代安装流程通过后移除                   |
| WP-E 工作成果审阅                    | 文件任务、diff、未跟踪/二进制/冲突、结果未知                  | Working Copy、文件引用、消息投影、工作台审阅 UI                                               | Host 任务身份、文件引用校验          | 真实任务后能定位产物并区分 Agent 上报、磁盘变化和外部编辑                                       | 旧结果链接或不可审阅展示被新审阅闭环替代后删除                  |
| WP-F 三路同候选应用验收              | 三路新建/任务/交互/停止/恢复/Provider/审阅/恢复包             | 全工作台、Host、Adapter、安装、Provider                                                       | WP-A–E                               | 同一安装候选通过三路真实流程、冷启动、并发、正式/QA 隔离和配对恢复                              | 清理已替代 QA 暂存；保留日用应用、凭据、项目和证据              |

### 2026-09-10 S0 执行记录：规格、计划和能力合同

- 新增
  `reports/2026-09-10-host-architecture/Farfold-下一阶段规格.md`，将五块工作落到产品目标、
  分层职责、能力保留矩阵、正常流程、失败行为和验收。该文件不是活动计划。
- 本文顶部新增 S0–S5 顺序，保持本文件为唯一活动计划；2026-09-09 的 0.1.7 交付证据继续作为
  历史事实保留，不改写为当前未完成状态。
- 独立复核三路关键风险：OpenCode 固定 v1.15.13 的 ACP `cancel` 仍返回
  `UnsupportedOperationError({ method: "session/cancel" })`；Pi ACP 当前运行中 prompt 进入队列，
  不是 Farfold 已接受的 Pi 原生 steer / follow-up 等价路径；Codex ACP main 的 package 版本为
  1.11.0，依赖 `@openai/codex` `^0.153.4`，与当前 Farfold 固定 0.143.0 组合不等同。
  Codex 用户提问 handler 仍依赖客户端表单能力，不支持时返回空 answers。以上是源码复核，
  不是安装应用验收。
- 前端新增能力保留合同：按安装、正常任务、插话、停止、权限 / 提问、Provider、恢复和成果审阅
  表达 Pi / OpenCode / Codex 状态，状态值区分已验收、部分可用、版本阻断和待核验。Runtime 状态区
  只展示前三项摘要，避免把握手或安装摘要冒充完整原生能力保留。
- 当前验证：前端 46 文件 / 207 项通过，typecheck 通过，前端 build 通过；本轮触碰文件的
  Prettier 检查和 `git diff --check` 通过。全仓已有大量未提交改动，本轮未清理、重置或替换正式应用。

### 2026-09-10 S1 公共 Host 能力保留快照切片

- 将 S0 的前端能力保留合同下沉到 Host：`runtime_capability_snapshot` 现在随 Pi / OpenCode
  managed Runtime 快照返回安装、正常任务、插话、停止、权限 / 提问、Provider、恢复和成果审阅八项
  `retentionCapabilities`。状态值区分已验收、适配缺口、版本阻断、部分可用、待核验和暂不支持。
- `runtime_discover` / `opencode_runtime_discover` 的 descriptor 也复用同一份 Host 数据，避免
  discovery 入口继续只暴露 Base / LifeModel 三项旧模型。Codex 属于动态登记安装，当前不通过
  managed Runtime snapshot 伪造 Host 快照；前端仅保留 Codex 已接受 App Server 范围的兜底展示。
- 关键边界：Pi 原生 steer / follow-up 仍标为已验收，但 ACP input/editor 候选明确是适配缺口；
  OpenCode 正常 Server 任务已验收，但固定 v1.15.13 ACP cancel 是版本阻断；Codex 新 ACP 组合未冻结，
  不由 0.143.0 App Server QA 证据自动通过。
- 验证：Rust 库测试 283 项通过、3 ignored；前端 46 文件 / 208 项通过；typecheck、前端 build、
  `cargo fmt --check`、all-targets clippy `-D warnings` 和本轮文件 `git diff --check` 通过。
  前端 build 仍有既有大 chunk 提示。本切片没有安装或替换应用，没有消耗模型请求，也没有改 Runtime 本体。

### 2026-09-10 S2 共享 Provider 投影合同切片

- 新增 `src/runtime/provider-projection.ts`，建立一次 Provider 连接向多个 Runtime 投影时的前端行为合同：
  保存、应用、请求验证、原生独立配置和活动任务生效边界分别表达。聚合状态不会把一路请求成功显示成
  全部成功，也不会把某一路失败扩散成其他 Runtime 失败。
- 关键边界：`native_unmanaged` 明确表示使用原生独立配置，Farfold 不覆盖；活动任务继续使用启动时绑定的
  配置，新配置只在对应 Runtime 的安全边界生效。该合同先作为 S2 的产品逻辑基础，未读取、保存或
  迁移任何真实凭据。
- 验证：新增 4 项前端测试覆盖一路验证不等于全局成功、部分失败归属、原生独立配置不覆盖、活动任务配置
  绑定。最新前端 47 文件 / 212 项通过，typecheck 和前端 build 通过；本轮相关 Prettier 与
  `git diff --check` 通过。没有安装或替换应用，没有执行 Provider 请求。

### 2026-09-10 S2 Host Provider 连接版本与任务绑定切片

- 新增 Host schema 9：记录 `provider_connections`、`provider_connection_versions`、
  `provider_target_projections` 和 `turn_provider_bindings`。Provider 投影现在绑定到具体
  Provider 连接实例、配置版本、目标 Runtime 安装、目标 Runtime 连接；同一 Provider key 的多个账号 /
  端点不会被聚合成一个全局状态。
- 配置指纹变化会生成新的 Provider config version，并把旧目标投影的 `verified_success` 清回
  `not_requested`；旧版本验证不能写入当前投影。`native_unmanaged` 不能记录为 Farfold managed 的
  请求验证成功。
- Pi / OpenCode 新 Host Turn 可携带 Provider connection + config version，Host 在任务开始时写入
  `turn_provider_bindings`；插话 / follow-up 不允许重新绑定 Provider 配置，活动任务继续使用开始时
  捕获的版本。
- S2 安装边界补正：当前 0.1.7 Pi / OpenCode 随包是保留交付事实，不是终态。S2 后续验收必须把
  Pi / OpenCode 也迁到本机优先、按需安装 / 校验 / 连接，最终主应用包不携带任何 Agent 本体。

### 2026-09-10 WP-A / WP-B 进展：Provider 行为缺陷修复与 OpenCode 首路接线

- 按 `Farfold-开发进展审查.md` 的 R1–R3 修正 Host Provider 投影：每次目标投影写入必须声明
  `config_version_id`，晚到的旧配置应用回执不能写到新配置；Provider key 或 source 变化会生成新
  config version 并清除旧请求验证；任务绑定必须匹配已应用的目标 Runtime、安装、连接、runtime
  provider 和 runtime model。
- OpenCode 设置页接入 Host Provider 存储：保存 / 移除 API key 后先写 Provider connection，再在
  OpenCode 重新连接完成后按当前选中模型记录 target projection。OpenCode 工作台恢复或选择模型时读取
  Host projection，只有当前模型与已应用投影精确匹配时，发送任务才携带 Provider connection/version。
- 当前边界：OpenCode 路径已经形成 UI→Host 存储→OpenCode 原生认证变更 / 重连→任务绑定的首个代码闭环；
  请求验证仍需要真实 Provider 任务完成后由原生结果回写，不能把 accepted 或 connected 当成请求成功。
  Pi / Codex Provider 可见流程、三路安装应用验收和旧入口删除仍未完成。
- 首路 ACP 处理结论：固定 OpenCode v1.15.13 ACP 源码的 `cancel` 入口返回
  `UnsupportedOperationError({ method: "session/cancel" })`，因此 WP-B 继续用既有 OpenCode Server
  路径闭合 Provider / 任务保障；WP-C 只能在冻结一个满足停止与交互要求的官方 ACP 组合后替换旧路径，
  不用 Farfold HTTP abort 旁路掩盖 ACP 缺口。

### 2026-09-10 WP-A / WP-B 监督复核修复：请求验证与凭据修订

- 修正 OpenCode 请求验证：前端不再把 `latestOpenCodeModel` 的“最后模型恢复”结果当成本次请求成功证据。
  Farfold managed Provider 任务提交前先读取 OpenCode 原生历史长度作为本次请求基线；提交被接受后，只有
  基线之后的新 assistant 消息同时满足无 native error、成功 finish、provider/model 精确匹配，才写入
  `verified_success`。旧成功历史、本次错误、取消、未知、模型不匹配均不会验证成功。
- 修正快速完成 / 旧回调边界：待验证状态在提交前带 baseline 建立，但只有 accepted 后才允许 idle 验证；
  unknown、拒绝、停止和切换作用域清理或忽略旧 pending。Host projection 读取失败会阻止 composer ready，
  不把 managed 配置不可读静默降级成无绑定 OpenCode 请求；未知 Provider connection 仍按尚未配置处理。
- 修正凭据变更身份：Host schema 升至 10，在 `provider_connection_versions` 增加
  `credential_revision_fingerprint`。OpenCode 保存 / 删除 API key 每次生成新的非敏感操作 revision，
  参与 config version 派生；不从 key 内容派生，不存原始 key。更换 key、删除或同 endpoint/model
  的凭据修订变化会使旧请求验证失效并把 target projection 降到 pending。
- 修正应用证据边界：OpenCode 设置页先写新 Provider connection 以失效旧投影，再调用 OpenCode 原生认证
  变更和重连；保存后重新读取 OpenCode 原生 Provider 列表，目标 provider 原生报告 connected 才记录
  `applied`，否则记录 failed。成功重连仍只表示配置应用，不等于请求验证。
- 修正 managed / 原生配置准入：前端新增 `providerRuntimeBindingState`，把未配置、原生独立配置、已绑定
  Farfold managed projection 和阻塞状态分开。只有当前 Runtime / installation / connection /
  provider / model 精确匹配、保存成功、应用成功且 config version 为最新时才把
  `providerConnectionId` / `providerConfigVersionId` 传入 OpenCode 提交；managed projection pending /
  failed / 模型不匹配 / 读取失败会阻止发送，不再静默降级成无绑定请求。原生 unmanaged 仍可按原生配置发送。
- 修正提交接受与 idle 竞态：OpenCode 提交前读取原生历史长度作为本次请求基线；提交被 Runtime 接受前若已收到
  idle，会记录 `idleBeforeAcceptance` 并在接受后立即补拉历史核验。验证仍基于本次基线后的 assistant
  终态、provider/model 和错误 / abort 状态，不只看历史长度增长。
- 当前验证：新增 / 更新前端行为测试覆盖旧历史不验证、本次 native error / abort / 模型不匹配不验证、
  credential revision 指纹生成、managed projection 阻塞 / 绑定 / 原生 unmanaged 准入；Host Rust 测试覆盖
  凭据修订变化使旧验证失效且不存 secret。目标检查通过：OpenCode conversation / opencode /
  provider-projection / managed-runtime-installation 前端 4 文件 34 项，Host schema 迁移测试 1 项，
  Host provider_projection 7 项，Host runtime_registry 5 项。仍未完成真实 Provider 任务、隔离 QA 候选安装应用验收、
  Pi / Codex Provider 可见流程和旧入口删除。

### 2026-09-10 WP-B / WP-C / WP-D 当前外部阻塞与独立推进

- WP-B 真实 Provider QA 未执行：当前任务没有提供隔离测试 API key、测试账号额度或明确可消费模型；
  使用现有正式 / QA 配置会触碰真实认证和外部费用。故本轮只关闭源码与自动化行为边界，不写“真实设置 →
  原生配置 → Provider 任务 → 状态回写”验收通过。后续 QA 必须使用隔离候选应用、隔离 Host 数据、
  明确测试凭据和一条低成本文件任务，完成后核对 OpenCode 原生 provider/model、Host
  `turn_provider_bindings`、Provider projection request_state 和实际产物。
- WP-C 首路候选取舍更新：OpenCode 固定 v1.15.13 原生 ACP 因 cancel 不支持，不能作为首路无损替换；
  Pi ACP 候选若仍把运行中 prompt 排队，不能替代已验收的原生 steer / follow_up；Codex 由于 Farfold
  已接受 0.143.0 App Server 能力，下一步可作为首个 ACP 探测候选，但必须先冻结官方 ACP adapter /
  `@openai/codex` / 本机 CLI 的版本组合，并证明不丢停止、原生提问、恢复和文件成果定位。未冻结前不得
  删除当前 App Server 路径。
- 2026-09-10 追加公开版本核验：`@agentclientprotocol/codex-acp` npm 最新 `1.11.0` 依赖
  `@openai/codex ^0.153.4`，而当前 Farfold 接受的 Codex 固定版本是 `0.143.0`；不能把该 adapter
  直接定为当前组合兼容。`opencode-ai` npm 最新 `1.18.30` 的官方标签源码已出现
  `session.abort` 支撑的 ACP cancel 路径，可列为 WP-C 下一轮 no-model 候选，但它不是已接受
  `1.15.13` 基线，也未做安装分发与无损能力验收。
- WP-D 独立推进入口：当前 `src-tauri/tauri.conf.json` 仍把 `resources/opencode-runtime/` 和
  `resources/pi-runtime/` 打进主包，这是过渡事实。本轮已新增 Pi / OpenCode 本机安装候选发现与手动选择
  UI，以及 Host 端绝对路径、固定版本、sha256 和 `--version` 检查；检查结果只生成
  `checked_not_active` 启动引用候选，不安装、不升级、不覆盖全局 CLI，也不替换当前随包 Runtime。下一步仍需
  在隔离候选应用里验证路径移动 / 缺失 / 错误版本 / 依赖异常 / 重定位恢复，并在证明外部安装启动闭合后再移除
  随包 Agent 本体。
- 2026-09-10 监督复核后追加实现：Pi / OpenCode 本机安装候选发现不再只看随包资源和
  `FARFOLD_*` 环境变量，新增 PATH、`~/.local/bin`、`~/.npm-global/bin`、nvm 常见版本目录、
  `/opt/homebrew/bin`、`/usr/local/bin` 的有限发现；仍不全盘扫描。外部候选按 canonical path 生成
  独立 system installation、runtime build 和 connection id，保存实际 sha256；随包候选仍保留托管
  hash 精确校验，且不能登记成系统安装。HostStore 的系统安装表已允许 Pi / OpenCode 保存，同时 Codex
  安装列表过滤为只读 Codex 记录，避免互相污染。OpenCode 已登记系统安装可由工作台保存为下一次新会话连接；
  Host 启动前重新核验路径、版本和摘要，匹配后才把 binary path 交给内部 OpenCode lifecycle。Pi 外部安装
  目前只保存和重核验；由于现有 Pi sidecar wrapper 仍定位随包 `pi`，非随包 Pi 新会话会明确阻断，不写启动成功。
- 2026-09-10 OpenCode ACP no-model 发行包探测：`opencode-ai@1.18.30` npm 主包下载到隔离临时目录并与
  registry integrity / shasum 一致；主包只包含 wrapper、postinstall 和 optional platform dependency。
  固定 `opencode-darwin-arm64@1.18.30` 平台包下载成功，包内 `opencode acp --help` 可运行。隔离 HOME /
  config / data / cache / state 下以 newline JSON-RPC 启动 `opencode acp`，`initialize` 返回
  `agentInfo.version=1.18.30`、`loadSession=true`、HTTP/SSE MCP、embeddedContext/image prompt capability、
  close/fork/list/resume session capability；`session/new` 在空项目成功返回原生 session id、model/mode
  configOptions 和 available_commands_update。对空闲 session 发送 `session/cancel` notification 未报错；
  这只证明 no-model 入口与静态源码 cancel 分支，仍未证明真实运行中模型请求可停止、权限 / 提问映射完整、
  Provider 配置和文件成果定位无损。顶层 `opencode --version` / `--help` 在本环境以 137 结束且无输出，
  需要作为候选异常继续排查，不能把平台包标为完整 Runtime 验收通过。

用户于 2026-09-09 明确确认“都验收了”，人工验收不再待办；依据是用户确认，不补造
操作者、机器参数或原始回执。0.1.7 已完成安装、打包及配对恢复检查；收尾中发现的一次
未归因启动超时保留为观察项，不声称已彻底消除。829c QA 工程证据保持原范围。
跨 Agent 交接、多 Agent 协作、LifeModel System 集成、第四路 Runtime 按用户要求暂缓，
不启动相关研究或开发。下方阶段状态及历史记录以本文末尾最新收尾记录为准。

## 1. 目标与固定决策

交付一完善 Pi/OpenCode 的开始、执行干预、返回续接体验及公共机制；交付二接入 Codex，
验证三路共存。P4 与交付一同步考察，不成为交付一的阻塞。保留 Farfold 暖色界面、侧栏、
底部输入区及各 Runtime 的独有能力，不重做品牌，不建立第二个 Agent loop。

| 项目      | 决策                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------- |
| 第三路    | 官方 Codex CLI 0.143.0，App Server，Farfold 自有 stdio 子进程；仅 Plan 原生提问采用获批实验 API |
| 安装      | 复用用户选择的官方 macOS arm64 程序或 npm 入口；不安装、不升级 CLI                              |
| 环境      | Farfold 独立 Codex 状态／认证；开发、QA、日用隔离，不导入默认 Codex 历史或令牌                  |
| 首版范围  | 核心文件工作、认证、模型、审批、用户提问、停止、转向、原生 ID 续接                              |
| 冷历史    | 用户 2026-09-09 同意固定 0.143.0 官方可恢复内容；命令详情缺口如实提示，不重建原生历史           |
| 扩展生态  | 保留原生加载行为；完整 Skills/MCP/插件配置管理、远程执行和自动化不纳入首版                      |
| 数据      | 交付一 schema 7；交付二 schema 8 只补充系统安装的启动定位／验证信息                             |
| 并发      | 全应用最多两条活动任务；同 Working Copy 排他；每个 Codex 连接最多一个活动任务                   |
| LifeModel | 原型冻结、入口及 opt-in/Proposal 治理保留；Codex 首版贡献／消费均不支持                         |
| 平台      | Apple Silicon macOS 内部版；跨 Agent 交接／协作、第四路和公开发行不实施                         |

历史基线：0.1.6 工程交付记录见
[内部交付历史](../../research/2026-09-07/internal-0.1.6-delivery-history.md)。
历史测试、旧截图和旧安装任务不等于本轮验收；本轮人工验收依据为上述用户确认，
未提供的操作者／机器详细记录不由 Agent 补造。
日用新增数据是用户数据，不再执行此前一次性整目录开发历史清理。

## 2. 行业学习与证据复核

- 针对具体配置、状态、权限、恢复或适配问题研究；优先官方固定版本源码、协议、文档和
  实际产品交互。同一用户目标／状态作比较，不只模仿外观或产品术语。
- 关键设计至少核对一项成熟实践及对应 Runtime 官方依据。记录参考、采用、未采用及原因；
  无直接先例的设计标为假设并验证。第三路发现新问题时重新查阅，不维护错误的原始假设。
- 引入代码／库前核对版本、许可和依赖；不引入 OpenLife，不修改 Runtime，不建泛化插件平台。
- 重要结论分为事实、推断、设计决定、未知／阻断。各切片完成时进行独立的一次反向复核，
  从原始输出、源码、实际文件、Session 身份和安装构建核对，不只复读开发总结。
- 接口存在不代表目标版本支持；认证、目录、进程、请求成功各自独立；发送成功不代表工作完成。
  不捏造权限选项、进度、diff、任务结果或验收。证据不足则降级／补验，关键失败不关闭阶段。
- 不建立机器可读治理平台。当前阶段在本文记录证据、限制和实际状态。

## 3. 顺序切片

### P0 — 同步依据与现状基线

状态：基线记录完成。
同步 AGENTS/PRODUCT/本文，历史记录归档。走查两路配置、项目、新建、执行、干预、失败、
退出和续接；同 Runtime 直用／Farfold 比较固定版本、模型和输入。
问题记录包含用户目标、复现、预期／实际、影响、证据层、职责与验收。
能力标为已验证／部分可用／适配未实现／官方受限／未知。
优先级：数据／目录／停止／身份；工作阻断和原生交互；状态与恢复；视觉键盘。
退出：固定有依据的 P1–P3 清单，区分缺陷与改善建议，不无限扩大普通视觉范围。

### P1 — 开始工作与共同入口

状态：实现与验收完成，日用 0.1.7 已安装；具体证据及保留观察见末尾。
统一新建、打开与启动检查；显示 Agent、项目、Working Copy、模型。
切换 Agent 打开另一会话，不迁移原生状态。认证、组件、连接、模型及请求错误独立表达。
主动验证只验证所选模型，不强制每次付费探测。失败保留草稿，不自动换模型／目录／Agent。
共同状态与 Pi trust／思考等专属设置分开；Provider/模型共用容器，认证实现保持专属。
移除运行快照和 UI 的固定 releaseCertification，安装验收保留在版本 Markdown 记录。
退出：两路真实新建和工作通过，无伪成功、错误绑定或输入丢失。

### P2 — 执行与干预

状态：共享停止／交互生命周期已实现；829c QA 三路原生干预已有安装证据，用户确认验收。
区分提交／执行／等待用户／停止中／完成／失败／结果未知。工具、答复、错误、交互位置稳定。
Stop 在工作和等待时可触达，以原生终态确认；Pi steer/follow-up 不混用，其他路不模拟。
交互绑定会话、原生请求和 generation，重复／失效／错会话回复不能执行。
共享事件订阅、身份和交互生命周期；原始 envelope 保留，专属投影和回复留在适配器。
统一交互容器但不混合 Pi 资源信任、原生工具权限与 LifeModel 审批。
输入区不得默认 Pi／默认支持转向；沿用 Host 准入，不增加前端调度／自动重试。
退出：真实执行、停止、交互通过，无串会话及迟到事件复活。

### P3 — 返回续接与交付一

状态：共同工作台已接入三路；829c QA 冷恢复与配对恢复通过，用户确认人工验收。
标题／项目／草稿／归档／选中状态持久；核对原生 ID 和目录后再允许续接。
缺失 Session 不静默新建；异常保留绑定和未知结果，恢复不自动重放。
冲突显示占用任务并保留输入。Changes 只说明路径观察，不假造完整 diff／因果归属。
统一激活、草稿、导航；历史与 gap repair 通过官方接口。
抽离主 App 的 Pi 专属控制，两路进入相同工作台；替换、验证、删除旧命令／订阅同一切片。
退出：P1–P3 同构建安装验收与原生能力回归，固定候选、配对恢复、正式路径检查后交付一。
人工使用与第二成员回执单列，Agent QA 不代填。

### P4 — Codex 固定接口与安装核验

状态：固定接口已有源码、协议与原生试验证据；用户已同意 Plan 实验提问及官方冷历史范围，
相应阻断解除。真实安装能力仍按 P5／P6 场景逐项验收，不能由接口试验代替。
固定 0.143.0，验证官方来源、实际程序、固定版本 schema 和核心行为。
2026-09-08 用户批准开启 experimentalApi 以验证 Plan 模式原生提问；
Default 模式 default_mode_request_user_input 开发中特性保持关闭，其他能力仍采用已核验稳定面。
获批例外须经实际验证；其余必须能力不在稳定面则阻断 P5，不自动换版本／Agent。
发现／选择支持官方 arm64 程序和 npm 入口；多候选显式选择。
记录入口、解释器、原生程序、版本、摘要。npm/nvm 不依赖 GUI PATH，不全盘扫描／加载 shell
配置／接受任意命令。不附着 Codex Desktop 或用户其他进程。
退出：固定版本所需方法、参数、通知、认证及续接实际核验；文档差异和未知单列。

### P5 — Codex 核心接入

状态：核心工作台、schema 8 程序引用、自有 stdio、ChatGPT 登录、文本／文件路径引用、
审批、Plan 提问、转向、停止及官方历史续接已有独立 Dev 与 829c QA 安装证据。
829c QA 完成三路并发、20 次冷恢复、流式计时及最新配对恢复；人工与第二 Mac 验收已由
用户确认，日用 0.1.7 已安装。API key 仅有接口／测试证据，未宣称真实账号请求验收。
复用共享 Host/工作台，自有 app-server stdio 进程；开发／QA／日用独立原生状态。
官方文件认证存储：目录 0700、文件 0600，不入 Host DB／日志／安装包。
官方 ChatGPT 浏览器登录／API key，完成／失败／取消／退出；不复制默认环境令牌。
项目资源／组织策略遵守原生语义，不把自定义状态目录宣称成完整隔离。
支持新建、发送、流、工具、审批、提问、停止、转向、ID 续接，模型／推理由原生目录提供，
不自动升级。文本和项目文件引用；图片仅在目标协议及模型同时确认支持时开放。
默认工作目录写入并需审批额外权限，不默认无限权限。
初始化／回复／通知／反向请求分别关联；管理请求有界超时，长任务不按普通控制超时结束。
Stop 未确认显示未知并提供终止自有 Runtime；异常使旧交互失效，保留绑定。
启动前验证程序；缺失／版本或摘要变化阻断并保留草稿。已接受程序仅搬家可重新定位；
不静默改绑构建，不实现跨 Codex 版本迁移，不修改用户 CLI。
退出：安装应用完整核心链路通过，共同机制复用，无第三套完整工作区或第二 Agent loop。

### P6 — 三路回归与交付二

状态：用户确认验收完成；0.1.7 日用安装及配对恢复已检查。829c QA 的核心回归、并发排他、冷恢复、
性能及配对恢复记录保留。五份既有报告格式问题已整理，安装声明不覆盖的能力继续单列。
固定候选及三路版本／来源／摘要，Codex 核心 + Pi/OpenCode 回归。
Pi+Codex、OpenCode+Codex 独立目录并发；第三条与同目录任务拒绝且保留输入。
第二 Mac 独立安装、CLI 配置、认证及任务；schema 升级／配对恢复／正式路径检查。
共性缺陷回公共层，专属差异留适配器。反向核对每条发布声明的同构建／环境／结果。
退出：明确三路支持范围和未验证项后交付；不代表全部生态／协作／任意 Agent。

## 4. 公共接口与数据

- 统一查询产品／安装／连接，区分程序来源和进程归属。Host 新建接收连接、Working Copy、
  类型化 Runtime 启动选项；打开／续接按持久绑定派发。
- 发送／停止共用准入，交互回复共用生命周期但专属验证，不能用原生命令绕过 Host。
- 组件停止只覆盖 Farfold 自有进程；动态身份不依赖两路静态字符串。
- 事件保留来源、generation、序号、原文、缺口与截断；有界缓冲，不将截断当完整。
- 工作台共享导航、状态、输入框架、交互容器；Runtime 模块提供专属配置／投影／操作。
- schema 8 仅添加系统安装路径、启动／解释器、摘要和验证时间，关联既有 installation/build；
  原生历史不复制成新权威。导出、恢复和完整性检查覆盖新增引用，跨机恢复须重新定位校验。
- 使用事务迁移和配对备份，旧应用不得开新 schema。真实日用数据不得当 QA 清理。

## 5. 测试、验收和复核

每切片运行相关行为测试；两次候选执行 AGENTS 全套检查及 clippy --all-targets。
新增覆盖：身份准入绕过、草稿／重复提交、乱序／重复／旧 generation／gap／超限、
转向 Stop 竞争、审批 Stop 竞争、切换后迟到回复、npm/nvm／空格／symlink／程序变化、
schema 7→8 数据保持、未知 Runtime 不落入 Pi、失败测试也释放 TempDir。

安装场景：独立配置、真实代码读写与检查、多文档产出读回、项目指令、原生干预、停止无
后续副作用、崩溃未知且无重放、每路同一 Session 连续三次冷启动、并发排他、外部 CLI
变化恢复、开发日用／默认 Codex 隔离、LifeModel 关闭时工作且旧治理回归。
900×620／常规／宽窗口检查长历史、键盘、焦点、滚动、忙碌和错误。前后真实截图对比；
浏览器只是辅助。测试数量、状态和覆盖范围来自实际输出。

性能：可比较环境下冷进程交互 p95 ≤2s，侧栏 ≤500ms，Runtime 就绪后恢复 ≤2s，事件绘制
≤150ms。每候选 20 次，记录可见性、负载及缺失，不删失败样本；Provider 时延分开。

复核节点：P0 检查缺陷真实性；关键设计检查行业及官方依据；P1–P3 检查状态／身份；
P4 检查固定版本接口；P5 检查原生／UI／存储；交付前检查同构建和实际结果。
接口或 Runtime 改变后重验受影响假设；关键失败不关闭阶段。
本人任务和第二 Mac 由实际操作者完成，未取得时保留待验收，不阻断独立工程工作。

## 6. 本轮执行记录

### 2026-09-07 起点

- 源码 HEAD c49148f；修改前 tracked 工作区干净，reports/ 和 output/ 为现有未跟踪报告资料，保留。
- AGENTS／PRODUCT／唯一计划已同步本次用户授权；上一轮 A–D 记录归档并保留完整正文。
- 正式 UI 当前已有两条实际会话，不是交付时的空白 profile；不清理或改写这些用户记录。
- 当前返回界面截图：`.design-qa/2026-09-07-runtime-workspace/01-opencode-return.png`。
- 本机 Codex 0.143.0 成功生成 stable 和 experimental schema，位于 ignored target 目录。
  stable schema 包含 turn/steer、thread/resume、account/login/start、两类审批及用户提问；
  这只是类型存在的事实，初始化／行为／Provider／安装验收均未因此记为通过。

### 首轮问题与实现切片（源码验证，安装验收进行中）

| 用户目标／问题        | 当前证据与职责                                                                                                       | 首轮处理及验收方法                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 判断 Runtime 是否可用 | 源码与失败后通过的测试复现：能力面板固定显示“待安装验收”，无法代表当前程序状态。Host／UI                             | 删除 `releaseCertification`；构建验收只在 Markdown 留证。安装界面核对无固定验收标签，进程／Provider 状态独立。         |
| 从一致入口开始        | 两路已有单独新建公开命令、重复开始页面；属于架构与体验改善，不当作已复现运行故障。Host／UI                           | 新建统一 `host_session_create`；安装／连接与专属选项必须匹配；复用开始面板，Pi trust 保留专属。安装两路真实新建验证。  |
| 按原生身份继续        | 已有共同打开入口，但 Pi trust 是顶层通用字段。Host                                                                   | 改为带 Runtime 标识的专属选项，按持久绑定校验；旧字段拒绝。验证跨 Runtime 选项不能改变绑定。                           |
| 判断 Stop 是否完成    | 源码：发送停止命令后无独立请求反馈。UI                                                                               | 共用停止请求状态；确认请求不清除“停止中”，原生结束才清除。四项行为测试覆盖确认／重复／拒绝／迟到失败；真实停止仍待验。 |
| 输入不误发、不丢失    | 源码：Enter 未判断 IME，OpenCode 在提交确认前清草稿。UI                                                              | IME 确认不发送，提交期间禁用编辑；两路仅提交成功后清草稿。中文输入和原生拒绝在安装应用补验。                           |
| 传输异常后知道结果    | 源码审阅风险：OpenCode `prompt_text` 错误后直接取消准入，需要区分拒绝与响应丢失。尚未复现真实传输异常。Host／Adapter | P2 保留高优先级核验；不能把源码风险写成已复现缺陷或已修复。                                                            |

已执行的检查：首轮前端 36 文件／141 测试通过；Rust 224 测试通过，`cargo clippy --all-targets -- -D warnings` 通过，前端构建通过。
此后续接选项和草稿提交时机有追加修改，相关检查与安装结果另记，不能继承此前结果。
开发包与正式 `/Applications/Farfold.app` 分开；正式 0.1.6 的用户数据保持保护。

### 行业依据与取舍

- Pi 0.84.3 随包 `docs/rpc.md` 明确 prompt 响应表示接受／排队，执行事件继续异步传递。
  采用“控制响应和执行终态分离”，保留 Pi steer 与 follow-up 不同语义；不将 UI 停止请求当成调度器。
- [OpenCode 官方 Server 接口](https://opencode.ai/docs/server/) 使用独立会话、异步提示、事件和中止接口。
  采用共同工作台容器和独立原生适配；不把 Pi trust、跟进或权限语义套入 OpenCode。
- [Codex 固定版本官方来源](https://github.com/openai/codex/tree/rust-v0.143.0) 与本机 npm 包均为 0.143.0、Apache-2.0。
  采用官方 npm launcher 解析平台依赖的做法；尚未引入第三方实现或重新分发其代码。
  目标程序输出的稳定 schema 作为字段证据，在线文档只用于理解整体行为，不直接套用更新字段。

### P4 无认证隔离接口实测

本机 npm 入口解析到 Node v22.22.3 下 `@openai/codex/bin/codex.js`，版本 0.143.0。
入口 SHA-256：`d3be844c45c4fd89392536e56e1010963f94785592596b50cd0c45bb8a341406`。
这不是完整程序身份：原生依赖、解释器摘要和官方分发比对见下方独立复核记录。

在临时独立 CODEX_HOME 中启动自有 stdio App Server，关闭 experimentalApi，指定文件认证，
移除继承的 CODEX／OPENAI 认证环境变量；未读取默认认证／历史，退出后删除该临时目录。
原始返回要点：

- initialize 成功；account/read 返回 account 为空且 requiresOpenaiAuth=true。
- thread/start 返回原生 ID，工作目录与请求相符。
- 空线程 `thread/read(includeTurns=false)` 成功；`includeTurns=true` 返回 -32600，
  “is not materialized yet; includeTurns is unavailable before first user message”。
- 同目录冷启 App Server 后 thread/resume 返回 -32600，“no rollout found for thread id”。
  设计决定：空白未持久化与丢失历史须明确表达，不另建线程冒充续接。
- 未登录时 model/list 仍返回 5 个条目，不能当作认证／真实请求成功。
- 无活动 turn 的 turn/steer 返回 -32600，“no active turn to steer”。

该实测只验证上述控制面行为；真实请求、审批／提问事件、转向、认证完成及持久线程三次续接仍未知。
P4 不标记完成，P5 尚未开始。

### P4 稳定能力门槛复核：用户提问阻断 P5

事实（同一 0.143.0 程序，experimentalApi=false）：

- `turn/start` 携带 `collaborationMode` 返回 -32600：
  `turn/start.collaborationMode requires experimentalApi capability`。
- `experimentalFeature/list` 将 `default_mode_request_user_input` 标记为
  `underDevelopment`、`enabled=false`、`defaultEnabled=false`。
- 固定版本源码 `protocol/src/config_types.rs` 的 `allows_request_user_input()` 只允许 Plan；
  `tools/src/tool_config.rs` 仅在上述特性启用后增加 Default。
  `core/src/tools/handlers/request_user_input.rs` 会实际检查该允许模式，不能只因 server request
  schema 存在就认定用户提问可用。

结论：本计划要求的原生用户提问，未能在该版本默认稳定配置下成立。
启用 Default 的开发中特性或开启实验 API 才能走已知路径；本轮不做这一隐式变更。
按 P4 退出规则，P5 暂停，交付一继续。普通文字问答不能冒充原生 `item/tool/requestUserInput`。

官方分发复核已通过：从固定 GitHub release 下载 npm arm64 压缩包，仅校验、未安装或执行。
包 SHA-256 `4efb871d409993c1c7d2103b0ceb7fc51aa2cb6ae85d0a2dbdb772678c70eb60` 与 release 摘要相符；
其中原生程序 SHA-256 `9070e47d422129106bc41ca651a9998b06a6c55bd42a7c3362b48f1d2850766f`
与本机 npm 安装相同。Node 解释器 SHA-256 为
`5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c`。
安装还包含 code-mode host、rg 和 zsh 资源，后续程序登记不能只校验 launcher 文件。

### 隔离安装首轮：失败也计入证据

`/Applications/Farfold Dev.app`，bundle `ai.farfold.desktop.dev`，debug QA，版本标识仍为 0.1.6，
不得与正式 0.1.6 的已交付构建混同。初始可执行 SHA-256：
`523a97756c0a95acab19dffa2469890c83d411233400204a6d4b3fc66855895e`；严格签名检查通过。
使用独立 Host/OpenCode 数据与 Pi 配置副本，原生 Pi 和 capability bridge 分别显式设置
`PI_CODING_AGENT_DIR` 和 `FARFOLD_PI_AGENT_DIR` 指向相同私有 QA 目录；未复制 Codex 认证。

- Pi 新建成功，原生 ID `01a07bcf-6ee7-775e-b323-d88de6e0b6ff`。
  当前 Z.AI / GLM-5.3-Flash 的真实请求返回 429，原因是余额／资源包不足；`result.txt` 未生成。
- OpenCode 新建成功，原生 ID `ses_f842d7aa8ffettDeS21jkFeS0F`。
  当前 Z.AI / GLM-4.5 也返回额度不足并进入原生重试；Stop 后返回空闲，`result.txt` 未生成。
- 两路均未因此记为真实任务通过；没有自动更换 Provider、账号或模型。
- 实际 UI 复现：OpenCode Stop 后保留“正在重试”文案；新回归测试先出现两个失败，修正原生
  idle 投影后 9 项文件测试通过。保留失败原因并显示“重试已结束”，不写成任务成功。
- 实际 UI 复现：暗色模式开始／空白页标题沿用浅色硬编码；改用现有主题文字变量，不重做样式。
- 源码本轮全部检查中，格式检查被既有未跟踪 reports/ 内 5 个文件挡住；未修改历史报告，
  不能记录 `format:check` 通过。

后续 Dev 构建 SHA-256：`e83370a838eab54905a6de54ba1fe7ec278b625f27c6c34bad552e056a9605a3`。
已保留独立的 `QA Pi 保留身份`／`QA OpenCode 保留身份` 标题及 PI-DRAFT／OC-DRAFT 草稿，
开始检查相同 native ID 冷启。首次 Pi 续接出现 `Pi Runtime version check timed out`，
保留该失败样本。同期 SDK 探测两项测试超过内部 10 秒期限无响应，不能等同 Provider 拒绝；
已改进测试错误说明，尚未通过延长超时掩盖问题。该时段机器仍在 Rust 编译，不据此报告正式 p95。

上述 e83370a8 构建共检查三个冷进程（PID 19421、22084、22207）：
两路最终均核对到上述相同原生 ID、各自标题和草稿；第三次先恢复上次选中的 OpenCode，再打开 Pi。
首个冷进程中 Pi 的第一次尝试超时，编译结束后手动重试才成功；因此不能记为“三次均一次通过”。
恢复没有提交新任务，失败历史没有被自动重放。界面截图 05–07 留在本轮 `.design-qa` 目录。

### 公共界面与原生回复切片

- 两路共用 `WorkspaceHeader` 与 `SessionStartPanel`；模型、运行状态、Runtime 选择和 Pi 扩展状态
  由各自调用方提供。Pi 控制器仍在 App 内，不能声称已完成整个工作台架构抽离。
- 共用 `NativeInteractionReply` 只管理回复中的显示状态；Host `InteractionRegistry` 仍是原生
  身份、过期和重复回复的校验权威，不新增权限或调度器。
- Pi 弹窗在 Host 接受回复后按确切请求 ID 移除；拒绝时保留输入并在弹窗内展示错误。
  超时按请求 ID 移除，避免旧计时器删掉后续弹窗。OpenCode 权限沿用专属回复类型。
- 四项行为测试覆盖单次发送、接受前不关闭、拒绝后明确重试、过期／代际更换后的迟到成功及失败。
  最新完整前端运行 37 文件／147 项通过；错误显示追加修改后该文件 4 项通过，前端构建通过。
  最新 Rust 225 项通过，测试目标 clippy 通过；随后修改仅在前端及测试脚本，未修改 Rust。
- 官方 Pi 0.84.3 `docs/rpc.md` 的 Extension UI Protocol 要求按 request ID 回复，原生端负责超时默认值。
  采用这一原生生命周期；未将确认／输入包装成工具权限。准备在独立 Dev 中用临时原生扩展
  检查实际往返，不请求 Provider；此证据不能替代真实 Agent 文件任务。

尚未关闭：Provider 真任务、OpenCode 不确定提交／事件断流后的任务占用、共同配置框架、
完整交互容器和 Pi 控制器迁移、同构建完整回归、正式性能采样、配对恢复及人工使用。
本轮尚未形成任何新的内部交付候选，正式 `/Applications/Farfold.app` 未替换。

### 原生交互复验与追加修订

安装构建 `0dcc258e424b7a38a42f03d4a8506b97af37b52dd673dca1d9fabc1c1cefff7f` 的
Pi 确认实际返回 true；随后修订暗色弹窗标题及输入标签。
构建 `cc4d25761f622c166c203a562adbc468283036c43e26df666a843e510f99a49c` 的原生扩展
实际返回：输入 `QA-中文-42`、选择 `乙`、Escape 取消 false、多行编辑的两行原文、超时 false。
返回值同时经界面通知和 QA 项目中的 `native-dialog-*.json` 核对。
这是临时 Pi 原生扩展的工程检查，不是 Provider 驱动的 Agent 文件任务，也不代表 OpenCode 权限通过。

- 截图 08 复现暗色弹窗标题不可读；截图 09 验证标题修复与有名称的中文输入控件。
- 截图 10 复现原生超时后侧栏“需要处理 1”残留；两项 Rust 回归先失败后通过。
  Host Registry 按原生 timeout 记录单调时钟期限，在读取／回复前清除已过期请求，
  不发送人工构造的取消／确认，也不把超时变成任务完成事件。
  前端超时后只读取原生状态以刷新共享快照；无 timeout 的交互不强行过期。
- 截图 11 的捕获尺寸为 900×620，输入区及模型／详情入口可操作；常规窗口亦已查看。
  未完成宽窗口、长交互、Stop／回复竞争和全部键盘场景，不能记为完整 UI 验收。
- 冷启实际显示过“未配置”，但此时配置尚未读取。改为区分待读取／读取中／读取失败，
  只有已读快照才显示配置结论；启动可用性与认证／请求验证仍分开。

追加检查：前端 37 文件／147 项及类型检查通过。第一次完整 Rust 运行 226 通过／1 失败，
失败是 Pi 原生 get_state 的 5 秒超时。该测试还未隔离 Pi 配置且断言失败会跳过清理；
现使用私有 agent 目录和退出守卫，增加失败时回收子进程／目录的测试。阈值仍为 5 秒。
随后完整 Rust 228 项通过，测试目标 clippy 与 cargo fmt 检查通过。
这不能证明安装应用的冷启性能问题已解决；之前失败样本仍保留。已核对并删除该次失败留下的
唯一空测试目录，未触及用户或 QA 会话。仓库格式检查仍只被既有 reports/ 中 5 文件挡住。

最终 Dev 复验构建：可执行 SHA-256
`c60b5857bc9fa651876f5921d51e1fbd3bb0896406f86710e5dc94a99836cdd1`；完整 App 严格签名检查通过。
该构建实际启动显示“正在读取配置”，没有把未读快照标成未配置。
原生 timeout 返回 false 后弹窗关闭、侧栏待处理为 0；其后无 timeout 的 confirm 正常返回 true。
两项 QA 返回文件于 21:14 更新，与现场通知一致；截图 12 留存超时修复结果。
同一进程恢复两路上述原生 ID、各自 Working Copy、标题及草稿；截图 13 记录 OpenCode 身份。
此处是当前切片复验，不替代该构建的三次冷启、真实 Provider 任务或完整安装验收。

退出所有本轮 QA 子进程后，按摘要核对并移除唯一临时 QA 扩展；仓库中的 fixture 源码、
截图和独立 QA 项目中的原生返回文件保留。随后以相同构建和私有 Pi 环境重新打开 Dev，
等待可用 Provider／模型信息；没有自动请求、改账号、复制 Codex 认证或替换正式应用。

### 2026-09-07 后续切片：OpenCode 不确定提交、断流占用与恢复（进行中）

本节接续上面的未关闭事项，不把此前源代码检查或旧 QA 哈希沿用为新构建验收。

- **已确认事实**：原实现对 `prompt_async` 所有错误撤销 Host admission；对
  `transport_error`／`protocol_error` 结束匹配 generation 的任务。恢复查询只读历史，
  没有读取原生会话活动状态。HTTP 响应或 SSE 连接丢失都不能据此证明任务停止。
- **行业与官方依据**：固定 OpenCode `v1.15.13` 的
  [prompt_async handler](https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)
  先 fork 原生 prompt，再返回 204；
  [SessionStatus](https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/session/status.ts)
  的 list 省略空闲会话；
  [官方 TUI sync](https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/cli/cmd/tui/context/sync.tsx)
  结合原生事件与 `session.status` 查询恢复视图。采用其官方状态查询方式，保留 Farfold 的
  admission、身份和界面；没有复制 TUI 实现，也没有增加 Agent 循环。
- **设计决定与限制**：提交响应丢失返回专门的 unknown 结果，保留草稿和 Working Copy
  占用，不重发。断流只降低结果置信度；只有匹配的原生终态、已观察执行后的官方空闲查询，
  或显式终止自有进程的确认才能释放占用。未观察到执行的请求可能仍在排队，因此一次空闲
  读数不足以撤销它。此保守规则是 Farfold 的宿主设计，不宣称 OpenCode 提供了提交查询令牌。
- **实现**：官方历史和状态重建核对持久 Host／原生 Session／Working Copy／generation；
  迟到查询不能结算替换后的任务。恢复沿用 `host_managed_runtime_stop`，额外绑定确切 turn ID，
  不依赖故障 HTTP 服务才能终止 Host 自有进程。新建／打开不能越过未释放的 Runtime 占用。
  进程 kill／wait 失败时保留 Child 所有权；SSE 正常 EOF 也触发缺口核对，主动停止后的旧流不报新故障。
  前端状态重建只允许一个在途调用并合并更新；恢复不会自动重放输入。
- **独立复核**：临时恢复旧断流处理后，`routed_transport_failure_keeps_the_working_copy_occupied`
  实际失败（active turns 0，预期 1；exit 101），随后恢复修复代码。
  HTTP 故障测试实际收完 POST body 后关闭连接，确认结果为 unknown；不是模拟 Provider 成功。
  临时输出位于忽略的 `src-tauri/target/opencode-protocol-audit/`。
- **检查进度**：前端 37 文件／149 项通过；先前一次 Rust 全量 232 项通过，最后的身份和竞争
  补丁仍需完成新一轮全量测试。测试目标 clippy 已通过一轮。`format:check` 仍被上述既有
  reports/ 的 5 文件阻断。新安装构建、故障操作和准确哈希待下文实际记录。

原生 status 和 Host 占用证据只说明活动／终止，不说明用户目标完成。强制终止 Server 不撤销已有
修改，也不能证明所有外部工具进程都已退出；恢复说明保留这一边界。真实 Provider 成功任务、
完整 P1—P3 安装验收、性能采样、人工使用与 Codex P4 稳定提问门槛仍未完成。

#### 安装故障验证与反向证据复核

- Dev 构建 `c461ab602749015fd0119902b032d361b063f2bb1d8c47d8230774e8ca30ef55`
  在同一 OpenCode 原生会话中发起不调用工具的 QA 文本请求，原生进入余额不足重试。
  确认自有 child 37020 的 parent 为 Dev 36879 和准确应用内程序路径后，注入进程退出。
  截图 14 显示结果未知、任务占用保留和恢复入口；显式恢复后续接同一会话，截图 15 显示
  原历史和恢复后的 QA 草稿。没有产生 Provider 成功答复或 result.txt。
- 随后构建 `f716a7ab52cb3239338742f2e66bdaf7f8559e48ce166c871c9b9652bffeafba`
  再次观察原生重试，针对自有 child 40556／Dev 40422 注入退出，确认未知状态下新建、续接、
  目录选择禁用，恢复操作可用。该构建的恢复按钮样式已统一；但 900×620 截图 16 实测发现
  通知被挤出窗口且滚动无法到达，不能判为小窗口通过。
- 已定位公共工作台 Grid 对可选行使用自动排布：没有 startup strip 时，通知误落入伸缩行。
  修订各公共区域的明确行位置，并约束通知滚动高度；最终安装复验结果继续另记，不沿用上面哈希。
- 源码最终行为测试 233 项全部通过（实际 5.25 秒）；前端 149 项、类型／构建检查、测试目标
  clippy、cargo fmt 和 diff 空白检查通过。格式检查仍有上述 5 个既有报告文件未通过。
- Host SQLite 里的 Changes `terminal_reason` 对此未托管 QA 工作目录保留
  `working_copy_not_managed`。它不是恢复成功、任务完成或文件修改的证据，不能拿它代替原生身份
  和现场界面。Host 与原生数据库均核对到 `ses_f842d7aa8ffettDeS21jkFeS0F` 及准确 QA 目录；
  首次恢复后原生消息为 2 user／2 assistant 记录，assistant 记录存在不代表生成了成功答复。

#### 无响应进程与后台执行修订（最新状态，尚未安装复验）

1. 布局修订安装构建为
   `4a5811c884f420137e6c87bb75b8fa820e828079577b214d4a34b2a92730d155`。
   对 Dev 41605 的确切自有 OpenCode child 41639 注入 SIGSTOP；实际请求仍使用已选择的
   GLM-4.5／zai，不更换账户、模型或权限。Stop 后读取界面出现 17.4 秒工具超时，随后显示
   原生 HTTP 查询失败与结果未知；恢复按钮最终成功终止此仍存活但无响应的自有进程。
   该次不是 Provider 成功任务。小窗口布局及后续异步修订尚需在最终同一构建重新验证。
2. 源码确认相关 Tauri 命令同步执行 HTTP；
   [Tauri 官方命令说明](https://v2.tauri.app/develop/calling-rust/#async-commands)
   明确区分主线程同步命令与后台任务。沿用仓库现有 `spawn_blocking` 模式，把会话新建／打开、
   Pi/OpenCode Host 提交与停止、导航元数据、OpenCode 历史／目录／权限请求及状态重建移出 UI
   线程。保留既有 Host controller、admission 和各原生协议，不建立新调度权威。
3. OpenCode 原生 Stop 的 HTTP 等待移出生命周期互斥区，使确切任务的自有进程恢复可以进行。
   原生 Stop 未返回时，即使收到 idle 也保留 admission，避免迟到的按 Session 取消操作影响新任务；
   响应丢失后拒绝重复 Stop，保留恢复入口。响应确认后重新核对原生状态；Stop 返回 true 本身
   仍不等于终态。新增回归覆盖 idle／未确认 Stop／新任务准入的竞争。
4. 最新检查：Rust **234 项通过**（7.02 秒）、测试目标 clippy、类型与构建检查通过。
   前端于 22:12:06 的一轮出现 2 项超时与 1 个 worker 错误（145 项通过；共执行 147 项）。
   系统电源日志显示 22:11:40 开始合盖睡眠、22:15:59 DarkWake；这一轮跨越了系统睡眠，
   不能作性能样本，也不据此修改测试阈值。23:10:17 按原配置重跑，**37 文件／149 项全部通过**
   （2.92 秒）。这些环境因素也意味着不能只用前述工具超时推算 UI 阻塞时长。
5. 最新完整 Dev bundle 已构建并通过严格签名检查，暂存于
   `src-tauri/target/debug/bundle/macos/Farfold Dev.app`，可执行 SHA-256：
   `66f457b248818afc0e507de6e3fc56c3bd16be7412374c96b587c1fba5937c7d`。
   **它尚未安装、启动或完成 UI 复验**。当前 `/Applications/Farfold Dev.app` 仍为上述 `4a5811…`；
   正式 `/Applications/Farfold.app` 未替换。Computer Use 报告 Mac 锁定且自动解锁失败，
   因此停止安装界面操作，不把源码／测试／暂存构建当作安装验收。
6. 解锁后待办：退出旧 Dev，完整安装并核对 `66f457…`，使用已有私有 Pi 环境启动；
   同一构建复验无响应 Stop 与恢复、900×620 控件可达性、两路原生身份与冷启。
   完成本轮临时 QA 输入后，经 UI 恢复 OpenCode 草稿
   `OC-DRAFT-KEEP-20260907：这条草稿不发送。`；不自动重放任何测试请求。
   Provider 成功任务及其余 P1—P3 退出条件仍未关闭，Codex P4 阻断未解除。

按摘要、路径和无进程引用核对后，已删除本轮暂存的三个旧 Dev 应用副本（c60b5857、c461ab60、
f716a7ab）；当前安装应用、最新暂存构建、私有配置／会话、截图和故障证据保留。

#### 解锁后的同构建安装复验与独立复核

- 已把 `66f457b248818afc0e507de6e3fc56c3bd16be7412374c96b587c1fba5937c7d`
  完整安装到 `/Applications/Farfold Dev.app`，严格签名与安装摘要检查通过；使用私有 Pi 环境启动。
  此记录替代上一节“尚未安装”的当前状态，保留该节作为当时事实。正式应用仍未替换。
- Dev 48694 的自有 OpenCode 48725 经父 PID、确切可执行路径与安装摘要核对后注入 SIGSTOP。
  原生已显示 GLM-4.5／zai 余额不足重试。点击 Stop 后 UI 显示停止中，900×620 下核对状态、
  终止自有进程和输入区均可见；点击恢复后 48725 已不存在，界面明确结果未知、不会自动重发。
  截图 `17-async-stop-recovery-900x620.png`、`18-async-owned-process-recovered.png`
  位于 `.design-qa/2026-09-07-runtime-workspace/`。这证明本场景可操作，不是 20 次性能采样。
- 经 UI 恢复 OpenCode 指定草稿；同一安装构建冷进程 48815、48887、48965 连续三轮，
  每轮分别续接 Pi 与 OpenCode，核对实际历史和草稿。Host/native Session ID、Working Copy、
  标题与草稿前后相同；OpenCode 原生库的 10 条消息 ID 集合没有增加（其中 assistant 记录
  不能作为成功答复证据）。截图 19—21 保存当前构建 UI；只读数据库核对原始输出保留在
  `src-tauri/target/opencode-protocol-audit/async-recovery-*.json`，不是新增治理平台。
- 两个 QA 目录仍无 `result.txt`。余额不足阻断真实 Provider 任务验收；以上仅关闭这个构建的
  无响应恢复、小窗口恢复入口和三轮身份／草稿续接检查，不关闭 P1—P3 或交付一。
- 独立复核固定 OpenCode 1.15.13 源码发现新增问题：`session.error` 并非必然终态。
  官方 `session/prompt.ts` 的文件／目录引用读取失败会发出该事件，随后返回错误说明并继续
  构造输入；官方 TUI `context/sync.tsx` 通过 `session.status` 更新运行状态。
  Farfold 原有 Host coordinator 与前端 reducer 却在该错误事件上结束任务／释放目录。
  此缺陷通过源码路径确认；新增回归正在核验，尚不写成安装场景已修复。

#### P2 原生错误与任务终态分离

- **事实／依据**：固定版本
  [OpenCode 1.15.13 prompt.ts](https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/session/prompt.ts)
  的文件引用读取失败路径发布 `Session.Event.Error` 后继续返回输入片段；
  [同版本官方 TUI 状态同步](https://github.com/anomalyco/opencode/blob/v1.15.13/packages/opencode/src/cli/cmd/tui/context/sync.tsx)
  依据 `session.status` 更新活动状态。采用其“错误诊断不替代活动状态”的边界；保留 Farfold UI、
  Host 准入与原始事件，不复制 TUI 实现。
- **修复**：删除 coordinator 在 `session.error` 上释放任务的旧分支，前端保留工作状态与不确定性，
  仍显示原生错误；共享投影保留先前活动状态并要求官方状态核对，不根据错误发明活动转变。
  原生 busy／retry 后的 idle 才按现有规则结束占用，Stop 未确认期间的准入保护保持。
- **复核**：新 Rust 回归在修复前实际得到 active turns = 0（预期 1），前端回归实际得到
  isWorking = false（预期 true）。Rust 测试第一次编译因缺少 Value 类型限定失败，修正测试后
  才取得上述行为失败证据。修复后 Rust **235 项通过**（1.69 秒）、前端 **37 文件／150 项通过**
  （4.31 秒），测试目标 clippy、typecheck、cargo fmt 和 git diff --check 通过。
  全仓 format:check 仍只报告既有 reports/ 下 5 个文件，未改写这些外部报告。
  原始执行日志为 `src-tauri/target/opencode-protocol-audit/nonterminal-error-*.log`。
- **构建**：完整 Dev bundle 构建与严格签名检查通过，已安装并以私有配置启动（PID 52803），
  当前可执行 SHA-256 为 `1a3791e8806c48ba3cfc962e84af461fa6eee8892bad4e08abda929c1ee4d5be`。
  这一修改之后，不把上一构建 66f457 的三轮冷启／故障注入直接记作新构建验收。
  非终态错误场景目前证据为固定官方源码与 Host／投影行为测试，尚无安装应用实际触发证明。

- **最新安装检查范围**：1a3791 构建已分别经 UI 续接 Pi／OpenCode，标题、模型、草稿和原生历史
  正确显示（截图 22、23）；Host 绑定／Working Copy／草稿、OpenCode 消息 ID 集合与 66f457
  检查后的基线一致，Pi 原生 JSONL 的 SHA-256 也完全一致，没有自动重发。
  本次未继续消耗已知余额不足的 Provider，也未在 1a3791 重做三轮或无响应故障注入。
  保留这些准确的验证范围；正式交付仍需同一候选的完整安装验收与真实任务。
- **下一切片**：继续 P1—P3 的共同配置、会话激活与 Pi 专属控制迁移；补齐原生失败恢复、
  并发、资源与性能验收。真实 Provider 成功任务需可用额度／用户指定可用模型；
  Codex 0.143.0 稳定面原生提问门槛仍阻断 P5，不改变实验开关或版本绕过。

#### 2026-09-08 用户指定 GLM-4.5-Air：模型切换与请求验证

- 用户明确指定把此前 Z.AI API 的模型改为 GLM-4.5-Air。本次仅修改隔离 Dev/QA 环境，
  沿用现有 Provider／认证／接口地址；正式 Farfold 配置未修改，Runtime 版本及应用构建未变。
- OpenCode 从原生目录选择 `zai/glm-4.5-air`，实际返回 `GLM45AIR-OK`；原生 assistant
  `msg_07f10aed6001Asbqr0Z2kLTe9A` 记录 modelID 为 `glm-4.5-air`、finish 为 `stop`、无 error。
- Pi 0.84.3 的 Z.AI 内置目录未含 Air。按随安装版本提供的 `docs/models.md` 官方机制，
  在私有 `ai.farfold.desktop.dev/pi-agent/models.json` 添加一个模型，并复用原生 Z.AI 的 API
  与兼容参数；没有修改 Runtime 或复制认证。模型文本／推理与 128K 上下文依据
  [Z.AI 官方模型说明](https://docs.z.ai/guides/llm/glm-4.5)，成本元数据依据
  [官方价格](https://docs.z.ai/guides/overview/pricing)；本地输出上限保守设为 16384。
  配置权限 0600。目录刷新后旧 Pi 进程曾返回 Model not found；重启 Dev、续接原生 Session 后
  再选择即生效。此差异记录为配置刷新体验待完善，不把 SDK 目录已加载当作原生进程已加载。
- Pi 当前会话与新会话默认均已选择 `zai/glm-4.5-air`。实际返回 `PI-GLM45AIR-OK`，同一
  原生 JSONL 记录 model_change、模型为 glm-4.5-air 的 assistant、stopReason=stop、无 error。
- 两次请求均为禁止工具／文件操作的简短模型验证；证明当前模型调用成功，不等同于读取、
  修改、工具审批与完整任务验收，也不能据此推算账户剩余额度。此前“没有可用 Provider 请求”
  的阻断对这两条配置已解除，后续真实任务使用用户指定的 Air。两路 QA 草稿通过 UI 恢复。
- 安装可执行摘要仍为 `1a3791e8806c48ba3cfc962e84af461fa6eee8892bad4e08abda929c1ee4d5be`。
  Host 与原生 Session 身份保留，Codex P4 稳定接口阻断不变。

#### 2026-09-08 真实文件任务与 Pi 模型配置激活切片

- **当前安装事实（1a3791）**：两路均用用户指定的 GLM-4.5-Air 实际读取 input.txt、写入
  result.txt、读回并调用 bash 检查。独立读取实际文件发现首轮两路都只有 `42`，缺少要求的换行，
  所以未将 Agent 的 FILE-OK 回复记为完整任务通过。通过各自原生会话继续修正后，两份文件
  精确字节均为 `34 32 0a`；Pi bash 输出 EXACT-BYTES-OK、read 输出 `42\n`，OpenCode 原生
  bash 记录 Python 精确字节断言及 hexdump 结果。没有由宿主代写产物或伪造工具结果。
  OpenCode 的修正过程中有多次工具尝试，不能写成首次执行即正确。两路标题／原生身份保持，
  LifeModel 关闭，草稿已恢复；这是工程安装任务证据，不代填用户或第二成员人工验收。
- **问题复现与官方依据**：前一轮在 SDK 刷新目录后选择新增 Air，实际运行 Pi 返回 Model not
  found；重新启动后成功。核对固定 Pi 0.84.3 的官方 `docs/models.md`、`docs/rpc.md` 与
  `dist/modes/rpc/rpc-mode.js`：get_available_models 与 set_model 使用运行进程的
  getAvailableSnapshot；官方交互模型选择器则刷新它自身的 modelRuntime。
  [固定版本源码](https://github.com/earendil-works/pi/tree/v0.84.3/packages/coding-agent)
  与安装依赖版本对应。采用其以当前运行目录作为选择依据的做法；Farfold 的 SDK bridge 和
  Pi RPC 是不同进程，因此沿用现有 Host stop/open 重新加载同一持久绑定，不修改 Pi 或另建循环。
- **源码修订**：抽出 `pi-model-selection.ts`，先查询原生已加载模型；目标缺失时通过现有
  会话生命周期重新加载，再读目录核对目标后才发送 set_model。不把已认证、SDK 已列出、
  Runtime 已加载或真实请求成功合成一个状态。选择器标明“重新加载并使用”，把错误留在弹层，
  对模型／默认模型／思考选项的重复操作和拒绝进行处理；重载期间阻断冲突的界面操作。
  原有直接 set_model 路径已被替换。默认模型与历史会话模型仍分开，不重发旧输入。
- **自动化**：新增 4 项行为回归覆盖原生目录身份、已加载无需重启、重载后再验证、重载失败或
  模型仍缺失时不发送选择请求。首轮前端为 152 通过／2 失败（共 154），失败均是 SDK probe
  10 秒进程超时；当时 Rust 正在完整编译，进程采样显示多应用和 rustc 高 CPU。负载是可能因素，
  不能据此认定唯一根因；不提高超时阈值，保留原输出并在编译后复查。
  Rust 235 项通过（6.57 秒），all-targets clippy、typecheck、cargo fmt 通过。
  全仓格式检查仍仅报告既有 reports/ 下 5 个文件。原始输出 model-reload-*.log 保留在
  src-tauri/target/opencode-protocol-audit/；当时最新源码安装验证尚在进行，后续结果见下。

- **安装重载复验（303d39）**：完整 Dev bundle 已安装并通过严格签名检查，可执行 SHA-256
  `303d390447e51b28f969128da6c490aa1708984185ff6d1ec6c02245f1108546`。
  为重现运行目录缺少新模型，仅在私有 QA 中临时选择内置 GLM-4.7（未发送该模型请求），
  暂时取出 Air 自定义项；Dev 60990 续接后 Pi 61016 已运行，再恢复原始 Air 配置并刷新 SDK。
  实际选择器显示“重新加载并使用”（截图 24）；点击后子进程变为 61093，模型变回 Air，
  无需退出桌面应用。Host 两路绑定／原生 ID／Working Copy／标题／草稿与操作前完全相同，
  配置文件恢复为原始内容，Pi 默认模型仍为 Air。截图 25 保存重载后同会话状态。
- **检查复核**：编译后不修改阈值重跑前端，38 文件／154 项全部通过（16.67 秒）；保留首轮
  两个超时，不把后一次通过写成从未失败，也不把检查用时视为产品 p95 性能。
  相关代码与计划格式检查通过；5 个既有 reports/ 格式问题仍未改动。
  当前检查覆盖模型重载切片；不因此关闭完整 P1—P3 或交付一。
- **同一新构建真实任务复核（303d39）**：Pi 与 OpenCode 均通过安装 Dev 界面，在上述原生
  会话中使用 GLM-4.5-Air 读取 input.txt、运行 Python 写入并断言 verified-303.txt、再原生读回。
  独立读取两份产物均为精确字节 `34 32 0a`，与原生工具记录对应。OpenCode 中途一次 read
  返回文件未找到，后续检查与读回成功；界面保留“有步骤失败”，不能记为所有步骤一次成功。
  截图 26、27 保存两路结果，截图 28 覆盖 900×620 模型选择器。最终再次核对安装摘要、两路
  持久身份、标题和恢复后的草稿，Pi 默认模型为 Air。此次任务不作为新一轮并发、三次冷启动或
  20 次性能采样验收。已核对并删除仅用于本次安装替换的旧 Dev app 备份，配置、数据和证据保留。
  共同 Provider 配置、完整恢复与原生干预回归仍待后续切片，Codex P4 稳定接口阻断不变。

#### 2026-09-08 共同 Provider 设置容器切片

- **设计依据**：对照 [W3C 原生模态 dialog 实践](https://www.w3.org/WAI/WCAG22/Techniques/html/H102)，
  采用浏览器管理模态焦点与背景不可操作的机制；认证提交中是否允许关闭由 Runtime 设置组件决定。
  固定 Pi 0.84.3 ModelRuntime 的 getProviderAuthStatus／login 与现有 bridge 保持认证权威；
  OpenCode 1.15.13 仍通过已有官方 `/provider` 与 `/auth/{id}` 路径查询及修改。
  [OpenCode Provider 说明](https://opencode.ai/docs/providers/)仅供整体信息组织参考，未据在线目录增加原生能力。
- **源码切片**：两路使用同一 ProviderSettingsDialog 和 ProviderCatalog，统一标题、刷新入口、
  服务搜索、空结果与焦点行为。删除 Pi 自写的全局焦点循环和两路重复弹窗／服务列表实现。
  状态文字由原生适配组件提供；公共列表不将条目存在或 connected 推断成保存凭据／请求成功。
  OpenCode 增加当前服务定位、显式刷新及目录读取失败重试；Pi 保留 OAuth／API key／自定义模型、
  指定模型主动验证与取消登录。没有修改原生认证协议，也没有把 OpenCode 的 OAuth 标为支持。
- **检查进行中**：前端 38 文件／154 项通过（6.96 秒），typecheck 与完整 Dev build 通过。
  安装界面的搜索、键盘、焦点、取消与小窗口操作尚在复验；此处不关闭 P1—P3 或交付一。
- **安装发现与追加修订**：中间构建 b593ff 的搜索／空结果可用，但 macOS 鼠标打开设置时
  activeElement 并非入口按钮，关闭后焦点落回页面；恢复可用原焦点，否则定位当前设置入口。
  12dd5c 安装复验确认关闭按钮返回入口，但搜索框内 Escape 未关闭对话框；已按现场行为增加
  明确键盘处理，并保留输入法组合状态与认证进行中的关闭限制。这两项属于本轮迁移后发现的问题。
  自定义模型说明同时移除错误的默认 `~/.pi/agent/models.json` 路径，改为当前 Farfold 环境。
- **原生取消证据**：b593ff 中点击 Pi 原生 API key 登录再取消，主界面出现普通 aborted 错误。
  固定 SDK 的 AbortSignal 与桥接响应核对后，仅当失败原因与本次 controller.signal.reason
  是同一对象时附加取消标记；凭据同步失败等其他错误仍保留失败，不依靠英文错误内容分类。
  新原生 SDK 测试先失败（缺少 cancelled），修复后通过；同时核对另一并发登录被拒绝且不被
  标为取消、临时目录未保存凭据，并在成功／失败后回收目录及进程。前端两项测试确认只有
  明确原生标记才映射为取消。没有修改 Pi Runtime，也没有以取消请求确认代替原登录结果。
- **追加检查**：前端 39 文件／157 项通过（9.75 秒）。全仓格式检查仍仅有原先 reports/ 的
  5 项问题；本切片文件格式通过。本切片没有 Rust 源码变化，不把上一轮 235 项结果记作本次新跑。
- **最终安装复核（f86bd8）**：完整 Dev 可执行摘要
  `f86bd8671c619f00ecbb1a1d21c1aa686a81baac36c43294790610f58e1cfb75`，严格签名通过；
  安装 bridge 与当前源码逐字节相同。最终键盘改动后前端 39 文件／157 项通过（19.96 秒），
  typecheck／构建及本切片格式通过。实际安装中两路搜索框 Escape 均关闭并回到设置入口；
  Pi 原生登录的空密钥提示、进行中防误关及显式取消通过，取消后不再出现普通失败提示。
  OpenCode 当前服务定位、搜索／空结果、原生目录刷新、空密钥禁用保存均已实际操作；
  目录读取失败重试路径尚未做安装故障注入。900×620 两路设置界面见截图 29、30。
- **同构建真实任务**：两路经 UI 续接原会话，用 GLM-4.5-Air 原生 read 读取 verified-303.txt，
  分别返回 PI-SETTINGS-READ-OK／OPENCODE-SETTINGS-READ-OK。Pi read 条目 e8e3a2af
  输出 `42\n`、最终条目 bf3f3b0d；OpenCode 原生 read 的 message 为
  msg_07f426c69001gvKBt3LJO4y6rh、status completed，最终 message 为 msg_07f42830d001l1UWca5nxqGSy6。
  独立文件字节仍为 `34 32 0a`。两路标题／持久身份／Working Copy／恢复后草稿与切片前完全相同，
  私有认证文件摘要未变化，正式应用摘要仍为 26b741…。截图 31、32 与忽略目录中的
  provider-settings-installed-result.json 保存对应结果。本轮没有重存／删除真实凭据，
  不据此宣称完整 OAuth／认证保存、三轮冷启动、并发或性能验收通过。
- **下一切片**：继续会话激活与 Pi 控制器迁移。另在 900×620 的 Pi 未启动首屏观察到
  继续／新建区域位于输入区下方，尚未核对所有滚动与键盘到达方式，需单独复现和修订。
  共同设置切片不代表整个开工页面或 P1—P3 完成；Codex P4 阻断不变。

#### 2026-09-08 Pi 会话激活与短窗口开工切片

- **复现与分类**：在 f86bd8 安装 Dev 的 900×620 窗口，开工页初始滚动位置看不到
  “继续对话／新建 Session”；向下滚动后两按钮可见。截图 33、34 分别保留初始与滚动状态。
  这是入口可见性问题，不是无法启动或不可滚动；普通桌面窗口原本可见。
- **行业与官方依据**：参考 [W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
  的重新排列而保留信息／功能原则，仅在短窗口压缩开工页的装饰与留白，项目资源详情继续在原区域滚动。
  这不等于声称完整 WCAG 合规。参考 [ACP 会话建立与恢复](https://agentclientprotocol.com/protocol/v1/session-setup)
  分开新建与按原生身份加载、明确 cwd 的做法；仅采用职责划分，不引入 ACP 方法或假设 Pi 支持 ACP。
  核对固定 Pi 0.84.3 分发中的 docs/rpc.md：new_session 可由原生扩展取消，get_state 提供
  sessionId／sessionFile；本仓 Host 的 create_native_session、verify_pi_target 仍负责实际原生结果。
- **源码变化**：Pi 新建、打开、Working Copy 切换、信任选项重启及配置加载后的重启，共用
  pi-session-activation 的 Host 调用顺序；删除 App 中对应重复停止／打开／投影路径。
  同 Working Copy 新建仍可使用现有 Pi 进程，由 Host 判定；打开持久绑定先确认旧进程已停止。
  只在 Host 返回绑定与 Runtime 状态的安装、原生 ID、工作目录、generation 对应时加载历史。
  旧代次、停止未确认或原生恢复失败不触发新建回退。自定义 Provider 保存前先要求可恢复的 Host 绑定。
  Working Copy 运行中切换不再提前把尚未启动成功的目录写入页面选择。
  现有任务准入、草稿保存、Native Session 与进程身份权威保持原位置，未新增调度器或数据库 schema。
- **检查**：typecheck 通过；前端 40 文件／174 项通过（22.25 秒），其中新增 17 项覆盖激活失败与身份边界。
  Rust fmt 和全目标 clippy 通过。全仓 format:check 仍只有此前 reports/ 的 5 项问题。
  安装候选构建与真实 UI 复验进行中；本节暂不关闭 P1—P3 或交付一。
- **同一安装候选复核（bfec4f）**：完整 Dev 可执行摘要
  `bfec4f9e3f713757f623f2dd8696820ca2e62223397ffba8544d49383ea6f90f`，完整构建与严格签名通过；
  安装 bridge 与当前源码字节一致。Rust 本轮 235 项通过（5.50 秒），不是沿用历史数量。
  两路 900×620 初始开工页均能直接看到继续／新建按钮，并从可见按钮实际恢复；
  Pi 展开准备信息后可滚动访问完整路径、资源说明和策略。常规 1199×768 画面也已观察。
  截图 35、36、40 对应短窗口与展开信息，没有宣称全部宽度、键盘或可访问性验收完成。
- **Pi 恢复与新建**：bfec4f 中连续三次冷启动，经 UI 继续同一原生 Session
  `01a07bcf-6ee7-775e-b323-d88de6e0b6ff`；每次 Host ID、标题与草稿完全一致，历史包含
  PI-SETTINGS-READ-OK。三次原生 JSONL 均为 41 条、末条 bf3f3b0d，未重放旧请求。
  随后真实 read 产生条目 23fbca9c、输出 `42\n`，最终 ac104794 为 GLM-4.5-Air／stop。
  同进程新建时 Pi PID 70307 不变，新原生 ID 为 `01a07f56-b86f-77f6-a05d-25be89b6dd7e`；
  标题明确设为 QA Pi 激活迁移 0908，新会话 read 条目 4c38b718、最终 011811db。
  切回旧会话后原草稿与历史恢复，原生进程换为 70435；新 QA 会话随后按现有规则打开并归档，
  原生记录保留。尝试直接归档另一条 Pi 会话时收到现有限制提示，未将该次操作记为归档成功。
- **OpenCode 与文件交叉核验**：原生 Session `ses_f842d7aa8ffettDeS21jkFeS0F` 使用
  GLM-4.5-Air 真实 read verified-303.txt，message msg_07f59d432001p4aTb02dMo8AG8、
  part prt_07f59efbd001OGaVg3pReaABiC 为 completed，实际绝对路径在 opencode QA Working Copy；
  最终 msg_07f59f01c001YFJGkHJ7m57fqd 为 stop，界面为 OPENCODE-ACTIVATION-READ-OK。
  两路文件字节仍为 `34 32 0a`，原标题／Host 与原生身份／Working Copy／恢复后草稿不变，
  认证文件摘要未变。证据位于忽略目录 activation-installed-result.json 和截图 37—39。
  正式应用摘要仍为 26b741…，未替换日用应用或改动默认 Runtime 环境。
- **独立复核后的边界**：本切片完成上述源码迁移和安装场景，不关闭 P1—P3 或交付一。
  停止失败及错误代次通过行为测试验证，没有将其记成安装故障注入；本构建未执行
  三路并发、全量原生干预、性能 20 次采样或人工验收。Codex P4 稳定用户提问接口阻断不变。
  另在从 Pi 导航到 OpenCode 的一次启动瞬间观察到旧 Pi 路径短暂显示，加载完成后正确显示
  OpenCode 目录；实际本次 read 位于正确目录。源码中 initialProjectPath 在打开返回后才更新，
  后续需针对待激活目标的标题／目录／草稿显示统一复现和修订，不能把此观察扩大为实际错目录执行。

#### 2026-09-08 会话切换目标信息切片

- **重新复现**：bfec4f 冷启动停留在 Pi 开工页，直接点击 QA OpenCode 保留身份，
  启动瞬间标题变为 OpenCode，Project／Working Copy 和输入区下方仍显示 Pi 目录。
  截图 41 与 opening-before.ax.txt 保留本轮原始观察。恢复完成后实际绑定与目录正确，
  不据此宣称 Runtime 在错误目录执行。
- **根因与参考**：全局项目选择通过 initialProjectPath 进入 OpenCode 页面，目标会话打开返回前
  缺少独立的显示状态。参考 [React 官方派生状态实践](https://react.dev/learn/you-might-not-need-an-effect)，
  目标显示在 render 中由当前请求与 Host 绑定直接计算，避免等 effect 更新后才纠正旧信息。
  草稿显示按会话身份对应，不能在身份改变后的首帧继续展示旧值。未采用重挂整个 Runtime
  工作台的方式，避免把原生连接与恢复控制作为 UI 重置的副作用。
  对应官方依据仍是固定 Pi 0.84.3 的 get_state／get_messages 和固定 OpenCode 1.15.13 的
  requireSession／messages 路径；本地已核对 session handler 先按 Session ID 查找，不把新建当作加载。
- **源码切片**：两路共用 SessionOpeningPanel 与类型化目标描述。用户点击后的标题、完整目录、
  导航高亮来自待打开的 Host 目标，状态明确为正在打开／新建；尚未取得匹配 Runtime 和 Host ID
  时只显示正在核对，不借用另一会话。此时旧模型、历史、草稿及详情不参与目标显示，输入禁止提交。
  成功后沿用原有 Host 绑定及历史加载；失败后退出该显示状态，保留原错误和持久资料，不增加重试、
  新建回退或另一套生命周期。共享草稿 hook 保留同步 Host 写入及迟到读回检查，仅增加显示身份匹配。
- **当前检查**：typecheck 通过，前端 41 文件／180 项通过（8.17 秒），新增 6 项目标显示测试。
  全仓格式仍只有此前 reports/ 的 5 项问题。本轮未改 Rust，前一切片 235 项不记为本轮新跑。
  安装构建和真实切换／缺失会话的失败复验进行中，尚不关闭 P1—P3。
- **中间安装复验与补充**：ae7e69 通过正常目标切换，但缺失原生记录时仅显示内部代码。
  随后补上失败目标名称；仅对当前 Host 的确切 native_locator_unavailable 错误说明恢复原记录，
  其他错误保留实际原因。最终前端 41 文件／182 项通过（9.05 秒），typecheck 与本切片格式通过。
- **最终同构建安装复核（0952d7）**：可执行摘要
  `0952d70be04962e620132c841a6845dd0107b1c1d559de34530e3e1999a4dedf`，完整 Dev build、严格签名通过，
  安装 bridge 与当前源码字节一致。Pi／OpenCode 切换时目标标题、目录、禁用输入和加载状态
  实际对应，完成后原 GLM-4.5-Air 与草稿恢复；常规窗口与 900×620 的目标面板见截图 46、47、49。
- **缺失记录失败与恢复**：仅临时移开上一切片的 QA 原生 Session
  `01a07f56-b86f-77f6-a05d-25be89b6dd7e` 文件。点击打开后明确提示
  “打开「QA Pi 激活迁移 0908」失败：找不到原生会话记录”，退出加载状态；原会话与草稿仍在，
  Host 仍为原 3 条 Session，没有新建替代。原文件逐字节恢复后，同一原生 ID 与原历史
  PI-NEW-SESSION-READ-OK 成功加载。该 QA 会话重新归档，临时 hold 文件不存在。
  截图 45、opening-final-failure.json 保留失败证据。此试验只证明该原生记录缺失路径，
  不扩大为所有异常退出／网络故障或跨 Runtime 恢复验收。
- **真实任务与反向核对**：两路均在最终安装候选用 GLM-4.5-Air 原生 read 读取各自
  verified-303.txt，实际内容仍为 `34 32 0a`。Pi 工具条目 05efc12f、最终 15ef8d4d／stop，
  显示 PI-OPENING-READ-OK；OpenCode read message msg_07f709706001txJkaTCE6rOh4q、
  part prt_07f70b946001xi6zwjLFH01i15 为 completed，最终 msg_07f70b981001300XMnApzOTQrQ／stop，
  显示 OPENCODE-OPENING-READ-OK。原有两路标题、Host／原生身份、Working Copy、草稿与认证摘要
  均和切片前一致；用于故障试验的第三条 QA 仅重新归档时间变化。截图 48、50 和
  opening-installed-result.json 对应实际输出。正式应用摘要仍为 26b741…，未改日用环境。
- **退出边界与后续**：本轮目标显示及已列安装场景完成，P1—P3／交付一仍未整体验收完成。
  最终候选有一次 OpenCode 打开等待较长，期间一直显示正在打开，之后恢复成功；没有精确分段采样，
  不推断是 Provider、Host 或渲染造成，也不计为性能达标。下一步按既有性能 trace 分开核对
  Runtime 启动、模型目录和历史恢复，继续剩余同构建干预、并发、冷启动与恢复验收。
  之前 bfec4f 的 Pi 三次冷启动不沿用为 0952d7 的三次证明。Codex P4 阻断及人工验收边界保持。

#### 2026-09-08 Runtime 检测阻塞与恢复分段计时切片

- **测量起点**：上轮未计时的长等待仍是待解释观察。本轮先在 f27eef 安装候选加入
  启动／原生核验／模型目录／历史读取分段计时，两个冷进程样本的 OpenCodeStart 为
  5700.1／6009.3ms，Verify 为 802.1／1175.0ms，Providers 为 1074.8／1260.7ms，
  History 为 31.5／33.3ms；未复现 20 秒等待。两个样本采集时有构建或测试负载，
  仅用于定位，不作为正式 20 次性能采样或发布性能结论。
- **实际问题**：同两次启动的 ShellReady 分别 2951／3176ms，其中前端就绪至绘制机会
  等待 2438／2668ms。源码确认两路 runtime_discover 同步执行程序摘要、版本子进程和
  Host 登记，阻塞命令处理线程。不要把该问题扩大为全部 Runtime 启动时间的唯一成因。
- **一手依据与取舍**：核对 Cargo.lock 对应 Tauri 2.11.5 的 async_runtime.rs
  spawn_blocking，以及 tauri-macros 2.6.3 的 command/wrapper.rs：同步包装直接调用，
  异步包装提交异步响应。采用官方阻塞工作执行器，保留原来的摘要／版本验证和登记结果，
  无缓存绕过、默认成功或第二套检测入口。
  同时复核 OpenCode 固定官方树 385cb694419f98103af0e8fc6187ddcbcbb6eecb 的
  cli/cmd/tui/context/sync.tsx 与 session handler，两个本地文件均匹配 Git blob 摘要。
  原生客户端按端点区分启动依赖及失败；Farfold 采用同样的职责区分来测量，
  暂不照搬并行目录／历史加载或原生 UI。外网文档读取本轮失败，以上依据来自已固定的官方源码。
- **实现**：两路公开检测命令改为 async＋spawn_blocking，完整校验完成才返回 descriptor。
  沿用 FARFOLD_PERF_TRACE 主动开启的本地计时，仅增加固定操作名、单调时钟耗时、结果布尔值，
  与现有绘制样本共用 4096 条上限；不写参数、返回内容、错误文本、路径、身份或凭据。
  OpenCode 启动进一步区分安装校验与子进程健康就绪，单次重试失败也保留计时结果。
  HostSessionOpen 包含控制锁等待、准入、绑定及导航，子阶段是其子集，不能相加重复统计。
- **最终安装候选**：`618ff50c007837417388266c5c2463041fb9f379c4252baf9aefec467334adb9`，
  完整 Dev build、安装副本与 staged 摘要一致，严格深度签名通过。最终源码 typecheck、build、
  cargo fmt、全目标 clippy 通过；前端 41 文件／182 项通过，最终 Rust 235 项通过（4.47 秒）。
  全仓 format:check 仍是 reports/ 的 5 个既有文件，本切片计划格式与 diff 检查单独通过。
- **三次同构建冷启动**：进程 81280／81706／83832，均按原 OpenCode 原生 ID 续接，
  模型 GLM-4.5-Air、标题、Working Copy 和保留草稿对应；三次结束后的原生历史摘要与首次一致，
  47 条消息／157 个条目，没有重放旧输入。原始证据 timing-final-cold-1/2/3.ax.txt、
  timing-final-cold-result.json 与 timing-installed-final.log。

  | 同构建样本              | 界面就绪 | 绘制等待 | 侧栏就绪 | 安装校验 | 子进程就绪 | Runtime 就绪后恢复 |
  | ----------------------- | -------- | -------- | -------- | -------- | ---------- | ------------------ |
  | 1（clippy 负载）        | 722ms    | 47ms     | 62ms     | 1607.8ms | 1667.0ms   | 2618ms             |
  | 2（Rust 测试负载）      | 760ms    | 52ms     | 88ms     | 3351.4ms | 4755.8ms   | 5197ms             |
  | 3（本轮编译测试已结束） | 469ms    | 41ms     | 47ms     | 2342.3ms | 1876.8ms   | 2094ms             |

  所列三次绘制样本 visible／focused 为真、visibility_changed 为假。较慢样本保留；
  “本轮编译测试已结束”不代表整台机器无其他负载。样本只验证本切片和定位，
  不能代替候选正式 20 次／p95 验收。Runtime 就绪后恢复 2 秒目标仍未通过，
  也未找到上轮超过 20 秒观察的确切原因。完整性检测仍在执行，不能将前端提前响应宣称为 Runtime 已就绪。

- **真实任务与独立反查完成**：两路在最终安装候选均用 GLM-4.5-Air 原生 read 读取各自
  verified-303.txt，实际字节仍为 `34 32 0a`。OpenCode 工具 part prt_07f84e947001Gkk7HuZ5H7QiYg
  为 completed，最终 msg_07f84e97c001kEui61uzJBZGwI／stop 显示 OPENCODE-TIMING-READ-OK。
  Pi 调用 a41091df 与工具结果 f7b71c55 的 toolCallId 对应，读取相对路径 verified-303.txt；
  最终 385c193f／stop 显示 PI-TIMING-READ-OK。截图 51／52、timing-final-installed-result.json
  对应 UI 和原始数据。原有三条 Host 记录的身份／标题／Working Copy／归档／草稿与切片前一致，
  两路认证和 QA 文件摘要未变；安装 bridge 与源码字节相同。正式应用仍为 26b741…，未改日用环境。
- **幻觉复核纠正**：当前 Pi 页面没有调用 piRuntimeAdapter.discover，不能把 Pi 检测接口的
  后台迁移说成已经验证了 Pi 首屏加速。实际冷启动加速证据属于 OpenCode 页面，Pi 本轮仅有
  同构建恢复与真实读回回归。后台检测完成的 descriptor 也不等于 Provider 请求或任务已经成功。
- **退出与后续**：本切片修复并验证了 OpenCode 检测阻塞界面，补齐可复用的阶段计时。
  仍待正式可比较环境 20 次性能采样、恢复耗时进一步分析，以及剩余干预／并发／恢复场景；
  不关闭 P1—P3 或交付一。源码迁移保留唯一命令实现，未增加旧路径回退。
  未取消完整性检查、升级 Runtime、修改模型／权限；Codex P4 稳定接口阻断与人工验收边界保持。
  0952d7 应用与 timing-host-backup.sqlite3 为本次唯一成对恢复点，最终候选运行于独立 Dev 环境。

#### 2026-09-08 OpenCode 旧会话按原生 ID 核验切片

- **从耗时排查发现的实际缺陷**：恢复、注册绑定、发送前验证和事件缺口重建，先前都用
  GET /session 列表查找既定原生 ID。官方 v1.15.13 默认按更新时间降序返回 100 条，
  因此旧会话会被误判为不存在。这是 P3 恢复正确性问题，不能当作单纯性能优化。
- **固定一手依据**：本轮重新取得官方 v1.15.13 tag，指向
  385cb694419f98103af0e8fc6187ddcbcbb6eecb；下载 session/session.ts 并核对 Git blob 摘要。
  [固定版本 Session 源码](https://github.com/anomalyco/opencode/blob/385cb694419f98103af0e8fc6187ddcbcbb6eecb/packages/opencode/src/session/session.ts)
  的 listByProject 默认 limit=100；get 按 ID 精确读取，缺失返回 NotFound。
  成熟实践参考同版本 cli/cmd/tui/context/sync.tsx 的 session.sync：已知目标调用
  sdk.client.session.get，而非用列表证明存在。本轮只采用按 ID 读取，保留 Farfold 自有界面、
  Host 准入与 Working Copy 排他，不照搬原生客户端 UI 或另建分页发现系统。
- **复现与证据层次**：独立临时环境实际创建 101 条原生空会话，列表为 100 条、最旧 ID 缺席，
  但单独读取原 ID／目录正确。session-limit-probe.json 记录结果，进程与临时目录已释放。
  初期探针用了 macOS 临时路径别名，列表为 0；修正为实际 canonical 路径后才形成 100 条边界证据。
  另一次探针健康读取超时，未计为成功。没有 Provider 调用或模型切换。
- **安装对照**：仅在独立 Dev 原生数据中，通过官方 API 创建并逐条登记 100 个临时空会话。
  原 QA ID ses_f842d7aa8ffettDeS21jkFeS0F 此时在列表之外，但按 ID 可读。
  旧安装 618ff5 打开失败，显示 bound native Session unavailable；原有 3 条 Host 绑定、标题、
  Working Copy、归档和草稿均未变。截图 53、direct-session-before.ax.txt 与 direct-session-qa-seeded.json 对应。
- **实现与旧路径删除**：统一 read_session 调用 GET /session/{id}，校验合法 ID、返回 ID 一致、
  实际 canonical 目录匹配，保留其他原生字段。打开与发送前核验、绑定注册、状态重建都经过它；
  404、错误身份、错误／缺失目录均失败，不创建替代会话，不回退列表或自动批准。
  状态重建证据源从 session.list 改为 session.get。确认已无工作台调用后，删除旧公开
  opencode_session_list 命令、Tauri 登记、前端列表解析与其孤立测试，同时删除重复查找与身份解析。
  未增加第二条公开原生调用入口，不绕过现有 Host 身份与目录权威。
- **针对性回归**：先保留旧列表行为运行缺页回归，实际失败为 Bound Session absent from discovery list；
  然后切换单会话读取，通过相同测试。新增覆盖未知字段保留、错误 ID／目录／缺失元数据、
  canonical 别名、404 不回退、非法路径输入在网络前拒绝。临时目录使用 RAII 自动释放。
  direct-session-red.log／green.log 保存实际输出；绿色筛选运行 4 项，其中含已有匹配测试。
- **最终候选安装验收**：最终 Dev 可执行摘要
  af1b99da51349d6a8343221bb47b328d4108f59da057e67b08695ba260bd4909，安装与 staged 一致、严格签名通过。
  列表之外的原会话已在此候选恢复 GLM-4.5-Air、历史与保留草稿；恢复检查点仍有 100 条更新会话。
  截图 54、direct-session-after.ax.txt 对应。原会话随后成功通过发送前核验，原生 read 工具
  prt_07f968745001wKQzfaXjagEQet 为 completed、实际文件内容为 42；最终
  msg_07f9687a8001ebTGUvVgj7w3VV／glm-4.5-air／stop 显示 OPENCODE-DIRECT-SESSION-OK（截图 55）。
  Pi 同构建回归的调用 03fa1cca 与工具结果 5febb537 的 toolCallId 对应，read 返回 42\n，
  最终 c9a83454／glm-4.5-air／stop 显示 PI-DIRECT-SESSION-REGRESSION-OK（截图 56）。
- **清理后续接与反向检查**：100 条临时会话逐条按已登记 ID、标题前缀、canonical 目录核对后，
  经官方 DELETE 接口删除；数据库反查剩余为零。清理后同候选另外两次冷启动原会话正常，
  三次 Dev 进程为 87092／89767／89940；首次在列表外恢复，后两次验证清理后的正常恢复。
  真实任务后的原生历史始终为 53 条消息／177 个条目，两个后续冷启动没有重放或改写历史。
  原有全部 3 条 Host 身份、标题、Working Copy、归档和草稿与切片前一致；认证、QA 输出文件摘要
  未变，安装 bridge 与源码字节相同。direct-session-installed-result.json 与 post-cleanup／cold-3
  AX 记录对应。正式应用仍是 26b741…，日用环境未改。
- **最终检查**：前端 41 文件／181 项通过（删除旧解析器的一项孤立测试），Rust 237 项通过
  （3.28 秒）；typecheck、完整 build、cargo fmt、全目标 clippy、本切片格式与 diff 检查通过。
  全仓 format:check 仍只有 reports/ 的 5 个既有文件，不报告全仓格式通过。
  新增回归先红后绿，删除原有只查列表的身份断言后，由更严格的原生 ID／目录断言替代。
- **性能与完成边界**：三次 Runtime 就绪后恢复为 2075／1848／1733ms；首次有本轮测试负载，
  后两次本轮编译测试已结束。全部样本保留，不因后两次较快宣称 p95 通过；
  这不是正式可比较环境 20 次采样，也未解释此前偶发 20 秒等待。
  本切片关闭已复现的旧会话误判与相关安装回归；P1—P3／交付一仍待其余验收，
  Codex P4 稳定接口阻断与人工验收边界不变。后续继续模型目录与恢复耗时核对及剩余原生干预、
  并发、异常恢复场景，不通过跳过身份或安装检查换取较短数字。
- **恢复点**：保留 618ff5 完整应用，以及新增临时记录前的 Host／OpenCode 原生 SQLite 备份。
  离线副本能正常打开并通过 quick_check；这不冒充本轮执行过完整应用降级。
  已核对并淘汰被替代的 0952d7 QA 应用／Host 备份，未删除当前应用、日用资料或原生会话。

#### 2026-09-08 持续开发前的 P4 决策门槛复核

- **当前事实**：重新解析本机 npm 入口并读取版本，仍为 Codex CLI 0.143.0；入口摘要为
  `d3be844c45c4fd89392536e56e1010963f94785592596b50cd0c45bb8a341406`，实际启动的
  arm64 原生程序摘要为 `9070e47d422129106bc41ca651a9998b06a6c55bd42a7c3362b48f1d2850766f`。
- **独立实测**：在临时 HOME、CODEX_HOME 和项目目录启动自有 stdio App Server，文件式认证、
  `experimentalApi=false`，未继承认证变量。initialize 成功，account/read 返回 account=null；
  带 Plan collaborationMode 的 turn/start 被参数门槛拒绝，返回 -32600
  `turn/start.collaborationMode requires experimentalApi capability`。
  experimentalFeature/list 再次返回 default_mode_request_user_input 为 underDevelopment、
  enabled=false、defaultEnabled=false。没有接受模型轮次或发出 Provider 任务；自有进程已退出，
  临时环境已删除。原始结果保存在本地忽略目录
  `src-tauri/target/codex-protocol-audit/stable-question-recheck-20260908.json`。
- **源码与行业依据**：再次核对固定版本 config_types.rs 的 allows_request_user_input 仅允许
  Plan，tool_config.rs 仅在上述开发中特性打开时加入 Default。
  [官方 App Server 说明](https://learn.chatgpt.com/docs/app-server)也明确实验字段须 opt-in，
  并将工具提问列为实验能力；在线文档只佐证当前说明，目标版本判断以本轮程序返回及固定源码为准。
- **待用户决定**：保持既定稳定接口边界则 P5 继续暂停；如要继续验证该版本的完整原生提问流程，
  需明确允许 Codex 实验 API，再验证 Plan 模式中的原生提问。允许实验 API 不等于允许启用
  Default 的开发中特性，也不等于真实提问、认证或安装应用已验收。尚未修改版本、开关或验收范围。
  Pi/OpenCode 交付一不受此门槛阻断，其余工程工作与安装验收仍待完成。

#### 2026-09-08 用户批准实验 API 例外与原生提问协议复验

- **用户决定**：批准固定 Codex 0.143.0 开启 experimentalApi，先验证 Plan 模式原生提问。
  Default 的 default_mode_request_user_input 特性保持关闭；没有批准升级 CLI、改变权限默认值、
  导入其他环境令牌或开放其他实验能力。AGENTS、PRODUCT 和本计划活动条款已同步，前面的
  稳定面阻断记录保留为历史证据。
- **行业依据与采用部分**：参照固定版本官方
  `app-server/tests/suite/v2/request_user_input.rs` 的原生 App Server 加本地 Responses fixture
  测试方法，以及同版本 ToolRequestUserInputParams/Response schema。仓库许可为 Apache-2.0；
  本轮编写独立的 Python 标准库探针，不引入上游实现或新增第三方依赖。
- **事实**：`scripts/codex-question-probe.py` 在相同摘要的真实原生程序上运行通过。
  experimentalApi=false 时仍有预期拒绝；true 时获得 Plan 目录、真实 item/tool/requestUserInput，
  threadId/turnId/itemId 与当前线程和轮次一致。回复按 question ID 编码后，原生
  serverRequest/resolved 先于 turn/completed，下一次 Provider 输入包含原答案。
  同一 CODEX_HOME 冷启动后按原 ID 恢复，历史轮次身份和 cwd 一致；第二次等待提问时中断，
  原生终态为 interrupted，迟到回复没有恢复执行。本次共 3 个本地脚本化 Provider 请求。
- **证据边界**：该探针验证真实 Runtime 的协议行为；模型响应由 loopback fixture 提供，
  不是真实模型自主提问、Farfold UI 回复、账号认证或安装核心验收。没有接受实验开关便直接
  将用户提问标记为可用。原始结果在忽略目录
  `src-tauri/target/codex-protocol-audit/approved-question-probe.json`，临时 HOME/CODEX_HOME、
  测试服务和自有 App Server 都已清理。后续继续真实账号与安装应用链路。

#### 2026-09-08 Codex 程序发现与检查切片（安装复核进行中）

- **实现**：Host 后台只读发现／检查入口，支持常用位置和有界 nvm 安装目录；canonical 路径
  去重，多候选由用户选择。手动文件选择复用系统面板。不遍历项目、加载 shell 或依赖 PATH。
  固定主程序／npm launcher 摘要先于执行；npm 显式定位 arm64 Node、原生依赖和包元数据。
  同时核对 package.json 摘要，避免模块导出重定向改变真实启动目标。--version 使用空继承环境
  与临时 HOME/CODEX_HOME，5 秒有界等待，检查前后重复核对程序与依赖；不写用户安装。
- **官方分发补核**：从同一固定 GitHub release 下载并校验、未安装：独立 arm64 archive
  SHA-256 `7df2384f037519dff7dbf4252e60913a5c1c7fdb66c1467c9125b2b2d3594a86`，
  其中主程序与 npm arm64 包为同一 `9070e47d…`；npm launcher archive 摘要
  `d8763cc089e94e2612cb34f947582735dbcbe6e983468cf86beb1a8c5847d84c`，launcher 和两种
  package.json 摘要与本机一致。npm 的 code-mode host、rg、zsh 和布局元数据均与官方包逐一比对。
- **独立源码复核发现并修订**：固定 install-context/src/lib.rs 会从 canonical bin 路径及
  codex-package.json 发现包布局，即使直接选择原生二进制也仍加载这些资源。该选择路径补充
  相同资源核验；不将它错误登记成只有一个文件的独立程序。
- **UI 范围**：公共 Runtime 选择器增加“Codex（接入准备）”，复用设置对话框和焦点恢复。
  找到文件、程序检查通过和账号／任务能力分开展示；关闭后保留原 Runtime、会话和草稿。
  当前检查结果只用于本次设置页面，尚未登记为可启动安装，不新增 schema 或空会话。
- **测试过程**：基础 3 项行为测试通过；需要实际安装的 2 项测试显式标为 ignored，并以指定
  本机路径单独执行。首轮实际 npm 及空格／移动／依赖／替换测试通过；追加直接二进制分支后，
  fixture 的 /var 与 /private/var 字符串前缀断言失败，原始失败日志保留。临时根路径 canonicalize
  后重跑；最终结果以随后记录为准。失败只在副本操作阶段，TempDir 按 unwind 释放。
- **安装阶段记录**：中间 QA 构建 `8ed1e9d160823bba10cdb5f53ca1a91bfbf467aa80310203355da23af6c2b8c6`
  已实测 npm 检测与版本／摘要展示、非程序 PRODUCT.md 拒绝、Escape 返回原 OpenCode 与草稿，
  焦点回到 Runtime 选择器。该构建尚未包含最后的直接二进制资源补检与间距修订，不沿用为最终验收。
  截图 57/58 位于 `.design-qa/2026-09-07-runtime-workspace/`。
- **本切片最终复核**：安装 QA 构建
  `5dc73198213e88dca88da7e79a5f858c2e5e82b9b7c501f9a1706cb86e50aff7` 与 staged 主程序
  一致，strict/deep 签名检查通过。最终安装应用完成 npm 候选检测／校验（显式 Node、6 个
  附属文件）、直接选择同包原生程序（4 个资源）、PRODUCT.md 拒绝、Escape 返回原 OpenCode
  会话／草稿及焦点。截图 59–61。Host 三条会话的绑定、标题、归档及草稿与切片前相同；
  Pi/OpenCode 认证摘要及正式应用 `26b741ca…` 未变化。没有创建 Codex Host Session。
- **最终工程检查**：前端 41 文件／181 测试通过；Rust 全量 240 通过、2 ignored（需指定实际
  安装），两项忽略测试已通过显式本机路径单独运行（58.31 秒），包含补充的原生路径资源检查。
  全目标 clippy、typecheck、build、cargo fmt、本切片 Prettier 和 diff 检查通过。
  全仓 format:check 仍报告原有 reports/ 5 文件；不声称全仓格式通过。
  原始日志均在 `src-tauri/target/codex-protocol-audit/installation-*`。
- **限制**：程序识别切片不代表 P4 全部完成、Codex 认证或核心任务可用；没有替代 P1—P3
  的同构建原生干预／并发／性能候选验收，也没有代填人工使用或第二 Mac 验收。
  最新恢复点为 af1b99 QA 应用和 installation-host-backup.sqlite3；本切片未执行完整降级恢复。
- **正在进行的真实认证核验**：创建全新的 Farfold Dev `codex/` 状态目录，0700；固定官方程序
  以文件式认证和 umask 077 启动自有 App Server。account/read 先确认为空，官方
  account/login/start 返回 ChatGPT 登录 URL，已打开供用户完成。未复制默认认证或历史。
  这是 P4 原生认证试验，尚未实现 Farfold 内完整登录交互；用户完成前不标记认证成功。
  此后新增认证／状态属于受保护 QA 配置，不纳入临时目录清理。

#### 2026-09-08 真实 ChatGPT 登录、Plan 提问与原生续接

- **认证事实**：用户在官方网页完成独立 QA 登录。旧等待曾超时，随后重发登录；没有复制
  其他环境令牌。首次探针收到 account/login/completed.success=true 后立即读取账号为空，
  原失败记录保留，不能将其中 completed=true 单独视为认证就绪。
- **根因复核**：固定提交 `c4d748f586a84a3ed5b6aceb82e9a1db4abb1cda` 的官方
  `app-server/src/request_processors/account_processor.rs` 中，
  send_chatgpt_login_completion_notifications 先发送登录完成，再 reload AuthManager，最后
  发送 account/updated。本机探针过早读取触发竞态；已改为匹配成功回调后有界等待
  authMode=chatgpt 的 account/updated，再读取账号。未修改 Runtime，也未用固定延时掩盖竞态。
  本轮未再次要求用户登录来重复该时序；新等待分支尚无第二次真实 OAuth 验收。
- **独立认证复验**：新的自有 App Server 从相同 QA 状态目录冷启动，account/read 返回
  type=chatgpt；auth.json 为 0600、目录为 0700。只记录类型与权限，不记录邮箱或令牌。
  认证读取结果在忽略目录 `isolated-auth-read-result.json`；原生模型目录在
  `authenticated-catalog.json`，两者均位于 `src-tauri/target/codex-protocol-audit/`。
- **真实模型试验**：使用原生目录默认模型 GPT-5.5、默认 medium 推理，在独立
  qa-projects/codex-p4-native 目录发起只读 Plan 轮次，Default 提问特性仍关闭。
  原生线程 `01a07fe2-b737-7402-b634-865dae4d495c`，轮次
  `01a07fe2-b752-7a20-906a-24f69918c60e`。收到真实 item/tool/requestUserInput，
  校验线程与轮次，按 question ID 回复 North；收到 serverRequest/resolved、completed 终态，
  最终答复为 `CODEX-REAL-QUESTION-OK North`。这是预先约定答案的工程测试，由探针回复，
  不代替用户真实业务决策或 Farfold 内 UI 回复。
- **冷恢复**：关闭自有进程后，再从同一状态目录按原生 ID resume；线程、cwd、模型、历史
  轮次与答案保持。试验记录为 `real-question-result.json`。随后独立读取原生 JSONL，
  核对 Session 元数据、唯一 request_user_input 调用、对应 function_call_output 与最终答案；
  原始历史没有命令或文件修改工具调用。复核记录为 `real-question-independent-check.json`。
- **范围与剩余项**：真实账号认证／模型／Plan 提问和一次冷续接的协议证据成立；不将其扩展
  为 Farfold 核心安装验收、三次冷续接、审批／转向／停止的真实模型验收或完整 P4 完成。
  本轮没有新增 Host Codex Session、修改 schema 或替换安装应用。后续继续公共机制与其他
  核心接口门槛；P1—P3 交付一和 P5—P6 交付二均未完成。

#### 2026-09-08 Pi／OpenCode 平级工作台与公共状态迁移

- **设计依据**：采用 React 官方 [Sharing State Between Components](https://react.dev/learn/sharing-state-between-components)
  的公共状态上移与单一来源原则；结合 Pi 0.84.3 官方
  [RPC 协议](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/docs/rpc.md)
  的原生状态／历史／事件职责，保留 Pi 适配器中的原生命令、Project trust、转向／跟进及
  Extension 交互。不采用按导航卸载控制器的方式，因为后台原生任务仍需接收事件。
- **实现**：App 只负责存储入口、公共导航／项目选择、主题和更新入口。PiWorkspace 与
  OpenCodeWorkspace 平级挂载，共用 RuntimeWorkspaceProps；切换只改变可见内容。
  HostWorkspaceConnection 是工作台唯一的 startHostShadow 所有者，两路都订阅现有 Host
  状态与事件；Pi 原生 reconciliation 保留在 Pi 组件中。QA sequence-gap 的原生操作由
  Pi 提供，公共层仅暂停／恢复通道，保留原 cursor，并在退出后禁止重启或接收迟到状态。
- **LifeModel 边界**：仅把已有公共状态和治理回调移至 useLifeModelWorkspace，没有增加原型
  能力、打开默认开关或更改 Proposal 审批。公共错误在当前 Runtime 既有输入区通知位置显示，
  避免原先公共操作失败只写入 Pi 的错误状态。Pi 原生来源游标／注入仍属 Pi 控制器。
- **删除与复核**：主 App 的 Pi 状态、原生命令、运行订阅和 Pi 专属 UI 已移出；旧 Host 连接
  启停与重复公共 LifeModel 管理路径已删除。源码搜索确认非测试 startHostShadow 调用仅在
  公共连接所有者中，未增加第二个后端任务调度器、SQLite schema 或 Runtime 版本变更。
- **当前候选**：QA 安装程序摘要
  `5f7d38815d65e22540bd36cd77cae3c98f8e3fae68da99bd4582dfea3ace1826`，与 staged 相同，
  strict/deep 签名通过。配对恢复点为 workspace-extraction/backup-5dc731.app、Host 和
  OpenCode SQLite 快照及 Pi 原生 JSONL 快照；本次没有执行应用降级恢复验收。
- **工程检查**：最终前端 42 文件／185 测试通过，包含 4 项公共连接生命周期行为测试；
  Rust 全量 240 通过、2 ignored（显式本机安装测试），all-targets clippy、cargo fmt、
  typecheck、build、本切片 Prettier 与 diff 检查通过。全仓 format:check 仍为原 reports/
  5 个文件失败，不将其改写为全仓通过。日志在 src-tauri/target/workspace-extraction-*。
- **安装实测**：原 Pi／OpenCode 会话各用 Z.AI GLM-4.5-Air 读取当前目录 verified-303.txt，
  返回 PEER-PI-0908-OK／PEER-OC-0908-OK。Pi 有停止按钮、正在执行时跨到 OpenCode，
  随后返回能看到 Pi 原生结果。两路原生 read 调用、工具输出 42 与最终标记已独立核对，
  原文件仍为 42 加换行；不因此声称所有原生干预、双任务同时活动或容量排他验收。
  原 Host 绑定、标题、归档和已恢复草稿一致，正式应用与三路认证文件摘要未改变。
  LifeModel 面板显示已停用，治理入口保留。安装证据与原生身份记录在忽略目录
  src-tauri/target/workspace-extraction/；正常窗口截图 62–65 位于现有 design-qa 目录。
- **继续验证**：同一安装候选进行三次双路冷续接，结果另记；P1—P3 完整交付、原生干预／
  并发排他、900×620 与宽窗口、正式 20 次性能、配对恢复和人工验收仍未关闭。
- **本切片冷续接与小窗口复核完成**：同一 5f7d38 安装应用连续三次退出／冷启动，每次
  Pi 与 OpenCode 均按原生会话恢复；六份 AX 记录均含原标题、保留草稿与本轮原生结果。
  第三次后 Host 绑定／标题／归档／草稿再比对一致。900×620 两路标题／模型／Runtime 选择、
  历史滚动、草稿和发送入口可用，截图 66/67；已恢复常规窗口。当前范围不含宽窗口或完整
  键盘／忙碌异常状态矩阵。
- **性能限制**：全部日志保留。记录的 PiResume 为 778／333／644ms，OpenCodeResume 为
  3583／1457／1615／1708ms；次数与 UI 实际恢复次数未完全对应，不能补造缺失样本，也不能
  删除 3583ms。这里包含编译测试负载及初次恢复，不是正式可比较的 20 次 p95 验收。
- **QA 恢复点整理**：核对当前 5dc731 应用及配对 Host／OpenCode 快照 quick_check、Pi 原生
  快照后，删除已被替代的 618ff5、af1b99 两个 QA 应用备份及三个对应旧 SQLite 备份。
  旧数据库的普通只读打开曾失败，改用离线独立备份的 immutable 只读检查确认 quick_check
  通过后才清理；未据此归因当前数据库故障。精确清单在 obsolete-backup-inventory.json。
  当前安装应用、最新配对恢复点、正式应用和三路认证／状态目录均保留。

#### 2026-09-08 原生干预复测与 OpenCode 审批中停止修复（安装复验中）

- **当前复现事实**：5f7d38 安装 QA 中，OpenCode 对自己 QA Working Copy 之外的专用无敏感
  文本触发 external_directory。切换 Pi 不显示该审批，返回 OpenCode 保留同一请求；拒绝后
  原生 read 记录用户拒绝。第二次仅本次允许后实际 read 完成并返回 OC-PERMISSION-ONCE-OK；
  第三次仍触发审批，未变成持久允许。第三次等待期间点击 Stop，原生 read 已记录
  Tool execution aborted / interrupted=true，但工作台计数仍为 1、状态为结果未知。
  手动核对使输入恢复，计数仍残留。该失败不归为 Provider 余额或模型不支持。
- **固定版本依据**：OpenCode 1.15.13 commit
  `385cb694419f98103af0e8fc6187ddcbcbb6eecb` 的
  [permission/index.ts](https://github.com/anomalyco/opencode/blob/385cb694419f98103af0e8fc6187ddcbcbb6eecb/packages/opencode/src/permission/index.ts)
  用 Deferred 的 finalizer 清除等待请求；取消不必发布 permission.replied。因此采用原生
  同会话 idle／经身份核验的官方状态核对使失效交互过期，不伪造用户回复或权限批准。
  [官方权限交互文档](https://opencode.ai/docs/permissions/) 用于场景对照；当前文档不是
  固定版本所有权限持久范围的证明，未据此重标 always 的范围。
- **根因与实现**：Host Registry 原先只在 permission.replied 或进程生命周期变化时清除；
  现在精确匹配 installation／generation／native Session，标记 Stale。手动原生核对后通过
  现有 Host 通道发布状态快照，不新增原生事件或推进原生序号。前端给每次并行状态读取独立
  revision，拒绝迟到读取覆盖更新状态；unknown 保留已观察原生活动的证据，使后续 idle
  能正确收束。确认 idle 清除该会话本地审批，其他会话及旧 generation 不受影响。
- **测试证据**：修复前，原生 idle 清理测试得到 3 而不是 1；前端 2 个断言失败，分别为
  已取消审批残留和迟到 unknown 覆盖 idle。修复后前端全量 42 文件／189 测试通过；
  Rust 242 通过、2 ignored，all-targets clippy、类型检查、本切片格式与 diff 检查通过。
  新增状态推送测试还检查旧 stream／旧 cursor 不覆盖当前交互、不会生成原生序号。
  初次类型检查发现测试使用错误的 permission 枚举拼写，按实际 Rust serde 类型修正后重跑
  通过，不能仅以 Vitest 通过代替类型通过。原始日志在 target/workspace-extraction/stop-permission-*。
- **Pi 转向试验的证据限制**：第一次使用 sleep 20，转向输入实际在原读取与原结束之后才进入
  Pi JSONL，随后返回转向标记。它不证明中途改变后续行为，也不构成 Runtime 转向故障；
  需以足够长的工具等待和原生时间顺序重新验证。不得仅根据最终标记宣称转向验收。
- **安装待验**：本次修复尚待新摘要安装构建重验，前述 5f7d38 成功项不能自动沿用。
  已退出 QA、恢复两路保留草稿，保存 target/stop-permission/backup-5f7d38.app、两个 SQLite
  quick_check 通过的配对快照及 Pi JSONL；正式应用和认证均未作为替换目标。
- **ad5f7c 安装复验未全部通过**：摘要
  `ad5f7c8ada9d3e2e8f1aaaf340864493bafcdb647a82d5ddfb3a1d0d777eb9c2`。
  第一次真实 OpenCode 请求超过两分钟无工具和明确错误，停止后原生 MessageAbortedError、
  输入恢复；不推断余额不足。第二次触发 read 审批，Stop 后原生工具
  `prt_080185abe001UGGYgoxOnHNLHY` 为 interrupted，审批与计数清零，但输入仍结果未知。
  手动核对恢复，故 ad5f7c 只证明失效审批清理，不证明自动恢复完整通过。
  进一步沿源码核对：idle 可以使停止回复发起的状态读取失效，而原处理只重载历史，缺少
  以这个终态事件为起点的新核对。已补充精确同会话原生 idle 后的官方状态读取，非付费
  模型探测，无计时重试或新任务调度；19c2a3 安装复验进行中。
- **ad5f7c Pi 原生干预证据**：转向在 sleep 90 执行期间通过 UI 发送，原生 bash 结果
  `c3230e06` 后紧接转向输入 `c43e340a`，没有后续 read，最终 `c1a716ed` 返回
  PI-STEER-APPLIED-AD5F。跟进在 sleep 45 期间排队，原任务 read `7c867ba9` 和结果 42、
  FIRST `888a5c9b` 完成后才出现跟进输入 `199a65db`，随后 SECOND `ff277ece`。
  两种操作的先后语义已分别验证。原始选择、输入与结果 AX 和剔除 thinking 的原生记录在
  target/stop-permission/pi-{steer,followup}-*；该证据属于 ad5f7c，不自动扩展至后续摘要。
- **19c2a3 安装复验**：摘要
  `19c2a3bd08175009ee575c399b79d912236d709458f03aebf1be2b383ddda593`，严格签名通过。
  两次独立 read 审批 Stop 均原生 interrupted、计数清零、自动恢复输入，不再需要手动核对。
  第二次有短暂未知后恢复，但旧“当前空闲／提交仍未确认”说明残留在执行进度区域，不能把
  完整 UI 状态判为通过；已仅清除被官方 idle 证据取代的该条自有说明，保留原生错误。
  新增状态文案测试与精确 idle 事件测试，最终定向 3 文件／39 测试通过，新候选复验中。
- **19c2a3 Pi 停止及双路活动**：Pi bash `65e89502` 在 08:27:00.339Z 执行 sleep 60 时，
  OpenCode read `prt_0802034b5002PzKkrBlvrbWKXy` 正在等待审批。Pi 在 08:27:25.800Z
  返回 Command aborted，后续无 read／预期原结束标记，输入恢复；OpenCode 的审批仍保留。
  返回 OpenCode Stop 后自动恢复。该证据确认这两个独立目录可同时活动、停止不串会话；
  不覆盖超容量／同目录拒绝。专用文件未修改，正式应用和三路认证摘要与本切片起点相同。
- **ff3aee 本切片安装验收**：摘要
  `ff3aeed8af64143257104f33ecdfc05a6b4d94d6405807f0ce4030448e1ea3b4`。
  等待审批 Stop 后，原生 `prt_080247932001KAxr2i4vAnovvy` interrupted；UI 经短暂未知后
  自动恢复，审批／计数归零且不残留已失效说明。随后新任务用仅本次允许实际读取 QA 文件，
  回复 OC-AFTER-STOP-FF3A-OK，未绕过审批或重放旧任务。截图 69 已检查，草稿恢复。
  前端最终 42 文件／191 测试，定向 39 测试、类型检查和构建通过；Rust 本轮 242＋2 ignored、
  all-targets clippy 证据来自同一未再变更的 Rust 实现。全仓格式仍有原 reports/ 五文件问题。
- **ff3aee 正式性能组**：M4／16GB／macOS 15.6，常规窗口，同一程序与同一长历史；每次
  重启应用及自有 Runtime，不重启 OS／清缓存，不提交 Provider 任务。前四次为流程试采：
  第四次仅等输入可用便退出，未等历史完成；保留 perf-ff3a 全部记录，不据此判断恢复失败。
  修正为输入、保留草稿及既有历史均出现后，另完整采样 20 次，未筛除快慢值。
  正式组 perf-final-ff3a 的四项均 20 个、无缺失／重复计时，均 visible=1、focused=1、
  visibility_changed=0；每次记录负载。40 次 Runtime 恢复均原历史／草稿存在，最后 Host
  身份／标题／Working Copy／归档／草稿和应用摘要相同。
- **p95（nearest rank）**：ShellReady 586ms、SidebarReady 54ms、PiResume 1030ms，
  OpenCodeResume 2295ms。OpenCode 最快 2097ms、最慢 2322ms，全组超过 2 秒目标，明确未通过；
  不移动 Runtime-ready 计时起点。此组没有 Provider 新请求，不能算完整事件至绘制性能验收。
  分段显示 OpenCode 会话核验约 0.8 秒，Provider 目录约 1.3 秒，历史读取约几十毫秒；继续
  排查读取路径与固定版本官方接口，不以改模型、删历史或跳过身份验证解决。

#### 2026-09-08 OpenCode 恢复的已配置模型目录切片（本切片安装验证通过）

- **依据与取舍**：固定 1.15.13 的 provider.list handler 合并 ModelsDev 完整目录与
  Provider.Service.list；Farfold 原解析随后丢弃所有未连接条目。固定
  [config.providers 定义](https://github.com/anomalyco/opencode/blob/385cb694419f98103af0e8fc6187ddcbcbb6eecb/packages/opencode/src/server/routes/instance/httpapi/groups/config.ts)
  和 [实现](https://github.com/anomalyco/opencode/blob/385cb694419f98103af0e8fc6187ddcbcbb6eecb/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts)
  则直接返回同一 Service.list 的公开 Provider 信息；采用官方客户端按用途选择目录的做法，
  开始／恢复的模型目录改为 GET /config/providers，认证设置发现仍保留完整 /provider。
  三份上游源文件按固定 Git tree blob SHA 核对，未升级 Runtime、引入第三方实现或缓存模型
  身份，也未改 Runtime-ready 计时点、认证逻辑和会话核验。
- **实现与测试**：按原生 providers 数组建立相同的已配置 Provider 与模型列表；忽略原生
  default 选择，不覆盖已恢复会话的模型。缺失／格式错误返回明确失败，不把协议异常变成
  未配置。旧解析对新目录返回 not_ready 的测试已实际失败；新解析及真实 HTTP 路径 fixture
  通过，协议 16 测试通过，Rust 全量 244 通过、2 ignored、all-targets clippy／cargo fmt／
  类型检查／构建通过。前端源码未在本切片改变，最近全量为 191 通过。
- **候选**：`0d1e7fa762dc61f199d303ad7e9ad72185df017ba799a0bf4d791fb544089bd6`，staged 与
  安装一致、strict/deep 签名通过，当前配对恢复点为 target/configured-directory/backup-ff3aee.app
  及两个数据库快照、Pi JSONL。初次恢复仍为原标题／草稿／GLM-4.5-Air，2 个已配置 Provider。
  此次 Provider 目录 157.5ms、历史 30.1ms、Runtime-ready 到恢复绘制 955ms，仅为一次安装
  观察，不能当作 p95 达标；继续真实任务与完整 20 次采样。
- **0d1e7f 真实任务与正式采样完成**：原生 read
  `prt_08041578d0016qExkdMBvFvFq8` 读取原文件 42，最终
  `prt_080415f32001tRmS61Hd6nONv6` 为 CONFIG-DIRECTORY-0D1E-OK 42；原生 message 的
  providerID=zai、modelID=glm-4.5-air，截图 70／原始记录在 configured-directory/native-task*。
  随后采用同样的完整历史退出条件做 20 次冷应用／Runtime 采样，未筛样。
  四项均 20 个、无计时缺失或重复，全部前台可见且可见性未改变；40 次 UI 检查均原草稿和
  历史正确，最后 Host 绑定／标题／Working Copy／归档／草稿、程序及认证摘要一致。
- **0d1e7f p95（nearest rank）**：ShellReady 529ms、SidebarReady 50ms、PiResume 965ms、
  OpenCodeResume 1255ms。OpenCode 范围 1026–1444ms，全组低于 2 秒；原 ff3aee 全组及试采
  均保留。新版采样前新增了一条真实读取 QA 任务，因此两组历史并非逐字相同，不能将比较
  说成严格等历史实验；新版自身固定历史／构建的指标通过。冷进程表示应用与自有 Runtime
  重启，不包含 OS 冷缓存；目录就绪前的发现／程序校验／启动分段继续保留，不混入或删除。
  证据为 configured-directory/perf-0d1e/results.json 及每次原始日志／AX。这一结果不替代
  前台流式事件正式采样、完整 UI／目录冲突、配对恢复和人工／第二成员验收。

#### 2026-09-08 工作目录占用提示切片（本切片安装复验通过）

- **当前复现**：0d1e7f 安装 QA 中，Pi 在自己的 Working Copy 执行 sleep 120；另一条
  OpenCode 会话绑定同一目录。提交被 Host 拒绝，草稿保留，原生 OpenCode 消息数为 0。
  但错误只说明“工作目录已有任务”，没有指出占用对话，未满足 P3 的定位要求。
  证据在 target/configured-directory/working-copy-rejected*，不把设计建议冒充故障。
- **依据与设计决定**：参考 Git 的
  [资源占用提示](https://github.com/git/git/blob/v2.48.0/branch.c)，拒绝操作时给出实际占用者；
  只采用这一信息组织方式，不移植 Git 锁语义。Runtime 依据仍为已核验的 Pi RPC／OpenCode
  固定会话与活动接口，目录排他是 Farfold 已批准的 Host 规则，不宣称 Runtime 自带该限制。
  在拒绝时捕获 Host 活动任务的强类型会话／安装／Runtime 身份，释放准入锁后按该会话 ID
  读取 Host 标题。标题不可读时明确说明，不猜测标题、不从当前导航推断占用者。
- **同切片迁移**：错误在 Host 形成统一可读文本；删除唯一消费者对应的前端错误码正则转换
  与三项旧测试。仍由原有 Host 权威拒绝，不新增前端排队／自动重试，不改变草稿或原生绑定。
  补充实际占用身份、标题缺失／未知 Runtime、容量占用名单与去重检查；前端现为
  41 文件／188 测试通过，类型检查通过。安装复验与最终 Rust 检查待记录。
- **恢复点整理**：先前 5dc731、5f7d38、ad5f7c、19c2a3 的旧配对恢复点已在各自后继安装
  验证后按精确清单删除，历史原始日志／截图仍在。最新 0d1e7f 应用、Host／OpenCode SQLite
  quick_check 通过的快照及 Pi JSONL 已保存到 target/admission-conflict；正式应用与认证
  只记录摘要核对。旧 ff3aee 配对点待本候选验收后再清理，不删除用户数据。

- **f1f410 安装复验通过**：摘要
  `f1f410cae768d3ccab30fe47f63b89f13f1b1f619d27050ade5c5d5ea3e4dbec`，安装／staged 一致、
  strict/deep 签名通过。Pi 执行 sleep 120 时，同目录 OpenCode 提交被拒绝；提示为
  “相关运行对话：Pi「QA Pi 保留身份」”，原草稿保留，原生 ses_f7faa4521ffe0tNvfgs2M4fNfZ
  消息数仍为 0。Pi Stop 原生结束后输入恢复，原 Pi／OpenCode 保留草稿和认证摘要核对一致。
  截图 71 已视觉检查；证据在 target/admission-conflict/rejected*、after.json。
  Rust 全量 246 通过、2 ignored，前端 41 文件／188 通过、类型／构建／全目标 clippy 通过；
  全仓格式检查仍仅报告原 reports/ 五文件。此项不替代超容量安装验收。
- **QA 清理**：本次额外创建但未发送的 ses_f7fad194affegwEWeYLhe8s5K1 已通过 UI 归档，并由
  Host archived_at 核对。首次点击后立即退出，未确认归档写入；第二次等待 UI 和数据库确认
  后才记录完成。同目录空会话保留，用于下一项真实复现，不删除原生历史。

#### 2026-09-08 OpenCode 未发送模型选择的恢复切片（本切片安装验收通过）

- **真实缺陷**：同目录空会话先显式选择 GLM-4.5-Air、提交被 Host 拒绝；f1f410 冷启动恢复
  原 ID／草稿后，模型却变为 GLM-4.5。empty-session-restored.ax.txt 是当前安装证据。
  根因是组件只保存内存选择，恢复仅从已成功执行的 assistant 历史取模型；空历史又自动
  取目录首项。目录包含某模型不等于用户选择它，不应借此更换 Provider 或模型。
- **固定官方依据**：1.15.13 的
  [Session HTTP 定义](https://github.com/anomalyco/opencode/blob/385cb694419f98103af0e8fc6187ddcbcbb6eecb/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts)
  与 [handler](https://github.com/anomalyco/opencode/blob/385cb694419f98103af0e8fc6187ddcbcbb6eecb/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)
  支持 PATCH /session/:id 的 metadata。Session.Info 存在 model 字段，但此 PATCH **没有**
  model 参数，不能根据 Info 字段猜测写接口。四份新读取上游文件均按固定 Git blob 摘要核验。
- **成熟实践与取舍**：官方 app 的
  [local.tsx](https://github.com/anomalyco/opencode/blob/385cb694419f98103af0e8fc6187ddcbcbb6eecb/packages/app/src/context/local.tsx)
  按工作区／会话单独保存模型选择，和已执行消息分开。采用“会话范围的用户选择”这一职责；
  Farfold 通过官方 metadata 扩展保存自己的命名空间，不复制其前端存储实现、不篡改原生
  model 字段或制造消息，不新增 Host 历史数据库，不改变 schema 7。
- **原生可行性试验**：隔离临时 OpenCode 1.15.13 进程创建空会话，PATCH 保存选择及保留
  其他 metadata；退出并冷启动后同 ID／目录／metadata 正确，消息数仍为 0。临时进程和
  目录在 finally 清理。证据 model-metadata-probe.json，只证明原生接口可行，不算产品验收。
- **实现边界**：模型读／写经过 Host 持久绑定、目录与原生身份核验；写入同时核对 Host
  活动任务、原生会话空闲和当前模型目录，只开放类型化 provider/model 参数。保留其他
  metadata，核对原生回复的同 ID／目录和实际保存结果。用户选择优先于旧执行历史；空历史
  无选择时要求明确选择，已选模型不在目录时显示不可用，不自动改模型。
  保存期间阻止发送与切换，失败保留草稿／明确未确认；恢复模型失败仍允许展示实际历史，
  但不默许模型。迟到读取不能覆盖较新选择。当前安装尚为 f1f410；新实现待新摘要验收。

- **安装迭代与最终证据**：189412 中已由实际 UI 保存 metadata，独立读取原生数据库确认
  Air／消息数为 0；发现输入框把“缺少模型”写成“连接命令通道”，随后补充精确未就绪原因。
  最终摘要 `9f13ba09ebef03f47d1b17e88d8c748a1b5a76402ff63d7dcc8d0d1c09659981`，安装／staged
  和严格签名核验通过。对 ses_f7faa4521ffe0tNvfgs2M4fNfZ 连续三次冷应用／Runtime 续接，
  Air、原生 ID、草稿全部一致，均发生在首次成功请求之前；cold-1/2/3.ax.txt 保留原始输出。
- **真实请求**：9f13ba 的 read `prt_080799d05001QTOqhYdHL2NDuP` 完成读取 verified-303.txt，
  最终 `prt_08079a4f2001wjwrgsEWeTabBS` 回复 MODEL-SELECTION-9F13-OK 42；两条 assistant
  均 providerID=zai、modelID=glm-4.5-air。原生文本有前导换行，第一次严格全文断言未通过；
  已保留原文，按去除外围空白后的 UI 文本核对，而非重试请求。文件仍为 42 加换行。
  截图 72 已视觉检查，真实任务／原生记录在 target/model-selection/real-task*。
- **空会话隔离**：切换至另一个无历史／无选择的原生空会话 ses_f7fad194affegwEWeYLhe8s5K1，
  没有继承 Air 或选择目录首项；模型为空、发送禁用，输入框明确提示“请先在顶部选择
  OpenCode 模型”。该 QA 会话已重新归档并核对 archived_at。同目录 QA 会话保留草稿，
  正式应用、三路认证摘要和 schema 7 均未变。当前最新配对恢复点为 model-selection/
  backup-f1f410.app、两个数据库快照与 Pi JSONL。
- **检查范围**：固定原生接口探针通过；模型协议新增 3 项检查，协议 19 通过；Rust 全量
  249 通过、2 ignored，all-targets clippy／cargo fmt／类型／构建通过；前端最终
  41 文件／188 测试通过。未以这些检查宣称任意版本／插件并发 metadata 写入或全部异常
  场景已覆盖；所有未交付能力继续留在后续清单。该切片不关闭整个 P1—P3 或 Codex 接入。

- **9f13ba 正式启动／恢复采样**：同 M4／16GB／macOS 15.6、1199×768，每次冷应用和自有
  Runtime，20 次完整记录，40 次原草稿／长历史恢复全部通过；Host 绑定／标题／Working Copy／
  归档／草稿及应用／认证摘要前后相同。四项均 20 个、无缺失／重复，visible=1、focused=1、
  visibility_changed=0。nearest-rank p95：ShellReady 294ms、SidebarReady 30ms、PiResume
  627ms、OpenCodeResume 971ms；两路最大恢复值 714ms／973ms。该组包含本轮新增 QA 历史，
  不据此计算相对旧版本的严格因果提速率。结果见 model-selection/perf-9f13/results.json。
- **证据归档纠错**：复用 CUA 检查函数闭包保留旧目录，20 次 UI 检查的 60 个文件写到了
  perf-0d1e，覆盖了其旧 AX/UI 文件；本轮 20 个新日志、旧日志／before／results 均未覆盖。
  已逐一按本轮启动时间、文件 mtime、Pi 新历史标记核对，将 60 个本轮文件移至 perf-9f13。
  修正清单在 evidence-path-correction.json；旧组 ui-artifacts-unavailable.json 明确标记
  旧完整 AX 已不可用，旧 UI 布尔结果仅保留在当时的 results.json。未伪造重建旧原始快照，
  不能再引用新 UI 文件证明旧构建。后续检查函数须显式传入输出目录，禁止依赖可重绑闭包。
- **窗口检查与恢复点**：9f13ba 两路原长历史在实际 900×620 及当前显示器最大 1306×768
  下均检查，截图 73／75／76／77 已视觉核对；74 实际为中间尺寸 1013×698，不能因文件名
  含 900 而当作最小窗口证据。原草稿不变，常规窗口最终恢复 1199×768。Cmd-K 可定位搜索框；
  不将这一检查扩大为完整键盘／焦点验收。已按精确清单移除 ff3aee、0d1e7f 共 8 个过期
  配对恢复对象，保留最新 f1f410 配对恢复点及其余原始证据。

#### 2026-09-08 9f13ba 流式绘制及配对恢复复核

- **事前采样约定**：同 1199×768 安装 QA，Pi／OpenCode 各完成一个真实 GLM-4.5-Air 文本
  流式任务；提交边界后取前 20 个连续已支持流式事件，同时保留整段分布，不切换工作区、
  不删慢值或不可见样本。Pi 计 RPC message_update，OpenCode 计 SSE message.part.delta。
  测量为 Host 收到事件至双 requestAnimationFrame 的下一绘制机会，不声称实际屏幕刷新、
  所有工具事件或纯 React CPU 耗时。事前约定、边界日志和 AX 在 model-selection/events-9f13。
- **结果**：前 20 个连续事件 nearest-rank p95：Pi 46ms、OpenCode 36ms；整段分别
  278 个／280 个，p95 46ms／39ms，最大 47ms／40ms，无可见性或焦点异常。该流式场景
  达到 150ms 目标。原生 Pi assistant 1d196b20、OpenCode msg_0808f8765001wR9LIozNI5uWrJ
  均为 zai/glm-4.5-air，原生最终标记存在、无工具调用。原生请求到结束为 13653ms／11178ms，
  包含 Provider 与 Runtime 处理；无法拆出纯 Provider 服务端时间，不混入事件绘制指标。
  首次检查助手错误地要求完成标记单独占一个原生 text part，实际 OpenCode 将整段答复
  放在同一个 part；已依据真实结构核对 assistant 最后一行，没有重试模型或改写历史。
- **配对恢复实际执行**：先退出 QA 及自有 Runtime，保存 9f13ba 应用、Host／OpenCode
  SQLite 一致快照、Pi JSONL；数据库 quick_check、原生头 ID 和程序摘要通过，快照设为
  0600，认证不复制。实际将 QA 回退至已保存的 f1f410 应用／对应数据；两路 UI 恢复原
  标题／草稿／历史，独立数据库绑定、消息数和 Pi 文件摘要与旧配对点一致，未重放请求。
  随后实际恢复 9f13ba 配对点并重启，两路本轮新增流式答复、原草稿均恢复；独立核对
  新选择 metadata、全部消息数、Pi 原始字节、schema 7、程序和受保护摘要全部一致。
- **证据与限制**：paired-recovery-9f13/{restored-*,f1f410-independent,final-independent}
  记录实际 UI 与反向核对。此为同 schema 7 两个固定 QA 构建的配对恢复，不能扩展为
  schema 7→8 迁移、正式应用替换、第二 Mac 或人工真实任务验收。正式应用与认证一直
  保持原摘要。当前 QA 已回到 9f13ba 并退出，最新完整恢复点为 backup-9f13ba.app 及对应
  数据快照。后续继续当前候选原生干预／真实产物补验，以及 Codex P4 未关闭控制语义。

#### 2026-09-08 Codex 原生控制与退出语义复核

- **实际协议证据**：固定 0.143.0／SHA 9070e47d…，experimentalApi=false，独立临时 HOME／
  CODEX_HOME、无认证的 loopback scripted Provider。命令审批 cancel→declined／interrupted、
  accept→completed／实际文件符合；文件审批 decline 不写入、accept 后真实文件与原生 diff
  对应。转向拒绝错误 expectedTurnId 和已结束轮次，正确输入进入同一原生轮次与后续请求。
  待审批时 interrupt 的空响应仅为确认；随后 resolved＋interrupted 才结束交互，迟到 accept
  没有执行或重放。证据 control-probe-result、file-approval-result、turn-controls-result.json。
- **版本差异**：真实稳定连接的命令审批包含 availableDecisions，但实际生成的 stable schema
  没有该字段，experimental schema 有。显式升级权限的请求仅给 accept、特定规则 amendment、
  cancel；不能套用全部枚举显示 decline／acceptForSession。初次探针错误地假设 decline 在
  每个请求均可用而失败，原始失败保留；修正为该请求明确允许的 cancel，未改变权限策略。
  接入保留原始字段，用固定版本类型校验并收窄可用决定；不据此开启其他实验控制方法。
- **Stop 关键边界**：真实后台 sleep 后写文件，在 turn/completed=interrupted 后仍完成；
  SIGTERM 终止 App Server（exit -15）也未阻止写入。关闭 stdio 输入触发正常退出（exit 0）
  的对照中，等待超过原定执行时间后文件仍不存在。三次独立临时试验保留
  background-{interrupt,owned-exit,graceful-exit}-result.json，不把进程退出与子任务清理混同。
- **官方与设计依据**：固定提交 c4d748f586a84a3ed5b6aceb82e9a1db4abb1cda 的
  [App Server README](https://github.com/openai/codex/blob/c4d748f586a84a3ed5b6aceb82e9a1db4abb1cda/codex-rs/app-server/README.md)
  明确 turn/interrupt 不清理后台终端；
  [stdio 退出实现](https://github.com/openai/codex/blob/c4d748f586a84a3ed5b6aceb82e9a1db4abb1cda/codex-rs/app-server/src/lib.rs)
  在连接关闭后执行 shutdown_threads。新读取六份源码均按固定 Git tree blob SHA 核验。
  后台 clean/list/terminate 仅存在于 experimental schema，当前不调用、不扩大既有授权。
  Farfold 将区分当前轮次中断和组件正常退出；未终结后台命令仍保留任务占用与待清理状态，
  通过退出自有组件恢复。EOF 退出失败／超时或强制终止不能宣称后台清理成功，保留未知。
- **证据边界与后续**：这些是原生控制面确定性试验，不是实际模型自主工具选择、Farfold UI、
  正式安装或全部子进程清理证明。未改变已登录 QA 认证、用户默认 Codex 历史或 Runtime
  版本。下一步实现持久安装引用及启动前复核，再接入自有连接；9f13ba schema 7 的安装 QA
  与完整配对恢复点保留为交付一候选，schema 8 的验收独立记录。

#### 2026-09-08 P5 持久安装引用与 schema 8 切片

- **设计与边界**：沿用 Host 的产品／安装／构建／连接身份及事务，新增
  system_installation_launches，以复合外键关联已登记构建。保存类型化选择路径、原生程序、
  npm 入口、Node 解释器、附属文件摘要和核验时间；不保存认证、启动命令或原生历史。
  新入口登记前重新核验 UI 所见程序；重新核验／定位先比对摘要，再执行 --version，包含
  Node 摘要。明确重新定位保留安装和构建 ID，旧对话框的过期写入被比较并交换检查拒绝。
  读取历史登记不等于当前可用，界面保留“上次核验”，任务接入仍标记准备中。
- **官方实践**：继续采用 P4 固定官方 npm 启动布局、install-context 的附属文件规则与版本
  验证；不依赖 GUI PATH 或 shell 初始化。持久化复用仓库已有 RuntimeRegistration 和
  portable-export 的一致快照机制，不另建程序管理器／认证数据库。程序文件仍归用户，
  Farfold 不安装、升级或删除它。UI 文件选择器会解析符号链接，应记录实际返回路径，不能
  把 QA 别名当成最终保存路径。
- **数据与兼容**：schema 8 迁移沿用先备份再事务升级；发布 manifest 同步到 schema 8，
  分发资源仍仅包含 Pi／OpenCode，不打包用户 Codex。导出 format 4 增加程序引用计数和
  路径策略，导入核对引用外键和类型化记录，拒绝混入认证或任意命令字段；跨机器文件未
  核验时不能因记录存在而启动。旧格式用配对应用／数据恢复，未保留伪兼容写入通道。
- **实际暴露并修复的备份问题**：迁移备份原先按 SQLite 默认模式创建为 0644，新增检查
  复现后改为独占创建 0600 文件。46bdade4… 安装升级后发现备份继承 WAL，普通只读打开
  失败；immutable 只读可核对完整原始内容，但不将其作为修复。随后按既有 portable-export
  做法，在快照关闭前转换 DELETE 模式，并保留失败证据、增加普通只读回归检查。
- **安装迁移验证**：实际回到 9f13ba schema 7 配对点后，以
  `db97dfeafcbeb98c3b6bf9cb568fb1bbe1d38ded1ca12212b39fd8b9e4e4d749` 再升级；schema 8、
  5 条原会话身份／标题／Working Copy／归档／置顶／草稿及 LifeModel 内容全部一致。
  新备份普通只读可打开、quick_check=ok、schema 7、DELETE、0600，旧绑定与升级后对应。
  证据 codex-installation-schema8/migration.json；旧失败在 migration-46bd.json 单列。
- **程序实际行为**：db97 在 UI 登记官方 npm/nvm 入口及独立原生 QA 副本；仅移动、修改
  自己的副本，不修改用户 CLI。文件缺失明确报错且记录不变；显式重新定位后原安装／
  构建 ID 不变；追加字节导致摘要变化时，在执行前拒绝，未改写已接受摘要。恢复原字节
  后重新核验成功。原始 AX 和数据库反查见 {registered,missing,relocated,changed-program,
  revalidated}-db97；不能把这些程序检查当成 Codex 核心任务已可用。
- **界面修正及最终候选**：截图 78 发现共享设置弹窗深色 h2 仍用浅色主题的暗文字，
  已在共享暗色标题规则中修复。最终安装／staged 摘要
  `16b66ceb99bb3589aebb1174f4d7d5a55b2017ab30790485bcd903a3794cb4e6`，严格签名通过。
  两条完整安装记录跨冷应用启动保持。截图 80 已确认标题清楚；82 为实际 900×620，83
  验证 Tab 可到达并滚动显示底部操作，Escape 返回 Runtime 选择器。81 为实际 961×662，
  不当作最小尺寸证据；79 是菜单尚未打开弹窗时的中间截图，已改名，不当作标题修复证明。
- **实际导出与配对恢复**：16b6 两路恢复原 GLM-4.5-Air／原草稿／长历史，原生 Pi 字节和
  OpenCode message／part 与 schema 7 配对点相同，没有重放任务。通过安装 UI 导出
  schema8-installed-16b6.farfold.sqlite3，实查 format 4／schema 8／5 会话／2 程序引用，
  DELETE、0600、完整性及外键通过，引用与 Host 一致。完整保存 16b6 schema 8 配对点，
  实际回退 9f13ba schema 7，再恢复 16b6 schema 8；两路 UI 和原生身份／草稿通过，两条
  程序引用原样返回。首次回退 UI 助手按 30 次读取过早结束，OpenCode 当时仍打开中；
  修正为等待实际恢复后通过，不将中间状态写作 Runtime 失败或性能样本。
- **检查与限制**：Rust 全量 253 通过、2 ignored；前端 41 文件／188 通过，类型／构建／
  cargo fmt／clippy 与 all-targets clippy 通过。全仓格式仍仅有原 reports/ 五文件失败。
  16b6 相对 db97 仅修正共享标题颜色；上述程序变化行为证据仍按 db97 归属，后续正式
  交付候选须按自身摘要跑完整回归，不自动扩大为任意构建／平台支持。当前未实现 Codex
  自有连接、Farfold 登录 UI、核心任务和三路并发；两个正式交付及第二 Mac／人工验收均
  未关闭。保留 schema 7 的 9f13ba 与 schema 8 的 16b6 两个必要配对点，正式应用及认证
  摘要保持不变。下一步接入自有 stdio 连接和精确认证状态，再迁移至共同工作台。

#### 2026-09-09 P5 自有连接与账号控制切片

- **实现**：Codex 程序在启动前再次按登记摘要核验，显式 Node/npm 或原生程序启动自有
  App Server，stdio 初始化并核对返回的 codexHome、平台；本切片 experimentalApi=false。
  环境按应用标识取独立 codex 目录，0700／0600，并拒绝认证符号链接和硬链接；不传入
  默认 Provider key、登录 issuer 或 CODEX_HOME 环境覆盖。账号响应不进入 Host DB、日志
  或公共原生事件环。浏览器登录地址限官方 HTTPS 域；原生账号存在与请求成功分别表述。
- **共同机制**：RuntimeSupervisor 改用拥有数据的类型化 RuntimeBinding，兼容两路固定
  安装和动态系统安装；公共快照与重置入口按安装身份查询。数据恢复／更新准入包含
  Codex；重新定位不能越过活动连接。账号操作和停止绑定安装及进程 generation，登录
  超时保留未知，不自动重发；未支持的服务端请求明确返回错误。缓冲有界，保留非认证
  原始通知和缺口计数；实际看到 remoteControl/status/changed，仅作为未接入事件显示。
- **官方依据及取舍**：固定 c4d748f586a84a3ed5b6aceb82e9a1db4abb1cda 的 App Server
  README（官方富客户端接口）、v1 InitializeResponse、v2 Account／Login／Cancel schema
  支持初始化与账号控制。沿用 JSONL、请求 ID、双向消息和有界缓冲；不采用 websocket、
  默认账号令牌导入、设备码或其他实验认证路径。源版本和许可沿用 P4 已核验依据。
- **安装事实**：7a872d… 与 ac1a24… 两个 QA 候选均从登记的 npm 程序启动自有 Node／
  原生 Codex 子进程，专属目录读回已登录 ChatGPT 账号；7a87 的停止按钮使两进程退出。
  ac1a24 的 Codex 连接存续时，Pi／OpenCode 原 ID、历史和草稿恢复；原生 Pi 字节与
  OpenCode message／part 未改变。ac1a24 应用退出清理已记录的自有进程，冷启动重新
  连接再次读回账号；900×620 的停止按钮可由键盘到达，Escape 返回 Runtime 选择器。
  当前记录均为 Dev 标识下的安装工程 QA，不等于独立 QA／日用／第二 Mac 全部验收。
- **独立复核发现并修复**：延迟 account/read 测试实际复现连接锁阻塞状态查询。改为
  短暂持有连接／账号锁，原生请求在锁外等待；关闭 stdin 可先解除待响应控制请求，
  Stop 不等待普通 15 秒控制超时。退出等待期间保留连接引用，避免尚未退出即允许维护。
  修复后的延迟状态／停止与维护准入行为测试通过；新源码候选正在进行安装复核。
- **证据与边界**：src-tauri/target/codex-connection 保留准确摘要、AX、进程父子关系、
  认证权限／摘要、原生历史及负例输出；截图 84–87 已查看。基础官方程序空环境试验
  完成未登录→测试 key 配置→退出→正常 EOF（无真实凭证、无模型任务）。当前尚未在
  Farfold 内验收浏览器完整回调、API key 真实请求、核心 Thread／Turn／Item、审批、
  提问和转向；不得将 P4 或上述账号读回扩大成核心任务可用。正式应用和其数据未替换，
  schema 7 的 9f13ba 与 schema 8 的 16b6 必要完整配对点仍保留。

#### 2026-09-09 P5 模型目录与动态身份续进

- **安装事实**：账号控制锁与退出观察修复候选 d123500f… 已安装；在自有 Codex 连接
  保持运行时，两路原生历史和草稿恢复通过。退出应用后，记录的应用及五个自有子进程
  全部退出。认证摘要、正式应用、Host 身份／草稿、Pi 原生字节和 OpenCode message／part
  与切片前一致，见 codex-connection/{coexist,exit}-d123-independent.json。
- **实现及官方依据**：模型目录使用固定 0.143.0 model/list 的分页、原生模型 ID／slug、
  推理字符串和原始顺序；完整读取后才显示目录。最多 16 页／500 模型，重复游标、重复
  身份、缺少必需字段或超限明确失败。没有 inputModalities 时不自行开放图片。来源为
  P4 固定提交 App Server README 和本机生成 stable/v2/ModelList{Params,Response}.json；
  不采用 Pi 思考等级枚举、不触发付费探测，不按目录升级既有会话模型。
- **新安装候选**：b621336d58fbd41b68950b6eddde5a0e64c22558a82bc62f23dcf343306765f4，
  staged／安装摘要一致、严格签名通过。在 Dev 安装 UI 读取到 2 个模型：gpt-5.5、
  gpt-5.3-codex-spark；展开 gpt-5.5 显示原生默认 medium 和 low／medium／high／xhigh。
  AX 在 catalog{,-options}-b621，截图 88 已查看；该结果不证明额度或真实模型任务成功。
  保持 Codex 连接，两路原会话恢复、原历史／草稿及保护文件反查通过
  （coexist-b621-*）。未在这次目录核验中发送任务。
- **共同机制**：事件与显示投影使用强类型动态安装／构建／连接身份，注册身份不匹配
  的事件被拒绝；未知 Runtime 的 Pi 形似事件保留原数据但保持未观察状态，不默认变成
  Pi 执行。目录回复绑定进程 generation，停止／重连后旧目录不能作为当前结果展示。
  当前还没有 Codex 核心事件派发和交互工作台，不能把容器扩展写成第三路任务能力。
- **检查**：此 b621 源码 Rust 全量 263 通过、3 ignored，all-targets clippy 通过；前端
  42 文件／191 通过，类型和构建通过。全仓格式仍有既有 reports/ 五文件失败。随后推进
  的动态原生会话登记／交互身份改动属于后续源码，另行测试／安装，不沿用 b621 验收。

#### 2026-09-09 P5 原生线程登记与恢复入口切片

- **公共身份**：现有 native-session 登记入口接受 RuntimeBinding，替换并删除 managed-only
  函数／类型名；Pi/OpenCode 仍经过同一实现，原派生 Session ID 不变。交互登记改为类型化
  动态安装身份，回复核对完整构建／连接／generation／native Session；更换身份、重复回复
  和已失效代际不能关闭或复活其他交互。Host 原生会话解析新增构建匹配，不沿用旧构建的
  身份解释。动态绑定、错误来源事件、跨连接回复与失效恢复测试通过。
- **原生依据**：固定官方 README 的 thread/resume 使用 thread.id；sessionId 是当前会话树
  身份。恢复时不发送 model、modelProvider 或 config 模型覆盖，先 thread/read 核对原工作
  目录，再 resume；仅官方历史提供内容，不把 Host 数据当作原生历史副本。返回目录、版本、
  非临时线程、原生时间、完整轮次视图、用户审批和受限 sandbox 均核对，未知 item 保留。
  显式固定程序的独立临时环境试验新增 thread/start 响应验证，1 通过，18.23 秒；无真实
  Provider 任务，不能当作模型执行成功。
- **Host 与 UI**：Codex 从同一个 host_session_create/open 接入，登记系统安装引用和原生
  thread.id；新建明确选择原生模型与推理，Host 重新核对目录，不自动替代选择。冷打开按
  已绑定安装启动自有连接，程序复核失败仍阻断。工作台复用侧栏、标题、项目入口、输入和
  设置容器，草稿写入同一 Host 存储；目前发送与原生干预仍禁用。原生会话不存在时失败，
  不创建替代。归档／删除的共享准入加入 Codex 连接，仍保留原生历史和程序文件。
- **安装验证**：40a1fd56… 在 Dev QA 的 codex-thread-0909 目录中，通过界面新建原生线程
  01a0821a-d670-7182-8574-fc04db3f4146，Host ID 为
  session-51a2af2e10f8d49d782875f1537b85b27516381bd59e43fa36bd72cd27a1b96a。
  gpt-5.5／medium、目录、原生 ID 与 Host 记录一致，标题及未发送草稿已保存；未执行 Turn。
  冷启动后 thread/read 返回 -32600，原绑定／标题／草稿保留。此原生空线程没有完成持久
  续接验收；不能据此声称真实任务三次续接已通过。
- **实际发现并修复**：40a1 的失败提示仅有协议码，且恢复页“新建 Session”按钮未切到模型
  选择页，UI 已复现。修复候选
  b199b227b136812ddc4f117f1871acbfe058ef214cf31e06f3034ef134b15b26
  已安装、stage 摘要和严格签名一致：原生读回失败明确说明绑定／草稿保留、未创建替代；
  新建按钮进入空模型选择页，旧草稿不显示在新建输入中且数据库原草稿不变。两候选的
  Pi/OpenCode 原生历史、原草稿恢复及保护文件反查通过，结果按各自摘要记录。
- **备份问题与边界**：增加 40a1 应用／Host／原生历史配对点，覆盖新增 Codex Host 引用；
  认证原位保留。Codex state_5.sqlite 无 WAL 辅助文件时直接只读打开失败。依据
  [SQLite WAL 说明](https://www.sqlite.org/wal.html)，在 Runtime 未连接且源文件摘要稳定时，
  仅复制源 DB 及存在的 WAL 到私有临时目录，副本检查后生成 DELETE 备份；三份 Codex
  数据库普通只读 quick_check=ok、0600，原 DB／WAL 摘要未改变。此配对点已校验快照，
  尚未做实际恢复演练；schema 7 的 9f13ba 和已演练 schema 8 的 16b6 暂时保留，后续淘汰
  被验证替代的旧恢复点。不会把部分失败的备份当作完成。
- **检查与未完成项**：Rust 267 通过、3 ignored，all-targets clippy／fmt 通过；前端 42 文件／
  192 通过，类型及构建通过。全仓格式仍为既有 reports/ 五文件失败。证据在 codex-connection
  的 thread-_／coexist-_／new-after-failed-resume-*，截图 89 已查看。发送、实时事件、工具、
  原生审批／提问／转向、真实任务后恢复和三路并发仍未实现或未验收；不能关闭 P5／P6。

#### 2026-09-09 P5 文本任务、事件、停止与真实续接切片

- **公共机制与原生依据**：沿用固定官方 App Server README 的请求 ID 关联、turn/start
  回包与 turn/completed 通知分离、原生 Thread/Turn/Item 身份。传输层区分发送前失败、
  原生明确拒绝和写入／响应未确认；超时不取消 Host 准入。单一有界事件消费者使用共享
  Host 通道，缓冲丢失明确报告，UI／数据库处理不阻塞控制响应读取。账号事件先过滤，
  仅留私有有限的登录完成身份／状态，未知 account 事件也不进入公共 ring；先于登录回包
  的完成通知按原生 loginId 关联，认证读回仍不等于模型成功。
- **任务与界面**：同一 Host Session 控制和 TurnCoordinator 负责完整绑定、工作目录、
  每连接一条／全应用两条准入；命令发送不能绕过 Host。Codex 原生轮次在适配器内保存，
  早于 turn/start 回包的通知有界暂存，绑定真实 Turn ID 后处理，其他轮次不能结算当前任务。
  工作台展示原生文本增量、用户消息、命令／文件等条目，详细 native JSON 可展开；未知条目
  保留。停止请求先显示停止中，失败／断流及未确认命令保留占用，不自动重发输入。账号
  变更在活动任务期间被同一准入拒绝。仍未实现审批回复、Plan 提问、转向和文件引用输入。
- **检查**：Rust 全量 274 通过、3 ignored；含真实 stdio fixture 的原生拒绝／未知结果、
  阻塞事件消费时控制回包、有界丢失、动态身份、早晚事件、后台命令占用和共享并发／同目录
  准入回归。前端 43 文件／196 通过，类型和构建通过，all-targets clippy 通过。五个既有
  reports 文件仍未通过格式检查。测试为固定行为证据，不替代真实模型或安装应用。
- **安装真实任务（5fab）**：候选
  5fab6d8c9ff18f8c79460bbadaa13334fbe0e7cd17441c730cfaf749fbc3f404
  通过 Dev UI 在 codex-core-0909 新建原生线程
  01a08260-bc56-7271-9418-87b7be350287，Host 为
  session-12e85caf1f9ff2c5aa2c632f0c9819e5aea2e91915970fa4b6e32eeea491e238，
  使用已登录的私有 ChatGPT 环境、gpt-5.5／medium。真实读取 input.txt、写 result.txt、
  读回并断言后回复 CODEX-INSTALLED-CORE-0909-OK。独立核对 UI 轮次
  01a08262-54a8-71f2-8f0b-8442d1f81e30、Host 绑定、原生 JSONL 0.143.0／cwd／
  function_call_output 和实际文件，结果精确为 34320a。没有把最终文本标记作为唯一证据。
- **停止的正反证据（同一 5fab）**：25 秒命令在原生 turn/interrupt 后仍继续并写出
  stop-after-5fab.txt；此场景“不再发生后续写入”未通过。界面保持未知和目录占用，直到
  迟到的命令退出事件才释放；恢复按钮点击时原生命令已完成，旧元素失效，未记为执行过
  连接恢复。第二次独立 60 秒命令在原生中断后，实际点击“停止自有 Codex 连接并核对”，
  自有进程通过 stdin EOF 正常退出；114 秒后的文件检查仍不存在 stop-owned-after-5fab.txt。
  这仅证明该恢复组合阻止了该测试的后续写入，不能宣称 turn/interrupt 单独终止所有 Shell、
  强杀等于清理完成，或撤销已经发生的副作用。
- **UI 修正与续接（c382）**：5fab 真实截图发现消息容器未用公共布局，设置仍说不能发任务。
  修正候选 c3820f96b7eabed17b4a443bff67cfe7080207bf6d25d5b84252a262ea19a4d6
  已安装，stage 摘要及严格签名一致。消息、工具容器和输入区复用公共滚动与排版；设置
  清楚说明仍在内部接入验证。此候选同一原生线程连续三次冷启动续接，标题、固定未发送
  草稿和三个原生轮次一致；Pi/OpenCode 原会话恢复、草稿及保护文件核对通过。900×620
  与常规窗口截图已查看。此次没有完成正式 20 次性能采样；冷续接操作观察约 12 秒，尚未
  分离程序核验／Runtime 初始化／历史恢复耗时，不能沿用 9f13 的性能通过声明。
- **恢复点**：已为 5fab 与当前 7 条 Host 会话、Pi/OpenCode、Codex 私有原生历史及支持的
  状态数据库建立配对备份，认证原位保留；实际替换应用及对应数据后，三路安装续接和
  独立保护核对通过。此配对点验证替代 16b6／40a1 及恢复暂存物，按准确摘要删除已替代的
  QA 备份，保留 schema 7 的 9f13ba 和 schema 8 的 5fab。不是日用数据清理。原程序引用、
  正式应用、认证、既有草稿以及原生 Pi/OpenCode 内容不变。
- **证据位置**：src-tauri/target/codex-connection 下 core-、stop-、owned-stop-、cold-[1-3]-c382、
  paired-restore-5fab、coexist-c382 等记录；安装截图 90–93，93 实测 900×620。保留停止
  未通过记录，不用后一次恢复成功覆盖。以上均为独立 Dev 安装工程 QA，不是正式日用安装、
  本人人工任务或第二成员验收，P5／P6 尚未完成。

#### 2026-09-09 P4 反向复核：冷历史命令条目缺口，需要决定验收范围

- **事实**：c382 三次冷续接恢复了文本和轮次，实时可见的命令条目没有由原生历史返回。
  对固定 c4d748f586a84a3ed5b6aceb82e9a1db4abb1cda 官方源码复核：
  rollout/src/policy.rs 不持久化 ExecCommandBegin/End 事件；app-server-protocol 的
  thread_history.rs 用对应事件重建命令条目。原生 JSONL 有 function_call/output，不能把
  它们当作 API 已返回的展示条目，也不据此编写第二套历史解释器。
- **独立接口试验**：固定 0.143.0 官方程序，在新建的私有临时目录和无认证的脚本化 loopback
  Provider 中执行一条命令，实时返回 userMessage／commandExecution／agentMessage；
  停止并重启后 thread/read(includeTurns=true) 和 thread/resume 都只返回 userMessage／
  agentMessage。再单独试验 schema 中的实验 thread/start.historyMode=paginated，实际
  程序返回 -32601、paginated_threads is not supported yet。该试验失败已保留于
  src-tauri/target/codex-protocol-audit/history-contract-result.json；不是 Farfold 产品接入，
  未接触真实账号／认证／应用 profile，也没有开启产品的新实验 API 或修改 CLI。
- **未知／阻断**：不能宣称冷启动完整恢复所有工具详情，或靠官方历史完整补齐工具事件缺口。
  本次已证实命令条目缺口，不外推所有工具类型均不可恢复；其他版本是否提供稳定完整历史
  仍未知。P4 约定“其余必须能力不在稳定面则阻断 P5，不自动换版本／Agent”，本轮在该
  验收范围决策处暂停 Codex 后续接入；交付一不因此被判失败。
- **待用户决定，尚未采用**：继续固定 0.143.0，把 Codex 首版历史范围明确限定为官方接口
  可恢复的内容，实时工具详情与冷历史缺口如实展示；或坚持完整工具历史门槛，暂缓 Codex
  交付，另行授权兼容版本选型与重新核验。不能暗中升级 CLI、导入默认历史、复制原生 JSONL
  建第二套历史权威，或把 paginated 的 schema 定义写成可用能力。
- **源码提示，尚未安装**：工作台增加官方冷历史可能缺少命令执行详情的说明；此提示不属于
  c382 的三次安装续接证据。最新类型检查、前端 43 文件／196 测试及本切片格式检查通过。
- **2026-09-09 用户决定**：用户同意上述建议，首版继续固定 0.143.0，历史范围限定为官方
  接口可恢复的内容，明确显示冷启动命令详情缺口。此范围决定解除该项 P5 阻断，继续审批、
  Plan 提问与转向等其余核心流程；不代表这些能力或完整接入已验收。不升级 CLI，不增加
  原生 JSONL 历史解释器，其余接口、身份、停止和交付门槛保持。

#### 2026-09-09 P5 原生交互设计与实现中

- 依据固定官方 c4d748f 的 App Server README Approvals/request_user_input、生成 schema 和
  [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，采用会话内展示原生请求、
  原生选项及单次 JSON-RPC 回复；写入后等待 serverRequest/resolved，不能当成执行成功。
  Codex 专属回复类型留在适配器，沿用共享 InteractionRegistry 与 Host attention 生命周期。
- 实现中：命令／文件审批、Plan 提问、expectedTurnId 转向。实验开关仅用于已获批的 Plan
  提问流程；Default 模式提问 feature 仍强制关闭。不采用后台进程实验管理、paginated
  历史、插件执行等其他实验接口。Plan 与工作模式使用同一已核对模型和推理选项。
- 交互身份包含原生线程／轮次／请求 ID 的类型，避免进程重启后数字请求编号重复时与历史
  attention 碰撞。完整安装绑定和 generation 仍独立检查。原生已解决、停止、轮次结束、
  连接失效使旧操作不可再次回复；不自动批准未知请求。
- 目前为源码与自动化阶段，尚未作为安装应用能力验收。后续记录准确候选与真实交互证据。

#### 2026-09-09 P5 安装交互验收与导航修正（进行中）

- **5c1e 安装事实**：Dev 候选
  5c1ec97f51daae5a387f7ebbff8dbd54b60ad1959a8e42ee3dcf6603e9a9a6ff，
  新建 Host session-6e0873f0761c7b8ffeacbceca69dfcbcb2a72808444e94a0c9094e5cfaacf2b0，
  原生线程 01a082ff-b40b-72c1-9d70-17ade8b80982，gpt-5.5／medium，独立
  codex-interactions-0909 Working Copy。通过 UI 完成 7 轮真实请求。
- Plan 原生问题实际回复 North，原生 function_call_output 记录 writing_direction 对应答案；
  命令审批只显示实际 availableDecisions（accept／原生规则建议／cancel），拒绝并中断时
  rejected-command.txt 不存在，单次允许后 accepted-command.txt 精确为 34320a。
  文件原生审批展示收到的 changes 和路径，decline 后 rejected-patch.txt 不存在，accept 后
  accepted-patch.txt 精确为 PATCH-ACCEPTED-0909 加换行。未选择持久规则。
- 原生转向在同一轮次 01a08308-9969-7af1-aeda-7121fa2d515c 生效，最终返回
  CODEX-INSTALLED-STEER-0909-OK。Plan 问题等待期间点击 Stop 后原生中断，旧问题和
  回复按钮消失。Host 共 6 条 interaction attention，5 closed／1 stale；原生轮次和文件
  与 UI 对应。证据 interactions-native-5c1e-independent.json、question/command/file/steer
  的 5c1e AX、截图 94–95；这些是 Dev 工程 QA，不是第二成员或正式日用验收。
- **实际发现**：Pi 侧栏仍仅放行 OpenCode，点击 Codex 报“不支持 Runtime codex”，但用
  Runtime 选择器返回时审批仍在。删除此旧两路分支，跨 Runtime 委托公共入口。返回 Codex
  后冷启动仍选 Pi，确认缺少公共焦点保存；增加 useSessionFocus 和同会话 focus，并在
  开新 Codex 会话前检查已有活动任务，避免跨工作台入口丢失执行上下文。上述修正的最终
  候选 d4f103ee2d8092b828f05fc87f06b3143716cf460b2ed52e7d2f09e074574291 已安装，
  对应安装回归正在执行，不能沿用旧候选声称修正已验收。
- 提问／审批卡片在真实截图中按钮过小、样式未统一，采用现有 permission 配色及主题变量，
  明确按钮、问题组、输入与可展开原生详情。此次不重做整体视觉。
- **检查与恢复**：串行 Rust 全量 278 通过、3 ignored，all-targets clippy／fmt 通过，前端
  44 文件／198 通过，类型／构建通过；5 个既有 reports 格式失败保留。一次并行打包与
  Rust doc-test 共用产物目录导致依赖查找失败，串行重跑已通过，没有改源码绕过测试。
  新建 schema 8 的 5c1e 应用／8 会话及原生历史配对备份，5 份 DB 副本只读 quick_check
  通过，认证原位不复制；该新点尚未实际恢复演练，9f13／5fab 已验证点暂留。

#### 2026-09-09 P5 导航恢复复核与项目文件引用

- **d4f1 安装复核**：同一 Dev 候选新增 Plan 原生问题，实际选择 Alpha 后，原生轮次
  01a0830f-f58f-7c83-8949-e2b46b27507b 完成且答案对应。等待问题时切换 Pi，原草稿
  保留；从 Pi 点击另一条 Codex 会话，明确拒绝切换，当前原生问题和会话仍在。900×620
  下问题可滚动、提交与 Stop 可触达，截图 97 已查看。
- 命令审批等待时 Stop 使旧请求失效；原生中断尚未确认命令终态时保持未知和占用，随后
  通过“停止自有 Codex 连接并核对”恢复同一线程。独立核对 stopped-command-d4f1.txt
  不存在。此场景不证明原生中断单独清理所有后台命令。
- **三次冷续接**：相同 d4f1 安装连续三次退出／重启，均恢复上次 Codex 选择、标题、
  固定未发送草稿及同一线程的九个原生 Turn ID。cold-[1-3]-d4f1 AX 与
  interactions-native-d4f1-independent.json 保留原始观察；不等同于 20 次性能验收。
- **文件引用设计**：核对固定官方 c4d748f TUI chat_composer.rs 的
  insert_selected_file_path/insert_selected_path：普通文件插入路径文本；App Server 的
  mention 用于 app/plugin 绑定，不把它冒充通用文件上传。采用相同路径输入职责，保留
  Farfold 原生文件选择器和自有输入框，不复制上游实现或依赖。官方源码链接：
  [固定版本路径输入](https://github.com/openai/codex/blob/c4d748f586a84a3ed5b6aceb82e9a1db4abb1cda/codex-rs/tui/src/bottom_pane/chat_composer.rs)。
- **实现待安装**：公共 Host 入口按持久会话身份校验 1–16 个当前 Working Copy 文件，
  解析符号链接，拒绝跨目录、失效路径和非普通文件；不读取文件内容，不赋予 Runtime
  权限。Codex 选择后把带转义的可见相对路径加入原草稿，发送后仍由 Runtime 按需读取。
  取消或校验失败保留草稿；异步结果不覆盖已变化的草稿。图片仍仅能引用路径，不宣称
  已作为视觉输入发送。该切片尚未安装验收。
- **77a7 文件引用安装验收**：Dev
  77a7cc442a5a3bef57531f28166eb157cb60c83460b529d5d6b598dc10475e43，取消后原草稿
  保留，目录外 QA 文件明确拒绝；文件选择器多选 `资料 "A".md` 与 `资料 B.md`，带转义
  路径进入同一草稿。原生轮次 01a08324-fedb-7eb2-9fb3-51fd4793e313 实际读取输入并写出
  reference-result.txt，原生工具读回断言通过，独立文件字节为 34320a。第一次把带说明的
  输入直接当整数转换失败，原生模型随后提取整数完成；两个工具输出均保留，没有隐藏失败。
  项目 AGENTS.md 的专用标记实际返回。900×620 截图 99 已查看；截图 98 实为常规窗口。
  reference-native-77a7-independent.json 保留该轮 22 条原生记录与输入／结果。
- 文件引用切片前端 198、Rust 279 通过（另 3 ignored）、类型及 all-targets clippy 通过。
  为保持 Dev 候选同样构建条件，中止一次默认 release 打包后用 `tauri build --debug` 完成
  77a7；没有把被中止的打包视为通过。全仓格式仍为同五份历史报告，不宣称全部检查通过。
- **恢复点已替代**：d4f1 配对恢复实际替换应用及对应数据，Codex 九轮、Pi/OpenCode
  原历史／草稿及保护摘要核对通过；据准确摘要清理已替代的 5fab／5c1e 配对点、恢复
  暂存和 c382／5c1e／8ab1 应用副本，保留 schema 7 的 9f13 与 d4f1 已验证点。
  77a7 新增第十轮已另作当前配对快照，恢复演练继续中，认证保持原位。
- **反向复核发现并修复中**：公共 Runtime 活动快照尚把 Codex 当作未知 Runtime，且
  原生已支持的审批在事件诊断中仍写“尚未接入”。新增适配器投影，区分初始化、任务占用、
  结果未知、确认终态和已核对续接；原生 turn/completed 单独不能释放背景命令状态。
  Host 的 runtimeObserved 只在核对原生 Turn 身份后标记，不代表任务目标完成。
  沿用现有纯数值性能开关，补充 Codex 程序核验／初始化／账号读取、恢复和事件绘制机会
  计时，供 P6 分离耗时；尚未完成正式采样或新候选安装复核。

#### 2026-09-09 P6 三路并发安装验证（进行中）

- **当前候选**：Dev 6fe60ef1a1fae429df965124bc10142bf036fe2afe9222f570f84c48a9441e0d，
  安装与 stage 摘要相同，严格签名通过。前端 44 文件／199、Rust 280 通过（3 ignored），
  类型／构建／fmt／all-targets clippy 通过。五份历史 reports 格式问题未改变。
- **真实并发**：Codex 原生线程 01a082ff-b40b-72c1-9d70-17ade8b80982 的轮次
  01a08337-8950-72c2-92bb-bc140014506f 等待原生 Continue/Pause 回答。Pi 独立目录会话
  01a08332-0ca4-7f24-a79c-319b3de219d7 和 OpenCode 独立目录会话
  ses_f7cca3707ffeRlxd5tt4yvU4q1 先后与它并行，均使用用户指定的 Z.AI GLM-4.5-Air，
  实际读取 input.txt、等待、写 result.txt 并原生读回。独立文件核对输入行与结果标记匹配；
  Pi 初始校验脚本误加了任务未规定的末尾换行要求，已纠正为核对两行实际内容，原字节保留。
- Pi＋Codex 活动时提交第三路 OpenCode，被 Host 容量限制拒绝，提示列明两条任务，
  草稿保留，该原生 OpenCode 会话消息数仍为 0。Pi 完成后 OpenCode＋Codex 两路同时
  存在未结束的 Host capture；两条 Peer 的开始／完成时间均在 Codex 等待轮次内。
- 单独保持 Codex 活动时，恢复相同 Working Copy 的 OpenCode 会话
  ses_f7ccbe3d0ffelNOKWeW0E5osIC 后提交，明确因目录占用被拒绝，没有容量错误混入；
  Working Copy ID 相同、原生消息数仍为 0。随后回答 Continue，Codex 轮次真实完成，
  三条任务均结束。所有 QA 未发送草稿恢复，原有会话／标题／草稿、Pi 原历史、OpenCode
  原消息和认证／正式应用摘要未改变。新建三条 QA 会话列为明确的新增数据，不据此放宽
  原会话保护。p6-*-6fe6 AX 与 independent.json 保留原始证据。
- **性能预检，非正式组**：ShellReady 312ms、SidebarReady 35ms、CodexInstallation
  10799.5ms、CodexInitialize 72.2ms、CodexAccountRead 0.4ms、CodexResume 66ms。
  该一次 Dev 构建观察说明等待主要发生在程序核验；不等同于正式 20 次 p95，也不取消
  每次启动的程序完整性检查。正式采样、剩余原生干预回归和最终配对恢复继续进行。
- **当前构建干预复验**：6fe6 原生轮次 01a08342-5489-7e31-bff8-a37a3c2aeeba，分别
  单次允许命令与文件审批，实际 accepted-command-6fe6.txt 为 `6FE6\n`，
  accepted-patch-6fe6.txt 为 `PATCH-6FE6\n`；原生读回及独立文件核对一致。轮次
  01a08346-3bb9-7881-ba30-ebcb2e7ce99a 在同一轮收到转向并返回新标记；轮次
  01a08347-577d-7e91-a8f4-98bbe18bdefe 等待 Plan 问题时停止，原生 turn_aborted
  与界面中断一致，旧回复操作消失。原草稿恢复。approvals-native／steer-stop-native 的
  6fe6 independent.json 与 AX 分别保留原始来源，截图 100 为 1199×768 常规窗口。
- **恢复点状态更正**：77a7 已完成实际三路配对恢复与保护校验，替代 d4f1；后者及已替代
  的 QA 应用／恢复暂存按准确清单清理。当前保留 schema 7 的 9f13 与 schema 8 的
  77a7。77a7 是并发测试之前的八会话快照，不得覆盖新增三条 QA 会话及后续原生轮次；
  6fe6 的新配对点须覆盖全部 Pi 原生会话，而非仅最初的一份 JSONL。

#### 2026-09-09 P6 固定 Dev 候选性能与实际恢复

- **冷启动正式组**：同一 6fe6 debug 安装，Apple M4／16 GiB／macOS 15.6，常规窗口
  1199×768，连续 20 次退出应用及自有 Runtime 后重新启动。每次恢复 Codex 同一线程的
  14 个 Turn ID，再恢复原 Pi／OpenCode 历史、标题与固定未发送草稿，最后返回 Codex。
  20 次均匹配，无自动重发，100 个对应计时样本均可见、聚焦且未发生可见性变化。
  每次负载与进程退出记录保留；没有运行编译或模型请求，没有丢弃失败／慢样本。
  `cold-20-6fe6-summary.json` 和每次 AX／日志／meta 保存原始依据。

| 指标（各 20 次，毫秒）  | p95（nearest rank） | 最慢 | 超过目标次数 |
| ----------------------- | ------------------: | ---: | -----------: |
| 冷进程可交互            |                 372 |  375 |            0 |
| 侧栏就绪                |                  40 |   44 |            0 |
| Pi 就绪后历史恢复       |                 508 |  535 |            0 |
| OpenCode 就绪后历史恢复 |                1021 | 1296 |            0 |
| Codex 就绪后历史恢复    |                  86 | 2933 |            1 |

- Codex 第 2 次恢复为 2933ms，其中历史就绪前 2909ms、绘制机会 24ms；根因尚未确认，
  保留该慢样本。以上 p95 达到既定指标不代表每次均低于阈值。**Codex 程序校验另计**，
  p95 11296.4ms、最慢 11330.2ms，不能用就绪后恢复指标掩盖启动等待；不取消摘要校验。
  本组没有模型请求，官方恢复内部是否包含额外上游等待未独立暴露，不编造 Provider 耗时。
- **原生流式组**：同一构建、可见聚焦窗口，三路各执行一次 40 行纯文本任务。预先约定
  取每路连续前 20 个事件，Codex／Pi／OpenCode p95 为 31／24／30ms。额外样本全部保留：
  共 1010／1049／984 个，完整组 p95 为 32／37／36ms，最大 35／43／40ms；无超过
  150ms、缺失或后台样本。它们测量 Host 事件到两次 RAF 的绘制机会上界，不代表精确像素
  上屏或 Provider 延迟。Codex 原生报告该任务总计 25277ms、首 token 6951ms，另行记录。
- 三路原生最终答复及 40 个序号、完成标记均独立核对。Codex 新轮次
  01a0835d-0eeb-7a41-a376-51e10aec89d6，Pi 原生 assistant 66fd084d，OpenCode
  原生 assistant msg_0835f78f4001Vb9dtd7G3Ytsae。UI 长文本 AX 截断曾导致检查脚本等待
  超时，原生完整结果及截图 102 已确认；OpenCode 初始检查把 part 外键误当 JSON 字段，
  按实际 `part.message_id` 修正后通过。保留检查局限，不把这些脚本错误写成产品失败。
- **最新配对恢复通过**：6fe6 应用与 schema 8 的 11 条 Host 会话、全部 Pi／Codex 原生
  历史及五份支持的数据库实际替换后，从安装应用核对原 Pi／OpenCode、新 Pi／OpenCode
  和 Codex 15 轮历史、标题、草稿。五份 DB quick_check 均为 ok；3 份 Pi、3 份 Codex
  原生文件、OpenCode 全部消息／条目和 30 份 QA 项目文件未变化，认证原位且摘要不变。
  `paired-restore-6fe6-independent.json` 与五份安装 AX 对应。旧 77a7 配对点及本次恢复
  暂存按准确清单清理；保留 schema 7 的 9f13 和最新 schema 8 的 6fe6，不删除用户 CLI。
- **证据边界**：以上是固定 Dev 安装工程证据。P6 QA release 使用独立 identifier 和新目录，
  其摘要、首启、认证和真实任务必须另行核对，不沿用 Dev 性能值当作 release 值。正式应用
  26b741ca 摘要未变，第二 Mac、本人人工任务和第二成员使用记录仍未取得。

#### 2026-09-09 P6 独立 QA release 准备与测试发现边界

- 新增 `tauri.p6qa.conf.json`，独立应用 `/Applications/Farfold P6 QA.app`，identifier
  `ai.farfold.desktop.p6qa`。最初 16699742 候选确认空 Host 会话、空 Codex 历史、未认证与
  独立程序登记，但性能开关原先只允许 Dev／日用 identifier，未产出计时记录。
  向现有显式允许列表加入 P6 QA，保持默认关闭、纯数值、有界；没有放开任意 profile。
- **当前 QA 候选**：release 可执行 SHA-256
  f424996be98874decc576d3358198ea5866803f4b3736bcc9a5d0ff3de441c04，安装与 stage 一致，
  严格签名通过。App-only ZIP `Farfold-P6-QA-0.1.6-f424996b.zip` SHA-256
  4ebb4ccbe2dd8bafc17e91adbea63511105bfc39f59f2fe5b4e7a1a24757fab9，实际解压、可执行
  摘要与严格签名再核对通过，包内无认证文件。使用与人工回执说明见 `P6-QA.md`。
- QA 更新前保留最初应用／数据快照，认证不复制。原生 Pi 在新目录创建了空 `{}` 认证
  文件，这不代表配置过账号；Codex 仍无 auth 文件和会话历史。更新后原登记保持；
  已观察到 ShellReady 313ms、SidebarReady 22ms、
  CodexInstallation 777ms、Initialize 82ms、AccountRead 1ms。这是一组首启观察，不是
  QA 正式 20 次或与 Dev 的受控因果比较。旧 QA 应用／临时数据快照按清单清理，保留当前
  QA、Dev、正式应用及两个已验证 Dev 配对基线。
- QA 原生账号接口明确返回未登录。通过实际 QA 界面发起官方 ChatGPT 登录，系统默认
  Tabbit 浏览器打开 OpenAI 登录页并进入 Google 登录；需要用户完成认证，已提出异步
  请求。没有复制 Dev／默认 Codex 的令牌。不能把浏览器打开或连接就绪记为认证成功。
  随后 QA 原生接口报告登录失败，账号仍未登录；未取得失败原因，不能擅自归因为超时。
  当前需要操作者在 QA 设置中重新发起并完成独立登录，旧浏览器页面不作为可继续的证明。
- **检查事实**：计时修正后的 Rust 280 通过、3 ignored，fmt 与 all-targets clippy 通过，
  release 打包通过。补跑前端时，Vitest 默认 glob 误收集临时备份中 31 份 Codex 原生插件
  测试：本仓 44 文件／199 通过，但整次命令失败，原始日志保留。该备份误含原生临时
  插件缓存，今后配对点仅收录必要 DB／原生历史／配置，排除 `.tmp` 和缓存。
- 核对本机 Vitest 4.1.11 的 `configDefaults.exclude` 与
  [官方 exclude 说明](https://vitest.dev/config/exclude.html)，新增测试专用
  `vitest.config.ts`，复用 Vite 配置并扩展默认排除项，仅增加 `src-tauri/target/**`；
  测试配置纳入 TypeScript 检查。未增加任意运行平台，也未排除源码目录。
  构建目录探针在修复前实际被发现，修复后准确少这一项，原 44 个源码文件完全相同；
  原生插件副本没有再进入测试。全量重跑 44 文件／199 通过，类型检查通过，探针已删除。
- 全仓 format:check 仍只失败于五份既有生成／历史报告；没有忽略它们或改写报告来制造
  全绿。QA release 的模型任务、正式性能、配对恢复与人工／第二 Mac 验收仍需继续。

#### 2026-09-09 P6 QA 登录、真实任务与成果链接修复

- **认证复核**：用户完成独立登录后，QA 实际“刷新账号状态”读到 ChatGPT Pro；本 QA
  `codex/auth.json` 存在且权限 0600，Codex 目录 0700。没有复制 Dev 或默认 Codex 令牌。
  这替代上一段“当前未登录”的状态，不把认证成功解释为任务成功。
- **f424 真实任务**：从空 Host 历史创建 QA 线程
  `01a0839d-7a55-7fb3-9140-112f7bf53774`，显式选择原生目录中的 gpt-5.5／medium。
  轮次 `01a0839d-f12d-73b2-bbe7-c24868233808` 实际读取五份项目输入，运行测试得到
  `-8 != 42` 的真实失败，修复 calc.py 后同一命令运行 1 项测试通过，测试源码没有变化。
  report.md 实际读回 A=17、B=25、总数=42；项目指令标记和最终标记均对应。
  原生 meta 的 cwd、CLI 0.143.0、originator=farfold、Host 持久身份与 UI 一致。
  `p6qa-code-doc-native-f424.json`、对应 AX 和实际文件保留。该工程任务不代填人工验收。
- **发现并复现**：答复本地文件链接被共享 MessageContent 的普通 `<a>` 当作网页地址，
  AX 显示 tauri://localhost/Users/.../report.md:1；实际点击没有定位成果文件。
  两项 SSR 回归在修复前失败。采用现有消息布局内的“在访达中显示”操作，三路消息组件
  传递已有 Host／原生身份；共享 Host 按持久 Working Copy、原生绑定、文件存在及符号
  链接核对后调用 Finder，不执行文件、不读取内容、不宣称行号跳转。
- **参考与取舍**：核对 [Tauri 官方 Opener](https://tauri.app/plugin/opener/) 及本仓固定
  tauri-plugin-opener 2.5.4 源码的 reveal_item_in_dir，采用系统文件定位能力，不新增依赖
  或编辑器。Codex 原生 Markdown 保留为事实输入；参考前一文件引用切片已核验的固定
  Runtime 路径语义。支持绝对／相对／本地 file URL、编码空格和行号后缀；真实同名
  `:数字` 文件优先，缺失／目录外链接明确失败。不得将目录边界称为完整系统隔离。
- **源码检查**：前端 46 文件／204 项通过，Rust 281 项通过、3 ignored；类型、构建和
  all-targets clippy 通过。新增路径用例曾发现 report.md:2 被误识别为 URL scheme，按
  原始失败修复后全量通过。新 release 正在打包，成果链接修复尚未安装验收；f424 原任务
  证据保留，不沿用为新构建已通过。

- **829c 安装修复通过**：QA release 更新为
  `829c5d91f64f71fdb3c2d64418e03bb1eb791091e32650b0b7d54550d54f9f20`，stage／安装摘要
  一致且严格签名通过。升级前保存 f424 应用／必要数据配对；认证留原位、没有复制缓存。
  新安装恢复原线程，点击旧答复中的空格路径 report.md:1 后 Finder 选中真实 report.md。
  新原生答复轮次 `01a083ab-d032-7551-9796-0222b95b2c88` 的相对文件链接工作，缺失文件
  和目录外文件分别显示准确错误；没有打开网页或更改文件。对应 Finder／负向 AX 已保存。
- **829c 原生干预**：Plan 轮次 `01a083ad-1c37-7f20-9ebc-17b1b856b6d9` 的 Beta
  选择与原生 function_call_output、最终答复对应。轮次
  `01a083af-88b0-7f01-87c0-cd2e90e6b8df` 单次允许命令／文件审批，实际输出分别为
  `829C\n` 和 `PATCH-829C\n`。900×620 文件审批截图已检查，操作与 Stop 可触达。
- 第一次转向操作晚于 25 秒任务结束，实际返回原始标记；新方向留在草稿，没有误发。
  保留 missed-window AX，不写成转向通过。随后 45 秒原生命令活动期间提交转向，轮次
  `01a083b2-b45a-7980-9dee-bc51c6c73dc7` 内追加用户方向并返回新标记。
  等待 Plan 问题时 Stop，轮次 `01a083b4-6836-7052-82bf-f691bb94adfe` 原生中断，旧
  回答操作消失。这不替代后台命令停止语义的独立验收。
- **三次冷恢复通过**：同一 829c QA 退出／重启后，七个原生 Turn ID、标题、固定草稿
  一致；原生 JSONL、认证和项目文件摘要不变，正式应用保持原摘要。第二／三次前检查
  上一轮已记录的自有进程退出。三次可交互 433／447／378ms，侧栏 64／63／59ms，
  Codex 就绪后恢复 121／77／142ms；这是三次回归，不是正式 20 次性能样本。
- **Pi/OpenCode QA 配置**：仅复用此前用户授权测试的 Z.AI API key 到两路独立 QA
  原生认证配置（0600），源凭据不变；Codex 认证不复制。Pi 复用已验证原生 GLM-4.5-Air
  模型条目，原生刷新后显式选择；OpenCode 直接从其原生目录选择同一模型，不升级 Runtime。
  这些是本机 QA 配置，不进入应用／分发包，也不替代第二成员自己的认证。
- **三路成果定位验证**：Pi 原生 `01a083bf-09f6-75e1-9a2d-cd9e0aebb8a3` 和 OpenCode
  原生 `ses_f7c3ea99cffeRXkzXhEAHUqGk2` 在不同目录分别完成代码／文档任务。原生工具
  保留 `-8 != 42` 失败与同一命令 1 项测试通过；测试文件不变，报告总数实际为 42。
  两路报告按钮分别在 Finder 定位正确目录，证明共享修改已经被三路真实使用。
- **资源证据分层**：两路原生工具都读到 AGENTS.md。OpenCode 的报告包含
  QA-RESOURCE-829C，符合该指令未限定位置的要求；Pi 报告和答复都漏掉该标记，保留为
  指令遵循的部分结果，不能声称全部资源语义通过，也不能据此断言 Farfold 没加载文件。
  `p6qa-pi-oc-native-829c.json` 保存 Host 身份、原始消息／工具记录和实际文件。

- **829c 三路并发复核**：Codex 在原生 Plan 问题等待期间，Pi 45 秒任务及随后 OpenCode
  25 秒任务分别在独立目录真实执行，Host 活动记录与原生终态、实际 concurrent.txt 对应。
  Codex＋Pi 活动时第三条 OpenCode 提交被容量权威拒绝，草稿保留且原生消息数量不增加。
  另建同 Codex Working Copy 的 OpenCode 会话，目录冲突明确指向占用任务，原生消息为 0；
  未复制会话或绕过 Host。最后回复原 Codex 问题 Finish，原轮次完成。
  `p6qa-capacity-native-829c.json`、`p6qa-wc-native-829c.json` 与各路并发 AX 保留。
- **829c QA 正式 20 次冷恢复**：Apple M4／16 GiB／macOS 15.6，1199×768；20 次均
  可见、聚焦且未改变可见性，负载逐次记录，缺失 0、剔除 0。nearest-rank p95：可交互
  456ms（max 483）、侧栏 77ms（max 77）；Runtime 就绪后恢复 Codex 149ms（max 154）、
  Pi 1011ms（max 1031）、OpenCode 1312ms（max 1336）。以上对应目标通过。
  程序检查／启动独立报告：CodexInstallation p95 1149.6ms，OpenCodeStart 3035.4ms；
  不把这些时间混入就绪后恢复，也不声称从点击到 OpenCode 可用仅 1312ms。
  本组不发送 Provider 请求，因此没有 Provider 耗时样本。原始 20 组日志、元数据和
  60 份三路 AX 及 `p6qa-formal-829c-summary.json` 保存完整记录。
- 第 21 次只做退出后独立核查、未再启动：所有上一轮自有进程已退出；4 个 Host 会话
  身份、标题和草稿、8 个 Codex 原生轮次、Pi 原生文件、OpenCode 11 条消息／49 条内容、
  全部 QA 项目文件与三路认证摘要一致。以上是准确 QA 构建的工程证据，不代填人工使用。

- **829c QA 流式计时**：每路同一原生会话各发一次无工具文本任务，预先约定取首 20 个
  连续 EventPaint，保留之后全部事件。Codex／Pi／OpenCode 的首 20 个 p95 分别为
  28／46／38ms；全部 648／565／949 个样本 p95 为 32／44／44ms，max 35／46／45ms。
  均可见且聚焦，无可见性改变；低于 150ms 目标。这是 Host 收到事件至绘制机会的观察
  上界，不是 Provider 生成时延或纯 React CPU 耗时。采样原始日志和完整数字分布保留。
- **复核纠错**：Pi 辅助文本节点只返回至第 21 行的一部分，曾被错误解读为原生漏答；
  独立 JSONL 核对及实际滚动截图证明原生与可见界面均有 01–40，立即更正。
  Codex、Pi、OpenCode 各自最终原生文本均有 40 个编号；不能将 OpenCode reasoning
  内容也计入最终正文。原生终态分别完成／stop／stop；本组没有文件修改，三路认证不变。
- **829c 后台停止**：轮次 `01a083e9-185e-7d52-8220-c161bc1bebcd` 执行一次
  sleep 120 后写文件的命令。Stop 后原生轮次中断，但实际 shell／sleep 仍在运行；
  UI 正确保留“结果未知，需要核对”。点击“停止自有 Codex 连接并核对”后，自有 App
  Server、shell 和 sleep 均退出，后续 stop-after.txt 未出现；同一原生线程恢复且草稿保留。
  实际 PID 与 AX、原生记录分别核对，未终止外部 Codex、Pi、OpenCode 或正式应用。

- **829c Pi／OpenCode 干预复核**：Pi 第二次 90 秒命令内显式选择“转向”提交，原生
  当前工具完成后消费转向并输出新标记，之后才消费独立跟进并输出跟进标记；原标记没有
  输出。第一次 45 秒窗口操作晚到，原标记已出现；该次不写成有效转向验收。保留操作中
  按钮名称／消息类型识别失败记录，它们未发送错误消息，不将工具脚本错误当产品缺陷。
  Pi Stop 的原生 bash 结果是 Command aborted，随后原生 assistant stopReason=error，
  工具 isError=true；UI 活动操作解除，不把这个原生停止结尾宣称正常任务完成。
- OpenCode 三次读取 QA 专用目录外文本分别为原生用户拒绝、仅本次允许后的真实内容、
  再次审批等待时 Stop（Tool execution aborted / interrupted=true）。单次允许未变成
  持久授权；切换 Pi 不显示此请求，返回仍可回复；停止后审批消失且“需要处理”为 0。
  首次拒绝后原生直接结束，没有请求中的最终文字标记；以原生错误为准，不伪造答复。
  三次原生 read 的 error／completed／error 记录和 AX 保留，文件摘要不变。
- **829c 当前配对实际恢复通过**：应用和当前 5 个必要数据库、全部 Pi／Codex 原生历史
  及必要配置先保存，再实际替换应用与这组数据，失败可回滚；认证和项目文件原位保护。
  重新启动后核对三路 UI、4 个 Host 会话、10 个 Codex 轮次、Pi 原生文件、OpenCode
  20 条消息／75 条内容、全部草稿及 24 份 QA 项目文件一致，5 个数据库 quick_check 均通过。
  `p6qa-paired-restore-independent-829c.json` 与三路 restored AX 对应。当前恢复点为
  src-tauri/target/paired-recovery-p6qa-829c；不能用已过时的 f424 一会话快照恢复当前数据。
- **界面与清理边界**：另检查当前全屏 1229×768 的长历史末尾、底部输入与导航，原生
  中断如实显示；LifeModel 面板为已停用，入口与 Proposal 语义保留。并未据此声称测过
  所有宽屏尺寸。按准确清单删除已替代 f424 QA 配对副本／ZIP 和恢复暂存；保留最新
  829c 恢复点、schema 7／Dev 的既有配对点、当前 QA／正式应用、外部 CLI 和认证。
  f424 原始任务证据与退役恢复点回执保留。没有清理用户日用数据。

### 2026-09-09 — 0.1.7 收尾、日用升级与保留观察

- **范围决定**：用户确认“都验收了”，并要求先收尾。人工待办依据用户确认关闭，
  不补造第二台 Mac 的机器参数或操作者回执。跨 Agent 交接、协作、LifeModel System
  集成及第四路均暂缓；本轮没有开展这些方向，也没有升级三路 Runtime。
- **交付身份**：`/Applications/Farfold.app` 为 0.1.7，Host schema 8，执行文件 SHA-256
  `c7750c4406075330d83e9c8ad3f7ee3d844113186de034d9160363d08cdd7820`。
  `src-tauri/target/internal-0.1.7/Farfold-0.1.7.zip` 为 152740971 字节，SHA-256
  `ad311d2d70d78054a6c6190beb427996e2fdadb32eb8efe1afa0ad3f03fe6ba0`。
  ZIP 实际重新解压，安装／解压执行文件一致，严格签名通过。包内没有认证文件、Host／
  原生数据库或 JSONL 历史。首次包检查错误地把 SDK 源码中的 sessions 目录当成用户
  历史，已核对目录内容并修正检查，未删除上游 SDK 源码。
- **文字与检查**：共同入口不再把已验收 Codex 标成“接入验证中”，认证／模型／真实
  请求状态仍分开；API key 实际请求、图片、默认模式开发中提问等未验收能力不扩大声明。
  同步 AGENTS、PRODUCT、P6-QA、INTERNAL-USE 及唯一主计划。五份既有报告仅整理格式，
  历史生成说明已澄清外部原稿的字节一致性只对应当时记录。
- **自动化事实**：前端 46 文件／204 项通过；Rust 281 项通过、3 ignored、0 failed。
  format、typecheck、前端 build、cargo fmt、all-targets clippy（`-D warnings`）、
  cargo test 与 release build 均实际执行。Pi 核对后台化后重新运行 Rust 测试、
  all-targets clippy 和 release build；最终文档 format、cargo fmt、git diff --check
  复核通过。日志位于上述交付目录。
- **发现与修复**：初始 9a8c 候选在日用 Pi 续接时超时，进程栈明确显示同步 Tauri
  `reconcile_pi_session` 在 macOS 主线程等待 RPC。改为与已有 OpenCode 接口一致的
  async／spawn_blocking；保留原始相关请求、5 秒期限、generation 与身份校验，没有
  延长期限、自动重发或另建空会话。
  参考 [Tauri 官方异步命令](https://v2.tauri.app/develop/calling-rust/#async-commands)，
  并核对固定 Pi 0.84.3 的既有 RPC 请求／响应实现；这是 Host 执行线程调整，不改 Runtime。
- **未知仍保留**：c775 替换后有一次相同 5 秒超时，不能仅由上述主线程修复解释。
  同一 Pi 二进制、日用原生会话、目录及启动命令组独立运行约 0.49 秒全部响应；
  这只缩小调查范围，不能算安装应用成功。后续 c775 正常入口连续三次冷续接通过，
  包含打开后立即续接，另一次应用／数据实际配对恢复后续接也通过。失败 AX 与进程栈
  全部保留；不删除失败样本，不据此宣称启动超时已彻底消除或达到新一轮 p95 目标。
  该观察继续开放，若再现应优先捕获首次失败期间的相关请求与进程栈，不能以重试成功关闭根因。
- **用户数据检查**：升级前实际验证 0.1.6 应用／schema 7 数据配对恢复，再升级到 schema 8。
  随后保存并实际恢复 0.1.7 当前配对。原 3 条 Host 会话的持久绑定、标题、归档和草稿不变，
  仅 last_opened_at 随续接更新；2 份 Pi JSONL、OpenCode 21 条消息／33 条内容、8 份
  认证／配置及 5 个项目文件保持。两库 quick_check 通过，没有在用户项目发送新任务。
  归档列表存在且状态不变；不把数据库保持扩大成归档会话本轮全部重新执行。
- **证据层次**：原 829c QA 应用摘要不变，其三路真实任务、原生干预、并发及 20 次性能
  证据仍只属于 829c。本轮 c775 的证据是源码检查、日用升级、原 Pi 续接、数据完整性、
  打包与配对恢复；没有给 c775 补写三路全量付费任务或正式 20 次性能采样。
  日用 Codex 目录尚未创建，不导入 QA／Dev／默认环境的认证；日用需用户独立配置。
- **恢复与清理**：保留本轮 schema 7 升级前配对与当前 schema 8 配对，位于交付目录的
  daily-0.1.6-pair／daily-0.1.7-pair；两者均只由相应应用与数据一起使用。凭据原位保护。
  清单核对后删除两份被替代应用及两次恢复的 displaced 暂存，保留当前 QA／Dev 配对、
  原始失败证据、项目、外部 CLI 和用户配置。未来已产生新用户数据时不可直接回滚此快照。

### 2026-09-11 — system Runtime 身份续接修复

- **OpenCode system installation 身份链**：OpenCode 运行态连接现在携带实际
  `RuntimeBinding`，事件路由、permission response、Provider auth/model idle lock、
  session reconciliation、supervisor snapshot、existing-session reopen 与 provider projection
  均使用当前 Session/connection identity，不再把 system binary 的事件或配置写回
  bundled installation。`opencode_active_turn` 不再用 bundled installation 过滤 system
  OpenCode active turn；事件结算仍要求 routed event 的 product/installation/generation/native
  session 精确匹配。新增回归证明 system OpenCode active/reconcile 可用，bundled 事件不能结算
  system turn，system routed busy/idle 才能释放占用；既有 two-active-turn 与 same-working-copy
  限制继续通过。
- **Pi external launch reference**：不改 Pi Runtime/Agent loop，只改 Farfold Host 与
  `pi-sidecar-wrapper.sh`。Pi `StartOptions` 可携带已验证 system `RuntimeBinding` 与 binary；
  wrapper 优先执行 Host 传入的 `FARFOLD_PI_RUNTIME_BINARY`，否则仍回 bundled。Pi running
  state、事件路由、native session registration、remember_session、open/create Session、
  stop/status/supervisor 均按当前 binding 处理；system Pi 启动前仍重新校验保存的安装路径、
  canonical path、version、artifact SHA 与 connection identity。
- **验证边界**：本轮完成源码与自动化验证，尚未把这些改动打包成新的 installed QA candidate，
  也未碰正式 `/Applications/Farfold.app` 或正式数据。已执行：`corepack pnpm typecheck`、
  `corepack pnpm test`、`corepack pnpm build`、`cargo fmt --check --manifest-path src-tauri/Cargo.toml`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked`、`git diff --check`。全量 Rust
  为 298 passed / 3 ignored；前端为 48 files / 222 tests。`corepack pnpm format:check`
  仍被既有 reports 文件阻断，主要是 2026-09-09 的 HTML 有不匹配 closing tag，另有报告
  Markdown/HTML 需要 Prettier；该失败不作为本轮 Runtime 身份修复的通过证据。
- **isolated P6 QA candidate 观察**：使用 `src-tauri/tauri.p6qa.conf.json` 打包
  `Farfold P6 QA.app`，产物位于
  `src-tauri/target/release/bundle/macos/Farfold P6 QA.app`，bundle id 为
  `ai.farfold.desktop.p6qa`；未替换或移动正式 `/Applications/Farfold.app`。实际启动 P6 QA
  后确认窗口标题为 “Farfold P6 QA”，切换到 Pi 并在不发送模型任务的情况下完成一次新建
  Pi 会话，QA profile 最新 session 为 bundled Pi `01a08c22-c820-7924-81b3-b3eb040fb1eb`，
  标题“新对话”。随后退出并重开同一 candidate；进程存在、主线程采样显示正常 AppKit
  event loop、QA 数据库 `pragma integrity_check` 为 ok、schema 为 10，但 CUA 对重开窗口的
  AX/screenshot 连续超时，因此“重开 UI 可见恢复”和 move-flow 尚不能写作通过。P6 QA
  candidate 进程已停止；该观察是 QA 阻断记录，不是正式应用验收。
- **OpenCode ACP 实验通道**：新增 shared ACP stdio transport 与独立
  `opencode-acp-stdio-v1` adapter identity，当前只用于实验入口，不替代 bundled
  OpenCode 1.15.13 的 HTTP/SSE 日常路径，也不修改生产兼容常量。Host 对请求使用
  correlation id、bounded pending、timeout 与 late-reply/drop 统计；断连、写入失败、
  EOF 或 stop 后均返回“结果未知/需重新核对”，不会重发未确认请求。原生 ACP event 以
  `kind=acp` 原样包入 Runtime event router，并保留未知 envelope；应用退出会清理自有
  ACP 子进程。
- **ACP fixed candidate evidence**：隔离 npm 平台包
  `opencode-darwin-arm64@1.18.30` 的二进制 SHA-256 为
  `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`。显式 ignored
  集成测试在传入该二进制路径时重新核验 `--version=1.18.30` 与 SHA，随后以隔离
  HOME/XDG/OPENCODE_CONFIG_DIR 启动 `opencode acp --pure --cwd`，完成
  `initialize(protocolVersion=1)`、`session/new`、`session/load`、`session/close` 与
  子进程退出清理；未发送 prompt 或付费模型请求。最初缺少 `protocolVersion` 时收到
  JSON-RPC `-32602`，按 `@agentclientprotocol/sdk` 与 OpenCode 1.18.30 源码修正。
- **ACP UI boundary**：OpenCode workspace 新增小型“ACP 实验连接”面板，可选择经
  SHA/version 固定的候选程序并触发 start/new/load/close/stop；面板显示独立 adapter、
  connection、session 和 lastError。该入口不启用 Composer，不把 ACP session 写作
  日常 Host Session，也不复用正式认证/数据目录；后续要进入日常 OpenCode 能力仍需
  单独完成 prompt、permission、native history 与 installed QA 可见恢复。
- **ACP P6 QA package / UI observation**：重新打包 P6 QA，产物仍为
  `src-tauri/target/release/bundle/macos/Farfold P6 QA.app`，release build 通过且未替换
  正式应用。启动后进程为 bundle id `ai.farfold.desktop.p6qa`，主线程采样位于 AppKit
  event loop；CUA `getApp("Farfold P6 QA")` 再次超时。替代 System Events 只确认到
  进程名，未返回窗口名；QA profile 数据库 integrity 为 ok，但该新 profile 当时没有
  `schema_migrations` 表。因此本轮只能写作“包内命令可编译、进程可启动、CUA/窗口可见性仍
  阻断”，不能写作 ACP 面板 installed UI 已人工可见验收。P6 QA 进程已停止。
- **ACP protocol/lifecycle 修复**：按 system debugging 复核，根因不是单个按钮，而是
  早期 ACP 实验命令把 Tauri command 线程直接绑定到同步进程/IO 和最长 15 秒等待，
  且 `new/load/close` 等会话操作等待响应时持有 lifecycle mutex；stdin pipe 不被
  Agent 读取时，`write_all` 也可能先于 response timeout 卡住。现改为 async Tauri
  command + `spawn_blocking`，lifecycle 只短锁取得连接句柄；ACP transport 拆出独立
  writer thread，调用侧只等待有界 write ack 和 response。stop 会先摘除连接并在锁外
  清理自有进程，不等待 pending session operation 完成。
- **ACP session identity / unknown 结果**：`close_session` 不再预先 `take()` native
  session id；只有 close 成功确认后才清空绑定。close 失败或超时时保留原 session id 和
  lastError，标记结果未知/需重新核对；active session 未确认关闭前拒绝 new/load 覆盖。
  会话操作带 pending token，晚到结果若已被新状态取代会被丢弃，不覆盖后续连接状态。
- **JSON-RPC / reverse request boundary**：ACP outbound request 现在带
  `jsonrpc:"2.0"`，inbound response/notification/request 必须声明 JSON-RPC 2.0；
  缺失或错误版本会使连接失败并保留未知结果。server 反向 client request 进入事件队列
  作为原生 envelope 保留，同时立即以 JSON-RPC `-32601` 明确拒绝；权限/提问等未实现能力
  不被宣称支持，也不会被静默当 notification 丢掉造成 Agent 挂起。
- **ACP isolation 修正与验证**：应用内 ACP 实验启动不再使用真实用户 HOME，而是使用
  Farfold QA profile 下的 `opencode-acp-experiment/home`，并继续设置隔离
  `OPENCODE_CONFIG_DIR` 与 XDG 目录；这与真实候选集成测试的临时 HOME/XDG 环境一致。
  已新增回归覆盖：late reply/drop、反向 request 明确拒绝、缺 JSON-RPC 版本失败、
  子进程不读 stdin 时 write timeout/stop 不死锁、close 失败保留 session id、active
  session 阻止 new/load 覆盖。显式真实候选测试继续通过
  `initialize/session-new/session-load/session-close/cleanup`，没有 prompt 或付费模型请求。
- **ACP second P6 QA package / UI observation**：完成上述修复后再次打包 P6 QA，release
  build 通过，产物仍为 `Farfold P6 QA.app`，未替换正式应用。启动后 pid 81051 为
  `ai.farfold.desktop.p6qa`，主线程采样仍在 AppKit event loop；CUA 读取 QA 应用继续
  `timeoutReached`。System Events 只确认进程名，未返回窗口名；QA profile
  `host.sqlite3` integrity 为 ok。该证据仍只证明包可编译启动，不能证明 ACP 面板 installed
  UI 可见验收。QA 进程已停止。
- **ACP write/stop boundedness 修复**：复核发现上一版 timeout 未覆盖 `sync_channel`
  enqueue 等待，`begin_stop` 也可能在同一满队列发送 Shutdown 时阻塞。现改为调用侧
  `try_send` 循环直到同一 deadline，队列饱和直接拒绝且标记 pending frame cancelled；
  已超时或已取消的 frame 即使 writer 后续有机会处理也不会再执行。stop 不再通过满队列
  发送 Shutdown，而是摘除 sender、标记连接失败并在独立 stop deadline 内清理子进程。
  server 反向 request 的 `-32601` 回复使用 best-effort 非阻塞写入；该写入失败不误杀
  Host 请求通道。新增饱和队列 + concurrent stop、子进程不读 stdin、reverse request
  压力下 response 仍先被消费的回归。
- **ACP Host registration / navigation**：`session/new` 与 `session/load` 成功确认后，
  ACP 会话会注册同一个 Host Runtime/installation/build/adapter/connection 身份：
  product `opencode`，adapter `opencode-acp-stdio-v1`，distribution `System`，
  connection kind `SystemLocal`，observed version `1.18.30`，artifact SHA 为固定
  `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`。随后按现有
  Host Project/WorkingCopy/native Session 规则注册 Farfold Session、mark opened，并把
  `HostNavigationSnapshot` 返回给前端 `replaceHostNavigation`。新增回归证明导航
  restore state、Farfold Session、native Session、WorkingCopy canonical path、adapter
  与 connection identity 一致。close 仍只在 ACP 成功确认后清空当前 native binding。
- **ACP frontend projection**：ACP 原生事件现在允许通过 Host runtime event router 进入
  OpenCode workspace 的现有未知事件保留路径；前端将 `kind=acp` 计入 unknown event，
  显示“保留原始事件、未推断含义”，但不把它当作 SSE/transport 连接中断，也不触发
  bundled OpenCode Server 的 native activity 重读。当前面板仍是过渡实验入口：可
  start/new/load/close/stop 和展示 Host Session id，但 Composer/prompt、permission
  交互、ACP native history 正式渲染仍未接通，不能宣称可通过 ACP 发送任务。
- **本轮验证**：未触碰正式 `/Applications/Farfold.app`、正式日用 profile 或用户认证。
  已执行 `cargo test --manifest-path src-tauri/Cargo.toml --locked acp`，结果 13 passed /
  1 ignored；显式真实候选
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.HiO90q/platform/package/bin/opencode`
  运行 ignored 集成测试，`initialize/session-new/session-load/session-close/cleanup` 通过，
  未发送 prompt 或付费模型请求。全量验证：`corepack pnpm typecheck`、`corepack pnpm test`
  48 files / 223 tests、`corepack pnpm build`、`corepack pnpm format:check`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked` 309 passed / 4 ignored 均通过。
  前端 build 仍有既有 >500 kB chunk warning；本轮不把它作为性能通过或失败证据。
- **ACP public open / cold restore route**：公共 Host Session 打开路径现按完整
  RuntimeBinding 分流。`product=opencode` 且 adapter `opencode-acp-stdio-v1` 的会话不再
  落入 OpenCode Server system 分支；Host 会先读取 persisted
  `system_installation_launches`，核验 launch JSON kind、adapter、version、SHA、selected
  path、当前二进制 `--version` 与 SHA，再用同一 QA profile 下的隔离 HOME/XDG/config
  启动 ACP 并对 persisted native Session 执行 `session/load`。成功后仍由公共
  `mark_session_opened` 返回唯一 `HostNavigationSnapshot`；前端侧栏/冷启动 restore 选中
  ACP 会话时采用 ACP status/adopt，不再读取 OpenCode Server provider/history，也不要求
  用户再次输入 native Session id。失败时不发送 prompt，保留 Host 会话与草稿，并停止
  本次自有 ACP 进程。
- **ACP prompt / cancel 第一段**：依据官方 ACP v1 文档，Host 新增
  `host_opencode_acp_turn_submit` 与 `host_opencode_acp_turn_abort`，分别发送
  `session/prompt` 与 `session/cancel`。submit 只在短 Host lifecycle 锁内完成
  target 校验和 Turn admission；长 `session/prompt` 请求在锁外等待，因此停止请求不会
  被提交线程自身挡住。ACP prompt 不接 LifeModel 注入、不需要 Provider/model 字段。
  完成响应释放 Turn；断线/超时标记 unknown 并保留占用恢复语义；取消请求只确认
  notification 写入，最终结果仍等待 prompt response 或进程终止证据。前端 active ACP
  session 可通过公共 Composer 发送文本和 Stop，但当前 transcript 仍只保留 raw/unknown
  原生事件，尚未完成正式内容分段渲染或权限 UI。
- **reverse request 拥塞语义修正**：反向 request 先进入 bounded 原生事件队列，再尝试把
  JSON-RPC `-32601` unsupported response 非阻塞排入 writer 队列。若 writer 队列已满或
  已断开，连接立即进入失败/未知并保留已收到的反向 request；若已排队，reader 不等待
  write ack，因此容量内的反向 request 压力不会阻塞后续普通 response 处理。新增回归
  分别覆盖容量内 response 先被消费、容量外失败连接且保留事件。
- **当前证据与欠项**：库测试与 fixture 已覆盖 ACP new/load/close、公共 Host 注册、
  fixed launch 记录保存/核验、prompt/cancel 方法接线、prompt 断线 unknown、反向权限请求
  unsupported 与拥塞失败。真实固定 OpenCode 1.18.30 候选仍只完成无模型
  `initialize/session-new/session-load/session-close/cleanup` 和 launch reverify；没有真实
  Provider/model prompt 验收。installed P6 QA 可见 UI/CUA 恢复仍未通过，不能写作安装应用
  用户流程完成。下一步仍需把 `session/update` 的 user/agent chunk、tool call、permission
  request outcome 与 cancelled permission response 投影进正式前端交互，并补 installed
  app 可见恢复证据。
- **本轮追加验证**：`cargo test --manifest-path src-tauri/Cargo.toml --locked acp` 为
  16 passed / 1 ignored；显式真实候选 ignored 测试通过并重新核验 persisted launch。
  全量验证通过：`corepack pnpm typecheck`、`corepack pnpm test` 48 files / 223 tests、
  `corepack pnpm build`、`corepack pnpm format:check`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked` 312 passed / 4 ignored、
  `cargo fmt --check --manifest-path src-tauri/Cargo.toml`、`git diff --check`。
- **ACP 长任务与实时事件纵切**：`session/prompt` 不再复用 15 秒控制请求 timeout。
  prompt 写入仍使用有界 write deadline；写入后 Host pending request 保持到原生
  `session/prompt` 终态响应、明确断连/stop 失败或用户停止，不把正常运行超过控制超时当作
  unknown。完成前的 `session/update` 与 `session/request_permission` 由每连接后台 event
  pump 持续消费并路由到 `RuntimeEventRouter`，不再依赖 status/new/load/close 的被动
  drain，也不要求前端轮询 status 才可靠接收流式事件。
- **ACP 权限交互**：`session/request_permission` 现在先登记真实 JSON-RPC request id，再把
  原生 envelope 路由为 Host pending interaction；用户点击前不发送 outcome。前端权限卡显示
  Agent 提供的原生 `optionId/name/kind`，回复命令按 Farfold Session、native Session、
  RuntimeBinding、generation 和 request id 校验后只回复一次
  `{"outcome":"selected","optionId":...}`。Stop 会对当前 session 的未决 ACP 权限回
  `cancelled`，并关闭 Host pending interaction；断连、切会话或 stale generation 不会自动授权。
  不支持的非权限反向 request 仍明确 unsupported/fail，不宣称为通用 ACP client surface。
- **ACP 前端投影**：OpenCode workspace 的 ACP `session/update` 不再一律作为 unknown。
  `agent_message_chunk` 投影到 assistant message，`tool_call` / `tool_call_update` 投影到现有工具
  activity，`plan` 以完整计划摘要替换显示，`usage_update` 暂作为 passive。未知 ACP method 或未知
  `sessionUpdate` 仍保留 raw event 并提示未适配；这不是 native history 完整恢复证据。
- **本轮纵切验证**：新增 fixture 证明 prompt 未结束前已经收到 chunk/tool/permission，用户点击前
  未发送 permission outcome，点击后才回复 selected，Stop 时 pending permission 回复 cancelled，
  断连仍标 unknown，旧 generation 完成不会释放当前连接。验证通过：
  `cargo test --manifest-path src-tauri/Cargo.toml --locked acp` 19 passed / 1 ignored；
  `corepack pnpm vitest run src/runtime/opencode-conversation.test.ts src/runtime/opencode.test.ts`
  27 passed；`corepack pnpm typecheck`；`corepack pnpm test` 48 files / 224 tests；
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`；
  `cargo test --manifest-path src-tauri/Cargo.toml --locked` 315 passed / 4 ignored；
  `corepack pnpm build` 通过但仍有既有 >500 kB chunk warning；真实固定 OpenCode 1.18.30 候选
  ignored 测试仍只覆盖无模型 initialize/new/load/close/cleanup，未发送付费 prompt。installed P6
  QA 可见 UI/CUA、真实 Provider/model prompt 和公共模型配置绑定仍是后续必需项。
- **ACP session configOptions 第一段**：依据官方 ACP v1 `configOptions` /
  `session/set_config_option` 语义，Host 现在保存 `session/new` / `session/load` 返回的完整
  configOptions，并吸收 prompt 期间 `config_option_update` 的完整替换状态。前端 active ACP
  会话在 header 中优先显示 category `model` 的 select；没有 model 时才显示
  `model_config` / `thought_level`，再没有则明确写作使用 Agent 默认配置，不制造 Provider/model
  列表。用户选择会调用 `session/set_config_option`，并校验 Farfold Session、native Session、
  RuntimeBinding 与当前 generation。该接线仍不是共享 Provider 凭据读取或真实付费 prompt 验收；
  下一步需要把 Host Provider projection 与 ACP model config 的配置版本关系补齐。
- **ACP configOptions / permission 竞争保护**：`session/request_permission` 现在保存原生
  request id 和 Agent 提供的 optionIds；前端只能回传这些原生 optionId，未知 option 被拒绝。
  写入前失败保留 pending request 以允许重试，写入后收到 unknown 不允许第二次授权，避免 late
  reply 后重复批准。Stop 会对当前 ACP native Session 的未决权限回复 `cancelled`，并关闭
  Host pending interaction。`session/set_config_option` 只允许在当前 Farfold Session /
  native Session / RuntimeBinding / generation 匹配且无 active Turn 时执行；返回后再次核对
  generation、binding、native Session 和最新 operation id，旧 session update 或晚到旧操作
  不能覆盖当前模型选择。
- **ACP native_unmanaged Provider 投影**：前端把 ACP select 型 model config 记录为
  Host Provider connection source `native_unmanaged`，fingerprint 只来自 ACP adapter、
  installation、connection、config id 和当前值；不读取、不复制、不代理 OpenCode 原生凭据。
  对应 Host projection 标记为 saved/applied/not_requested，并用
  `current_task_keeps_bound_config` 表达活动任务边界。ACP Composer 在存在 model config 时会等待
  该映射写入完成；提交 `host_opencode_acp_turn_submit` 时附带 provider connection/config version
  以及 ACP runtime provider/model id，Host 通过既有 `turn_provider_bindings` 记录本次 Turn 使用的
  配置版本。该证据只证明“本次任务绑定到哪个原生 ACP 配置版本”，不是 Farfold managed Provider
  请求验证，也不是真实付费 prompt 成功。
- **本轮验证**：通过 `corepack pnpm typecheck`、`corepack pnpm vitest run
src/runtime/opencode-conversation.test.ts src/runtime/opencode.test.ts
src/runtime/provider-projection.test.ts` 35 passed、`corepack pnpm test` 48 files / 224 tests、
  `corepack pnpm build`、`corepack pnpm format:check`、`cargo fmt --check --manifest-path
src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked acp` 23 passed / 1 ignored、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked` 319 passed / 4 ignored、`git diff --check`。
  显式真实候选
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.HiO90q/platform/package/bin/opencode`
  仍只覆盖无模型 `initialize/session-new/session-load/session-close/cleanup`。本轮未替换正式应用、
  未触碰正式 profile 或用户认证，仍未完成 installed P6 QA 可见 UI/CUA 恢复、真实 Provider/model
  prompt、ACP native history 冷恢复完整渲染或成果审阅验收。
- **managed Provider Host 权威修正**：撤回“前端可串联写 Host connection、再自报 applied”的错误边界。
  `managed_provider_api_key_save` 现在由后端规范化 endpoint（只允许 http/https，去除 username /
  password / query / fragment 和尾部 `/`）、派生完整 connection id。2026-09-11 复查发现上一包
  “写 current credential 后再 upsert Host，失败时删除 written.path”的实现会在更新已有连接且 Host
  写失败时删除旧有效凭据；“瞬时 require_runtime_idle 后 spawn native apply”也不能阻止任务开始
  race。因此撤回“任务开始 race 不能再覆盖”的超证据结论，改为下列新证据。
- **不可变 credential revision 与恢复策略**：API key 现在写入不可变
  `<connection>.<credential-revision>.secret.json`；`<connection>.json` 只保存无秘密 current pointer /
  metadata。保存时使用同进程短锁串行化同 profile 的提交顺序：写新 revision、发布 pointer、提交
  Host DB；若 Host upsert 失败，只在 current pointer 仍指向本次 revision 时恢复旧 pointer，并只删除本
  操作拥有的新 revision。DB 已提交的 provider config version / credential revision 是 list 与 apply 的
  权威；current pointer 只是非秘密显示缓存。`managed_provider_connection_list` 现在直接枚举 Host DB
  中已提交的 `farfold_managed` connection，再按其当前提交 revision 读取 metadata；pointer 丢失或损坏
  不再隐藏已提交连接。提交前中断留下的 orphan revision 或未提交 pointer 不会作为可应用连接暴露。新增测试覆盖已有
  key 更新失败仍读回旧 key、两次并发 save 只暴露一个提交 current revision、orphan revision 不进列表、
  重启后即使 pointer 指向未提交 v2，list / secret apply 仍读取 DB 已提交的 v1，以及删除 / 损坏 pointer
  后仍可列出 DB 已提交连接。
- **managed Provider 应用防 stale / race**：OpenCode Server 与 Pi 的后端 apply 命令都要求 provider
  connection id、read-time provider config version、operation id、Runtime product / installation /
  connection、runtime provider/model id。现在新增 TurnCoordinator 的 Runtime product + installation
  scoped Provider application reservation：apply 开始前登记短期占用，同安装任务 admission、同安装第二个
  apply、以及所有活动 operation id 复用都会被拒绝；错误/超时/返回通过 RAII 释放。后端调用原生入口前后
  仍核对当前 Host config version，只有匹配时才写 target projection 为 applied。新增 TurnCoordinator
  测试覆盖 apply 占用期间任务不能开始、同连接两次 apply 不能交错、同安装不同 connection 也不能交错、
  operation id 不能复用、旧 release token 不能释放新的 operation。
- **OpenCode / ACP managed 边界**：OpenCode Server 路径仍只允许默认
  `https://api.openai.com/v1` 通过既有 native auth change 应用；custom endpoint 会保存 managed
  connection，但不能冒充已应用。ACP 路径没有写原生 secret/model 的 ACP API；现在新增
  `opencode_acp_experiment_new_managed_session`，只在 ACP 停止时读取 Host DB 已提交的 managed
  connection/version，按 provider config version 派生独立 runtime connection，把原生
  HOME/XDG_DATA_HOME/XDG_STATE_HOME/XDG_CACHE_HOME 放入长期 profile root，把含 key 的
  OPENCODE_CONFIG_DIR/XDG_CONFIG_HOME 放入本次 operation launch-config root。启动失败或未登记前失败只删除本次
  config root；成功 stop 且传输层确认正常退出后也只删除 config root，不删除 native session/profile
  数据；stop 失败不删除可能仍被使用的目录。launch-config operation 目录现在必须由本次操作新建，若同名目录已存在则拒绝覆盖残留。
  `session/new` 只有在 native `configOptions` 当前 model 与
  options 都确认 `<providerConnectionId>/<modelId>` 后，才把该 Host provider version 对当前 ACP
  installation/connection 记录为 `applied`。从侧栏冷恢复已改为先用 Host Session 的 runtime connection
  反查 applied/历史 managed provider version，再用同一版本 profile root 和 `session/load` 恢复；Provider
  更新后旧会话继续绑定旧 config version，新会话使用新 version。`session/load` 完成时不再重写当前
  provider projection，因此旧会话恢复不会被 current v2 的 stale guard 拒绝，也不会把当前应用/验证状态倒写回
  v1。当前已运行会话不重启、不换 key；任务提交读取 status 中后端确认的 managed provider 绑定，不再从前端
  selector 同名推导。
- **OpenCode ACP API contract 证据**：2026-09-11 对固定 `opencode-ai@1.18.30` /
  `opencode-darwin-arm64@1.18.30` 平台包做本地 fixture 探针：`@ai-sdk/openai-compatible` 实际向
  `<baseURL>/chat/completions` 发送 OpenAI Chat Completions streaming 请求，`Authorization` 使用配置中的
  Bearer key，请求 body 的 `model` 为配置的模型短 id。由此 OpenCode ACP managed 保存入口使用
  `openai-chat-completions`；`openai-responses` 保留为 Pi 旧路径，不能用于固定 1.18.30 的 OpenCode
  openai-compatible provider。本轮新增 ignored 可复跑测试
  `fixed_opencode_acp_program_reads_managed_private_config_without_model_turn` 与
  `fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model`，均使用
  `/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode` 真实固定二进制、fixture
  key 和私有 launch/profile；后者只打本地 HTTP fixture，确认 path/key/model，不触发真实付费网络。新增
  `fixed_opencode_acp_managed_session_stops_cold_restores_old_version_and_new_uses_current` 串同一内部产品路径：
  save v1 -> 真实固定二进制 managed `session/new` -> Host 注册 -> 正常 stop 删除自有 config 且保留 profile
  -> save v2 -> 重开 HostStore/runtime -> 侧栏 open `session/load` 恢复 v1 同一 nativeSession -> 本地 fixture
  通过 `host_opencode_acp_turn_submit_blocking` 共用 admission -> `turn_provider_bindings` -> native prompt ->
  finish 路径提交，故意传入 v2/伪造前端 provider 字段仍落库 v1 provider version 且 fixture 收到 v1
  key/model；新建 v2 会话省略前端 provider 字段仍落库 v2 provider version 且 fixture 收到 v2 key/model，1
  passed，无付费网络。ACP dynamic binding 的提交 openability 只过滤静态 `runtime_build_not_current` blocker；
  archived、working copy、native session 和 active runtime binding 仍逐项核对。
- **共享 managed Provider 与 Pi 映射**：Pi bridge 的 0.84.3 capability 路径允许 `openai-completions`
  与 `openai-responses` 两种 `models.json` API；`scripts/provider-probe.test.mjs` 通过本地
  Chat Completions fixture 证明 Pi SDK 会按选中 model 调用 `openai-completions`。因此 Pi 设置页的共享入口改为
  “共享 OpenAI-compatible”，默认保存 `openai-chat-completions`，应用到 Pi 时映射为 Pi custom provider
  `openai-completions`；旧 `openai-responses` 保存连接仍映射为 Pi `openai-responses`，不盲目互转。Pi 仍需要先通过既有
  `models.json` custom provider contract 写入 provider/model 定义（不写 secret），再由后端读取
  managed secret 并通过 Pi `ModelRuntime.login(..., api_key)` 做认证。应用必须绑定当前
  Host Session 的 installation/connection；后端现在核对当前 Pi runtime binding 与输入目标一致，并要求
  Pi runtime provider id 等于 Host provider connection id，拒绝前端任意伪造 provider id。后端
  `managed_provider_apply_pi` 现在先从同一 Host managed provider version 读取 endpoint/apiKind/model/context/max
  和 reasoning/image/developer-role/reasoning-effort 能力字段，通过 Pi capability bridge
  `upsert_custom_provider` 写入 typed `models.json` provider/model 定义，再读取同一 version 的 secret 执行
  `ModelRuntime.login(..., api_key)`，最后记录 Host projection；前端不再在 managed 保存或复用路径直接调用
  `upsertCustomProvider`。新 managed Provider 保存要求 context window、max tokens、reasoning、image input、
  developer role 与 reasoning effort 都来自用户可见的显式字段；旧文件缺省值仅作兼容读取，不能再把硬编码
  false/true 描述为“显式配置”。若 Pi `models.json` upsert 已写入但后续 login 失败或超时，当前版本目标仍匹配时
  Host 会把目标投影标记为 `failed` 并记录原因，不留下旧 applied 状态冒充成功。
- **saved connection UX**：OpenCode 和 Pi 的共享 Provider 设置页现在都会读取
  `managed_provider_connection_list`，显示已保存的非秘密连接，并允许用户不重新输入 API key 直接应用
  选中连接。OpenCode 设置页新增“新建 ACP 会话”动作：在已选择固定 ACP 二进制、项目目录且 ACP 未运行
  时，使用保存连接启动新的 managed ACP 私有 launch；当前已运行 ACP 会话不被重启或换 key。OpenCode
  Server 的保存连接应用仍受默认 endpoint 限制；Pi 保存连接应用现在只请求后端 apply，由后端写入当前 Pi
  custom provider 定义并走 secret login，定义已使用保存连接的 apiKind 映射和显式能力字段。
- **installed P6 QA attempt / evidence boundary**：完成代码层修正后用
  `FARFOLD_P3_QA=1 VITE_FARFOLD_HOST_SHADOW_QA=1 corepack pnpm tauri build --config src-tauri/tauri.p6qa.conf.json`
  重新打包独立 `Farfold P6 QA.app`，产物位于
  `src-tauri/target/release/bundle/macos/Farfold P6 QA.app`，bundle id 为
  `ai.farfold.desktop.p6qa`，ad-hoc signed CDHash
  `bbc995a0e55c5b49db7a56da917abbb8f99d0d3b`；未替换或移动正式 `/Applications/Farfold.app`。
  启动后 CUA `getApp("Farfold P6 QA")` 仍超时，但 System Events 能看到 bundle id
  `ai.farfold.desktop.p6qa`、进程名 `farfold` 和窗口标题 `Farfold P6 QA`。截图
  `.design-qa/2026-09-11-opencode-acp-managed/01-p6qa-launch.png`、
  `02-after-permission-key.png`、`03-after-cg-click.png` 显示 macOS “Farfold P6 QA 想访问 桌面
  文件夹中的文件” 权限弹窗遮挡主界面；AppleScript、键盘确认和 CGEvent 坐标点击均未能可靠关闭该系统弹窗。
  因此本次 installed QA 只证明独立包可构建、可启动且窗口可见；实际设置页、关闭恢复、错误展示和侧栏
  open UI 仍被系统权限弹窗 / CUA timeout 阻断，不能写作安装应用验收通过。检查后未发现仍在运行的
  P6 QA 应用进程。后续 Host submit / Pi apply 代码修正只完成源码、单元、fixture 和构建验证，尚未重新打包并启动
  installed P6 QA。随后新增更隔离的 QA 配置 `src-tauri/tauri.p6qa.shared.conf.json`，bundle id
  `ai.farfold.desktop.p6qa.shared`，product name `Farfold P6 QA Shared`，未触碰旧 P6 QA 或正式 profile；
  构建产物为
  `src-tauri/target/release/bundle/macos/Farfold P6 QA Shared.app`，ad-hoc signed CDHash
  `6231790d65aa103be573214fddec278d7b467325`，执行文件 SHA-256
  `aef157b1c413a1585e0f026ee99fa1248690dad01950396c0420876ac516e9cf`。CUA 能读取该安装 QA 窗口，
  初始侧栏为空、Provider 设置可打开。通过 UI 保存本地 fixture managed OpenAI-compatible 连接后，非秘密
  pointer 与 Host DB 显示同一 `provider_connection_id` / model / endpoint / context / max / capability 字段；
  UI 重新打开后“已保存连接”列表显示 `OpenAI / qa-shared-ui / gpt-shared-ui`，secure key 字段为空，证明未回填
  API key。第一次测试发现无当前 Pi Host Session 时 apply 失败在 modal 内静默；已修复 ProviderSettings
  的 managed save/apply 错误展示，重建同一 QA app 后点击“应用已保存连接”可见错误
  `Error: 当前没有可验证的 Pi Host Session，不能应用到目标 Runtime。`。本轮 installed QA 仍未完成
  “选择项目 -> Pi apply/probe -> OpenCode ACP 新会话/恢复/继续”的完整可见流，不能写作安装三路验收通过。
- **本轮验证更新**：通过 `corepack pnpm typecheck`、`corepack pnpm test` 49 files / 232 tests、
  `corepack pnpm build`（仍有既有 >500 kB chunk warning）、`cargo fmt --check --manifest-path
src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked` 342 passed / 8 ignored、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked managed_provider` 15 passed、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked pi_capabilities` 5 passed、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp` 15 passed / 5 ignored、
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode cargo test --manifest-path src-tauri/Cargo.toml --locked fixed_opencode_acp_program_reads_managed_private_config_without_model_turn -- --ignored --nocapture` 1 passed、
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode cargo test --manifest-path src-tauri/Cargo.toml --locked fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model -- --ignored --nocapture` 1 passed、
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode cargo test --manifest-path src-tauri/Cargo.toml --locked fixed_opencode_acp_managed_session_stops_cold_restores_old_version_and_new_uses_current -- --ignored --nocapture` 1 passed、
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode cargo test --manifest-path src-tauri/Cargo.toml --locked fixed_shared_saved_connection_drives_pi_bridge_and_opencode_acp_without_reentering_key -- --ignored --nocapture` 1 passed、
  `corepack pnpm vitest run src/runtime/managed-provider.test.ts scripts/provider-probe.test.mjs` 2 files / 11 tests；
  新增 provider-probe 覆盖同一 Pi bridge 进程内 `upsert_custom_provider` -> `login_api_key` ->
  `test_connection`，本地 Chat Completions fixture 收到 saved key 和 selected model，证明 shared saved
  connection 能经 bridge 复用而不重新输入 key；新增 fixed shared ignored 测试覆盖 temp Host DB 内保存一次 ->
  list 同 id/version -> Pi apply/probe -> OpenCode ACP managed session/turn，fixture 同时收到 Pi probe 与
  OpenCode prompt 的同一 Bearer key / model。ProviderSettings 错误展示修复后再次通过 `corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/managed-provider.test.ts scripts/provider-probe.test.mjs` 2 files / 11 tests、
  `corepack pnpm format:check`，并重建 `Farfold P6 QA Shared.app`。通过 `git diff --check`。本轮仍未用真实 key 发送模型请求，未替换正式应用、
  未触碰正式 profile 或用户认证。
- **2026-09-11 P6 QA Shared 可见流补验与缺口**：按监督复核要求修正 fixture 与断言后，固定
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode`
  的 shared ignored 测试连续 10 次通过。修正点包括：fixture 只在成功解析请求后返回成功响应，
  解析失败记录非敏感 `_readError/_parseError`；Pi / OpenCode 请求用各自窗口分别断言 path、Bearer
  存在、model 和消息，不再用总请求数证明来源；Pi capability bridge 的调试 fetch wrapper 不再通过
  `new Request(input, init).text()` 消耗原始 body，并返回非敏感 dispatch / bridge identity 摘要。
  随后重建独立 `Farfold P6 QA Shared.app`，bundle id 为 `ai.farfold.desktop.p6qa.shared`，
  ad-hoc signed CDHash `a544307056a1d3b6b755020053edbfd95ed53ad5`，执行文件 SHA-256
  `f3a24876d771a34046600b91ce1433270ce57fc27769e47463f7d58d53047a64`，包内
  `pi-capability-runtime/bridge.mjs` SHA-256 与源码资源同为
  `a7b577b6cf91fcfbcc40623fe20db2fed4c83d2cc8881b4be908563412c36957`；仍未替换正式
  `/Applications/Farfold.app`。
- **installed QA 可见证据**：本地 fixture 固定在 `http://127.0.0.1:50302`，只记录非敏感请求摘要；
  QA Shared profile 的 saved connection 仍显示 `OpenAI / qa-shared-ui / gpt-shared-ui`，secure key
  字段为空。通过 macOS 打开面板选择非 Desktop 项目 `/private/tmp/farfold-p6qa-shared-project`。
  前两次 Pi 启动仍复现 `Pi Runtime version check timed out`，第三次创建 Host Pi session
  `01a08d6d-6547-77f7-8a6f-a6a6ff819046`；直接执行同一 QA 包内 `pi-runtime/pi --version`
  五次均 0.23–0.32s 返回 `0.84.3`，所以该超时仍是保留观察，不能写成已修复。应用 saved connection
  后，Pi 模型菜单可见 `OpenAI 已连接 · gpt-shared-ui`，选择 managed provider 模型后发送
  `PI-SHARED-UI-0911-B`，fixture 收到 Pi 请求 path `/chat/completions`、Bearer 存在、model
  `gpt-shared-ui`、消息含 marker；Pi 原生 JSONL 写入 assistant `ok PI-SHARED-UI-0911`，Host
  `turn_provider_bindings` 记录两条 Pi turn 绑定到同一 managed provider/version。第一次 Pi 请求因
  fixture 只接受 `/v1/chat/completions` 而返回可见 404，此后修正 fixture 接受 Pi 实际 path。
- **OpenCode ACP 可见证据与剩余问题**：OpenCode 面板选择固定 `opencode` 1.18.30 后，普通
  ACP “新建”能创建 Host/native session，但输入仍禁用，因为该入口不是 managed saved connection。
  通过 OpenCode Provider 设置页“新建 ACP 会话”使用 saved connection 创建 managed ACP；修复
  `OpenCodeWorkspace` 在 ACP new/load 结果后未激活 returned Host binding、Composer 仍只看普通
  OpenCode Server `status.running` 的前端缺陷。最终可见 UI 顶部显示 `OpenAI/gpt-shared-ui`，输入启用，
  发送 `OC-SHARED-UI-0911` 后 fixture 收到 OpenCode 请求 path `/chat/completions`、Bearer 存在、
  model `gpt-shared-ui`、消息含 marker；Host `turn_provider_bindings` 记录 OpenCode turn 绑定到
  managed ACP connection `connection-cd865ac9d72a2588f7845902a57c916ae01351eb1ce24285614c2c33d42237d4`。
  停止 ACP 后进程列表未见固定 1.18.30 ACP 进程，Host session
  `session-254731da311e272ead86d6b7cfb6a4e32d67fe280a6e4d8ad6b838a996777a36` 与 native session
  `ses_f72844e54ffepD6OoZXCgfsuOo` 保留。重启 QA Shared 后侧栏恢复该 Host session，但 ACP 程序路径
  和 native session 输入未自动恢复；手动重新选择二进制、启动 ACP 并载入同一 native session 返回
  `ACP 请求失败（错误码 -32603）`。因此当前不能写作 OpenCode ACP 停止后完整恢复/继续通过；另一个
  UI 缺口是 ACP response 文本未在主 transcript 中清晰渲染，当前成功证据来自 fixture、Host binding
  和原生/请求层。
- **2026-09-11 P6 QA Shared OpenCode ACP 闭环补验（后续复审核降级）**：针对上条失败继续修正，不删除失败记录。
  根因分层为：侧栏恢复 ACP session 时前端在 `session/load`/早期事件之后重置 conversation，冷历史和早期回放被抹掉；
  ACP composer/恢复仍依赖普通 OpenCode Server `status.running` 与普通 reconciliation generation；
  `agent_message_chunk` 缺少 native `messageId` 时使用固定本地 id，跨 turn 可能合并；capability bridge
  probe 详情曾返回完整 URL/body/messages/prompt，生产摘要过宽。修正后，ACP restore 先激活 Host binding
  再打开 Host session，不在 `openHostSession` 后重置 conversation；ACP 活动态读取改用
  `opencode_acp_experiment_status` 与 Host 侧私有 DB 读取 `opencode_acp_session_messages`，不再用普通 OpenCode server
  reconciliation 判定 managed ACP 会话；本地 chunk id 按 turn 分配并在 idle 时 settle；`bridge.mjs`
  probe dispatch 只返回协议、host、path、query/userinfo 布尔、auth 布尔和 body 结构摘要，不返回原始消息或 prompt。
  新增/更新测试覆盖 ACP 多轮无 messageId chunk 分离、scrubbed provider probe、ACP cold restore/history
  与 session controller ACP openability。2026-09-11 后续架构复审确认：该补验仍把 Host 私有读取
  OpenCode `opencode.db` 作为历史恢复补偿，因此只能证明“安装态闭环可见恢复曾被补偿到可用”，不能证明
  ACP-only 的 `session/load` 历史恢复架构通过。
- **最终 QA Shared 包身份**：使用
  `FARFOLD_P3_QA=1 VITE_FARFOLD_HOST_SHADOW_QA=1 corepack pnpm tauri build --config src-tauri/tauri.p6qa.shared.conf.json`
  重建 `src-tauri/target/release/bundle/macos/Farfold P6 QA Shared.app`。bundle id
  `ai.farfold.desktop.p6qa.shared`，ad-hoc signed，未 notarize，CDHash
  `ad8495f684b9f86c5715e7349fa7f4d9bbde8a95`，执行文件 SHA-256
  `11b782c5d8eb91515451a7a0ca3ec52d2973634fac137c3cd6db222573a3dad8`。包内
  `Contents/Resources/pi-capability-runtime/bridge.mjs` SHA-256 与源码
  `src-tauri/capability-bridge/bridge.mjs` 同为
  `3891b224b29aa2811cd8981e9c4798f2b5a1293671081d781c2c9198feb2f23b`。未替换正式
  `/Applications/Farfold.app`，未触碰正式 profile 或用户认证。
- **最终 installed visible closed loop**：在同一最终 QA Shared 包中，本地 fixture 为
  `http://127.0.0.1:50302`，只记录非敏感摘要，并使用标准 OpenAI streaming `finish_reason: "stop"`。
  使用侧栏恢复 managed OpenCode ACP Host session
  `session-b3607a35cce26e292ea1bf4df48363f977d4fde341792171908edc1dd3c60b06` / native session
  `ses_f728742b3ffeSZr1myXN6DVjYy`，界面显示 `OpenAI/gpt-shared-ui`、`opencode-acp-stdio-v1`、输入启用，
  无需手工填 nativeSession 或重新选择二进制。发送
  `final clean loop first OC-FINAL-1. Reply briefly.` 后主 transcript 可见同一用户消息和单条
  `ok OC-FINAL-1`。随后点击“停止 ACP”，退出应用，进程列表未见固定 1.18.30 ACP sidecar；重新打开同一
  `Farfold P6 QA Shared.app`，点击侧栏同一个 ACP 会话后自动恢复第一轮历史，再发送
  `final clean loop second OC-FINAL-2. Reply briefly.`，主 transcript 可见 `ok OC-FINAL-2`。fixture
  记录 OpenCode prompt 请求 path `/chat/completions`、Authorization 存在、model `gpt-shared-ui`、
  第二轮 roles 为 `["system","user","assistant","user"]`。第一轮 fixture 另有 title agent 请求，因此不能写作
  “每个用户 turn 只有一个 Provider HTTP 请求”；可见主回复和 native history 为单条。
- **最终检查**：通过 `corepack pnpm format:check`、`corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/opencode-conversation.test.ts scripts/provider-probe.test.mjs` 2 files /
  24 tests、`cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture` 15 passed /
  5 ignored、`cargo test --manifest-path src-tauri/Cargo.toml --locked session_controller -- --nocapture` 8 passed、
  `git diff --check`、以及上述 QA Shared Tauri release build。Pi 早前两次
  `Pi Runtime version check timed out` 与 post-replacement `Pi RPC get_state request timed out after 5000 ms`
  仍是独立保留观察，不能由 OpenCode ACP 闭环补验覆盖或描述为已修复。

- **2026-09-11 OpenCode ACP-only history 修正与 installed visible 复验**：按架构复审移除 Host 对
  OpenCode 私有 `opencode.db` 的读取接口，删除前端 `loadAcpHistory` 路径和 Tauri
  `opencode_acp_session_messages` 命令；Host 不再维护 Runtime 私有 Agent DB history bypass。后端仍只通过
  OpenCode ACP 官方 `session/load` 载入原生 Session，并保留 ACP raw event 到 Host runtime event router。
  前端修正为：ACP Host session 打开前先绑定目标 Runtime/build/connection/session；runtime event 不再被
  view-scope 暂停误丢，而是只按 product/installation/adapter/runtimeBuildId/connectionId 过滤；ACP restore
  不再先调用普通 OpenCode `openCodeRuntimeStatus` 或普通 history；`user_message_chunk` 按连续 chunk
  分组为用户消息；`available_commands_update` 只作为 passive 能力列表更新，不再作为 prompt 完成或结果已知证据。
  冷恢复和 prompt 完成分别由 Host `session/load` 操作完成与 `session/prompt` response settle。固定 OpenCode 1.18.30
  后端 ignored 测试确认 `session/load` 会回放两轮历史的 `user_message_chunk`、`agent_message_chunk`、
  `available_commands_update`，该断言禁止回退到 private DB read。
- **ACP-only 最终 QA Shared 包身份**：使用
  `FARFOLD_P3_QA=1 VITE_FARFOLD_HOST_SHADOW_QA=1 corepack pnpm tauri build --config src-tauri/tauri.p6qa.shared.conf.json`
  重建 `src-tauri/target/release/bundle/macos/Farfold P6 QA Shared.app`。bundle id
  `ai.farfold.desktop.p6qa.shared`，ad-hoc signed，未 notarize，CDHash
  `0f4368e8297eb5c18d7f2bac0289d3cf9bd4f75e`，执行文件 SHA-256
  `e77b9cc28fc53369f04a7f27d848905214f9bcc47d79ba5b8806c792d58cbcdd`。包内
  `Contents/Resources/pi-capability-runtime/bridge.mjs` SHA-256 与源码
  `src-tauri/capability-bridge/bridge.mjs` 同为
  `3891b224b29aa2811cd8981e9c4798f2b5a1293671081d781c2c9198feb2f23b`。`rg` 确认
  `src`、`src-tauri`、`scripts` 内已无 `opencode_acp_session_messages`、`read_acp_session_messages`、
  `loadAcpHistory` 或 `opencode.db` 私有 history 路径引用。
- **ACP-only installed visible multi-turn closed loop**：在上述最终 QA Shared 包内，使用本地 OpenAI-compatible fixture
  `http://127.0.0.1:50302` 和 managed OpenCode ACP connection
  `connection-cd865ac9d72a2588f7845902a57c916ae01351eb1ce24285614c2c33d42237d4`。新建 managed ACP Host session
  `session-7584b3e847f554bffa80322e7a8aff694da30497bf5075c3de7562c0ab46cf10` / native session
  `ses_f71b80669ffe0apZSln75CoCbR`，状态文案显示 `OpenCode ACP 已连接`。发送
  `acp multi first ACPMULTI-1. Reply briefly.` 与 `acp multi second ACPMULTI-2. Reply briefly.` 后，主 transcript
  依序可见两条用户消息、`ok ACPMULTI-1`、`ok ACPMULTI-2`。退出应用并确认固定 1.18.30 ACP sidecar 不在进程列表后，
  重新打开同一最终包，点击“继续对话”触发 ACP `session/load`，主 transcript 恢复两轮用户消息和两条回复，输入框可用，
  未因 `available_commands_update` 卡在工作中。继续发送 `acp multi third ACPMULTI-3. Reply briefly.` 后主 transcript
  可见第三轮用户消息与 `ok ACPMULTI-3`；fixture 记录第三轮 OpenCode prompt 请求 path `/chat/completions`、
  Authorization 存在、model `gpt-shared-ui`、roles 为 `["system","user","assistant","user","assistant","user"]`，
  证明第三轮请求使用了由官方 ACP replay 恢复的两轮上下文。另有 title-agent 请求存在，不能写作每个用户 turn 只有一个
  HTTP 请求。
- **ACP-only 最终检查**：通过 `corepack pnpm format:check`、`corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/opencode-conversation.test.ts src/runtime/host-shadow.test.ts scripts/provider-probe.test.mjs`
  3 files / 49 tests、`cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture` 15 passed /
  5 ignored、固定 binary
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode cargo test --manifest-path src-tauri/Cargo.toml --locked fixed_opencode_acp_managed_session_stops_cold_restores_old_version_and_new_uses_current -- --ignored --nocapture`
  1 passed，以及上述 QA Shared Tauri release build。Pi 启动 timeout 与 post-replacement
  `Pi RPC get_state request timed out after 5000 ms` 仍是独立保留观察，不能由本次 OpenCode ACP-only 修正覆盖。

- **2026-09-11 OpenCode ACP intervention contract audit**：按官方 ACP v1 文档复核干预边界：
  initialization 要求 Client 明示 `clientCapabilities`，省略能力按 unsupported 处理
  （https://agentclientprotocol.com/protocol/v1/initialization）；permission 使用
  `session/request_permission`，Client 在 prompt cancel 时必须以 `RequestPermissionOutcome::Cancelled`
  回复待处理 permission（https://agentclientprotocol.com/protocol/v1/schema#requestpermissionrequest）；
  prompt cancel 通过 `session/cancel` 收束，原 prompt 可返回 `stopReason: "cancelled"`
  （https://agentclientprotocol.com/protocol/v1/cancellation）；原生问答/结构化输入属于
  `elicitation/create`，只有 Client 在 `clientCapabilities.elicitation` 明示 form/url 后 Agent 才能请求
  （https://agentclientprotocol.com/protocol/v1/elicitation）。当前 Farfold 对固定 OpenCode 1.18.30 的
  `initialize` 仍发送 `clientCapabilities: {}`，因此不声明 elicitation 支持，也不把 permission approval
  伪装成 native question；遇到非 permission 反向请求继续以 JSON-RPC unsupported error 回复并保留 raw event。
- **OpenCode ACP intervention implementation**：ACP permission 回复输入新增 `runtimeGeneration`，前端只提交原生
  `optionId` 与当前 ACP generation；后端用 Host Session binding、native Session、当前 connection/generation、
  InteractionRegistry pending request 与 ACP transport 原生 `optionId` 集合共同校验，只有真实待处理请求可回复一次。
  UI permission card 保留 OpenCode 原始 options 顺序，主按钮只按原生 `kind=allow_once` 优先、否则
  `allow_always`，不再把“数组最后一项”假定为主操作。`session/prompt` 返回
  `stopReason: "cancelled"` 时 Host turn 不再记为正常 accepted，而是进入 unknown/已取消提示并保留草稿，不自动重发。
- **OpenCode ACP real-agent permission probe**：重新下载隔离 npm 平台包
  `opencode-darwin-arm64@1.18.30` 到
  `/tmp/farfold-opencode-acp-1.18.30.7C34UR/platform/package/bin/opencode`，核验 `--version=1.18.30`
  与 SHA-256 `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`。使用隔离
  HOME/XDG/OPENCODE_CONFIG_DIR、临时 workspace、本地 OpenAI Chat Completions fixture 和固定二进制运行真实
  `opencode acp --pure --cwd`：第二个模型请求包含 9 个工具
  `apply_patch,bash,glob,grep,read,skill,task,todowrite,webfetch`；fixture 返回 `read` tool call
  `filePath=/etc/hosts` 后，真实 OpenCode 发出标准 `session/request_permission`，options 为
  `once(allow_once)`、`always(allow_always)`、`reject(reject_once)`；回复 `once` 后 tool_call completed，
  agent message `done`，prompt result `stopReason=end_turn`。该探针证明真实固定 Agent 的 permission surface
  可被本地 fixture 驱动，但不是 QA Shared 可见 UI 验收。
- **OpenCode ACP intervention checks so far**：通过 `corepack pnpm format:check`、`corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/opencode-acp.test.ts src/runtime/native-interaction-reply.test.ts src/runtime/native-stop-request.test.ts src/runtime/opencode-conversation.test.ts src/runtime/host-shadow.test.ts scripts/provider-probe.test.mjs`
  6 files / 58 tests、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture` 17 passed / 5 ignored、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked session_controller -- --nocapture` 8 passed，以及固定二进制
  `fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model`、`fixed_opencode_acp_managed_session_stops_cold_restores_old_version_and_new_uses_current`
  各 1 passed。仍未完成新包的 QA Shared 可见 permission/cancel/restart 验收；该项必须另行记录，不能由脚本探针替代。
- **OpenCode ACP intervention package / installed visible permission evidence**：真实 QA 发现固定 OpenCode 1.18.30
  反向 `session/request_permission` 可使用数值 JSON-RPC id `0`，原 transport 只接受字符串 id，导致 QA Shared
  首次 `PERM-UI-1` 显示 `OpenCode 结果未知` 与 `ACP 反向请求 id 必须为字符串`。修复后 ACP transport
  与 InteractionRegistry 接受字符串或整数 id，内部按稳定 key 去重，但回复保留原生 JSON-RPC id 类型；新增
  `numeric_reverse_permission_id_is_replied_with_original_json_rpc_id` 覆盖该兼容性。使用
  `FARFOLD_P3_QA=1 VITE_FARFOLD_HOST_SHADOW_QA=1 corepack pnpm tauri build --config src-tauri/tauri.p6qa.shared.conf.json`
  重建 QA Shared，产物为
  `src-tauri/target/release/bundle/macos/Farfold P6 QA Shared.app`，bundle id
  `ai.farfold.desktop.p6qa.shared`，ad-hoc signed CDHash
  `bc5aa5d3da53a704f568176ae6a0a2a56c4e1930`，执行文件 SHA-256
  `a9c37d453cecb46f8e2bf0decb5561818d25fe40be42191400cad70c0f808f2c`，bridge source/package
  SHA-256 均为 `3891b224b29aa2811cd8981e9c4798f2b5a1293671081d781c2c9198feb2f23b`。在该包中通过
  saved managed OpenCode ACP connection `connection-cd865ac9d72a2588f7845902a57c916ae01351eb1ce24285614c2c33d42237d4`
  恢复 Host session `session-f37b6fcd87ed79f9a80155c0bb976c83b6a5ef814fe859b52ea239c25b3622e7` /
  native session `ses_f7193d94bffebpdBGvljaJrWar`，状态显示 `OpenCode ACP 已连接`。本地 fixture 驱动
  `PERM-UI-3` 读取 `/private/tmp/farfold-acp-ui-permission-target-3.txt`，UI 显示原生权限卡
  `允许 /private/tmp？`，raw envelope 含 `toolCallId=call_read_perm_ui_3`、locations 与 rawInput，
  按原 options 展示 `Allow once`、`Always allow`、`Reject`，点击 `Allow once` 后权限卡消失、待处理归零、
  主 transcript 显示 `done PERM-UI-3`；fixture 第二次请求包含 marker 后的 assistant/tool 角色，证明工具结果回到
  Agent。`PERM-UI-4` 同路径族点击 `Reject` 后权限卡消失、待处理归零、输入恢复可用；fixture 未收到 marker 后
  tool-result/final 请求，不能写作 Agent 已生成优雅拒绝回复，但可证明本次 UI 没有误允许或继续执行读取。
- **OpenCode ACP cancel visible gap**：同一 native session 中继续做 `CANCEL-PERM-UI-1` 时，历史拒绝与本地 fixture
  组合触发 OpenCode 重复向模型请求同一个 tool call，UI 停在正在提交；点击“停止”后 Host 显示
  `OpenCode ACP prompt 已取消；不会自动重发。`、`提交结果未知，输入已保留。请核对状态或停止当前任务；不要重复发送。`，
  但 5 秒后仍是 `停止中...` / `任务进行中`，不满足“无 hanging work placeholder”和“cancel 后同一 working copy
  立即开始下一 turn”的 installed visible 验收。最终通过“停止 ACP”收住实验连接，状态回到 ACP 未启动。该失败样本
  不能由 Rust/Vitest 的 cancel 单元测试替代；下一步需要在干净 native session 复现并修正 prompt cancel
  收敛、重复 tool-call 抑制或 OpenCode 终止确认路径。
- **OpenCode ACP intervention final checks**：计划补记后重跑通过 `corepack pnpm format:check`、
  `corepack pnpm typecheck`、`corepack pnpm vitest run src/runtime/opencode-conversation.test.ts src/runtime/opencode-acp.test.ts src/runtime/native-interaction-reply.test.ts src/runtime/native-stop-request.test.ts src/runtime/host-shadow.test.ts scripts/provider-probe.test.mjs`
  6 files / 58 tests、`git diff --check`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked acp_transport -- --nocapture` 12 passed、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture` 17 passed / 5 ignored、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked session_controller -- --nocapture` 8 passed。使用
  `OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.7C34UR/platform/package/bin/opencode`
  单独重跑固定二进制 `fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model` 与
  `fixed_opencode_acp_managed_session_stops_cold_restores_old_version_and_new_uses_current` 各 1 passed。`pgrep`
  未发现残留固定 OpenCode ACP sidecar。Pi 启动 timeout 与 `Pi RPC get_state request timed out after 5000 ms`
  仍是独立保留观察，不能由本次 OpenCode ACP permission/intervention 修正覆盖。
- **OpenCode ACP confirmed cancel 修正**：复核官方 ACP prompt turn cancellation 语义后，确认
  `session/cancel` notification 只是请求取消；Agent 终止操作、发送完 pending updates 后，以原
  `session/prompt` response 的 `stopReason="cancelled"` 确认终态。上条可见卡住的直接 Host 根因是
  `host_opencode_acp_turn_submit_blocking` 把这一 confirmed cancellation 当作 unknown 并提前返回，绕过
  `verify_active_session` 和 `TurnCoordinator::finish`，测试
  `host_acp_submit_treats_cancelled_prompt_as_unknown_not_accepted` 又断言 active turn 保留，从而固化
  working copy 占用。修正后 `HostOpenCodeTurnSubmission` 新增明确 `cancelled` outcome；后端只有在
  Host binding、native session、working copy 和当前 runtime generation 核验通过后释放对应 turn，
  否则仍降级为 unknown 并保留占用，不允许迟到旧代次取消释放新 turn。前端 submit 收到 `cancelled` 后
  settle ACP conversation、显示已取消、不写成任务成功；abort 通知返回只在当前仍 working 时写“等待原生
  prompt 响应”，避免迟到请求回执覆盖已确认终态。保留 transport 断线/超时 unknown 语义，没有添加重复
  tool-call 抑制器或接管 OpenCode Agent 决策。
- **OpenCode ACP confirmed cancel package / verification**：使用
  `FARFOLD_P3_QA=1 VITE_FARFOLD_HOST_SHADOW_QA=1 corepack pnpm tauri build --config src-tauri/tauri.p6qa.shared.conf.json`
  重建 QA Shared；产物 `src-tauri/target/release/bundle/macos/Farfold P6 QA Shared.app`，bundle id
  `ai.farfold.desktop.p6qa.shared`，ad-hoc signed CDHash
  `9915fcaae0346db331d4efa5b630cd71c56a9d21`，执行文件 SHA-256
  `f7d4ed986afda0cc4b2455325ff5eaaf87cbcfac3ec8d4bdc360d17d63e26753`，package/source bridge SHA-256
  均为 `3891b224b29aa2811cd8981e9c4798f2b5a1293671081d781c2c9198feb2f23b`。本地代码验证通过
  `corepack pnpm format:check`、`corepack pnpm typecheck`、`corepack pnpm vitest run src/runtime/opencode-conversation.test.ts src/runtime/opencode-acp.test.ts src/runtime/native-interaction-reply.test.ts src/runtime/native-stop-request.test.ts src/runtime/host-shadow.test.ts scripts/provider-probe.test.mjs`
  6 files / 58 tests、`git diff --check`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked acp_transport -- --nocapture` 12 passed、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture` 17 passed / 5 ignored、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked session_controller -- --nocapture` 8 passed，以及固定
  OpenCode 1.18.30 二进制两项 ignored 集成用例各 1 passed。随后打开新 QA Shared 包，确认二进制选择可恢复
  OpenCode 1.18.30；但 CUA 对主面板“新建”/“停止 ACP”按钮点击未产生 session/status 变化，Provider 设置中
  managed ACP 新建仍因当前 running/unmanaged 状态被禁用，未能完成干净 installed visible cancel 验收。已手动
  终止 QA Shared 产生的固定 OpenCode ACP sidecar `/private/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/.../opencode acp --pure --cwd /private/tmp/farfold-p6qa-shared-project`。因此本条只关闭代码层 confirmed cancel 卡住根因；
  “生成中取消、等待权限时取消、快速重复停止、取消后同 working copy 新回合、取消中退出重开”的最终 installed
  visible 验收仍需在可稳定创建 clean managed ACP session 后补验。
