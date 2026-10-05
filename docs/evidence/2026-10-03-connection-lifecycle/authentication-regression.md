# 认证回执与操作状态竞态

完整 Rust 第二轮中，连续认证用例的第二次调用偶发被拒绝为“上次操作尚未结束”。修前 `operations.rs` 和 `api_key_auth/tests.rs` 均与本轮执行前副本逐字节相同。

原因：`authentication_result` 先通过一次性通道发出结果，`run` 在函数退出时才释放操作保护。接收方被同步唤醒后立即重试，可早于保护释放。

## 确定性回归

子任务 `/root/connection_lifecycle` 的工具输出留有下列记录，未另存原始日志文件；这些不是从完整测试日志推算。

- 红测 `authentication_delivery_releases_reservation_before_confirmed_reply`：退出 101；在实际通道发送唤醒点，预期 `[true]`，实际 `[false]`。0 通过、1 失败；工具会话 1144，结果片段 c96c95。
- 修复后 `cargo test … authentication_ -- --nocapture`：12 通过、0 失败，退出 0；工具会话 63970，片段 ad33f1。覆盖成功、确定错误、未发送、超时未知及关闭中保护。
- 原 `protocol_key_wire_round_trip_keeps_secret_out_of_cache_and_error_diagnostics`：1 通过、0 失败，退出 0；工具会话 11900，片段 655387。该测试未修改。

## 修复

认证结果处理持有原有操作保护，确认结果/未发送在回执前释放；超时进入未知等待后继续持有，关闭中仍将保护转交至实际进程结束。未添加新的认证流程或改变密钥交付。独立只读复核未发现此范围内阻断。最终完整检查日志另附。
