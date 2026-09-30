# 实际工作目录传递的独立审查

只读复核当前 [process.rs](../../../src-tauri/src/acp_client/process.rs)、[process_cwd_tests.rs](../../../src-tauri/src/acp_client/process_cwd_tests.rs)、[Cargo.toml](../../../src-tauri/Cargo.toml) 与锁文件差异，未发现此改动中的确定阻断。审查者没有运行 Cargo、真实 Agent、正式应用或改动生产源码。

## 核对结果

- 将 `spawn_process_in` 逐项对照本机锁定 `agent-client-protocol 2.2.0/src/acp_agent.rs` 的 `AcpAgent::spawn_process`：相同 command、字面 args、追加 env、`process_group(0)`、三路管道及 `async_process::Child`；唯一启动行为增加是该连接的 `current_dir`。没有 shell 拼接、清空环境、替换 HOME、读取项目启动配置或代写外部配置。
- 原 [manager.rs](../../../src-tauri/src/acp_client/manager.rs) 的普通连接使用已验证、规范化的选择目录，并将同一目录交给进程和会话请求；`probe_launch` 仍使用应用数据目录及独立 candidate key。安装候选没有借此替换已选 AgentRow、握手或用户目录。
- SDK `ByteStreams` 与 `Channel` 桥接保持原实现。启动之后的独立进程组、精确 Child 所有者、stderr 有界排空、TERM/KILL、等待回收、登记失败回收及关闭确认代码没有被此差异改写。
- 直接依赖 `async-process =2.5.0` 复用锁文件里已存在的版本，锁文件仅给 Farfold 添加直接依赖边。已核读[官方发布时间收据](../2026-09-30-agent-access-startup-options/fast-agent/async-process-release.json)：2025-09-14 发布、查询时未撤回，超过 7 天；收据 crate checksum 与锁文件相同。此次没有改 Agent 版本或增加环境开关。

## 已核读的验证及边界

- [最终目录回归收据](focused-stable-green.json)、[原始日志](focused-stable-green.log)：退出 0，6/6。实际自有测试子进程覆盖空格目录、字面参数与公开环境、HOME 保持、并发目录互不污染、父进程 cwd 不变、目录验证后消失不回退且可重试、候选仅 initialize 且原行不变，以及冷恢复保留 native id/模型/推理、漂移继续阻止发送。
- [既有生命周期收据](lifecycle-green.json)、[原始日志](lifecycle-green.log)：退出 0，18/18；覆盖精确 Child 回收、忽略 TERM 的后代、stderr 未结束、登记失败、候选取消及工作保护。该命令明确跳过另一片正在红绿验证的 `auth_cleanup_retries`，不能称整套 Rust 全绿。
- 先前 5/6 的 fixture 正向状态名 `ok` 与真实 `ready` 不符，以及并行施工时缺少测试模块的编译失败，原收据保留；最终收据已覆盖修正后的 6 例。日志仍有另一改动中的 `unused_mut` 警告，完整 clippy/全量检查由根任务后续记录。

这些是锁定 SDK 对照、源码审查和受控子进程证据。尚不能代替新候选的正式安装、实际 Agent 配置发现、首条回复或冷恢复旅程验收；本审查未读取或改写用户凭据和外部历史。
