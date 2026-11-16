# fast-agent 已批准的官方命令审批与停止

2026-11-15。用户批准 fast-agent 走官方 ACP 工具终端，仅执行用户看到程序、逐项参数和工作目录后明确批准一次的命令。其他 Agent 继续原接入。正式 Farfold 0.1.7 arm64，CDHash `aed12e353224056ba742eb7716a95409d81eb09e`。限定已登记的 fast-agent 0.10.1，当前机器的已有设置。 [产品契约](../../../PRODUCT.md) · 安装原件（本机 `output/2026-11-15-cycle12-fast-approved/install.json`）

## 正式版实测

1. 从 Farfold 普通新对话选择 fast-agent 的已有设置，在单独自建目录发一条命令测试。先批准 Agent 自己的单次工具许可，随后 Farfold 单独列出程序 `/bin/sh`、单个参数 `./wait-owned.sh` 和原工作目录；界面有「批准一次」及「拒绝」。本次只批准一次。
2. 观察到由 Farfold 启动的 Shell PID 66676、它的 `sleep` 子进程 PID 66678，两者属于进程组 66676。确认它们正在运行后点「停止」。Farfold 发送原请求取消，Agent 回包后界面显示「回复已停止，仍有步骤未确认结束」。
3. 点击后 273 毫秒内独立观察到两个 PID 已退出。超过原定等待的 60 秒后，完成标记仍未写出，观察器未发送终止信号。长驻 Agent 连接与本次拥有的命令进程组各有归属。 进程观察（本机 `output/2026-11-15-cycle12-fast-approved/fast-process-evidence.jsonl`） · [脱敏时序](live-results.json)

完整需求的实时工具终态、正式双任务隔离、停止后冷续答仍待验。双任务隔离、拒绝无启动和迟到请求已有受控验证；测试覆盖这一组 Farfold 持有的进程。Agent 自管或远程任务需有可归属的官方控制。关闭延迟先报告连接中断，只有确认进程结束才发布关闭回执。

## 工程与安装

- 前端构建及与该候选前端输入一致的 10,937 项前端测试通过。Rust Clippy 通过，当前 Rust 单元测试 2,782 通过、10 忽略，集成测试 10 通过、1 忽略。受控的启动、双任务实际进程隔离、关闭时序、拒绝及迟到创建分项已通过。
- 构建前后 2,624 个输入一致。正常退出后核对 206,918 条保护数据，安装前后摘要相同，私有元数据副本完整性通过。只替换 `/Applications/Farfold.app`，本机正式副本签名已核，重复应用包已清理。 构建（本机 `output/2026-11-15-cycle12-fast-approved/release-build.log`） · Rust 回执（本机 `output/2026-11-15-cycle12-fast-approved/backend-full-tests.log`） · 重复包处理（本机 `output/2026-11-15-cycle12-fast-approved/duplicate-cleanup.json`）
