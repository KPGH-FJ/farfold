# 同一运行页面的 MCP 窄验证

本包只验证标准 stdio MCP 客户端能否经受控本地通信读取**同一个持续存在的真实 Tauri/WK 合成页面**。不修改 Farfold 仓库；不启动真实 Agent、模型、账号、网络或用户页面。原 `mcp-controlled-validation` 证据保持冻结。

## 执行结果

2026-10-03 18:02:17 UTC 开始的一次最终实机运行已通过，进程正常退出。完整证据：`running-mcp-20261003T180217Z.json`。该记录包含 MCP 2025-06-18 初始化、工具列表、请求/响应和不含授权秘密的 host 生命周期事件。

| 实际检查 | 结果 |
| --- | --- |
| 同一已运行真实页面的两次 MCP 读取 | 相同 instanceId 与实际 native view；正文 `Running page version one` → `Running page version two`；revision 1 → 2；readId 不同 |
| 创建与读取次数 | native 进程只启动一次；页面创建计数一直为 1；前两次真实读取计数 1 → 2 |
| 真实服务端错误 capability / scope | 直接 socket 请求分别返回 `UNAUTHORIZED` / `SCOPE_MISMATCH`，不由 shim 预检代替 |
| 第三次真实读取的迟到结果 | host 已完成读取并发 `held`，撤回后先确认 `revoked`，对应 MCP 结果为无正文错误 |
| 关闭之后 | MCP 请求拒绝；直连 host 明确返回 `CLOSED`；最后 finished 事件确认创建仍 1、读取仍 3 |
| 自有管道和 socket | 新鲜匿名管道授权；0700 目录、0600 socket、当前 UID；未将授权秘密写入证据 |

`protocol-tests.log` 另有 9 个合成 Unix socket / 协议检查通过；它们与上述实机证据分开。首次默认沙箱不允许 bind Unix socket，原样代码经受控执行批准后通过；对应记录为 `protocol-sandbox-limitation.log`。本包运行完成后已退出全部自建进程并清除本次临时 socket 目录，不再追加验证。

## 本次边界

只有 `read_page_snapshot` 一个 MCP 工具；输入固定为 `requestId, taskKey, label, generation`。scope 只允许 `running-page-task / running-page / 1`。工具不接受任意 URL、JS、路径、命令或页面控制动作。`generation=1` 是这个一次性合成场景的授权值，不是产品持久化状态体系。

本包 launcher 启动一个 native 进程和一个 MCP shim。此后每次工具调用只连已存在的 Unix socket，**shim 没有启动 native 进程的代码**。native host 创建一个 nonpersistent WK 页面，保存实际 view 身份；先读 version one，再由 host 自有固定脚本修改同一个节点为 version two，随后再次真实读取。回执核对 instanceId、实际 view 身份检查、nativeCreateCount、nativeReadCount、readId、revision 和正文变化。

socket 所在临时目录权限 `0700`，socket 权限 `0600`，均核对当前 UID。新鲜 capability 只存在于 launcher / host / shim 内存及匿名管道；不写文件、命令参数、环境变量、MCP 参数或诊断。测试控制 pipe 仅有固定 mutate、hold-next-read、revoke、close、quit 等动作，未暴露为 MCP 工具。正常与错误证据都不保存 capability；命中泄漏保护时落盘与最终状态均失败。

服务端自身必须拒绝错误 capability 和错误 scope；客户端将直接连 socket 核验这两项，不能只拿 shim 参数预检代替。只读结果同样核对受授范围、请求 ID、页面种类、数据类型与大小，不返回内部异常正文。

## 撤回与关闭的验证口径

- 先让一次真实 WK 读取完成，但在服务端发送前保留其结果；收到 `held` 后撤回。MCP 得到不含正文的错误，不能拿旧结果冒充有效读取。
- 撤回只阻止尚未发送的内容；**无法追回已经写出的字节**。MCP 连接没有在本包扩成流式取消协议。
- 最终授权检查/写 socket 与撤回、关闭确认须序列化。服务端窄回归证据由 `browser-running-page-probe` 保留，不能用仅回调前的状态检查代替。
- 关闭后再次 MCP 调用拒绝，并直接核实服务端返回 `CLOSED`。最后 `finished` 事件在这些调用后重新采样创建与读取次数，确认没有新建页面或额外 native 读取。该顺序覆盖撤回之后关闭的场景，不声称覆盖全部独立关闭竞态。

服务端发现并修复过“最终检查释放状态锁后，撤回确认先于旧正文写出”的竞态；对应 `../browser-running-page-probe/checks/outbound-red.log` 与 `outbound-green.log` 保留 RED/GREEN。当前 live 使用该修复后的 server。客户端独立审查另外收紧了证据泄漏时的失败状态与关闭后最终计数核对；最终 live 在这些修复之后执行。

## 真实 Agent 接入仍未验证

本次 launcher 能把匿名 FD 交给 shim，是**探针自有启动方式**。标准 ACP `McpServerStdio` 只有 `command / args / env` 配置，没有任意继承 FD 的交接字段。因此此包不能证明实际 Agent 启动 MCP helper 时可以复用这一 bootstrap。

正式接入仍需短验证：代表 Agent 官方扩展面支持怎样的临时授权交付、是否把配置写入历史/诊断、如何脱敏、恢复时怎样重新授予。不能为了接通而把秘密塞进 argv、普通配置或日志，也不能替 Agent 改用户配置。生产 `new/load mcpServers` 在本轮保持不注入。

同一运行页和受控通信可行，不等于生产 UI 分享、秘密输入暂停、账号交接、持续 profile、人工控制权或真实 Agent 工具调用已完成。本包所有页面均为自有合成内容，只验证一个固定只读工具。

## 文件与重现

- `page_server.py`：标准库 MCP stdio 薄 shim，仅连接已运行 host；JSON-RPC initialize → initialized → tools/list → tools/call。
- `live_client.py`：创建私有 IPC、一次性内存授权、启动合成 host/shim、执行上述验收并保存白名单证据。
- `test_page_server.py`：合成协议与 AF_UNIX 检查，无 GUI / Agent。
- `source-hashes.json`：最终 shim、client、测试和说明的 SHA-256，另记录本次 native host 源码，便于核对证据版本。
- 相邻 `browser-running-page-probe`：真实 Tauri + native WK host、固定合成页、测试控制及服务端授权检查。

无 GUI 的检查：`python3 -m unittest -v test_page_server.py`。环境须允许 Unix socket；不需要安装依赖。

`python3 live_client.py` 会实际启动相邻 `browser-running-page-probe/running-page-probe`，需要相应受控 GUI 执行授权。不能把本包注册到正式 Agent 中，也不能把已有 JSON 回执重放成当前读取。

协议依据：[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)。本次协商版本为 `2025-06-18`，不宣称是最新版本。
