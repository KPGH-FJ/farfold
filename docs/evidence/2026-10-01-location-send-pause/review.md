# 按位置暂停发送的独立证据复核

2026-10-01，复核正式 `61e8fb4` 的本轮实际暂停、当前任务结束、正常退出后的冷恢复、恢复位置和明确继续发送。仅读取本目录收据、01–11 界面文本、02/04/07/08 截图及只读采集工具；没有运行应用、Agent、产品测试或采集脚本，没有读取正式数据库、凭据、协议正文或外部历史。只新增本文。

结论：本条 OpenCode / Nemotron / 已有设置历史支持按位置暂停后续发送、保留单条队列、冷恢复暂停、恢复位置后不自动发送及明确继续成功的有限旅程。未发现需要本片改源码的证据矛盾。[PRODUCT](../../../PRODUCT.md) 要求恢复不自动发送队列，本次阶段收据与该要求一致；不扩大到其他位置、Agent 或完整产品验收。

## 阶段与请求

各协议收据使用同一 [data-before.json](data-before.json) 窗口起点，下面计数为累计出站 `session/prompt`，不能把前序历史中的标记或重复 AX 节点算成本轮发送。

| 阶段               | 界面和只读事实                                                                                                                                                                                                                                                    | 累计 prompt |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------: |
| 当前任务与单条队列 | [01](01-running-with-queued-marker.txt)为等待 300 秒的 A 与已排队的 B；[02](02-pause-exact-location-review.jpg)审阅精确 `/private/tmp/farfold-stop-queue-idn3cxh0`，说明当前任务不会停止。                                                                        |           1 |
| 位置暂停           | [03](03-location-paused.txt)显示目标已暂停；[04](04-paused-current-task-continues.jpg)仍在处理 A，B 保留且继续按钮禁用。[暂停采样](paused-running-processes.json)观察到该目录下的 OpenCode 与其 Python 子进程。[protocol-paused](protocol-paused.json)无 cancel。 |           1 |
| A 结束而 B 保留    | [05](05-task-ended-queue-still-paused.txt)显示 A 的准确标记与已完成状态，B 仍暂停。[任务结束收据](protocol-after-task-ended.json)没有第二次 prompt。没有执行停止操作；本次观察支持 A 继续至完成，不能推成所有任务或审批行为已验证。                               |           1 |
| 正常退出、冷恢复   | [cold-exited](cold-exited.json)确认正常退出后无应用及先前采样身份；[06](06-cold-paused-queue.txt)恢复原历史与 B，位置仍暂停、继续禁用。[冷恢复协议](protocol-cold-paused.json)仍只有 A 的一次 prompt。                                                            |           1 |
| 恢复位置、尚未继续 | [07](07-location-resumed-with-queue-paused.jpg)位置阻断消失，B 仍是暂停队列，继续按钮可用。[恢复后采样](resumed-observation-processes.json)覆盖 16:57:30–16:57:40；[16:57:56 协议](protocol-resumed-before-continue.json)仍无新增 prompt。                        |           1 |
| 明确继续 B         | [08](08-explicit-continue-result.jpg)出现 B 的准确回复与已完成状态；[明确继续后协议](protocol-after-explicit-continue.json)只增加一次，时间为 16:58:20.832。                                                                                                      |           2 |

第一个 prompt 的观察时间为 16:46:56.981。最终仍只有这两个出站 prompt；这证明本次有限窗口内没有自动重复派发，不代表所有异步排列或无限观察期。

## 队列计数与策略范围

[policy-paused.json](policy-paused.json) 的旧 `queueEntries:2` 误把对象的 `blocks`、`uncertainIndex` 两个字段算成两条消息。原收据保留；[更正收据](queue-shape-correction.json)的对象摘要与旧队列摘要相同，实际 `blocks.length=1`，与界面一致。本次独立核对其四个保护收据的原 SHA 全部匹配，未覆盖原始错误证据。详见[计数更正](queue-count-correction.md)。

暂停、[冷恢复](policy-cold-paused.json)和[恢复位置](policy-resumed.json)的精确目标队列摘要均为同一个值；冷恢复及恢复位置实际条目数为 1。仅在明确继续后，[队列记录消失](policy-after-continue.json)，最终[退出策略收据](policy-after-exit.json)仍为 0 条、无输入、意见或附件。原其他队列、输入、意见、选择及版本的摘要保持，没有新增未发键残留；目标 activity 有实际变化。

策略是[原无显式位置覆盖](policy-before.json) → 暂停时 `false` → 恢复后及最终退出 `true`。其他目标字段（该位置的 OpenCode、默认及旧默认）仍无覆盖，不相关策略摘要一致。**恢复的是发送行为，不是原设置逐字恢复**：完整策略摘要已变化，并保留此位置的显式 `true`。采集器的“不相关策略”摘要排除了本次目标位置和 Agent 字段，后者另由公开目标字段核对；不宣称检查了外部 Agent 配置。

## 原数据、源码与收尾

[最终退出](after-exit.json)保持原 36 条索引、40 个启动配置，无新增索引或设置。原 49 项设置只有 `agentWorkPolicy.v1` 与 `unsentWork.v1` 变化；原未发字段只有本测试 activity 变化。最终策略和未发收据证明自有待发内容已发送完、无新增键残留，不能仅凭“原队列摘要保持”证明本次新增队列已清空。

[09](09-original-model-preserved.txt)保留原 OpenCode Zen / Nemotron，[10](10-original-amp-draft-restored.txt)及[11](11-original-amp-medium.txt)恢复原 Amp / Medium 空稿。没有把恢复发送改成变更模型、来源或释放其他队列。

[本轮身份](candidate-run.json)是复用候选的准备记录，不是新安装完成证据。453 项源码输入与正式二进制摘要至 17:03:57 退出收据保持；之后另片的源码变动不属于本次安装观察。正式二进制仍为 `c02f1ff781b805c95891d718c40aa6fbd12a86e3432f8e11585149f4ed625504`。

[最终协议](protocol-metadata-final.json)为 4 个文件、33 条 startup、4 initialize、2 session/new、2 session/load、2 prompt，0 cancel / authenticate / permission，拒绝记录为 0。不称 initialize-only；两条 stderr 标记没有正文，不能用于推断根因。有限采集只覆盖窗口内新日志的完整行，不含旋转日志或完整请求正文。

[28 个采样身份](all-observed-processes.json)按 PID 与启动时间核对，最终应用、当前后代和先前采样身份均已结束；不声称捕获全部瞬时进程。此复核没有新增执行或复测，不将[队列源码的既有 24 项测试](queue-review.md)算作本次安装旅程。

未覆盖：暂停期间处理真实审批或点击停止、暂停期间新建工作、其他位置或 Agent 的实际并发发送、队列编辑/移除、保存失败、崩溃/强杀、其他账号或模型组合。未知策略字段保护属于随后独立源码片，未向正式设置注入未知字段制造故障。
