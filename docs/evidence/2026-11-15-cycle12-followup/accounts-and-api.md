# 28 家 Agent 的登录与 API 接入核对

2026-11-15，macOS。账号依据当前登记和第 10–12 周期的正式版分项。保存的握手只证明 Agent 宣告的方法，官方文档只证明该范围提供接口。没有重新登录、换号、读取密钥或为这个盘点发送模型请求。 [28 家逐项证据](../2026-11-15-cycle12-macos/acceptance-matrix.md) · [第 10 周期](../2026-11-15-cycle10-macos/README.md) · [第 11 周期](../2026-11-15-cycle11-macos/README.md)

## 需要用户处理的账号

- **明确需要认证（5 家）**　Antigravity、Autohand、Gemini CLI、Grok Build、Nova。Gemini CLI 有自己的 Gemini API Key 方式。Antigravity、Autohand、Grok Build 和 Nova 各有官方配置路线，本机当前登记对这些替代路线尚无实际可用结果。
- **先核原账号或服务（2 家）**　Claude 可核原订阅／Console，也有 Farfold Messages API 路线。Amp 需先准备厂商原版 CLI，旧登记认证未完成且原身份待核；目前不能只叫用户在现有 Amp 适配器里重登。
- Factory Droid 的旧 401、Qoder 另一版的认证要求和 Pi 的旧 402 各自保留。Cline、DimCode 和 Kimchi 是连接或真实请求故障，MiniMax Code 和 siGit Code 首先需认清原模型或服务。细项见下表。

## 在 Farfold 直接填写模型 API

进入「设置 → API 配置 → 添加 API 配置」，然后在适用 Agent 的「账号与服务 → 模型 API 服务」选择。**当前有 3 家接入该统一入口。**

| Agent                       | 接口                                  | 当前证据                                                                                                |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| OpenCode                    | Chat Completions、Responses、Messages | 源码三类均已实现并有受控路由验证。MiMo 实用样本使用用户在 OpenCode 中已有的设置。                       |
| Codex                       | Responses                             | 有受控路由记录。NEW-24 仍暂停受影响的新发送。另有独立的官方 OpenAI API Key 登录方法。                   |
| Claude Code 的官方 ACP 接入 | Messages                              | 同安装受控 HTTP 收到实际所选模型与路由。每个新连接要由 Agent 确认支持；真实计费服务及当次端到端仍待证。 |

