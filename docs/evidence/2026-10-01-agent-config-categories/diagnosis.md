# 多个配置选项共享类别：Dirac 读取失败的候选解释

2026-10-01，只读调查。生产源码和测试均未修改，未运行 Cargo、Agent、正式应用、认证或模型请求；未读取用户配置、秘密或协议正文。本文是已有失败的诊断材料，不是新的活动计划。

## 实测边界

[目录第三批](../2026-10-01-agent-access-directory-batch3/README.md)使用正式候选 `423aed4`，二进制 SHA-256 为 `457edd0197b33de1972c7b7c56912f5ecb7f14074cb5254894ab983c1874d78a`。[Dirac 登记](../2026-10-01-agent-access-directory-batch3/dirac-registration.json)为 `dirac-cli@0.5.17`；[04 截图](../2026-10-01-agent-access-directory-batch3/04-dirac-model-read-failed.png)显示模型、Reasoning Medium、Thinking Off 字段及最终读取失败，用户没有改变选择或发送消息。

[允许读取的协议元数据](../2026-10-01-agent-access-directory-batch3/protocol-metadata-final.json)中，实际连接文件 `protocol-v1-1790792141329-4.jsonl` 有成功的 initialize、成功的 `session/new` 及两次 `session/update`。没有协议错误、后续设置或关闭出站记录，也没有 prompt。因此不能把后续某个协议动作失败当成已测原因。[前一静态核对](../2026-10-01-agent-access-directory-batch3/dirac-static.md)已确认标准关闭接口存在，本调查没有重复执行关闭测试。

本调查核对了下述 Farfold 文件相对 `423aed4` 的差异：`model_guard.rs`、`pump.rs`、`config_check.ts`、`sessions.ts`、`agent_preparation.ts` 均无差异。当前工作区的下一片认证改动不作为该安装候选的结果。

## 已确认的静态缺陷

