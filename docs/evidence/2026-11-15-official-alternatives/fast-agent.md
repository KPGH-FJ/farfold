# fast-agent 官方终端控制替代路径

2026-11-15。范围为现有同一安装的 fast-agent-acp 与 fast-agent-mcp 0.10.1，macOS。验证 ARCH-28、ARCH-29、ARCH-44、ARCH-45 的停止与隔离分项。

## 现有接口

官方目录的启动参数包含 `-x`。同版本文档及已安装源码说明，当客户端声明工具终端、会话启用 Shell 且 Agent 设定没有要求优先本地执行时，普通 Shell 工具委托客户端执行。认证终端声明与工具终端声明各自独立。Farfold 目前声明前者，标准会话派发未接工具终端。 [官方登记](https://raw.githubusercontent.com/agentclientprotocol/registry/main/fast-agent/agent.json) · [同版终端接法](https://github.com/evalstate/fast-agent/blob/v0.10.1/docs/docs/acp/index.md#shell-and-file-access) · [会话接线](https://github.com/evalstate/fast-agent/blob/v0.10.1/src/fast_agent/acp/server/session_runtime.py) · [Farfold 握手](../../../src-tauri/src/acp_client/manager.rs#L690) · [会话派发](../../../src-tauri/src/acp_client/pump.rs#L358)

现有 `session/cancel` 只取消指定会话正在等的请求。同版委托终端遇到超时会依次发 `terminal/kill`、`terminal/output`、`terminal/release`，收到 `CancelledError` 则脱离等待。已有本地 Shell 受控原件证明，模型侧 `process(stop, process_id)` 和关闭自有运行实例可物理终止对应的会话级子进程。该库调用与目前可见的 ACP 客户端请求分属不同入口。 [同版停止实现](https://github.com/evalstate/fast-agent/blob/v0.10.1/src/fast_agent/acp/server/agent_acp_server.py#L745-L775) · [终端实现](https://github.com/evalstate/fast-agent/blob/v0.10.1/src/fast_agent/acp/terminal_runtime.py) · 既有本地对照（本机 `output/2026-11-13-cycle67-closure/fast-stop/summary.json`）

## 受控结果

实际执行已安装的 `ACPTerminalRuntime`，并运行从同一安装提取的精确 `AgentACPServer.cancel` 方法。替代传输端按正式终端方法名收发，只接受事先限定的两条临时会话及同一条有限时长的测试命令。临时程序与临时会话无网络、模型、实际配置或正式数据路径。此夹具覆盖委托终端的库实现、模拟客户端接线及真实子进程结果。完整 ACP 传输、正式应用和真实 Agent 工作流仍待验。

1. A、B 均实际收到终端创建及等待请求，两条独立子进程输出启动标记。取消 A 的精确前台任务后，A 实际子进程仍活，A 未发终止或释放请求。
2. 客户端利用自己持有的句柄精确终止 A，核到实际退出 `-SIGTERM`。同一客户端 B 仍在运行且请求未结束。
3. B 达到自身的测试超时后，官方委托终端发出了终止、取输出和释放，B 实际退出 `-SIGTERM`。回执记录整个过程 3.467 秒，共两个自有子进程与两个精确终止信号，零网络尝试、零越界请求，核查的四份安装源码摘要一致。

首轮夹具将标准错误接到 `/dev/null`，文件写入审计在启动前拒绝该打开操作，零启动。只改夹具为使用管道，第二轮完成上述验证。 夹具（本机 `output/2026-11-15-official-alternatives/fast-agent/terminal_control.py`） · 首轮原件（本机 `output/2026-11-15-official-alternatives/fast-agent/terminal-run-01/receipt.json`） · 第二轮原件（本机 `output/2026-11-15-official-alternatives/fast-agent/terminal-run-02/receipt.json`）

## Farfold 可开发的范围

- 实现使用官方工具终端的通用客户端接线，能以连接、会话与原请求定位 Farfold 自己启动的终端。先接完整创建、输出、等待、终止、释放及工作目录和命令授权，再启用该能力声明。已有获准 shell 行为和认证终端走各自原路径。工具终端只受已核权限与有效会话控制，收到停止时拒绝该请求的迟到创建，等待自己持有的进程退出，再报告该终端结果。待核终态保留现有忙态与未知保护。 [ACP 终端契约与权限边界](https://agentclientprotocol.com/protocol/v1/terminals#security)
- fast-agent 的 `terminal/create` 使用 `sessionId`，并由客户端返回终端 ID。该调用自身无工具事件 ID。工具事件、ACP 回包与终端退出记录应按可核归属分列，遇到映射缺失单独说明。按原条件复测并发、迟到回包、正常退出与恢复、权限拒绝、实际命令及子进程退出。使用登记启动形态与当前已选服务，核 Shell 是否实际委托。
- **官方依赖**：Agent 自行托管的本地进程、持久任务、远程工作及外部 MCP 工作未交给这个客户端终端。对这些路径仍需官方将取消传到原任务或给出精确可调用的控制及终态接口。同一安装缺少客户端可直接调用的 `process(stop)` ACP 方法。该模型工具、服务端实例关闭和另开一轮均无法提供既有停止按钮所需的精确原请求控制。 [官方 Shell 配置](https://fast-agent.ai/ref/config_file/#shell-execution-settings) · [原正式反例及结论](../2026-11-13-cycle67-closure/README.md#未通过与缺条件)

**首发建议**：保留，先实施并完成委托终端的真实停止、隔离及恢复验证。现有 fast-agent 入口的 S7 仍未通过。若已选首发设置的关键实际工作无法委托客户端，且无具备精确终态的官方控制，按已授权范围再作去留判断。
