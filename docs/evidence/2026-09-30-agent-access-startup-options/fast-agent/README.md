# fast-agent 启动失败：目录与公开入口的分层调查

本目录只记录 `0b6d74c` 安装观察后的调查。未改产品或外部包，未读取凭据，未调用认证、`session/new` 或 `prompt`。独立探针只发送一次 `initialize`；动态错误正文和环境值不落盘。目录里的脚本、distribution 清单和生成入口都是公开代码。

## 正式安装观察

- 安装版的空模型输入沿用目录声明：`fast-agent-acp==0.10.1`、参数 `-x`、公开环境 `FAST_AGENT_MODEL=codexplan`。连接检查失败，没有提交登记或安装清单；原有 8 个 Agent 保持。该安装操作与数据保护由主任务记录。
- `installed-startup-diagnostics.json` 只保留相关日志的方向、时间、字节数：发出 `initialize`，约 0.98 秒后收到合计 282 字节 stderr，没有协议回复。没有保留正文，不能据此判断具体异常。
- `formal-app-cwd.json` 是主任务的实际进程观察：正式应用操作系统工作目录为 `/`。

## 问题一：实际子进程目录没有采用连接目录

当前 `ProcessTransport::connect_to` 直接调用锁定 SDK 的 `AcpAgent::spawn_process`。SDK 2.2.0 的启动配置只有 command/args/env，启动实现没有 `current_dir`。因此逻辑连接目录虽然是应用数据目录或用户选择的目录，子进程仍继承正式应用的 `/`。

官方 fast-agent-mcp 0.10.1 的 `context.py` 在启用默认会话历史时先创建 `SessionManager`；`paths.py` 默认使用 `Path.cwd() / '.fast-agent'`，`session_manager.py` 会创建其中的 `sessions` 目录。固定源码位置和摘要见 `source-before-probe.json`。这不是 Farfold 写外部配置，也不能通过改 HOME 或给根目录写权限绕过。

| 独立条件                                                     | 公开入口                                | initialize 结果                                          | 安全诊断                                                                         |
| ------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| cwd=`/`，含空格 venv，真实 HOME/login 环境，目录 `codexplan` | 有效 `fast_agent.cli.commands.acp:main` | 14.361 秒退出 1；无 stdout；stderr 14,124 字节           | 固定异常 `FileNotFoundError`/`OSError`；Errno 2/30；出现已知 `/.fast-agent` 位置 |
| 自有空可写 cwd；同指定运行环境、版本和公开命令               | 有效 `fast_agent.cli.commands.acp:main` | 13.283 秒收到 596 字节 initialize 回复；stderr 0；退出 0 | 返回 `fast-agent-acp` 0.10.1；只创建自有 `.fast-agent/sessions` 目录，没有文件   |

原始收据分别是 `initialize-directory-probe.json` 和 `initialize-entrypoint-counterprobe.json`。第二次只发送 initialize，然后关闭输入并回收进程，没有模型读取、认证或请求成功证据。

这是对实际工作目录缺口的最小反证，不能扩大成正式安装 282 字节错误的完整归因：正式失败候选已经回收，未保留其生成入口；根目录探针与正式失败的错误量和耗时也不同。两次独立探针重新准备了临时 venv，临时绝对路径不同，不能声称所有动态文件字节完全相同。

## 问题二：两个官方 distribution 声明同名 console

当前缓存的两个 0.10.1 distribution 都声明 `fast-agent-acp`：

| distribution          | 声明目标                           | 模块是否存在 |
| --------------------- | ---------------------------------- | ------------ |
| fast-agent-mcp 0.10.1 | `fast_agent.cli.commands.acp:main` | 存在         |
| fast-agent-acp 0.10.1 | `fast_agent_acp.cli:main`          | 不存在       |

wrapper distribution 的缓存 `RECORD` 只有 5 个 dist-info 文件，完全没有 `fast_agent_acp` 模块。它的公开 METADATA 依赖 `fast-agent-mcp==0.10.1`，并说明自己是便捷入口。两份 wheel 的同名 console 声明不同，生成脚本的最后覆盖结果不能仅从安装包版本推断。

先前 `initialize-writable-probe.json` 的准备检查发现生成入口不是预期 MCP 目标，立即停止；该次没有启动 Agent，也没有发送 initialize。该次完整脚本未保留，不能补写成已确认 wrapper 目标。

新条件探针先保存实际生成脚本、两份已安装 entry_points/RECORD，再检查目标是否是已声明的官方目标且模块存在。本次得到有效 MCP 目标并完成可写目录握手。公开文件及其摘要位于 `prepared-entrypoint/` 和 `initialize-entrypoint-counterprobe.json`；没有修改生成脚本或包来取得成功。

同名声明与缺模块是已确认的公开包事实；它们是否导致本次正式安装的 282 字节错误仍未确认。不能把耗时或字节数相近当作错误正文证据，也不能为通过检查而 patch 外部包。

## 回收与下一步

所有探针和准备进程均已结束。公开入口收据保存后，本次唯一保留的自有临时目录已精确清理，见 `entrypoint-counterprobe-cleanup.json`；根目录未创建 `.fast-agent`。历史收据保持原样。

下一片可以在通用 `ProcessTransport` 启动落点采用已验证的实际 cwd，保留官方 `ByteStreams` 和既有 Child/进程组回收；实现草案与必要回归见 `cwd-implementation-draft.md`。产品源码当前没有因此变更，正式安装复验仍待完成。公开入口覆盖问题单独保留，不能用 cwd 修复宣称整个 fast-agent 安装已通过。

## 后续核对（2026-10-01）

真实 cwd 修复已进入[新片](../../2026-10-01-agent-process-cwd/backend.md)，上述原安装失败与独立探针保留原条件。当前[官方 ACP 文档](https://fast-agent.ai/acp/)同时说明便捷 wrapper 路线，以及安装 `fast-agent-mcp` 后运行 `fast-agent-acp` 的路线。后一条可作为需要明确呈现来源的官方替代路径依据，但本次尚未在 Farfold 实现或执行，不默默替换目录声明的 distribution，也不使用文档中的浮动版本命令。
