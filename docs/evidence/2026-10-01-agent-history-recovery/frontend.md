# 对话读取失败：前端实施与受控检查

2026-10-01。仅改变成功 session_open 之后的本地恢复失败归类与出口，保留原历史、模型和发送准入。七个生产文件与三个测试文件的 SHA-256 / 行数见 [最终源码收据](source-final.json)，含另一个作者的 App 导航小块；初次七文件快照保留在 [原收据](source-initial-frontend.json)。完整安装身份由根任务的 candidate-source 收据决定，不能用这十项摘要替代。

## 最终行为

- [session_recovery.ts](../../../src/runtime/session_recovery.ts) 在本次 resumed IPC 已成功后检查原门槛：匹配完成标记、未观察到丢失连接、可读用户消息 / 回复或有效附件。缺少完成标记生成自有 `incomplete`，完成后无可读内容生成自有 `empty`；类型不从远端文字、contains 或错误对象字段推断。
- [sessions.ts](../../../src/runtime/sessions.ts) 保留原正文、待发队列、模型保护、未知执行状态和暂停状态。成功 resumed IPC 且该次没有观察到丢失时，清除旧 `connectionLost`，以独立读取失败继续阻止发送；原未知执行、停止未确认、待发和模型保护不清除。旧 owner 的实时工具 ID 不转给新连接，工具记录及原状态保留。真实丢失事件仍走原处理路径。
- 失败回放只继续观察该 channel owner 的真实 connectionLost。迟到正文、配置、完成标记都不开放原对话；开始下一次重读会取消旧 owner 的前端资格，其迟到事件不能影响新结果。
- 已成功结果提供的 canonical cwd、service、serviceContext 保存在失败占位中。显式新稿沿同 Agent、该资料文件夹与确认来源创建，保留旧正文和队列，不复制旧消息或强制重送模型配置，不自动 prompt。缺少确认来源不默认成“已有设置”。
- [ThreadView.tsx](../../../src/components/ThreadView.tsx) 显示“对话读取失败”及对应说明，提供“重试读取”和显式“新开会话”。真正的连接失败继续显示原连接出口；读取成功后若原模型保护不通过，仍暂停发送。
- 重试由 App 的持久 owner 处理 canonical 返回目标；切到其他页面不抢回焦点，暂离后只修正已有原稿返回 key。独立 ThreadView 的 fallback 也检查目标、活动状态、卸载与操作序号。显式新稿的迟到完成仅在原页面仍有资格时打开；新稿与重读按钮及 handler 互斥，完成后恢复忙态。创建行为仍沿原 Agent / 目录 / 来源，不补发旧队列。App 的精确范围及 deferred 反例见 [导航实施](app-navigation.md)。

改动只涉及前端内存状态及既有 IPC 调用，不新增后台诊断、数据库历史副本、身份账本或外部配置写入。[session_types.ts](../../../src/runtime/session_types.ts) 的有限读取失败字段由 [session_projection.ts](../../../src/runtime/session_projection.ts) 初始化；新文案集中在 [strings.ts](../../../src/runtime/strings.ts)。

## 红 / 绿证据

