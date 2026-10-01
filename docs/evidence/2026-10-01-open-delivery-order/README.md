# 打开结果与预留释放顺序

2026-10-01 19:25。`6064d05` 已随客户端设置保护候选安装。独立受控红绿、相关 69 项及[独审](review.md)通过，六源冻结见 [implementation.md](implementation.md)、[最终身份](source-final.json)。根任务完成完整 Rust 575 项（四并发、3 既有忽略）、fmt/clippy/构建及正式安装回归，见[组合候选工程记录](../2026-10-01-client-settings-data-preservation/engineering.md)与[安装记录](../2026-10-01-client-settings-data-preservation/installed.md)。

安装回归覆盖原 OpenCode 历史两次冷读取、原模型/来源保持，以及 Amp 模型准备读取；全窗 0 prompt、原正式数据保持。没有执行尚未加入历史的真实预览关闭/重开，微小交付窗口仍由确定性受控用例证明，不扩大为该安装分支或全部 Agent 验收。实施说明内的“未运行真实 Agent/正式数据库”描述子任务受控实施阶段，后续根任务安装回归以本段链接为准。

以下章节保留**实施前的准备快照**，其中“建议”“预计”“待运行”描述当时状态；准备时输入见 [source-basis.json](source-basis.json)，实际结果以实施说明及原始收据为准。这不是新增活动计划。

## 已见失败与代码顺序

前序[第二轮默认全量日志](../2026-10-01-work-policy-data-preservation/rust-full-recheck.log)中，`preview_cleanup_is_idempotent_after_detach_and_agent_exit` 在首次打开返回后，第 625 行第一次关闭预览失败：“此对话上次打开尚未结束，请等待结果后重试”。相同测试在四并发全量通过，不能单靠复跑认定缺口消失；当次未采样预留释放时序，不把下述推导冒称该次直接观测。

- [`session.rs`](../../../src-tauri/src/acp_client/session.rs) 的 `open_session_owned` 先按 Agent、目录、历史 ID 取得 `OpenReservation`，随后传给 `send_reserved`。
- [`operations.rs`](../../../src-tauri/src/acp_client/operations.rs) 把它放入同一 `OperationLease`。OpenSession 在 `execute` 中完成真实打开，`reply.send(outcome)` 唤醒接收者时，外层 `_lease` 仍存活，直到 `run` 离开才释放。
- 预览 `close_session_owned` 也先取该精确预留，所以接收结果的线程可以在释放前遇到冲突。普通后续操作也可能遇到 `open:<id>` 尚未释放；不应仅靠调用方等待一小段时间。
- [`discovery_tests.rs`](../../../src-tauri/src/acp_client/discovery_tests.rs) 已有 `reserve_after_open_completes` 在返回后循环 `yield_now` 等待预留的测试辅助，说明该次序此前已被测试适配；它不能证明产品交付时已可执行后续操作，也不应拿来修复新反例。

## 确定性红例：直接观察实际派发的交付点

复用既有自有 Python 对端、临时 `MetaStore`、真实 manager/SDK 路径。建议在新 `acp_client/open_delivery_tests.rs` 中使用 discovery 或 lifecycle 测试模块的夹具，通过既有 `ManagedConnection::send_reserved(ManagerCommand::OpenSession, Some(opening))` 派发；这条做法已有 [`lifecycle_tests.rs`](../../../src-tauri/src/acp_client/lifecycle_tests.rs) 跨服务恢复用例可参考，不需要测试专用生产开关。

先对实际结果 `oneshot::Receiver` 手动 `poll` 一次，注册自有同步 `Wake`；随后等待 Wake 的完成通知，等待期间不再 poll 原 Receiver，以免其 waker 被运行时替换。Wake 在 `Sender::send` 返回前执行，只做两次立即准入尝试并记录布尔结果：同连接的 `open:<native>` operation，以及同 Agent/目录/native 的 `OpenReservation`。尝试取得的临时 guard 当场释放，不在 Wake 内 panic、不睡眠，也不把新 guard 留到后续关闭制造假失败。

1. **完整成功**：对端返回正常 load，原回放/config/route/pump ready 流程都执行。Receiver 的真实结果须成功；Wake 时两个预留均应已可取得，原 session route 仍在；随后既有 close 能完成。
2. **真实失败**：同一对端针对 load 返回固定协议错误。Receiver 保留原失败；Wake 时两个预留均应可重试，失败没有留下可用 session route。

旧源码预计两例会在 Wake 中记录被拒绝，形成实际派发的确定性红；这仍是待运行预期。不能只重写 `_lease` 生命周期的模拟函数作为全部证明，也不以新增 sleep/yield 让结果变绿。先核实际红后再确定最小生产改动。

## 终态释放必须同时满足的边界

候选修改只针对 OpenSession 的**完整本地终态交付**：`pump::open_session_on_connection` 已等待整个 new/load、必要设置、服务/模型核对、route 注册和 pump ready。不能在收到单个 `session/load` JSON 回复时就释放，因为随后仍有本地步骤。ListSessions 的只读释放包装不能直接套入这里。

| 场景                                     | 必须保留的行为                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 完整成功或真正失败且接收者仍在           | 对外可处理最终结果前释放该次两类预留；成功 route 保留，原错误保持。                                                     |
| 命令尚未开始、接收者已离开或排队期限已过 | 不发送请求；丢弃该次未开始操作时释放，不能遗留预留。                                                                    |
| 已发送后接收者离开、请求超时或取消未确认 | 沿原 effectful `retain=true` 等真正响应或连接结束；另一个来源的同 native 仍被拦住，其他目标不受影响。                   |
| 离开后收到迟到成功                       | 先沿原路径移除该次孤立 session entry 并结束其 pump，再释放；不能让同 native 重试提前接上旧 route。                      |
| 连接进入 CLOSING                         | `OperationLease::drop` 把 opening/admission 留在 `closing_opens/closing_admissions`，直到实际结束；不能绕开此既有转移。 |
| 接收者恰在终态交付期间消失               | `send` 失败返回的成功值仍须按原孤立打开清理，不因提前 drop 丢失这条路径。                                               |

建议只收窄现有 OpenSession 分支的“结算后清理、释放、交付”顺序，不增加全局协调器、第二队列、持久状态或新的身份映射。实现时必须检查最后一项发送竞争；仅在 future 返回前无条件 `drop(_lease)` 不足以证明孤立打开仍受保护。若必须调整内部结果承载形状，应保持对外 IPC 和生命周期语义不变，并先提交具体差异供审查。

## 必要回归与出口

除成功/真实失败两个同步 Wake 红例，还需有界控制对端的“已收到 load，等待显式释放”标记：在响应未给出期间丢弃接收者或触发短测试 deadline，同目标不可再次 load，其他目录/来源的独立 native 可工作；迟到成功后清理旧 route，再允许重试。保留既有[跨来源迟到恢复保护](../../../src-tauri/src/acp_client/lifecycle_tests.rs)与[关闭中预留转移](../../../src-tauri/src/acp_client/lifecycle.rs)用例；新增未开始不派发及交付期接收者消失的反例。

受控测试通过后，再跑相称的 discovery/lifecycle/operations 检查；全量与正式安装由根任务执行。安装可复用已有 OpenCode 历史执行打开→立即关闭预览→再次打开，不需新账号、CLI 安装、修改模型或发送请求。安装通过仍只证明对应历史入口，不取代未知结果和取消竞争的受控证明。
