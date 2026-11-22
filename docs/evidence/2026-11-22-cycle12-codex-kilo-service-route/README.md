# 第 12 周期 Codex 同一连接与 Kilo 服务地址

2026-11-22，北京时间。Copilot 原 ACP 对话保持。Gemini CLI 与 Antigravity 实际授权继续暂缓。

## Codex 同一连接账号与只读

官方 0.171.0 此前能分别读到账号和实际只读，联合前检停在账号工作区路由。此轮受控探针能连接测试转发端口，公网直连 `chatgpt.com` 可解析域名，TLS 等待超时。用 Mac 已配置的本机 HTTPS 代理访问同一官方域名，在同一隔离进程读到了原配置的 ChatGPT 登录和工作区。服务仍由官方证书验证。关闭账号网络窗口再新建临时线程，实际回报 `gpt-6-astra / Ultra`、OpenAI、只读、工具网络关闭、用户审批以及空历史。 [本机端口对照](codex-account-window-control.json) · [同一进程零模型回执](codex-same-process-preflight.json) · [官方线程启动返回](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)

正式 Farfold CDHash `8b990faeef206603cc5fbd1f822266d99a2f7a29`。从「我的 Agent → 管理设置 → Codex → 检查程序」核对原登记 1.13.1。仅发出初始化，超时前未收到回复，账号页不可用。以现可用代理在旧官方 CLI 0.155.1 的隔离入口补查，也停在初始化。用户随后明确确认当下保存的 Codex 登录就是上次 Farfold 实测所用的账号。 [正式旧版超时](codex-farfold-check-timeout.json) · [旧官方程序只读复验](codex-old-isolated-timeout.json)

在新版独立的官方入口再次核合相同账号回执、实际只读及模型后，同一临时线程只提交一次 `turn/start`，内容为合成纯文字。原厂进程返回失败提示，没有收到答复或完成回执。账号查询连接已排空，单次提交后没有观察到新的官方 TLS 连接，厂商是否处理以及用量均未确认。原文件、配置、登记和历史继续按隔离前检保护，进程正常退出。该次单次授权已用于提交，零重发。临时目录的脱敏日志另见回执中的分类，失败事件的具体原因未保留，不能据旁路日志确定根因。Farfold 正常入口仍待新版正式验证。 [单次尝试回执](codex-single-attempt.json) · [官方发送协议](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)

## Kilo 同一进程的最终地址

Kilo 7.8.1 的 `/config/providers` 能从同一运行进程读到合成自定义服务的生效地址。测试夹具在用户选 A、管理配置覆盖为 B 时拦住发送，A、B 请求数都为零。读回 A 时，A 收到一次合成模型请求并在同一 ACP 对话返回准确标记，B 收到零次。使用模型地址后备字段也通过。定向接口 `/api/provider/{id}` 对 ACP 当前可选的自定义服务返回 `ProviderNotFoundError`。已核 7.8.32 的官方实现同样查独立目录，本批未运行这一版本。 [原始回执与官方源码](qualification.json)

全量查询返回的范围超过单个已授权服务，地址快照与下一次发送之间也可能发生设置变化。Kilo 的 Farfold 统一 API 继续待官方提供窄范围的运行中地址回执与发送绑定，或独立的进程级官方锁定方式。继续可用原官方设置。 [定向查询代码](https://github.com/Kilo-Org/kilocode/blob/2aa002cc0ab69d89f591f8174631152efa720877/packages/server/src/handlers/provider.ts#L18-L30) · [实际地址选择代码](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/opencode/src/provider/provider.ts#L1852-L1875)
