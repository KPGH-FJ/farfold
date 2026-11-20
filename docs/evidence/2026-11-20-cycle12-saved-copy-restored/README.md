# 第 12 周期 原副本放回后从同一保存记录打开和定位

2026-11-20 北京时间，正式 Farfold `72e971df5`（0.1.7），macOS arm64，主进程 19119，CDHash `5bf21663b6f7caa4e341c9ebc4476d60bb4e299c`。本批在 Claude 和 Copilot 各两次拒绝都已确认后开始，沿用相同的两条保存记录。两条复验均使用先前的原对话，复位后无需再次另存。[替换后的四次拒绝及准备时的路径纠正](../2026-11-20-cycle12-saved-copy-same-content-replacement/README.md)

11:50:58.237，在 `/private/tmp/ff-c12-n20-saved-copy-restore-kwva_p64/{claude,copilot}` 内分别原子交换一次，将原文件放回各自记录的 `recorded/result.txt`，替身保留于 `held/result.txt`。两份原副本各自回到原路径，核对了原 inode、磁盘设备、权限、纳秒级修改时间和完整内容。交换后的两份原件、两份替身、两份源文件和两份访达对照均再次从磁盘核对。

| 样本    | 放回的原 inode | 保留的替身 inode | 内容                                                                        | 本机 `restore.json` 的 SHA-256                                     |
| ------- | -------------- | ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Claude  | `16565891`     | `16565969`       | 71 字节，`fa66f4cebb90e9d5bbab7f56c8c5348c2faea019df1e9638105a94f32949ff61` | `f1b9fe409d46141b8cdefb311356121c225016ecaa25e98b6fe95315142420b9` |
| Copilot | `16566405`     | `16566446`       | 45 字节，`ff9ec757a550a684b40a55662307ec2de17146b27d81a070ce40d2e074190cdd` | `1d239eb947c9e406456f6f24f3bbc13db217384ca77f298b9e3cd3a8a35bfe7f` |

## 从同一保存记录实际打开和定位

- **Copilot。** 11:51:12.725 点一次「打开副本」，Farfold 显示「已请求打开这份副本。」系统「文本编辑」中核对该次新增文档窗的精确 URL `file:///private/tmp/ff-c12-n20-saved-copy-restore-kwva_p64/copilot/recorded/result.txt`，两行依次为 `Farfold Copilot delivery sample`、`alpha: ready`。11:52:14.567 从同一条记录点一次「显示副本位置」，Farfold 显示「已请求显示这份副本的位置。」访达显示 `recorded`，所选文件精确指向同一新副本 URL，状态栏为「选择了1项（共1项）」。
- **Claude。** 11:52:47.796 点一次「打开副本」，Farfold 显示「已请求打开这份副本。」系统「文本编辑」实际窗口 URL 为 `file:///private/tmp/ff-c12-n20-saved-copy-restore-kwva_p64/claude/recorded/result.txt`，两行依次为 `FF_C12_CLAUDE_WRITE_2013`、`验收：内容原样，末尾保留换行。`。11:54:17.928 从同一条记录点一次「显示副本位置」，Farfold 显示「已请求显示这份副本的位置。」访达显示 `recorded`，唯一项目的 URL 为同一 Claude 新副本，状态栏为「选择了1项（共1项）」。

文本编辑与访达均核对了实际系统结果。磁盘复核的原副本仍分别为 71 和 45 字节，两份完整字节与各自原成品相同，末尾换行保留。该测试窗内 Farfold 协议诊断没有新对话事件，也没有模型发送。 [磁盘核验](observations.json)
