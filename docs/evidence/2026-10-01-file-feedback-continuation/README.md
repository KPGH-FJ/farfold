# 文件意见跨页、冷恢复与加入原稿

2026-10-01 15:51–16:18，复用正式候选 `61e8fb4`，没有重装或修改产品源码。**同一 OpenCode 历史中，两版本文件意见的跨页保留、正常退出后的两次冷恢复，以及明确加入原输入有限通过。** 本片没有发送意见或其他新消息，不代表 Agent 执行反馈、所有 Agent 或完整产品验收通过。

[本轮身份](candidate-run.json)引用[原安装收据](../2026-10-01-managed-installation-paths/candidate-install.json)。二进制 SHA-256 为 `c02f1ff781b805c95891d718c40aa6fbd12a86e3432f8e11585149f4ed625504`；准备时 4 个安装文件与原收据一致，[453 项源码快照](candidate-source.json)至[最终退出](after-exit.json)没有变化。本片未重新打包或运行产品检查，沿用原候选检查与[重复应用清理证明](../2026-10-01-managed-installation-paths/duplicate-app-cleanup.json)。

## 实际结果

[目标](target.json)仍是[前序产物验收](../2026-10-01-agent-artifacts/README.md)的 OpenCode 历史：工作目录 `/private/tmp/farfold-stop-queue-idn3cxh0`，native ID `ses_f0a560db1ffeJTUeGpvCgi6hIG`，原 `opencode/nemotron-3-ultra-free` / 已有设置。唯一文件为任务自有 `/private/tmp/farfold-artifact-target-54r34ch8/proof.txt`；本片没有编辑文件。

| 路径                     | 实际结果与证据                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 分别填写两个版本         | [01 最后版本](01-final-version-feedback.jpg)保存 FINAL 意见，修改后片段第 1 行；[02 较早版本](02-earlier-version-incomplete-line.jpg)保存 EARLIER 意见，修改前位置仍为未完成的 `1-`。两个 `contentId` 分别为 `23:1044074445`、`24:3909496048`，详见[冷退出前快照](before-cold-feedback.json)。不把片段位置称为完整文件行号。                                                                                                                           |
| 跨页与新稿隔离           | [03 设置返回](03-after-settings-return.jpg)及[AX](03-after-settings-return.txt)仍显示 BASE 原输入和两条意见；未完成位置的产物页“加入对话”按钮禁用。[04 新对话](04-new-draft-isolated.jpg)及[AX](04-new-draft-isolated.txt)输入为空，没有带入原对话意见。                                                                                                                                                                                               |
| 第一次冷恢复             | 正常[退出](before-cold-exit.json)并[核对结束](cold-exited.json)后重新打开同一历史，[05](05-cold-saved-feedback.jpg)及[AX](05-cold-saved-feedback.txt)显示“未发送的文件意见（2）”。[冷恢复后快照](after-cold-feedback.json)的 composer 与两条意见完整内容摘要、版本、选择和 `lineInput` 均与退出前相同。                                                                                                                                                |
| 只加入 FINAL，再次冷恢复 | 明确点击 FINAL 的“加入输入框”，[06](06-one-feedback-added.jpg)及[AX](06-one-feedback-added.txt)显示原 BASE 加一份 FINAL，EARLIER 仍独立保留。再次[正常退出](before-second-cold-exit.json)、[核对结束](second-cold-exited.json)后，[07](07-second-cold-single-insertion.jpg)及[AX](07-second-cold-single-insertion.txt)保持单份；[加入后](after-one-added-feedback.json)与[第二次冷恢复](second-cold-feedback.json)的 composer、feedback 快照完全相同。 |
| 明确加入未核对位置       | 从保留意见入口将 EARLIER 加入同一输入，[08](08-unchecked-location-preserved-in-input.jpg)及[AX](08-unchecked-location-preserved-in-input.txt)明确保留“行位置‘1-’（用户填写，尚未核对）”，没有改成已确认行号。[加入两条后的快照](after-both-added-feedback.json)中 BASE、FINAL、EARLIER 各出现一次，feedback 已空；意见仍未发送。                                                                                                                       |
| 清理本片输入并返回       | 经界面只清除本片自有输入，[09 原对话](09-original-thread-model.jpg)及[AX](09-original-thread-model.txt)显示空输入、原 Nemotron / 已有设置；[10 新空稿](10-original-new-draft-restored.jpg)、[11 Amp / Medium](11-original-amp-medium.jpg)及[AX](11-original-amp-medium.txt)记录原入口恢复。[退出后意见快照](after-exit-feedback.json)确认 composer 不存在、feedback 为空，没有新增未发键。                                                             |

[机器对比收据](feedback-comparison.json)由上述已有只读快照计算，保存输入文件摘要；两次冷恢复比较的是完整 composer/feedback 对象，观察时间不要求相同。FINAL 在加入后及再次冷开均只有一次，EARLIER 的文字摘要及未完成 `1-` 保持，直到用户另行加入。目标本轮始终 0 附件，**不能称附件保留已验证**。

## 请求、原数据与退出

[最终有限协议元数据](protocol-metadata-final.json)覆盖 6 个当前日志文件、48 条 startup 记录：6 initialize、3 session/new、3 session/load，**0 prompt、0 authenticate、0 cancel、0 permission**，拒绝记录数为 0。窗口起点为本片 [data-before.json](data-before.json) 的 15:51:49，不是复用候选的安装时间。只含窗口内完整行的有限字段，不含旋转日志或正文，不称完整协议审计。3 次 session/new 不代表新增持久历史；[最终索引核对](after-exit.json)仍为原 36 条且 `newSessions=[]`。

原 40 个启动配置保持；原 49 项设置仅 `unsentWork.v1` 摘要变化，没有新增设置。对照[原未发基线](unsent-before.json)，原 composer、choice、feedback、queues、version 均保持，仅目标对话 activity 变化。[全部阶段的只读快照](feedback-comparison.json)确认没有其他对话的未发字段变化；最终本片临时输入与意见已清除。

任务文件始终为 38 字节，SHA-256 `27fceb4d57d4e45656735aaf78d83241ac6fb729b8a730024f3b82f67f8aa80a`，与[前序最终文件](../2026-10-01-agent-artifacts/artifact-final.json)一致。16:18:41 [退出核对](after-exit.json)确认正式应用及其当前后代不存在，[累计采样](all-observed-processes.json)的 33 个 PID＋启动时间身份均已结束；只证明采样身份，不声称捕获所有瞬时进程。

未覆盖：附件保留、产物缺失时恢复、磁盘写失败、强制结束或崩溃、反馈实际发送与 Agent 执行、其他 Agent/其他对话的同名文件意见。未降低这些出口，也不将本片补验当作新的功能实现。

## 准备与采集来源

[工具来源](helper-provenance.json)、[准备检查](preparation-checks.json)及[意见检查](feedback-inspection-checks.json)保留实际验收前的准备事实，不代表彼时已经执行界面旅程。数据库采集均使用 `mode=ro`；[inspect_feedback.py](inspect_feedback.py)只记录精确测试对话的本次标记、内容摘要、版本、位置及附件数量，其他未发内容只有摘要。源码核验、进程采样与[协议采集](collect_protocol.py)没有写数据库、读取凭据或修改外部 Agent 配置。
