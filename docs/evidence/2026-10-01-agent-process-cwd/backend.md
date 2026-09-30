# 通用连接子进程的实际工作目录

源码已修复、定向受控测试已通过；本文件不代表正式安装验收。实际 Agent、模型读取、首发和续接仍由同候选的安装证据判断。未启动真实 Agent，未操作正式应用、用户配置或凭据，未改全局计划/状态，未提交代码。

## 根因与改动

`AcpManager` 已按 Agent 与工作目录区分连接，普通连接使用验证后的目录，候选探测使用应用数据目录。但 `ProcessTransport` 原来调用的锁定 SDK 2.2.0 `spawn_process()` 没有设置操作系统 cwd；实际 Child 继承父进程目录。此前真实 fast-agent 调查已证明有效官方入口在 `/` 创建默认目录失败、在自有可写目录 initialize 成功。该结果仅支持通用 cwd 缺口，不能解释未保留正文的全部安装错误，也不覆盖独立的同名 console/缺模块问题。

本片生产只改：

- `src-tauri/src/acp_client/process.rs`：从官方 `AcpAgentConfig` getter 取得原 command/arguments/environment，在同一 `std::process::Command` 上设置本连接的 `current_dir`；保留原 `process_group(0)` 和三条管道，转为同类型 `async_process::Child`。之后的 ProcessControl、ConnectionLife、stderr 有界读取、supervisor 注册、Child wait/reap 与官方 ByteStreams 完整沿用。
- `src-tauri/Cargo.toml`：新增直接精确依赖 `async-process = '=2.5.0'`。该版本本来已在 Cargo.lock 和 SDK 依赖链里；锁文件只增加根 package 的依赖项，没有升级其它包。官方发布于 2025-09-14，来源及 checksum 见 [既有公开收据](../2026-09-30-agent-access-startup-options/fast-agent/async-process-release.json)。
- `src-tauri/src/acp_client/process_cwd_tests.rs`：新受控子进程测试模块，通过真实 manager/ProcessTransport 和协议连接调用验证效果，不只检查 Command 构造。

没有修改 manager、协议 session/load、模型保护或元数据结构。没有设置全局 cwd/PWD、清空环境、改 HOME、增加品牌分支、配置写入或补丁。自定义参数的相对文件自然按所选实际工作目录解释，保留原字面值，不自动绝对化，也不回退到父目录。

## 红与绿证据

| 收据                            | 结果               | 范围与说明                                                                                                                                                           |
| ------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focused-red.json/log`          | exit 101           | 原生产 spawn；6 个用例失败。直接观察到实际 cwd 为 Cargo 父目录，候选目录不符，已删除目录仍回退启动；并发首版 fixture 另存在输入观察问题，不能把其缺文件当作 cwd 证据 |
| `concurrent-red.json/log`       | exit 101           | 改为同一已登记命令/参数、按真实 PID 分别观察；再次确证两个连接的实际 cwd 错误                                                                                        |
| `focused-green.json/log`        | exit 101，5/6      | 生产修复后 cwd/候选/消失目录/漂移保护通过；正向冷恢复误将模型检查状态期待为 `ok`，实际契约为 `ready`。只修测试预期，生产模型保护没变                                 |
| `focused-final-green.json/log`  | exit 101，未跑测试 | 协作片的 `session/close_tests.rs` 入口已接线而文件尚未落盘；保留编译失败事实，不当作 cwd 回归或绿结果                                                                |
| `focused-stable-green.json/log` | exit 0，6/6        | 共享源码稳定后，新目录与冷恢复用例全部通过                                                                                                                           |
| `lifecycle-green.json/log`      | exit 0，18/18      | 既有生命周期、取消、候选回收、注册失败、stderr/后代退出等回归；显式 skip 同时开发片的新预期红例 `auth_cleanup_retries`，不扩大为其已验证                             |

六项最终覆盖：

1. 含空格所选目录：实际 cwd、相对 marker、字面 argv/公开测试 env、HOME 继承正确，父进程 cwd 保持。
2. 同一已登记命令在两个目录连接：两个精确 Child 各有正确目录和 marker，观察按 PID 隔离。
3. 候选检查：实际 cwd 为应用数据目录，进程回收完成，原登记与握手保持，仅 initialize。
4. 验证后目录消失：启动失败，fixture 没有启动或 fallback 写入，重新创建目录后可重试。
5. 冷恢复：新 manager/Child 使用原目录，`session/load` 的 cwd 与实际 cwd 一致，原 native ID、模型和推理记录保持；没有发送配置修改。
6. 模型/推理漂移：原模型保护仍返回 `blocked`，后端拒绝请求，没有向 fixture 发出 prompt，不强改任何选择。

fixture 只写测试 TempDir 内的公开观察。目录错误时不在父工作区写相对 marker；成功用例逐一等待精确 Child 回收。源码快照、行数和基础提交见 `source.json`；不是安装候选身份。

## 交接边界

本片 production 和新测试已冻结，Cargo 已释放给认证取消/关闭确认的独立开发片。完整 fmt/clippy/test、同候选打包和安装验证由主任务串行执行，不能把这里的 24 个受控测试当作 J1–J6 验收。

实际 cwd 修复后，外部 Agent 可按自身官方行为读取或写入该目录；安装复验需记录已知目录/配置存在性与必要摘要，不能承诺外部零写入。fast-agent 的公开 console 覆盖缺模块保持单独待验证，不通过改包、private HOME、切模型或手改配置绕过。
