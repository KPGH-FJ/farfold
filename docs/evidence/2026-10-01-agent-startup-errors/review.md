# 启动错误：后端独立只读审查

审查时间：2026-10-01 01:23:42 +08:00。结论：以下稳定生产范围未发现有证据支持的阻断问题。审查者没有运行 Cargo、实际 Agent 或正式应用，没有修改产品源码。

## 审查范围与身份

对照本片 diff，读取 `acp_client/initialization.rs`、`manager.rs`、`process.rs`、`startup_tests.rs`；追踪既有 `ConnectionLife::closed/finish`、候选检查与安装的错误/回收边界，并核对官方 SDK 2.2.0 的类型响应、本地解析和 EOF 错误行为。`mod.rs` 与 `lifecycle_tests.rs` 的测试接线一并核对。

| 本次生产范围                                 | SHA256                                                             | 行数 |
| -------------------------------------------- | ------------------------------------------------------------------ | ---- |
| `src-tauri/src/acp_client/initialization.rs` | `1cf827f08bd8aa073efa9fb4bd25efcddb727e39f9c6317da6a0e4cf1c7c6b17` | 76   |
| `src-tauri/src/acp_client/manager.rs`        | `ac2c110294e978d9bbe79eb2a30d4952a563ccd2f1f687ba61708cc9227dab77` | 1379 |
| `src-tauri/src/acp_client/process.rs`        | `b244bf7bc16c7a75c9d81d75040b592e188d867e01ed1dc47b24afd070f869f8` | 322  |

这些摘要只界定独立审查范围，不是完整构建或安装身份。作者在本次读取时继续追加 cleanup 反例，测试文件可能改变；后续若生产文件改变，须重新核对相应 diff。

## 边界核对

- 初始化请求失败先发送不含正文的枚举回执，再返回原 SDK 错误给既有连接 owner 收尾。成功、明确错误、sender 消失和等待超时分别处理；没有将 sender 消失称为 OS 进程退出。
- `Failed` 包含请求失败及本地类型解析失败，不按 `InvalidParams` 或 `InternalError` 推断远端拒绝、模型缺失或版本不兼容。EOF 只使用官方 SDK 固定 helper；其分类仍只说明连接检查前结束，不能扩大为某种退出根因。
- `start_failed` 仅在同一 `ProcessControl` 的实际 OS `spawn` 返回错误时设置，先于该错误返回。不从缺少 PID、请求错误码、空回执或解析失败推断“程序未启动”。该字段不改变 Child ownership 或新增持久记录。
- manager 的新错误回执和新日志仅包含固定码，不格式化原 `message/data`。公开 canary 受控反例覆盖错误响应、畸形结果、stderr 与缺失执行路径；原协议流量仍由既有只含计量的诊断路径处理。
- 新分类不提前调用 `finish` 或移除连接。确切 Child 等待、所属进程组回收、原进程守护及清理仍由同一 owner 执行；返回错误本身不代表回收已经完成。
- `probe_launch` 遇到收尾错误时，只有原检查已经失败/取消、该 owner 已为 `CLOSED/FAILED`，并且再次成功读取 map 确认同 key 已移除，才保留原检查结果。检查成功后清理失败、尚未终结、key 仍在或 map 读取失败都继续传播安全错误，不能借固定码吞掉未知回收。
- 外层候选取消保持既有优先选择与真实收尾等待。超时或调用者取消后，接收者被关闭，迟到成功不能进入该调用的登记、握手保存或选用路径；既有 `StartingConnection` 关闭请求和 `ConnectionLife::ready` 状态门保留。

## 证据层级与剩余验证

已核 [backend-green-first.json](backend-green-first.json) 及对应日志：五个真实受控子进程例成功，覆盖错误响应、畸形结果、EOF、真实启动失败、取消后迟到成功；它们检查旧目标保持、候选清理和诊断没有 canary 正文。审查者只读取作者的退出收据，没有重复运行。

作者此时还在补 cleanup 锁错误及短期限超时反例，最终结果由其后端证据和根任务工程检查记录。此审查不将第一组通过扩大为完整错误矩阵通过，也不代替安装版错误提示、真实失败根因或完整接入验收。前端映射由本审查者实施，故这里的独立结论仅针对另一作者的后端范围，不称前端已独立审查。
