# 认证声明保真：后端实现与受控验证

2026-10-01。工作区源码，尚未提交、打包或正式安装验收。前置调查见 [DeepAgents 静态核对](../2026-10-01-agent-access-directory-batch2/deepagents-static.md)、[设计](../2026-10-01-agent-access-directory-batch2/auth-preservation-design.md)和[设计独立审查](../2026-10-01-agent-access-directory-batch2/auth-preservation-review.md)。DeepAgents 本次真实 prompt 的失败根因仍未知，不能用本片声明修复解释为已经解决。

官方范围更正见[后续联网核对](official-auth-scope.md)：实验性 env_var 已于 2026-07-27 移除，Rust SDK 归入 Agent 是有意的兼容策略，不是漏升级。本片保留旧发行公开声明并关闭不具实际配置能力的误导入口，不将 env_var 恢复为现行标准功能。后续 Key 路线须依据当前官方 Agent/Terminal/结构化交互或经核实的服务配置，不启用旧全局授权。

## 行为与边界

[handshake.rs](../../../src-tauri/src/acp_client/handshake.rs)通过 SDK 2.2.0 的 `UntypedMessage` 和 `SentRequest::map` 接住同一次 initialize 成功响应，立即校验并提取认证声明。剩余能力仍由官方 `InitializeResponse` 解码；其 `auth_methods` 留空，避免其他消费者再经有损 typed 序列化覆盖真实分类。连接仍只有一个 `OnceLock<Handshake>`，没有新表、请求旁路或额外状态登记。未知类型和已知畸形声明不能降级成普通 authenticate；重复身份、非字符串 type、无效/重复环境变量名和集合边界也有保护。

声明分为所属连接的临时执行字段及公开结果。有效 Terminal 仍严格使用已选程序、完整基础参数与声明追加参数，保留原声明环境；不去重参数。Kilo/Amp/Qwen 仍经既有目标校验。args/env 容器先检查真实结构，不以 SDK 容错后的剩余参数运行。旧兼容扩展只保留现有路由实际读取的字段。

写入既有 AgentRow 的结果只保留公开身份、类型和变量名，不保存认证参数、环境值、任意 `_meta`、vars.value/default/file 或 link 查询。新格式使用同一握手内 `farfoldAuthFormat: 1` 作公开结构标识；它不授予缓存执行权。原始完整 Value 不越过映射函数，Handshake 不派生 Serialize/Debug。现有 cwd、环境继承、ByteStreams、进程组、回收及 tap 元数据规则未改。

[auth.rs](../../../src-tauri/src/auth.rs)的 `auth_methods` 新收可选 cwd/source：已有设置来源只读取目标目录的当前 live 声明。没有目标、没有该目录 live 连接或选中 API 时，缓存仅可展示，所有方法均带固定不可执行说明，退出登录不可用。旧有损快照不能凭缺省 type 重新取得执行资格。`auth_run` 与 logout 执行前都要求精确 live 声明；[manager](../../../src-tauri/src/acp_client/manager.rs)的 protocol guard 消费同一对象，不再重新序列化 typed auth。未知/环境方法在凭据查询、PTY 或 authenticate 前拒绝，既有来源与账号操作保护继续存在。

Wire 保留原字段，增加 `kind: environment | unsupported` 和可选 `envNames`。它们使用固定 `unavailableReason`；环境名不代表一定是密钥，不复用现有 api-key 作为假支持，不新增 Keychain 交付。`terminalCommand` 在公开查询返回 null，当前前端没有消费该预览字段；实际完整命令只在 live 路由核验及执行中使用。手动明确配置的登录路线保持独立，不从 description 解析命令。

## 回归证据

[真实首轮红测](declarations-red.log)运行当前 SDK typed roundtrip 再接现有应用分类，并覆盖 live manager：4 项全部失败，分别为 env_var / 未知类型误标 Agent、畸形 Terminal 参数被过滤后仍可运行、未知类型实际到达协议分发。该记录发生在修复之前，退出码见[收据](declarations-red.json)。

修后最初[11 项定向通过](declarations-green.log)。期间一次编译错误来自遗漏处理 `UntypedMessage::new` 的 Result，已修正；[原编译失败](compile-first.log)保留，不作为行为红测。

最终定向检查分别通过，过滤集合有交集，不相加为独立总数：

| 检查            | 结果      | 日志与收据                                                             |
| --------------- | --------- | ---------------------------------------------------------------------- |
| auth            | 77 项通过 | [日志](auth-stable.log) / [收据](auth-stable.json)                     |
| lifecycle_tests | 24 项通过 | [日志](lifecycle-stable.log) / [收据](lifecycle-stable.json)           |
| startup         | 12 项通过 | [日志](startup-stable.log) / [收据](startup-stable.json)               |
| initialization  | 2 项通过  | [日志](initialization-stable.log) / [收据](initialization-stable.json) |

新增 [SDK/应用测试](../../../src-tauri/src/auth/declaration_tests.rs)、[纯声明测试](../../../src-tauri/src/acp_client/handshake/tests.rs)与[真实受控传输测试](../../../src-tauri/src/auth/declaration_transport_tests.rs)覆盖：

- 实际 SDK 单次 initialize 经 map 进入 live 与存储；两个目录提供不同声明，查询/执行不串用；API 来源、断线和旧缓存不可自动运行。
- 环境、未知和 Terminal 不发送 authenticate，真实普通 Agent 方法仍发送一次；Terminal 参数逐字追加，环境值只留当前连接。
- 自有临时 Python 对端的 candidate 检查不改注册记录，完成后无候选待清理状态。
- 秘密 canary 放在变量值、未知 metadata、链接查询、终端环境和参数中；持久公开声明、查询结果和本夹具协议日志均不含该值。
- 已有 Kilo/Amp/Qwen、标准 Terminal 权威、来源保护、提前取消、晚到关闭、启动错误及超时测试继续通过。

受控传输只启动自有临时 Python 对端，不运行真实 Agent 或发送 prompt。auth 定向组沿用既有自有测试 Keychain 写入/读取/清理测试，不能将它写成真实账号或环境变量交付验证；没有读取用户真实凭据。最终日志中的一处测试 unused import 警告随后仅删除该未用 import，生产语义未变。`cargo fmt --check` 与 `git diff --check` 通过；全量 clippy/测试及安装旅程由根任务统一执行，本文不预先宣称通过。

## 交付范围

本后端共 10 个源码/测试文件，路径、行数及最终摘要见 [backend-files.json](backend-files.json)。最长 manager 1,386 行，auth 1,044 行；新模块与测试均低于 1,500 行。未改依赖、官方包、安装器、全局计划或状态文件。完整环境变量输入/秘密交付、DeepAgents 请求失败原因与正式安装版表现仍待各自证据。

独立审查已只读核对上述后端及最终定向日志，未发现确定后端阻断；统一前后端审查记录由审查者在前端稳定后补齐。此结论不代替根任务全量检查或安装验证。
