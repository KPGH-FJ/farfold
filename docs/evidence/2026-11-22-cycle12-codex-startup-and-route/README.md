# 第 12 周期 Codex 启动恢复与零发送路由检查

2026-11-22，北京时间。本轮未发送模型消息。Kilo 等官方提供最终地址和发送绑定；Copilot 原 ACP 对话、Gemini CLI 与 Antigravity 不进入本次验收。

## Farfold 原入口恢复

上一轮用于验证新版的诊断进程从 13:40:33 到 13:48:34 在 Codex 原安装标识上持有共享锁。Farfold 原登记的 60 秒初始化超时从 13:42:50 起，整个等待窗口都落在持锁期间。原厂 0.155.1 在读取这个文件之前会先等独占锁。断网、无凭据对照中，原登记 Node 和 ACP 1.13.1 搭配外部 0.155.1 或随包的 0.156.1，握手均正常；仅隔离读取原配置的 0.155.1 也完成握手。 [原测试的时间与锁](legacy-lock-overlap.json) · [原厂 A/B 对照](official-legacy-pair.json) · [0.155.1 安装标识源码](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/installation_id.rs#L21-L51)

确认测试进程退出后，从正式 Farfold `8b990fae` 的「我的 Agent → 管理设置 → Codex → 检查程序」重试。原程序检查在 168 毫秒收到对应回复，账号页读到此前用户确认的原登录，已有设置检查通过。当前默认显示 6.2 Sol，原 6 Astra / Ultra 仍可在模型页暂选。放弃本次选择，原设置保持。两个连接均零 `session/prompt`，旧 Codex 对话没有打开。未改程序、登记或超时。 [正式零发送回执](farfold-codex-recovered.json)

## 新版账号、只读与路由

独立官方 ACP 2.9.0 / CLI 0.171.0 通过已有系统 HTTPS 路径完成握手，在原连接收到官方账号推送，能读提供方配置入口。诊断将 SQLite 临时状态指到独立目录，原登录保持。ACP 当前模型和模式回执只说明选择状态。之前同进程官方原厂检查已确认实际只读、工具网络关闭、原 `gpt-6-astra / Ultra` 和账号。旧正式入口虽恢复，仍不能用其模式标签作为实际只读证明。 [新版 ACP 零发送](new-acp-isolated-account.json) · [原厂同连接回执](../2026-11-22-cycle12-codex-kilo-service-route/codex-same-process-preflight.json)

官方 `codex doctor --network-only --json` 在独立隔离连接完成 Responses WebSocket GET 升级，HTTP 101 且未立即断开。同一诊断的独立 HTTP 连通检查失败。另一条原厂读模型操作返回 `gpt-6-astra / Ultra`，模型目录可能来自本机缓存。这两项证明 WebSocket 路径和模型配置可核，真实推理、额度和 HTTP 后备仍待。 [官方网络检查](native-network-doctor.json) · [只读模型目录](native-model-catalog.json)

上次单次尝试留下原厂泛化错误标记和零新官方连接。保留的 SQLite 日志中的模型目录超时及 WebSocket 预热均早于人工提交，原错误的结构化内容没有留下。无法据此判定模型或额度拒绝。诊断已修正为保留可归属的错误类型、HTTP 状态和厂商重试标记，跳过消息及身份字段。安装标识核对也改为比较原字节和文件身份，避免持有共享锁。三项离线测试通过，未启动新的推理请求。 [原请求脱敏诊断](previous-send-diagnosis.json) · [诊断修正回执](diagnostic-correction.json)

官方 0.171.0 启动新对话时可经 Responses WebSocket 预热。预热帧包含会话指令等字段并设置 `generate=false`。该版本未找到能在保留内置 OpenAI 服务时单独关闭此预热的公开配置。本轮隔离了新对话的预热网络，只单独检查 WebSocket 升级，未在线发送预热帧。新的纯文字复验需要用户另行授权。 [原厂预热流程](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/session/startup_prewarm.rs#L464-L529) · [预热请求构造](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/client.rs#L2444-L2474) · [原厂服务覆盖规则](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/model-provider-info/src/lib.rs#L793-L824)
