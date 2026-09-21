# Farfold 多 Runtime × 最简 LifeModel：耦合与开发顺序建议

> 2026-09-12 文档校正：本文件保留当时的研究、交接或验收记录。正文中的“当前”、Pi-only / Pi 唯一 Runtime、未采用适配器、未完成或下一步等描述仅对应原记录时点，不是当前执行指令。正式 0.1.7 已支持 Pi、OpenCode、Codex；OpenCode ACP 的 C 阶段已通过 Dev 工程出口，D Pi 仅部分实现、普通 ACP 工作台未接通，E 未开始。开发和自动续接已按用户要求暂停。最新状态以[唯一活动计划](../../plans/runtime-neutral-lifemodel.md)和[正式使用说明](../../INTERNAL-USE.md)为准；不得按旧报告重做已完成工作或清理当前用户数据。

日期：2026-08-30；R0 技术证据更新：2026-08-31
状态：产品合同与 D1 顺序已于 2026-08-31 获批；实现尚未开始

## 1. 建议结论

推荐顺序不是“先把所有 Runtime 做完”或“直接在现有 Pi 事件上做 LifeModel”，而是：

```text
完成多样 Runtime 合同 PoC
          │
          ▼
冻结最小 Runtime Adapter / provenance 合同
          │
          ▼
把现有 Pi 放到合同后面，保持 UI/UX 与原生语义不变
          │
          ├──────────────▶ 最简 LifeModel 垂直切片（Pi 首个来源）
          │                         │
          ▼                         │
接入第一个非 Pi Runtime             │
          │                         │
          └──────────────┬──────────┘
                         ▼
             跨 Runtime 贡献/消费闭环
```

也就是：**先用研究消除合同不确定性；随后做一个很薄的 Runtime-neutral seam；然后按用户当前优先级实现最简 LifeModel；再接入非 Pi，并用它验证 LifeModel 真正跨 Runtime。**

当前已经完成 Codex、OpenCode 与 Kimi Code 三个非 Pi D2，并用三种官方边界验证 C1/U1；第三种协议校准已经完成。R0 剩余的不是另一个探针，而是产品层决定：冻结第三方条款、批准首个 Adapter，并把未来合同正式写入 `PRODUCT.md`、`AGENTS.md` 与唯一 active plan。

## 2. 当前正式合同与未来方向的冲突

当前仓库正式事实仍是：

- `AGENTS.md`：Pi 是唯一 Agent Runtime；不得实现第二 Agent loop；Gate 0 没有 LifeModel；
- `PRODUCT.md`：Farfold 依赖 Pi 原生 Provider、model、Session、工具、权限和 compaction 语义；
- `plans/gate-0.md`：当前交付完成条件只覆盖 Pi-native 桌面闭环。

而研究后的未来方向是：

- Farfold 成为拥有完整 UI/UX 的 Runtime-neutral host；
- 用户在创建 Session 时选择 Agent Runtime，Session 保持原生绑定；
- LifeModel 属于 Farfold/用户，可以从多个 Runtime 收集来源并向多个 Runtime 提供小范围上下文。

这不是“小功能”，而是产品合同变更。用户已于 2026-08-31 明确批准更新 `PRODUCT.md`、`AGENTS.md` 与唯一 active plan，并确认 OpenCode 为首个非 Pi Adapter；仍不能在 D1 中暗中加入第二 Runtime 或 LifeModel。

## 3. 三种开发顺序比较

| 顺序                                                                     | 优点                                                           | 主要问题                                                                              | 判断     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| A. 直接在当前 Pi UI events 上做 LifeModel                                | 最快看到界面                                                   | events 会丢失；没有持久 provenance；Pi 字段进入 canonical schema；以后跨 Runtime 返工 | 不建议   |
| B. 先建设完整通用 Runtime 平台，再做 LifeModel                           | 理论边界整齐                                                   | 容易过度抽象；在没有 PoC 时猜测 39 个 Runtime；推迟用户当前最简 LifeModel目标         | 不建议   |
| C. 合同 PoC → 薄 seam → Pi-first 最简 LifeModel → 首个非 Pi → 跨 Runtime | 先解决最危险耦合，同时尽快交付 LifeModel；每一步有真实产品回路 | 需要先完成一轮看似“没有新 UI”的合同工作                                               | **推荐** |

