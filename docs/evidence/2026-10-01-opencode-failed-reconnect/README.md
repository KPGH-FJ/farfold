# OpenCode：连接退出、恢复失败与明确重连

2026-10-01 13:17–13:22，复用正式 `350643f` / `b529957d20e9f83a47a24fb9ca4c15eb4d2e6a807bbbceaaf83767baa924e9f9`，没有重装或更改产品源码。只操作本任务已有的 OpenCode 测试历史及自有空目录，保持原 Nemotron 3 Ultra Free / 已有设置。

在[已完成、未运行的历史](01-idle-history-and-own-draft.jpg)中加入仅本轮未发 marker。按 PID、启动时间、父进程及 cwd [精确校验后 SIGTERM](disconnect-injection.json)该测试连接；安装版显示[连接已结束与重连入口](02-observed-connection-loss.jpg)，旧正文与草稿保持。

确认自有目录为空且进程已退出后，[临时改名](cwd-unavailable.json)使原位置不可用。明确点击重连后，[失败提示、原正文及未发草稿保留](03-recovery-blocked-own-cwd-missing.jpg) / [完整 AX](03-recovery-blocked-own-cwd-missing.txt)。[该目录缺失窗口没有出站协议请求](missing-directory-protocol-window.json)，因此只称位置缺失使恢复未能发起，不称 Agent 拒绝恢复或网络故障。

将[同一设备、同一 inode 的空目录原样恢复](cwd-restored.json)，再明确点击重连：[同一历史与草稿恢复可用](04-explicit-reconnect-restored.jpg)，[原模型、已有来源保持](05-preserved-model-source.jpg) / [AX](05-preserved-model-source.txt)。[随后 10 秒采样](recovered-processes.json)及至退出无新 prompt。通过 UI 清除自己的未发 marker，返回[原 Amp 空稿入口](06-own-draft-cleared-original-entry.jpg)。

[有限协议元数据](protocol-metadata-final.json)及[计数](bounded-verification.json)：3 initialize、1 session/new（原 Amp 预览）、2 session/load（首次读取及目录恢复后的明确重连），0 prompt/authenticate/cancel。不存在自动续发，不把此记录解释为零 HTTP。仅计真实进程退出和位置缺失条件下的 R6/J5 有限通过，未测运行中断流、恢复中再次退出或所有 Agent。

[最终保护核对](after-exit.json)：446 输入和二进制保持，原 36 索引/37 启动配置无变化，所有原草稿/选择/队列等字段保持；只有本测试的 activity 变化，无新索引。4 个[采样进程身份](all-observed-processes.json)最终均结束。自有目录仍空、inode 保持；前片文件产物仍为 38 字节及相同 SHA，无重复应用。工程检查复用[当前候选检查](../2026-10-01-draft-files-and-artifact-sources/implementation.md)，不重复未变检查。

发现待修：恢复失败页同时展示顶部失败提示、连接结束提示和输入框上方重复失败提示；两处“去设置”与实际重连动作分散。见 03，下一片收敛错误呈现与主要动作，不改变数据保留、模型保护或明确重连规则。
