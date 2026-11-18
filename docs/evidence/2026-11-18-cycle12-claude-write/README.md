# 第 12 周期 Claude 官方 Write 交付与冷开

2026-11-18，macOS arm64，正式 Farfold `98d365c08`（0.1.7，CDHash `a373426cac1c3553e6b772ffaf423f1bed7303c6`），Claude Agent ACP 0.107.0，Claude Code 2.1.323。自有空目录 `/private/tmp/ff-c12-claude-write-n18.3qlz13my` 的目标为 `result.txt`。预计 UTF-8 共 71 字节，两行及末尾 LF：

```text
FF_C12_CLAUDE_WRITE_2013
验收：内容原样，末尾保留换行。
```

## 正式创建与单次批准

20:04:24 从 Farfold「新对话」选 Claude，使用「已有设置」及原小米 `mimo-v2.6-flash (haiku)`，只发一条测试指令。Claude Code 原记录在 20:04:28 提出一次 Write `call_6b4442b61a3546db9272c799`，原 ID 为 `908bce92-4953-4fef-96c3-b8b0d9515bbf`，模型字段 `mimo-v2.6-flash`。

审批时目标尚不存在。从 Farfold 审批卡核明路径，并用该自有会话的原工具参数核实预期字节。20:05:22 只选单次「批准」。原工具同 ID 报告成功，回复完成。直接从处理过程的 Write 工具行点击路径，文件区显示计划的两行。创建后的磁盘内容与预期逐字节一致。

## 同一对话冷开与原步骤打开

先关闭文件区，再正常保存退出，20:06:11 观察到原应用进程已结束。重新打开同一正式版，从侧栏找到同一对话，展开「查看处理过程」。在「技术详情」核对原步骤标题为 `Write result.txt`，随后收起详情，从原工具主行点击绝对文件路径。Farfold 原文预览显示两行内容、唯一验收标记及完整文件另存入口。

| 核对项   | 写完后与冷开点击后                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原会话   | Farfold 唯一索引、创建时间及 Claude Code 唯一原记录相同                                                                                                 |
| 原工具   | 原记录各只含上述一次 Write 调用和同 ID 成功结果                                                                                                         |
| 文件     | 同路径，71 字节，SHA-256 `fa66f4cebb90e9d5bbab7f56c8c5348c2faea019df1e9638105a94f32949ff61`                                                             |
| 磁盘身份 | 同 inode 15717936，修改时间 `1795003522186078532` 纳秒一致                                                                                              |
| 正式协议 | `protocol-v1-1795003437416-1.jsonl` 一次新建、一次手动发送、一次权限请求。冷开 `protocol-v1-1795003583579-0.jsonl` 一次加载、零新建、零发送、零权限请求 |

用户从原 Write 工具的位置直达当前磁盘文件。官方 Write 报告位置及差异，Farfold 的原工具位置按钮用于打开该位置。此样本只覆盖一次单次批准及新建成品的历史直达。已有文件覆盖、取消失败、其他工具或其他格式按原条件继续。 [官方 Write 实现](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.0/src/tool-calls/reporters/file-edit.ts#L25-L64) · [Farfold 文件位置](../../../src/components/thread-items.tsx) · [原 Bash 及 Read 独立证据](../2026-11-18-cycle12-claude-pair-stop/README.md#b-通过官方-read-冷开直达同一成品)

测试目录保留原文件，冷开核对后保存一份逐字节相同的[成品证据](fixture/result.txt)。

小米同一脱敏 Key 的日用量在 20:03:26 为 15 次、153,421 Token、¥0.040746，20:07:02 为 19 次、191,851 Token、¥0.052737。同期其他 Key 有活动。日用量只给窗口合计，实测模型以本次 Write 原生记录确认，Farfold 手动请求数以正式协议核对。 [小米日用量口径](https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get)
