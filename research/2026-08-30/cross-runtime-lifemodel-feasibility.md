# 跨 Runtime LifeModel 可行性研究

日期：2026-08-30；运行证据更新：2026-08-31
状态：概念与合同研究；没有实现 LifeModel 代码
前提：LifeModel 属于用户与 Farfold，不属于任何一个 Agent Runtime。

## 1. 可行性结论

跨 Runtime LifeModel **架构上可行**，但必须放弃“让每个 Runtime 直接读写同一张 LifeModel 表”这一做法。

可行的边界是：

```text
Runtime 原生持久 Session
        │  只读、官方接口、turn 完成后对账
        ▼
Farfold Source Envelope
        │  去密、资格判断、有限抽取
        ▼
Atomic Proposal ── 用户编辑/批准 ──▶ Canonical LifeModel
                                             │
                        Farfold 相关性选择 + 用户预览/移除
                                             ▼
                              Runtime 官方上下文入口
```

这条链满足四个关键要求：

1. 不修改、fork 或 patch Pi、Codex、Hermes 等后端；
2. 不让任何 Runtime 直接拥有或写入 canonical LifeModel；
3. 来自不同 Runtime 的信息最终进入同一个用户模型；
4. LifeModel 中的信息可以被任何**通过消费能力验证**的 Runtime 使用，而不是绑定到来源 Runtime。

运行时证据已经达到 3/3：OpenCode、Codex 与 Kimi Code 都在不修改后端 Agent loop 的情况下，通过官方持久历史达到 C1，并通过官方 per-turn/session 上下文入口达到 U1。Kimi 的 D2 使用其标准外部 Provider 配置连接用户授权的 GLM 5.3 Flash；这证明 Runtime/LifeModel seam，不证明 Kimi 托管模型服务可用。尚未完成真实 Proposal、批准存储、删除与跨 Runtime 幂等闭环，因此结论是“跨 Runtime 来源与注入合同已有三种承载面实证”，仍不是“LifeModel 产品已实现”。

## 2. 不可妥协的产品边界

### 2.1 LifeModel 不是 Agent Memory

- Runtime 原生 Session/Memory 用于该 Agent 的工作连续性，由 Runtime 自己管理。
- LifeModel 保存用户确认的长期事实、偏好、约束和工作方式，由 Farfold 管理。
- Farfold 不把一个 Runtime 的完整聊天复制成另一个 Runtime 的“伪 Session”。切换 Runtime 时新建或选择目标 Runtime 的原生 Session，只注入经过选择的 LifeModel 小片段。

### 2.2 LifeModel Proposal 不是工具权限

Proposal 只决定内容能否进入 LifeModel。工具执行、文件修改、网络访问、命令审批继续由当前 Runtime 的原生权限协议决定。Farfold 只渲染和转交，不重解释 Agent 意图。

### 2.3 MVP 只接受显式信息

可提议：

- 用户明确陈述的事实；
- 用户明确陈述的偏好；
- 长期约束；
- 可复用的工作方式。

MVP 不提议：

- 从语气推断人格；
- 从单次行为推断长期习惯；
- Agent 自己声称的用户事实；
- 工具输出中的第三方信息；
- 临时任务参数、代码内容或一次性 deadline；
- 任何命中敏感类别或 secret 规则的内容。

### 2.4 用户批准是 canonical 写入的唯一入口

抽取器只能创建 Proposal。只有用户明确批准的 atomic item 才能成为 active LifeModel item；用户可以先编辑、缩小作用域或直接拒绝。不存在“高置信度自动写入”。

## 3. 为什么多个 Runtime 不应共享一个万能 runtime_id

同一用户可能同时拥有：

- Pi 0.84.3 与 Pi 的未来版本；
- 两个 Codex 安装或两个认证状态；
- 同一 Runtime 的多个进程；
- 同一项目内多个原生 Session；
- 同一原生 Session 的恢复连接；
- 同一条用户事实在不同 Runtime 中重复或冲突地出现。

因此应区分以下坐标：

| 坐标                     | 用途                        | 是否进入 LifeModel 内容语义           |
| ------------------------ | --------------------------- | ------------------------------------- |
| `runtimeKind`            | 来源产品，如 `pi`/`codex`   | 否，只是 provenance                   |
| installation fingerprint | 来源安装版本与签名/路径指纹 | 否，只用于审计和兼容性                |
| adapter protocol/version | 当时如何读取来源            | 否，只用于可重现性                    |
| native session ref       | 指向 Runtime 原生 Session   | 否，只用于来源定位                    |
| native entry/message ref | 指向具体用户陈述            | 否，只用于证据定位                    |
| workspace/project scope  | 限定事实是否只对某项目有效  | 是，作为 scope，不作为 Runtime 所有权 |
| user scope               | 全局、项目、主题或会话      | 是                                    |

