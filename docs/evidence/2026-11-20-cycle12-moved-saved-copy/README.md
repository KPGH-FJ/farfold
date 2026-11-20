# 第 12 周期 已保存副本移动后的打开与定位

2026-11-20 北京时间。正式 Farfold `72e971df5`（0.1.7），macOS arm64，主进程 19119，CDHash `5bf21663b6f7caa4e341c9ebc4476d60bb4e299c`。两条测试使用各自已完成的原对话和原 `result.txt`，新目标在 `/private/tmp/ff-c12-n20-saved-copy-missing-m3tm2pd4/{copilot,claude}`。各自的 `recorded` 目录有一份名称不同的相邻文件，`decoy/result.txt` 同名但内容不同，`control/control.txt` 是访达的独立对照。试前记录 `fixture-before.json` SHA-256 `e099c94f3092e7c46e3f243a3b2fd73714a1a0c416967974e65911fac7117ab5`。

## 从两个原对话复验

- **Copilot。** 从原会话 `129d85c1-6bd6-408f-a6b4-2b776ccc7704` 的回复链接打开成品。11:33:32.247 从「完整文件另存为…」新建 `copilot/recorded/result.txt`，界面显示 `45 / 45 字节` 和保存成功。11:33:42.602 将该测试副本在同卷以排除覆盖的原子重命名移至 `copilot/moved/result.txt`。验证原位置不存在、原 inode 和全量内容保持。11:34:49.145 从同一保存记录点一次「打开副本」，11:34:50.045 点一次「显示副本位置」。[Copilot 原成品](../2026-11-20-cycle12-native-entry/README.md#copilot-成品与冷开)
- **Claude。** 从原会话 `908bce92-4953-4fef-96c3-b8b0d9515bbf` 的原 Write 步骤位置打开成品。11:35:22.193 从同一正常另存入口新建 `claude/recorded/result.txt`，界面显示 `71 / 71 字节` 和保存成功。11:35:33.071 独立移至 `claude/moved/result.txt`。11:35:51.210 从同一保存记录点一次「打开副本」，11:35:52.110 点一次「显示副本位置」。[Claude 原成品](../2026-11-18-cycle12-claude-write/README.md)

四次操作都显示「无法读取副本，请检查保存位置和访问权限。」早先成功保存的记录和当时的字节数仍在。打开前后，「文本编辑」所显示的前台文件 URL 仍为独立的旧恢复样本 `file:///private/tmp/ff-c12-n20-unwritable-save-xl42g1by/copilot/recovered/result.txt`。定位前后，访达都在该次测试的 `/private/tmp/ff-c12-n20-saved-copy-missing-m3tm2pd4/{copilot,claude}/control`，唯一选中项始终为 `control.txt`。定位后用访达「前往文件夹」读取了该窗的准确原目录再关闭输入栏。未出现打开或显示位置的成功回执，未观察到错开同名文件或误选相邻文件。

## 源文件、原位置和对照文件

| 样本    | 移动后内容与文件身份                                                                                                                      | 本机移动与验证原件                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Copilot | 45 字节，inode `16562066`，纳秒修改时间 `1795145612547439520`，SHA-256 `ff9ec757a550a684b40a55662307ec2de17146b27d81a070ce40d2e074190cdd` | `copilot/move-record.json` SHA-256 `8a754a2f28e57cd551b3fb94df7c91aa13bb4febd52c0937ba31f3ab596a61a6` |
| Claude  | 71 字节，inode `16562854`，纳秒修改时间 `1795145722489925545`，SHA-256 `fa66f4cebb90e9d5bbab7f56c8c5348c2faea019df1e9638105a94f32949ff61` | `claude/move-record.json` SHA-256 `380220d806bed99ba25d479fd671a8cccf4cc94f2d57c4ee0a412f7785c4a9f1`  |

操作后，两条保存记录引用的原 `recorded/result.txt` 都不存在。两个移动后的副本和对应源文件逐字节相同，各自文件身份、长度、权限、纳秒修改时间与试前一致。两组同名对照、相邻文件及访达对照各自的 inode、长度、权限、纳秒修改时间和 SHA-256 也保持。11:33:10–11:35:55 的 Farfold 协议诊断零对话事件，零模型发送。 [相同长度与修改时间下的副本变化](../2026-11-20-cycle12-copilot-saved-copy-integrity/README.md)

独立磁盘核验重新读取了两条移动回执、六个对照文件、两个原件和两份恢复副本。原保存路径缺失、移走后的副本及其余各文件与相应基线逐项核合。 [磁盘核验](observations.json)

本批覆盖两家的原保存路径缺失时，打开和定位保护准确地停在原记录。现有反馈指向副本的保存位置与访问权限。
