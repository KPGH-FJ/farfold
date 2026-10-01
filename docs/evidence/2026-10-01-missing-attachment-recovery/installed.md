# 单文本附件缺失与恢复：正式安装记录

截至 2026-10-01 20:21，复用正式 `6064d05`（含 `bd65145`），未重装或重新构建。二进制 `832a6c7f3c4421c01dec91584afdc029320a4362cfb22468765c93fedc63ff49` 与[原安装](../2026-10-01-client-settings-data-preservation/candidate-install.json)一致，[复用核对](candidate-reuse.json)和[最终退出](after-exit.json)记录 455 个输入未变。工程检查属于原候选，本片未重新执行。以下是一个文本草稿附件的有限旅程，不是图片、排队内容或消息交付验收。

## 界面与文件

[01](01-original-draft.jpg) / [AX](01-original-draft.txt)为 Amp / Medium / 已有设置的原空稿。[02](02-draft-with-local-attachment.jpg) / [AX](02-draft-with-local-attachment.txt)添加任务自有 `attachment-proof.txt` 和 `FARFOLD-ATTACHMENT-DRAFT-20261001`，未发送。[正常退出](cold-exited.json)后，20:01:47 的 [hide 收据](file-hide.json)将原文件改名到同一任务目录的备用路径。实际操作脚本为 [move_attachment.py](move_attachment.py)，范围来自 [target.json](target.json)；源文件为 74 字节，移动前后 SHA 一致，没有删除正文。

[03](03-cold-retained-unchecked.jpg) / [AX](03-cold-retained-unchecked.txt)冷启动保留文字及附件，显示“核对恢复的附件”且发送禁用。保持附件勾选并核对后，[04](04-missing-file-read-failed.jpg) / [AX](04-missing-file-read-failed.txt)实际显示 `无法读取“attachment-proof.txt”，请取消勾选或重新选择附件。`，这是一次真实缺失读取失败。随后“稍后处理”→设置→继续草稿，[05](05-failed-attachment-retained-after-navigation.jpg) / [AX](05-failed-attachment-retained-after-navigation.txt)仍保留文字和附件，发送禁用；[中间核对](after-missing-check.json)仅新增本片 `composers.new`，所有原未发字段不变。

20:06:20 的 [restore 收据](file-restore.json)恢复同一 74 字节文件。明确重新核对后，[06](06-restored-file-check-succeeded.jpg) / [AX](06-restored-file-check-succeeded.txt)显示“附件已核对，已保留你的选择。”，原文字/附件仍在，发送入口可用但没有点击。最后只经 UI 清除本片文字和附件，[07](07-original-empty-draft-restored.jpg) / [AX](07-original-empty-draft-restored.txt)恢复 Amp / Medium 空稿且发送禁用；局部核对成功提示仍在，不声称所有提示消失。

[最终文件](file-final.json)记录原路径恢复，备用路径不存在，74 字节与 SHA `cdedf393b059ff450d8dbafe90845eb6d8c79f023d31a3f5798e74975a25934b` 保持；旧 38 字节 proof 的匹配检查也通过。文件仍留在任务自有目录，UI 附件清理不等于删除该目录。

## 数据、协议与回收

[基线](data-before.json)与[未发摘要](unsent-before.json)分别为原 36 索引、40 Agent、49 设置和原未发字段。[原稿清理后](after-restoration.json)与 20:21:11 的[退出回执](after-exit.json)均记录：原索引/Agent/设置摘要无变化，索引仍 36 且无新增，设置无新增，原未发字段与形态保持且无新增根字段或容器键。原 Agent 比较只证明基线 40 行保持，回执没有当前 Agent 总数/新增行统计。[派生核对](comparison.json)保留输入摘要和这些有限判定。

[4 个采样身份](all-observed-processes.json)在最终回执中均不存在，正式应用及其后代采样为空。这是 PID/启动时间的采样范围，不声称捕获全部瞬时子进程。一次采集误用了不存在的 `all-observed.json`，在读取参数文件处失败，没有产出 after-exit 或执行协议采集；以更正为 `all-observed-processes.json` 后的成功回执为准。

[协议采集](protocol-metadata-final.json)窗口从本片基线 `1790854332693` 至 `1790857271723`，仅当前完整 `.jsonl` 行，2 文件、0 拒绝记录。实际分类为：

| 分类                                                          |          数量 |
| ------------------------------------------------------------- | ------------: |
| v2 startup 摘要                                               |            16 |
| out initialize / session/new                                  |         2 / 2 |
| in response / session/update                                  |         4 / 2 |
| err other（stderr 字节标记）                                  |             2 |
| out prompt / authenticate / cancel / session/load             | 0 / 0 / 0 / 0 |
| session/request_permission / set_config_option / session/list |     0 / 0 / 0 |

两个文件的最终摘要都记录 initializeAccepted、childReaped、groupEnded、connectionRemoved 为 true，TERM 请求与 signal 15；16 是状态快照数，不是 16 个进程。不存在协议错误记录，stderr 标记不含正文，也不能据此推断零外部活动或账号状态。

本片只计正常退出后的单文本草稿附件缺失检查、失败保留、原文件恢复重核及自有输入清理通过。图片、排队附件、文件内容改变、权限拒绝、保存失败、强制终止、发送/回复及认证均未测；账号与最终同候选全目录验收继续开放。
