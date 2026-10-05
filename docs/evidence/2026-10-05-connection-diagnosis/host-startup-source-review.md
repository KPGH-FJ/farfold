# 启动握手源码复核与最小受控验证

2026-10-05。只读工作树，读取时 HEAD 为 `8ed33eb`；未改源码、未启动真实 Agent、未读真实日志、账号、环境值或对话。以下实际运行现象由父任务提供，本报告没有独立重读这些记录。

## 当前结论

Cline 两次、OpenCode 一次均已启动子进程、完成登记并走到 initialize：父任务白名单摘要为 `childStarted=true`、`failurePhase=initialize`、出站 initialize 1 条、无已观察到的入站消息/标准错误记录、`initializeResponse=not_observed`。超时后 SIGTERM、回收、进程组结束、连接移除均已确认。Pi 与 Codex 无消息预开成功。

**仍不能把根因判为宿主未写入，也不能判为官方 Agent 不响应。** 当前记录位于物理写入之前，缺少 write/flush 完成与子进程实际读取的观测点。最短待定位区间为：

`bridge inspect → wire channel → SDK outgoing actor → write_all + flush → 子进程 stdin 读取/启动 → stdout 换行与解析 → bridge 入站检查`

前端 `modelConfigOption` 只选择已返回的会话模型控件，不能改变这里的 initialize 握手。若尚无 initialize 响应，不能用模型选择修复去解释超时。

## 源码证据

| 边界          | 当前实现与定位                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 60 秒范围     | `src-tauri/src/acp_client/manager.rs:41,522,652`；`initialization.rs:35` 对握手 oneshot 等待设 60 秒，含异步启动直到响应解码，不是模型请求队列。                                                               |
| spawn         | `process.rs:171` 直接使用登记 command/args/environment/cwd 创建管道子进程。这里没有 Cline/OpenCode 专属启动分支。                                                                                              |
| 登记前置      | `process.rs:365` 等待 registration_result 后，才在 `369–374` 创建 ByteStreams 与 bridge。因此这三次已观察到 out initialize，可排除“仍卡在本次登记等待”。                                                       |
| 出站观察      | `process.rs:378` 调用 diagnostics.inspect；SDK `jsonrpc.rs:6534` 先 inspect，再 `right_tx.unbounded_send(frame)`。日志是此内存桥边界的事实，不是 OS 写入回执。                                                 |
| 实际写入      | SDK `jsonrpc/transport_actor.rs:147` 对 outgoing sink 执行 `.send(line).await`；`jsonrpc.rs:6406–6431` 追加 `\n`，`write_all` 后 `flush`。不存在已发现的“漏加换行/漏调用 flush”。                              |
| 双向驱动      | SDK `jsonrpc.rs:6261–6273` 并发驱动出入站；宿主 `process.rs:396–398` 并发驱动 wire、endpoint、bridge；源码未发现先等待响应才驱动 writer 的直接循环等待。                                                       |
| 实际管道      | async-process 2.5.0 `src/lib.rs:482–499` 将 ChildStdin 的 write/flush 委托给异步管道包装。宿主未另外套缓冲 writer。                                                                                            |
| 入站观察限制  | SDK `jsonrpc.rs:6405` 使用按行读取；`jsonrpc/transport_actor.rs:223` 完成行解析后才向 channel 交付。没有换行的部分 stdout 或 malformed frame，不等于入站 typed message；“入站 0”不足以证明原始 stdout 0 字节。 |
| stderr 与记录 | `process.rs:245–271` 独立线程排空 stderr，只记录字节数；`startup_diagnostics.rs:120,151` 使用容量 64 的 try_send，记录可丢弃。不能把零条记录当成严格零字节证明。                                               |
| 解码与模型    | `manager.rs:572–584` 接到响应才做 Handshake::decode；`587` 才进入会话命令循环。`src/runtime/session_projection.ts:372` 的模型控件选择更晚。                                                                    |

以上 SDK 路径均来自本机 Cargo registry 的公开依赖源码：`agent-client-protocol-2.2.0`、`async-process-2.5.0`。未浏览网络。

## 本轮未提交共用接入差异

