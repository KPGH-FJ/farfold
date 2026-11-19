# 第 12 周期 Cursor 拒绝回放复核

2026-11-20，北京时间。仅核自建原样本 `390aaa3a-d8e2-4895-91fb-4c5c8f7e44d6`，工作目录 `/private/tmp/ff-c12-n20-ryup8cla/cursor`。正式 Farfold `87ac54ec2` 用现有 Cursor Auto 设置从正常入口发送一次，在 `/bin/sh ./once.sh` 的审批点一次拒绝。界面显示已告知 Agent，预定成品始终未出现。随后正常退出并重开同一条，原文和答复可见，工具只显示「执行 · 步骤已结束」。重开零发送、零审批。此次复核只读取该样本的本机字节和安装源码。 [正式原件](../2026-11-20-cycle12-native-entry/README.md#cursor-拒绝与冷开)

## 同一工具的原记录与回放

厂商 `~/.cursor/acp-sessions/<原会话 ID>/meta.json` 确认同一目录，SHA-256 `e93231acfd806923dfcead276da0cba4774e2abff2a8cee8b435384f2d36affa`。只读复制 `store.db` 与 `store.db-wal` 到内存，按盐值、帧校验和及提交边界读取最新提交。76 帧，WAL SHA-256 `d614642a8ef3357fbbdf5740b1e0d798e058bc07c3aa37040d0a743a0c244a2e`。读取前后两个原文件标识、字节数和修改时间相同。

| 原件                                                                                     | 可核事实                                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 625 字节记录，SHA-256 `0225b5affa50a4b00e26658e8130a1821f1d157e811dc1efb0894d44646a075c` | 带 `toolCallId`、原工具 `678b06f3-fa27-45ec-952b-147b60a24c71` 和 `User rejected`。 |
| 520 字节记录，SHA-256 `a391d53c7f595d3762cbaae9875ff6b914b0bbd949fcd548afd92d7f0561f362` | 同一原会话、同一原工具及脚本，含 `User rejected`。                                  |

登记的 Cursor 2026.11.13 对应 macOS arm64 官方包 `2026.11.13-eacade1`。安装目录 `agent-installations/agent-registry%3Acursor/install-1iFE3v/dist-package` 内 `8104.index.js` 的 SHA-256 为 `6605d145643e8190df2b5250bbef41a54d96473baab88c49e3dc9c0915a85e0f`。在这份文件中，`replayAgentTurn` 以轮次和步骤下标生成 `replay-${t}-${a}`；`presentCompletedToolCall` 用这个编号发 `completed`。Shell 的 `extractToolCallOutput` 只为 `success` 或 `failure` 输出退出码及标准输出流，拒绝结果没有对应输出分支。由此可解释同一工具的原编号和拒绝原因为何没出现在正常冷开回执中。 [登记版本](https://raw.githubusercontent.com/agentclientprotocol/registry/5f9c6347acda6c4a9ff91eadb0452b56ccf883d5/cursor/agent.json) · [官方安装包](https://downloads.cursor.com/lab/2026.11.13-eacade1/darwin/arm64/agent-cli-package.tar.gz)

## 已核官方入口

- Cursor CLI 文档提供 `agent ls`、`--resume` 和发送时的 JSON 输出。ACP `session/load` 走上述恢复与回放，恢复分支还会写原会话元数据。已核命令清单、安装包入口及更新说明，未找到可按此本机 ACP 会话和原工具读取拒绝结果的官方只读导出。 [CLI 参数](https://cursor.com/docs/cli/reference/parameters) · [CLI 输出](https://cursor.com/docs/cli/reference/output-format#tool-call-events) · [ACP 扩展](https://cursor.com/docs/cli/acp#cursor-extension-methods) · [更新说明](https://cursor.com/docs/cli/changelog)
- Cursor SDK 可读取自身 Agent 或已保存的追踪文件。Hooks 的 `permission_denied` 属于工具发生时的回调，OpenTelemetry 需事先启用且无历史补采。这些入口目前没有公开说明可按此 ACP 原会话和原工具读回已发生的拒绝。 [TypeScript SDK](https://cursor.com/docs/sdk/typescript#inspecting-agents-and-runs) · [追踪读取](https://cursor.com/docs/agent-sdk/reference/cli#inspect-a-session) · [Hooks](https://cursor.com/docs/hooks#posttoolusefailure) · [OpenTelemetry 限制](https://cursor.com/docs/enterprise/opentelemetry-export#limitations)

后续验收需要官方回放保留原工具编号和拒绝结果，或提供可按原会话、工作目录和工具编号核对的只读接口。厂商私有库的字节只用于此次归因。本次零启动、零会话打开、零模型请求，未改写厂商记录。