顺序 C 的关键不是“Pi-first”，而是“canonical 不含 Pi 所有权，Pi 只是第一个通过 Source Adapter 的来源”。

## 4. 哪些东西必须统一，哪些不能统一

### 4.1 Farfold 可以统一的薄层

Farfold 只统一用户可见的生命周期和宿主责任：

- Runtime 安装发现、版本与健康；
- Session 创建时选择 Runtime；
- `FarfoldSession → RuntimeKind + NativeSessionRef` 绑定；
- start/load/resume、send、cancel、turn complete、fatal exit；
- 消息 delta、工具状态、权限请求、用户提问、计划、错误的 typed envelope；
- 原始扩展事件的保留和降级展示；
- capability snapshot；
- durable history/replay 读取；
- LifeModel SourceEnvelope 与 InjectionManifest。

这不是 Agent loop。Farfold 不规划任务、不替 Runtime 选择工具、不执行 Runtime 的 tool call，也不把一个 Runtime 的失败转换成另一个 Runtime 的意图。

### 4.2 必须保持 Runtime-native 的语义

- Provider、model 与 reasoning/thinking 选项；
- permissions 与 approval choices；
- tool 类型、diff、shell、browser、MCP；
- compaction、branch/fork、steer/follow-up；
- skills、extensions、hooks、slash commands；
- subagents、plan mode、remote/cloud session；
- 原生错误、用量和认证语义。

UI 可以有共同容器，但不能把这些能力削成“最低公分母”。公共 envelope 必须允许 Runtime-specific payload 与 capability-specific view。

## 5. 推荐的宿主边界

### 5.1 Session 创建时绑定，不在原生 Session 中切换 Runtime

```text
Farfold Session A ── Pi Adapter ── Pi native session X
Farfold Session B ── Codex Adapter ── Codex thread Y
Farfold Session C ── Hermes Adapter ── Hermes session Z
```

用户在 Farfold 中“切换 Runtime”，实际是新建/选择绑定不同 Runtime 的 Farfold Session。不能把 Pi session X 的 transcript 伪装成 Codex thread，也不能在一个 Session 中途替换后端后继续声称上下文连续。

如果用户希望从 A 继续到 B，产品应创建新的目标 Session，并明确展示：

- 这是新的 Runtime 原生 Session；
- 哪些 LifeModel item 被注入；
- 是否还附加了用户主动选择的 handoff 摘要；
- 原 Session 保持原样。

handoff 摘要是独立、用户可见的 artifact，不是 LifeModel，也不是 Session migration。

### 5.2 Runtime Supervisor 不能预设所有 Runtime 都是一个进程

Adapter 必须声明自己的连接模型：

- per-session subprocess；
- shared subprocess + multiplexed sessions；
- local HTTP service；
- remote service/SDK-managed runtime；
- singleton、是否支持并发、是否需要应用级 Session lock。

当前 Rust `PiRuntime` 是单一 lifecycle slot。未来不能简单改成 `HashMap<runtime_id, Child>` 就宣称完成，因为 Codex thread、OpenCode server、Copilot SDK 和 ACP subprocess 的所有权不同。

初始产品可限制“每个 Farfold Session 同时一个 active turn”，并按 Adapter 的并发声明串行化；但数据结构不能把一个全局进程 ID 当成 Session ID。

### 5.3 Presentation cache 不是 Runtime history truth

Farfold 可以缓存用于快速显示的 normalized transcript，但必须标记来源版本与同步位置：

