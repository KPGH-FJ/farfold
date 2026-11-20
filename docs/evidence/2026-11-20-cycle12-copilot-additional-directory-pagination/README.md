# 第 12 周期 Copilot 另一原目录和翻页条件

2026-11-20 09:38，北京时间。macOS arm64 正式 Farfold 0.1.7，源码 `87ac54ec2`，CDHash `9547fa1f88f9ca651e857a64c14b61748e20e7c4`。沿用已有 GitHub Copilot 接入。本次补查自有、此前已完成的 B 对话 `f811816c-77cf-41d7-be83-46af51c5f621`。停止样本 A 的正文与操作均未打开。 [B 的原测试](../2026-11-18-cycle12-dirac-copilot/README.md#copilot-双前台实停)

从「所有对话 → 带入已有对话」选择 GitHub Copilot 的原目录 `/private/tmp/ff-c12-copilot-stop-qa4m_wu8/B`，只点一次「查找对话」。列表找到原标记 `FF_C12_COPILOT_EXIT_1118_B`，官方返回的位置和对话列表中的位置均为原目录，显示「已加入」，对应复选框和「加入所选」禁用。

切回「Agent 默认范围」再查一次。首屏显示 19 条，B 和独立 Copilot 成品样本 `FF_C12_N20_COPILOT_FILE` 各出现一次。页面未出现「加载更多」。现有界面有有效的下一页游标才提供该按钮，本次没有可操作的下一页，也没有实际翻页验证。 [ACP 翻页条件](https://agentclientprotocol.com/protocol/v1/session-list#pagination) · [下一页游标处理](../../../src/components/ImportConversations.tsx#L645) · [按钮显示条件](../../../src/components/ImportConversations.tsx#L1416)

| 核对原件       | 实际结果                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B 原目录列表   | `protocol-v1-1795138714429-8.jsonl`，9 行，SHA-256 `bb3cb45b06d538a7068e868f3608990fffcc23a24be8ef2bac37fadd72f6c31c`。第 8、9 行为 09:38:35.095 列表请求及成功响应。                                                                          |
| 默认范围第一页 | `protocol-v1-1795138731052-9.jsonl`，9 行，SHA-256 `ecebbd37505c6bd69dacf77107b927c0bd64dc17114dc7ab4ea4b53e2c4d781f`。第 8、9 行为 09:38:51.312 列表请求及成功响应。诊断记录只存事件类型，不含游标正文。                                      |
| B 原记录及文件 | Farfold 原 B 索引仍为 1 条，前后摘要 `ea2686b886bcf36af72da01ac6d87dff7733f2d59d4d71bdec91d7045022f748`。官方原历史 22 行，前后 SHA-256 `589410f81490761ba589b46d68acda92f91271c30216171321b7290ec62b7721`。原脚本与 36 字节结果的摘要均保持。 |

两次各一个列表请求，零打开正文、加入、新建、发送及取消。此次补齐另一已知原目录的查找和当前默认首页。实际翻页仍需已有历史自然返回下一页；更多目录及十月原样本新版续答仍按原条件。 [先前目录对照](../2026-11-20-cycle12-copilot-directory-discovery/README.md)

共用界面受控检查另行通过。`ImportConversations.scope.test.tsx` 与 `OpenedFileView.test.tsx` 共 123 条通过，其中列表检查覆盖本地筛选时保留翻页按钮、加载下一页的有效记录及跨页目录冲突。该结果按受控环境记录，Copilot 实际翻页仍待。 [受控范围](../../../src/components/ImportConversations.scope.test.tsx#L346)
