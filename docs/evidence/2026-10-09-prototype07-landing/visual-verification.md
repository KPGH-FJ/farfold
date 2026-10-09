# 正式组件受控可视验证

2026-10-09，当前生产 React 组件与按 `main.tsx` 真实导入顺序收集的 CSS，使用受控状态输出 HTML。浏览器为 Codex 内置浏览器，默认 1280×720 和最小 900×620。页面顶部标示“受控数据 / 非安装实测 / 静态预览”。所有界面数据均为 fixture，无真实账号、凭据或 Agent 请求。

## 实际查看范围

| 界面状态             | 尺寸与截图                                                                                   | 结论范围                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新草稿与侧栏，明/暗  | 1280×720；`workbench-light.png`、`workbench-dark.png`                                        | 页面比例、输入区、工作位置、操作层级                                                                                                                     |
| Agent 目录           | 900×620；`agents-minimum-final.png`                                                          | 探索/管理区分、搜索与卡片                                                                                                                                |
| Agent 能力依据，暗色 | 900×620；`capabilities-dark-minimum-final.png`                                               | 三列表格、未知能力、页脚可见                                                                                                                             |
| Agent 程序/账号/模型 | 900×620；`agent-program-minimum.png`、`agent-account-minimum.png`、`agent-model-minimum.png` | 三个分类、来源与当前选择层级；长内容需页内滚动                                                                                                           |
| 自定义 Agent 长表单  | 900×620；修前 `agent-custom-minimum.png`                                                     | 修后 `agent-custom-minimum-final.png` / `agent-custom-bottom-final.png` / `agent-custom-exit-final.png`：标题/页脚固定，滚动到末项，退出三个按钮完整可达 |
| 通用设置/通知        | 1280×720 与 900×620；`settings-general.png`、`notification-switch-minimum.png`               | 分组与开关外观；不是通知送达证明                                                                                                                         |
| 数据与隐私           | 900×620；`privacy-minimum.png`、`privacy-range-minimum.png`                                  | 滚动查看保留/删除范围及确认勾选；没有执行清除                                                                                                            |
| 对话库               | 900×620；`library-minimum.png`                                                               | 未发计数、筛选、列表                                                                                                                                     |
| 历史导入/移组        | 900×620；`import-minimum.png`、`move-minimum.png`                                            | 预览与范围、确认对象和分组；未导入/移动真实数据                                                                                                          |
| LifeModel            | 900×620；`lifemodel-minimum.png`                                                             | 明确未启用和不采集边界                                                                                                                                   |
| 对话/停止结果未知    | 900×620；`conversation-minimum.png`、`stop-unknown-minimum.png`                              | 真实组件渲染受控正文；停止提示、审批和发送禁用                                                                                                           |
| 附件展开             | 900×620；`attachments-minimum.png`                                                           | 名称、完整路径和内部滚动列表                                                                                                                             |
| 配置比较             | 900×620；`configuration-minimum-final.png`                                                   | 当前/本次、普通设置不承诺保存、未知类型只读                                                                                                              |
| 消息独立重发编辑     | 900×620；`resend-minimum-final.png`                                                          | 主草稿保留说明、输入与发送按钮、关闭保留/放弃                                                                                                            |
| 长命令搜索           | 900×620；`commands-minimum-final.png`                                                        | 长名称/说明换行，行高无重叠                                                                                                                              |

全部截图位于 `screenshots/`。有些对话页面的 textarea 自动聚焦令截图停在下部；这不代表顶部消失。静态 SSR 不执行 React 事件，原生 details 展开/滚动可以检查，按钮业务流程由独立组件回归覆盖。生成了更多配色页面不等于全部浏览器实测；没有宣称覆盖全部尺寸、完整读屏、操作系统界面或所有真实状态。

## 发现及修正

1. 通知开关最初只有状态文字，缺少视觉控件。改为轨道与圆点，保留 switch 语义、焦点、禁用与主题。最终截图 `notification-switch-minimum.png`；旧 `settings-notifications.png` 仅为修前证据。
2. 长命令继承通用按钮固定高度，长说明实际重叠。改为自动高度且禁止被 flex 压缩。`commands-minimum.png` 为修前，`commands-minimum-final.png` 为修后。
3. 自定义接入表单超出弹窗可视范围：原 dialog 高度 556，但 form 延伸到 y=887，确认区在视口之外。仅为该表单增加纵向布局，标题与页脚不缩小，正文独立滚动。修后正文 y=102–524，可视 422 / 内容 716，页脚 y=524–587；浏览器滚动到环境变量末尾，按钮保持可见。退出确认三项完整可达，默认焦点在继续填写。13 项行为测试、类型与构建通过。
4. 重发按钮曾出现黑块和页脚裁切，定位为受控页面缺失正式祖先节点导致 CSS 不命中。修正渲染 fixture 后恢复正常，没有把该假象作为产品缺陷或修改产品布局。配置比较同样修正 fixture。`resend-minimum.png`、`configuration-minimum.png` 是无效外层的早期证据，最终版本使用 `*-final.png`。
5. Agent 目录和能力表的早期输出同样补齐实际路由祖先，最终以 `agents-minimum-final.png` 和 `capabilities-dark-minimum-final.png` 为准。

`visual-artifacts.json` 记录最终交付文件的 SHA-256，用于后续核对文件是否改变；不冒充每次截图时的逐文件源快照。上述修前与错误 fixture 截图保留并明确标识，不当作最终 UI。