- Runtime 可用时，以官方 load/read/replay 对账；
- Runtime 不可用时，可以只读展示 cache，并明确“未与原生 Session 同步”；
- 不能用 cache 自行恢复或续写 Runtime Session；
- 未知/新增事件保留 raw envelope，不静默丢弃。

## 6. UI/UX 影响

Farfold 保留自己的完整 UI/UX，不嵌入 Codex、Hermes、Cursor 等产品界面。当前 Pi UI 是重要基线，但不是不可修改的最终模板。

### 6.1 共同 UI

- 新建 Session 时的 Runtime picker；
- Session header 中持续可见的 Runtime 标识、版本/状态；
- 统一消息流、停止、重试、恢复入口；
- 安装/认证/不可用的清晰诊断；
- LifeModel 本轮开关、context preview、移除与发送披露。

### 6.2 Capability-driven UI

- 有 plan 的 Runtime 显示 plan；没有的不显示空壳；
- 有 steer/follow-up 的 Runtime 显示对应交互；不支持时解释原因；
- permission choices 由 Runtime payload 决定，Farfold 不发明统一“允许/拒绝”后丢失细粒度选项；
- Runtime-specific extension 先用安全通用卡片展示，成熟后再增加专用组件；
- 每个 Session 明确显示 `Base`、`Contributes to LifeModel`、`Uses LifeModel` 三个独立能力。

## 7. 分阶段开发建议与完成条件

### R0：关闭研究 Gate

工作：

- 固定 Codex、OpenCode、Kimi Code/一个 gateway Runtime 的版本与官方分发；
- 至少三个非 Pi 完成同一 D2 剧本；
- 输出 capability snapshot、事件样本、失败语义与条款/认证结论；
- 以合成数据验证 source read 与 context injection。

完成条件：

- 三个非 Pi 通过双轮、取消、审批、重启恢复、持久 history；
- 至少两个非 Pi 达到 C1；
- 至少两个非 Pi 达到 U1；
- 没有依赖 patch、私有文件格式或 GUI 自动化；
- 用户批准首个产品候选与产品合同变更。

当前状态：**R0 完成，3/3**。Codex App Server、OpenCode HTTP/SSE 与 Kimi Code ACP 均已 D2/C1/U1；产品合同和 OpenCode 首选已获批。Kimi 使用标准外部 Provider 配置接入 GLM 5.3 Flash；其 managed OAuth/provider 请求持续 HTTP 500，必须作为 Provider 可用性单独呈现。OpenCode 的第三方条款与固定版本复核保留为进入 D3 的候选专属门。

### D1：建立薄 Runtime seam，只包住 Pi

工作：

- 从 `pi_runtime_*` facade 中抽出最小 typed host contract；
- PiAdapter 原样转发 Pi 语义；
- 用 golden protocol/event tests 证明 UI 行为没有退化；
- 加入 RuntimeKind、installation、NativeSessionRef、capability snapshot 的明确分层；
- 不接入第二 Runtime，不添加 LifeModel。

完成条件：

- 当前 Pi 的 Provider/model/Session/tool/permission/compaction/steer/abort/resume 行为保持；
- 正式安装 Farfold.app 的现有 Pi 回路通过同一构建验收；
- 没有第二 Agent loop；
- 未知 Pi event 不被静默吞掉。

### D2：最简 LifeModel 垂直切片，Pi 是首个来源

这是用户当前产品优先级，放在第二个开发 slice，而不是等所有 Runtime 都接完。

工作：

- 只实现 explicit fact/preference/constraint/work method；
- 只从 turn-complete 后的 durable Pi source 创建 atomic Proposal；
- 本地 canonical store、用户编辑/批准、冲突与 lifecycle；
- 本轮 context preview/remove/disable；
- 通过 Pi 的官方、临时、可审计入口消费一个小集合；
- secret/sensitive hard gate、provider disclosure、hard delete。

完成条件：

