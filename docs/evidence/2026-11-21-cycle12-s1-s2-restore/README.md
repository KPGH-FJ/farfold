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

## Grok Build 与 fast-agent 首答

本轮按现选正式版和已有配置，分别从独立空目录新建一条对话，各手动发送一次纯文字，均准确回复并显示「已完成」。未打开原 Grok 交付对话，原 12 份文件重新核对无变化。原首次带入的 fast-agent 对话未开、未发。账号或具体计费归属没有新的独立回执。

| Agent             | 原 ID                                  | 实测与回执                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grok Build 1.0.90 | `01a1fa2a-5488-7330-b83c-84f1fa8814c7` | 独立目录 `/private/tmp/ff-s12-grok-first.iR0LfRyj`，现有设置下的 Grok 4.7 / Low。原厂商助手第 6 行精确回复 `FF_S12_GROK_FIRST_20261121_A`，实际 `model_id:grok-4.7`、`reasoning_effort:low`，该行原字段 SHA-256 `281abe1c8f58182c04756708e4fe270fd3a6be4dd088659d21b093ebfad64332`。协议 `protocol-v1-1795198437970-10.jsonl` L35/L94，前 94 行 SHA-256 `09c609280f6c468269b7e780832f0b045abbb0da6bda056349da9e09cc14b482`。 |
| fast-agent 0.10.1 | `2611210216-7vTKXu`                    | 独立目录 `/private/tmp/ff-s12-fast-first.cSJ3Rv5N`，沿原 `codexplan`。厂商 `session.json` 显示 `codexresponses / gpt-5.6-sol`，`history_agent.json` 记录一问一答，最终为 `endTurn`，SHA-256 `afc50a3b568a15511cffccb9c679fcd4a511eeea82ebe350021459e2e78dcbb0`。协议 `protocol-v1-1795198601898-12.jsonl` L12/L25，前 25 行 SHA-256 `4711bc41449d2725392f9fd33066a7b0d6eeb475160b86d4a24b1bfc09c443ad`。                     |

