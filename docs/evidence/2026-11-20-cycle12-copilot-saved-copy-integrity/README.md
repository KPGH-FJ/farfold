# 第 12 周期 Copilot 副本改变后的打开保护

2026-11-20 北京时间。正式 Farfold `72e971df5`（0.1.7），macOS arm64，主进程 19119，CDHash `5bf21663b6f7caa4e341c9ebc4476d60bb4e299c`。普通搜索打开 `FF_C12_N20_COPILOT_FILE`，从原会话 `129d85c1-6bd6-408f-a6b4-2b776ccc7704` 的原回复打开 `./result.txt`。11:31:43.492 通过「完整文件另存为…」新建私有测试副本 `/private/tmp/ff-c12-n20-saved-copy-missing-m3tm2pd4/edited/copilot-integrity-result.txt`，Farfold 显示 `45 / 45 字节` 和保存成功。原始副本与源文件逐字节一致。[原成品回执](../2026-11-20-cycle12-native-entry/README.md#copilot-成品与冷开)

11:32:07.835 对这份自有副本在原文件对象上仅改第一个 ASCII 字节 `F` → `G`。副本 inode `16561662`、权限 `0600`、45 字节长度和纳秒修改时间 `1795145503783299988` 保持。原有内容摘要 `ff9ec757a550a684b40a55662307ec2de17146b27d81a070ce40d2e074190cdd`，改后摘要 `5822553c15910cb78e0d3dcb5dc585b69ecea39daf879b2d0da1b65c7cf56602`。文件状态时间随实际写入变化。源文件 inode `16416358`、修改时间和内容摘要保持。独立本机记录 `edited/receipt.json` SHA-256 `8e2c166c1d1997656ad559ee61ddaf05af152c31e413d4c3e17d8a1d8c95f59d`。

11:32:18.709 在同一保存记录只点一次「打开副本」。原保存成功回执仍可见，这次操作明确显示「副本或保存位置已变化，本次未继续操作。请重新核对。」文本编辑前后均显示原先独立的已恢复 Copilot 文稿，文件 URL 保持 `file:///private/tmp/ff-c12-n20-unwritable-save-xl42g1by/copilot/recovered/result.txt`。没有看到新打开本次被改的文件或「已请求打开这份副本」提示。该窗内 Farfold 协议诊断无对话事件，零模型发送。 [文本编辑对照文稿来源](../2026-11-20-cycle12-unwritable-save-recovery/README.md)

本批证明该已完成副本被实际改动，即使长度、inode 和修改时间保持，Farfold 也会拦下旧记录的打开动作。副本移动后的打开与定位另行复验。
