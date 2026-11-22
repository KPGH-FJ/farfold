# 第 12 周期 Codex 官方 CLI 断网准备验证

2026-11-22，北京时间。本批没有发送消息，也没有把 Codex 新对话的预热数据传到外网。保持当前正式 Farfold、两家原登记及历史。结果只证明独立 CLI 路径的准备分项。 [脱敏回执](offline-cli.json)

## 同一官方连接的实际回执

用官方 Codex 0.171.0 的 `app-server --listen stdio://` 在独立测试目录启动一次。整个进程的本机回环、IPv4 和 IPv6 连接均被系统隔离拒绝。独立对照确认无法读写夹具外测试数据，也不能访问系统安全存储。CLI 保留用户现有 Codex 配置来源，只读本机保存的官方登录，测试日志和状态落到独立目录。安装标识不加共享锁，退出后文件身份和原字节核合。

1. `accountSession/list` 关闭工作区元数据刷新。官方只读回执报告当前登录和已选工作区，来自上一批用户确认的原 Codex 设置。只保留各字段是否存在，未记录邮件、账号 ID 或工作区 ID。
2. `modelProvider/list` 报告默认提供方为 OpenAI。它证明本地可选配置。在线工作区和本轮真实推理、实际计费都没有在断网阶段验证。此前在线原服务的官方正例单列。 [此前授权首答](../2026-11-22-cycle12-codex-startup-and-route/README.md#用户批准的新短测)
3. 在同一条 stdio 连接创建无历史的临时对话，官方返回实际文件权限只读、工具网络关闭、审批由用户逐次处理，并核合 OpenAI、`gpt-6-astra / Ultra` 与独立目录。未提交 `turn/start`，也未加载旧对话。即使程序安排预热，断网条件也不会传出预热内容。检查结束后官方进程退出。

[官方账号只读接口](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server/src/request_processors/account_processor/workspace_switching.rs#L14-L44) · [官方实际对话设置回执](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server/src/request_processors/thread_processor.rs#L1780-L1805) · [官方预热实现](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/session/startup_prewarm.rs#L464-L529)

## Farfold 正常入口的接法边界

Farfold 现有官方 CLI 通道通过登记包运行 `cli app-server --listen stdio://`，只用于读取技能等已接功能。对话正常入口经 ACP 建立连接。官方 ACP 2.9.0 私有启动 App Server，并省略实际对话设置通知。已发布接口也没有提供这条私有连接的只读旁路。因而，打开独立 CLI 能核实这次诊断和正式实现的可行性，无法承接正在由 ACP 管理的对话。

用相同厂商 CLI 做了完全断网的官方 ACP 2.9.0 对照。握手成功，声明账号状态能力；独立目录新建空对话返回通用错误 `-32603`，未给可归属原因。未得到对话 ID，因此未尝试切换只读，也没有权限、模型或账号值可核。隔离同时拦住了原历史及外部网络，不能只凭这次错误把原因归为断网。全程没有发送模型消息。 [ACP 对照回执](offline-acp-comparison.json)

沿用 ACP 的落地条件是官方向客户端转交同一条对话的实际设置和变更。另一个可开发的官方接法是让 App Server 从正常入口接管一条新对话自创建、审批、发送、停止到重开的完整生命周期，保留旧 ACP 连接和历史的归属。App Server 是不同协议，本批未接到 Farfold 的对话正常入口。正式入口只读、账号和模型的组合继续待验，未提高 S1 或 S2 的通过计数。

[Farfold 官方 CLI 启动点](../../../src-tauri/src/acp_client/extension_inventory/launch.rs#L237) · [Farfold 对话入口](../../../src-tauri/src/acp_client/manager.rs#L716) · [ACP 启动官方进程](https://github.com/agentclientprotocol/codex-acp/blob/v2.9.0/src/CodexJsonRpcConnection.ts#L30-L57) · [ACP 实际权限事件处理](https://github.com/agentclientprotocol/codex-acp/blob/v2.9.0/src/CodexEventHandler.ts#L845-L850) · [官方 App Server 介绍](https://developers.openai.com/codex/app-server/)
