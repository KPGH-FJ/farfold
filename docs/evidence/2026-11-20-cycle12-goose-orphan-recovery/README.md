# 第 12 周期 Goose 断线后原命令回收核对

2026-11-20，北京时间。以正式 Farfold `87ac54ec2`、macOS arm64、Goose `1.59.1` 的自建原会话 `20261119_4` 为准。原工具 `call-7153581d-1328-404c-8c08-ef3556a52f38` 在对话中前台等待。Goose 连接进程 `61215` 与 Shell `61339` 属于不同进程组，sleep `61341` 随 Shell。仅结束测试连接进程后，两个原工具进程仍在运行，约 155 秒后由脚本自然结束。Farfold 始终保留原步骤结果未知。 [正式断线及冷开原件](../2026-11-20-cycle12-goose-queue-recheck/README.md#独立命令工具组断线与热重连)

## 为什么原命令继续运行

Goose 启动 Unix Shell 时通过 `process_group(0)` 新建工具进程组。Goose 活着时，原工具的取消、超时和执行对象析构能结束该组。进程被系统立即终止时，Goose 来不及跑这段清理，原前台 Shell 可被系统接管并继续执行。Farfold 持有亲自启动的 Goose 进程，以及以该进程编号为组号的那一组。它的退场确认只覆盖该组，原 Shell 转到独立组后不在该范围内。 [Goose 启动与清理源码](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/agents/platform_extensions/developer/shell_process.rs#L12-L89) · [原工具取消和超时](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/agents/platform_extensions/developer/shell.rs#L469-L483) · [Farfold 连接进程退场](../../../src-tauri/src/acp_client/process.rs#L452) · [macOS 组信号范围](../../../src-tauri/src/supervisor/macos.rs#L189)

## 现有入口的边界

- `session/cancel` 只查当前存活 Goose 进程中的会话取消信号。新的进程即使读回同一原会话，也不会接回旧的 Shell。无信号时返回空成功无法证明旧工作已结束。读取原历史只回放厂商已存的记录。 [原取消实现](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/acp/server.rs#L2367-L2384) · [原加载实现](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/acp/server/load_session.rs#L367-L412)
- 官方当前目录 `1.60.1` 仍以 `goose acp` 启动。两版 Shell 组代码字节一致，SHA-256 `03f8a0e8e0783551a46ec05ef66a0dcb640b5540a65059f8fc5a4666c61f2f72`。两版公开入口均未提供按原对话及原普通 Shell 工具查找、精确取消和读回退出结果的方式。计划任务的停止只接受那个独立接口创建的任务编号。 [现行官方目录](https://raw.githubusercontent.com/agentclientprotocol/registry/main/goose/agent.json) · [1.60.1 对应实现](https://github.com/aaif-goose/goose/blob/v1.60.1/crates/goose/src/agents/platform_extensions/developer/shell_process.rs) · [计划任务实现](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/acp/server/schedule.rs#L297-L337)
- 测试能确认原进程，是因为断线前在隔离目录记录了进程身份、启动时间及亲子链。正式入口当前没有这份由 Goose 提供、绑定原工具的材料。会话环境变量可被继承或改写，不能把同目录、命令名、单个进程编号或同一会话内所有进程当成本工具所有权。macOS 的负进程号信号仅发往一个进程组。 [Goose 会话环境](https://github.com/aaif-goose/goose/blob/e62a656f460d6399b34c747014d810727ff70b05/crates/goose/src/agents/platform_extensions/developer/shell.rs#L616-L622) · [Farfold 进程身份记录](../../../src-tauri/src/supervisor/macos.rs#L25) · [产品边界](../../../PRODUCT.md)

本批复核沿原样本取证，未新增模型请求或改动应用。精确回收仍待支持。可复验条件是原工作自身在连接失联后被可靠收回并留下原工具终态，或由官方接口从同一原工具核对身份、精确停止及取得终态。第三方客户端终端可按官方 `terminalId` 回收由自己启动的进程，当前 Goose 内置 Shell 自行启动，不经过该入口。具备条件后，从正常入口同时运行独立 A、B，只断开 A，核对 A 工具及子进程确实结束，B 继续，原队列和未知保护无误。 [ACP 终端协议](https://agentclientprotocol.com/protocol/v1/terminals#killing-commands)
