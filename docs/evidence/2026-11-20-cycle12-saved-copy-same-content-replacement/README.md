# 第 12 周期 同名同内容替换后拒绝打开和定位副本

2026-11-20 北京时间，正式 Farfold `72e971df5`（0.1.7），macOS arm64，主进程 19119，CDHash `5bf21663b6f7caa4e341c9ebc4476d60bb4e299c`。测试目录 `/private/tmp/ff-c12-n20-saved-copy-restore-kwva_p64`。试前记录 `before.json` 的 SHA-256 为 `bb5b22d51cf014853af0c265f1d38707f2ed18aeafc0feb0d9b94d52b4ccca89`。

## 两个原对话的保存和替换

- **Claude。** 在原对话 `FF_C12_CLAUDE_WRITE_CASE`（`908bce92-4953-4fef-96c3-b8b0d9515bbf`），从原 Write 步骤打开 `/private/tmp/ff-c12-claude-write-n18.3qlz13my/result.txt`。11:49:15.370 在系统保存框核对准确目录 `claude/recorded` 后，保存 `result.txt`，Farfold 显示 `71 / 71 字节` 和「完整文件副本已保存。」11:49:26.600 同卷原子交换两个测试文件，原保存路径的 inode 从 `16565891` 变为 `16565969`，原件保留在 `claude/held/result.txt`。[Claude 原成品](../2026-11-18-cycle12-claude-write/README.md)
- **Copilot。** 在原对话 `FF_C12_N20_COPILOT_FILE`（`129d85c1-6bd6-408f-a6b4-2b776ccc7704`），从原回复的 `./result.txt` 链接打开 `/private/tmp/ff-c12-n20-ryup8cla/copilot/result.txt`。11:50:19.396 在系统保存框核对准确目录 `copilot/recorded` 后保存，界面显示 `45 / 45 字节` 和保存成功。11:50:28.797 原子交换，原保存路径的 inode 从 `16566405` 变为 `16566446`，原件保留在 `copilot/held/result.txt`。[Copilot 原成品](../2026-11-20-cycle12-native-entry/README.md#copilot-成品与冷开)

每例在交换前后核对同一个父目录、同一路径、同一文件名，以及两文件相同的磁盘设备、归属、权限、纳秒级修改时间、字节数和全文 SHA-256。两文件的 inode 不同，交换后分别保留。源文件及各例独立的访达对照文件经磁盘复查保持一致。 [磁盘核验](observations.json)

| 样本    | 保存文件与替身的修改时间及 SHA-256                                                        | 本机 `plant.json` 的 SHA-256                                       |
| ------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Claude  | `1795146555665927858`，`fa66f4cebb90e9d5bbab7f56c8c5348c2faea019df1e9638105a94f32949ff61` | `4c9f24e0d6da42687d7b83f97ba4c4727cbee0bef2eb129d194abbf684246a18` |
| Copilot | `1795146619694433895`，`ff9ec757a550a684b40a55662307ec2de17146b27d81a070ce40d2e074190cdd` | `47bce9131318de233a5d2d8b257f74edc7a7da447aa93ba4819cfbe82c591374` |

## 四次原保存记录操作

| 样本    | 打开副本           | 显示副本位置       |
| ------- | ------------------ | ------------------ |
| Claude  | 11:49:58.459，拒绝 | 11:49:59.277，拒绝 |
| Copilot | 11:50:38.306，拒绝 | 11:50:39.097，拒绝 |

四次都显示「副本或保存位置已变化，本次未继续操作。请重新核对。」原单独保存成功的记录和字节数仍可见。这四次操作均无新的打开或显示位置成功回执。系统「文本编辑」前台窗口仍指向启动本批前的独立对照 `file:///private/tmp/ff-c12-n20-unwritable-save-xl42g1by/copilot/recovered/result.txt`。访达定位操作前后都留在各自试验的 `<样本>/control` 目录，唯一选中的 `control.txt` 保持。两组拒绝都记录后才复位。[原件放回后从同一条记录复验](../2026-11-20-cycle12-saved-copy-restored/README.md)

11:47:50–11:54:23 的 Farfold 协议诊断没有新对话事件，零模型发送。结论覆盖正式版上以上两条同名、相同字节且修改时间相同的替换样本。

## 准备时的路径纠正

11:48:07.103 首次 Claude 另存时，旧操作引用把一份新副本写到了上一批已经空出的 `/private/tmp/ff-c12-n20-saved-copy-missing-m3tm2pd4/claude/recorded/result.txt`。没有覆盖旧文件。确认是本次新建的 71 字节文件（inode `16565556`，SHA-256 与上述 Claude 一致）后，将它单独移至 `/private/tmp/ff-c12-synthetic-save-quarantine-fjtk53fk/stray-claude-result.txt`。复核旧记录路径再次为空，上一批已移走副本及对照文件保持。额外的旧路径保存记录未作编辑。后续两例均在真正点保存前核对系统保存框的完整新路径，本段多出的试验副本未计入四次结果。[上一批移动样本](../2026-11-20-cycle12-moved-saved-copy/README.md)
