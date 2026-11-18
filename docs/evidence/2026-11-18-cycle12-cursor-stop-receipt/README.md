# 第 12 周期 Cursor 双任务停止回执复核

2026-11-18 只读复核 11 月 16 日 Cursor 2026.11.13 的两条自有前台任务。原正式 Farfold 复验沿用已有设置和 Auto，各单次批准 `/bin/sh ./wait-owned.sh`。通过原会话 ID 的 SHA-256 前 16 位及厂商会话元数据核对两条原记录和各自目录。时间均为 UTC+8。 [原双任务及进程观察](../2026-11-15-cycle12-followup/cursor-foreground-pair-2026-11-16.json)

| 样本 | 原对象与结果                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | 原会话 `54d3940b-2b4b-4ceb-9e99-15c14ad38907`，摘要前缀 `292123690aafcb77`，目录 `/private/tmp/farfold-c12-cursor-pair.e_uc93b4/alpha`。Farfold 12:05:05.171 发出停止，5 毫秒后收到响应。原实测在 12:05:05.240 已观察到 A 的 Shell 和子进程都退出。A 的实时诊断在停止后无工具类更新，原目录对应的 Cursor 工具目录没有终端回执，也未从原会话数据库取得可核的同工具终态。 |
| B    | 原会话 `9347f1fa-5ccb-41c4-b075-60d110dd7d0e`，摘要前缀 `db96ba11207394e9`，目录 `/private/tmp/farfold-c12-cursor-pair.e_uc93b4/bravo`。Cursor 的终端原件 `837209.txt` 对应原目录及原命令，记 PID 10380、`status: succeeded`、`exit_code: 0`，于 12:05:29.927 结束。Farfold 在 12:05:31.951 收到 B 的工具类更新，12:05:41.173 收到本轮响应。B 原连接零停止。            |

B 的厂商终端原件补证了另一条任务的实际成功。A 的前台进程退出已有实测，原工具终态仍未知。仍需官方提供同一工具的明确结束回执，另验被监视的后台命令。本次未启动应用或 Agent，零新会话、零工具执行、零模型请求。

## 原件定位

| 本机原件                                                                                     | 位置                                  | SHA-256                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `~/.cursor/acp-sessions/54d3940b-2b4b-4ceb-9e99-15c14ad38907/meta.json`                      | A 原目录                              | `86f13dc4fff0d26351398fa79cba6094db594f9558930ce809243f12e1341242` |
| `~/.cursor/acp-sessions/9347f1fa-5ccb-41c4-b075-60d110dd7d0e/meta.json`                      | B 原目录                              | `926ca4b7064e41e71add6e48353dc283b7456664c43d8c9f6e663997bce7dbc9` |
| `~/.cursor/acp-sessions/54d3940b-2b4b-4ceb-9e99-15c14ad38907/store.db`                       | A 原会话库，按只读不可变模式检查      | `410d25eeeef8aab162f66f5a17127515598243187060804da5d3482d6e6eb1e4` |
| `~/.cursor/projects/private-tmp-farfold-c12-cursor-pair-e-uc93b4-bravo/terminals/837209.txt` | B 终端回执，第 2–7、12–14 行          | `a05d3713035eff0269903dbaad9a44ddccac60e3e4af8fe29f0a0e74a6661741` |
| `~/Library/Logs/Farfold/protocol-v1-1794801847981-1.jsonl`                                   | A 原请求、审批及停止，第 11、41–46 行 | `3e3e08fa1188bc57afe9e09acee08772570fdcbfc5209c62a94737ac2f9b8176` |
| `~/Library/Logs/Farfold/protocol-v1-1794801818662-0.jsonl`                                   | B 原请求及完成，第 11、37–41、120 行  | `95c054d006e790500fb3ecc588c8b1e133822f92b5bf633cb53025de0c68f0c8` |

## A 原工具终态的官方入口核对

仅针对原会话 `54d3940b-2b4b-4ceb-9e99-15c14ad38907`。核对目录登记的 Cursor 2026.11.13，macOS arm64 厂商归档为 `2026.11.13-eacade1`。本机打开归档解包后的 `~/Library/Application Support/ai.farfold.desktop/agent-installations/agent-registry%3Acursor/install-1iFE3v/dist-package/8104.index.js`，该文件 SHA-256 为 `6605d145643e8190df2b5250bbef41a54d96473baab88c49e3dc9c0915a85e0f`。 [原登记](https://raw.githubusercontent.com/agentclientprotocol/registry/5f9c6347acda6c4a9ff91eadb0452b56ccf883d5/cursor/agent.json) · [厂商归档](https://downloads.cursor.com/lab/2026.11.13-eacade1/darwin/arm64/agent-cli-package.tar.gz)

- **加载会写入。** `loadSession` 认证后打开原会话存储、读取原模型，并在恢复分支调用 `writeFile` 重写原 `meta.json`。后续初始化还可能迁移已保存的 ACP 模型选项。A 的原工作目录现已不存在。此次未执行加载、未替换目录。
- **回放重新编号。** `replayAgentTurn` 用轮次和步骤索引生成 `replay-${turnIndex}-${stepIndex}`。回放工具更新统一写入 `status: completed`，单看这个状态无法把回执归到原工具 ID，也无法区分命令成功与被中止。Cursor CLI 的正常回放入口为 `session/load`。SDK 的会话检查文档覆盖 SDK 服务及其保存的跟踪文件，当前未找到可按该本机 ACP 原会话和工具 ID 查终态的公开接口。 [Cursor ACP](https://cursor.com/docs/cli/acp) · [Cursor CLI 命令](https://cursor.com/docs/cli/reference/parameters) · [SDK 会话检查](https://cursor.com/docs/agent-sdk/reference/cli#inspect-a-session)
- **复验条件。** A 的 OS 前台进程退出证据保持，原工具结果仍未知。需 Cursor 为原 `toolCallId` 发出可核归属的明确终态，或开放按同一原会话、请求和工具查询的只读接口。此次只读核对同一 A 的证据与安装代码，零启动、零打开或恢复会话、零模型请求，未写入 Agent 历史或配置。 [ACP 工具状态](https://agentclientprotocol.com/protocol/v1/tool-calls)
