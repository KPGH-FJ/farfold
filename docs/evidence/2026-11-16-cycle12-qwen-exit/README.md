# 首发范围与账号服务盘点

2026-11-16，macOS。按用户决定保留 Qoder CLI，将 Qwen Code 移出首发目录、新接入和整家验收。对齐目录规则、产品契约和当前验收表，剩余 26 家、208 个验收项。保留原登记、历史和可查证的旧验收表。[现行首发名单](../../agent-first-release.md) · [当前验收表](../2026-11-15-cycle12-continuation/acceptance-roster.json)

正式版「探索 Agent」显示 26 项，Qoder CLI 在目录和新对话选择器内可见。新对话选择器搜索 `Qwen Code` 返回零结果。更新前后 Qwen Code 与 Qoder 的 2 条登记、3 条对话索引完全一致。安装核对 236,586 项数据前后一致，独立元数据副本完整，重复候选已移除。前端及验收索引 71 项定向检查、Rust 发布版 22 项定向测试、Clippy、生产构建、文档检查通过。[实装回执](results.json)

## 用户能处理的条件

- **MiniMax Code。** 最新既有服务以 `MiniMax-M2.7` 发出的一条请求在上海时间 13:53:15 失败。厂商原记录 `50110` 表示余额或额度不足，零助手回复和用量记录。请在 MiniMax 官方入口核对当前中国区服务的可用额度。旧对话的原账号和计费来源仍未确定。官方新版提供自带 API，本机 0.2.7 的这条接法尚无实测。 [最新只读回执](results.json) · [此前旧会话回执](../2026-11-16-cycle12-original-config/results.json) · [MiniMax 官方设置](https://github.com/MiniMax-AI/minimax-code/blob/main/README.md#2-sign-in-or-bring-your-own-api-key)
- **Claude。** 继续验收可选 Claude 订阅或 Anthropic Console 账号，从 Farfold 的 Claude 管理设置进入官方登录终端。本机 0.107.0 包含官方登录程序。已有小米 Messages 服务仍保存，Farfold 托管 Claude 接法因凭据进入子进程参数已暂停。 [正式核验](../2026-11-16-cycle12-original-config/README.md#claude-环境核对) · [Claude 官方认证](https://code.claude.com/docs/en/authentication)
- **Antigravity 和 Gemini CLI。** 两家均曾明确要求认证，沿用用户暂缓安排。恢复测试时，个人 Google 账号可用 Antigravity 官方登录。Google 自 2026-06-18 停止 Gemini CLI 的个人订阅和免费 Code Assist 请求，企业许可证和付费 Gemini API 路线仍有官方支持。 [Antigravity 官方认证](https://antigravity.google/docs/ide/extensions/acp/#authentication) · [Google 迁移公告](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)

## 逐家只读核对

以下使用当前正式安装登记、已保存设置和最新可核实请求。程序、设置和握手的存在只说明可继续检查。盘点没有新发模型请求、读取密钥或变更登录。

| Agent          | 当前所见                                                                 | 本次需要用户操作                                   |
| -------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| Amp            | 旧适配曾要求认证。当前只见旧适配登记，未发现厂商原版 `amp`。             | 先核厂商程序及原线程，届时如需原账号再处理。       |
| Antigravity    | 已安装，正式设置曾要求认证。                                             | 暂缓。恢复时可登录 Google。                        |
| Autohand       | 已登录后用原 `fantail` 实答、冷开续答及文件交付。                        | 暂无。                                             |
| Claude         | 独立 Messages API 测试曾成功，官方适配真实发送要求认证，托管接法现暂停。 | 有官方账号时可用 Claude 订阅或 Console 官方登录。  |
| Cline          | 原账号重登后 Sonnet 5.5 正式短测成功。                                   | 暂无。                                             |
| CodeBuddy      | 有较早实答，当前登记在，现代版本接续仍需复验。                           | 暂无新的认证错误。                                 |
| Codex          | 已有设置及先前实答，有受影响请求的权限验证限制。                         | 当前无需 Responses Key。                           |
| Cursor         | 原 Auto 正式实答及旧对话续答。                                           | 暂无。                                             |
| Devin          | 原 SWE-2 Flash Medium 正式实答、冷开和续答。                             | 暂无。                                             |
| DimCode        | 会话创建内部错误，本机声明无认证方法。                                   | 先排查连接。                                       |
| Dirac          | 用所选免费模型实答、冷开。                                               | 暂无。                                             |
| Factory Droid  | 曾两次正式实发得到 `401`。当前同版没有新认证结果。                       | 先核原设置的 `/status`，确认再次要求认证时再登录。 |
| fast-agent     | 原服务已有实际任务和冷开续答。                                           | 暂无。                                             |
| Gemini CLI     | 已安装，正式设置曾要求认证。                                             | 暂缓。恢复时按企业或 Gemini API 的官方条件办理。   |
| GitHub Copilot | 有旧实答，当前安装版本仍需复验。                                         | 暂无新的认证错误。                                 |
| Goose          | 用已有 OpenRouter 服务实答和续答。                                       | 暂无。                                             |
| Grok Build     | 用户登录后沿原模型及推理档实答、续答。                                   | 暂无。                                             |
| Kilo           | 已有服务和匿名模型有实答。                                               | 暂无。                                             |
| Kimchi         | 已读设置，最新实际请求返回内部错误。                                     | 先定位错误。                                       |
| MiniMax Code   | 原对话与最新 M2.7 请求均有厂商额度不足错误，原账号未确认。               | 核对现有中国区服务可用额度。                       |
| Mistral Vibe   | 沿原 Medium 3.5 和 High 已实测。                                         | 暂无新增凭据动作。                                 |
| OpenCode       | 已保存的小米 Chat Completions 实答并冷开。                               | 暂无。                                             |
| Pi             | 沿用原 OpenRouter 设置实答并冷开。                                       | 暂无。                                             |
| Poolside       | 旧有实答，本期最新请求返回内部错误。                                     | 先定位错误。                                       |
| Qoder CLI      | 官方 Custom 的小米配置实答并从旧对话续答。                               | 暂无。                                             |
| siGit          | 已读到本地 Onde 选项，实际回复待证。                                     | 先验已有本地选项。                                 |

[逐家实测回执](../2026-11-15-cycle12-continuation/acceptance-roster.json) · [Amp 官方接入核对](../2026-11-15-official-alternatives/amp.md) · [Factory Droid 实测](../2026-10-24-agent-acceptance/droid-formal-e6e1-ack-summary.json) · [Factory 官方命令](https://docs.factory.com/droid-cli/cli-reference) · [siGit 官方说明](https://github.com/getsigit/sigit)

Farfold 的「设置 → API 配置」当前有两条有效保存项，格式分别为 Chat Completions 和 Messages，各含一个模型。当前源码在这里支持 OpenCode 的 Chat Completions、Responses、Messages 和 Codex 的 Responses。已存的两条格式可供 OpenCode 选用。Codex 若改用自带 API，需另有 Responses 服务，现有账号路径无需新增 Key。Qoder 使用厂商自己的 Custom 配置。[Farfold 接入能力](../../../src-tauri/src/acp_client/service_config.rs) · [Qoder 正式实测](../2026-11-15-cycle12-pre-send/qoder-history-cline-smoke-2026-11-16.json)
