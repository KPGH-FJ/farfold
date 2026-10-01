# 工作设置保护：安装证据独立审查

2026-10-01。仅复核保存的 JSON、01–08 AX、03/04 像素和最终叙述；未运行应用、Agent、测试、安装 helper 或数据库读取。结论：本轮正常策略回归与最终数据保护叙述有相应收据支持，未发现需要阻止收口的证据矛盾。

## 身份与叙述冻结

[执行身份](candidate-run.json)为 `41cb5b23ae2b1cfe1552ebcd3a4db66f76853277`；[17:55:04 安装](candidate-install.json)的二进制 SHA256 为 `53a0351ace3b6a81aee3b3eb37616612a26c258e649d7629c2d0f01c9f722573`。复制差异为空、签名退出 0；[18:06:35 退出](after-exit.json)仍为同一二进制，[453 项输入](candidate-source.json)的变化为空。随后另一片对话打开代码的变更不属于这次安装观察，未用当前工作区反推当时的冻结状态。

最终审阅文档摘要：

| 文件                               | SHA256                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| [README.md](README.md)             | `f9a06ccb2d9a3451d2baeb74309c29697dbcf977d63c8b89cf283efc3b49aef3` |
| [installed.md](installed.md)       | `db6c1bce1e4fbc7f5632a665b8ecfb824666db90d83fb4ea6bb39bab5c0c7eec` |
| [comparison.json](comparison.json) | `4fb0d410dd9246e5494f83c54764d12ac733802f291c4b2a6b6ab4551e153d48` |

派生比较列出的 24 份原 JSON 与 16 份截图/AX 摘要均重新核对一致；不是仅信任作者列出的布尔结果。

## 正常路径与数据

[基线](policy-before.json)已经显式启用目标位置，随后 [暂停](policy-paused.json)为 `false`，[冷启动](policy-cold-paused.json)仍为 `false`，[明确恢复](policy-restored.json)及[退出后](policy-after-exit.json)均为 `true`。03/04 像素与 AX 的暂停/恢复按钮、目标位置及说明一致；最终整个策略摘要回到基线，无关策略摘要各阶段一致。不能与上一片的“无显式覆盖→false→true”混用。

[原数据基线](data-before.json)为 36 条索引、40 个启动配置、49 项设置。[最终收据](after-exit.json)没有原记录改变或缺失、新增索引或设置；[原未发字段](unsent-before.json)与退出后完整字段摘要逐项一致，派生比较的各容器新增键和根新增字段也为空。阶段中仅目标策略临时改变，最终原设置摘要全部恢复。这些证据覆盖 Farfold 保存的元数据和未发字段，不是外部 Agent 文件普查。

05 的原历史和 Nemotron 模型展示属于旧对话读取；没有把已有 A/B 标记当成本轮新回复。06 返回原 Amp 空稿；07 实际是对话选项，Medium 选中以 08 AX 的 `Value: on` 为依据。最终叙述已正确说明这两个文件名与实际界面的边界。

## 协议、退出与限制

从[最终协议元数据](protocol-metadata-final.json)重新计数：3 个文件、23 条启动摘要、3 次出站 initialize、2 次 session/new、1 次 session/load；prompt、cancel、authenticate 与审批请求均为 0，拒绝记录为 0。三个连接的最后摘要均为已接受 initialize、成功、实际 childReaped/groupEnded/connectionRemoved；signal 15 与我方 TERM 记录不能解释成自然退出或失败根因。两条 stderr marker 没有正文，不作原因判断。有限白名单窗口也不证明窗口外行为。

[采样汇总](all-observed-processes.json)的 5 个 PID+开始时间身份均已结束，最终正式进程列表为空；不声称采样枚举全部瞬时子进程。[重复应用清理](duplicate-app-cleanup.json)的四个文件摘要与安装收据逐项一致，仅删除此匹配 bundle，正式应用保留。

未知对象和数组保护只在自有临时存储测试，正式数据库没有异常注入。本轮没有新消息、账号、审批、停止、队列继续/编辑或强制退出验收；保持正常策略和旧历史不等于这些分支全部通过。最终 Rust 四并发通过与此前默认并发失败、可选观测字段的测试合同修正，在安装说明中分别保留，没有宣称默认并发问题全部解决。源码判断仍见[原独审](review.md)，本文件不替代该层结论。
