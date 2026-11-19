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

| Agent    | 当前核对                                                                                                                                          | 复验触发                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot  | 原前台进程已退出，缺同一工具的终态。另一个旧 Auto 请求的厂商失败没有准确对应的协议事件。                                                          | 官方为同一工具 ID 发出终态后复验停止及冷开。Auto 另需能对应同一请求的结构化失败，再复验失败提示、无完成通知、草稿和待发保留。 [Auto 复验条件](../2026-11-16-cycle12-eight-check/README.md#等待官方的复验条件)                                                                                                                             |
| Autohand | 原目录已有内置官方 0.9.11 `--acp`，A 的 Shell 结束而子进程仍运行，原工具无终态；现行稳定版未变。                                                  | 官方前台停止覆盖原子进程并报告同工具终态。届时沿原 Fantail 从 Farfold 复验双前台、停止和冷续答。 [正式证据](../2026-11-18-cycle12-autohand-stop-receipt/README.md#11-月-19-日复验条件)                                                                                                                                                    |
| Dirac    | 目录已分发 0.6.1。所查历史回放仍优先返回已有事件，规则写入没有精确的并发冲突保障。                                                                | 正文回放补齐或出现能核原 ID 与目录的只读原文接口。正式撤回需要官方确认实际作用范围和精确写入效果。 [官方回放](https://github.com/dirac-run/dirac/blob/225d7cf86d1bd500352b0ef4875b86a1a17b6622/cli/src/agent/DiracAgent.ts#L2316-L2365)                                                                                                   |
| Cline    | 3.0.74 列表查询未传入工作目录，打开与查询均可能改变失联任务状态，另一路径会提前合并重复 ID。                                                      | 官方提供精确目录、保留冲突且从打开到查询都只读的列表；自动成品另需同一原工具结构化位置，持久许可需可查可撤的逐条规则。 [成品和撤销正式证据](../2026-11-19-cycle12-cline-delivery-permission/README.md) [目录传递](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/session/session.ts#L103-L115) |
| Pi       | 0.0.34 仍未转发每个对话的 MCP 工具。扩展命令终态修复亦未发布。                                                                                    | 官方发布可核的转发及撤回后，复验正常网页审批、截图、撤回和冷开范围。独立 SDK 1.5.2 仍是受控可行路径。 [转发改动](https://github.com/svkozak/pi-acp/pull/164) · [命令终态改动](https://github.com/svkozak/pi-acp/pull/118)                                                                                                                 |
| Qoder    | 已知目录可精确查找。官方发布 1.1.92 的默认列表仍只从首条历史取工作目录。同版原工具结束可从厂商记录核对，Farfold 实时未收到 A 的同一工具结束回执。 | 默认历史列表提供准确原目录。停止后通过官方回执或只读接口返回同一请求与工具的真实终态，再核实 Farfold 实时及重开表现。 [原回执补证](../2026-11-18-cycle12-qoder-stop-receipt/README.md)                                                                                                                                                    |
| Claude   | 已验同 B 用官方 Read 报告同一成品路径，冷开从 Read 历史步骤直接打开。原 Bash 仅有命令与结果。                                                     | 原 Bash 步骤的直达需要官方按原工具报告精确成品路径，再核同一原文件回放。[正式复验](../2026-11-18-cycle12-claude-pair-stop/README.md#b-通过官方-read-冷开直达同一成品)                                                                                                                                                                     |
| Cursor   | A 原前台进程已退出。现用官方加载会重写元数据，回放重编号并统一报完成。                                                                            | 原工具 ID 的确切终态，或保留原会话、请求和工具归属的只读查询。受监视的后台 Shell 仍需官方的精确停止入口。[官方入口核对](../2026-11-18-cycle12-cursor-stop-receipt/README.md#a-原工具终态的官方入口核对)                                                                                                                                   |
| MiniMax  | 原目录已装 0.7.7，原轮仍活跃的双后台已实际停 A、B 继续。冷开 A 回复正确，约 600 秒后才结束，原步骤终态未知。                                      | 等厂商补冷开取消任务处理、原工具终态，以及无活跃原轮时精确停止后台的入口，再从 Farfold 复验。 [新版实测](../2026-11-19-cycle12-minimax-077/README.md)                                                                                                                                                                                     |
| Amp      | 官方适配器仍为 0.13.0。显式 MiMo 续答仍把只供新线程的 `--model` 加到原线程续接，CLI 导出与未映射原线程的接入分属两条路径。                        | 适配器支持先核原模型再续答，或官方提供原线程模型更新及精确的原标识和目录映射。已验证的 Default 沿用原 MiMo 分项保持。 [适配器实现](https://github.com/tao12345666333/amp-acp/blob/v0.13.0/src/amp-transport.ts#L223-L244) · [Amp 模型说明](https://ampcode.com/docs/model-selector#switch-models-in-a-thread)                             |
| Kilo     | 正式 7.8.1 原 Bash 实停，实时和冷开却显示步骤勾号，中止只见于原输出。现行目录 7.8.27 的 `completed` 工具映射未变。                                | 等同一工具 ID 的结构化中止或失败回执，复验正常入口实时显示和重开同一工具。 [正式实测](../2026-11-18-cycle12-kilo-stop-display/README.md) · [目录当前映射](https://github.com/Kilo-Org/kilocode/blob/v7.8.27/packages/opencode/src/acp/tool.ts#L186-L198)                                                                                  |
| OpenCode | 2.2.7 普通停止已结束回复，原生后台 Shell 保持运行并自然完成。                                                                                     | 官方提供同一原 Shell ID 的精确停止入口，再从 Farfold 复验停止、进程实际退出及界面状态。 [实际失败](../2026-11-19-cycle12-official-background-stop/README.md#opencode-回复停止后原后台命令继续运行)                                                                                                                                        |

Gemini CLI 与 Antigravity 按用户要求暂缓。

CodeBuddy 原官方目录入口已通过 Hy4 / On 首答、同原对话切换和冷续答。原目录标准 Hy4 也已验双前台精确停止、原工具中止与冷开续答。 [正式实测](../2026-11-18-cycle12-codebuddy-registry-stop/README.md) · [原目录实测](../2026-11-18-cycle12-codebuddy-registry-model/README.md) · [独立入口实测](../2026-11-18-cycle12-codebuddy-hy4-official-launch/README.md)

### Pi 网页传输前置复核

2026-11-18 并行复核已发布适配器 `0.0.34` 与厂商 SDK `1.5.2`。当前仍需正式接法将 MCP 工具传入原 Pi 对话，并让每次批准、拒绝和结束对应原请求。

本机运行一项既有 macOS 工程测试，1 项通过。两个实际签名的助手进程均通过归属检查，各用相同的请求编号读取各自的受控页面；撤回后两边分别回复结束，再读取均被拒绝。测试只覆盖 Farfold 的实际助手进程与合成页面。Pi 到实际签名助手的归属、正式网页、截图及真实命令审批仍待验。测试无模型请求。[工程测试](../../../src-tauri/src/browser_sharing/transport_multi_native_tests.rs)
