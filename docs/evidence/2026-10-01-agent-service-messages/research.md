# M4 Messages 服务交付：只读研究

日期：2026-10-01。范围对应[活动计划](../../../plans/agent-access.md) §3.2 M4、§3.4 有限配方与 §6.1 服务生命周期，以及 [PRODUCT.md](../../../PRODUCT.md) 的服务来源与旧对话保护。本次没有修改产品代码、运行 Agent 或应用、调用模型、读取用户认证配置或密钥、升级组件。公开源码和官方文档只能证明接口及静态行为；Messages 的真实交付、首发与恢复均未在本次验证。

## 结论

**推荐下一片先扩展 OpenCode 现有服务交付，增加 Messages；Claude 暂保留为独立的条件式方案。** OpenCode 已有独立提供方、密钥环境引用、精确模型校验和来源隔离，官方固定发行也内置 Anthropic provider，新增范围可以集中在现有接入层。中央 API 测试已经支持 Messages，但当前没有 Agent 接入开放这种格式，不能把中央测试成功当成 Agent 可用。

Claude 的公开组件支持环境及 SDK 配置，但仅增加地址、API Key、模型三个变量不足以保证选择：设置文件可以覆盖环境，其他认证与云路由可能优先，恢复时启动模型选择还会触发组件自己的模型重申。当前官方文档提供宿主控制路由的接口，但尚未证明已装 CLI 的实际行为。无需为开发强求第三个 Agent，也不以改配置文件、私有 HOME 或模型代理补齐此缺口。

## 1. 可直接复用的当前代码

| 入口                                                                             | 已有行为                                                                                                                                                                      | 本片边界                                                           |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [service_config.rs](../../../src-tauri/src/acp_client/service_config.rs)         | OpenCode 的 Chat Completions/Responses、Codex 的 Responses；独立 `farfold_<digest>` 提供方；配置里仅放环境变量引用，密钥通过不实现 Debug/Serialize 的 `LaunchConfig` 单独交付 | `messages` 目前不在能力中；不能由中央编辑器支持格式推导 Agent 支持 |
| [service_connection.rs](../../../src-tauri/src/acp_client/service_connection.rs) | 所选来源与修订隔离连接；旧对话按原非秘密来源恢复；不自动换来源；配置锁内读取最新登记与服务                                                                                    | 不另建连接管理器、来源账本或凭据授权关系                           |
| [credentials.rs](../../../src-tauri/src/credentials.rs)                          | Keychain 引用、服务身份、轮换/删除、修订；地址或格式变化不自动向新目标交付旧 Key                                                                                              | 不读取或记录真实 Key 来完成研究；原 CRUD 无须重做                  |
| [api_test.rs](../../../src-tauri/src/api_test.rs)                                | Messages 显式短测为 `x-api-key` + `anthropic-version: 2023-06-01`；基础地址后追加 `/messages`                                                                                 | 测试与 Agent 的实际请求地址规则必须一致；成功只覆盖被测模型        |
| [ServicePicker](../../../src/components/ServicePicker.tsx)                       | 按接入能力筛选服务、保留失效的原选择并要求重新选择                                                                                                                            | 不新增品牌界面，不将环境变量认证声明转成 API 配置权限              |

`service_config::catalog_id` 当前仅认可 `def_for` 中的原三个接入身份。未来 Claude 能力须核实目录 ID、登记来源及官方启动形状，不可按标题、`agentInfo.name` 或任意相同名称启用。OpenCode 扩展沿当前已支持身份，不扩大到所有自定义程序。

## 2. Claude：已装公开组件与未关闭条件

### 2.1 固定公开材料

[历史声明](../2026-10-01-agent-access-directory-continuation/claude-declaration.json) 指向 `registry:claude-acp` 的受管 Node 入口。读取该公开安装包确认：组件 `@agentclientprotocol/claude-agent-acp` 0.81.2，依赖 SDK 0.3.280；SDK 公开 manifest 标明 CLI 2.1.280、构建日期 2026-09-21。这不是执行过该 CLI 的证明，组件允许 `CLAUDE_CODE_EXECUTABLE` 指定其他入口。本次没有读取或校验二进制 SHA。