LifeModel item 不能带“只供 Pi 使用”或“属于 Codex”的默认所有权。来源 Runtime 是证据元数据；消费 Runtime 是一次 Injection 的审计元数据。这两个方向必须分开。

## 4. 逻辑数据合同

以下是研究用逻辑合同，不是要求立即创建这些数据库表。

### 4.1 Runtime Identity

```text
RuntimeInstallation
- runtimeKind
- executableOrEndpointFingerprint
- runtimeVersion
- distributionSource
- adapterKind / adapterVersion
- authStateRef (只存 opaque 状态引用，不存 secret)
- lastVerifiedAt
```

运行连接另有临时 `connectionInstanceId`。它只用于关联进程事件，不得成为长期来源主键。

### 4.2 Source Envelope

```text
SourceEnvelope
- sourceId                    Farfold 稳定 ID
- runtimeKind
- runtimeVersion
- adapterKind / adapterVersion
- nativeSessionRef            opaque
- nativeEntryRef              opaque；缺失时用序号 + 内容 hash
- workspaceScope
- actor                       user / assistant / tool / system
- completionState             complete / incomplete / cancelled / failed
- authoredAt / observedAt
- contentDigest
- durableLocator              通过官方接口重新取得的定位信息
- redactionReport
```

关键约束：

- live delta 只能创建 provisional observation；turn complete 后必须用原生持久历史对账，才能得到 durable source；
- `actor != user` 的内容默认不能成为用户事实；
- incomplete、cancelled、failed 的用户草稿默认不进入抽取；
- 原生 message ID 若非协议保证稳定，只作为 locator 的一部分，不单独充当全局 ID；
- 不为方便而复制完整 reasoning、tool output 或整段聊天到 LifeModel 数据库。

### 4.3 Atomic Proposal

一条 Proposal 只表达一个可独立批准、编辑、冲突和删除的陈述：

```text
LifeProposal
- proposalId
- candidateType                fact / preference / constraint / work_method
- candidateText
- proposedScope
- sourceIds[]
- extractorIdentity/version
- extractionPolicyVersion
- createdAt
- status                       pending / approved / rejected / expired
- userEditedText
- sensitivityFlags[]
- duplicateOrConflictRefs[]
```

“我喜欢简短回答，但写研究报告时希望证据完整”必须拆成两个有条件的 preference，而不是一个不可解释的大段摘要。

### 4.4 Canonical Life Item

```text
LifeItem
- itemId
- type
- statement
- scope
- lifecycle                    active / needs_review / superseded / retired
- version
- approvedAt
- sourceIds[]
- sensitivityClass
- retrievalMetadata
```

canonical item 没有 `ownerRuntimeId`。一个 item 可以有多个来自不同 Runtime 的 source，也可以被多个 Runtime 的 injection 使用。

### 4.5 Injection Manifest

每次给 Runtime 使用 LifeModel 都应产生可见、可删除的审计记录：

```text
InjectionManifest
- injectionId
- farfoldSessionId
- runtimeKind / nativeSessionRef
- channel                      turn_context / additional_instructions / scoped_mcp
- selectedItemIdsAndVersions[]
- renderedPayloadDigest
- userPreviewed / userRemovedItemIds[]
- sentAt
- runtimeAcknowledgement
- persistedByRuntime           yes / no / unknown
```

它记录“哪一次用了哪些确认内容”，但不把 Runtime 输出反向当成 LifeModel 更新。

## 5. 贡献链：Runtime 如何在不被修改的情况下贡献来源

### 5.1 首选流程

1. Farfold Adapter 订阅 Runtime 官方 live event，供 UI 显示；
2. 等待 Runtime 的明确 turn-complete/idle/stop reason，不能把 stdin write 成功当完成；
3. 使用同一 Runtime 的官方 history/read/load/replay 接口取得持久记录；
4. 用原生 ID、顺序和内容 digest 对账 live 与 durable 数据；
5. 只取符合资格的完整 user entries；
6. 先做确定性 secret/sensitive 检查；
7. 在用户已知的 provider/local extractor 中做有限结构化抽取；
8. 每个陈述生成 atomic Proposal；
9. 用户编辑/批准后写入 canonical LifeModel。

这个过程不需要修改 Runtime，只需要它公开稳定的持久历史读取面。

