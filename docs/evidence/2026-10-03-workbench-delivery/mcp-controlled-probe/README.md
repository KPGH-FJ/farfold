# MCP 受控验证工作包

此目录仅为独立验证材料。没有修改 Farfold 仓库，没有启动真实 Agent、模型或账号，没有安装依赖，没有向生产 `session/new` / `session/load` 注入 MCP 配置。所有页面和请求均为本工作包自己的合成内容。

## 当前结论

2026-10-03 17:23:58 UTC 的一次实际调用已通：标准 stdio MCP 客户端 → `initialize` / `notifications/initialized` → `tools/list` → `tools/call(read_page_snapshot)` → 本次新启动的真实 Tauri 主 WK 与独立子 WK → isolated-world 页面读取 → MCP 结构化结果。

成功内容是 `Controlled seam page` / `Controlled browser seam 42Only synthetic probe content.`。原生回执含 19 项检查通过，主页面自身的 Tauri invoke 和 channel 真实往返也通过。不是转发先前生成的 JSON：结果文件位于本次新建目录，原生进程拒绝覆盖，requestId 与当次 MCP 调用相同，observedAtMs 不早于启动时刻。未授予任务、过期 revision 在启动前拒绝；成功后原页面已关闭，再用原授权读取也拒绝。整个日志只启动了一次原生探针。

这证明了受控协议调用至实际 native 页面的可行性，**没有证明真实 Agent 已连接、生产共享浏览器已接通，或秘密保护已实现**。本次每次有效调用新建短命合成页；生产需要连接同一正在运行应用中用户实际看见的页面。撤回、暂停恢复和迟到结果目前只由注入 backend 的独立测试证明，不能称为 stdio 在途取消或生产门控已验证。

## 证据与文件

| 文件 | 内容 |
| --- | --- |
| `mcp-20261003T172358Z.json` | MCP 完整初始化、工具列表、两次拒绝、一次真实成功、关闭后拒绝的请求与响应；明确 `realAgent:false`、`productionSharing:false` |
| `native-call-1zcf3hpy/result.json` | 上述调用当次生成的真实 Tauri / WK 回执，含 19 项检查及父页面 invoke/channel |
| `protocol-tests.log` | 18 个协议及授权边界测试通过；这些为受控 fixture，均不启动 GUI |
| `grant-failure-red.log` | 独立审查发现失败后旧授权可再次启动 backend 的 2 项 RED |
| `acp-contract-tests.log` | 当前官方 `agent-client-protocol 2.2.0` 默认功能的 4 个类型及 wire-shape 测试通过，offline + locked |
| `page_server.py` | Python 标准库薄 stdio MCP server；没有模型循环、采样或通用命令工具 |
| `live_client.py` | 标准 JSON-RPC 控制客户端与独立证据记录器；只有一次有效 native 调用 |
| `acp-contract/` | 官方 SDK 的 new/load、stdio、HTTP、能力差异序列化验证 |

Live 证据先于独立审查的小修复：修复将已经提交的探针操作在成功、失败、超时、坏回执后都消费原一次性授权，且不误清期间重新发出的授权。先有 2 个失败复现，再有 18 个 GREEN；成功路径的回执和工具 shape 未改变。未为该失败回收修复重复启动 GUI。

## 已核实的官方接缝

- Farfold `src-tauri/src/acp_client/pump/open.rs:73` 的 new，以及 `:118` 的 load，目前都传 `mcpServers: []`。保留现有 route、原始 response envelope、事件回放和配置核验，不能另建 Agent loop。
- 当前依赖 `agent-client-protocol = "=2.2.0"`，默认 features 为空。其 schema 的 `NewSessionRequest::new(cwd).mcp_servers(...)` 与 `LoadSessionRequest::new(id,cwd).mcp_servers(...)` 接受同一 `Vec<McpServer>`。
- `McpServer::Stdio(McpServerStdio::new(name, absolute_command).args(...))` 的 wire shape 无 `type` 字段；有 `name, command, args, env`。规范声明 Agent 必须支持 stdio，但具体接入仍需代表性真实验证，不能据类型可序列化宣称工具已连接。
- HTTP / SSE 有独立能力位，默认 false；HTTP shape 有 `type:"http"`、`url`、`headers`。不能把一个传输的结果套给所有 Agent。
- SDK 的 MCP over ACP 依赖 `unstable_mcp_over_acp`，当前未开启。本轮不启用、不假定可用。
- 当前本机未发现可直接复用的缓存 rmcp / MCP SDK 包；因此协议探针采用标准 JSON-RPC peer，无新增依赖。Rust 类型检查只使用已有缓存的官方 ACP crate。

