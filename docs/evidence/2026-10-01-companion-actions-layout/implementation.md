# 所需程序操作区布局

根任务确认前一安装候选正常退出、445 源码输入未变且观察到的 3 个进程均已结束后，授权本片单 CSS 修改。本子任务未运行应用、Agent、Cargo、构建或前端套件。

依据：[实际安装截图](../2026-10-01-agent-access-companion-program/01-autohand-missing-program.png)中，所需程序说明与两个安装按钮同排，按钮中文被压成两行。[AgentPrerequisites.tsx](../../../src/components/AgentPrerequisites.tsx)把说明和两个按钮放在同一个 `.agent-setup-program`；[agent-hub.css](../../../src/agent-hub.css)为该类设置不换行的横向 flex，按钮没有独立禁止收缩规则。

仅修改 [agent-setup-presentation.css](../../../src/agent-setup-presentation.css)，以 `.agent-preparation-dependencies` 限定范围：卡片允许换行并左对齐，说明 `flex-basis: 100%` 独占一行、`min-width: 0` 与 `overflow-wrap: anywhere` 允许长路径换行；直接操作按钮 `flex: 0 0 auto`、`white-space: nowrap`，空间不足时整颗按钮换到下一行。采用现有 12px 间距与按钮样式，不改变其他程序卡、安装/候选语义、禁用状态、点击事件或文案，不增加专属 Agent 分支或纯 CSS 镜像测试。

变更仅涉及此 CSS；未改 TSX 或运行逻辑。按钮移到说明下方会增加卡片高度，但避免文字和操作竞争横向空间；窄窗口按按钮整体换行。没有新增镜像 CSS 测试。

根任务检查：1,213 前端（137 文件）、类型、构建、全工程格式、正式打包均退出 0，见 `checks-frontend.json`、`checks-format.json`、`checks-bundle.json` 及对应完整日志。133 项后端输入不变，`backend-reuse.json` 指向前片 527 Rust（3 既有忽略）和 fmt/clippy。独立[审查](review.md)无阻断。Vite 保留既有大 chunk 提示；不将该提示称为构建失败或本片修复。

安装视觉与数据保护结果另见本目录 `installed.md`；原截图保留为修改前证据，不替代修复后的观察。