| 检查             | 实际结果与边界                                                                                                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 初次测试载入     | [frontend-red.json](frontend-red.json) / frontend-red.log：退出 1，0 测试执行。新夹具未给 import 时读取的 invoke 设置 Promise 默认值；只纠正夹具，未计为业务红。原收据保留。                                                                                                                          |
| 旧行为反例       | [frontend-red-corrected.json](frontend-red-corrected.json) / frontend-red-corrected.log：退出 1，8 项失败。生产未修改，真实 threads.open / Tauri IPC 夹具 / ThreadView 呈现链重现归类、来源和 canonical 目标问题。                                                                                    |
| 首次修复         | [frontend-green.json](frontend-green.json) / frontend-green.log：退出 0，8 项通过。                                                                                                                                                                                                                   |
| 迟到真实丢失反例 | [frontend-late-loss-red.json](frontend-late-loss-red.json) / frontend-late-loss-red.log：退出 1，1 项失败 / 9 项跳过。证明完全关闭失败 channel 会漏掉之后的真实 loss。                                                                                                                                |
| 初版新片边界     | [frontend-boundaries-green.json](frontend-boundaries-green.json) / frontend-boundaries-green.log：退出 0，新 10 项通过；覆盖真正冷 API 占位及迟到 loss 的 owner 隔离。此时尚未加入最终导航和旧实时状态反例。                                                                                          |
| 初版相称回归     | [frontend-related-green.json](frontend-related-green.json) / frontend-related-green.log：退出 0，9 文件 112 项通过；原收据保留，不能当最后源码的完整检查。                                                                                                                                            |
| 旧状态保护红     | [旧 loss 红](frontend-prior-loss-red.json)：1 项失败；修掉旧 loss 后，[旧工具 owner 红](frontend-tool-owner-red.json)：1 项失败。最终成功 load 清旧 loss 和旧实时 ID，保留未知执行、工具记录、队列和模型保护。                                                                                        |
| 返回目标红       | [ThreadView fallback 红](frontend-retry-navigation-red.json)：2 项失败 / 3 项通过；App [导航与原稿返回红](app-navigation-origin-red.json)：6 项失败 / 24 项通过。App 最终 34 项通过，统一范围包含这 34 项，数量不重复相加。                                                                           |
| 新稿迟到导航红   | [frontend-new-draft-red.json](frontend-new-draft-red.json)：3 项失败 / 1 项通过 / 7 项跳过，证明离开、换目标和卸载后的迟到完成会抢回焦点；正常新稿打开仍通过。                                                                                                                                        |
| 动作互斥红       | [frontend-exclusive-red.json](frontend-exclusive-red.json)：2 项失败于按钮未禁用；[更强派发反例](frontend-exclusive-dispatch-red.json)：同两项直接证明另一操作被发出。最终两种顺序都不并发派发，且完成后两按钮恢复可用。                                                                              |
| 最终相称回归     | [frontend-exclusive-stable-green.json](frontend-exclusive-stable-green.json) / frontend-exclusive-stable-green.log：退出 0，11 文件 160 项通过。包含新读取 11 项、导航 13 项和 App 34 项；覆盖既有历史 / UI恢复、队列与来源、类别保护、认证恢复、准备返回、选择文案和集中禁用词检查。各轮数量不相加。 |
| 最终类型         | [frontend-typecheck-exclusive-stable.json](frontend-typecheck-exclusive-stable.json) / frontend-typecheck-exclusive-stable.log：退出 0。                                                                                                                                                              |

最后局部 Prettier check 与 git diff --check 退出 0。没有执行整仓测试、Cargo、正式应用或真实 Agent；全量检查与安装旅程由根任务统一完成。

## 反例覆盖与未测范围

[ThreadView.history-reading.test.tsx](../../../src/components/ThreadView.history-reading.test.tsx) 使用真实 threads 控制器和呈现组件，只有 IPC 是自有受控夹具。覆盖配置-only + 匹配标记、缺标记超时、读取前真实 connectionLost、远端同文案、已成功新连接清旧 loss 但保持未知执行 / 旧工具不复活、canonical target + API 来源、来源字段缺失、成功重读仍模型阻断、真正冷 API 占位、失败后的真实 loss 与旧 owner 隔离。既有有效附件历史与缺失 / 错配 marker 用例继续通过。

[ThreadView.history-navigation.test.tsx](../../../src/components/ThreadView.history-navigation.test.tsx) 调用真实按钮回调，仅延迟控制器 Promise 完成，检查 fallback 重试、App owner 委派、新稿导航与两动作互斥。App 另用既有 hook harness 通过真实 ConversationLibrary / ThreadPage 入口检查重试和原稿返回；没有把测试 hook 当安装旅程证据。

这些测试不证明 Dirac / siGit 正式失败都属于 `empty`，也不证明外部历史存在、已删除或实现不支持恢复。现场事实及静态候选见 [调查](investigation.md) 与 [siGit 官方分支](upstream-empty-history.md)。正式两个旧测试的资料文件夹已为 canonical；本片另补 alias 输入的 store 与页面导航受控反例，避免失败后的 canonical key 更新使原页面或暂离返回路径丢失占位。真实 alias 导航尚未安装验收。

此处不宣称真实冷恢复成功、账号成功、模型载入或真实请求成功。对原未知请求不重发，对原模型不改选，对没有正文的历史不生成空白成功会话。