### 5.2 为什么不能直接监听 UI events

当前 Farfold 的 Pi event queue 只有内存容量 512，满时会丢最老事件。其他 Runtime 也常区分 ephemeral delta 与 persisted event；例如 [GitHub Copilot SDK 官方文档](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events) 明确区分恢复后会重放的持久事件和不会重放的临时事件。

因此：

- live event 是展示事实，不是最终存储事实；
- durable replay 是来源事实；
- 两者不一致时暂停抽取并记录 Adapter 错误，不能猜测补齐。

### 5.3 贡献能力等级

| 等级 | 条件                                                                    |
| ---- | ----------------------------------------------------------------------- |
| C0   | 不能读取可靠持久用户消息；不得贡献                                      |
| C1   | 能在 turn complete 后读取完整 user messages，并稳定定位来源             |
| C2   | C1 + 能恢复/重放、识别删除/编辑/分支、区分 incomplete 与 tool/assistant |

MVP 只有 C1/C2 Runtime 才显示“可向 LifeModel 提议”。基础 Runtime 可用性和贡献能力是两枚独立 badge。

## 6. 消费链：所有 Agent 如何使用同一 LifeModel

### 6.1 Farfold 先选择，用户再决定

在发送用户消息之前，Farfold 根据：

- 当前用户输入；
- 当前项目/主题 scope；
- active LifeItem；
- 用户对本 Session 的启用状态；
- 明确的敏感性规则；

选出一个小集合。UI 必须允许：

- 本轮完全关闭 LifeModel；
- 预览每个 item；
- 移除单个 item；
- 查看为什么相关；
- 知道内容将发送给哪个 Runtime/provider。

禁止把整个 LifeModel、全部来源对话或其他项目内容注入每一轮。

### 6.2 官方注入通道的优先级

不同 Runtime 使用不同官方 Adapter 通道，不定义一个假想的万能 system prompt：

1. **首选：turn-scoped structured context**。Runtime 官方请求若能携带 context/input part，按其角色与类型传递；
2. **次选：session/turn-scoped additional instructions**。只使用公开字段或 CLI flag，不能写入 Runtime 的全局配置或规则文件；
3. **受限备选：Farfold 提供的 session-scoped read-only MCP**。只有当 Runtime 官方允许客户端在 Session 创建时提供 MCP，且 MCP 只能读取用户已为该 Session 批准的 snapshot；
4. 如果只剩安装扩展、修改规则文件、patch prompt、解析私有存储或模拟键盘 UI，消费能力判定为不支持。

ACP 的 [Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup) 允许 Client 在 `session/new`/`session/load` 时传入 MCP servers，但这只证明传输入口；每个 Runtime 是否正确隔离、展示和审计仍需 PoC。

### 6.3 为什么 scoped MCP 不能直接暴露整个 LifeModel

若 Agent 可以自由搜索完整 LifeModel，Farfold 就失去“本轮预览/移除”的控制，而且 prompt injection 或工具滥用可能扩大读取面。安全做法是：

- Farfold 先创建本轮/本 Session 的 immutable snapshot；
- MCP 只能读取 snapshot 中的 item，不接受任意全库检索；
- 每次读取进入 Injection Manifest；
- snapshot 在 Session 结束或用户关闭后失效；
- Runtime 无法通过 MCP 写 LifeModel 或批准 Proposal。

### 6.4 消费能力等级

| 等级 | 条件                                                                   |
| ---- | ---------------------------------------------------------------------- |
| U0   | 没有公开、可控、非持久污染的上下文入口；不得消费                       |
| U1   | 能把用户预览的小集合注入当前 turn/session，并可关闭                    |
| U2   | U1 + 能确认是否被 Runtime 持久化、恢复时可核对、支持来源/manifest 审计 |

“基础 Runtime”“贡献 LifeModel”“消费 LifeModel”必须分别展示。例如一个候选可能是 `Base=yes, Contribute=no, Use=yes`，而不是被一个 `supportsLifeModel` 布尔值掩盖。

## 7. 主要 Runtime 的 LifeModel 接口证据与候选

表中明确区分运行证据与文档候选；没有运行过的入口不能借用其他 Runtime 的结果。

