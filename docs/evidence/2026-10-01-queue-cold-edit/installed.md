# 队列冷编辑与明确重选保存：正式安装记录

2026-10-01 20:46–21:11，复用唯一 `/Applications/Farfold.app` 的 `6064d05`（含 `bd65145`），二进制 `832a6c7f3c4421c01dec91584afdc029320a4362cfb22468765c93fedc63ff49`，见[本片复用](candidate-reuse.json)与[原安装](../2026-10-01-client-settings-data-preservation/candidate-install.json)。[455 项输入](candidate-source.json)至退出未变。本轮没有重装、源码改动或重复工程测试。

## 原目标与真实操作

目标是[既有 OpenCode 测试历史](target.json)，工作位置 `/private/tmp/farfold-stop-queue-idn3cxh0`，原 `opencode/nemotron-3-ultra-free` / 已有设置 / build。[01](01-original-history.jpg) / [AX](01-original-history.txt)恢复原正文，[02](02-original-model.jpg) / [AX](02-original-model.txt)明确显示完整模型/来源和模式。[初始队列核对](queue-before.json)中本目标的主输入、队列与编辑稿都不存在，其他原内容仅对比摘要。

A 是本轮唯一明确发送的请求，要求单次 `python3 -I -B -c 'import time; time.sleep(120); print("FARFOLD-QUEUE-COLD-A-20261001")'`，不读取/修改文件、不重试。A 运行时将本片 B 加入待发并立即进入编辑以暂停队列；A 自然完成后加入 C。[03](03-two-paused-items-with-main-draft.jpg) / [AX](03-two-paused-items-with-main-draft.txt)显示 A 的准确标记及“已完成”、B/C 两项、主输入 BASE 与暂停状态；没有停止 A，也没有批准请求。

[04](04-unsaved-edit-before-cold.jpg) / [AX](04-unsaved-edit-before-cold.txt)中的编辑稿改为 B_EDIT，但没有点保存。20:58:29 的[冷前收据](before-cold.json)分别保存三个对象：主输入 BASE、编辑稿 B_EDIT（原目标第一项 B）、原 B/C 顺序队列；附件均为 0、没有待提交发送。21:00:26 的[正常退出核对](cold-exited.json)保留这些自有记录。

## 冷恢复、加入主输入与明确保存

[05](05-cold-editor-preserved-stale.jpg) / [AX](05-cold-editor-preserved-stale.txt)冷恢复后仍显示 B_EDIT，保存入口禁用并说明：“无法确认原待发消息，编辑内容仍保留。可将它加入输入框；待发队列继续暂停。”[冷后收据](after-cold.json)中主输入、编辑稿与队列的完整摘要均与冷前相同。禁存符合准确目标保护，不以相同下标/文字代替进程内对象身份。

本次点“加入输入框”后，[06](06-cold-edit-kept-in-main-draft.jpg) / [AX](06-cold-edit-kept-in-main-draft.txt)主输入为 BASE+B_EDIT，两个标记各一份；原队列仍 B/C。[after-keep.json](after-keep.json)证明编辑稿清除，队列摘要完全不变，没有发送。

随后明确重新选择第一项 B 的编辑入口，填同一 B_EDIT 并保存。[07](07-explicit-reselection-saved-paused.jpg) / [AX](07-explicit-reselection-saved-paused.txt)显示第一项改变、第二项 C 保持、主输入仍 BASE+B_EDIT、队列仍暂停。“继续发送”入口可见但没有点击。[保存收据](after-explicit-save.json)证明只有第一项完整正文/块摘要改变，第二项 C 与主输入摘要逐字一致；编辑稿清除，`uncertainIndex` 仍 null。队列预览截断处不作为完整正文证明。

[56 项阶段核对](comparison-final-stages.json)全部通过，输入摘要均指向现存原回执，覆盖三对象冷保持、各一次追加、只改第一项、C/主稿保留及最后清理。这是保存收据的派生校验，不是新运行的产品测试；运行时暂停与保存禁用仍以界面为证。此文档收口没有改动或执行 [comparison.py](comparison.py) / [inspect_queue.py](inspect_queue.py)。

## 自有清理、原数据与退出

没有点击继续发送。只移除本片 B_EDIT/C 两条待发及 BASE/B_EDIT 主输入，[08](08-test-drafts-and-queue-cleared.jpg) / [AX](08-test-drafts-and-queue-cleared.txt)原对话主输入/队列清空，A 的真实历史保留；[清理收据](after-cleanup.json)中的三个对象均回到初始不存在状态。[09](09-original-amp-empty-draft.jpg) / [AX](09-original-amp-empty-draft.txt)返回 Amp 普通空稿，[10](10-original-amp-medium.jpg) / [AX](10-original-amp-medium.txt)明确 Medium 保持，没有选择另一个模型。

[本片基线](data-before.json)为原 36 索引、40 Agent、49 设置。[21:11:26 退出核对](after-exit.json)记录原索引及 Agent 行保持、无新索引；原设置仅 `unsentWork.v1` 变化，限目标对话 activity，原版本/主输入/选择/意见/队列字段保持，无新增未发根或容器键残留。这里没有宣称 activity 逐字恢复，也不将基线 40 Agent 行保持扩大为全表无新增。[6 个采样身份](all-observed-processes.json)均不在，正式应用后代采样为空；短等待工具进程未被这份采样单独覆盖，不声称全部瞬时进程清点。

## 协议与未测范围

[最终安全元数据](protocol-metadata-final.json)窗口为本片基线 `1790858762143` 至 `1790860286797`，4 个当前日志、32 条启动摘要、0 拒绝记录。实际分类：

| 记录                                                       |      数量 |
| ---------------------------------------------------------- | --------: |
| out initialize / session/new / session/load                | 4 / 2 / 2 |
| out session/prompt                                         |     **1** |
| in response / session/update                               |   9 / 135 |
| err other（stderr 字节标记）                               |         2 |
| authenticate / session/cancel / session/request_permission | 0 / 0 / 0 |
| session/set_config_option / session/list                   |     0 / 0 |

[冷前](protocol-before-cold.json)、[冷后](protocol-after-cold.json)、[明确保存后](protocol-after-explicit-save.json)、[清理后](protocol-after-cleanup.json)到最终退出始终只有同一条出站 prompt；不将旧正文回放中的历史请求算作本次发送。四个最终启动摘要均 accepted、childReaped、groupEnded、connectionRemoved，TERM 请求与 signal 15；32 是状态快照数。日志仅当前完整行和固定元数据，stderr 只计字节，不能推断正文；没有全轮转日志或全部外部行为审计。

本片通过正常退出冷恢复的纯文本队列编辑保留、目标不明确时禁存、加入主输入和明确重选第一项保存；B/C 没有实际发送/回复。附件队列、未知结果、保存失败、强杀、实际停止、取消编辑和其他 Agent 同类旅程未测，不由本片扩大结论。账号与最终同候选全目录验收继续开放。
