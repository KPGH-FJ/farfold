# 归档保护：安装证据独立核对

未发现本次安装证据的阻断问题。已核当前 [README](README.md)、[安装记录](installed.md)、01–08 图片及同名 AX、归档/恢复/两次退出收据与协议元数据；只读取已存材料，没有启动应用、Agent、测试或正式数据库。关键来源 SHA-256 与逐项核对结果见 [机器摘要](installed-review.json)。

[安装收据](candidate-install.json)对应 `ab7a3ec`、正式二进制 `22ac66ae…18a361b`，四文件一致且签名通过。[458 项输入](candidate-source.json)当前摘要也与冻结值一致，[最终退出](after-exit.json)报告同一二进制且无输入变化。

[01](01-original-empty-draft.jpg)/[08](08-original-empty-restored.jpg) 像素显示 Amp / Medium 的空稿。[02](02-unsent-archive-blocked.jpg) 像素与 AX 显示测试 marker、禁用归档及未发内容说明；[首次退出](draft-after-exit.json)保留该新增 composer 键，[03](03-cold-draft-preserved.jpg)冷启动后 marker 仍在。[04](04-return-selection-preserved.jpg)/[07](07-restored-history-selection.jpg)显示沿用已有设置、Nemotron 3 Ultra Free 与 build；这是本次可见选择，不能扩成所有配置项均逐项展开验证。

清本次稿后，[05](05-archived.jpg)显示计数 34 和恢复动作，[06](06-archived-list.jpg)显示目标在已归档列表中；[归档收据](archived.json)仅目标 `archived/updated_at` 改变。[恢复收据](restored.json)使目标回到 `archived=false`，[07](07-restored-history-selection.jpg)计数回到 35、旧历史可读、输入为空。没有把回放的旧指令或回复算成本轮执行。

最终原 36 索引无增删，非时间内容全部保持，只有目标 `updated_at` 变化；目标模型配置、身份、标题、收藏、创建时间保持。原 40 Agent 摘要保持，不能据此推称整个当前 Agent 表计数已核。原 49 设置仅 `unsentWork.v1` 改变：只有目标活动时间不同，`ended=true` 保持，其他原文字/附件字段、选择、反馈、队列和活动摘要保持；本次新增 composer 键已清，无新增未发键残留。不能声称所有时间或整个设置逐字恢复。

[协议元数据](protocol-metadata-final.json)为 4 文件、32 启动摘要、4 initialize、2 new、2 load、8 response、110 update，2 条 stderr 长度标记，0 拒收记录；所收窗口无 prompt/authenticate/cancel/permission/set_config_option。四个连接最终均记录 childReaped、groupEnded、connectionRemoved；[6 个采样身份](all-observed-processes.json)在最终退出观察中均消失，不能扩大为所有短命后代。[重复应用](duplicate-app-cleanup.json)经同一四文件核对后精确移除，正式应用保留。[原始格式保留清单](raw-format-preservation.json)全部字节摘要匹配，审查没有改写这些收据。

这是规范路径下的普通归档保护与恢复安装回归。未在正式数据制造别名；别名、改指、目录不可核实与竞争边界仍依赖[受控源码与测试证据](source-review.md)。本次不覆盖自动到期归档、强杀、账号成功或整个目录同候选完整旅程。