官方 [Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options#option-categories) 明确允许多个选项共享同一类别，数组顺序用于界面优先级；唯一标识是各选项的 `id`。类别属于界面提示，不应成为正确性要求。[官方 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)与本地 `agent-client-protocol-schema-1.9.1/src/v1/agent.rs:2299–2304` 的说明一致。主模型菜单优先显示较前选项可以成立，但不能因此丢掉其他选项的恢复基线。

已装公开包的 [sessionConfig.ts](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:dirac/install-vRKF11/node_modules/dirac-cli/dist/source/cli/src/agent/sessionConfig.ts:124>)有两类重复类别：

| 公开源码位置     | 不同选项 ID                           | 共同类别        | 生成条件                                                           |
| ---------------- | ------------------------------------- | --------------- | ------------------------------------------------------------------ |
| 168–172、243–247 | `thinking_budget`、`reasoning_effort` | `thought_level` | Reasoning 始终生成；Thinking Budget 在该实现的非 DeepSeek 路线生成 |
| 211–233          | `model`、`inference_speed`            | `model`         | 后者在程序判定当前服务支持速度选项时生成                           |

这里只读包内固定实现，没有查询本次实际服务、用户配置或当前值。第二类是另外一个必须覆盖的静态反例，不能推定本轮也返回了速度选项。

Farfold 的失败链不需要发送另一个协议请求：

1. [model_guard.rs:53](../../../src-tauri/src/acp_client/model_guard.rs#L53) 的 `choice()` 找到同类别第二项即返回 `None`；[invalid_categories:42](../../../src-tauri/src/acp_client/model_guard.rs#L42)把这种情况归为无有效值。
2. [ModelGuard::check:138](../../../src-tauri/src/acp_client/model_guard.rs#L138)即使在新草稿也会产生 `missing` 问题和 `status: blocked`。两个不同 ID、各自完整有效的值被当成缺失。
3. [pump.rs:1224](../../../src-tauri/src/acp_client/pump.rs#L1224)在成功的新建响应后生成该检查；[session_commands.rs:123](../../../src-tauri/src/acp_client/session_commands.rs#L123)随 `session_open` 成功结果返回。通知处理也会在 [pump.rs:685](../../../src-tauri/src/acp_client/pump.rs#L685)重新检查并发出相同状态。
4. [config_check.ts:14](../../../src/runtime/config_check.ts#L14)将非 ready 标成 `modelDrift`；[sessions.ts:669](../../../src/runtime/sessions.ts#L669)处理读取结果，也处理缓冲的检查事件。[agent_preparation.ts](../../../src/runtime/agent_preparation.ts)因 `modelDrift` 判定本次读取失败，保留实际字段并显示固定的安全错误。

因此，该实现对合法多选项类别存在确定的静态错误；它与本轮“新建成功、选项可见、随后本地读取失败”的现象吻合。**仍未证明本轮实际收到的完整选项或 `configCheck` 恰为上述形状。** 下一片受控对端能证明共用机制缺陷；只有之后的同候选安装复验才能确认 Dirac 的这条失败是否被关闭。不能据此推断认证、服务可用性或首发成功。

## 持久基线与兼容设计

当前 [Snapshot](../../../src-tauri/src/acp_client/model_guard.rs#L14)仅存 `model?: Choice` 和 `thoughtLevel?: Choice`；`record()`在现有会话索引的 `config_options` 内加 `_farfoldConfig: 1`。`ModelGuard::new()`还兼容更早的 `{配置ID: 值}` 数据。Farfold 的服务来源仍在同一对象的 `_farfoldService`，必须原样保留。

最小方向是在**现有这份会话选择元数据**中保存完整的受保护选项集合，以唯一 `id` 对应类别、类型和已选标量值；不新建表、会话账本、外部历史解析或 Agent 配置。实现前确定该集合的明确格式标记，并兼容读取旧单值格式与旧 flat map。UI 展示仍按 Agent 数组顺序，基线比较按 ID，不把排序变化当成选择变化。范围限现有 `model` / `thought_level` 保护语义；虽然当前官方资料另列 `model_config`，此片不顺带引入它的新冻结策略。

必要约束：

- 新草稿允许多个不同 ID 的模型/推理选项，首次真实请求准入才固定全部受保护值；读取模型本身不制造历史记录或自动请求。
- 已有对话恢复逐 ID 检查全部已记录选项；任一值改变、消失或类型变化都继续阻止误续答。不能删除 `selected.next()` 检查后直接 `first()`，否则会静默漏掉第二个推理或模型选项。
- 字段换 ID 即使值相同也不是原选择保持：旧 ID 缺失、新 ID 未记录分别判断，不能按类别和值推断改名。现有 `check()`只比较前后值，单项同类别换 ID 而值不变也可能通过，这是同一基线身份问题的必要反例。
- 旧单值记录仅证明它确实保存的 ID/值，不能凭同类别把该值复制到新增 ID。多出来的未记录项保留未知；复用现有“已知模型保持、未记录推理需显式确认”的规则时，必须检查完整显示集合并经用户确认后才补存。原模型变化或缺失不能由确认当前值绕过。
- 旧 flat map 可按实际 ID 对齐；缺值不猜默认。旧记录升级不能在打开历史时自动覆盖原基线。类别后来省略或改变时，已记录 ID 仍须检查，不能因此解除保护。
- 重复 ID 与重复类别分开：同类别不同 ID 合法；同 ID 重复、已保护 select 的值非字符串或缺失仍需明确错误。重复 ID 应在完整声明中检查，不能先过滤类别而漏掉另一个类别中的同 ID。未知类别/未知类型继续按协议降级，不扩成任意配置内容持久化；但已经保存的保护项不能借改成未知类型解除保护。
- 有格式标记但版本不受支持的快照不能再当 legacy flat map 或忽略新集合后按旧摘要放行；保留原记录并明确无法核对。只有确实没有新格式标记的旧记录才进入兼容读取。
- `model`、`thoughtLevel`若继续用于旧展示兼容，只能作明确的显示摘要；执行准入和冷恢复必须读取完整集合。不能用摘要的第一项证明其余值也保持。

还有三个必须同步核对的共享入口：

- [pump.rs:1141](../../../src-tauri/src/acp_client/pump.rs#L1141)的恢复时参数变更保护也调用单值 `choice()`，应检查全部受保护 ID，否则第二个推理 ID 可能漏过恢复修改禁令。
- [sessions.ts:1204](../../../src/runtime/sessions.ts#L1204)已禁止任一 `thought_level` 项在既有对话中修改，但模型只经 `modelConfigOption()`检查首项；多模型类别要保持同一完整保护范围。`config_check.ts`的错误项目可增加选项 ID/公开名称以辨认两项，不能把两项合成一个不明“推理等级”。普通模型菜单的突出显示策略不必因此重做。
- [pump.rs:792](../../../src-tauri/src/acp_client/pump.rs#L792)的已选 API 请求准入读取 `current_value()/model/value`，格式变更不能丢掉该消费者而误阻已有 API；[service_config.rs:70](../../../src-tauri/src/acp_client/service_config.rs#L70)目前严格要求单一、匹配的服务模型。保留现有 API 来源核验，不把多类别兼容改成“任意一项值相同就算所选服务匹配”。多项声明的显示兼容不自动证明其服务模型映射。

## 下一片最小可复现反例（尚未添加、运行）

| 层次与拟议测试落点                                                                                                              | 构造                                                                                                                                     | 必要断言                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Rust 真实 SDK/自有对端；优先在现有 [config_guard_tests.rs](../../../src-tauri/src/acp_client/config_guard_tests.rs)新增独立用例 | initialize 后 session/new 成功返回 `model=m`、`reasoning_effort=medium`、`thinking_budget=0`，后二者同 `thought_level`；再发完整选项通知 | open 成功且配置检查 ready，两项值原样保留；对端未收到 prompt、set_config 或 close。当前源码预期在 ready 断言变红           |
| 同一对端第二形状                                                                                                                | `model=m` 与 `inference_speed=standard` 同 `model`                                                                                       | 不因类别重复失败；不能用思考专属条件修补                                                                                   |
| [sessions.preparation.test.ts](../../../src/runtime/sessions.preparation.test.ts)的真实 sessions/controller                     | 成功 open 结果带 ready 检查，随后同样完整的选项更新；反向再注入明确 blocked 检查                                                         | ready 时准备完成且各 ID 不丢；blocked 时仍诚实显示失败，不吞保护。无自动 prompt/close                                      |
| Rust 持久及恢复                                                                                                                 | 初次准入保存全部值；恢复时仅调换顺序、或分别改变/缺失第二项                                                                              | 顺序变化通过；任一受保护值变化/缺失阻止续答，所有原值保持，无自动 set_config 修复                                          |
| 旧数据与输入边界                                                                                                                | 原 `_farfoldConfig:1` 单值、旧 flat map、缺额外项、重复 ID、非字符串值、未知快照版本、无类别、换 ID 但值相同                             | 原单选样本不退化；未知额外项不伪装已记录；重复 ID / 非法值 / 未知格式不放行；改名不能当保持；恢复请求不得改第二个受保护 ID |

测试文件变更须等待当前认证候选安装验收结束后的明确授权；此时不占用 Cargo 或前端 runner。安装复验应使用原 Dirac 程序、目录和返回选项，只明确重新读取；不改模型/推理、不发送请求。若仍失败，保留失败并继续基于公开状态缩小原因，不能用此静态解释强行关闭问题。
