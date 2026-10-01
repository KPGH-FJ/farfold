# 全量检查失败的范围与处理

2026-10-01。以下区分实际失败、静态可解释路径与尚未确定的运行原因。没有因这些失败修改生产超时、跳过用例或放松工作设置保护；本调查未启动 Cargo、应用或 Agent。检查由根任务串行执行。

## 原始结果保留

| 检查                                                                           | 实际结果                                    | 范围                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| [第一次默认并发](checks-rust.json) / [原日志](rust-1.log)                      | 562 通过、5 失败、3 忽略                    | clippy 先通过；工作设置新增及既有 9 例全通过。                                         |
| [5 项逐个隔离重查](isolated-failure-recheck.json)                              | 5 个原失败测试各自通过                      | 源码未修改；不能据此抹去全量失败。                                                     |
| [第二次默认并发](rust-full-recheck.json) / [日志](rust-full-recheck.log)       | 561 通过、6 失败、3 忽略                    | 无同时 formatter/build，失败集合变化。                                                 |
| [四并发全量对照](rust-bounded-recheck.json) / [日志](rust-bounded-recheck.log) | 566 通过、1 失败、3 忽略                    | 同源码、同用例、同生产超时；仅 `--test-threads=4`。剩余失败是可选诊断字段断言。        |
| [测试断言修正后的最终检查](checks-rust-final.json) / [日志](rust-final-2.log)  | 567 通过、0 失败、3 忽略；fmt/clippy 退出 0 | 全部用例仍执行，测试并发为 4。此次通过不证明默认并发问题全部已解决，也不代表安装验收。 |

## 五项首轮失败并非一个已证根因

1. **入站错误观察**：`protocol_errors_incoming_initialize_null_is_observation_not_request_match` 在 `protocolErrorClass` 上得到 `Null`。[`startup_diagnostics.rs`](../../../src-tauri/src/acp_client/startup_diagnostics.rs) 的 `annotate_error` 明确用 `try_lock`，竞争或锁损坏时省略整个可选分类组；基础错误记录仍保留。[原测试](../../../src-tauri/src/acp_client/protocol_error_tests.rs)却要求每次必须存在分类，二者合同矛盾可由源码确认。日志没有捕获当次 `try_lock` 结果，因此不能写成已直接观测锁竞争。
2. **准备/已有来源的环境用例**：[`dependency_environment_tests.rs`](../../../src-tauri/src/acp_client/dependency_environment_tests.rs) 第 82 行失败的是 `cleanup.unwrap()`，不是随后检查的连接 `status`。夹具在 Python `initialize` 内运行自有 shell 程序，`subprocess.run(..., timeout=2)` 没有捕获异常。超时导致夹具退出、随后清理报“Agent 连接已结束”是可检验路径，但当前日志没有保存固定异常类、`status` 和执行阶段，不能判定为环境传递错误或已证超时。
3. **两个准备探测与共享工具发现**：[`preparation.rs`](../../../src-tauri/src/acp_client/preparation.rs) 的缓存检查及旧程序版本诊断、[`uv_runtime.rs`](../../../src-tauri/src/uv_runtime.rs) 的受管工具探测均使用 [`agent_discovery::version_output`](../../../src-tauri/src/agent_discovery.rs)。它把启动失败、非零退出、读取错误、超量和 5 秒超时等分支归为 `None`。原失败只能证明未取得可用输出，不能由 `None` 认定超时。夹具都是自有临时 `#!/bin/sh` 和内建 `printf`，没有账号、网络或真实安装依赖。

第二轮新增的程序选择与 uv 发布失败也经过上述版本探测；取消测试先在 Node 版本读取处失败，没有到预期取消标记。四并发对照中这 8 个非分类失败测试均原样通过，支持执行并发影响的调查方向，尚不足以区别调度延迟、OS 启动/退出、管道或其他原因。

## 并发条件与另一项顺序候选

仓内有 67 个未显式指定 `worker_threads` 的多线程 Tokio 测试。锁定 Tokio 1.53.1 的 `runtime/builder.rs` 默认使用 `num_cpus`；其 `loom/std/mod.rs` 在没有覆盖时调用 `available_parallelism`。本次只读环境检查取得逻辑 CPU 数 10，`TOKIO_WORKER_THREADS` 与 `RUST_TEST_THREADS` 均不存在。默认并发用例叠加各自运行时，还可能同时存在共享 manager 运行时、诊断线程、进程读取线程和子进程；这是资源竞争条件，不是对当时线程数或资源耗尽的完整采样。限定测试并发没有改生产阈值，也没有减少测试总量。

另需独列第二轮 `preview_cleanup_is_idempotent_after_detach_and_agent_exit`：首次打开已返回后，第 625 行立即清理收到“此对话上次打开尚未结束”。[`session.rs`](../../../src-tauri/src/acp_client/session.rs) 把打开预留交给 `send_reserved`，[`operations.rs`](../../../src-tauri/src/acp_client/operations.rs) 的 OpenSession 分支在 `execute` 交付结果时仍持外层 `_lease`，函数结尾才释放。因而存在结果接收者先尝试相同预留的窗口，不能把这个失败直接归为资源拥塞。当次没有记录释放次序；下一步若处理，应使用同步 Wake 的受控反例证明交付时预留状态，同时保留未知结果、取消和孤立已开对话的清理边界，不能套用只读列表的释放规则。本片未修改该生产路径。

## 本片仅修正观察测试合同

[测试修正身份](observer-test-correction.json)固定唯一追加变更：基础入站 protocol 错误必须被观察到；有任一可选分类字段时，三个字段均按原精确值严格校验；整组缺失时，三个字段必须全部不存在，部分组或 `null` 值不能蒙混通过。原初始化结果匹配、`initializeAccepted`、原 Agent 记录、候选清理和隐私断言保留。

[`startup_diagnostics/tests.rs`](../../../src-tauri/src/acp_client/startup_diagnostics/tests.rs) 已有确定性纯测试：正常入站观察覆盖 9 类完整字段与固定 9 字段形状；显式持锁和锁损坏时只保留 6 个基础字段。因此真实桥接测试不再要求竞争情况下强制产出可选观测，但没有削弱完整注解或安全省略的独立验证。

`work_policy.rs` 仍为 451 行，SHA-256 `36807e04c60a96fe1cf259e222641fc96d83e478aa9340ffef17e60ac21cae04`。前后冻结输入分别见 [原冻结](candidate-source-before-observer-test.json)和[当前冻结](candidate-source.json)；没有改变任何生产源码以使这轮全量通过。
