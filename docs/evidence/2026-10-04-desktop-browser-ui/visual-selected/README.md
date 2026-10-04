# 精确选中源码树视觉核验

本目录独立于工作区版本的 `visual` 证据。源码唯一来自 `/Users/tw/Documents/Codex/2026-10-03/task-3/desktop-ui-integration-20261004/selection/source`；测试所有组件导入、CSS、图片读取均改用此路径。未写入生产源码或选中树。

正式组件合成静态渲染 **2/2 通过**，外部调用 **0 次**。独立 WK 视图核验两张截图：

- [桌面读取确认，1440×900](output/request-desktop.png)：当前请求卡、确认/取消/查看按钮、圆角输入框、停止和待发完整可见；浅色对比正常。
- [深色浏览器窄窗，640×900](output/browser-dark-narrow.png)：页签无默认凸起边框，明暗文字可读，地址栏、图标工具与内容收起入口无越界；浏览器覆盖布局正常。

两张均无页面横向溢出、无横向控件裁切、无控制台错误，截图已人工检查。对应 HTML 为 [读取确认](output/01-request-light.html) 与 [深色浏览器](output/04-browser-dark.html)。选中树现有标识和模型控件按其源码如实渲染，不使用未选入的工作区实现替代。

[输入摘要](output/source-hashes.json)记录 22 项组件、CSS 与图片；集合 SHA-256 为 `f45c55526552d31127bdb15b529adfc7d69190ead8b31da9e94a68bf3d0702b5`。[verification.json](output/verification.json)也记录选中树 manifest 摘要、截图摘要及所有尺寸回执。截图后输入无变化。

边界：这里只证明所选源码的静态组件布局。未运行 React effects，不证明焦点/点击/原生网页加载或 Agent 回执；浏览器为正式初始空页。窄窗覆盖后的底层对话盒尺寸仍存在，尺寸检测不据此声称被遮挡控件可操作。

重现：在本目录运行 `node node_modules/vitest/vitest.mjs run --config vitest.config.mts --configLoader runner`，随后运行 `python3 capture-fixtures.py`。复用已有依赖与临时 WK 截图工具，无安装、网络请求或正式 App 启动。