同批 Codex 先完成独立草稿准备，后经用户明确批准只发一次，见下方[单次短测](#codex-单次首答与实际权限)。旧对话与依赖完整实际权限的命令照原条件。[原暂停说明](../2026-10-09-capability-hardening/README.md) · [官方模式与回执复核](../2026-11-19-cycle12-official-route-recheck/README.md#codex-的-new-24-发送保护)

## 官方终端返回及恢复

新版正式 CDHash `aaa074f4e3a6265d7dc6e8a25de7809c92a4fb2c`，主程序 SHA-256 `4de1cc45a90e764b80cded7cf398f61cce4f945b439d27246cdae5fe5545d636`。正常保存退出换装，核合 264,505 项元信息及 6 份关键摘要。Rust 2,848 个单元及 10 个集成测试通过，11 项忽略，格式、Clippy 和正式打包通过。

在同一自建空目录 `/private/tmp/ff-s12-recovery.ic8OATxG` 用未发标记逐家启动官方终端。均未输入、未完成新的授权、未发模型请求。返回后逐家核对原文字、目录及发送入口。实际登录与身份不能从终端成功退出推定。

| Agent        | 实际入口                                                                      | 观察                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| fast-agent   | 新增同安装的 `fast-agent-acp auth provider login codex`，和官方外配指导分列。 | 正式终端进程确为原登记，点取消后该 PID 退出。返回同一草稿后提示重新读取。手动重读并继续后发送按钮恢复，没有自动发送。仍需真实新授权及所采用凭据来源。 |
| Autohand     | Set up Autohand Code                                                          | 终端很快自行返回，页面显示「设置已检查」。继续读取并回同一草稿，已有设置下原 `fantail` 和发送按钮可用。未到待用户登录状态，本次没有取消证据。         |
| Mistral Vibe | Register your API Key                                                         | 终端进入等待，取消显示「已取消此次操作，账号设置是否改变仍需检查」。原稿、目录、已有设置及发送入口保持。AI Studio 登录另验。                          |
| Pi           | Launch pi in the terminal                                                     | 官方终端已启动，未输入即取消。原稿、目录及发送入口保持；提供方登录或 Key 写入分别待验。                                                               |
| Qoder CLI    | Login with qodercli                                                           | 官方终端显示待账号设置，未输入即取消。原稿、目录及发送入口保持。当前 Custom MiMo 及旧 Auto 不可用条件沿既有证据。                                     |
| Kilo         | Login with Kilo                                                               | 官方终端显示待账号设置，未输入即取消。原稿、目录及发送入口保持。免费 Gateway 已有首答，账号权益及其他来源分别待验。                                   |

[fast-agent 官方 OAuth](https://fast-agent.ai/models/providers/openai/)

## 换源取消与服务测试失败恢复

OpenCode、GitHub Copilot 从同一自建目录各用未发草稿选择已存 `Atria / Atria-Dawn`。从正常「准备与连接 → 账号与服务 → 管理接入 → 更换服务」临时选已存 Xiaomi anthropic，均在继续前「暂时返回」并放弃。两条均回到原草稿、目录、Atria 和可用发送按钮，零模型请求。两份 API 配置均未编辑。

另从设置新建未保存的 API 样本，只使用自建回环地址与假密钥。未监听端口报「无法连接模型服务，请检查网络、证书和基础地址」。换地址后系统清空旧输入并要求重新填密钥，短测和保存按钮在补填前禁用。临时监听不回复 TLS 握手，界面按实际结果显示「连接或响应超时」。第二个独立慢样本在测试进行中点取消，界面显示「已取消本次检查」，回环连接约 0.74 秒关闭。放弃未保存配置后，样本未入设置，正常入口仍回原 Copilot 测试草稿、Atria 和可用发送。此为正式界面的合成服务失败、超时与取消，未消耗模型请求，也不充当任何 Agent 的真实认证失效回执。

## Cursor 打开超时后的账号恢复

正式版在独立草稿触发的一次 Cursor `session/new` 超过 120 秒，126.081 秒才有正常回包。协议 `protocol-v1-1795201688837-28.jsonl` L8/L10，L11 还有迟到的会话更新。随后从草稿打开官方 Cursor Login 时，界面显示「请先完成此 Agent 的任务、待处理事项及账号操作」。第二份协议 `protocol-v1-1795201886718-29.jsonl` 只有握手，无 `authenticate`。保护源于此前未确认打开，未观察到 Cursor 拒绝凭据。返回时原草稿、目录和可用发送保持。

从正常界面保存并退出。重新打开后，直接从「设置 → Agent 与账号 → Cursor」检查程序、执行一次原 Cursor Login，界面显示「Agent 已接受授权操作」并可继续，实际读回 Auto。协议 `protocol-v1-1795202231236-0.jsonl` L8 唯一认证、L9 正常回包，前 9 行 SHA-256 `7ae545de9553f80af9175e89d33fe93d660f0c8706016ee74eb81dd179501156`。此轮无新的授权输入和模型发送，厂商未返回账号身份。

Farfold 已细分这类错误。没有活动任务或其他操作，但保留了未确认打开时，提示先保存并正常重开，再继续账号设置。原账号保护持续有效。受控回归覆盖真实活动保留原提示、晚打开持续阻止变更、原进程结束后释放。新版正式 CDHash `266728f08c6bc865ee5b95d7d3181e3a303ff731`，可执行文件 SHA-256 `4688f1a3cdd41733d77f4ac2ce177042472ed3bacc5143ef9b3331837babf98a`，停机核合 264,507 项元信息及 6 份关键摘要。

新版回归中 Rust 2,849 项单元与 10 项集成通过，11 项忽略，Clippy、格式和正式打包通过。正式从独立草稿再次新建 Cursor，本次成功且发送可用，未重现迟到。协议 `protocol-v1-1795202456450-0.jsonl` L8/L9，前 10 行 SHA-256 `254ff2dd08c63294d771513ff09c25b7428d79e609092c6337cd8111467e02b9`，零模型发送。新提示的精确分支已由受控回归直接核验。

## Codex 单次首答与实际权限

用户批准从独立草稿选择当前界面最收紧的「Ask for approval」，沿原模型来源和设置发送一条不带附件、不调用工具的纯文字。正式 Farfold CDHash `266728f08c6bc865ee5b95d7d3181e3a303ff731`，登记 Codex ACP 1.13.1，在 `/private/tmp/ff-s12-codex-first.9pfc4wui` 新开 `01a1fa6a-7990-72a2-81a1-c4a64b9e79e6`。Farfold 只对这份草稿明确确认下次消息权限，未切换到已存 Atria 或改变其他对话。确切回复 `FF_S12_CODEX_FIRST_20261121_A` 并正常结束。协议 `protocol-v1-1795202641198-2.jsonl` L16/L17 设置回执，L18 唯一出站，L35 正常结果，前 35 行 SHA-256 `14f9e1d86cd2527f9cacc8c7e24b4fa6a74a1cbbcfcae27a4ac3464d969d95ab`。

厂商原卷首 15 行 SHA-256 `bf926cf55fa9cd68e40828cf8749ce0907fa527e2d5c28ffa2bb89a372045adc`。L1 实际 CLI 0.155.1，模型商字段 `openai`。原请求 `01a1fe63-c6f8-76f1-809e-6b2e851f323f` 的 L8 显示 `gpt-6-astra / ultra`、`on-request / user`、`workspace-write` 和 `network_access:false`。L9 原提问，L12 为准确回复，L15 正常结束。全程零工具调用、零审批。实际计费账号或凭据来源未回报。

首答有证。实际文件权限仍允许写入测试目录，未达到严格只读。实装和官方 1.13.1 源码均将标识 `read-only` 映射到 `workspaceWrite`，确认回执本身不能证明实际文件范围。官方 2.0.0 恢复单独只读预设，2.7.0 另有分组模式选项。已使用本次单次发送授权，后续真实发送需新授权。原作品、旧对话恢复、实际完整权限及受 NEW-24 影响的命令按原条件继续。[旧版预设](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/AgentMode.ts#L38-L53) · [厂商修复](https://github.com/agentclientprotocol/codex-acp/commit/7fee150a55098f7140a03907fec5f11) · [2.7.0 预设](https://github.com/agentclientprotocol/codex-acp/blob/v2.7.0/src/AgentMode.ts#L49-L65)

Farfold 补上官方新版分组权限选项的兼容。原扁平选项保持。重复、混合、缺失的分组和值仍拒绝，旧对话仍需重新确认；当前实际权限继续由证据判定。两组定向测试均通过，覆盖官方分组、回执不符和原命令保护。Rust 全量初次一项未通过，复跑 2,851 项单元和 10 项集成通过，11 项忽略。Clippy、格式和打包通过。新版正式 CDHash `14c2fc84eabf003471fba7c5f84e48d1b7b0e06f`、可执行文件 SHA-256 `ca6bbd998e8eaaedf06567ebf2b5d3007ba3445b4b531f217cefbfbeef5b2d8a`，停机核合 264,507 项元信息与 6 份关键摘要。应用重开，单次实答记录保留。新版 Codex Agent 的实际只读和权限恢复仍待单独复验。
