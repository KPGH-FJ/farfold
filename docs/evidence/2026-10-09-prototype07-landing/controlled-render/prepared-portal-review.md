# 准备完成后的首发输入区布局修复

正式安装后的发现来自 `../installation/screenshots/restored-window.png`。这是准备完成、尚未发送的新对话：`EmptyState` 保留同一个编辑器，将其 DOM 容器移到 `ThreadView` 的 `draftComposerRef` 挂载点。

根因有两层：

- 移动后的 `.empty-col` 不再属于 `.workspace-start`，失去开始页的宽度覆盖，退回 `styles.css` 中 `width: 460px; max-width: 80%`。
- 挂载点是未设置宽度的 `div`，在 `align-items: center` 的 `.composer-wrap` 内按内容收窄；子级再受 80% 限制。

修复仅增加挂载点的 `prepared-composer-host` 样式类，限定其占满可用宽度并沿用对话输入区的 784px 上限；子级 `.empty-col` 使用满宽，工作文件夹条与正文保持相同边距并允许换行。没有修改草稿归属、准备过程、模型选项、权限或发送逻辑。

## 受控复现

- [修前页面](./conversation-07-prepared-before.html) 使用冻结的 `prepared-portal-before.css` 与修前 DOM。
- [修后页面](./conversation-07-prepared.html) 使用当前生产 CSS 与当前 DOM。
- `prepared-portal-render.test.tsx` 从正式 `EmptyState` 取得编辑器，放入正式 `ThreadView` 的实际 ref 挂载点，保留正式 Sidebar、`.product-app`、`.workspace-thread` 和 `.conversation-workspace` 祖先；SSR 只替代 DOM 移动过程，不执行准备或发送。
- 所有选项值、Agent、工作目录都是明确的受控数据，不代表真实服务回执。

生成命令：

```sh
corepack pnpm exec vitest run --config docs/evidence/2026-10-09-prototype07-landing/controlled-render/vitest.config.ts docs/evidence/2026-10-09-prototype07-landing/controlled-render/prepared-portal-render.test.tsx
```

初次生成时冻结了修前 CSS；后续生成只刷新当前页面，保留修前对照。

## 验证范围

`EmptyState.selection.test.tsx` 与 `ThreadView.shortcuts.test.tsx` 共 57 项通过；生成器 1 项、类型检查和目标文件格式检查通过。CUA 在本机浏览器同一窗口目视确认：修前输入区狭窄且控件占四行，修后输入区恢复宽度且控件占两行。未将包含其他浏览器标签信息的整窗截图保存到项目证据。

主任务已在 1280×820 浏览器窗口复现修前结构：挂载容器宽 460px、`.empty-col` 宽 368px、输入框宽 320px，与安装版问题一致。纯页面截图为 [before.png](../prepared-draft-layout/before.png)。独立源码复核确认 CSS 级联成立、普通对话输入区不受影响；当前 900px 最小窗口范围未发现新的溢出风险。

标准尺寸纯页面截图和修复后的再次安装验证由主任务记录；上述受控页面与行为测试不能替代安装验证。
