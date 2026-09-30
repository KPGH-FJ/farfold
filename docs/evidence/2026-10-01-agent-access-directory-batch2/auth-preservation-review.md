# 认证声明保真：独立只读审查

审查时间：2026-10-01 02:05，02:09 补读作者新增的 Terminal 容错与目标查询/执行守卫说明（Asia/Shanghai）。读取[设计稿](auth-preservation-design.md)、当前 Farfold 认证/初始化/传输代码、锁定 SDK 2.2.0 与 schema 1.9.1 的本地公开源码。补读后的设计稿 SHA-256：`972da8d7aa2e4162638253d375ffcf175352c03e78d6183062b61d47586bb801`。

结论：设计选择的官方接入位置可实施；无需新增传输旁路、请求账本或依赖。下面三项是实现必须覆盖的边界，不是已完成修复或已通过测试。

## 1. 信息必须在同一次 initialize 的 typed 解码之前保留

schema 的 [v1 AuthMethod](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-schema-1.9.1/src/v1/agent.rs:573)只有 Terminal 和末尾 untagged Agent。Agent 对象没有未知字段拒绝规则，只保存 id/name/description/_meta。于是有合法 id/name 的 `type: env_var` 或其他未支持显式类型不能在 typed roundtrip 后保持原类型与 vars；其结果会成为缺省 Agent 对象。当前 [manager](../../../src-tauri/src/acp_client/manager.rs#L501)先 typed 解码，再在第 572 行重新序列化保存；[auth_run](../../../src-tauri/src/auth.rs#L434)也重序列化 live typed 握手。这是确定的源码边界。DeepAgents 的已装公开声明另见[静态调查](deepagents-static.md)，本审查没有运行其认证或请求。

推荐的 `UntypedMessage::new("initialize", &init)` 加 `SentRequest::map` 仍是同一个官方请求：

- [UntypedMessage 的 Response](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-2.2.0/src/jsonrpc.rs:5351)为 `serde_json::Value`。
- [SDK incoming actor](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-2.2.0/src/jsonrpc/incoming_actor.rs:208)按 response ID 找到并移除对应 pending reply，再按该请求的 method 执行协议兼容处理；未知或其他请求的响应不会被任意归到 initialize。
- [protocol_compat](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-2.2.0/src/jsonrpc/protocol_compat.rs:518)核验 v1 协议版本后返回 Value，没有在这里重序列化认证枚举。
- [SentRequest::map](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-2.2.0/src/jsonrpc.rs:5738)保留原 id、method、response receiver、取消与响应排序；只映射成功响应，协议错误绕过 mapper。

因此应在这个 mapper 内立即解码成单一受限 Handshake，让现有 oneshot/OnceLock 承载它。现有超时、取消、StartingConnection 和进程回收行为保持；不要从 process bridge 或 tap 复制原始响应、用“最近一次 response”匹配，或另建 ID 缓存。[tap](../../../src-tauri/src/acp_client/tap.rs)继续只写事件类别、方向与字节数。

## 2. 公开投影与实际运行声明必须分开审查

新增保留范围可以很小：有效、唯一、有界的 id/name，缺省/显式 Agent 的区别，Terminal 的已校验执行种类，env_var 的变量名称列表，以及未支持/无效的固定分类。其他显式类型只需保留“显式未知，不能自动操作”的事实，不应把任意原始 type 文本当错误文案输出。

`vars[].name` 应沿现有 `valid_env` 语法，并增加数量、单名长度和总量上限。该语法只确认环境变量名称，不证明变量必然是密钥，也不证明任一变量有现成的服务交付路径。多个变量、重复名称、缺失或畸形 vars 都须有明确分类，不能静默取第一项。不要复制 value/default/token/key、文件内容、任意 `_meta`、link 查询或动态错误正文；原始 Value 不进入连接结果、日志或数据库。

必须特别防止把“官方 typed 解码成功”误认为严格格式检查：[AuthMethodTerminal](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-schema-1.9.1/src/v1/agent.rs:698)的 args 使用 `DefaultOnError<VecSkipError<...>>`，env 使用 `DefaultOnError`。例如 `args: 7` 或混入非字符串项存在被默认或跳过的源码路径；仅再次反序列化官方枚举不能证明原参数完整。因此 mapper 应先核对原始已知字段的形状，畸形声明不给执行身份。此处未执行反例测试，须以真实 schema 回归取得红绿证据。

有效 Terminal 继续使用注册程序及完整基础参数，再追加声明参数，环境覆盖按现有语义；不能把它发给 authenticate。已有经验证的兼容扩展继续经同一个 route 判定，不因新类型保留覆盖 Kilo/Amp 等目标保护。Terminal env、参数或旧扩展中的运行值若不能安全持久化，应只留在当前连接的运行声明；持久投影明确表示需要重新检查，不能删减字段后仍当成完整可执行声明。

首片只显示 env_var 的声明并关闭错误的普通登录动作是合理边界；它不等于 Key 输入或服务配置已实现。[现有服务编译](../../../src-tauri/src/acp_client/service_config.rs#L36)没有通用环境变量交付路线。不得直接将 env_var 标成现有 api-key，随后自动查 Keychain、分发旧 Key，或把空 authenticate 正常返回当作真实请求认证恢复。

## 3. 新捕获证明与执行前的精确目标不能被旧缓存替代

旧存储中的 `{id, name}` 既可能是合法缺省 Agent，也可能是旧 schema 压平的 env_var/未知类型。两者无法从旧值反推。需要在现有握手持久投影中明确区分本应用的新捕获结果与缺证明的旧缓存，不新增登记表；缺证明时显示待重新检查，不能用 Agent 名称猜类型。

当前两个接线点须同步处理：

- `auth_methods` 只有 agentId，读取 Agent 最后存储的握手；前端账号页也只传该 ID。它不能单凭另一个目录刚保存的投影声称当前目录拥有可执行声明。可给现有查询增加目标参数/来源，或明确显示缓存状态并走既有重查入口，不扩成全 Agent 会话阻断。
- `auth_run` 当前对 live lookup 是最佳努力：取得时替换握手，失败则继续旧 row.handshake。若新的持久投影有意省略运行值，这个回落必须停止；执行自动声明前要求原目录、已有设置来源的当前 live Handshake，manager.authenticate 也从同一对象核对 method ID 与执行种类。用户明确配置的手动路线仍是独立授权，不伪装成自动声明。

## 后续必要证据与结论限制

尚未运行任何测试或应用。实现时最低限度应取得真实 schema roundtrip 反例，以及真实 SDK 单次 initialize 的结果映射回归；验证 env_var/未知/非字符串 type/畸形 Terminal/重复 ID 不发送 authenticate、不创建自动 PTY，正常 Agent/Terminal 保持原路线。

还需把 canary 放入新增非公开字段、vars 值、未知 metadata 和 URL 查询，检查持久投影、tap 与固定错误输出均不包含正文；覆盖超时、取消、迟到响应、candidate 不写注册握手，以及两个目录相同 method ID 不串用执行身份。旧缓存缺证明时的说明、明确重查和返回路径由同一 UI 验证。真实 Key 交付、DeepAgents 实际请求失败根因与正式安装验收均不由本次设计审查证明。

本次只写本审查文档；未改产品源码、依赖、用户配置或凭据，未运行 Cargo、Agent、登录或正式应用。
