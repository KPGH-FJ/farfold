# R5 受控静态导出

当前生产 `AgentSetup` 及其真实子组件通过 React SSR 导出，保留生产 CSS、SVG、结构和文案。所有方法、服务、完成回执、模型选项与程序清单都来自测试文件内的固定非秘密示例。没有运行 Tauri、读取实际程序/账号/Key/配置、认证、发送模型请求、安装或卸载；Devin 只比对静态字符串身份。

导出器：[AgentSetup.r5-render.test.tsx](../../../../src/components/AgentSetup.r5-render.test.tsx)。HTML 与截图已复制到本目录，临时导出目录为 `/tmp/farfold-r5-controlled-html-2026-10-03`。`manifest.json` 包含 HTML、实际生产组件、CSS 与 R5 原文件的 SHA-256；`static-33.json` 包含权威名单/源码一致性和统一入口矩阵；`captured-files.json` 保留 12 个 HTML 和 18 个 PNG 的摘要。

生成命令（工作目录 `/Users/tw/Desktop/farfold`）：

```sh
corepack pnpm exec vitest run src/components/AgentSetup.r5-render.test.tsx
```

| 导出 HTML                   | 实际生产状态                               | R5 对照状态                  |
| --------------------------- | ------------------------------------------ | ---------------------------- |
| `01-account-key.html`       | 账号与指定密钥两种选择                     | `account-methods`            |
| `02-terminal-api.html`      | 终端与模型 API 两种选择                    | `service-source`             |
| `03-three-methods.html`     | 账号、终端、模型 API 三种选择              | `connection-three-methods`   |
| `04-account-summary.html`   | 固定成功回执后的账号摘要                   | `chatgpt-success`            |
| `05-terminal-summary.html`  | 用户确认完成且回收/检查后的终端摘要        | `terminal-checked`           |
| `06-service-step.html`      | API 未选来源，第二步只选服务身份           | `service-select`             |
| `07-service-summary.html`   | 来源已选，唯一当前接入摘要                 | `service-ready`              |
| `08-model-step.html`        | 第三步模型未选，空选项明确保留             | `models-ready`（仅布局对照） |
| `09-model-selected.html`    | 第三步模型明确已选，模型选项读取固定       | `models-ready`（仅布局对照） |
| `10-program-list.html`      | 已断开后的当前程序/候选清单                | `program-candidate`          |
| `11-program-connected.html` | 已连接时先断开后管理                       | `program-manager-connected`  |
| `12-service-editing.html`   | 真实更换服务回调展开来源选择，停止继续模型 | `service-select`             |

R5 对照原文件：`/Users/tw/Documents/Codex/2026-10-02/task-3/refined-prototype/Farfold-R5.html`，使用 `#状态ID` 进入对应模拟状态。每个示例仅对照相应共享结构；示例的能力组合不等于任何 Agent 的真实声明。

静态核对：活动计划 §0.2/§0.4 指向 §4.3 的 33 项，与 `first_release.rs` 的 `INCLUDED` 集合及顺序一致，缺项和多项均为空。`registry_agent_id` 保留 Codex/Pi/OpenCode 的既有 ID，其余加 `registry:`；`AgentHub` 仅有一个 `AgentSetup` 入口。该检查不读取每家配置，也不证明 33 项账号/能力/参数验收。

本轮针对导出器的 2 项测试通过。组件位置缓存和真实回调都仅存在于此测试；传输层只返回固定示例，其他执行接口被拦截。模型已选状态的一次自动准备读取也被记录并返回固定快照，没有创建实际对话。导入图用 TypeScript AST 扫描，包含 `AgentHub` 的 `agent-hub.css` 基础布局、其他静态样式及 xterm 包样式；本地 CSS 的 `@import` 在原位置递归展开，并移除原引用。当前生产 CSS 没有 `@import`；首次导出缺少基础布局的原因是旧跨行正则漏掉部分 TS 样式导入，已修复。

截图已使用 1280×820 视口完成 12 个生产状态和 4 个 R5 对照；另有 420×820 的方式选择及程序清单两项。隔离 headless 浏览器只访问本地固定文件，禁止网络，不使用用户浏览器资料；结束时只关闭本任务创建的进程。18 个截图的弹窗水平溢出均为 false，见 `capture-report.json`。源码导出和最终截图均包含最后步骤文案，程序清单、服务摘要、账号/终端完成摘要、模型及窄视口已逐图检查。此前漏导基础 CSS 的截图不计作最终证据。

HTML 中唯一额外脚本为 `dialog.showModal()`，使真实弹窗进入浏览器顶层；页面没有 React hydration，按钮不能作为交互验收证据。CSS 导出顺序沿当前 `main.tsx` 的本地导入图，现有 SVG 内嵌为 data URL。只截接入弹窗，未手写替代工作台背景；因此不证明完整壳层、交互/焦点、真实终端内容或安装版表现。账号说明与手动方式、当前程序检查连接、真实模型读取状态及实际保护按[候选说明](../README.md)保留，不由模拟内容补造能力。