[统一服务能力定义](../../../src-tauri/src/acp_client/service_config.rs) · [Claude 受控回执](../2026-10-09-capability-hardening/claude-service-delivery/receipt.json) · [NEW-24](../../status.md#未解决问题与执行边界)

## 逐家状态

| Agent          | 本机需要什么                                               | 模型 API 设置或厂商账号入口                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amp            | 先准备厂商原版 CLI，核旧身份和原线程；旧登记认证未完成     | Amp 账号内的 Model Routing 可绑定供应商 Key、订阅或 gateway。AMP_API_KEY 是 Amp 账户凭据。 [官方](https://ampcode.com/docs/customize/model-routing)                                                  |
| Antigravity    | 正式版明确要求认证                                         | 自家 CLI／IDE 的 Gemini API Key 或 Google 登录。该 Key 路径在当前 Farfold 登记待验。 [官方](https://antigravity.google/docs/install?tab=cli)                                                         |
| Autohand       | 正式版明确要求认证                                         | 官方伴随 CLI 可配置 Anthropic、OpenAI 等提供方及其 Key。当前登记复验待做。 [官方](https://docs.autohand.ai/working-with-autohand-code/configuration)                                                 |
| Claude Code    | 先核原账号／服务；统一 Messages 可作为单独路线             | Farfold 可设 Messages。原订阅和 Console 各走官方认证。 [Farfold 实现](../../../src-tauri/src/acp_client/service_config.rs)                                                                           |
| Cline          | 当前初始化早退，先解决连接                                 | Cline CLI 原生认证／提供方设置。 [官方](https://github.com/cline/cline/blob/main/docs/cli/cli-reference.mdx)                                                                                         |
| CodeBuddy      | 旧真实会话有证据，当前身份未复验                           | 官方 CODEBUDDY_API_KEY、BASE_URL 和模型配置。 [官方](https://www.codebuddy.ai/docs/cli/iam)                                                                                                          |
| Codex          | NEW-24 限制受影响的发送，登录或换 Key 不能解除             | Farfold Responses。也能走官方方法直接认证 OpenAI API Key。 [统一配置](../../../src-tauri/src/acp_client/service_config.rs) · [认证实现](../../../src-tauri/src/acp_client/api_key_auth.rs)           |
| Cursor         | 新版沿原账号和 Auto 实际续答                               | CURSOR_API_KEY 可认证 Cursor。当前 CLI/ACP 未核到可直接填第三方模型商 Key 的可用入口。 [官方](https://cursor.com/docs/cli/acp)                                                                       |
| Devin          | 旧服务有实答，原对话实际读取失败                           | 当前 ACP 使用 Devin Cloud 及其厂商认证，未核到当前 ACP 的直接模型商 Key 路径。 [官方](https://docs.devin.ai/cli/acp/zed)                                                                             |
| DimCode        | 创建会话内部错误，先确定故障                               | 官方 /connect 或 OPENAI_API_KEY。 [官方](https://dimcode.dev/en/docs/getting-started/)                                                                                                               |
| Dirac          | 原免费模型已实际回复                                       | Dirac 自家设置／CLI 可选择 OpenRouter 等模型服务。 [官方](https://dirac.run/docs/cli)                                                                                                                |
| Factory Droid  | 有旧 401 和内部错误；先核同一来源                          | Factory Key 是厂商认证。外部自定义模型用其原生 BYOK。 [官方](https://docs.factory.com/model-independence/byok)                                                                                       |
| fast-agent     | 已有服务产生过实际结果                                     | 通过 fast-agent 自己的 provider 配置／环境使用 API。Farfold 命令审批是本地执行权限。 [官方](https://fast-agent.ai/models/llm_providers/)                                                             |
| Gemini CLI     | 正式版明确要求认证                                         | Google 登录、Gemini API Key 或 Vertex。外部配置有效性要回 Farfold 用所选模型复验。 [官方](https://google-gemini.github.io/gemini-cli/docs/get-started/authentication.html)                           |
| GitHub Copilot | 原账号有实答，现版本的账号权益仍按证据核                   | Copilot CLI 自己的 BYOK 支持 OpenAI Chat Completions、Azure 及 Anthropic。GitHub 云功能依各自认证。 [官方](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models) |
| Goose          | 原已有设置有真实文件及停止证据                             | goose configure 可设提供方。OpenRouter 有原实测。 [官方](https://goose-docs.ai/docs/getting-started/providers/)                                                                                      |
| Grok Build     | 正式版明确要求认证                                         | xAI Key 或官方较新 BYOK。当前登记未验。 [官方](https://docs.x.ai/build/enterprise)                                                                                                                   |
| Kilo           | 原已有模型有实答和停止记录                                 | Kilo 自有 provider／连接设置。 [官方](https://kilo.ai/docs/getting-started/byok)                                                                                                                     |
| Kimchi         | 请求内部错误、结果未知；先诊断                             | kimchi setup 的厂商 Key，官方列有 Anthropic 与 OpenAI 选项。当前实际组合待验。 [官方](https://github.com/getkimchi/kimchi/blob/v1.3.0/README.md)                                                     |
| MiniMax Code   | 原模型未核。已找到现存目录的旧正文，只读                   | 官方文档的 CLI BYOK。当前登记的实用性待验。 [官方](https://github.com/MiniMax-AI/minimax-code/blob/main/README.md)                                                                                   |
| Mistral Vibe   | 原服务有真实结果，此前两次专项请求额度已用                 | Vibe 自家 API Key 或原生外部提供方配置。 [官方](https://docs.mistral.ai/vibe/code/cli/configuration-reference)                                                                                       |
| Nova           | 正式版明确要求认证；还有协议权限差异                       | nova setup 支持 Compass Key 等官方配置。当前 V1 兼容性独立核验。 [官方](https://github.com/Compass-Agentic-Platform/nova)                                                                            |
| OpenCode       | 原 Xiaomi MiMo 已实际使用                                  | Farfold 可直接设三类接口；也可继续使用 OpenCode 现有设置。 [Farfold 实现](../../../src-tauri/src/acp_client/service_config.rs)                                                                       |
| Pi             | 旧 402，原选择仍需核                                       | Pi 自家 /login、环境或模型配置；现 Farfold 沿用已有设置。 [官方](https://docs.pi.dev/latest/models)                                                                                                  |
| Poolside       | 旧有成功，最新真实请求内部错误                             | pool login 的厂商 Key 及原生模型路由。 [官方](https://docs.poolside.ai/get-started/log-in)                                                                                                           |
| Qoder CLI      | 原登记曾实答，另一版本的认证错误单列；默认历史查询本次为空 | 厂商 PAT 对应认证。CLI Custom 模型的 BYOK 受套餐及版本适用条件限制。 [官方](https://docs.qoder.com/cli/custom-models)                                                                                |
| Qwen Code      | 原模型选择可读，真实回复未确认                             | Qwen Code 的 /auth 与 modelProviders。 [官方](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)                                                                       |
| siGit Code     | 原服务来源未核，默认历史查询本次为空                       | 官方支持默认本地推理和自家 Cloud，未核到当前产品能接任意模型商 Key 的证据。 [官方](https://github.com/getsigit/sigit)                                                                                |

用户已授权使用现有旧对话。Farfold 的「带入已有对话」用默认范围此次找到 MiniMax 在现存目录的原正文。原配置未确认，未加入、未发送。Qoder 和 siGit 的默认官方列表为空。Devin 同原对象前次读取失败，Amp 当前接入缺厂商程序。后续沿现有历史定位样本。 [本批零发送回执](expanded-history-samples.json)

## 第 12 周期后续的第三方 API 核对

- **Claude Code** 可以走第三方模型网关。使用 Farfold 的现有入口时，网关须提供兼容的 Anthropic Messages 接口并接受 `x-api-key`。模型 ID 按网关要求填写，流式回复和工具调用还要用所选服务验证。 [Claude Code 网关](https://code.claude.com/docs/en/llm-gateway-connect) · [官方兼容要求](https://code.claude.com/docs/en/llm-gateway-protocol#api-formats) · [Farfold 交付接口](../../../src-tauri/src/acp_client/service_delivery.rs)
- **Gemini CLI 0.62.0** 能用 `GOOGLE_GEMINI_BASE_URL` 配 Gemini 协议网关，也能用 `GOOGLE_VERTEX_BASE_URL` 配 Vertex 协议网关。只有 OpenAI Chat Completions 或 Anthropic Messages 的服务要由网关做协议转换，当前 Farfold 统一入口没有为 Gemini CLI 传这两种配置。用户暂缓该家的登录验收。 [同版本官方配置](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/docs/reference/configuration.md#environment-variables)
- **Antigravity** 的独立 CLI 能配置 Gemini 兼容网关。当前 Farfold 登记的 ACP 1.2.1 要求客户端声明网关认证能力，现有 Farfold 握手未声明。Google 官方列出的可选非 Gemini 模型客户端也没有 Farfold，当前接入的该路径待开发和验证。用户暂缓该家的登录验收。 [独立 CLI 网关](https://antigravity.google/docs/cli/install/#point-the-cli-to-a-custom-endpoint) · [ACP 更新](https://antigravity.google/docs/changelog?tab=acp) · [ACP 模型范围](https://antigravity.google/docs/ide/extensions/acp#models-and-thinking-level)
- 本机只读盘点有一条现存统一 API，格式为 **Chat Completions**。当前三个支持集中配置的 Agent 中，只有 OpenCode 能直接套用该格式。Claude 与 Codex 分别需要 Messages 和 Responses 格式。盘点未读取 Keychain 或输出服务地址。
