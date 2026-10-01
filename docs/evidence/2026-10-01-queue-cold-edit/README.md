# 队列冷编辑：实际安装补验

2026-10-01 21:11，复用正式 `6064d05`，完成原 OpenCode 测试历史的两条待发消息、独立编辑稿和主输入的正常退出冷恢复、准确目标保护及明确重选保存。原 Nemotron / 已有设置 / build 保持；最后仅清本片文字和队列，返回原 Amp / Medium 空稿。见[实际记录](installed.md)与[56 项派生核对](comparison-final-stages.json)。本片有 **1 次真实 prompt（A）**，B/C 未发送；没有源码变化、重装或重复工程测试。

## 实际路径

[原安装收据](../2026-10-01-client-settings-data-preservation/candidate-install.json)与[本片复用核对](candidate-reuse.json)记录候选 `6064d05`（含 `bd65145`），二进制 `832a6c7f3c4421c01dec91584afdc029320a4362cfb22468765c93fedc63ff49`。[455 项输入](candidate-source.json)至[最终退出](after-exit.json)保持。20:46:02 的[本片基线](data-before.json)为原 36 索引、40 Agent、49 设置；[目标初始状态](queue-before.json)中主输入、编辑稿和本片队列均不存在，没有覆盖旧内容。[target.json](target.json)的准备值由以下实际收据补充，不改写原准备状态。

| 阶段             | 实际结果                                                                                                        | 证据                                                                                                                                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原历史与选择     | 打开同一测试历史，原 OpenCode Zen/Nemotron 3 Ultra Free、已有设置与 build 保持                                  | [01](01-original-history.jpg) / [AX](01-original-history.txt)、[02](02-original-model.jpg) / [AX](02-original-model.txt)                                                                                                                                                                             |
| A 运行与队列暂停 | 明确执行一次请求中为 120 秒的等待 A；运行时加入 B 并立即开始编辑以暂停队列。A 自然完成后加入 C，主输入保留 BASE | [03](03-two-paused-items-with-main-draft.jpg) / [AX](03-two-paused-items-with-main-draft.txt)                                                                                                                                                                                                        |
| 未保存编辑稿     | 原队列仍为 B/C，编辑稿为 B_EDIT，主输入为 BASE；没有保存编辑稿后正常退出                                        | [04](04-unsaved-edit-before-cold.jpg) / [AX](04-unsaved-edit-before-cold.txt)、[冷前](before-cold.json)、[退出](cold-exited.json)                                                                                                                                                                    |
| 冷恢复保护       | 三对象摘要完全保持；编辑稿仍在，无法确认原待发目标，保存禁用，队列继续暂停                                      | [05](05-cold-editor-preserved-stale.jpg) / [AX](05-cold-editor-preserved-stale.txt)、[冷后](after-cold.json)                                                                                                                                                                                         |
| 加入输入框       | 本次 B_EDIT 仅追加一份到 BASE；清编辑稿，原 B/C 队列不动                                                        | [06](06-cold-edit-kept-in-main-draft.jpg) / [AX](06-cold-edit-kept-in-main-draft.txt)、[持久核对](after-keep.json)                                                                                                                                                                                   |
| 明确重选 B 保存  | 重新选中当前第一项 B，保存 B_EDIT；只替换第一项，C 和主输入摘要不变，编辑稿清除，队列仍暂停                     | [07](07-explicit-reselection-saved-paused.jpg) / [AX](07-explicit-reselection-saved-paused.txt)、[保存后](after-explicit-save.json)                                                                                                                                                                  |
| 清理与退出       | 未点击“继续发送”，仅清自有待发条目及文字，返回原 Amp / Medium 空稿，正常退出                                    | [08](08-test-drafts-and-queue-cleared.jpg) / [AX](08-test-drafts-and-queue-cleared.txt)、[09](09-original-amp-empty-draft.jpg) / [AX](09-original-amp-empty-draft.txt)、[10](10-original-amp-medium.jpg) / [AX](10-original-amp-medium.txt)、[清理后](after-cleanup.json)、[退出后](after-exit.json) |

冷恢复保存禁用是准确目标保护，并非编辑内容丢失：存储保留原内容与位置，不恢复进程内对象身份，也没有按文本或下标猜测要覆盖的条目。本次“加入输入框”后通过明确重选取得当前目标，再保存。07 的队列预览被截断，完整 B_EDIT 及 C/主输入保持由持久收据核对，不只依靠预览文字。

## 数据与观察边界

[阶段核对](comparison-final-stages.json)从保存的白名单收据派生，56/56 项通过，原三对象冷前后摘要相同；不是 56 项工程测试，也不能单凭摘要证明运行时暂停。[05–07](05-cold-editor-preserved-stale.jpg)的界面提示与按钮共同证明本次暂停/目标保护；[比较检查来源](comparison-checks.json)保留原记录。[inspect_queue.py](inspect_queue.py)与[comparison.py](comparison.py)没有在本次文档收口中重新执行或修改。

[最终核对](after-exit.json)：原 36 索引和基线 40 Agent 行摘要保持，无新增索引；49 项原设置仅 `unsentWork.v1` 变化，限目标对话 activity。原版本、主输入、选择、意见及旧队列字段保持，无新增未发根字段或容器键残留。原 Agent 比较没有当前总数/新增行统计，不扩大为全表结论。[6 个采样身份](all-observed-processes.json)均结束，455 输入与正式二进制保持。

[最终协议元数据](protocol-metadata-final.json)为 4 个当前日志文件、32 条 startup 摘要：4 initialize、2 new、2 load、**1 prompt**、9 response、135 update、2 stderr 字节标记；0 authenticate/cancel/permission，0 被拒绝记录。冷前、冷后、明确保存和清理后累计始终是同一条 prompt，B/C 没有因完成 A、冷恢复、加入输入框或保存而发送。日志采集从本片基线起计，仅当前完整 `.jsonl` 行，不读正文、stderr 或轮转副本；工具来源见 [helper-sources.json](helper-sources.json)。32 是快照数，6 是有限采样身份数，不是全部瞬时子进程统计。

本片只通过同一原对话的纯文本队列冷编辑、三对象保留、不可确认目标时禁存、加入主输入和明确重选第一项保存。没有点击“继续发送”，不证明 B/C 发送/回复；附件、未知结果队列、保存失败、强制终止、实际停止、取消编辑及其他 Agent 的同类路径均未测。账号与最终同候选全目录验收仍开放。

源码与既有受控依据：[Composer](../../../src/components/Composer.tsx)、[queue_edit](../../../src/runtime/queue_edit.ts)、[sessions](../../../src/runtime/sessions.ts)、[drafts](../../../src/runtime/drafts.ts)、[draft_storage](../../../src/runtime/draft_storage.ts)、[对象身份用例](../../../src/runtime/queue_edit.test.ts)及[队列用例](../../../src/runtime/sessions.queue-edit.test.ts)。本次是既有候选的安装补验，未改实现或重复运行这些测试；前序[位置暂停](../2026-10-01-location-send-pause/README.md)与[附件缺失](../2026-10-01-missing-attachment-recovery/README.md)仍按各自候选和范围保留。
