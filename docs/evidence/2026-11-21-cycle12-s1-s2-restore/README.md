# 第 12 周期 S1–S2 配置保持与已有授权复查

2026-11-21，北京时间。macOS arm64 正式 Farfold 0.1.7，初始安装 CDHash `22836e0711b6551614434f8d0f5c16939205a227`。测试均从正常入口使用自建目录 `/private/tmp/ff-s12-live.4f3AQKqN`，只使用指定已有模型配置。

## OpenCode 与 Copilot 共用 Messages

OpenCode 从新对话选择已存「Xiaomi anthropic」，同一条配置先前在 Copilot 原 ID `4764561c-c160-4efb-be2f-68ece21b1bbc` 有厂商确认的实际 BYOK 回复。OpenCode 独立新对话 `ses_e06470668ffed1KN9m6e2whqp8` 一次准确回复 `FF_S12_OPENCODE_MESSAGES_20261121_A`。两条落盘记录的服务 ID、指纹与 `mimo-v2.6-flash` 完全一致，未重新填 Key。OpenCode 协议 `protocol-v1-1795191011290-3.jsonl` L11 发送、L32 正常结果，前 32 行 SHA-256 `9348182cdb342da270db72b968e0866352a2decc40e5089a3837c9fb815e2889`。独立账单未核。

Farfold 正常退出，确认应用进程均已关闭。重新打开后，依次从侧栏冷开 Copilot Messages、Copilot Chat Completions、OpenCode Messages。三条打开原问答，分别显示原服务「Xiaomi anthropic」「Xiaomi」「Xiaomi anthropic」与原 MiMo 模型。各协议 `protocol-v1-1795191467887-1.jsonl`、`protocol-v1-1795191524196-2.jsonl`、`protocol-v1-1795191548610-3.jsonl` 各只有一次原对话读取，零新模型发送。此前两种格式的真实用量及同服务证据仍分别适用。[前一批回执](../2026-11-20-cycle12-s1-s2-followup/README.md)

## Goose 取消后的实际恢复

Goose 1.59.1 原自建草稿用官方 `goose configure`，无输入取消，返回原稿点「检查已有设置」，读回不同默认模型，发送保护生效。经模型页明确选回 `Nemotron 3.5 Super VL (free)` 与 Off，原稿恢复可继续。正常保存退出，冷开同一草稿仍显示原文字、工作目录、免费模型以及 Off。将自建标记换成短问，只手动发送一次并显示准确回复、正常完成。无自动发送。

原会话 `20261120_17`。协议 `protocol-v1-1795191386432-0.jsonl` L16 唯一出站、L46 正常结果，前 46 行 SHA-256 `a96ef519c4a4f41e9d2b0feab5d88c2117eb7c547a742c1c1ae49b7461a4cef3`。Goose 自有同 ID 会话数据库确认提供方 `openrouter`，模型 `nvidia/nemotron-3.5-super-vl:free`，模型配置原字段 SHA-256 `d95ffe764073a1cf10cb06dc0c8620d8d29f00336e64db118521ea6cb20d8369`。范围限此前已保存的免费模型和恢复分支。

## 统一 API 新候选的边界

