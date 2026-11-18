# 第 12 周期 Autohand 停止与续答回执复核

2026-11-18 只读复核 Autohand 0.9.11 的两条自有前台任务及停止后的一次续问。两条原任务均从正式 Farfold 以已有服务和 Fantail 发出，分别单次允许 `/bin/sh ./wait-owned.sh`。原双任务验证时只点 A 的停止。A 的 Shell 退出，但其 sleep 子进程仍活跃，由 PID 1 接管，后到期退出。B 的原进程继续并自然完成。A 的实际停止仍为失败。[原正式实测与进程快照](../2026-11-16-cycle12-eight-check/README.md#autohand-前台停止) · [脱敏进程回执](../2026-11-16-cycle12-eight-check/results.json)

| 样本 | 厂商保存的同一原对话                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `543cc4f7-ddc5-404c-910e-824287ba0e4b-1794813698772`，原目录 `/private/tmp/farfold-c12-autohand-pair.qQlcyOTZ/A`。原会话第 1、2 行有原请求和 `run_tool_script` 调用 `chatcmpl-tool-834320617980becf`。没有同 ID 工具结果，也没有这次工作的正文回复。第 3 行为次日手动续问，此后无保存回复。 |
| B    | `3d185eb2-db95-4fa0-9b83-b59e94651f6d-1794813755397`，原目录 `/private/tmp/farfold-c12-autohand-pair.qQlcyOTZ/B`。原会话第 2、3 行的 `run_tool_script` 调用及结果 ID 均为 `chatcmpl-tool-a8b32e6d1b03caba`，结果 `ok: true`。结束标记同时出现在同一工具结果及第 4 行助手答复。              |

- **11 月 16 日实时停止。** A 的 Farfold 诊断第 29 行发出停止，随后第 31、36 行分别在 4 毫秒、53.389 秒后收到工具类更新。诊断只保留类别，无法核实这些更新的工具 ID 或状态。A 的厂商原会话仍无该工具的终态。B 收到工具更新并完成，零停止。两条实时诊断各记录一次新建、一次发送。
- **11 月 17 日同一 A 冷开。** Farfold 诊断记一次加载、一次手动续问、零新建。发送后 167.454 秒点一次停止，其后没有入站回复或终态。厂商保存了此次续问。约 22 分钟 50 秒后有独立的进程组结束与连接移除记录。这次关闭仅证实连接已清理，原续答及停止终态仍未知。[中断后的原证据对齐](../2026-11-18-cycle12-goal-reconciliation/README.md)
- **Farfold 受控检查。** `src/runtime/conversation_export.activity.test.ts` 共 13 项通过。覆盖已取消轮次的工具步骤在取得同一工具终态前继续显示未知，以及另一轮或另一会话的同一标识不改变原工具状态。此结果只对应 Farfold 组件。正式实停仍需官方停止覆盖原子进程，随后从 Farfold 核原工具终态与原对话续答。

## 原件定位

本次零新会话、零工具执行、零模型请求。下列七份原件前后字节一致。记录仅保留自有样本和核对字段。

| 本机原件                                                                                     | 位置                                       | SHA-256                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `~/.autohand/sessions/543cc4f7-ddc5-404c-910e-824287ba0e4b-1794813698772/metadata.json`      | A 原会话 ID、目录和模型                    | `5e8b26a42a7bfd8dd8d5a39010b5ac46c41c23423474e7447cfad7a3d13b55b6` |
| `~/.autohand/sessions/543cc4f7-ddc5-404c-910e-824287ba0e4b-1794813698772/conversation.jsonl` | A 第 1–3 行                                | `c474e29c24562ce22b3ea46493ad1d101e6de2817bd0384fde8fc93c8791ec9e` |
| `~/.autohand/sessions/3d185eb2-db95-4fa0-9b83-b59e94651f6d-1794813755397/metadata.json`      | B 原会话 ID、目录和模型                    | `48a536fc4de623d6bf667cad4c57d2c406501a9a72a8a90671559f70225c89f7` |
| `~/.autohand/sessions/3d185eb2-db95-4fa0-9b83-b59e94651f6d-1794813755397/conversation.jsonl` | B 第 1–4 行                                | `15903c454ec587fca77dedddad73f683392a30c467111d672d984ba2f574bca0` |
| `~/Library/Logs/Farfold/protocol-v1-1794813695086-1.jsonl`                                   | A 前台任务，第 15、24、29、31、35、36 行   | `76a35a2bc9f4d2a329b1e0d4064e1aa1f5a7f69c6f02b5b18c67ccf1b39fbc97` |
| `~/Library/Logs/Farfold/protocol-v1-1794813753323-3.jsonl`                                   | B 前台任务，第 15、24、29、31、155 行      | `10fcd441e8434a6baea74b5092c2d99b4546c458531d032db7fd7a466b76ec32` |
| `~/Library/Logs/Farfold/protocol-v1-1794915706083-0.jsonl`                                   | A 冷开和续答，第 10、16、17、22、25、26 行 | `f811603dd6dd4ee91378a7b974ae82d501a961f6f8a00df627ec37525f21d428` |

## 11 月 19 日复验条件

只读核对 Farfold 原登记 `registry:autohand`，已用厂商 Autohand Code 0.9.11 内置 `--acp`，登记及握手均为 0.9.11。厂商 GitHub 最新稳定发行和 npm `autohand-cli` 的 `latest` 均为 0.9.11。旧 0.2.1 适配器已由厂商归档，旧安装不属于原入口。本轮没有重新发消息。进入下一次正式验证的条件是官方可针对原前台命令终止其子进程并发出同工具的终态。届时从 Farfold 沿已有 Fantail 复验只停 A、B 保持、原 A 冷开及手动续答。 [稳定发行](https://github.com/autohandai/code-cli/releases/tag/v0.9.11) · [厂商内置接法](https://docs.autohand.ai/integrations/acp-mode) · [旧适配器归档](https://github.com/autohandai/autohand-acp)
