# 收到的协议错误：有限诊断方案

结论：存在一个可由现有机制补齐的调查缺口，建议只为真实入站错误回复增加固定类别，沿原无正文日志、预览与导出流程保存。该片不修改请求、认证、取消或失败结算，不增加请求账本、Agent 分支或 UI，不解释 VTCode 失败根因。本稿只读源码、已保存的无正文证据及锁定 SDK 的公开源码；没有运行 Agent、模型、应用、安装或 Cargo，没有读取用户凭据、配置或原始错误正文。

## 现场事实与必要性

[batch7 原诊断](../2026-10-01-agent-access-directory-batch7/read-only-diagnosis.md)及[协议元数据](../2026-10-01-agent-access-directory-batch7/protocol-metadata-final.json)记录：`26e9592` 的 VTCode 已连接并创建测试对话，唯一 `session/prompt` 在 `1790802726414` 发出；三条更新之后，`1790802727462` 收到 `response/error=protocol`。没有目标标记成功回复，具体原因未知。1268 字节不能说明错误内容；已存元数据没有 ID，不能仅凭时间顺序独立证明回复关联。

[发行核对](../2026-10-01-agent-access-directory-batch7/vtcode-release-diagnosis.md)未发现可证实的 Farfold 分发或映射错误。目录版本 `0.96.14` 与程序自报 `0.96.12`、空认证表的对应关系有静态线索，但不能代替本次请求错误码。补入站有限分类有实际调查价值，不能按固定 tag 猜账号、Key、模型或网络原因。

## 当前机制

- [process.rs:297–314](../../../src-tauri/src/acp_client/process.rs) 使用官方 `Channel::bridge_with_inspection`。出站回调调用 `annotate_outgoing_error`；入站回调已有真实 typed 消息，却只记录 `error=protocol`，没有类别。
- [startup_diagnostics.rs:270](../../../src-tauri/src/acp_client/startup_diagnostics.rs) 已对 typed `RpcResponse::Error` 提取固定出站类别、`RequestId::Null` 布尔及观察时的 `initializeAccepted` 状态。使用 `try_lock`，锁冲突或失效时省略整个可选组；新观察没有磁盘操作或等待。
- [tap.rs:58–102](../../../src-tauri/src/acp_client/tap.rs) 从验证字段重建记录，旧 v1 可选分类组目前只接受 `dir=out/event=response/error=protocol`；仅在生成端补字段仍会被 writer/export 的 validator 剥离。
- `Diagnostics::record` 继续用容量 64 的普通队列和 `try_send`；满队列可丢普通记录。v2 启动摘要使用原独立槽，本片不修改该槽或其清理事实。
- [diagnostics.rs:205–267](../../../src-tauri/src/diagnostics.rs) 的 `safe_logs` 对固定头尾窗口中的完整行逐项调用同一个 `safe_record`，随后按已有预算形成预览快照；导出使用已审阅的快照。[既有导出回归](../../../src-tauri/src/diagnostics/log_tests.rs)验证旧 v1、新出站分类与 v2 共存及预览后 ZIP 不变化。

锁定 SDK 为 `agent-client-protocol 2.2.0` / schema `1.9.1`。其 `RawJsonRpcMessage::Response(RpcResponse<Value>)` 保留标准错误 envelope；官方 `bridge_with_inspection` 在转发前按源顺序观察有效消息，包含 batch 的每个有效成员，原帧继续原样转发。非法 wire 帧和传输失败不能伪称已观察到 typed 入站错误回复。

## 最小实现

1. 在现有真实入站 inspection 中，为 `RawJsonRpcMessage::Response(RpcResponse::Error { id, error })` 添加有限分类，仍走原 `record → 普通队列 → DebugTap`，observer 仍返回 `Ok(())`。只读 `error.code`、ID 是否为 `Null` 和现有观察布尔；不调用错误的 `Display`，不从 message/data 推断类别。
2. 保留旧 v1 的三个可选字段：`protocolErrorClass`、`responseIdNull`、`beforeInitializeAccepted`。入站类别闭合为下表；出站仍保持既有六类及其旧含义。旧无分类 v1 继续可读，v2 不变，无需新格式版本。
3. 同步 `safe_record`：仅真实记录上下文 `dir=in/event=response/error=protocol` 接受新的完整、类型正确字段组。每个方向分别使用明确 allowlist；部分字段、错误类型、未知字符串或错误上下文全部剥离整组，原基本元数据仍可保留。不得透传任意 Value 或扩展 code 数字。