- Kilo 7.8.1。在限制外网、只放行合成服务和程序自身回环入口的独立临时环境，官方临时配置已完成首答和同原 ID 冷续答。冷开零自动请求。一次合成 401 返回结构化 `-32603` 和 `APIError`。有一次额外的同地址、同模型标题生成。组织和设备管理配置会在临时配置之后合并，当前没有实际服务地址的证明，保持只有官方设置。在核验的临时文件与诊断中未发现合成密钥。[官方配置顺序](https://kilo.ai/docs/contributing/architecture/cli-runtime#config-precedence)
- Dirac 0.6.0。官方自定义地址参数与环境密钥、仅使用环境两条合成路径均实答且同 ID 冷开续答。首次成功后两条路径均把合成密钥写到临时的 `globalState.json` 的提供方配置。保持现有用户自配路径，统一配置等待官方不持久化选项。未交付真实密钥、未改变用户配置。[官方自定义 API](https://dirac.run/docs/cli#custom-openai-compatible-providers)
- Cline 3.0.74。官方 CLI 可自配服务，ACP 启动的模型选择受其目录限制，自定义地址未通过该入口交付。现有统一 API 仍待合适的官方方式。[对应版本源码](https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/acpAgent.ts#L714-L780)

## Cline 已有授权复用反馈

本轮用已有归属打开 Cline 原草稿的「Sign in with Cline」。官方 `authenticate` 发出并完成，未出现需要用户操作的 OAuth 页，保持已有凭据。官方 [对应版本认证代码](https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/auth.ts#L72-L96) 会先复用已保存凭据。原版错误地回到方式列表，仍显示同一个「登录」按钮。协议 `protocol-v1-1795191688844-6.jsonl` L9 唯一认证、L11 响应，前 11 行 SHA-256 `fe6f14204beb59eed353aee3e7575f46f3095906b0e58e11f5fd1c5483595f16`。随后取消选择并返回原草稿，未调用模型。

首次候选已显示授权回执，但仍未给下一步。最终修复让已明确启动的官方认证保留在同一账号步骤，只有原作用范围的连接检查已完成才可继续模型页。正式 CDHash `3eb75596a03f24d047c35e02e8a7497a3a6b26b1`，程序 SHA-256 `75ad81ca2b6184e3538d0b266f3c44526b1949dcc28b9b59a636d1b426154d0a`。换装正常退出并核合 264,505 项元信息及 6 份关键摘要。11,079 项前端测试及类型检查通过。

最终从同一草稿只点一次官方方法。界面显示「Agent 已接受授权操作」及「继续选择模型」。授权 `protocol-v1-1795192933829-1.jsonl` L9/L11，前 11 行 SHA-256 `366adaad183760cc99126f9975e2faa884e7e43b587d35547922e395e3159102`。连接后官方默认模型变成 Sonnet 5.5，界面保留原免费模型并暂停发送；手动选回原 Nemotron 3.5 Super VL (free)，回到同一草稿、目录和来源，随后只发送一次准确回复 `FF_S12_CLINE_AUTH_READY_20261121_A`。新原 ID `1795193067959_EDIZG_cli`，协议 `protocol-v1-1795193067663-3.jsonl` L14/L22，前 22 行 SHA-256 `0ab7a8184c8de12783530af79bf9ce5226adf78279a16007a449ac69f767457b`。此为已有授权复用，首次浏览器授权、取消及账号切换待实际新账号条件。

## Responses 同服务跨家实答

正式 CDHash `3eb75596a03f24d047c35e02e8a7497a3a6b26b1`。用户新保存的「Atria」服务格式为 Responses，模型 `Atria-Dawn`。设置页同一服务卡列出 OpenCode、Codex 和 GitHub Copilot。按用户指定，只从 OpenCode 和 GitHub Copilot 的正常新对话各选择该服务并手动各发一次短测。两条 Farfold 原对话验证服务 ID、由地址与接口格式产生的指纹、模型均一致。验证全程未读取密钥。

| Agent          | 原 ID                                  | 原始证据                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenCode       | `ses_e06166d25ffebF4LhQIJEFrlKW`       | `protocol-v1-1795194195928-5.jsonl` L11 唯一出站、L34 正常返回。前 34 行 SHA-256 `a6c36eadecda27beaa3f983a3c8711001006d35080a70290e65d4fc2bfa56652`。厂商数据库 `session_message` seq 5 实际模型 `Atria-Dawn`，提供方标识与同一服务身份派生值核合，准确回复 `FF_S12_OC_RESPONSES_20261121`，`finish=stop`。assistant 原字段 SHA-256 `6aa6b4715c11a8a62de84503175f3111261f734f5b92d5553fb6a3a56b06de5f`。                                   |
| GitHub Copilot | `5c9fa44b-a6ec-4cca-9ca1-9bb9f0caf52c` | `protocol-v1-1795194310790-7.jsonl` L13 唯一出站、L21 正常返回。前 21 行 SHA-256 `b72fec286f8e854da49e6bcea051ac07956947c1657bf73935b1ab386895670a`。厂商事件 L7 `apiEndpoint:/responses`、`isByok:true`、`byokKind:remote_user`、`model/responseModel:Atria-Dawn`、`finishReason:stop`、零工具。L8 准确回复 `FF_S12_CP_RESPONSES_20261121`，L9 结束，前 9 行 SHA-256 `9bd28d8305888a233a02904bf866495527e9dabe024f8f792773bcb69f860978`。 |

本证据补齐这两家在 Responses 上的一份配置两家实答。前序 Chat Completions、Messages 各有独立的同服务样本。独立账单未核。Codex 继续保留原发送保护，未为此次试用选择此配置或发送。Gemini CLI 和 Antigravity 仍按用户安排暂缓。

## Amp 登录指引返回

Amp 0.13.0 当前登记使用用户选定的本机 Amp CLI。正式版账号与服务页单列「在 Amp 登录账号」的官方指引、Amp 适配器自己的 API Key Setup 以及厂商设置模型服务的链接。打开官方登录说明后，在同页使用「检查已有设置」，实际显示「连接已重新检查」，身份字段仍显示未提供。继续选模型后，界面保留原 MiMo 选择并提示程序返回了默认模型。直接选回原 `mimo-v2.6-flash`，从准备页回到原文字、独立目录和可用发送按钮。此分项零模型请求、零账号或密钥变更。新的网页登录、取消及换号仍待可测试账号。当前内嵌的独立账号登录要求匹配已审适配器及同登记受管理官方 CLI；此安装保留已选的外部 CLI 并走官方指引。[Amp 官方账户说明](https://ampcode.com/docs/cli#manage-cli-accounts)

## Devin 免费账号可用模型首答

用户确认原 Devin Pro 已到期、同一账号仍有免费额度，并批准独立草稿只测一次。官方价格页确认 Free 含有限额度与受限模型目录，超出付费计划额度的购买另列。正式 CDHash `3eb75596a03f24d047c35e02e8a7497a3a6b26b1` 从普通新对话核对旧 `swe-2-high / High` 不可用，在独立草稿明确采用 `SWE-2 Flash Medium`，保留 Agent 已有来源。已保存的原选择保持。未续费或购买额外额度。 [Devin 官方价格说明](https://devin.ai/pricing#frequently-asked-questions)

本次独立原 ID `adorable-swing`。一次手动发送后返还准确标记 `FF_S12_DEVIN_FREE_20261121_A`，界面显示「已完成」。官方本地会话存储为同一 ID、同一目录、`windsurf` 提供方和实际模型 `swe-2-flash-medium`，助手原字段 SHA-256 `2d8c9142da83ece9e7666323052fe47bc5e30ef0fcfe1bb9073950d919fcf50e`，零工具。协议 `protocol-v1-1795195225669-17.jsonl` L199 唯一发送、L243 正常结果，前 243 行 SHA-256 `2c57488c7dd1d964b254223fc9eb8c1cbabff39e2531e280116a4289e526ef23`。独立扣费明细未核。本轮首答累计 16 家。旧付费模型和思考档仍列为不可用。

## 一键恢复原模型

新版只在已确认服务保持、原模型仍可选、其他已存选择均与当前选择一致时显示「恢复原模型」。实际读回相同才可继续。旧模型下架或思考档等一起变化的情况仍需明确核对；受控回归同时覆盖过期读取和只恢复选项而不发送、不保存默认值。

正式 CDHash `5433c51d240b6ca185c09b63e0eb8f90decc70af`，主程序 SHA-256 `3625ccfb88afb76638575d7e13c6c27dbc116349c707254f66124fc395d1ffc1`。正常退出换装，核合 264,505 项数据元信息与 6 份关键摘要。前端 11,083 项、类型检查与正式打包均通过。

从独立 Amp 草稿选「模型与来源 → 准备与连接」。当前报告 `Default`，原选择为 `mimo-v2.6-flash`，此时「使用此 Agent」禁用。点一次「恢复原模型」，Amp 实际读回原 MiMo，继续按钮恢复。返回同一草稿，原文字、工作目录及可用发送按钮保持。设置协议 `protocol-v1-1795196436344-4.jsonl` L12 唯一配置请求、L14 正常响应，前 14 行 SHA-256 `8f9fad04b23233212583823ef440e6ace59b1591f8c1eae8639f79c1abca0553`。新草稿入口按原选择准备，无模型发送。管理入口同时存在旧模式等差异时只提供明确采用当前设置。

## Responses 原对话冷开

在上述更新后的正式版依次从侧栏打开刚才的 Copilot 和 OpenCode 两条 Atria 测试对话。均读回原问答并继续显示原服务「Atria」及 `Atria-Dawn`。Copilot `protocol-v1-1795196542871-6.jsonl` L8/L13，前 14 行 SHA-256 `e0625002323bd88dc73dd88dee95bebf3dbf000c2f3dffaabcd81d29cb7c1d9c`。OpenCode `protocol-v1-1795196625256-7.jsonl` L8/L12，前 13 行 SHA-256 `6d3515f4c035b12767f5cad76ee528ad8b73de71da47b542490b51a170dba367`。每条只读取一次原对话，零模型发送。
