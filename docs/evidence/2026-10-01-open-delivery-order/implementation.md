# OpenSession 交付顺序修复

2026-10-01 18:32 源码冻结，Cargo 已交回根任务。只完成源码与受控检查，尚无本片安装版结论；没有运行真实 Agent、操作正式应用或正式数据库。原工作设置源码摘要保持不变。

## 已确认的缺口

旧 `run` 在 `reply.send` 唤醒接收者之后才释放 `OperationLease`，其中还持有跨来源的精确 `OpenReservation`。新测试通过临时 MetaStore、自有 Python 对端与真实 `ManagerCommand::OpenSession` 派发，在同步 Wake 中立即检查两个预留：成功和明确失败均被拒绝。

[首轮红](red.json) / [原日志](red.log)保留原观察；[消费后红](consuming-red.json) / [原日志](consuming-red.log)进一步先消费真实结果再立即检查，旧生产仍 0 通过、2 失败，两个结果均为 `(false, false)`。这是确定性交付窗口，不是编译失败或靠调度复跑推定。前序全量 discovery 失败与此窗口相容，但当次没有时序采样，不把新反例当作该历史失败的直接现场归因。

## 最小变更

- [`operations/open_result.rs`](../../../src-tauri/src/acp_client/operations/open_result.rs) 新增内部一次性 `OpenDelivery`，把原结果、原 lease、原连接 SessionMap 和 Operation 暂时交给唯一结果接收者。它不是新会话表、队列或持久状态。
- [`session.rs`](../../../src-tauri/src/acp_client/session.rs) 在公开 manager 方法返回前调用 `accept()`，先取出真正的成功或错误，再释放原 lease；外部返回类型和 IPC 不变。
- 未消费的成功结果，无论发送失败、接收者在通知时消失、结果已进入通道后被丢弃，均先从对应连接移除该 sessionId 的通路并发送原 Shutdown，再释放预留。通知不在 SessionMap 锁内进行，避免同步 Wake 重入死锁。
- [`operations.rs`](../../../src-tauri/src/acp_client/operations.rs) 只替换 OpenSession 分支。原 `execute(... retain=true ...)` 的未知结果等待、请求取消及连接结束语义不改；完整 new/load、设置、检查、通路注册及 ready 完成之后才生成交付对象。未开始请求的 future 被丢弃时释放原 lease，不产生请求。
- [`manager.rs`](../../../src-tauri/src/acp_client/manager.rs) 只调整该内部通道类型。`OperationLease::drop` 关闭中的转移规则不改，仍由实际进程结束释放 closing 预留。
- [`lifecycle_tests.rs`](../../../src-tauri/src/acp_client/lifecycle_tests.rs) 注册新测试，并让原来两条直接消费内部通道的测试显式接受结果；原断言保留。

不采用“先释放后 send”：接收者恰好关闭时会产生孤立清理之前的开放窗口；也不在持锁时发送通知。单纯读取 `is_closed()` 无法消除检查与发送间的竞争。

## 验证范围

[新真实派发测试](../../../src-tauri/src/acp_client/open_delivery_tests.rs)覆盖七项：完整成功后立即关闭、明确失败后立即可重试、通知期间丢弃接收者、已送达但未消费的成功结果、超时未知后迟到成功、等待期间接收者离开后迟到成功、未开始就过期或取消。未确认期间同目标两个预留保持关闭，其他目标可准入；迟到成功清理之后可通过公开 manager 再次打开。

另一个纯守卫测试确认：连接进入关闭后丢弃结果，精确 opening 仍保留到 `life.finish`。原跨服务恢复、实际进程回收、effectful 未知等待和 ListSessions 交付测试继续通过。

| 检查                                   | 结果   | 原始证据                                                        |
| -------------------------------------- | ------ | --------------------------------------------------------------- |
| 首轮六条新派发用例                     | 6/6    | [收据](green-first.json)、[日志](green-first.log)               |
| lifecycle 相关集合（含最终七条新派发） | 53/53  | [收据](related-lifecycle.json)、[日志](related-lifecycle.log)   |
| discovery / preview                    | 7/7    | [收据](related-discovery.json)、[日志](related-discovery.log)   |
| operations（含新关闭转移）             | 9/9    | [收据](related-operations.json)、[日志](related-operations.log) |
| Cargo fmt check                        | 退出 0 | [收据](fmt-check.json)、[日志](fmt-check.log)                   |

最终三组筛选互不重叠，共 69 项；首轮 6 项与最终集合重叠，不额外累加。测试使用四并发，未运行全量 Cargo、clippy 或打包。完整检查及安装旅程由根任务负责。

[controlled-processes.json](controlled-processes.json)从原测试日志派生 19 次新测试 Python 进程观测：均在等待 manager disconnect 完成后核实精确 PID 已不存在。夹具只创建 Python 线程，没有启动真实 Agent；此记录不是全局后代或系统进程审计。全部定向命令已结束，无本片保留的运行任务。

[六文件最终摘要及行数](source-final.json)记录最长文件 1,448 行；work_policy 摘要仍为 `36807e04c60a96fe1cf259e222641fc96d83e478aa9340ffef17e60ac21cae04`。源码冻结后只更新本片证据。