固定组件来源：[0.81.2 npm 元数据](https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp/0.81.2)、[发行页](https://github.com/agentclientprotocol/claude-agent-acp/releases/tag/v0.81.2)、[提交 5dbb453 的源码](https://github.com/agentclientprotocol/claude-agent-acp/blob/5dbb453c63a89746627799b2b06b31ba01a1b674/src/acp-agent.ts)。以下摘要用于定位本次读过的公开材料，不是版本 pin 或 Agent 兼容性门槛。

| 公开文件（安装包内）                     | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `claude-agent-acp/package.json`          | `babacb99324687f02d54f0894c6ebdab1240fa057e4c325464f3390b93ea8a65` |
| `claude-agent-acp/dist/acp-agent.js`     | `36a33a984624541ea013c085f5bd1d982294cfe70beb42826752f62bdc538d64` |
| `claude-agent-acp/dist/session-model.js` | `1cc635299c34d3b8933ece92dcabed84b34f688ad98f5ae7f6fcdaf700f42c41` |
| `claude-agent-sdk/package.json`          | `1b088aefaa33134531f1840976e87cc1fce2383deff646a75e7a5bdd78cf18c8` |
| `claude-agent-sdk/manifest.json`         | `6d9840c779f76b2a7e974aa3476be24d1ea477f5dc96abd0096be28a58cb7120` |
| `claude-agent-sdk/sdk.d.ts`              | `b7ac9c0ed0db5c1792a5394e72c75d69d85f4ce9edc0279487ec55d32eabfa76` |

### 2.2 为何不能直接增加三个变量

固定组件的 `createSession` 把继承环境、SDK 选项环境和官方提供方环境合并；默认仍读取 user/project/local 设置。源码明确处理设置文件环境覆盖子进程环境的冲突：它将官方 gateway 路由同时写入 SDK `settings.env`，并禁用该次 `apiKeyHelper`。见[固定源码的配置合并](https://github.com/agentclientprotocol/claude-agent-acp/blob/5dbb453c63a89746627799b2b06b31ba01a1b674/src/acp-agent.ts#L8423-L8480)。不能直接照搬它的 gateway 实现：其中认证 headers 会进入程序配置对象；Farfold 必须保持秘密独立交付，也不提供模型代理。

官方文档说明，认证优先级先看云提供方，再看 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、helper、OAuth 等；已有官方 gateway 会话还可能位于这个序列之外并优先。故设置 BASE_URL 与 API_KEY 不足以排除继承的 Bearer、云服务或 gateway。研究没有读取用户配置，也没有推断本机存在其中任何一种状态。[官方认证优先级](https://code.claude.com/docs/en/authentication#authentication-precedence)

当前官方文档的 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 可防止设置文件覆盖宿主路由与认证变量，但同时影响 managed 模型优先级及部分遥测默认行为；仅确认这是一项官方宿主接口，未确认本机 CLI 2.1.280 的对应实现。不能将它当成私有环境开关、自动移除用户策略或已完成隔离的证据。[官方环境参考](https://code.claude.com/docs/en/env-vars)

### 2.3 模型与恢复边界

固定 [session-model.ts](https://github.com/agentclientprotocol/claude-agent-acp/blob/5dbb453c63a89746627799b2b06b31ba01a1b674/src/session-model.ts) 的 `getAvailableModels` 优先读取 `ANTHROPIC_MODEL`，再读取设置及恢复提示；可能进行别名/allowlist 映射，并在恢复时调用 SDK `setModel` 重申启动选择。官方当前文档也说明启动模型选择可能覆盖恢复模型。[官方模型恢复说明](https://code.claude.com/docs/en/model-config)

因此，若以后实现 Claude，至少先验证：精确 API 模型 ID 在新稿中被实际确认；同来源旧对话恢复不会因别名、策略或新环境发生改选；已有订阅来源的旧对话不能被改成 API 来源。保留现有完整受保护 ID 集合、服务身份和模型准入，不把接入组件的模糊映射当作模型保持，也不在失败时自动改成 Default。`CLAUDE_MODEL_CONFIG` 只能作为公开候选目录/映射接口研究，不能制造“实际已经使用所选模型”的证明。

### 2.4 Claude 后续最小调查门槛

- 核实所运行的官方 SDK/CLI 入口及宿主路由接口；不能因包 manifest 相同推断 executable override 也相同，不升级日常 CLI 来制造结果。
- 仅在任务自有受控设置中验证：冲突 BASE_URL、AUTH_TOKEN、云服务开关、helper、模型设置、managed allowlist；不读取用户真实配置，不清空环境，不创建私有 HOME。
- 将官方路由参数与密钥交付分开。若无秘密不进入启动配置/诊断的官方接口，则保持此路线不可用；不拼 shell 或替 Agent 写配置。
- 对新稿及同来源冷恢复分别验证；任何未知 gateway/策略优先级保留为条件缺失，不用收到模型后的错误提示代替启动前隔离证明。

## 3. OpenCode：推荐的较小实现路线

**静态可实施，真实 Messages 请求尚未验证。** 固定 OpenCode 1.18.31 已包含官方 `@ai-sdk/anthropic` 3.0.111；拟通过现有独立提供方配置明确选择该实现，不新增 Farfold 依赖、不下载 floating 包、不把 Claude 的根地址语义套到任意网关。

固定来源：[OpenCode 1.18.31 提供方实现](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/provider/provider.ts)、[该发行依赖声明](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/package.json)、[Anthropic provider 3.0.111](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.111/packages/anthropic/src/anthropic-provider.ts)、[Messages 请求实现](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.111/packages/anthropic/src/anthropic-messages-language-model.ts)。补读了官方 npm 固定归档的公共 JS，未执行安装脚本或任何 SDK 请求；`@ai-sdk/provider-utils` 4.0.46 的显式字符串 `apiKey`/`baseURL` 直接返回，不回退对应全局环境。[固定 helper 元数据](https://registry.npmjs.org/@ai-sdk%2fprovider-utils/4.0.46)

| 官方公开归档（仅内存读取）      | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `@ai-sdk/anthropic` 3.0.111     | `73bea91ccdc47af4efa1b6d77b8a4fe4af6303d16abc04aba54b2b1f75f6086e` |
| `@ai-sdk/provider-utils` 4.0.46 | `e56798f119aea0cb5ab48ef54b3d0d9816223f2bf37c115077f0ca4562588eed` |

### 3.1 交付形状及规则

延续当前 `OPENCODE_CONFIG_CONTENT` 合并，独立提供方保持原摘要 ID；`npm` 使用官方 `@ai-sdk/anthropic`，`options.baseURL` 使用已确认的 Messages 基础地址，`options.apiKey` 仍为 `{env:FARFOLD_SERVICE_KEY_<suffix>}`。选用 `apiKey` 与中央测试现有 `x-api-key` 语义一致；不自动改成 Bearer，也不同时填写 `authToken`。

模型 map 的键与 `model.id` 分别对应 OpenCode 选择身份及实际 API 模型 ID。沿现有 `models[id] = {name:id}` 可让 API ID 保持逐字相同，选择身份为 `farfold_<digest>/<id>`；名称仅展示。仍用 `validate_model` 比较实际 `currentValue`，不因菜单中存在该项就允许首发。

当前编译器只拒绝继承 inline 配置中同 ID 的不同定义；这不是对所有磁盘/插件配置的冲突证明。OpenCode 还会合并提供方选项与 `model.headers`，模型级 `provider.npm` 优先于提供方级 `npm`；Anthropic SDK 的 `options.headers` 又位于默认认证头之后，可以覆盖头值。独立 ID 减少冲突，却不能单独证明真实交付隔离。新增受控反例须包括磁盘/插件同 ID 的地址、token、头及模型实现覆盖；不能只断言生成的 JSON。若无法通过官方接口保持所选目标与认证，相关条件明确拒绝/不开放，不静默清除用户设置。见[实际配置合并](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/provider/provider.ts#L1482-L1512)与[实际 SDK 选项](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/provider/provider.ts#L1734-L1786)。

用户 `enabled_providers` / `disabled_providers` 可以过滤新提供方：保留限制并给出可恢复失败，不为通过测试删除限制。不复制用户 auth 配置，不沿用其他提供方的 Key。全局 `ANTHROPIC_AUTH_TOKEN` 并非该固定 SDK 的自动回退项；仍需防范合并进该提供方的显式 `authToken`/headers，与 Claude CLI 的认证优先级分开分析。

### 3.2 地址必须先统一

Anthropic provider 默认基础地址为 `https://api.anthropic.com/v1`，对精确官方根有补 `/v1` 的处理，但自定义根不补；请求会再追加 `/messages`。当前中央测试直接在用户基础地址后追加 `/messages`，若用户填官方根，两条路线就会不同。

最小实现须给中央测试与交付编译器同一确定规则：只对官方精确根的版本路径作有限处理；自定义 HTTPS 基础地址逐字保留其路径，不能猜测补 `/v1`。或者统一要求明确版本基础地址，并对缺失者给可读说明。无论采用哪项，保存的来源身份及修订仍按原机制处理，不因本片静默迁移已有服务或自动交付旧 Key。必须受控覆盖官方根、官方 `/v1`、自定义根、自定义 `/v1`、自定义其他前缀、尾斜线与禁止具体 `/messages` 请求路径。

### 3.3 预计最小代码范围

| 文件                                                     | 必要改动                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `acp_client/service_config.rs` 及相称拆分测试            | 有限 Messages 能力、官方 Anthropic provider、环境引用、精确模型选择与原配置冲突；保留既有 Chat/Responses 输出 |
| `api_test.rs` / `api_test/tests.rs`，必要共享地址 helper | 与编译器使用同一 Messages 请求地址规则；保留不重定向、显式短请求、取消及大小限制                              |
| 现有能力/来源选择组件测试                                | Messages 服务只在已提供该能力的接入上可选；旧无效选择保留；环境认证声明不变成 API 配置入口                    |

服务 CRUD、Keychain、连接隔离、轮换、删除、旧来源恢复和单次显式请求已经有实现，新增片不重做这些机制。`validatedApiTypes` 的完成声明必须与实际证据一致；实现/受控验证与安装版真实请求分列。

## 4. 必要反例与安装出口

建议受控红绿至少验证以下真实边界，测试名称仅为实施建议，本次没有创建或执行测试。

另有必须通过的实际 SDK 请求反例：磁盘/插件同 ID、模型 headers 或模型级实现覆盖时，不能以生成 JSON 正确或模型名相同宣称隔离；建议 `messages_does_not_accept_merged_routing_or_auth_override`。这一项的结果决定可开放范围。

| 反例                                                  | 应有行为 / 建议用例                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 原环境存在另一 Anthropic Key/token、原提供方与模型    | 独立提供方只使用本次明确 API Key 与模型；不影响原提供方。`messages_uses_selected_secret_without_global_auth_fallback` |
| 官方根与自定义根                                      | 中央短测和 Agent 配置产生同一实际请求目标；不猜网关版本路径。`messages_request_base_is_shared_and_exact`              |
| 同提供方 ID 冲突、提供方被禁用或未获 enabled 名单许可 | 拒绝或真实读取失败，原选择和限制不改。`messages_preserves_provider_restrictions`                                      |
| 任意同名自定义 Agent、Claude 环境认证声明             | 不授予 Messages 交付能力。`messages_capability_requires_known_official_route`                                         |
| 服务保存、轮换、改地址/格式、删除                     | 保存不交付；选择才使用；旧修订失效不自动重连，不把旧 Key 发到新目标                                                   |
| 新稿读取的实际模型不等于请求、同名模型来自另一服务    | 保留原选择与失败，不能首发；来源 ID/指纹/修订仍参与隔离                                                               |
| 原 Messages 对话冷恢复                                | 原来源、模型及推理项完整，恢复不自动发送；缺服务/模型/Key 时明确失败，不换成已有设置或 Default                        |
| canary Key                                            | 不出现在 inline 配置、MetaStore、公开 IPC、诊断或错误字符串；仅进入用户明确选择的连接秘密交付                         |

正式出口需要同一安装候选：选择 Messages 服务与明确模型 → 读取及确认 → 返回原稿 → 用户明确短请求得到准确回复 → 冷恢复同来源/模型/推理并明确续发；再核对轮换/删除、失败重试、取消、旧数据及进程退出。中央 API 短测不能替代通过 Agent 的首条请求。

实现与受控检查可继续自主推进。真实请求条件是用户已有或明确提供的 Messages HTTPS 服务、有效 API Key、可用模型，以及该次明确服务/模型选择；本研究不读取现有秘密、不猜模型、不自动注册或发送。条件未具备时，安装后的真实请求/恢复仍标未测，不能把功能存在计为上市完成。

## 5. 本次验证范围

已完成：现有源码与产品边界读取、Claude 已安装公开包及固定官方源码核对、官方认证/路由/模型资料核对、OpenCode 官方固定版本的并行静态核对。未完成：任何产品实现、受控行为红绿、真实 API 请求、Claude 宿主路由实测、同候选安装验收或用户账号配置。后续落地仍需各层独立证据。
