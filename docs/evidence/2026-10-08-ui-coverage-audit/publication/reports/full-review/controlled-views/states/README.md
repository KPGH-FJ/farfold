> 2026-10-24 隐私发布副本。历史结论及已测/失败/未测边界保留；本机路径和生成标识已脱敏，末尾换行统一为一个LF。实拍图、原始AX及中间数据仅本地保留，相关链接通向公开哈希清单，不表示原图已发布。

# 当前组件关键状态受控展示

2026-10-08，源码 `f720d6a77bdc4f4610c98f7b01d654dcc6d01ae3`。这是独立 SSR 证据入口，**不是安装版，也没有验证真实业务操作**。

主线程授权在 `controlled-views/` 内新增独立导出测试，复用当前生产组件和已有测试 fixture。没有改 `src/`、生产配置、环境变量或全局用户数据；没有使用历史冻结 harness。

- [导出脚本](../../../../reproduction/full-review/controlled-views/state-export.test.tsx) / [独立配置](../../../../reproduction/full-review/controlled-views/state-export.config.ts)
- [12 个场景、来源和哈希](../../../../file-inventory.html#file-168) / [执行回执](../../../../file-inventory.html#file-167)
- 当前 CSS 从 `src/main.tsx` 的依赖图原样展开，共 23 个 CSS 输入，无自定义样式；使用已有产品容器 class 作为孤立组件舞台。它没有侧栏/窗口外壳，不能用其整体位置评价正式 App。
- SSR 无 React 事件处理器。仅 06 使用原生 `dialog.showModal()`，12 将原生附件 `details.open` 设为 true；用于让已有组件内容可见，不是用户操作验证。其他按钮不执行。
- Tauri invoke、文件选择/保存、外部打开、fetch 均拒绝，导出测试断言没有外部 I/O 调用。合成命令只作为字符串显示，没有执行。

| 文件 | 场景 | 必须保留的限制 |
| --- | --- | --- |
| [01](../../../../file-inventory.html#file-154) | 待审批，完整命令、目录与一次批准/拒绝选项 | 合成请求；未决定、未执行 |
| [02](../../../../file-inventory.html#file-155) | 同一审批在停止等待期间禁用 | 卡片属性；未验证取消及恢复 |
| [03](../../../../file-inventory.html#file-156) | 单一文本必填问题，保留已填值 | 原有 fixture 只有文本，不覆盖数值/布尔/多选 |
| [04](../../../../file-inventory.html#file-157) | 回复未知，答案只读 | 不代表真实超时/传输失败 |
| [05](../../../../file-inventory.html#file-158) | 两条待发，停止后暂停，保留草稿 | 组合沿用现有单测内容；未继续发送 |
| [06](../../../../file-inventory.html#file-159) | 第一条待发编辑弹窗 | 仅内存 startQueueEditor；未保存/放弃/发送 |
| [07](../../../../file-inventory.html#file-160) | 停止结果未知、执行状态未知及重试入口 | 未向 Agent 发取消；不证明已停止 |
| [08](../../../../file-inventory.html#file-161) | 读取工作设置失败与重试入口 | 原样测试错误文本；不是实际用户设置失败 |
| [09](../../../../file-inventory.html#file-162) | 文件卡的 Agent 报告片段差异 | old/new 合成，不代表磁盘当前内容 |
| [10](../../../../file-inventory.html#file-163) | 同一片段的分栏差异子组件 | 非整个成果面板；未选行、提交意见 |
| [11](../../../../file-inventory.html#file-164) | 紧凑附件条目 | 内容仍折叠 |
| [12](../../../../file-inventory.html#file-165) | 展开图片、文本及不支持预览资源 | 有效图片只有已有 2×1 PNG；没有音视频/PDF/Office 解码或播放证据 |

媒体页沿用 `MessageContent.test.tsx` 的附件数据形态，仅把该 markup 测试中的伪图片字节换成仓库已有有效 `PNG_IMAGE_TEST_DATA`。没有为音频伪造可播放数据，不扩建媒体播放器。

复现命令（仓库根执行）：

```sh
corepack pnpm exec vitest run --config docs/evidence/2026-10-08-ui-coverage-audit/full-review/controlled-views/state-export.config.ts
```

本次结果：1 文件、1 项通过，1.82 秒。12 HTML 哈希核验一致，生产源码/配置无脏改。主线程 IAB 已于 09:25:50–09:25:51 UTC 渲染全部 12 页，本子任务已逐张目视复核；截图均为 625×769 JPEG。[截图清单](../../../../file-inventory.html#file-169)；完整逐图结论见上层 `state-coverage-options.md`。06 dialog 已打开、12 附件已展开，未见裁切或叠字；没有实际业务操作验证。
