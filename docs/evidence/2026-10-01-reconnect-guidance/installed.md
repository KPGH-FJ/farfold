# 单一恢复提示：安装验证

2026-10-01 13:39–13:45，正式 `/Applications/Farfold.app`，源码 `802be9c`，二进制 `1a66d452e832895b044e85f1a205961915baa9e78f8257d190dff119c843fd1f`。[安装收据](candidate-install.json)确认 4 文件匹配、签名通过；[446 项输入](candidate-source.json)至退出不变。

已测成功：

- 本任务 OpenCode 旧测试历史载入后，[加入仅本轮未发 marker](01-idle-original-history.jpg)。按 PID、启动时间、父进程及目标 cwd [精确核对后让空闲连接退出](disconnect-injection.json)，[连接结束提示与重连按钮位于输入区旁](02-idle-disconnect-near-composer.jpg)。正文与草稿保留。
- 将确认属于本任务的空目录[暂时改名](cwd-unavailable.json)，明确重连失败后，[只显示一条失败原因与一个直接重连按钮](03-single-recovery-failure.jpg) / [AX](03-single-recovery-failure.txt)。[与前序候选逐项对比](guidance-comparison.json)：相同失败原因 2→1、“去设置”2→0；另一个连接结束横幅已去掉，原未发 marker 仍在。
- [同一设备/inode 的空目录原样恢复](cwd-restored.json)后，点击该按钮，[旧历史与原稿保留、失败提示清除](04-reconnected-draft-retained.jpg)，[原 Nemotron 3 Ultra Free / 已有设置保持](05-original-model-source.jpg)。[10 秒采样](recovered-processes.json)及至退出无 prompt。未点击发送或待发；恢复后的既有队列暂停规则保持，不计实际续答验收。
- Dirac 原失败历史[仍有“重试读取／新开会话”专属入口](06-special-history-failure.txt)。点击一次重试，协议确有第二次读取，但[仍没有正文且发送禁用](07-special-history-retry-result.txt)。只计专属呈现和重试入口回归，不计 Dirac 恢复成功；未创建新会话。
- UI 清除仅本轮测试 marker，返回[原 Amp 普通空稿](08-original-amp-draft-restored.jpg)；最终选择字段与基线一致。

[协议计数与文件核对](bounded-verification.json)、[有限原始元数据](protocol-metadata-final.json)：4 initialize、1 session/new（Amp 预览）、4 session/load（OpenCode 两次、Dirac 两次），0 prompt/authenticate/cancel。目录缺失窗口 0 协议事件，因此只称位置不可用使恢复未能发起，不称 Agent 拒绝或网络故障；不以零 prompt 推导零 HTTP。

[最终保护核对](after-exit.json)：原 36 索引/37 启动配置无变化，无新索引；全部原草稿、选择、反馈、队列保持，设置只有本测试 activity 变化。5 个[采样身份](all-observed-processes.json)全部结束；[重复应用精确清理](duplicate-app-cleanup.json)保留正式应用。自有目录仍空，前片产物文件 38 字节及 SHA 保持。

[全量前端](checks-frontend.json)：138 文件、1,238 项通过，类型/构建退出 0；[格式](checks-format.json)与[打包](checks-bundle.json)通过。133 后端输入未变，[复用](backend-check-reuse.json)535 Rust、3 项既有忽略及 fmt/clippy。有效红例、76 项定向回归、独立源码审查见[实现记录](implementation.md)。

本片只关闭本次普通恢复提示重复和动作分散问题。未知执行/来源错误/权限提示反例由组件测试覆盖，未在安装版新制造这些条件。旧目录偶发超时原因、Codex 恢复差异、Autohand 安装确认、Messages 云端与全目录真实账号/首发/续接和完整同候选验收继续开放。