- 第二份报告的硬指标在合成集通过；
- 用户真实选择的少量低敏感 Session 完成 installed-app 回路；
- canonical schema 没有 Pi owner 字段；
- 删除 LifeItem 后索引、snapshot 与 pending duplicate 无残留；
- Proposal 没有接管 Pi 工具权限。

如果 Pi 无法通过 C1 或 U1，D2 停止，不能退回解析私有 JSONL 或修改 Pi。

### D3：接入第一个非 Pi Runtime，只做 Base 能力

首选候选的条件顺序：

1. R0 D2 证据通过；
2. 用户机器上可使用或用户同意安装；
3. 官方第三方嵌入与认证/许可允许；
4. 协议能保留 Runtime-native 交互；
5. 与 Pi 协议形态有足够差异，能检验抽象。

按当前证据，**OpenCode 仍是首个产品 Adapter 的领先候选**：用户机器上已有签名 Desktop 与 CLI，HTTP/SSE D2 已覆盖双轮、审批、取消、恢复、C1/U1，并能使用 Runtime 自己的免费模型。Codex 同样通过 core D2，但 0.143.0 暴露模型版本不兼容、schema/实现漂移与删除事务缺陷，升级复验前排第二。Kimi Code ACP 也已 D2/C1/U1，但本轮需要外部 GLM Provider 才完成，Kimi managed Provider 仍返回 500，且 embedded resource 会进入恢复语境；因此它更适合作为 ACP 合同校准与后续候选，不应超越 OpenCode。Hermes 保留为更接近 Pi gateway 语义的后续对照。

工作只覆盖 Base Runtime：创建/恢复 Session、发送、流、工具、权限、取消、完成和错误。不要在同一 slice 同时打开 LifeModel。

完成条件：

- Farfold 正式安装应用内完成目标 Runtime 的真实用户闭环；
- UI 全程显示 Runtime identity；
- 重启后恢复原生 Session；
- Pi 回归无退化；
- 不展示或嵌入对方 UI。

### D4：让第一个非 Pi 贡献并消费 LifeModel

工作：

- 单独开启 C1/U1 badge；
- 同一 explicit preference 分别从 Pi 与非 Pi 产生来源，验证幂等/冲突；
- 在非 Pi 新 Session 中预览并注入 Pi 来源的 canonical item；
- 反向在 Pi 中使用非 Pi 来源的已批准 item；
- 核对两个 Runtime 的 Injection Manifest 与原生 Session 持久化行为。

完成条件：

- canonical item 对 Runtime 来源中立；
- 不发生跨 project scope 泄漏；
- 两边删除、恢复、compaction 后的行为明确；
- 用户能看懂来源 Runtime 与当前使用 Runtime 的区别。

### D5：第二种协议与 ACP 扩展

工作：

- 再接一个不同形态 Runtime；
- 若前两个/三个 PoC 表明 ACP 共同面稳定，再实现通用 ACP Adapter；
- Runtime-specific extensions 通过 capability namespace 增加，不污染基础合同；
- 安装与升级继续固定版本、校验来源，不能直接追 `latest`。

完成条件：

- 新 Runtime 不要求改 Host 核心生命周期；
- capability 缺失能安全降级；
- Adapter 合同版本升级有兼容测试；
- 39 项 Registry 不被自动宣称支持，只显示逐项验证过的版本。

## 8. 为什么最简 LifeModel 放在第一个非 Pi 之前

这不是技术上唯一顺序，而是结合用户当前目标后的产品取舍：

- 用户明确要先实现最简 LifeModel；
- 只要 R0 已经用真实非 Pi PoC 校准过 source/context 合同，canonical 设计就不再只根据 Pi 猜测；
- D1 的薄 seam 能阻止 Pi 字段渗入 canonical；
- Pi-first 能用现有成熟 UI/UX 降低同时变量；
- D3/D4 随后立刻用非 Pi 证明它没有被“伪通用化”。

