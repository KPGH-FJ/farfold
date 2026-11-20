# 第 12 周期 S1–S2 首轮逐家实测

2026-11-20，北京时间。macOS arm64 正式 Farfold `72e971df5`（0.1.7），应用标识 `ai.farfold.desktop`，CDHash `5bf21663b6f7caa4e341c9ebc4476d60bb4e299c`。范围为首发 21 家。「探索 Agent」本次显示官方目录刷新失败，仍提供 13:40 的缓存目录和本机已登记程序。界面 22 条包含自定义的 CodeBuddy Hy4 测试登记，首发实测按 21 家标准目录。

## 一套测试怎么跑

1. 从正式版进入选定 Agent 的设置，检查已选程序和版本。
2. 在「账号与服务」核选择页。界面应让用户区分账号认证、已有设置、Agent 自己的 API 配置和 Farfold 保存的模型 API。对照同版本声明及厂商说明，记录当前显示的方式和要求。
3. 从正常新对话入口进入独立测试目录，确认该 Agent、已批准的来源和模型。需要时核原草稿返回和输入保持。
4. 只按已批准设置发送本轮独有短标记。核回复、结束回执、实际服务及原对话归属。
5. 依适用范围覆盖取消、失败、恢复，以及获准测试身份的退出、换号和密钥变更。只按已明确授权的范围使用现有账号和服务。

每家在第一个确认的问题或必要条件缺失处暂停，记录实际到达的步骤，然后测下一家。界面方式可用、真实首答通过和适用流程全部通过分别有证。厂商说明或已有证据只覆盖各自的实际场景。Gemini CLI 与 Antigravity 本轮检查程序和方式页，实际授权继续按暂缓安排。

官方入口、Agent 自有 API 与 Farfold 已存 API 的逐家核对见[官方接入附表](official-inventory.md)。

## 首轮逐家停点

21 家均从正式界面到达账号与服务页。按本轮第一停点统计，15 家触到明确问题，3 家到达后缺必要证据或保护条件，2 家按暂缓只核入口，1 家通过已配 API 的主链。整套 S1–S2 的适用分支尚无一家完整通过。表中方式数按本轮可见的选择卡计，包含「已有设置」和明确标注的禁用项。同一个官方账号可能有多个授权入口。

| Agent          | 正式页显示的接法                                                            | 第一停点与本轮结论                                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amp            | 2 项。已有设置、Amp API Key Setup。                                         | 方式说明未通过。「终端登录」的主选项实际上设置 Amp 适配的密钥。展开「管理接入 → 更多登录选项 → 手动配置登录」只得到执行文件和参数空表单，未给出当前版本对用户可用的官方账号登录路线。原 MiMo 已有设置和这两条来源的关系也未交代。 |
| Antigravity    | 5 项。已有设置、Google、Gemini Enterprise、Gemini API key、Agent Platform。 | 暂缓实际授权。已连接并读到选项。其中密钥及云服务授权与两个账号入口在「账号登录」同组。                                                                                                                                            |
| Autohand       | 2 项。已有设置、Set up Autohand Code。                                      | 方式说明未通过。页面只给一个终端设置入口，说明「Configure authentication and a model」，未说明原账号与官方自定义提供方分别如何使用。                                                                                              |
| Claude         | 3 项。已有设置、Claude Subscription、Anthropic Console。                    | 方式说明未通过。两种官方账号路线可见。原 Claude Code 兼容 Messages 已实答，界面只有通用的「已有设置」，未给到第三方 Messages 的官方配置指引和 Farfold 当前托管不可用的区别。                                                      |
| Cline          | 5 项。已有设置、Cline、ClinePass、ChatGPT Subscription、模型服务。          | 方式说明未通过。选择「模型服务」后，只显示「在终端中完成设置」及「继续」，未说明这是 Agent 自己的提供方和密钥配置。实际 OAuth 和终端动作未触发，临时选择已放弃。                                                                  |
| CodeBuddy      | 5 项。已有设置、iOA、Google/Github、WeChat、Enterprise Domain。             | 原设置开工未通过。正常新对话到本轮独立目录后，模型页明确提示「创建会话失败：设置尚未确认，请检查后重试。已保存的选择当前不可用。」未换模型或发送。                                                                                |
| Codex          | 5 项。已有设置、ChatGPT、ChatGPT 设备码、API Key、模型 API 服务。           | 受发送保护限制。正常新对话读到已选 6 Astra，工作目录准确。权限页提示「当前完整权限尚无法确认，部分命令暂不能发送」。沿原 NEW-24 保护，未发请求。                                                                                  |
| Cursor         | 2 项。已有设置、Cursor Login。                                              | 首答完成。用原设置 Auto 从本轮独立目录发一次并得到准确结果。厂商原件记录实际使用 Cursor 的 `cursor-grok-4.5-high`。到账号与用量归属仍缺本次实际身份依据。                                                                         |
| Devin          | 3 项。已有设置、浏览器登录、终端登录。                                      | 原设置开工未通过。正常新对话选择独立目录后，模型页提示「创建会话失败：设置尚未确认，请检查后重试。已保存的选择当前不可用。」未换模型或发送。                                                                                      |
| Dirac          | 1 项。已有设置。                                                            | 方式说明未通过。正式页只显示「已有设置」，未说明可在官方 `dirac auth` 选择提供方或配置自有 API 后返回复用。                                                                                                                       |
| fast-agent     | 2 项。已有设置、Configure fast-agent。                                      | 方式说明未通过。界面把要求在外部文件或环境中配置提供方密钥的说明归在「账号登录」。厂商当前实现接收该认证方法只确认调用，不完成提供方配置。                                                                                        |
| Gemini CLI     | 5 项。已有设置、Google、Gemini API key（禁用）、Vertex AI、AI API Gateway。 | 暂缓实际授权。本机方式页明确禁用 Gemini API key，界面将 Vertex/Gateway 也列在「账号登录」。未启动外部登录、设置或模型。                                                                                                           |
| GitHub Copilot | 2 项。已有设置、Log in with Copilot CLI。                                   | 方式说明未通过。GitHub 登录有正式终端入口。厂商正式支持的 CLI 自带模型 API 及其在当前登记的复用条件未交代，当前没有 Farfold 集中 API。                                                                                            |
| Goose          | 2 项。已有设置、Configure Provider。                                        | 方式说明未通过。选 Configure Provider，原说明要求运行 `goose configure` 配提供方和密钥，按钮却是「登录 Configure Provider」。未按该登录按钮。已放弃本次临时选择。                                                                 |
| Grok Build     | 3 项。已有设置、cached_token、Grok。                                        | 方式说明未通过。原令牌复用同时落在「已有设置」和账号登录下的 `cached_token`，只给本地文件提示。用户难以区分缓存复用、官方新登录和厂商 API。没有打开指定原对话。                                                                   |
| Kilo           | 2 项。已有设置、Login with Kilo。                                           | 方式说明未通过。正式页能识别 `kilo auth login` 的终端路径，未交代 Gateway 或自有提供方配置后如何沿用。                                                                                                                            |
| MiniMax        | 2 项。已有设置、Sign in to MiniMax Code。                                   | 方式说明未通过。当前 Kilo 等共用入口已列出账号登录；MiniMax 页未说可先按官方 CLI 配第三方 API，再回 Farfold 沿用。用户已经配置小米的正例仍成立。                                                                                  |
| Mistral Vibe   | 3 项。已有设置、AI Studio 登录、Register your API Key。                     | 首答完成。独立新对话用原 Medium 3.5／High 一次实答。记录中的服务为 `configured`，本次使用哪份账号凭据以及归属仍待确证。未打开未结束的旧断线样本。                                                                                 |
| OpenCode       | 3 项。已有设置、Login with opencode、模型 API 服务。                        | 已配 API 主链通过。草稿中切到 Farfold 已存 Xiaomi 和对应 MiMo，原文字与目录保留。厂商原件匹配实际所选的 Xiaomi API 来源并正常结束。新账号或独立测试密钥的变更条件仍待。                                                           |
| Pi             | 2 项。已有设置、Launch pi in the terminal。                                 | 原设置开工未通过。正常新对话到独立目录后，模型页提示「Agent 当前未提供某项已保存设置」，无可发送模型。未改设置或发送。                                                                                                            |
| Qoder CLI      | 2 项。已有设置、Login with qodercli。                                       | 方式说明未通过。可运行官方登录终端，未交代当前账号可在 Qoder CLI 的 `/model → Custom` 配哪些自有服务及如何回来沿用。官方第三方配置和原 MiMo 正例继续保留。                                                                        |

