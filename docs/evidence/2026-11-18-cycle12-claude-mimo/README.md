# 第 12 周期 Claude Code 小米 MiMo 首答与冷开续答

2026-11-18，macOS arm64，正式 Farfold `98d365c08`（0.1.7，CDHash `a373426cac1c3553e6b772ffaf423f1bed7303c6`）。正式登记与握手版本均为 Claude Agent ACP 0.107.0，本次原会话记录为 Claude Code 2.1.323。用户在 Claude Code 本机配置小米按量 Messages 地址 `https://api.xiaomimimo.com/anthropic` 及 `mimo-v2.6-flash`。

## 从 Farfold 发送

从「新对话」选择 Claude Agent，在独立空目录使用「已有设置」。发送前界面列出配置的 MiMo，包括选中的 `mimo-v2.6-flash (haiku)` 模型别名。本次未打开 Claude 登录流程。

在 17:51:58 只发送一条无附件、无需工具的短测试，标记 `FF_C12_CLAUDE_MIMO_1752`。本机正式协议记录中恰有一个 `session/prompt`。17:52:10 收到精确标记，Farfold 显示「已完成」。Claude Code 隔离测试目录中的原对话 `3baad729-4a3e-485c-b7fc-ac4d1ea82379` 同时记录相同用户标记及回复，最终助手事件的模型为 `mimo-v2.6-flash`。

## 小米侧核对

以同一把用户已配置的 Key 调用小米官方只读日用量接口，日期为 UTC 2026-11-18。发送前，该 Key 的脱敏标识没有 `mimo-v2.6-flash` 在线用量。17:52:57 查询时记录仍未出现。17:53:52 再查，同一脱敏标识新增 2 次在线推理、13,018 Token，用量金额为 ¥0.011141。同模型另一标识的 32 次在线推理与 22,754,134 Token 在两次发送后查询中一致。只发送一条用户消息，日用量为合计，未确认第二次推理的具体用途。 [小米日用量口径](https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get)

首答覆盖通过 Claude Code 自己的设置，从 Farfold 正常入口使用 MiMo。旧托管入口的凭据交付、Claude 订阅与 Console 的登录及取消、模型切换仍按原项记录。 [原生接法](../2026-11-17-cycle12-models-and-sigit/README.md#claude-code-与小米-messages) · [托管限制](../2026-11-16-cycle12-original-config/README.md#claude-环境核对)

## 正常退出后查找、重开与续答

18:10 正常保存并退出，确认 Farfold 原进程退出。重新打开同一正式应用，从「搜索对话」按 `FF_C12_CLAUDE_MIMO_1752` 找到原测试对话并打开。首轮原消息与回复都读回。当前对话仍显示「沿用已有设置」及 `mimo-v2.6-flash (haiku)`。

18:11:42 在原对话发送一条无附件续问。消息只提供新的标记 `FF_C12_CLAUDE_MIMO_RESUME_1810`，要求从上一轮回复取出旧标记。18:11:46 回复准确给出原标记和新标记，顺序相同，各占一行。Farfold 显示已完成。同一隔离目录下只有一条 Farfold 登记和一个 Claude Code 顶层对话记录，重开前后都是原 ID `3baad729-4a3e-485c-b7fc-ac4d1ea82379`。该原会话的续答模型字段为 `mimo-v2.6-flash`。

本次正式协议日志 `protocol-v1-1794996650939-0.jsonl` 记录一次 `session/load`、一次手动 `session/prompt`、零 `session/new`。只有一条续问写入原会话，无自动重发、无工具操作或服务切换。

小米同一脱敏 Key 的当日 `mimo-v2.6-flash` 在线记录从 18:09:42 的 2 次、13,018 Token、¥0.011141，变为 18:13:35 的 4 次、37,952 Token、¥0.012435。18:12:55 查询尚未更新。另一脱敏 Key 的同模型记录在此期间保持 38 次。此次对账增量为 2 次推理、24,934 Token、用量金额 ¥0.001294。日用量是同 Key 的合计，第二次推理的用途未单独核实。 [小米日用量口径](https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get)

本样本证明从 Farfold 自有对话索引查找、冷开读回和沿原小米设置续答。厂商独立历史的默认发现、其他模型切换和托管凭据交付仍分项验证。
