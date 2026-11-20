# 第 12 周期不可写目标后的另存恢复

2026-11-20，北京时间。正式 Farfold `72e971df5`（0.1.7），macOS arm64，主进程 19119，CDHash `5bf21663b6f7caa4e341c9ebc4476d60bb4e299c`。沿用 Claude 与 Copilot 已经完成的原成品。从各自原对话走正常文件区。两个同名源均为 `result.txt`，每次目标都是该测试独有的目录。 [原成品与另存证据](../2026-11-20-cycle12-same-name-delivery-copy/README.md)

准备目录位于 `/private/tmp/ff-c12-n20-unwritable-save-xl42g1by/{claude,copilot}/{readonly,recovered}`。两份不可写目录权限均为 `0555`，各有一份原 `existing-saved.txt`。据同一用户试写，同名目标尚不存在且创建因权限被拒。两份恢复目录均可写且起始为空。试前记录 `fixture-before.json` SHA-256 为 `2a5f3bd55cc244347218af2c031eae9edb384765915dd7755eb23ec9fb643e69`。

## 从实际写入失败恢复并打开正确副本

1. **Claude。** 普通搜索打开 `FF_C12_CLAUDE_WRITE_CASE`，原会话 `908bce92-4953-4fef-96c3-b8b0d9515bbf`。通过原 Write 步骤的精确位置打开 71 字节成品。从「完整文件另存为…」选择自己分支的 `readonly/result.txt`。本次 11:07:58.954 系统另存窗口的「保存」可用并完成派发。Farfold 显示该确切目标的保存记录，随后显示「此次保存未完成。无法写入目标位置。」及 `0 / 71 字节`。从原预览再次另存一次，到自己的 `recovered/result.txt`。11:08:18.107 点保存，完成后显示 `71 / 71 字节` 和「完整文件副本已保存。」11:08:32.762 从该记录点一次「打开副本」，macOS 默认「文本编辑」实际打开 `file:///private/tmp/ff-c12-n20-unwritable-save-xl42g1by/claude/recovered/result.txt`，可见 `FF_C12_CLAUDE_WRITE_2013` 与「验收：内容原样，末尾保留换行。」。
2. **Copilot。** 普通搜索打开 `FF_C12_N20_COPILOT_FILE`，原会话 `129d85c1-6bd6-408f-a6b4-2b776ccc7704`，从原回复的 `./result.txt` 打开 45 字节成品。11:09:13.048 系统另存窗口的「保存」可用，派发到 Copilot 自己的 `readonly/result.txt`。Farfold 的记录先进入保存，再显示相同写入失败及 `0 / 45 字节`。11:09:32.970 改选自己的 `recovered/result.txt` 另存一次，完成后显示 `45 / 45 字节` 和保存成功。11:09:37.653 点对应记录的「打开副本」，「文本编辑」实际打开 `file:///private/tmp/ff-c12-n20-unwritable-save-xl42g1by/copilot/recovered/result.txt`，可见 `Farfold Copilot delivery sample` 与 `alpha: ready`。

## 原件和副本核对

两次错误均实际到达 Farfold 保存任务，准确显示无法写入。各自不可写目录仍只保留原 `existing-saved.txt`，两处都没有新目标或临时文件。两份源文件和两份既有标记的设备号、inode、权限、纳秒修改时间、长度及 SHA-256 均保持。

另一次独立磁盘核查实读了原件、两个预置文件和两个恢复副本，确认失败目录清单与试前一致，恢复目录各含一份逐字节相等的新副本。 [磁盘核验](observations.json)

| 样本    | 恢复目录副本          | 副本 inode | 与原成品逐字节一致的 SHA-256                                       | 不可写目录既有文件 SHA-256                                         |
| ------- | --------------------- | ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Claude  | `result.txt`，71 字节 | `16555463` | `fa66f4cebb90e9d5bbab7f56c8c5348c2faea019df1e9638105a94f32949ff61` | `d1e8a75e4ce77c54ab962b9fedda980dd470747e61ef3a3412b66d0ad136101c` |
| Copilot | `result.txt`，45 字节 | `16556199` | `ff9ec757a550a684b40a55662307ec2de17146b27d81a070ce40d2e074190cdd` | `1a6bae9d131a04383cce81f273f312e829c463f9ffbaa934fd54bdf30bdfcc58` |

从正式保存记录打开的两个文稿均未编辑。11:07:17–11:09:47 的 Farfold 相关协议诊断零收发，零模型发送、零工具执行。原预览、失败记录和恢复记录分别保留。试前后原件 `host-cua-before.json` 与 `host-cua-after.json` 的 SHA-256 分别为 `ea03cb07df54d7465ae1d843435a1d9e2110bae61e0a5b634fc002a9d6988972` 与 `e395985deaa23757b908935bfd12bf606522827fae7d874ff663b3616b7b60da`。

本批补齐 P14 与两家 S5、S8 的真实权限失败、换位置恢复、完整副本和默认编辑器打开分项。其他磁盘写入失败各有自己的验收条件。
