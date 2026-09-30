# 启动失败安全诊断：只读设计核查

2026-10-01。只读当前启动、安装、进程所有权及诊断导出代码；未改生产/测试、运行 Agent 或应用、读取凭据或原始日志正文。本稿补充现有证据，不另建活动计划，也不将 Grok、Factory、Junie、Minion 的检查早退归因于某个依赖或账号。

**可以小步补充：沿同一连接的现有 DebugTap 留固定阶段、匹配的 initialize 响应观测、实际退出码/信号及回收事实。**这些记录只帮助调查，不参与 Agent 准入、选用、重试或进程终止；不新增数据库、安装历史表、Agent 身份体系或另一套进程所有者。

## 现有机制与缺口

| 当前落点                                                                                                                                       | 已有事实                                                                                                     | 未保留的信息                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [initialization.rs](../../../src-tauri/src/acp_client/initialization.rs#L14) / [manager.rs](../../../src-tauri/src/acp_client/manager.rs#L553) | 四个固定启动错误码；60 秒等待；超时/取消不能被迟到成功改写                                                   | 码只分类失败出口，不能恢复具体阶段、响应是否出现或退出码                                               |
| [process.rs 第 209–274 行](../../../src-tauri/src/acp_client/process.rs#L209)                                                                  | 唯一 Child owner 已调用 status/try_status，持有实际 ExitStatus；TERM/KILL、进程组结束和 reap 由此 owner 确认 | `ProcessControl.done` 仅发送 `Result<(), String>`，具体 code/signal 与应用终止动作被丢弃               |
| [tap.rs](../../../src-tauri/src/acp_client/tap.rs#L30) / [process.rs 的桥接观察](../../../src-tauri/src/acp_client/process.rs#L291)            | 非秘密方向、事件类别、字节数；stderr 只计字节；独立、有界写盘                                                | response 没有请求归属，不能从任意 incoming response 推断 initialize 已响应；当前也无启动/退出/回收记录 |
| [probe_launch](../../../src-tauri/src/acp_client/manager.rs#L273) / [安装失败回收](../../../src-tauri/src/agent_install.rs#L285)               | 实际 owner 结束、连接 key 移除才允许清理；未确认时保留文件和未选收据，旧目标不替换                           | 连接回收和候选文件回收未形成安全摘要；隐式 TempDir Drop 没有可报告的删除结果                           |
| [logging.rs](../../../src-tauri/src/logging.rs#L156) / [safe_logs](../../../src-tauri/src/diagnostics.rs#L153)                                 | 普通日志只留组件及消息字节数；导出重验白名单，需预览后本机导出                                               | 普通日志不会保留固定错误码的正文；新诊断字段不加入白名单就会被排除                                     |

因此，文件回收会使原包检查更困难，但退出码本来就没有写入安全日志。保留现有协议文件不等于已经取得这些诊断事实；旧四项失败不能靠新代码追溯补齐。

## 最小记录与落点

每连接只增加一份固定大小的安全快照，写入该连接既有诊断文件。使用固定枚举、布尔和有界数值，不接收自由字符串：

- `phase`：实际到达的 `spawn` / `registration` / `initialize` / `cleanup`，由相应代码边界更新；不从错误文本猜阶段。首片覆盖已进入候选连接检查的路径，下载/解包失败不冒充初始化失败。
- `startupOutcome`：既有四码或 `success` / `cancelled` / `unknown`。调用方结果一旦确定即保留；迟到响应只更新观测，不改变超时/取消。
- `initializeResponse`：`not_observed` / `matched_result` / `matched_error` / `unknown`，另记 `initializeAccepted`。收到结果包与成功完成 Handshake 解码分开；错误包不记录 code/message/data，也不从 SDK 错误反推远端拒绝。
- `processExit`：只有同一 Child 的成功 status 观测才填 `code` 或 `signal`；未创建子进程、等待失败或未确认时填固定状态，不拿 `null` 冒充退出码 0。
- `termination`：应用曾请求 TERM/KILL、退出状态是否在该请求前已观测。这里只陈述请求与观测顺序；不声称系统已收到信号，也不把取消/超时后的 SIGTERM 当成程序自行崩溃。
- `cleanup`：分别保留 Child reap、进程组结束、连接 key 移除、候选目录 `deleted` / `retained` / `unconfirmed` / `not_applicable`。它们不是同一事实；仅有空管理表或 TempDir Drop 不足以宣称文件已删。

[manager 的实际 initialize 请求](../../../src-tauri/src/acp_client/manager.rs#L489)有锁定 SDK 2.2.0 `SentRequest.id()` 这一公开身份，既有桥接也能观察请求/响应。关联须在出站 initialize 转发给进程前建立单个内存 ID，再匹配入站返回；不能假定 send_request 返回后还来得及注册，也不能拿出站错误响应或其他 ID 充当返回。只保存结果/错误包类别，不保存 ID 或参数，不建立请求映射表。该 SDK 的 `map` 只处理成功结果，错误响应会绕过 mapper，所以不能只在 `Handshake::decode` 里打“已响应”标记。依据是本机锁定包及其[官方固定提交中的公开接口](https://raw.githubusercontent.com/agentclientprotocol/rust-sdk/2a78849d3eb3dcb140dade3b8fc938cf1e2b9ce5/src/agent-client-protocol/src/jsonrpc.rs)。

最小改动范围为 `process.rs`（退出与终止事实）、`manager.rs` / `initialization.rs`（固定结果、匹配响应及连接回收）、`tap.rs`（固定记录和重验）、`diagnostics.rs`（本机预览/导出），必要时在 `agent_install.rs` 明确取得自己 TempDir 的清理结果。辅助类型可拆在 `acp_client`，不改外部包、启动 argv/env、HOME、四码 UI 映射或选用事务。已确认关闭后的目录清理失败仍不得覆盖原启动原因；未确认关闭继续沿原保护保留活文件。

当前写盘通道只有 64 个槽且使用 try_send，协议文件也有上限/停止写入，导出只读每文件前 256 KiB。终态摘要不能直接当普通高频事件发送后假定必然留存：应在同一 writer 保留一个固定大小摘要槽与少量尾记录预算，并让导出有界取得尾摘要、继续按字段重建。诊断 I/O 不得阻塞协议、reap 或 owner 释放；写盘失败、应用异常退出、观测缺失都保留未知，不影响连接结果。禁止为可靠性增加无限队列、全量 stderr 或同步写盘等待。

## 必要反例与真实出口

| 受控反例                                                   | 必须得到的边界                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 同一个自有进程无响应退出 3 / 被信号结束 / 实际 spawn 失败  | 分别保留实际 code、signal、未创建进程；不能都归成同一退出码                           |
| 成功响应、错误响应、畸形结果；另一 ID/方向的响应           | 仅正确请求匹配；畸形结果可“观察到结果但未接纳”；未知包/秘密 canary 不落盘或导出       |
| 超时或取消后迟到成功，TERM 忽略的后代直到 KILL 才结束      | 原超时/取消不改变；终止请求与晚到回收可见；不提前释放 owner 或提交候选                |
| 管理锁/进程等待/目录清理失败、通道满/日志不可写/文件达上限 | 清理分层保留未知/失败；旧目标和活文件保护保持；写盘不延长生命周期，尾摘要按白名单导出 |

这些测试可扩展现有 [startup_tests](../../../src-tauri/src/acp_client/startup_tests.rs)、[cleanup 反例](../../../src-tauri/src/acp_client/startup_cleanup_tests.rs)及[生命周期组](../../../src-tauri/src/acp_client/lifecycle_tests.rs)，不跑真实 Agent 来制造红例。正式安装出口另需用户明确重试一个实际失败条目，核对候选回收后安全记录仍在、固定错误和重试入口保持、旧程序/对话/草稿不变，且日志与完整导出中没有 stderr、argv、env、路径、账号或秘密。没有这一步，不宣称已定位或修复上述四项失败。
