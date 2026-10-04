# 官方 Codex 临时 MCP 合并与日志边界

核实日期：2026-10-05（本机工作日）。这是一份**纯工程证据**，没有启动真实 Agent、Codex app-server、模型、Farfold 或 MCP 子进程；没有读取真实用户配置、环境值、日志或对话。生产改动由主工作流另行完成。

## 会改变接入决策的结论

1. **磁盘配置中不同名的 MCP 可以保留。** 官方 Node adapter 的 new/load/resume 都把本次 MCP 转成 `config.mcp_servers` 交给 Codex。Codex 的配置层按表递归合并；合成的 global/project 两项与 Farfold 临时项在三条路线中同时存在。这里证明的是公开实现与纯函数行为，实际工具发现和读取仍需真实链路验收。
2. **`CODEX_CONFIG` 的内联 MCP 必须保护。** Node 会以本次临时 MCP 整体覆盖已有顶层 `mcp_servers`；`mcp_servers.*` 点分键虽然在 Node 中保留，但下游构造 overrides 层的顺序可能使其被整个 `mcp_servers` 表覆盖。不要通过复制或改写用户配置修复。安全门应对该次启动的有效值作有界解析，只保留是否安全；顶层精确字段或点分前缀出现时，不注入临时网页工具，普通 Agent 继续可用。
3. **`APP_SERVER_LOGS` 非空会记录临时授权。** 官方 Logger 在模块初始化时读取此项，`"0"`、`"false"` 和空格均算启用。`attachLogs` 原样记录 app-server stdin，包含临时 MCP env。缺失或空字符串才关闭该日志路径。判断必须对应实际启动的连接；复用连接不能用之后的环境变化重新背书，也不应擅自关闭用户日志。
4. **同名不能当作安全合并。** 官方默认先读取配置项名称（含配置层中禁用的名称）并跳过冲突。`DISABLE_MCP_CONFIG_FILTERING=true` 会绕过此过滤；底层逐叶合并可能把 URL 与 stdio command 混在一起。Farfold 应继续使用其已有的随机、独立临时名称。该开关不改变不同名磁盘配置的递归保留。

`CODEX_PATH` 是官方支持的下游选择项。Farfold 既有安装/发现流程也可能设置它，不能简单以“非空”断开常规官方入口。本次下游合并证据适用于审查的官方 Codex 实现；不据此保证任意自定义下游，也不新增二进制哈希或版本准入锁。

## 准确来源与调用链

版本和哈希只用于复核此次审查输入，**不是运行资格固定条件**。已安装公共包为 `@agentclientprotocol/codex-acp 1.13.1`，其公开依赖包为 `@openai/codex 0.156.1`。全部输入均为发布代码；未执行 package entrypoint。

| 已核代码 | 位置与意义 |
| --- | --- |
| [CodexAcpClient.ts](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/CodexAcpClient.ts#L519) | `resumeSession` 519、`loadSession` 559、`newSession` 599；共同调用 725 的 `createSessionConfig`，775 只取配置 MCP 名称；821 转换 stdio/env。 |
| [Logger.ts](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/Logger.ts)、[CodexJsonRpcConnection.ts](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/CodexJsonRpcConnection.ts) | Logger 开关与 stdin 原文记录。发布 `dist/index.js` 分别在 27204、27288；启动解析 `CODEX_CONFIG` 在 40564–40568。 |
| [thread_processor.rs](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/thread_processor.rs#L1321) | new 的 request config 在 1340 进入 `load_with_overrides`；resume 的 3900 附近进入 `load_for_cwd`。 |
| [config_manager.rs](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/config_manager.rs#L286) | 286/300 两入口归于 355 的加载函数；371–388 把 request HashMap 转为 CLI overrides，并交 `ConfigBuilder`。 |
| [core/config/mod.rs](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/config/mod.rs#L1479) | 1479 加载配置层，1494 取有效合并结果。 |
| [loader/mod.rs](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/loader/mod.rs#L411)、[state.rs](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/state.rs#L475) | overrides 加为本次 SessionFlags 层；有效配置按低到高逐层调用原生 merge。 |
| [merge.rs](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/merge.rs#L57)、[overrides.rs](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/overrides.rs#L9) | 表递归合并与构造点分覆盖层的整值插入。本目录保留这些实际执行的原样小文件和 `key_aliases.rs`。 |

[official-source-manifest.json](official-source-manifest.json) 记录发布 bundle SHA-256、每段提取的精确起止行和 SHA-256、提取合成文件哈希、官方 Rust 文件 URL/哈希。下载的 Rust 和 adapter TS 文件均与对应公开 tag tree 的 Git blob SHA-1 核对一致。完整 bundle、源码树 API 返回以及大模块只在本次工作区审查，没有纳入此精简归档。

## 已执行的最小代表样例

- [adapter-results.json](adapter-results.json)：12 个场景。new/load/resume 三条官方方法；内联 MCP 被覆盖的反例；既有/禁用配置名称冲突过滤；显式关闭过滤；6 种日志开关。风险样例均按预期复现，并未记成“生产安全”。
- [rust-results.json](rust-results.json)：5 个场景。上面三条方法的输出送入官方 Rust merge 后保留 global/project MCP；同名逐叶冲突；点分内联 MCP 的两种顺序得到不同结果。
- 所有地址为 `.invalid` 或纯合成路径，token 明示为 `SYNTHETIC_TEMPORARY_TOKEN_NOT_REAL`。

Node 验证执行的是发布 bundle 精确提取的原函数。`config/read` 返回、thread RPC 接收端、无关的技能/模型方法及日志文件 sink 为合成夹具；没有用自写合并函数替代官方实现。Rust 验证直接编译原样 `merge.rs`、`key_aliases.rs`、`overrides.rs`；未涉及的网络域名规范化依赖设为调用即 panic，保证它不会被假实现默默替代。二者通过实际 adapter 输出 JSON 衔接；并非完整 app-server 启动测试。

## 重放

在此目录运行：

```sh
node check-official-adapter.cjs
cargo run --offline --manifest-path rust-probe/Cargo.toml > rust-results.json
```

Rust 依赖须已缓存；`--offline` 不下载或安装。Node 默认使用归档的提取代码，并核对其审查哈希。如另有同一发布包的公共 `dist/index.js`，可把准确路径作为唯一参数传给脚本：脚本会重新提取、验证跨度和生成代码与此次审查一致，仍不会 import 或启动 Agent。换版本须另做兼容审查，不能把此脚本的证据哈希判断移入产品准入。

## 完成边界

此证据允许在实际连接安全门成立后继续接官方声明式 new/load MCP；不代表工具已发现、页面已授权或模型已真实读取。明日仍须在已授权的同一 Codex/服务/模型下验证真正的工具列表回执、允许后原请求继续、停止/取消最终回执，并保留未注入旧会话的准确状态。

本次仅明确排除了上述已核的 adapter 日志路径与内联配置覆盖条件；不宣称第三方可执行程序的一切日志、持久化和自定义实现都经过安全审计。Farfold 现有短期授权、任务归属、关闭撤销及日志脱敏仍需持续生效。

源码遵循上游 Apache-2.0，随附 [LICENSE.codex-acp](LICENSE.codex-acp)、[LICENSE.codex](LICENSE.codex) 和 [NOTICE.codex](NOTICE.codex)。本地文件均只为复核，没有改写上游包或用户配置。
