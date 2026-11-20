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
