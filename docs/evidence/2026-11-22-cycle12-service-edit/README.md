# 第 12 周期所选 API 服务直达编辑

2026-11-22，北京时间。首发 21 家，Gemini CLI 与 Antigravity 的真实授权暂缓。本批沿 S1–S2 核对配置入口和返回，不发送真实模型请求。

## 旧版正式复现

正式应用 CDHash `d1060343c458bfc730885bbde2514f868aa72c8c`。恢复自建 OpenCode 草稿 `FF_C12_OPENCODE_AUTH_CANCEL_ONLY 草稿保留`，工作目录 `/private/tmp/ff-c12-s1-auth-cancel.GC606Qta/opencode`。用已有 Atria／Atria-Dawn，从「模型与来源 → 准备与连接 → 账号与服务 → 管理接入」点「编辑服务」。应用打开 API 配置列表，仍需在三份配置中找到 Atria 并再次点编辑。用「返回刚才的页面」回到原账号与服务页面，再回草稿，原文字、原目录和 Atria 保持。此次未触发保存、测试 API 或发送。

## 正式版复验与保存保护

正式首轮 CDHash `74f3fae12031093308cc02c2a08bd7bc4a981192`。同一草稿、同一 Atria，点击「编辑服务」直接显示 Atria 配置名称、Responses 和 Atria-Dawn，键盘落到名称。只在表单内改名，点取消出现「放弃未保存的修改？」。确认放弃后回到账号与服务的原接入方式，复开仍显示 Atria 原名。再次取消并返回，原未发文字、目录和 Atria 保持，发送按钮可用、焦点回「模型与来源」。另外从常规「设置 → API 配置」仍见原列表、筛选和逐项编辑。两份正式协议日志共零 `session/prompt`。范围限这条 OpenCode 的现有 API 草稿和常规列表；未修改已存服务，未验证其他 Agent 的正式直达。

指定服务编辑提交时带原服务版本、名称和提供方，后端在同一保存锁内和现值比较。目标被删除、替换或已变时，在读写密钥和写入设置前拒绝。编辑器保留未保存内容、停止提交旧表单，提示返回重新打开。受控回归覆盖模型变更、密钥轮换、名称或提供方变更、服务删除及正常保存。普通 API 配置入口沿现有保存流程。正式测试只验证直达和取消，版本竞争由受控回归验证。

最终正式 CDHash `05dc8ac032c227d6c910df77ede581532fa25e91`，可执行文件 SHA-256 `e50dfcf3b47891e77bdc266ac917fdd2a34032584313e9a1ec687ffa5eb00c50`。正常退出后，264,507 项数据元信息和六份关键摘要保持。最终装机同一 OpenCode 草稿再次直达 Atria 并取消，保留原稿、目录、Atria 和可用发送按钮，焦点回「模型与来源」。新日志 `protocol-v1-1795313442689-0.jsonl` 零 `session/prompt`。前端全量 11,100 项通过。保存保护功能的 Rust 全量 2,853 个单元与 10 个集成通过，11 项忽略。随后按 Clippy 要求缩小内部可选结构，Rust 两个受影响测试、Clippy、格式、arm64 打包和签名校验通过，界面与保存请求的 JSON 结构保持。

## Copilot 厂商失败反馈

目前的官方稳定版 1.0.114 与此前三个合成 401 路径所测版本一致。官方 SDK 1.0.34 声明可按会话 ID 只读获取持久事件，失败事件包含错误类型、可选状态码和原消息 ID。[此前合成 401](../2026-11-20-cycle12-s1-s2-followup/README.md#继续待验) · [官方稳定版](https://github.com/github/copilot-cli/releases/tag/v1.0.114) · [官方失败事件](https://github.com/microsoft/copilot-sdk/blob/v1.0.34/nodejs/src/generated/session-events.ts#L2784-L2868) · [官方只读接口](https://github.com/microsoft/copilot-sdk/blob/v1.0.34/nodejs/src/generated/rpc.ts#L51527-L51535)

隔离运行当版官方发布包。ACP 发一次合成 Chat Completions 提问，自行向本机服务尝试三次，助手消息带错误，仍返回 `end_turn`。原会话 `c2b0ae13-7b6f-4ddf-804f-8b6143e20b44` 存有结构化 `session.error`，`errorType:authentication`、`statusCode:401`、`providerErrorCode:invalid_api_key`，失败指出的 `originatingMessageId` 与原 `user.message` 的 `messageId` 相同。关闭自有会话后，禁网的同版官方程序只发 `ping` 和 `sessions.readPersistedEvents`，成功取回同样八条持久事件，日志摘要前后相同。未读取用户项目、历史或钥匙串，未调用外部模型。此路径尚未接入 Farfold，需核打开会话时原请求归属及可读时机。 [关闭后受控回执](copilot-401-after-close.json)

第二条独立合成会话 `7d041051-4cf5-46c3-a7b9-57180f2b8e04` 中，第一次发送前尚无持久事件。ACP 唯一测试提示仍返回 `end_turn`。会话与进程保持打开时，只读接口在该样本完成后的约 2 毫秒取到同一个根消息对应的结构化认证失败，读取前后日志摘要一致。ACP 往返中未观察到同一个原消息 ID、事件 ID 或结构化失败。实际引入前需要验证 Farfold 发出的请求与厂商根消息可稳定一对一对应，以及外部并发、旧事件或缺证时的行为。普通真实对话仍不能按消息正文判定成功或失败。两个自建进程均正常退出。 [打开时受控回执](copilot-401-while-open.json)
