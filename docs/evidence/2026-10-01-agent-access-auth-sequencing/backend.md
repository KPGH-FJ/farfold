# 认证启动排序与早取消：后端受控证据

本片实现与受控测试不等于安装版登录、账号成功或完整接入验收。正式应用验证由本目录的候选身份及后续安装证据另行记录。本次没有运行官方 Agent、登录账号、读取真实密钥或改外部配置。

## 已确认缺口

前一安装候选中，Kilo 已读取模型后点击登录，被账号操作互斥拒绝，未启动登录子进程；准备稿已关闭后的第二次点击可以启动并取消。现场材料保留在前片 `../2026-09-30-agent-access-auth-target/`，首次失败没有覆盖成成功。

源码显示，准备稿关闭与登录准入缺少等待关系；同时，关闭请求先发送回执，再释放其操作锁。普通及手动终端登录虽然有可取消的 Attempt，却未把该 Attempt 的取消标记交给 PTY。手动执行错误映射还把 `AUTH_CANCELLED` 转成普通失败。

## 实现边界

- `auth/attempts.rs` 复用同一 Attempt/Operation，取消可中止本地目录验证、配置锁及连接准备等待；配置锁取得后再核对取消。`auth_run`、手动终端及退出账号在进入下一动作前检查同一取消状态。已经发出的协议认证继续由既有请求 owner 等待真实结果，本片不提前释放其未知结果。
- `auth/terminal.rs` 是普通及显式手动终端登录共用的启动段：环境读取前后检查取消；若读取同时失败并取消，保留 `AUTH_CANCELLED`。`spawn_controlled` 接收同一 `abandoned` 标记，继续使用原有进程组回收和真实退出帧。配置锁、账号操作锁和 Attempt 由原有退出 sink 持有，真实退出后释放。手动命令其它错误仍使用安全通用文案。
- 同步 Keychain 调用一旦开始不能中途取消，读取前后的检查不承诺“零读取”。本地 `ensure_connected` 若已经启动连接，其取消沿既有连接 owner 收尾；启动连接不等于发送认证。取消恰与进程启动交错时，也由同一 PTY owner 回收，不声称每个交错都未创建子进程。
- `Mutation::finish` 在唤醒等待关闭/配置结果的调用者前释放已完成的 mutation。调用者不再等待或结果超时后，真实请求和操作锁继续保留到最终回执或连接确实结束。
- `session_close` 新增可选 `allowAlreadyClosed`；默认行为保留。仅严格准备稿收尾传 `true`。缺失 route 必须通过公开当前状态确认：同 Agent、同目录的全部非候选来源都不能仍处于 connecting/closing，查找及锁错误不算缺失。原有 route 的 token、状态和协议关闭检查照旧，未知关闭不会被放行。其他目录与候选检查进程不替代该目标的关闭判断。
- 严格关闭成功后的 `session_dismiss` 仍是尽力隐藏历史索引，不能当作协议关闭或持久清理已经成功。本片没有新增持久账本、配置对象或凭据字段。

## 红绿结果

原始结果及命令见 [backend-red.json](backend-red.json)、[backend-green.json](backend-green.json)。这五组共 12 个测试：基线 9 失败 / 3 成功，修复后 12 成功。基线是当前入口的等价提取，未改变取消或关闭行为。

| 受控范围                                                                       | 基线            | 修复后 |
| ------------------------------------------------------------------------------ | --------------- | ------ |
| 早取消、配置锁等待、环境读取前后、已启动终端原 owner 回收                      | 4 失败          | 4 成功 |
| 手动错误映射保留取消                                                           | 1 失败          | 1 成功 |
| 真实 oneshot wake 核对锁释放顺序、未知关闭保留锁                               | 1 失败 / 1 成功 | 2 成功 |
| 可选缺失重试、connecting/closing、查找错误、其他目录/候选边界                  | 2 失败 / 2 成功 | 4 成功 |
| 真实受控协议：关闭调用者放弃等待 → 原 route 仍保留 → 迟到关闭成功 → 同标识重试 | 1 失败          | 1 成功 |

上述真实协议例通过本项目自有临时目录内的 Python 对端执行；并非 Kilo 或其他实际 Agent。超时仍保留请求由 Mutation 的 5ms 受控期限例验证，真实协议例使用调用者停止等待触发相同未知结果路径，不声称实测了正式 15 秒超时。

追加的“环境读取失败同时取消”反例先失败，见 [backend-environment-error-red.json](backend-environment-error-red.json)，最终包含在 [backend-auth-final-green.json](backend-auth-final-green.json) 的认证范围检查中。

相关回归见 [backend-related-green.json](backend-related-green.json)：认证 61 项、PTY 6 项、连接生命周期 19 项均成功；追加反例及最终环境状态修复后的认证范围重新运行，62 项成功。各范围有交叉，不相加为独立测试数量。完整工程检查与安装验收由根任务执行并另留证据。

## 源码与待验收

主要入口为 `src-tauri/src/auth.rs`、`auth/attempts.rs`、`auth/terminal.rs`、`manual_auth.rs`、`acp_client/mutation.rs`、`pump.rs`、`session.rs`、`session_commands.rs`。受控测试位于 `auth/terminal/tests.rs`、`mutation/tests.rs`、`session/close_tests.rs` 及既有生命周期测试模块。各文件均未超过 1500 行。

下一步在同一正式候选检查：Kilo 已读模型后直接登录的关闭排序；Amp 同程序终端登录；早取消不产生迟到登录 UI；取消后的确切子进程退出；原草稿、原模型/推理及用户配置保持。账号成功、真实登录页授权和首条消息仍需要实际条件，不能由本片测试宣称完成。