`process.rs`、`startup_diagnostics.rs`、`tap.rs`、Cargo.toml/Cargo.lock 对当前 HEAD 无差异。

`manager.rs` 的近期变化主要是连接保留、关闭原因、状态事件与后续认证；initialize 构造、send_request、ByteStreams 和 60 秒常量未改。状态 sink 成功分支在 initialize 完成以后（`manager.rs:689`），关闭分支在结束清理阶段（`624`）；没有本次失败发生前调用它的证据。

`lifecycle.rs:254` 的空闲回收要求 READY，CONNECTING 不符合；新 view/session 保留不解释初始化尚未响应的 60 秒等待。`handshake.rs` 的 API-key 声明过滤只处理已收到的握手结果，不解释没有任何匹配响应的观测。

目前未找到可据此定罪的共用代码改动。Cline 的 npm 包启动器会转到平台二进制；不可只按 npm 安装方式就认定它和 OpenCode 是同一种 Node 协议循环，也不能由 --version 成功推断 ACP stdin 已进入读取。

## 先做的一条现有测试

在唯一仓库由父任务串行执行，避免争用构建锁：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib acp_client::process::cwd_tests::candidate_check_uses_app_data_and_keeps_selected_row_and_handshake -- --exact
```

此测试的 `Fixture` 使用临时目录、临时 MetaStore、受控 Python 对端和本地假 Agent 登记（`process_cwd_tests.rs:50–106`）。对端从 stdin 实际读出并解析每个完整消息才记 method 并响应（`:33–40`）。断言唯一调用为 initialize、返回成功、确切子进程已回收、原选择与握手记录未改（`:208–237`）。不会运行官方 Agent 或发模型请求。本子代理仅审查了测试，未执行；结果由父任务记录。

**该测试通过的含义**：当前源码的通用启动链能把 initialize 送到真实受控子进程，完成响应与清理；不能回溯证明失败官方 Agent 的那三次写入，也不覆盖实际安装包与源码是否完全一致。

## 若仍需区分写入与读取，最小补充测试设计

保持在独立测试工作区，继续使用同一 ProcessTransport/ByteStreams，不替换为另一套 Python 宿主发送器。不新增生产开关，不连接真实账号。

1. **对端读取回执**：受控 peer 读到第一条完整合法 initialize 后，在临时 sidecar 仅写 `completeLine=true`、`parsedInitialize=true`、字节计数、单调时间；不写正文、请求 ID、路径值。先写 sidecar，再发最小合法响应。回执证明到达子进程，不依赖宿主 bridge 自证。
2. **有限延迟对照**：同一 peer 分别在读 stdin 前有限延迟、读完后回包前有限延迟。可断定等待发生在读入前还是处理/回包后；收到完整行本身不等于宿主 flush future 已完成，需单独观察 writer。
3. **writer 完成边界**：仅在测试包装现有 ChildStdin，记录 poll_write 成功累计字节与首个 poll_flush 成功/错误类别；保持所有字节原样转发，不记缓冲区内容。在受控 peer 上验证：bridge 已观察、writer 已完成、peer 已读取三类事件不能互相替代。包装不得假造 flush 成功。

若需要验证入站盲区，再追加一个受控 peer 将合法响应分两段发送、第二段补换行，确认第一段只增加原始读字节，直到完整行才有 typed 入站。这是针对现有证据盲区的定向测试；无需全量 Agent 或长超时反复试跑。

## 优先核对的无内容字段

现有字段足以先核：每次尝试关联与时间窗口、出站 initialize 数、`failurePhase`、`initializeResponse`、`initializeAccepted`、out/in/err 的白名单事件与字节计数、`childReaped`、`exitObservedBeforeTerm`、`exitSignal`、`groupEnded`、`connectionRemoved`。对记录文件不要凭文件名猜 Agent 身份；DebugTap 文件名只含时间/序号。

仍缺、且只有在继续授权定向诊断时才值得新增的字段：首个 pipe write 完成/累计字节、首个 flush 完成、写入错误类别、stdout 原始读字节/完整行计数。这些必须是固定 schema 数值/枚举，不收集消息、stderr 文本、环境值或账号。得到这些字段之前，不建议修改认证、切模型、增加 initialize 超时或补 Agent 专属启动分支。
