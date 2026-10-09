# 正式组件受控呈现

从 [index.html](./index.html) 查看当前画册。页面使用本次改动后的正式 React 组件，以及按 `src/main.tsx` 导入顺序收集的生产 CSS；组件的显示内容和状态由对应测试文件控制。这里不使用原型的组件或样式。

这是静态视觉检查材料，不是已安装 Farfold 的操作录像或真实 Agent 验收。按钮不执行操作。对话框的 `open` 属性替代正式组件挂载后的打开动作。组件周围的画册横幅和外部布局包装仅用于证据展示。

设置样例覆盖通用设置、通知许可未知、数据清除确认、LifeModel 边界、对话库、移动确认和已有对话预览。通知保持许可未知，历史正文与是否可继续分别呈现；没有将受控内容当作通知投递或恢复成功。

受控组件生成命令：

```sh
corepack pnpm exec vitest run --config docs/evidence/2026-10-09-prototype07-landing/controlled-render/vitest.config.ts
```

工作台样例由 `src/components/Workbench.landing-render.test.tsx` 生成；准备完成后的首发输入区由 `prepared-portal-render.test.tsx` 使用正式 EmptyState 编辑区与 ThreadView 挂载位置生成。每次生成刷新画册目录和 `production.css`。HTML 与生成 CSS 保留原始字节，已在 `.prettierignore` 中精确排除；只格式化生成器源码及 Markdown。`prepared-portal-before.css` 冻结安装版修正前的级联，不随生成器刷新。

浏览器核对、截图和最终测试结果由同级证据记录单独说明。
