# DeepAgents 0.1.7 请求失败：静态调查

2026-10-01。仅只读已装公开包源码、Farfold 源码、登记收据、协议元数据和现有截图；未执行 Agent、登录或请求，未读取用户凭据、外部配置、原始 stderr 或协议正文，未修改产品源码。本次请求的具体运行原因仍未知。

## 已有实测与调查对象

[登记收据](deepagents-registration.json)确认正式安装为 `deepagents-acp@0.1.7`，Node 入口为受管 `install-yU32hG/node_modules/deepagents-acp/dist/cli.js`，无附加参数；握手自报版本 `0.0.1`，不能用它覆盖包版本。测试记录的模型和思考值均为 null，来源为已有设置。[07 准备页](07-deepagents-request-failed.png)与[08 测试对话](08-deepagents-test-thread.png)显示一次请求未完成，没有实际回复。

[协议元数据](protocol-metadata-final.json)中 `protocol-v1-1790790309411-6.jsonl` 记录 `session/new` 成功，随后一次 `session/prompt` 收到协议错误；只保留类别及字节数，没有错误码、异常原文或服务状态码。因此不能把该次失败写成缺 Key、401、余额不足、模型失效或缺依赖已被运行证明。

本次只读包清单确认依赖实际为 `deepagents 1.8.8`、`langchain 1.5.14`、`@langchain/core 1.2.13`、`@agentclientprotocol/sdk 0.17.1`。以下行号以本机已装公开文件为准；可对照[官方 0.1.7 标签 server.ts](https://github.com/langchain-ai/deepagentsjs/blob/deepagents-acp%400.1.7/libs/acp/src/server.ts)，没有用当前主分支替代安装版本。

## 默认服务与请求阶段的失败路径

| 边界       | 源码确认的行为                                                                                                                                                                                      | 对本次结论的限制                                                                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 默认模型   | `cli.js:1390–1401` 默认 `claude-sonnet-4-5-20250929`，`1422–1427` 允许 `--model` 覆盖，`1571–1578` 将该值交给 Agent。                                                                               | 这是包的静态默认，不是模型协议声明或本次服务成功接收的证明；Farfold 测试索引仍须保留模型未知。                                                                                                               |
| 模型读取   | `cli.js:695–733` 创建 Agent 并仅返回会话和 modes，不返回模型清单；`1234–1265` 调用 `createDeepAgent`。                                                                                              | `session/new` 成功不证明服务包或凭据可用；也没有依据从模式名称补造可选模型。                                                                                                                                 |
| 真实请求   | `cli.js:798–817,852–918` 在普通 prompt 才进入 `agent.stream`，流正常结束才返回 `end_turn`；`AbortError` 返回 cancelled，其余异常重新抛出。                                                          | 模型初始化、服务认证/网络/额度、工具及事件转换都可能在这一路径失败，不能把全部异常归为认证。                                                                                                                 |
| 服务包加载 | `langchain/dist/agents/nodes/AgentNode.js:116–122` 在调用模型时执行 `initChatModel`；`chat_models/universal.js:170–172` 将 Claude 前缀映射到 Anthropic，`127–157` 动态导入 `@langchain/anthropic`。 | 本次静态枚举该受管 `node_modules` 树内的包清单，没有找到 `@langchain/anthropic` 或 `@langchain/openai`。缺少服务集成包是具体失败候选，但未执行模块解析，也未排除祖先目录解析或更早失败，故不升级为本次根因。 |

入口见[已装 cli.js](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:deepagents/install-yU32hG/node_modules/deepagents-acp/dist/cli.js:1390>)、[模型调用节点](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:deepagents/install-yU32hG/node_modules/langchain/dist/agents/nodes/AgentNode.js:116>)、[服务加载实现](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:deepagents/install-yU32hG/node_modules/langchain/dist/chat_models/universal.js:127>)。`deepagents-acp`、`deepagents`、`langchain` 的已装 package.json 均未把上述两个服务包列为直接依赖；没有为调查补装包、改变默认模型或新增 Key。

## 认证声明的确定缺口

[已装声明](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:deepagents/install-yU32hG/node_modules/deepagents-acp/dist/cli.js:423>)实际包含两项 `type: "env_var"`，分别给出 `vars: [{name: "ANTHROPIC_API_KEY"}]`、`vars: [{name: "OPENAI_API_KEY"}]` 及公开服务页面；第三项 `deepagents-setup` 只有名称和说明。`handleAuthenticate` 在同文件第 691 行是空操作，不收集、保存或验证 Key。包 README 第 64–69 行也仅说明相应环境 Key，没有复用其他 CLI 订阅登录的依据。

当前出现一条可由源码完整确认的误路由链：

1. [锁定依赖](../../../src-tauri/Cargo.lock)使用 schema 1.9.1。[AuthMethod 定义](/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-schema-1.9.1/src/v1/agent.rs:573)只有 `Terminal` 和末尾 `#[serde(untagged)] Agent`；`AuthMethodAgent:643–663` 只保留 id/name/description/_meta，未拒绝未知字段。`env_var` 因而落入 Agent，type、vars、link 被丢弃。
2. [manager.rs:572](../../../src-tauri/src/acp_client/manager.rs#L572)将 typed 握手重新序列化后保存。[登记收据](deepagents-registration.json)中这两项确实只剩 id/name；[auth_run:434](../../../src-tauri/src/auth.rs#L434)也从 live typed 握手重新序列化，故只在 `auth.rs` 末端判断 `type == env_var` 已无法恢复信息。
3. 缺省 type、无扩展字段的结果通过 [protocol_method](../../../src-tauri/src/acp_client/auth_route.rs#L34)，成为 `Route::Agent`。[账号页](../../../src/components/AgentAuthSection.tsx#L426)据 kind 给出“开始登录”，[auth_actions](../../../src/runtime/auth_actions.ts#L85)发送普通 `authenticate`，后端同样允许该归一化声明。
4. DeepAgents 空 `authenticate` 可正常返回；[AuthActivity](../../../src/runtime/auth_activity.ts#L94)随后重查连接。当前文字是“连接已重新检查”或“登录流程已结束”，仍要求实际对话验证，**没有直接声称 Key 有效**；但该入口无法完成名称所指的 Key 设置，确属声明处理与操作可达性缺口。本次没有点击或实测此登录流程。

SDK 0.17.1 的 `AgentSideConnection` 第 32–36 行直接返回 Agent 的 initialize 结果，没有在服务端把这些字段先删掉。信息丢失点位于 Farfold 所用 Rust schema 的 typed 归一化边界，不应据归一化后的 id/name 猜测原始类型。

## 错误传播与最小后续验证

[已装 JS SDK](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:deepagents/install-yU32hG/node_modules/@agentclientprotocol/sdk/dist/acp.js:819>)在请求处理时保留 `RequestError`、将参数验证错误变为 invalid params，而普通异常转为 internal error（`-32603`），细节进入 data。DeepAgents 没有把普通服务异常统一转换成 `authRequired`。Farfold 的 [describe_acp_error](../../../src-tauri/src/acp_client/pump.rs#L243)只将明确 AuthRequired 映射为 `AUTH_REQUIRED`，其余沿失败结算；[uiError](../../../src/runtime/ui_error.ts)隐藏原始诊断，使用通用请求失败文案。按目前收到的事实保留通用失败是合理分类，不能从默认服务、Key 名称或没有正文反推认证失败。

可补强的是已确认的声明信息，而非猜测本次错误：

- 在 typed 归一化前，通过现有官方协议传输保留认证声明的类型与所需公开字段，再统一处理 env_var；暂不支持的显式类型应有诚实不可自动操作出口，不能降为普通 authenticate。不得在 UI 按名称/品牌补分支，也不能解析 description 为命令。
- Key 路线仍需经既有服务选择与明确交付边界，不读取或自动分发任何现有凭据；空 authenticate 返回与连接成功继续不等于 Key/请求可用。第三项空 setup 不能凭描述制造可执行配置命令。
- 官方 `--model` 可作为后续已有启动参数审阅机制的来源；是否支持及如何兼容已存参数另行实现验证，不把静态默认写入用户选择或当前测试索引。服务包缺失应先取得受控的依赖解析反例/官方发行修复依据，不修改已装外部包来补齐。

最小受控回归建议（本次未执行）：以真实 schema roundtrip 输入 `{id,name,type:"env_var",vars,link}`，验证类型/公开变量名在接入层可达且不会发送 authenticate；同时保留真正缺省/显式 agent、typed terminal、未知显式 type、畸形 vars 的边界。组件测试覆盖 Key 项不会显示虚假的普通登录动作，未支持项给出明确出口；普通协议 internal error 仍为通用失败，只有明确 AuthRequired 才进入认证要求。此组回归与后续安装验证分别记录，不能替代本次未知运行根因。