| Runtime                | durable source 候选                                      | context channel 候选                                | 当前判断                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi                     | RPC `get_messages`；理想上验证并暴露上游稳定 entries API | 官方 extension/context seam 或明确的 prompt context | 当前 Farfold surface 不足以给 C1/U1 结论                                                                                                                 |
| Hermes                 | TUI Gateway `session.history`                            | TUI prompt/session 官方字段；必要时官方 extension   | 最值得做跨协议 PoC                                                                                                                                       |
| Codex 0.143.0          | `thread/read(includeTurns=true)`                         | `turn/start.additionalContext` 的 `application`     | **C1/U1 已实测**：三轮六 item 重启前后摘要一致；合成 context 返回 `VERDANT`。仅依据官方 App Server 与本机运行证据                                        |
| OpenCode 1.15.13       | Server Session messages API                              | per-turn `system`                                   | **C1/U1 已实测**：四条持久消息重启前后摘要一致；合成 context 返回 `VERDANT`                                                                              |
| Kimi Code 0.39.1       | ACP `session/load` history replay                        | ACP embedded `resource` context                     | **C1/U1 已实测**：重启后 replay 7 个消息 chunk 且能回忆 `17`；embedded resource 返回 `LABEL=VERDANT`。该 context 进入原生 Session 语境，不能假设为非持久 |
| 原生 ACP Runtime       | `session/load` replay；message ID 可能可选               | prompt content 或 session-scoped MCP                | ACP 给共同底座；逐实现验证必不可少                                                                                                                       |
| Copilot SDK            | persisted session event log                              | `systemMessage`/session config                      | 官方区分持久/临时事件；public preview 与无 Session lock 是风险                                                                                           |
| Claude Agent SDK       | SDK message/session stream                               | 官方 system/context options                         | 技术入口存在，第三方认证/条款为硬 Gate                                                                                                                   |
| Qwen                   | project-scoped JSONL 的官方 headless resume；ACP/daemon  | `--append-system-prompt` 或 daemon input            | daemon 自称 experimental，不能先依赖生产语义                                                                                                             |
| OpenHands Agent Server | RemoteConversation events/API                            | Conversation/Server API                             | 只有连接完整 Server 才算外部 Runtime；Farfold 自组 SDK loop 不纳入                                                                                       |

## 8. 多 Runtime 并发、重复与冲突

### 8.1 多个 Runtime 同时贡献

- 每个 native Session 按来源顺序串行 ingest；
- 全局 Proposal 队列可并发生成，但 canonical 写入由用户操作串行提交；
- `runtimeKind + nativeSessionRef + nativeEntryRef + contentDigest` 参与幂等键；
- Adapter 重连或 load replay 不得重复创建 Proposal；
- 来自不同 Runtime 的同义来源可以挂到同一 pending/active item，不能创建多个看似独立的“真相”。

### 8.2 冲突不自动覆盖

例：Pi Session 中用户说“默认用中文”，Codex Session 中用户后来明确说“所有项目默认用英文”。系统只能：

1. 识别为可能冲突；
2. 建立新的 atomic Proposal，并引用已有 item；
3. 把已有 item 标记为 `needs_review`，但不修改其文本；
4. 让用户决定替换、限定 scope、保留二者或拒绝；
5. 批准后旧 item 进入 `superseded`/`retired`，保留版本与来源关系。

时间更新不能被默认解释为事实更新，因为不同项目、不同角色和条件偏好也可能造成表面冲突。

### 8.3 原生 Session 删除与 LifeModel 删除分开

- 删除 Runtime Session：调用 Runtime 官方删除或让用户在 Runtime 中删除；Farfold 的 source locator 变成 unavailable/tombstoned，不暗中保留整段原文。
- 删除 LifeItem：删除 statement、向量/索引、缓存 snapshot、pending duplicate 和未完成 injection payload；保留最小不可逆审计占位需另获用户同意，否则一并删除。
- 删除 LifeItem 不自动删除各 Runtime 原生 Session；删除 Session 也不自动撤销用户已经独立批准的 LifeItem。

## 9. 安全、隐私与数据流

### 9.1 本地 canonical，provider 调用显式披露

- canonical LifeModel 与 Proposal 默认存本地；
- Runtime 的 provider 调用仍由 Runtime 自己负责；
- Farfold 若使用模型抽取或相关性排序，必须在 UI 中说明使用哪个 provider、会发送什么红acted 内容，并允许关闭；
- 凭据只由 Runtime/系统安全存储拥有，Farfold LifeModel 记录只保存 opaque auth state，不保存 token。

### 9.2 确定性 secret 过滤先于模型

至少阻断：API keys/tokens、私钥、密码、seed phrase、cookie/session、云凭据、连接字符串中的 secret、身份证件/支付数据等预设敏感类别。敏感类别默认关闭，不因用户在聊天中说过就进入 Proposal。

