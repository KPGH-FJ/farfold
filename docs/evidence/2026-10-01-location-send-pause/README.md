# 按位置暂停与恢复发送：有限安装验收

本轮复用已安装的 `61e8fb4`，没有重装。OpenCode 原有测试对话在任务运行期间暂停该位置发送，运行任务自然完成，单条待发消息经过正常退出和冷恢复仍保留；恢复位置发送后没有自动派发，明确点击继续后才得到 B 回复。实际停止、审批、队列冷编辑及同位置/其他位置新稿发送均未测试。

[本轮身份](candidate-run.json)引用[原安装收据](../2026-10-01-managed-installation-paths/candidate-install.json)：二进制 SHA256 为 `c02f1ff781b805c95891d718c40aa6fbd12a86e3432f8e11585149f4ed625504`。[453 项输入](candidate-source.json)在[最终退出核对](after-exit.json)中没有变化。本轮至 2026-10-01 17:03 正常退出，不将随后工作区修改视为此安装候选的行为。

[16:36:34 基线](data-before.json)为 36 条索引、40 个启动配置、49 项设置；[原未发字段](unsent-before.json)及[准备核对](prepared-before-run.json)保留原始摘要。[唯一目标](target.json)是此前任务自有的 OpenCode 历史：`/private/tmp/farfold-stop-queue-idn3cxh0` / `ses_f0a560db1ffeJTUeGpvCgi6hIG`，沿用已有设置及 `opencode/nemotron-3-ultra-free`。本轮未新建此对话或更换模型、来源。

## 实际观察

| 阶段             | 界面与结果                                                                                                                                                                                                                                                                                                            | 本片窗口累计 prompt |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 运行与排队       | A 执行一次 `python3 -I -B` 等待 300 秒；B 为只回复固定标记的单条待发消息。停止入口可用。见 [01](01-running-with-queued-marker.jpg) / [AX](01-running-with-queued-marker.txt)。                                                                                                                                        | 1                   |
| 暂停位置         | 审阅并暂停唯一测试目录；当前任务继续运行，B 保持 1 条，继续发送不可用。见 [02](02-pause-exact-location-review.jpg) / [AX](02-pause-exact-location-review.txt)、[03](03-location-paused.jpg) / [AX](03-location-paused.txt)、[04](04-paused-current-task-continues.jpg) / [AX](04-paused-current-task-continues.txt)。 | 1                   |
| A 自然结束       | 得到 `FARFOLD-LOCATION-PAUSE-A-20261001`；B 仍暂停，未执行停止操作。见 [05](05-task-ended-queue-still-paused.jpg) / [AX](05-task-ended-queue-still-paused.txt)。                                                                                                                                                      | 1                   |
| 正常退出与冷恢复 | 同一历史和单条 B 保留，位置策略仍为 `false`，继续发送仍不可用。见 [冷退出](cold-exited.json)、[06](06-cold-paused-queue.jpg) / [AX](06-cold-paused-queue.txt)。                                                                                                                                                       | 1                   |
| 恢复位置发送     | 策略变为 `true`，B 仍处于待发暂停状态；10.24 秒进程观察及随后协议快照没有新增 prompt。见 [07](07-location-resumed-with-queue-paused.jpg) / [AX](07-location-resumed-with-queue-paused.txt)、[观察窗口](resumed-observation-processes.json)。                                                                          | 1                   |
| 明确继续         | 点击继续后，B 派发并得到 `FARFOLD-LOCATION-RESUME-B-20261001`，临时队列清空。见 [08](08-explicit-continue-result.jpg) / [AX](08-explicit-continue-result.txt)。                                                                                                                                                       | 2                   |

计数依据依次为[暂停](protocol-paused.json)、[任务结束](protocol-after-task-ended.json)、[冷恢复](protocol-cold-paused.json)、[恢复后继续前](protocol-resumed-before-continue.json)、[明确继续后](protocol-after-explicit-continue.json)。[派生比较](comparison.json)核对前四阶段 prompt 的文件、时间及字节数相同，而不只比较数量。[最终协议快照](protocol-metadata-final.json)包含 4 个日志文件：4 次 initialize、2 次新对话准备、2 次历史读取、2 次 prompt；取消、认证及审批请求均为 0，33 条启动摘要。仅保存安全元数据，回复内容的结论来自界面观察；该有限窗口不能证明无限期不会自动发送。

[09](09-original-model-preserved.jpg) / [AX](09-original-model-preserved.txt)显示原 OpenCode Zen / Nemotron 3 Ultra Free、已有设置和 `build` 保持；随后返回原 Amp 普通空稿，[10](10-original-amp-draft-restored.jpg) / [AX](10-original-amp-draft-restored.txt)、[11](11-original-amp-medium.jpg) / [AX](11-original-amp-medium.txt)显示原 Medium 仍选中。没有向 Amp 发送消息。

## 策略、数据与退出

位置策略从[原无显式覆盖](policy-before.json)变为[暂停 `false`](policy-paused.json)，[冷恢复仍为 `false`](policy-cold-paused.json)，再变为[显式启用 `true`](policy-resumed.json)，并在[继续后](policy-after-continue.json)和[最终退出](policy-after-exit.json)保留 `true`。恢复的是启用语义，**整体策略没有逐字恢复到原值**。各阶段其他策略字段摘要一致，此位置的 OpenCode、OpenCode 默认及旧默认均没有新增覆盖。

原 `policy-paused.json` 的 `queueEntries=2` 是对队列对象两个字段计数的采集错误；真实待发消息为 1 条。原收据保留，见[更正说明](queue-count-correction.md)及[同队列摘要的形状核对](queue-shape-correction.json)，不将该错误解释为第二条消息丢失。

[派生比较](comparison.json)基于保存的原始 JSON，记录输入摘要及比较范围：[退出核对](after-exit.json)中原 36 条索引、原 40 个启动配置无缺失或改动，没有新增索引；原设置仅 `agentWorkPolicy.v1`、`unsentWork.v1` 变化。未发字段中仅本测试对话 activity 改变，原 composer、选择、文件意见、队列字段保持，无新增残留字段；最终本轮 composer 和临时队列均不存在。其他策略摘要保持。

[汇总采样](all-observed-processes.json)共有 28 个进程身份，最终均不再存在，正式应用进程列表为空；这不是全部瞬时子进程的普查。[独立原收据审查](review.md)及[队列源码只读审查](queue-review.md)分别说明证据边界；后者的 24 项既有定向测试不能替代本轮未执行的安装版队列冷编辑。

## 采集与未覆盖范围

[工具来源](helper-provenance.json)及[准备检查](preparation-checks.json)记录只读采集方式。协议窗口从本片 `data-before.json.at` 开始，仅收集完整安全白名单记录；进程观察不保证捕获全部瞬时进程。[策略采集器](inspect_policy.py)仅读目标策略和未发数量，其余内容保存摘要，不写数据库或读取凭据。派生比较没有重新执行 Agent、测试或应用。

本轮没有测试新稿同位置或其他位置发送、实际停止、审批响应、队列编辑/移除、冷编辑、强制退出；没有因暂停修改全局权限或 Agent 配置。停止按钮可用、一般工具成功及界面审批说明不构成审批旅程通过。本目录是当前活动计划的有限安装证据。
