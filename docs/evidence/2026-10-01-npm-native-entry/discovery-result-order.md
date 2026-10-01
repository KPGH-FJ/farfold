# 列表查询结果交付顺序

本片全量 [rust-2.log](rust-2.log) 实际为 545 通过、1 失败、3 既有忽略；失败位于既有 `explicit_discovery_sends_global_cursor_and_preserves_remote_failure` 的第二页调用。native 入口的新 11 项全部通过，不能把该轮全量写成通过。

[单独精确复现](discovery-isolated.json)一次通过。只读追踪发现每个发现流程夹具都有独立 `AcpManager` 和 `ConnectionLife`，不是多个测试共用同一列表锁；并行负载只是可能影响调度，不能作为确定归因。[operations.rs](../../../src-tauri/src/acp_client/operations.rs) 原先在 `run` 外层持有 `list` lease，通用 `execute` 先调用 oneshot `send`，然后才返回并释放 lease。接收者可在另一执行线程立即进入下一页，此时上一页的锁尚在。

新增 [list_result_tests.rs](../../../src-tauri/src/acp_client/operations/list_result_tests.rs) 给接收者登记同步 `Wake`，在 `send` 唤醒的准确时刻尝试预留下一次列表操作，不用延时或重试绕过保护。[确定性红测](discovery-delivery-red.json)为 2 失败、3 通过：真实成功、真实远端错误的交付点均仍被上一操作阻止。

最小修复仅为 `ListSessions` 使用 `execute_list`：把原 lease 移入整个列表查询 future，取得真实 `Ok` 或 `Err` 后先释放，再由原 `execute` 交付。`all_pages` 的内部各页不提前释放；尚未执行、调用者放弃、超时或连接结束时仍由原只读流程放弃并 drop 查询，释放其 lease。没有改变通用 `execute` 或任何有副作用操作的保留规则，也没有删掉忙碌保护。

最终五个新增用例覆盖成功/失败交付、pending 仍阻止下一次、调用者取消、未开始的过期/放弃操作不派发，以及只读超时后的真实 drop。早期放弃用例最终显式销毁接收者并使用一旦被 poll 即失败的 future，避免把等待超时误当早取消。既有有副作用超时保留等三个用例一起回归；原实际发现分页夹具也单独复测。结果见 [discovery-delivery-green.json](discovery-delivery-green.json)，文件身份见 [discovery-source-final.json](discovery-source-final.json)。本节是源码与受控验证，不代替正式应用中的列表查找验收。