抽取器不能被用来“判断 secret 是否值得保存”；命中规则时在模型调用前删除或阻断。原始敏感片段不进入日志。

### 9.3 Prompt injection 与指令边界

- source 中的文本只作为待分类数据，不作为 extractor 的指令；
- canonical statement 使用受限类型和用户编辑后的短句，不保存网页/工具输出原文；
- 注入时标明“用户确认的背景数据”，不允许 item 携带工具命令或越权指示；
- 一个 Runtime 的 assistant/tool 内容不能借由 LifeModel 变成另一个 Runtime 的 developer/system 指令。

## 10. 最简 LifeModel 的验证方案

### 10.1 先使用合成数据

构造至少覆盖以下类别的跨 Runtime 对话集：

- 明确长期事实、偏好、约束、工作方式；
- 明确临时信息；
- 否定、反讽、引用他人、假设句；
- 同义重复与跨 Runtime 冲突；
- secret 与敏感信息；
- incomplete/cancelled turn；
- assistant 幻觉、tool output 与网页 prompt injection；
- 项目 scope 与全局 scope 混淆。

同一语义分别通过 Pi、Codex、Hermes/ACP 等 Adapter feed 输入，验证输出不依赖来源 Runtime 的 UI 事件格式。

### 10.2 硬指标

在实现前冻结评测集与阈值。建议研究 Gate 至少包括：

| 指标                                                    |                   Gate |
| ------------------------------------------------------- | ---------------------: |
| 未经批准写入 canonical                                  |                      0 |
| secret/sensitive 进入 provider payload、Proposal 或日志 |                      0 |
| assistant/tool 内容被当成用户事实                       |                      0 |
| source link 可重新解析或明确 tombstoned                 |                   100% |
| Proposal 幂等重放                                       |                   100% |
| hard delete 后内容、索引与 snapshot 残留                |                      0 |
| 跨 project scope 错误注入                               |                      0 |
| Injection Manifest 与实际 payload 不一致                |                      0 |
| 明确 eligible 样本的 Proposal precision                 | 建议 ≥95%，recall 次要 |

precision 优先于 recall：漏掉一个偏好可以让用户以后再提；错误沉淀或越权注入会破坏信任。

### 10.3 真实数据只在后期、由用户挑选

合成 Gate 通过后，用户手动选择少量低敏感 Session，逐条查看 source、redaction、Proposal、批准和 injection。不得默认扫描历史全库。

## 11. 当前阻断点

1. 当前 Pi Adapter 没有完成 durable-source 合同验证；内存事件队列不能作为来源真相。
2. 三个非 Pi 已达到 D2/C1/U1，但 Pi 自己仍未完成 C1/U1；首个 LifeModel 垂直切片不能借用非 Pi 证据替 Pi 放行。
3. 三个非 Pi 已证明官方上下文入口可用，但 context 如何持久化、恢复时如何展示、compaction 后是否保留仍需逐 Runtime 确定；Kimi 的 replay 已显示 embedded resource 会影响恢复后的语境，不能从正确回复推断 U2 或“无持久污染”。
4. 用户对 Farfold 自己的 extractor provider、数据发送披露和本地-only fallback 尚未看到实际 UX 验证。
5. hard delete、冲突、scope 与跨 Runtime 幂等只有逻辑设计，没有存储与故障注入证据。

因此第三个 Runtime 校准已经完成，产品合同也已于 2026-08-31 获批。下一步按唯一 active plan 先建立 Pi-only 薄 seam，再验证 Pi 自己的 C1/U1；在 D1 中仍不应预埋 LifeModel schema。

## 12. 最终回答

- **多个 Runtime 能否共同服务一个 LifeModel？** 能。来源通过 provenance 合并，canonical item 不属于任何 Runtime。
- **一个 LifeModel 能否供所有 Agent 使用？** 原则上能；实际只对通过 U1/U2 的 Runtime 开放，不能承诺“任何 Runtime 自动支持”。
- **是否需要改后端 Agent？** 不需要，也不允许。贡献依赖官方持久历史读取；消费依赖官方 per-turn/session context、additional instructions 或受限 MCP。没有官方 seam 就标记不支持。
- **提前加 runtime id 是否足够？** 不足。必须分离 Runtime 产品、安装、连接、原生 Session、来源条目和 injection 记录。
- **最简 LifeModel 是否可以先实现？** 三个多样非 Pi Runtime 的 C1/U1 PoC 与产品合同均已通过；现在先完成薄 seam，并让 Pi 自己通过 C1/U1，然后进入最简垂直切片。非 Pi 结果不能替代 Pi 的来源/注入证据。
