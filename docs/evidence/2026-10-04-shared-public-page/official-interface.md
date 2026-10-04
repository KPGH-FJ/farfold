# 官方接口核查范围

本片以现有官方 ACP 2.2.0 类型构造 `session/new`、`session/load` 的 `mcpServers`。stdio 使用标准 `name/command/args/env` 字段，不依赖继承自定义文件描述符；已有活跃会话没有动态补工具入口，也不自动重开。协议另有按能力声明的 resume，Farfold 本片没有新增该入口。见[官方会话协议](https://agentclientprotocol.com/protocol/v1/session-setup)。

首个源码核查代表是 Zed 维护的 codex-acp v0.16.0，锁文件对应 Codex rust-v0.137.0；这些版本仅标识所核证据，不是产品准入 pin。

- [会话配置](https://github.com/zed-industries/codex-acp/blob/v0.16.0/src/codex_agent.rs)在内存克隆配置，将请求带来的 MCP 与 Agent 自己的 MCP 合并。未见该默认路径直接写用户配置文件。
- [stdio 启动器](https://github.com/openai/codex/blob/rust-v0.137.0/codex-rs/rmcp-client/src/stdio_server_launcher.rs)通过标准参数和环境启动工具，并可能记录工具 stderr。因此自有 helper 不输出凭证或正文到 stderr。
- [日志初始化](https://github.com/zed-industries/codex-acp/blob/v0.16.0/src/lib.rs)受外部调试配置影响；本片没有读取实际用户环境，也不保证任意包装器或未来版本不会记录扩展配置。
- [历史记录器](https://github.com/openai/codex/blob/rust-v0.137.0/codex-rs/rollout/src/recorder.rs)已核默认元数据字段未包含这份 MCP 配置；工具读出的正文仍可能进入 Agent 自己的对话历史，停止不能追回已交付内容。

Farfold 仅将随机短期凭证放入本次标准请求的工具环境，不放入 AgentRow.env、settings、会话配置或诊断。携带该凭证的打开失败使用固定错误，避免直接显示可能回显请求的远端错误。工具名有独立的非秘密随机后缀，避免覆盖 Agent 自己的同名配置。

当前准入集中在 `acp_client/browser_capability.rs`，仅已核 registry 来源的 Codex ACP 启动形状；其他入口是未核实，不是“不支持 MCP”。这不是二进制身份验证或操作系统沙箱。同一个 Agent 进程中的任务分隔仍依赖可信 Agent 的官方实现。

来源 URL、下载状态及实际保留源码摘要见 `raw/official-sources.json`。受控 new/load 请求验证与真实页面验证分开记录；本片未运行真实代表 Agent，不将两类受控对端拼成真实 Agent 成功。