如果跳过 R0/D1，所谓 Pi-first 会变成 Pi-locked；如果要求先完成所有 Runtime，LifeModel 又会被无限推迟。推荐顺序是在这两者之间设置可验证的窄门。

## 9. 需要避免的提前设计

- 为未来所有 Runtime 创建一个巨大的 enum/数据库 schema；
- 把在线 Registry `latest` 当作可复现依赖；
- 把 `runtime_id` 同时用于安装、进程、Session 和来源；
- 将 stdout JSON 都视为等价事件；
- 用统一 system prompt 覆盖各 Runtime 原生提示词；
- 为“贡献 LifeModel”安装会修改 Runtime 行为的扩展；
- 解析闭源 Runtime 私有数据库或配置；
- 用 Farfold presentation cache 伪造原生恢复；
- 把 Proposal 审批复用于 tool permissions；
- 一次性同时重构 UI、进程监督、Session 存储、LifeModel 和第二 Runtime。

## 10. 风险与早停条件

| 风险                                 | 早期证据                                         | 处理/早停                                                   |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------- |
| 各 Runtime 的“完成”语义无法统一      | send 返回早于 turn complete；无 idle/stop reason | 保留 Adapter-specific completion；仍无法可靠判断则淘汰 Base |
| 无稳定持久 history                   | 只有 delta/最终文本；恢复不 replay               | Base 可保留，C0 禁止贡献                                    |
| 无安全上下文入口                     | 只能改配置、扩展或私有 prompt                    | U0 禁止消费，不改后端                                       |
| 认证/条款不允许第三方宿主            | 官方条款限制或需要厂商审批                       | 停止该候选产品接入                                          |
| abstraction 需要大量 Runtime 特例    | 第二/第三 Adapter 频繁修改核心状态机             | 回退到更薄 host contract，特例下沉 Adapter                  |
| LifeModel precision/secret Gate 不过 | 错提议或数据外泄                                 | 停止真实数据试用，继续合成研究                              |
| Pi UX 回归                           | 当前原生功能被最低公分母削弱                     | 不合并 D1/D3，先恢复 Pi parity                              |

## 11. 当前可以做与不可以做

现在可以：

- 审阅 3/3 D2/C1/U1 证据并冻结最小 Runtime/provenance/injection 合同；
- 核对 OpenCode 产品接入条款与固定版本，决定是否批准其为首个 Adapter；
- 正式修改 `PRODUCT.md`、`AGENTS.md` 与 active plan——但仅在用户明确授权该合同变更后；
- 继续用合成数据验证 Pi 自己的 C1/U1，不扫描真实历史。

现在不可以：

- 修改现有 Pi Runtime 或 UI 进入多 Runtime 产品开发；
- 添加第二 Runtime 到 Farfold.app；
- 创建真实用户 LifeModel 数据库或扫描历史 Session；
- 修改 `AGENTS.md`、`PRODUCT.md` 或 active plan，除非用户明确批准新的产品合同；
- 把 D2 技术 Gate 写成 D3 产品可用性，或宣称 Farfold.app 已支持多 Runtime。

## 12. 决策状态

用户已经接受未来方向与顺序 C：一个 Farfold UI/UX、多个原生 Runtime Adapter、Session 创建时绑定 Runtime；`R0 合同 PoC → D1 薄 seam → D2 最简 LifeModel → D3 首个非 Pi → D4 跨 Runtime LifeModel`。本轮“开始”授权的是研究和隔离 Runtime 安装/登录，不是修改产品代码。

用户已批准把上述未来合同正式写入 `PRODUCT.md`、`AGENTS.md` 与唯一 active plan，并确认 OpenCode 为首个 Adapter。R0 已关闭；下一实施 slice 是 D1 Pi-only 薄 Runtime seam。此批准不等于 D1 已实现，也不允许把 LifeModel 或 OpenCode 混入同一 slice。