| schema 1.9.1 typed code | 入站固定类别         |
| ----------------------- | -------------------- |
| ParseError              | `parse_error`        |
| InvalidRequest          | `invalid_request`    |
| MethodNotFound          | `method_not_found`   |
| InvalidParams           | `invalid_params`     |
| InternalError           | `internal_error`     |
| RequestCancelled        | `request_cancelled`  |
| AuthRequired            | `auth_required`      |
| ResourceNotFound        | `resource_not_found` |
| Other 或未来未知变体    | `other`              |

这些变体在锁定 schema 的 `src/v1/error.rs:149–195` 明确声明。观察到 `auth_required` 仅表示收到这个码，不能证明具体账号缺失；`request_cancelled` 也可能表示资源约束或程序结束，不能证明 Farfold 已发取消。未知码不存数值。`Null` 是合法 JSON-RPC ID，不能据它判断消息畸形或解析失败。

**阶段首片只保留观察时点，不增加请求关联。** `beforeInitializeAccepted` 为观察时尚未接受初始化的布尔；即使 cleanup/timeout 已发生也可能为真，不代表错误产生于 initialize handler。当前观察器只在内存保存一个 initialize ID，[inspect](../../../src-tauri/src/acp_client/startup_diagnostics.rs) 匹配后会清空它，v2 已记录精确 `matched_error`/`matched_result`。该事实不能被扩成 prompt/auth 阶段。虽然 SDK `SentRequest::id()/method()` 公开，但连接可能并发进行其他请求；不为本片新增单槽猜测或请求表。其余关联保持未知。

真正入站 Error 可以按 observed 类别诊断；SDK 请求 await/on-result 产生的本地解码、EOF、超时错误不能从同一数值反推远端 Error。本片不修改 [pump.rs](../../../src-tauri/src/acp_client/pump.rs) 的正常失败/认证标记链，也不改变原正文、队列、来源、模型保护或重试动作。

## 必要回归范围

建议生产最小范围是 `process.rs`、`startup_diagnostics.rs`、`tap.rs`，测试沿现有 `startup_diagnostics/tests.rs`、`protocol_error_tests.rs` 与 `diagnostics/log_tests.rs`；若文件超 1500 行，仅拆测试模块。没有新依赖或存储表。授权后先红再绿，当前未修改或运行测试。

- **真实 bridge 入站 fixture。** 测试自有受控子进程完成 initialize 后，对一个请求实际返回标准错误，至少覆盖 `auth_required`、`internal_error`、`invalid_request`、自定义码，以及 null/non-null ID。从实际 tap 文件核固定分类，并证明收到的原错误仍按原 SDK 流转。旧出站 parse/unknown-method-null 回归继续有效。
- **本地失败反例。** 合法入站 Result 造成 typed 解码失败、EOF、超时不得新增入站错误分类；恶意或不完整 wire 不能伪造 typed Error。取消后迟到 Error 可以是观察事实，但不改变已结算的取消/失败状态，不自动重发或触发认证。
- **纯投影与不确定性。** 枚举全部标准类别；message/data/ID/method/环境和自定义 code 的秘密 canary 不进入记录。Result/Request/Notification 不产生分类。观察状态锁争用或失效省略整组，不等待或填默认布尔；`Null`、接受前/后、timeout/cleanup 时点均只报告实际有限事实。
- **validator 与导出。** 旧 v1、旧出站分类、新入站分类、v2 同时保留；伪字段、未知类别、缺字段、错误类型和错误 dir/event/error 被剥离。实际 `safe_logs → preview → ZIP` 保留合法入站分类，canary/数字码不在文件或预览；预览之后新增记录不混入已导出 ZIP。

普通队列满、文件上限、头尾窗口和总导出预算仍可遗漏这条分类；新增字段不改变丢失语义或保障必达，缺记录不能当成未收到错误。安装验证须使用新候选一次明确请求及有限诊断导出，才能确定该次实际类别；旧 VTCode 首发失败保持，不回填旧码、不读原正文，也不把新分类当成请求问题已解决。
