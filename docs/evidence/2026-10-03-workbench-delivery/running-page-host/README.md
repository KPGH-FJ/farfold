# 同一运行中 WK 页面：本地只读接口受控证明

2026-10-03。本包只创建一个短命、独立 Tauri 2.11.5 进程及一个临时 WK 页面，供外部受控 MCP shim 读取。**最终 live 验证一次通过，所有自建进程已经退出；本包结束，不继续扩功能。**

未改仓库、未启动正式 Farfold 或其 setup/MetaStore/Keychain/Agent，未安装应用/依赖或创建 `.app`，未访问公网、真实账号、用户对话、凭据、profile 或模型。

## 证明了什么

最终回执：`../mcp-running-page-validation/running-mcp-20261003T180217Z.json`。本目录 `results/live-summary.json` 保存白名单摘要和原始文件 SHA256；原始 MCP transcript 由兄弟包归档。

- 一个独立 Tauri 主视图经稳定 `get_webview_window("main").with_webview` 创建一个独立 WK。使用修复后 v2 native 源码，fresh 非持久仓库，不向子页注入应用桥。
- MCP 第一次调用使服务端**当次调用 `ff_browser_read`**，得到 `Running page version one`、revision 1、readId `read-1`、nativeReadCount 1。
- host 通过仅用于探针的固定操作，直接修改相同 WK 文档；没有导航、重建或缓存 JSON 替换。MCP 第二次实际读取得到 `Running page version two`、revision 2、readId `read-2`、nativeReadCount 2。
- 两次读取与原地修改均检查实际 WK 对象仍是最初创建的对象，回执只输出 `sameNativeInstance: true`，不输出内存地址。`instanceId` 是独立生成的随机标签，并非身份检查依据。nativeCreateCount 始终为 1。
- 错 capability 与错服务端固定 scope 均通过直接 socket 请求验证拒绝；scope 不由工具参数授予。
- 第三次实际原生读取后、发送前挂起结果。收到 `held` 后撤回授权，未发送正文被丢弃，只返回无内容错误；再次读取被拒绝。此钩子验证**真实读取结果的出站门控**，不是声称原生回调本身发生在撤回之后。
- 关闭后 MCP 读取拒绝，直接 socket 返回 `CLOSED`；最后 `finished` 回执确认 nativeCreateCount 1 / nativeReadCount 3，没有重建或新增原生读取。

## 最窄本地协议

```text
running-page-probe SOCKET_PATH CONTROL_FD
```

SOCKET_PATH 由受控 launcher 放入 task-3 下新建的当前用户 `0700` 目录；host 核对目录归属/权限并将 Unix socket 设为 `0600`。CONTROL_FD 仅为继承的匿名管道描述符数字。每次启动新生成的 64 个十六进制字符（256 位）的 capability 经 stdin 匿名管道交接，MCP shim 经另一匿名管道取得同值；不进入 argv、环境变量、文件、事件或日志。没有 TCP 监听端口。

socket 只接受一行 JSON、最多 4 KiB，字段严格限制为：

```text
op=snapshot, requestId, taskKey=running-page-task,
label=running-page, generation=1, capability
```

授权范围是服务端常量；工具传入的 taskKey 等字段仅用于核对。服务端不接受 URL、脚本、路径或任意命令。每次成功调用都读取当前 WK，回执包含正文、标题、观测时间、revision/readId，以及实际创建/读取计数和对象一致性布尔值。

host 控制管道仅接受固定 `mutate / hold-next-read / release-held / revoke / close / quit` 行，用于本次合成测试；它不属于 MCP 工具，不是产品 API。stdout 仅有不含 capability 或正文的合成事件。正文只有固定 fixture，输入 canary 被原生读取过滤。

## 撤回与发送顺序

源码复核发现过“最后授权核对通过后释放锁，再写 socket”的间隙；撤回可能先确认，旧正文却后写。已用专门 `outbound.rs` 修复：

1. 最终授权核对与实际写入共享一个出站门控，写入有**绝对 1 秒 deadline**和 16 KiB 上限。
2. revoke/close 的状态变更与 ACK 使用相同门控。ACK 不会跨过已获准、尚未完成的有界写入；ACK 之后的新写入再次核对时被拒绝。
3. 门控和页面状态锁均不覆盖原生读取等待。撤回/关闭可独立处理挂起的 snapshot；最多等待已经开始的有界出站写入，不等该读取完成。

定向测试使用真实 UnixStream pair，在“最终核对之后、写入之前”暂停 writer 并触发撤回。旧 helper 真实 RED：撤回 ACK 先于正文写入，断言失败；修复后的实际 helper GREEN：正文写入先完成，才有撤回 ACK，撤回后授权检查为 false。源码与两份日志保留在 `checks/`。

这里证明的是应用的输出准入/写入顺序。**不能召回已经写出的字节**，也不把客户端晚收到 ACK 前已写出的数据算作新的泄漏。

## 复现与证据边界

```sh
sh browser-running-page-probe/build.sh
rustc --edition=2024 --test browser-running-page-probe/outbound_tests.rs -o /tmp/running-page-outbound-check
/tmp/running-page-outbound-check
```

完整 live 的 launcher、stdio shim、client 和 sanitized transcript 在 `../mcp-running-page-validation/`。重放 RED 可将 `outbound_tests.rs` 与 `checks/outbound-before-fix.rs` 复制到临时目录，后者命名为 `outbound.rs`，再用相同 rustc test 命令；本次实际 RED/GREEN 日志已经保存，无需为归档重跑。

这是**受控 MCP → 本地通信 → 同一正在运行的真实 Tauri/WK 页面**证明。没有运行真实 Agent，没有把正式 Farfold Rust BrowserWorkspace 命令调度或产品 UI 接入，没有完成账号秘密交接或 OS/网络沙箱。

匿名 FD bootstrap 只是独立 launcher 的授权交接。ACP 标准 stdio MCP 启动参数只有 command/args/env；本探针不证明真实 Agent 官方启动面支持继承该 FD，也不把此方案定为生产接口。之后仍需单独短验证真实官方扩展启动面、临时授权交付及脱敏；本包不扩建 handoff。

`native-source-provenance.json` 核对 BrowserWorkspace 两文件与修复后 v2 的 SHA256 相同。`evidence-manifest.json` 仅归档源码、脚本、结果摘要、编译日志和 RED/GREEN 证据；排除可执行文件、`.o/.a`、缓存和运行 socket。
