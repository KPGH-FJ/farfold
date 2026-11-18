# 第 12 周期 Copilot 工具回执与 Grok 成品冷开

2026-11-18，macOS arm64。正常入口复验使用正式版 0.1.7，源码 `addd85cf7`，CDHash `47b352da5f04af22fa4fb631590c9626288a278c`。

## Copilot 工具回执

上批两条前台样本的登记均从 1.0.112 启动。核对原始事件的 `copilotVersion` 后，已确认先启动的 B 为 1.0.112，后启动的 A 为 1.0.114。中间由官方程序自动更新。原进程采样仍证明两条工作同时运行，点停 A 后它的 Shell 及子进程退出，B 不受影响。 [上批进程证据](../2026-11-18-cycle12-dirac-copilot/README.md#copilot-双前台实停) · [GitHub 关于 CLI 缓存更新](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference#pinning-the-cli-version)

官方 ACP 通过同一工具 ID 的更新报告工具状态。GitHub 还提供 `sessions.readPersistedEvents`，可以读已保存的事件。隔离使用官方 1.0.112 程序读取两条自建会话的副本，禁网，零恢复、零发送。A 返回全部 18 条，包含原 Bash 启动与 `user_abort`，一直没有同一工具 ID 的结束事件。B 返回全部 22 条，可查到它自己 Bash 的成功回执。两份输入摘要前后一致。 [ACP 工具状态](https://agentclientprotocol.com/protocol/v1/tool-calls) · [GitHub 工具结束事件](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events#toolexecution_complete) · [官方只读接口回执](copilot-sdk-persisted-events.json)

正常重启 Farfold 后，冷开 A 原对话，仅发出一次加载，无自动重发。界面仍显示「步骤结果未知」。这条已确认实际进程退出，工具结束回执仍待 Copilot 为原 `toolCallId` 提供可核终态。当前没有可补到界面的官方结果。 [原对象与冷开回执](copilot-official-stop-a.json)

## Grok Build 成品冷开

正常新建一条自有对话，沿已有设置的 Grok 4.7 / Low。一次手动发送，一次批准明确的 `result.txt` 写入。完成时从「本轮产物」打开成品，四行原字、组内顺序和末尾换行逐字节与预期一致。原件不变。

确认工作位置只余既有已结束但结果未知的记录后，正常保存退出，保留该记录。重启后通过搜索打开同一原对话，零新建、零发送。从原「查看处理过程」的精确文件按钮打开结果，显示与磁盘核合。成品仍为 106 字节，前后摘要一致。冷开时「本轮产物」没有出现，覆盖的是历史工具路径的交付取回。 [正常入口回执](grok-cold-file.json) · [自有原件](fixture/input.txt) · [成品](fixture/result.txt)

## 等待官方的条件

| Agent   | 当前核对                                                                                                                   | 复验触发                                                                                                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot | 已证明原前台进程退出。官方事件读取返回完整 A 记录，缺同一工具的终态。                                                      | 官方为同一工具 ID 发出终态后，在 Farfold 复验实际停止、终态呈现和重启后保留。                                                                                                                                                                                                                                 |
| Dirac   | 目录已分发 0.6.1。所查历史回放仍优先返回已有事件，规则写入没有精确的并发冲突保障。                                         | 正文回放补齐或出现能核原 ID 与目录的只读原文接口。正式撤回需要官方确认实际作用范围和精确写入效果。 [官方回放](https://github.com/dirac-run/dirac/blob/225d7cf86d1bd500352b0ef4875b86a1a17b6622/cli/src/agent/DiracAgent.ts#L2316-L2365)                                                                       |
| Cline   | 3.0.74 列表查询未传入工作目录，打开与查询均可能改变失联任务状态，另一路径会提前合并重复 ID。                               | 官方提供精确目录、保留冲突且从打开到查询都只读的列表。 [目录传递](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/session/session.ts#L103-L115)                                                                                                                     |
| Pi      | 0.0.34 仍未转发每个对话的 MCP 工具。扩展命令终态修复亦未发布。                                                             | 官方发布可核的转发及撤回后，复验正常网页审批、截图、撤回和冷开范围。独立 SDK 1.5.2 仍是受控可行路径。 [转发改动](https://github.com/svkozak/pi-acp/pull/164) · [命令终态改动](https://github.com/svkozak/pi-acp/pull/118)                                                                                     |
| MiniMax | 官方包 0.7.7，原登记正式分发仍为 0.2.7。                                                                                   | 目录正式分发新版后保留原 MiMo 与原登记，复验后台 A 实停、B 继续、终态和冷开。 [目录更新](https://github.com/agentclientprotocol/registry/pull/780)                                                                                                                                                            |
| Amp     | 官方适配器仍为 0.13.0。显式 MiMo 续答仍把只供新线程的 `--model` 加到原线程续接，CLI 导出与未映射原线程的接入分属两条路径。 | 适配器支持先核原模型再续答，或官方提供原线程模型更新及精确的原标识和目录映射。已验证的 Default 沿用原 MiMo 分项保持。 [适配器实现](https://github.com/tao12345666333/amp-acp/blob/v0.13.0/src/amp-transport.ts#L223-L244) · [Amp 模型说明](https://ampcode.com/docs/model-selector#switch-models-in-a-thread) |

Gemini CLI 与 Antigravity 按用户要求暂缓。
