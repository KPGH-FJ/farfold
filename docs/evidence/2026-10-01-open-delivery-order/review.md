# 对话打开交付顺序：独立审查

2026-10-01。只读检查冻结六文件、内部 channel/公开接收落点、原 effectful 等待和生命周期转移，以及保存的红绿收据。未运行 Cargo、应用、Agent、测试 helper 或正式数据库。结论：当前修复没有发现阻断问题；完整工程检查和安装旅程由根任务另行核验。

## 冻结身份

[source-final.json](source-final.json)的六文件 SHA256 与实际字节全部一致，最长 1,448 行；work_policy.rs 也仍匹配该收据单列的摘要。本次临时交付对象不是持久记录、请求关联表或另一恢复体系。

| 文件                                                                                     | SHA256                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [operations.rs](../../../src-tauri/src/acp_client/operations.rs)                         | `7fa7c39c32d0415ecea851711c577a6a6de476541a7f0e79c1139c31eef0dac2` |
| [operations/open_result.rs](../../../src-tauri/src/acp_client/operations/open_result.rs) | `652e4cf8b69a8fd9caebe0a29f613d6c00a4fa183d02f6f7ae3a35e641ded97e` |
| [manager.rs](../../../src-tauri/src/acp_client/manager.rs)                               | `df069058c0f1db798326473457659a19284ab4f849d7772ed3c555a477f8ab06` |
| [session.rs](../../../src-tauri/src/acp_client/session.rs)                               | `ea63eb9dbbfe4e29458cae0aba9c008ca55709e76b8b1637e084c10616c4b34b` |
| [lifecycle_tests.rs](../../../src-tauri/src/acp_client/lifecycle_tests.rs)               | `e7eda250434b10dc52f858327e4e39c3afac86a8a79c29a375f17ab6d674c3d5` |
| [open_delivery_tests.rs](../../../src-tauri/src/acp_client/open_delivery_tests.rs)       | `456b5a4a31647976c3bbc02f6dfb1d70037ece5a2c8ffca4212b9067f9c65745` |

## 所有权与失败边界

`OpenDelivery` 接收原 `OperationLease`，内部结果仍等待完整 `open_session_on_connection` 完成，不在收到单个 load JSON 时提前释放。`open_session_owned` 取得内部结果后调用 `accept()`：先取出原 Ok/Err，再 drop lease，之后才将原结果返回公开 manager 调用方。两个预留因此不再依赖发送方 `run` 退出的时机。

发送失败、发送后未消费、同步 Wake 中接收者消失以及迟到成功均落到同一个 Drop。成功值未被接受时，先将该操作标为 abandoned，再在现有 SessionMap 中精确移除其 session entry；锁已释放才向该 entry 的 control 发送 Shutdown，动态 guard 随 entry 销毁，之后释放原 lease。`reply.send` 不在 sessions/activity/opening 锁内，避免同步唤醒重入这些锁。已接受成功的 route 保留；未接受的 Err 没有成功 route，需要释放的仍只是该次原 lease。没有新增远端 close/delete 请求。

原 `execute(..., retain=true, ...)` 的 stop、deadline、未开始检查和未知结果等待没有生产改动。未结算的 wrapper future 持有原 lease：已发送后调用方离开或超时仍等待真正结果或连接结束；迟到成功清理后才开放重试。命令尚未开始即过期/接收者关闭则不发送 load，丢弃 wrapper 释放原预留。连接进入 CLOSING 时继续由既有 OperationLease::drop 转移 opening/admission，直到真实进程 owner finish；没有直接清 closing_opens。

原 map/生命周期锁失败分支和异常进程结束行为未在本片扩写；本次成功 Drop 路线的受控证据不是对所有锁毒化情况的清理保证。原模型、来源、事件/队列、协议请求和外部 IPC 结构没有本片生产差异。

## 真实受控证据

[consuming-red.json](consuming-red.json)与[原日志](consuming-red.log)为两项真正行为失败，0/2：在真实 ManagerCommand::OpenSession 的同步 oneshot Wake 内取得结果后，两类预留仍被拒绝。不是编译失败，也不是重写相同逻辑的纯模拟。

[首绿](green-first.json)及[日志](green-first.log)为六项通过；最终在[生命周期](related-lifecycle.json) / [日志](related-lifecycle.log)的 53 项、[历史预览](related-discovery.json) / [日志](related-discovery.log)的 7 项和[操作](related-operations.json) / [日志](related-operations.log)的 9 项检查中均退出 0，[格式](fmt-check.json)退出 0。最终包括七项真实 manager/SDK/self-owned Python 对端用例及一项关闭中转移纯例：

- 同步 Wake 中接受成功或真正失败后立即取得两类预留，成功还走真实 preview close。
- 同步通知期间 Drop 接收者，以及发送方已结束但结果尚未消费：先清孤立 route，再开放预留；缓冲未消费期间仍受原预留保护。
- 已收到 load 后调用方放弃或短 deadline：同目标被拒、独立目标可操作；显式释放对端后清迟到成功，并通过公开 open entry 重试。
- 未开始过期/接收者关闭不发送 load；CLOSING 转移仍等真实 finish。

[受控进程记录](controlled-processes.json)为各轮新测试的 19 次自有 Python 退出观察，均在 awaited manager.disconnect 后记录 gone；它不是安装版或系统全进程审计。本轮没有真实 Agent、账号、消息首发或安装验收，不能由这些 fixture 扩大为对应产品旅程已经完成。
