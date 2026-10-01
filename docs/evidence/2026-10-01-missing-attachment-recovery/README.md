# 冷恢复附件缺失：实际安装补验

2026-10-01 20:21，复用已安装 `6064d05`，完成一个任务自有文本草稿附件的正常退出冷恢复、缺失检查失败、换页保留及原文件恢复后重试。Amp / Medium / 已有设置保持；只移除本片文字和附件，原空稿恢复。见[实际记录](installed.md)与[派生核对](comparison.json)。本片没有重新构建、安装或发送消息。

[原安装收据](../2026-10-01-client-settings-data-preservation/candidate-install.json)与[本片复用核对](candidate-reuse.json)确认二进制为 `832a6c7f3c4421c01dec91584afdc029320a4362cfb22468765c93fedc63ff49`；[455 个输入](candidate-source.json)至最终退出未变。19:32:12 的[基线](data-before.json)记录原 36 个索引、40 个 Agent、49 个设置，[未发字段](unsent-before.json)只保存摘要。最终[退出核对](after-exit.json)确认原字段完全保持、无新增索引/设置/未发键残留，4 个采样身份均结束；原 Agent 比较只覆盖基线 40 行，不据此宣称全表没有新增行。

## 实际路径与证据

| 阶段               | 实际结果                                                            | 证据                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原空稿与添加       | Amp / Medium 空稿，添加 `attachment-proof.txt` 及本片文字，未点发送 | [01](01-original-draft.jpg) / [AX](01-original-draft.txt)、[02](02-draft-with-local-attachment.jpg) / [AX](02-draft-with-local-attachment.txt)                                        |
| 正常退出后暂移文件 | 同目录精确改名，原路径缺失；74 字节与原 SHA 保持                    | [冷退出](cold-exited.json)、[移走收据](file-hide.json)                                                                                                                                |
| 冷恢复与缺失核对   | 文字/附件保留，发送禁用；保持勾选核对后明确显示无法读取             | [03](03-cold-retained-unchecked.jpg) / [AX](03-cold-retained-unchecked.txt)、[04](04-missing-file-read-failed.jpg) / [AX](04-missing-file-read-failed.txt)                            |
| 稍后处理与换页返回 | 文字/附件仍保留，继续待核对，发送仍禁用                             | [05](05-failed-attachment-retained-after-navigation.jpg) / [AX](05-failed-attachment-retained-after-navigation.txt)、[中间数据](after-missing-check.json)                             |
| 原文件恢复与重核   | 同一 74 字节文件恢复原路径；明确重新核对成功，文字/附件仍在，未发送 | [恢复收据](file-restore.json)、[06](06-restored-file-check-succeeded.jpg) / [AX](06-restored-file-check-succeeded.txt)                                                                |
| 自有输入清理与退出 | 经 UI 移除本片文字/附件，原空稿恢复；文件留在原路径，旧 proof 匹配  | [07](07-original-empty-draft-restored.jpg) / [AX](07-original-empty-draft-restored.txt)、[恢复核对](after-restoration.json)、[最终文件](file-final.json)、[最终退出](after-exit.json) |

精确文件范围由 [target.json](target.json)记录。实际移动使用 [move_attachment.py](move_attachment.py)，两次操作分别保留 [hide](file-hide.json) / [restore](file-restore.json)回执，未使用旧 README 的建议命令。最终原文件 74 字节，SHA-256 为 `cdedf393b059ff450d8dbafe90845eb6d8c79f023d31a3f5798e74975a25934b`，备用路径不存在；UI 清除附件不等于删除任务自有临时目录。07 局部“附件已核对”提示仍可见，不称所有提示消失。

## 结论范围

[协议元数据](protocol-metadata-final.json)从本片基线时间起计至退出，2 个文件包含 16 条启动摘要、2 initialize、2 session/new、4 response、2 session/update 及 2 条 stderr 字节标记；0 prompt/authenticate/cancel/load/permission。摘要条数不是进程数，stderr 只记录字节标记，不推断正文。当前 `.jsonl` 的有界采集不等于全部轮转日志审计；采集来源见 [helper-sources.json](helper-sources.json)。

本片只证明一个本地文本草稿附件在正常退出冷恢复时缺失、检查失败后保留和同文件恢复后重试通过。图片、队列附件、内容变化、发送中/未知结果、权限拒绝、写入失败和强制退出均未测；没有登录、首发或续答结论。下一片队列冷编辑准备中，账号与最终同候选全目录验收仍开放。

源码入口为 [AttachmentRecovery](../../../src/components/AttachmentRecovery.tsx)、[attachment_review](../../../src/runtime/attachment_review.ts)、[draft_attachments](../../../src/runtime/draft_attachments.ts)、[drafts](../../../src/runtime/drafts.ts)与 [Composer](../../../src/components/Composer.tsx)。这是既有候选的实际补验，本片没有改源码或复跑未变工程检查；准备阶段原回执保持，后续实际结果以以上链接为准。
