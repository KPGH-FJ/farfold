# 认证声明保真：只读设计核对

2026-10-01。针对 [DeepAgents 静态调查](deepagents-static.md)中 `env_var` 被归一化成普通登录的缺口，只核对现有源码与本地官方 Cargo 源码/缓存；未修改产品、锁文件或依赖，未运行 Cargo、Agent、登录或正式应用。下面是可实施边界与待执行回归，尚无修复、红绿或安装通过结论；本次 DeepAgents 请求根因仍未知。

## 可用的官方接入位置

推荐在现有 initialize 请求的结果映射处保留认证声明，不改子进程传输或 SDK：

1. [manager.rs](../../../src-tauri/src/acp_client/manager.rs#L466)继续用官方 `InitializeRequest` 构造相同请求、能力和协议版本；将该请求通过 `UntypedMessage::new("initialize", &init)` 发送。
2. 官方 SDK 2.2.0 的 [UntypedMessage](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-2.2.0/src/jsonrpc.rs:5351)以 `Value` 为 Response；[SentRequest::map](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-2.2.0/src/jsonrpc.rs:5730)允许立即消耗成功响应，返回自己的受限结果类型，仍复用同一个请求 ID、取消和响应归属。仓库 [session/new 与 session/list](../../../src-tauri/src/acp_client/pump.rs#L1064)已经使用此公开请求接口。
3. 映射函数先提取并校验认证声明，再通过官方 `InitializeResponse` 校验其余 v1 握手；原始 Value 在映射结束时丢弃。不要把完整 Value 放进 oneshot、连接状态、数据库或事件总线；返回的对象只含原有 typed 握手与本次校验出的认证声明。
4. SDK [protocol_compat::incoming_initialize_response](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-2.2.0/src/jsonrpc/protocol_compat.rs:518)先核对协议版本并返回同一 Value，没有把 v1 authMethods 再序列化。故使用 UntypedMessage 不绕过 initialize 协商，也不会在映射之前再次丢失 env_var。SDK 的私有 response hook 不需要调用。

不推荐从 [process.rs 的 bridge inspection](../../../src-tauri/src/acp_client/process.rs#L293)另存一个回复：那里已有安全诊断职责，另存需额外配对请求 ID、处理迟到回复和共享缓存，而上述 SDK 映射已经具有这些归属。`process.rs` 的 cwd、环境继承、ByteStreams、进程组和退出回收，以及 [tap.rs](../../../src-tauri/src/acp_client/tap.rs)的无正文日志保持原样。

## 本地 schema 可用性

[Cargo.lock](../../../src-tauri/Cargo.lock)锁定 SDK 2.2.0 / schema 1.9.1。本次枚举的本地 registry source、crate cache 都只有这两个对应版本；本地 schema 稀疏索引最后一项也是 1.9.1，未 yanked。**未发现本地已缓存的后续 schema，不能宣称联网最新版本也如此**，也未执行升级或下载。

1.9.1 的 [v1 AuthMethod](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-schema-1.9.1/src/v1/agent.rs:573)只有 Terminal 和 untagged Agent，无 EnvVar。相同版本的 [v2 AuthMethod](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-schema-1.9.1/src/v2/agent.rs:517)已有 Other 变体保留未知类型，但仍无专门 EnvVar；它使用 `methodId`、`auth/login` 和 v2 握手语义。不能仅为修这次 v1 信息丢失而切协议版本，或把 v1 对象强行套入 v2 类型。现有公开 untyped 请求足以在不 patch SDK 的前提下修复边界。

## 同一握手对象与数据边界

建议新增小模块 `acp_client/handshake.rs`，由单次 decode 产生 `Handshake { typed: InitializeResponse, auth: Vec<AuthDeclaration> }`。将现有连接的 `OnceLock<InitializeResponse>` 改为这个对象，不增加第二个连接状态、登记表或持久化账本。能力读取继续使用 `typed`；认证读取只使用 `auth`。公开投影由同一对象按需生成，不再独立维护一个声明缓存。现有 AgentRow.handshake JSON 通过显式序列化方法生成：保留既有能力/程序身份字段，用受限公开声明替换 authMethods，不能直接序列化整个 typed 对象。

认证投影必须区分以下来源，不能统一先反序列化为 AuthMethod 再判断：

| 原始声明                                         | 接入层保留和路由                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无 type / 明确 `agent`                           | 保留两者的区别；使用现有普通 authenticate 或经核验的兼容扩展。不得仅因名称包含 Key/login 推断类型。                                                                                                     |
| 明确 `terminal`                                  | 先检查原始 type，再按官方 Terminal 结构校验；格式错误不能退成 Agent。继续原注册程序加声明参数及目标保护；不能因本片重排/删去已有有效参数而启动另一条命令。                                              |
| 明确 `env_var`                                   | 仅新增保留 type、id、name 和通过变量名规则校验的 `vars[].name`；不复制变量值、default、token、key、未知扩展字段。多个变量不能静默压成第一个。原始 link/description 不是运行必要条件，首片可不新增保存。 |
| 其他显式 type / 非字符串 type / 已知类型格式错误 | 分类为未支持或无效，保留必要身份供说明；不保留任意 payload，不允许 authenticate，也不落入名字推断。无有效身份、重复 ID、超出数量/长度边界时，相关声明不得获得可执行身份。                               |

对已有 Agent/Terminal 路线，不扩大当前字段和 `_meta` 保存范围；解析器必须明确列出保留项与现有消费者，例如 `_meta.terminal-auth`、`_meta.type/args`、`_meta.api-key.env`。未理解的额外字段不能因为采用 untyped 就全部进库。运行所需的现有声明字段和供 UI/存储的公开投影需分别审查：若字段可能含秘密，不能为方便持久化原样复制；缺少安全可持久表示时保留 live 运行声明，断线后要求重新检查，不能用删减后的对象假装仍有完整可执行参数。

特别是官方 Terminal 类型的参数/环境容器含容错解码规则，格式错误的成员可能被丢弃或归空；仅要求 `serde_json::from_value` 成功不够。应在 typed 解码前检查原始 terminal 的 args/env 形状及成员类型，整条畸形声明不可自动执行，不能删掉坏参数后运行剩余命令。有效 terminal 的原声明参数/环境仅在所属 live 连接内存中供已有目标核验及执行；持久/UI 投影不得复制任意环境值或 `_meta`。env_var 的 `vars[].value/default/file`、额外元数据与带查询的链接同样不保存。不要给整个 Handshake 派生通用 Serialize/Debug 后绕过这些边界。

所有校验错误使用固定中文说明/错误码，不插入原始类型值、变量值、URL 查询、JSON 或解码错误正文；原始回复不得实现 Debug/Serialize 后意外被日志打印。可在现有诊断测试加入秘密 canary，要求新增持久投影与 tap 均不包含它。

## 路由与统一 UI 的最小接法

[auth_route.rs](../../../src-tauri/src/acp_client/auth_route.rs)和 [auth.rs](../../../src-tauri/src/auth.rs)必须共用新的声明结果；[manager.authenticate](../../../src-tauri/src/acp_client/manager.rs#L675)也从同一 live 结果核对 method ID 与执行种类。只改 `auth_methods` 的展示不够：`auth_run` 当前会重新序列化 live typed 握手，必须同步替换该读取入口，否则执行前又丢失类型。启动、scope、来源和取消检查维持不变，未知类型在凭据查询、启动或 authenticate 之前拒绝。

UI 继续一份 [AgentAuthSection](../../../src/components/AgentAuthSection.tsx)。建议 `AuthMethodInfo.kind` 增加通用 `environment` / `unsupported`，环境方法可用现有 `envName` 的单值补充或有界 `envNames` 列表呈现声明；不将所有环境变量等同秘密 Key。未支持方法使用独立固定说明与现有 unavailableReason，隐藏不可执行的“开始登录”，保留重新检查连接及用户明确配置的更多方式。既有 agent/terminal/api-key 行为不变，不写 Agent 品牌分支。

**此片不能只将 env_var 改成现有 api-key 就声称接入完成。** [service_config::capability/compile](../../../src-tauri/src/acp_client/service_config.rs#L36)目前仅为 OpenCode/Codex 提供服务编译；DeepAgents 尚无此路线。[CredentialSettings](../../../src/components/CredentialSettings.tsx)及 [credentials.rs](../../../src-tauri/src/credentials.rs)对旧 env grants 只有保留与撤销，没有新授权入口。`ManualAuthSection` 保存的是用户明确指定的命令与变量名，也不是一个声明驱动的 Key 输入/交付流程。首片可先关闭误导登录入口并诚实显示尚不能直接配置；完整环境 Key 交付仍需沿已有“选择服务才授权本次连接”的边界单独补齐，不恢复全 Agent 自动分发，不为 DeepAgents 写配置或新建第二套凭据存储。

旧数据库中的缺省 Agent 项可能本来就是未知类型被旧 SDK 压平，不能据旧 id/name 反向猜回 env_var。沿现有显式重新检查取得新握手；UI 不能把尚未重新核实的旧缓存标为可执行的新声明。执行前必须要求目标目录/来源的当前 live 声明，后端不得从失真的旧缓存回落。具体缓存呈现可复用 unavailableReason 与重查入口，不通过全 Agent 阻断影响其他目录或 API 会话。

具体接线不能遗漏两处：

- [auth_methods](../../../src-tauri/src/auth.rs#L372)当前只收 agentId，读取全 Agent 最后落库的握手；[前端调用](../../../src/runtime/agents.ts#L211)与 [AgentAuthSection 的加载 effect](../../../src/components/AgentAuthSection.tsx#L131)需要传入实际 cwd/source，并随该目标变化重新读取。已有设置来源下，返回该目标 live 声明的公开信息；无 live 时缓存仅供说明并明确需要重查，不能因为其他 cwd 更新了 AgentRow 就变成可执行。API 来源继续沿现有服务边界，不把账号动作授权带过去。
- [auth_run](../../../src-tauri/src/auth.rs#L438)目前在 live lookup 失败时仍沿用 row.handshake，terminal 可继续进入 PTY；新实现必须移除此自动执行回落，只在同目标 live 声明通过后派生完整调用。`manager.authenticate` 和 logout 的 guard 同样使用该 live 分类，不能重新从 typed 序列化恢复。持久公开投影如需标识新格式，可在现有握手内放一个 Farfold 自有版本字段；它只表示投影格式，绝不授权离线执行，旧记录缺字段也不得猜原类型。执行安全不依赖这一可选格式标记。

## 最小文件范围与实现顺序

| 范围                                                                  | 必要改动                                                                                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 `src-tauri/src/acp_client/handshake.rs` 及独立测试                 | 纯 decode/投影/显式序列化，已有 schema 真 roundtrip 反例；不承载进程或账号生命周期。                                                                       |
| `acp_client/mod.rs`、`initialization.rs`、`manager.rs`                | 模块接线；initialize 使用公开 untyped + map；oneshot/OnceLock 承载同一个 Handshake；保存及 live 认证统一读取。manager 当前 1379 行，解析逻辑必须放新模块。 |
| `acp_client/session.rs` 与既有连接 fixture                            | 仅调整 typed 能力字段访问/测试构造；不改会话/恢复协议。若采用显式访问器可缩小这些机械改动。                                                                |
| `auth.rs`、`acp_client/auth_route.rs` 与路由测试                      | 类型优先、不可执行原因；auth_methods 接入 cwd/source，auth_run 去掉旧缓存回落；统一 live 守卫及旧缓存出口。                                                |
| `src/runtime/agents.ts`、`AgentAuthSection.tsx`、相关字符串与组件测试 | 新种类/公开变量名说明及目标参数；加载 effect 跟随实际目录/来源，禁止 environment/unsupported 发普通登录；其他入口和重查继续复用。                          |
| 本片不需改动                                                          | Cargo.toml/lock、SDK 源码、process/tap、外部包、秘密存储、Agent 配置及安装器。完整服务交付不计入这张最小修复表。                                           |

顺序为：真实 schema 反例先红 → 纯解析/投影 → initialize 与 live/store 同一对象接线 → 认证执行守卫 → UI → 受控生命周期与秘密 canary 检查 → 同一正式候选安装验证。全部仍待实施；不把下述代码样例写为已经运行的红测。

## 必须使用真实 SDK 的回归反例

首个回归应对真实 1.9.1 类型做 roundtrip，而非只把一个伪造 JSON 交给路由：

```rust
let raw = json!({
    "protocolVersion": 1,
    "agentCapabilities": {},
    "authMethods": [{
        "id": "fixture-key", "name": "Fixture Key",
        "type": "env_var", "vars": [{"name": "FIXTURE_KEY"}]
    }]
});
let typed: InitializeResponse = serde_json::from_value(raw).unwrap();
let normalized = serde_json::to_value(typed).unwrap();
assert_eq!(normalized["authMethods"][0]["type"], "env_var");
```

按当前 schema，该“必须保留类型”的断言预期失败。修复测试改走同一次请求的真实 SDK untyped 结果与应用 decode 后，还要验证：

- 任意 Agent ID 的 env_var 都不会调 authenticate；未知显式类型、`type:null`、畸形 terminal、重复 ID 同样不会落普通登录。真实缺省/显式 Agent 及有效 typed Terminal 继续走原路，已核验 Kilo/Amp/Qwen 扩展不被覆盖。
- SDK transport fixture 实际收发一次 initialize，结果经 map 后的 live 与持久公开声明一致；candidate 不写注册握手，原 registered 程序保持。远端错误、解码失败、60 秒超时、取消与迟到成功沿当前 startup-errors 行为，不假 ready。
- 在额外字段、vars.value/default、未知 metadata 中放 canary，持久公开声明和日志不得出现；仍保留合法变量名。单/多变量、缺失或错误 vars、超长输入各有真实分类，不截断后当有效声明。
- UI 中 environment/unsupported 无普通登录请求；重查、暂离、返回与旧缓存刷新可达。既有 API 来源不会自动交付 Key；空 authenticate 不能清掉已证实的请求级认证要求。

安装验收先复核 DeepAgents 的公开声明与入口分类，保留原模型/来源/草稿，且无需点击空 authenticate。实际 Key 交付、服务依赖修复或再次 prompt 需要相应实现和明确旅程证据，不能由本片静态设计代替。
