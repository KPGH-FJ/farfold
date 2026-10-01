# 文件意见续接的独立证据复核

复核正式 `61e8fb4` 的本次跨页、两次正常退出后的冷恢复、明确加入原输入及收尾。仅核对本目录的原始收据、界面文本、02/04/05/07/08/11 截图和检查工具源码，并终审[README](README.md)与[派生对比](feedback-comparison.json)；派生收据列出的 9 个输入文件摘要全部匹配。未运行应用、Agent、Cargo 或证据工具，未读取正式数据库、用户凭据或原始协议正文。只新增本文。

结论：实际证据支持本条 OpenCode 测试历史的有限文件意见旅程通过，未发现需要改源码的证据矛盾。未完成行位置以未核对的用户文字保留和加入，没有被当作有效范围；本片始终未发送意见给 Agent。

## 两个内容版本与明确移入

[精确目标](target.json)在准备时没有保存的输入、意见、附件或队列，仍使用原 OpenCode / Nemotron / 已有设置。两条意见对应同一个自有文件的不同内容标识，不能把片段坐标称为文件中的真实行号。

| 核对点           | 原始证据与实际范围                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前与较早版本   | [01](01-final-version-feedback.txt)的最终片段选择为修改后第 1 行；[02](02-earlier-version-incomplete-line.jpg)较早片段保存 `1-`、修改前，直接“加入对话”禁用。两个内容标识分别为 `23:1044074445` 和 `24:3909496048`，没有被覆盖成同一条意见。                                     |
| 跨页保留         | [03](03-after-settings-return.txt)仍保留较早意见及 `1-`；[04](04-new-draft-isolated.jpg)新对话为空白 Amp 草稿，不含本条测试标记。                                                                                                                                                |
| 第一次冷恢复     | [before-cold-feedback](before-cold-feedback.json)与[after-cold-feedback](after-cold-feedback.json)的输入快照摘要、两意见的条目键摘要、文字摘要、contentId、scope、selection 和 lineInput 全部一致。[05](05-cold-saved-feedback.txt)实际显示两条保留意见及未核对说明。            |
| 只移入第一条     | [after-one-added-feedback](after-one-added-feedback.json)的输入含 BASE、FINAL 各一次，176 字符；仅移除 FINAL 意见，EARLIER 的文字、版本与未完成位置保持。[06](06-one-feedback-added.txt)显示原 BASE 和最终意见同在输入框。                                                       |
| 第二次冷恢复     | [second-cold-feedback](second-cold-feedback.json)的 176 字符输入全文摘要及完整输入快照摘要与移入后一致；只剩 EARLIER 意见。[07](07-second-cold-single-insertion.jpg)支持恢复没有自动再次追加已移入意见。此证据不是重复点击压力测试。                                             |
| 再移入未完成位置 | [08](08-unchecked-location-preserved-in-input.jpg)明确保留“当时查看的内容”和 `行位置“1-”（用户填写，尚未核对）`。[after-both-added-feedback](after-both-added-feedback.json)输入含三个不同标记各一次、329 字符，保留意见集合为空。只能计用户文字的诚实带入，不能计有效范围核验。 |

AX 会在输入控件值及其子节点重复表示同一文字，不能用全文搜索次数判重复插入。上述单次标记结论取自检查工具对实际输入值的 marker 列表和全文摘要，并与截图相互核对。

## 原数据与本次新增内容清理

[inspect_feedback.py](inspect_feedback.py)分别记录原字段变化和 `addedFieldKeys`。仅看 `changedOrMissingOriginalFields` 为空，不能证明本轮新增输入或意见已被移除：这些键在基线里原本不存在。

[after-exit-feedback.json](after-exit-feedback.json)同时证明目标输入不存在、意见为空、所有 `addedFieldKeys` 为空；因此本次自有新增输入与意见已清理。所有阶段 `unexpectedUnsentChanges` 为空，原字段只有本条目标的 activity 变化；原选择、其他意见、队列、输入及版本保持。这里的 `onlyTargetUnsentChanges` 只是在原摘要和新增键范围内的核对，不代表所有外部 Agent 数据或秘密的审计。

[最终退出](after-exit.json)中原 36 条索引、40 个启动配置保持，无新增索引/设置；原 49 项设置只 `unsentWork.v1` 变化。453 个源码输入和正式二进制摘要保持。目标文件在各检查收据中仍为 38 字节、准备时的同一摘要，本片没有实际文件修改；[09](09-original-thread-model.txt)、[10](10-original-new-draft-restored.txt)及[11](11-original-amp-medium.jpg)分别支持原模型、原全局空稿和 Amp / Medium 保持。

## 发送与退出边界

重新汇总[脱敏协议](protocol-metadata-final.json)：窗口来自本次 `data-before.json`，6 个文件、48 条启动摘要，6 initialize、3 session/new、3 session/load，0 prompt / authenticate / cancel / permission。这些加载请求说明本轮不是 initialize-only；没有新 prompt，不将屏幕中的前序回复算作本轮回复。采集只覆盖窗口内新日志的完整行，不含旋转日志，也不代表完整协议审计。

[第一次退出](cold-exited.json)、[第二次退出](second-cold-exited.json)及最终退出均无应用和当前后代；最终[33 个采样身份](all-observed-processes.json)按 PID 与启动时间核对均已结束，不声称捕获全部瞬时进程。

[candidate-run.json](candidate-run.json)的 `uiJourneyExecuted:false` 是 15:53 准备阶段的固定记录，实际执行结论来自其后的界面与最终收据；本轮复用已安装候选，没有重新安装。通过范围不扩大到意见发出后的执行效果、其他 Agent、强制崩溃或持久化写失败。
