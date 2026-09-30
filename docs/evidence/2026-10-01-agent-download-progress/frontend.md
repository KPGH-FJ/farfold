# 下载进度显示真实字节数

本片接续正式候选 `04f95e7` 的 Junie 下载观察：界面长期只有“下载中…”，无法从界面判断已收数据是否增长。源码确认这不是已证明的网络停滞或总量缺失：[后端](../../../src-tauri/src/install_job.rs)在每个下载块发送累计 `bytes` 与可选 `total`，[前端状态](../../../src/runtime/agents.ts)完整保存，但原显示只使用 `stage`。有无总量都没有显示字节。

## 实现范围

[program_progress.ts](../../../src/runtime/program_progress.ts) 增加共享 `installProgressLabel`，只在下载阶段补充实际测量：

- 已收字节为零时显示 `已下载 0 B`，缺少字节测量时仍为原阶段文案。
- 总量未知时显示 `下载中… 已下载 1.5 MiB`；可靠总量存在时显示 `下载中… 2 MiB / 8 MiB`。采用 1024 倍率及对应单位，不给百分比、速度或剩余时间。
- 仅接受非负安全整数字节；总量为零、非法或小于已收字节时只显示已收量，不展示相互矛盾的大小对。
- 切到校验、解压、取消或连接阶段，沿用原阶段，不残留旧下载量。没有新增任务状态、持久存储或事件。

AgentHub 与 AgentSetup 通过原 `programProgress` 自动获得同一显示。[ProgramManager](../../../src/components/ProgramManager.tsx) 和 [AgentPrerequisites](../../../src/components/AgentPrerequisites.tsx) 复用该函数；依赖和未选候选的原 `check` / `ready` 特定文案继续保留。每个入口的取消动作、目标 Agent 归属和迟到事件保护不变。新中文文案集中于 [strings.ts](../../../src/runtime/strings.ts)。

## 回归与检查

- [共享显示边界](../../../src/runtime/program_progress.test.ts)：零字节与无测量不同、未知或矛盾总量、非法计数、连接/空闲时不冒用旧量。
- [目录与准备页](../../../src/components/AgentHub.install-progress.test.tsx)：收到量增长、有/无总量、阶段切换、两个同时准备的 Agent 不串进度，取消仍传原 Agent ID。
- [程序管理](../../../src/components/ProgramManager.selection.test.tsx)：同一安装的实际量与取消目标、解压后去掉旧量，不触发选用。
- [真实状态/通道的依赖组件回归](../../../src/components/AgentPrerequisites.install.test.tsx)：`Channel` 回调的字节可见，后续专用检查文案保留，切换目标后忽略旧目标迟到进度。只使用受控 IPC，没有启动外部程序。

[首轮红](red.json) / [日志](red.log)为 13 失败、28 通过：其中 6 项是缺字节展示的直接反例，另 7 项由首个失败中断后同测试 Agent 的待结算依赖任务引发，不归为产品缺陷。将测试夹具的 Agent ID 按用例隔离，未改生产逻辑，得到[隔离后的行为红](isolated-red.json) / [日志](isolated-red.log)：6 失败、35 通过。

实现后，[定向检查](focused-green.json) / [日志](focused-green.log) **6 文件、45 例通过**（包含集中字符串检查和既有程序摘要测试）；[类型检查](typecheck.json) / [日志](typecheck.log)退出 0。[源码摘要](source-final.json)记录 8 文件最终 SHA-256/行数，[格式及本地链接检查](checks.json)记录独立自检。

此处只证明源码和受控交互。根任务将统一全量前端检查、打包及正式安装；尚未由本片证明真实 Junie 下载字节增长、取消、安装成功或任何新增 Agent 请求/续接。未运行 Cargo、正式应用或 Agent，未修改用户配置、账号、会话、全局计划或状态文档。
