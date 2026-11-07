# 第 1 阶段 Kilo 与 Goose 独立排查

独立排查只读核对 macOS arm64 27.0（26A425）上正式版 `dbe23bb6e` 的已有记录与官方实现。前次原会话已完成的实测分别保留。

## Kilo 桌面授权

系统日志归属到正式 Farfold 启动的 Kilo，先比较上一版 `68aefdb49` 和当前版 `dbe23bb6e` 的临时签名，记录代码要求不匹配，再进入授权询问。磁盘上唯一匹配 Farfold 桌面服务的允许记录对应 10 月 24 日正式版 `e6e1c3796`，通过当时的候选摘要和安装记录核实。三版临时签名均不同，当前正式版自身签名有效，但无法通过磁盘上的旧签名要求。日志拿来比较的旧签名来自哪份系统状态仍未知。 [10 月 24 日安装记录](../2026-10-24-agent-acceptance/formal-e6e1-installation.json) · [Apple 代码签名要求](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements/)

沿原请求查到系统沙盒服务向权限服务发起请求。16 条同活动记录、6 条同请求或连接记录均未取得可归属的授权决定。进入询问后的同活动记录只显示系统读取提示说明。前台切换事件支持提示处理曾启动，具体弹窗、系统调用返回及决定仍未知。系统日志的保留方式限制了事后能核实的范围。 [原目录复测](../2026-11-06-phase1-next/README.md#kilo-原目录) · [Apple 日志保留说明](https://developer.apple.com/documentation/os/generating-log-messages-from-your-code)

前次原目录已在正式应用列出、读回并准确续接。长期授权仍需在用户在场时以当前签名和自有桌面样本观察明确的授权结果，再正常重开验证能否不重新选择目录就读取。跨版本授权保留待计划中的稳定签名阶段验证。此前正式版用同一原生选择器，桌面内两个目录仍超时，桌面外样本通过。 [工作目录对照](../2026-11-06-formal-cwd/README.md) · [Apple 文件权限说明](https://developer.apple.com/forums/thread/678819)

只读复核回执为 `persistent-desktop-identity-receipt.json`，2,350 字节，SHA-256 为 `b93e4756009c04511180d559af7dba393ae96fd1c73c97262a234b53979fa688`。

## Goose 原会话等待

复核前次原会话卡住时的进程采样，同一正式应用启动的 Goose 主线程在 59 次采样中都停在同一条调用链。Goose 正在准备回复，加载项目提示规则，构建 Git 忽略规则时同步打开文件，最深可见帧是系统 `open`。此前只匹配了其他 `open` 变体，遗漏这条栈。项目根目录的 `.gitignore` 是当前元数据支持的候选，采样没有保留调用路径或系统调用结果。 [Goose 提示准备](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/agents/prompt_manager.rs#L86-L95) · [Goose 文件规则加载](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/hints/load_hints.rs#L170-L229)

Goose 1.52.0 在同一连接中处理回复任务和传入的取消通知。按对应 SDK 实现，任务队列与接收通知由同一个连接任务轮询。这使同步打开文件有可能推迟取消处理。采样发生在取消之前，无法确认这条调用持续占用整个等待窗口，也未确认底层打开文件为何等待或前次是否触达模型提供方。Farfold 记录取消到 Goose 处理约隔 276 秒，随后约 3 毫秒收到协议响应。Farfold 记录取消的时点早于写入子进程，实际写入时点仍缺。 [Goose 分发源码](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/acp/server/dispatch.rs#L125-L147) · [SDK 2.2.0 调度源码](https://docs.rs/agent-client-protocol/2.2.0/src/agent_client_protocol/jsonrpc.rs.html#1945-1984)

正式应用回读确认前次已停止、无新增助手回复。同一原会话空闲后，沿用原模型发送不同的自测问题，Goose 准确取回另一条历史标识，5.540 秒取得协议终态。历史请求未重发。 [原会话实测](../2026-11-06-phase1-next/README.md#goose-原会话)

私有系统采样原件第 57、60–68 行对应上述调用链，131,713 字节，SHA-256 为 `ac86d41a5eda2482d3cf6d0707e5b4819802f0e6eef9ba3f695334eac7748ce3`。迟到响应复核为 `goose-original-late-boundary.json`，3,545 字节，SHA-256 为 `e49137e21a87453b111412aa028220d52aa0ef374ec0fd3bd04d2b98b416d39b`。新问题复核为 `goose-original-new-probe-bounded-observation.json`，7,354 字节，SHA-256 为 `9c9809a6ab22a85c8bd1c9f44b7a8caf609cbbe606ed1d5a74a3524fd7334d41`。

## 两次长等待的采样时间

按 Farfold 的发送、停止记录与系统取样时间对齐，Goose 的文件打开取样约在发送后 126 秒、停止前 53 秒开始，覆盖约 3 秒。原用户消息此前已进入 Goose 历史。取样时主线程正在准备项目提示并打开文件，具体路径、等待持续多久和请求是否到达提供方仍待确认。 [Goose 原会话回读](../2026-11-06-phase1-next/README.md#goose-原会话)

Copilot 启动程序与实际进程的取样约在发送后 115–116 秒开始。三组管道读数约在发送后 167–168 秒取得，均早于停止约 36–37 秒。这些零读数只覆盖停止前的窗口。原消息后来进入 Copilot 并以停止收尾，写入管道、启动程序转发和 Copilot 开始处理之间的时间分布仍未知。 [Copilot 原会话对照](README.md#迟到的停止与原会话对照) · [已归档时间差](summary.json)
