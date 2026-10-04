# 正式组件受控视觉核验

最终候选于 2026-10-04 在独立 WKWebView 中完成 8 张布局截图；生产组件静态渲染 6/6 通过，外部调用计数为 0。所有数据为合成数据，未运行正式 App、Agent、模型请求或浏览器账号，未读取用户对话与桌面。

本仓库平铺归档其中 4 张截图及全部尺寸回执；未归档的截图与 7 份合成 HTML 仍在原执行目录 `/Users/tw/Documents/Codex/2026-10-03/task-3/production-ui-20261004/visual/output/`。下表仅为已归档附件提供相对链接。

## 最终结果

| 场景 | 尺寸 | 证据 |
| --- | --- | --- |
| 读取确认、停止与待发 | 1440×900 浅色 | [截图](request-desktop.png) |
| 读取确认深色 | 1440×900 深色 | [截图](request-dark.png) |
| 读取确认窄窗口 | 640×900 浅色 | 截图仅在原执行目录；[尺寸回执](verification.json) |
| 对话与浏览器并排 | 1440×900 浅色 | 截图仅在原执行目录；[尺寸回执](verification.json) |
| 浏览器覆盖模式 | 640×900 深色 | [截图](browser-dark-narrow.png) |
| 正文、模型、思考与发送 | 640×900 浅色 | 截图仅在原执行目录；[尺寸回执](verification.json) |
| 浏览器中的待确认返回入口 | 640×900 深色 | [截图](browser-pending-narrow.png) |
| 浏览器全窗口 CSS 状态 | 1440×900 浅色 | 截图仅在原执行目录；[尺寸回执](verification.json) |

检查后修复并重新截图的两项问题：浏览器页签残留系统默认凸起边框且深色未选中项对比度不足；Markdown 列表因全局 padding 清零而标记贴边。最终页签使用主题色且无默认边框，列表恢复 21px 缩进。

最终 8 张截图无页面横向溢出、无控件超出横向视口、无控制台错误。发送与待发按钮在对应对话布局中完整落于视口；圆角输入框为桌面 24px、窄窗 22px。深色读取确认按钮采用反色；待发保持文字按钮，停止保持独立入口。全窗口网页区域铺满 1440×900，侧栏与对话不再占据空间。窄窗浏览器上的“返回对话确认”入口可见。最终截图已经人工检查，未发现本片范围内新的阻塞问题。

## 证据范围

真实生产组件：Sidebar、ThreadView、Composer、ArtifactPane、BrowserWorkspace、BrowserReadRequest、BrowserShareControls。顶栏由合成容器使用 App 现有选择器；正文与状态来自受控内存数据。生产源码摘要在 [source-hashes.json](source-hashes.json)，截图与尺寸回执在 [verification.json](verification.json) 和 [capture-receipts.json](capture-receipts.json)。

这是静态组件和布局核验，不运行 React effects，不证明按钮点击、焦点恢复、真实网页加载或许可后继续工具调用。浏览器内容为组件真实的初始空页；等待确认的元数据单独注入以核对返回入口位置。全窗口截图显式加入生产 CSS 状态类，仅证明相应布局，不伪称执行过展开事件。覆盖模式下尺寸测量不等于被覆盖控件可操作，已另以截图核对显示层级。

## 重现

以下为原执行目录的命令记录，不应在本归档目录直接执行。原执行目录的 `node_modules` 只软链接已安装依赖，Vite 缓存也定向原执行目录；归档脚本保留原源码与缓存绝对路径，没有写生产源码或创建生产测试文件。

```sh
cd /Users/tw/Documents/Codex/2026-10-03/task-3/production-ui-20261004/visual
node /Users/tw/Desktop/farfold/node_modules/vitest/vitest.mjs run --config vitest.config.mts --configLoader runner
python3 capture-fixtures.py
```

截图程序为本任务此前从受控 `capture_review.swift` 编译的 `/tmp/farfold-capture-task-first-20261004`，只加载指定本地合成 HTML，使用独立非持久 WK 数据区和自身视图快照，不截桌面。
