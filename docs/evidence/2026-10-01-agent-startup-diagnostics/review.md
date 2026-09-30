# 安全启动诊断：独立审查

2026-10-01 05:31–05:44（UTC+8）。最终独立审查**未发现剩余源码阻断**。初审提出的两项问题均已有实际红绿证据，冻结后已复核必要差异。未运行 Cargo、真实 Agent、正式应用或探针；未改生产/测试、读取凭据或原始协议正文。以下测试结果来自作者及根任务的原始收据，正式安装验证另行判断。

## 输入与范围

已核对[设计](../2026-10-01-agent-access-directory-batch5/startup-diagnostics-design.md)、[导出设计](export-design.md)、桥接对应的锁定 SDK 2.2.0 公开源码，以及当前新增固定摘要、DebugTap、manager、唯一 Child owner、安装目录回收和导出代码。

| 05:31:48 核对输入                                 | SHA-256                                                            | 行数 |
| ------------------------------------------------- | ------------------------------------------------------------------ | ---- |
| `src-tauri/src/acp_client/startup_diagnostics.rs` | `1f29a52933b90a95e53fd08806f6d9c110255f4f611c39a7a5a13f12df142c07` | 291  |
| `src-tauri/src/acp_client/tap.rs`                 | `9d74b1754e6a33df9ded7a912b0c5f5bea64a412b9666fc7d8b58bb5316db61e` | 227  |
| `src-tauri/src/acp_client/manager.rs`             | `e263dfa2bd8fc0dab5e9b7a9d2581e4b7bd9c486ad08434a0b3d37ed98a0e05e` | 1448 |
| `src-tauri/src/acp_client/process.rs`             | `0d1e5a0736277c1805c9b4295805fb47553b17a7a1b636d279981913d7243007` | 325  |
| `src-tauri/src/diagnostics.rs`                    | `fa55a586a87b52852bfd6631468c06e8894a74c479c2f3b8cd9d8bf770a7cb79` | 649  |

以上表格保留初审输入。最终已逐文件核对作者 05:42:11 的[13 项冻结记录](source-final.json)，其中 12 项当前 SHA 完全相同；唯一差异是根任务为通过格式检查调整 `mod.rs` 模块声明排序，当前 SHA 为 `fecb40ea33dee924f08a38307bd16d4eb190cb6e5961b71a992382bb7eb81ca3`。13 项全部匹配根任务 05:42:48 的[428 项候选输入](candidate-source.json)，安装冻结身份以此记录为准。

受控测试源包括 `startup_diagnostics/tests.rs`、`startup_diagnostics_tests.rs`、`process_startup_tests.rs`、`agent_install/cleanup.rs` 和 `diagnostics/log_tests.rs`。已读取首次五例红日志，结果为 0 通过 / 5 失败，失败原因均为有界等待未得到最终摘要；该原始失败保留，未以随后通过覆盖。

## 已核边界

- 一条 outgoing initialize 在桥接转发前记录单个内存 RequestId，仅同 ID 的 incoming response 匹配。ID 不序列化；错误方向/其他 ID 不计，匹配 result/error 与 Handshake 解码接受分开。摘要首次确定的启动结果不会被迟到成功改写。
- 唯一 Child owner、原参数/环境/真实 cwd、进程组终止和 wait/reap 链保持。只有成功 ExitStatus 设置退出码/信号与 reap，等待错误单独保留；TERM/KILL 是我方请求事实，`exitObservedBeforeTerm` 只陈述观测顺序。没有把收到 SIGTERM 推为程序自行崩溃。
- 摘要在同一 writer 的固定槽中独立于普通 64 项队列，另有 64 KiB 有界摘要预算。最终 worker 使用同一有界队列的记录/唤醒消息，无定时轮询；队列满时已有消息提供唤醒，槽更新不丢失。worker 不自持 sender，最后 owner 释放、队列读完后仍读取最新槽再结束；协议与进程回收不等待诊断磁盘。落盘和导出均重建固定类型白名单，未透传正文、argv/env、路径、ID 或任意 Value。磁盘失败仍是尽力记录，不能据缺失记录推断进程事实。
- 候选文件仅在原管理关闭检查后，无已启动 Child，或实际 reap / group 结束 / 同 key 移除联合成立时可释放；未知/poison 保留文件与既有未选收据，不改变原选中目标。明确 TempDir close 后再查存在性，删除失败/未确认分别留存，未用 Drop 证明删除，也不覆盖原启动错误。
- 导出读取固定文件长度，头尾不重叠、合计不超过 256 KiB，只解析完整换行；每文件保留最后合法摘要并先预留总预算，仍最多 32 文件 / 2 MiB。非法或截断摘要不能替换合法记录；真实重复普通事件不按文本去重。预览仍是 ZIP 唯一审阅快照。

## 初审问题与关闭证据

**P2：复用 READY 连接仍新建启动诊断，已关闭。**05:31:48 的 `manager::connect_launch` 在内部 READY 早返回前无条件 open DebugTap/worker；多次复用会生成未创建 Child 的伪启动文件，可能挤出真正失败证据。最终普通连接传入 `None`，诊断创建延后至 READY 返回与环境准备之后；候选仍显式传入自己的摘要。[真实 manager 反例](ready-reuse-red.log)复用 40 次得到 41 文件、预期 1，实际红；[最终定向](startup-final-stable.log)验证仍仅 1 文件、1 次 initialize。

**P2：真实 spawn 失败先写 outcome，会与明确取消冲突，已关闭。**05:31:48 的 OS 错误处提前写 `StartFailed`，可能先于调用方明确取消。最终进程层只保留原实际 `start_failed` 原子事实，outcome 由 manager receive 或取消分支确定。[真实 OS 缺失路径反例](spawn-cancel-red.log)在其后选择取消，实际摘要 start_failed、预期 cancelled，实际红；[最终定向](startup-final-stable.log)验证 cancelled 且没有 Child。普通 spawn 失败的 AGENT_START_FAILED 与 start_failed 摘要测试也继续通过。这一用例验证实际 OS 失败后的确定排列，不单独声称执行了整个 Tokio 双就绪 select 竞态。

## 收据与结论边界

已核对作者[最终定向收据](focused-final.json)及日志：启动摘要 16/16；其余生命周期、锁错误、候选关闭、导出、cwd、安装及 tap 各组均退出 0。过滤器存在重叠，不将这些组相加为独立测试数量。较早受影响组与最终窄修复的时间差由根任务完整测试收口。

根任务在最终候选输入上运行的[完整 Rust 收据](checks-rust-full-formatted.json)记录 fmt/clippy/test 均退出 0；[完整测试日志](rust-full-formatted-2.log)为 472 通过、3 项既有忽略。首次仅模块排序的 fmt 失败收据仍保留；本审查没有另开 runner。

未发现新增执行路线、生命周期 owner、请求/正文账本或候选提前释放。受控通过不代表 Grok、Factory、Junie、Minion 的旧失败原因已定位；旧失败不得用新字段追溯补齐，正式候选重试与预览/导出仍需独立安装证据。
