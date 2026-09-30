# 程序启动与连接检查错误

本片修复 Farfold 的错误归类和重试说明，不修改外部 Agent、安装依赖解析或用户配置。安装版与真实目录重试由根任务统一执行；下述受控测试不能代替安装验收。

## 问题与实现

原 `manager` 的初始化回执只发送成功响应。请求返回错误时发送端被丢弃，拒绝响应与本地响应解析失败都可能变成“初始化期间进程退出”。前端又把这些英文失败归为“连接失败”。候选检查另会把已确认非零退出的清理结果覆盖到原失败原因。

新 `initialization.rs` 仅允许四个固定错误码进入回执。SDK 的数字错误码、`message` 和 `data` 都不会复制到新回执或日志；原 SDK 错误仍留在后台任务返回值中，以维持原进程所有权与回收流程。

| 错误码                     | 可以确认的范围                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `AGENT_INITIALIZE_FAILED`  | 初始化请求未成功，可能是错误响应或本地响应解析等原因；不能据此声称远端拒绝、账号缺失或包依赖不兼容              |
| `AGENT_INITIALIZE_TIMEOUT` | 既有 60 秒初始化等待到期                                                                                        |
| `AGENT_CONNECTION_ENDED`   | 官方 SDK 的入站关闭标记，或初始化回执发送端在完成前结束；不能据此声称已取得进程退出码                           |
| `AGENT_START_FAILED`       | 本次 OS `spawn` 调用明确返回错误；由同一 `ProcessControl` 保存布尔事实，不从 PID 为零、SDK 错误码或错误正文反推 |

候选检查继续请求关闭并等待同一实际进程所有者。仅当它已写入 `CLOSED`/`FAILED`，且同一个连接 key 已从成功锁定的管理表移除时，已确认退出的清理结果才不覆盖原失败或取消结果。结束未确认、仍有所有者或管理锁失败仍返回原清理错误；失败不能被显示成可继续安装的成功。

未修改候选提交、安装收据、原目标选用或取消优先级。超时后的初始化回执接收端关闭，迟到成功不会改变超时结果；候选取消继续通过原进程回收流程结束，不能注册或覆盖原目标。

## 测试与证据

- [backend-red.json](backend-red.json)：新增五项受控子进程测试，四项错误归类失败、一项取消/迟到成功保护通过；原始结果见 [backend-red.log](backend-red.log)。
- [backend-green-first.json](backend-green-first.json)：上述五项均通过。
- [backend-focused-final.json](backend-focused-final.json)：最终相邻生命周期、初始化超时与清理锁反例的命令和退出码。测试结果以该收据与各日志为准。
- `startup_tests.rs` 覆盖错误响应中的正文 canary、本地畸形成功响应、无响应退出、实际 spawn 失败、取消后的迟到成功。失败候选均检查原登记记录保持、候选不再待处理、诊断不包含正文 canary；正常候选可重试。
- `initialization.rs` 测试保留超时结果且拒绝迟到成功回执，以及 SDK 数字码和敏感错误正文不决定“远端拒绝”。
- `startup_cleanup_tests.rs` 用真实受控进程与故意损坏的管理锁验证锁错误不会被固定重试码覆盖，实际进程仍被回收，旧登记记录保持。它可能在候选检查第一次查找连接时返回，不能单独证明 `closed().await` 后联合条件的执行分支；该分支的关闭状态、同 key 移除和再次成功锁定三项条件由独立源码审查核对。

受控程序只在各自临时目录写标记；没有运行真实 Agent、正式应用、账号登录或 prompt。前端映射和实际安装观察另见本目录前端及根任务证据。

## Minion 官方发行核对

[官方发行检查](official-release-check.json) 与 [wheel 静态检查](minion-wheel-static.json) 记录此次原始来源、时间、完整文件字节数与官方摘要。使用 `curl` 取得完整 Minion wheel 后，278,047 字节与 PyPI SHA256 `501d2c176dc06e837dfc4d9c5608b8b760edc315a76d0ec184113d1ca0ef50df` 一致。之前 urllib 正文或分段截断的字节没有保存为发布包，也没有用于源码结论。

- [PyPI Minion Code JSON](https://pypi.org/pypi/minion-code/json) 当前最新发布版仍为 `0.1.44`，2026-03-15 上传。该 wheel 仍声明 `agent-client-protocol>=0.7.0`，顶层导入 `ModelInfo`、`SessionModelState`、`SetSessionModelResponse`。
- [PyPI ACP Python SDK JSON](https://pypi.org/pypi/agent-client-protocol/json) 当前发布版 `0.12.1` 的官方 wheel 摘要也已核对；静态 AST 检查确认 `acp/schema.py` 没有上述公开定义。
- [Minion 主分支源码](https://raw.githubusercontent.com/femto/minion-code/main/minion_code/acp_server/agent.py) 已不含三个旧符号。本次记录主分支内容摘要，但它是可变分支，不是发布包；不能把它当成已发布修复，也未从主分支安装。

这组官方发布包的静态接口不兼容与此前独立 SDK 导入检查一致。原安装失败没有留存 traceback，仍不能把这项检查当成原进程的精确异常归因；原边界见 [前次调查](../2026-09-30-agent-access-uvx/minion/README.md)。本片没有固定外部 SDK、写兼容层或修改包。Minion 后续安装失败应按本次实际阶段显示安全原因，保留原程序、提供重试，其他认证/模型/首发/续接仍须各自实测。