页面里的 `codebuddy · 未在运行` 等字幕显示所选工作文件夹和任务状态。不同 Agent 共用原工作目录时，选择器仍能准确标出选中的 Agent。本轮新对话的独立目录在实际准备和发送前从系统面板确认。

## 三条实际回复

- **OpenCode。** 本轮 `FF_C12_S1S2_OPENCODE_20261120`，原 ID `ses_e081d83beffeM05sp4sDdnXHg0`。在独立目录从草稿搜索 Xiaomi，从「你保存的 API 服务」选择 Xiaomi／`mimo-v2.6-flash`。十五时三十六分只发送一次，原样答复并完成。Farfold 配置落盘为 Xiaomi Chat Completions，与官方原记录此次的服务身份及模型完全匹配。原助手记录的结束原因为 `stop`。协议 `protocol-v1-1795160177312-42.jsonl` 前 15 行 SHA-256 `5fe8debf429f887d8002c8332f296bbf5e4fb8fc4134e6af1a05c4da47208f3d`，第 11 行唯一请求。
- **Mistral Vibe。** 本轮 `FF_C12_S1S2_MISTRAL_20261120`，原 ID `99b09f28-f8bb-4567-b01c-c2225003639a`。原 Medium 3.5／High 一次实答、完成。官方作用记录标 `configured`，可归到本次请求，未返回实际账号凭据或扣费来源。协议 `protocol-v1-1795160331988-44.jsonl` 前 34 行 SHA-256 `c6d67b91cc71b70f574426fdf5bda8c35b510aa03646c9f2efb6e58667cf85a7`，第 14 行唯一出站。原厂商 `journal/0000000000000005.jsonl` SHA-256 `a273bc0160915193fca45ba93ab7f76ac6cb9d28c6b0280bbf33e71162e861b5`。
- **Cursor。** 本轮 `FF_C12_S1S2_CURSOR_20261120`，原 ID `5c7acd4d-c7fc-48b9-8e82-3a6d4db738e2`。原 Auto 一次实答、完成。原助手记录准确答复，实际模型字段为 `cursor-grok-4.5-high`。账号和费用字段未确认。协议 `protocol-v1-1795160589524-48.jsonl` 前 34 行 SHA-256 `17a7dbd7eadd2a0fd16f9aec33396943539763f33cc2625dab2d73e5c4b61cdf`，第 11 行唯一出站。

首轮结束时应用回到「探索 Agent」。密钥和现有账号设置均由用户此前配置，期间没有真实换号、轮换或扩大权限。依据各家第一停点进入后续修复批次。

后续结果见[修复与正式复验](repair-retest.md)。首轮结论保留当时实际停点。
