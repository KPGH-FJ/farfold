# 第 12 周期继续验收

macOS 正式 Farfold 0.1.7。相关产品范围由唯一活动计划维护。

## fast-agent 双任务与停止后续答

第一次尝试中，A 已实际运行，B 在 Farfold 的全局发送队列等待满 60 秒，未产生 `session/prompt`。原有一个 Claude 请求收到 `auth_required` 后，状态未知且仍保留一个全局发送名额。A 实际停止并在原连接续答。用户保存并结束 Nova 原设置终端后，正常退出重开 Farfold，释放旧连接名额。

第二次，两条 fast-agent 0.10.1 任务从正常入口分别在两个独立目录出站。Agent 许可与 Farfold 各批准一次；实际核到两组 Shell 和 `sleep` 同时运行。仅点击 A 的停止后，686 毫秒内观察到 A 两个原进程退出，B 的原进程仍在运行并自然写出正确标记，Farfold 收到 B 的 `PAIR_B_SHELL_DONE`。等超过 A 原定 85 秒，无完成标记。A 的官方工具步骤仍显示结果未知。

再次正常退出并冷开 A，Farfold 读取同一原对话，保留「此前请求结果未确认，未自动重发」。手动发一条只读上下文的短消息，准确回复首条记号 `FF_C12_FAST_PAIR_A_9402`，无工具调用。新连接记录一次原会话 `session/load` 与一次手动发送，无 `session/new`。 [脱敏回执](fast-agent-pair.json) · 进程原始观察（本机 `output/2026-11-15-cycle12-continuation/paired-retest/fast-pair-processes.jsonl`）

## 已有账号、官方程序与首次使用

- Grok Build 的账号已由用户登录。正式应用能打开现有原对话，该轮正文可读并显示完成。入站正常完成的回执见此前对应协议日志，本轮未重复发送。
- Autohand 原 0.2.1 适配器要求登录凭据附带到期时间，当前官方 CLI 保存的长期凭据没有该字段。在 Farfold 正常更新入口选中厂商原生 `0.9.11 --acp`，保留原程序。旧认证结果曾使新程序界面继续显示需登录，未真正尝试打开会话。正常重启后，原账号设置被接受，`fantail` 已读回，一次正式短测准确回复记号，通过认证及实际发送分项。 [同版官方源码](https://github.com/autohandai/code-cli/blob/v0.9.11/src/modes/acp/adapter.ts#L740)
- 用户保存并结束 Nova 原终端后，正式界面仍显示需要登录。官方 1.1.65 的 V1 分支发 `permission/request`；官方 ACP V1 规定 `session/request_permission`。已查官方 ACP/CLI，现有集成无法走合格的审批入口。按用户授权将 Nova 移出首发清单，既有程序、登记、凭据和历史按原边界保留。 [官方发布](https://registry.npmjs.org/@compass-ai%2Fnova/1.1.65) · [ACP 权限要求](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- Qoder 的默认历史列表此前为空。本轮从持久自建目录走正常新对话，连接检查超时，发送不可用。零模型请求，保留该故障条件。Gemini CLI、Antigravity 登录按用户要求暂缓。 [28 家前序核查](../2026-11-15-cycle12-followup/accounts-and-api.md)

- Devin 的已知旧对象此前读取失败。本轮改走新样本目录，官方会话打开超过等待期限，正式入口保存原内容并禁用发送。零模型请求。

## 已保存 API 的复验

本机只有一条 Chat Completions 配置。选择它的既有 `apodex/apodex-1.1-mini:free`，从正常 OpenCode 新对话初次复测。官方返回了新会话，Farfold 在发送前显示「设置尚未确认」，无模型请求。源码核对发现，Rust 已对实际所选服务生成的完整模型值精确验证，前端又用配置中的短模型 ID 比较。已接入后端确认的完整值并保留服务、模型和原配置归属核对。正式新版使用原已保存配置和同一模型创建成功，真实 `session/prompt` 发出一次，原服务及模型写入该自建对话。OpenCode 随后返回协议错误，界面保留未知，未收到模型正文。为区分发送问题和服务本身的可用性，用设置里的独立 API 测试核了同一模型，返回 HTTP 404；同一服务的另一个已保存模型 `cohere/north-mini-code:free` 返回超时。现配置的这两个模型均无端到端成功。 [脱敏回执](account-api-results.json) [三家第三方 API 边界](../2026-11-15-cycle12-followup/accounts-and-api.md#第-12-周期后续的第三方-api-核对)

## 当前正式安装

新版正式 Farfold 为 0.1.7 arm64，CDHash `195969c5753ec3997f7940d8c9c2d43952da1555`。安装前后 206,936 条保护数据摘要一致，元数据副本完整性通过。已从正常入口看到 27 项，Nova 未显示，原登记与安装路径仍可读。Autohand 显示可用。 安装原件（本机 `output/2026-11-15-cycle12-continuation/install.json`）

前端全量 10,942 项及构建通过。Rust Clippy 通过。Rust 初次全量有一项工具恢复夹具等待超时，单独复验通过；在构建及前端结束后重新全量检查，2,782 项单元与 10 项集成通过，共 11 项保持忽略。 前端回执（本机 `output/2026-11-15-cycle12-continuation/frontend-tests.log`） · Rust 全量复核（本机 `output/2026-11-15-cycle12-continuation/backend-sequential-recheck.log`）