官方依据：[ACP 会话设置](https://agentclientprotocol.com/protocol/v1/session-setup)、[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[MCP 工具与结构化结果](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。本次明确协商 `2025-06-18`，不声称它是最新版本。

## 最小共用边界

工具只暴露：

```ts
type ReadPageArguments = {
  requestId: string;
  taskKey: string;
  label: string;
  revision: number;
};
type PageSnapshot = ReadPageArguments & {
  url: string;
  title: string;
  text: string;
  observedAtMs: number;
};
```

受控范围是 `taskKey="mcp-controlled-task"`、`label="mcp-controlled-page"`、`revision=1`。不接收任意 URL、JS、路径、命令或结果文件；字段之外的输入直接拒绝。MCP 返回 `content:[{type:"text",text:JSON}]` 与相同 `structuredContent`；失败只返回 `isError:true` 和固定短文案，不回显底层异常。native 超时 25 秒，客户端响应超时 30 秒。

生产应由一个共用 Rust 页面读取服务承接 UI 与 MCP 调用，复用同一当前页面、navigation revision、只读提取、关闭/导航后失效检查。内部调用方授权必须来自 Host 已确认的任务与浏览器分享范围，不能把工具传入的 `taskKey` 当授权证明。建议内部签名形态为 `read_page_snapshot(access, request) -> Result<PageSnapshot, ReadError>`，其中 access 由当前任务连接拿到；具体结构不在本探针中定为产品实现。

当前 browser 草稿 `browser_workspace_snapshot` 是主应用 webview 的受限 command。外部 Agent 启动的 stdio helper 不能直接调用它或越过 main/origin gate。正式接线仍需一个受控本地通信边界，让 stdio helper 调同一个页面服务；可复用稳定的 stdio 作为外部入口，但本地通信鉴权、生命周期、退出清理、撤销传达及不会泄漏到启动诊断的交接方式须先做短验证。这不是简单把 `mcpServers:[]` 换成一个对象就完成。

共用部分：页面授权与控制权、导航版本、真实读取、回执、关闭失效、脱敏边界、失败短文案。接入差异：官方配置注入面、支持的传输、重新连接和 load 的实际行为、工具启用回执。不复制浏览器实现到各 Agent，不修改 Agent 自身配置，不以 new/load 成功返回代替 MCP 可用证据。

## 留给正式接线的工作与边界

1. 将已验证的真实页面读取纳入既有应用，保持用户可见、可定位、可接管；不以本探针新建页面代表生产共享页面。
2. 明确用户分享与秘密输入暂停的 UI 和后端状态，再让所有读取入口检查同一授权。当前只排除合成输入 canary，不能推断完整秘密保护或真实账号交接已完成。
3. 验证 stdio helper 到运行中应用的最小受控通信；scope 必须服务端授予，撤销/关闭/任务切换后迟到结果丢弃；超时不宣称已经取消原操作。
4. 然后在既有 new/load 请求中加入已授权的可用 MCP 配置，保留 Agent 自有工具配置。恢复时重新核对分享范围与工具可用性，不把历史授权自动套给当前页面。
5. 用一个明确支持该官方扩展面的代表 Agent 验证真实工具发现、一次页面读取和人工接管；认证、模型和账号测试仍按既有用户评审后的接入流程安排，不能由本包代替。

本包不包含登录、持久 profile、用户文件页面、任意网站、下载、网络请求、点击/输入工具、生产分享状态、真实模型调用或全量 33 家测试。

## 重现方式

无 GUI 的检查：

```sh
python3 -m unittest -v test_page_server.py
cargo test --offline --locked --manifest-path acp-contract/Cargo.toml
```

`python3 live_client.py` 会实际启动相邻 `browser-seam-validation/seam-probe` 的受控原生窗口，需要相应 GUI 执行授权。不要在正式 Agent 配置中注册此探针；不要把已有回执路径传给它当作读取成功。
