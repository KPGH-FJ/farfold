# HTML 文件与内容栏：真实 React / Tauri / WK 接缝

2026-10-05（Asia/Shanghai）。所有页面、文件和回复均为新建合成数据；没有启动正式应用、正式 setup、Agent 或模型，没有读取用户对话、游戏文件、凭据、终端或桌面。

本目录沿用已有独立内存 Tauri context 和同一应用标识，不创建或注册 `.app`。主页面执行正式 `MessageContent`、`ArtifactPane`、`OpenedFileView`、`BrowserWorkspace`、文件与浏览器 client/scope/guard；后台执行正式文件交付、浏览器命令与 `BrowserWorkspace.m`。使用已有 Vite/Rust 缓存，不安装依赖。

只有合成 thread 的内容栏开关替换为内存回调；不构造真实 ThreadsStore。事件测试桥把真实 Rust 状态事件转发给主页面监听，core 包装仅记录调用后转发实际 Tauri invoke。切换文件沿正式 `browserSurfaceGuard.runLatest` 先等待原页面关闭确认。没有 mock React hooks、假 native frame 或伪造文件回执。

## 两个真实失败

1. [标题栏偏移](results/geometry-analysis-before.json)：22 个可见样本均向上偏 28pt。主 WK 的 full bounds 高 760，而 DOM 高 732；safeAreaRect 为 `(0, 28, 1100, 732)`。旧实现把 DOM 坐标直接当作 full-view 坐标。实际 [测试窗口截图](results/before-window-ready-narrow.png) 显示网页盖住第二行按钮和提示。最初旧几何断言使用同一个错误原点，不能算通过；本记录显式纠正。
2. [旧尺寸与快速窗口变化](results/geometry-rapid-before.json)：受控注入一次旧 DOM 尺寸 IPC，在窗口缩小时仍须接受；随后快速恢复尺寸，DOM 最终值不变，native 仍保留缩小时的坐标映射，出现 120pt 偏差。此为受控在途 IPC 情况，不冒称普通用户拖动已复现。

## 最终结果

**19/19 通过**，输入前后摘要一致，进程正常退出。最终 native SHA：`5d50172a409daa4b4878554551dceb831e18dc2476e827d0e8ff103ea5427ce8`。

- [最终完整结果](results/sharing-20261004T182258Z.json.gz)、[执行与输入回执](results/receipt-20261004T182258Z.json)、[简洁结果与截图摘要](results/final-summary.json)。
- 真实点击 HTML 链接后核实并打开；切另一文件先取得 close ACK 再首次核实；同名重点击重核；文件/网页 tabs 往返不重复打开；Markdown 实际读取成功。
- 宽栏、窄栏、放大、pageZoom 1.25、零安全区、收起/恢复的独立坐标误差为 0（缩放仅浮点 epsilon）。越界恢复保持隐藏，有效恢复保留原页。
- 与第二个失败完全相同的旧尺寸 IPC + 快速窗口变化用例已变为差 0；保持同一个页面，无 JS 重发/刷新。
- 已查看真实 [宽栏](results/window-ready-wide.png)、[窄栏](results/window-ready-narrow.png)、[放大](results/window-expanded.png) 截图，按钮和提示完整可见，网页从正文边界开始。

隐藏状态不比较 DOM 与旧 native frame：页面应保留并隐藏，只有重新显示后才要求几何一致。最初模拟截图、测试打包错误和 selector 错误不计入最终通过数。

## 截图和范围

`before-window-*` 和最终 `window-*` 使用 `CGWindowListOptionIncludingWindow`，仅指定此探针自己持有的 NSWindow ID，是真实窗口画面，不截桌面或其他应用。最早的 `ready-*.png` 是 own-WK 分别快照后合成；它掩盖了坐标原点错误，**不作为最终视觉证据，也不建议归档**。

正常流程覆盖点击 HTML 链接、实际核实文件、首次自动 HTML 打开、宽窄栏、放大、缩放 1.25、零标题栏安全区、改变窗口高度、收起/恢复、无效恢复拒绝、换 HTML 先关闭、同名重点击重核，以及 Markdown 文件真实读取。外部浏览器按钮不点击，不影响用户默认浏览器。

此证据不覆盖真实 Agent 请求、正式 ThreadView/存储、正式安装版、用户游戏的物理输入；那些结果单列。

## 复现与归档

1. `node build-ui.mjs`：真实依赖打包，记录所用生产前端源码前后摘要。
2. `sh build.sh`：从正式源码准备未改 sharing 模块的构建副本，编译正式 native/Rust 模块，校验输入稳定。
3. `python3 -B run_probe.py`：运行新独立窗口，正常退出，产生 JSON 回执和自己窗口的 PNG；界面执行需要相应授权环境。

参考 `curated-files.json` 归档。无需归档二进制、目标文件、构建后的 JS/CSS、生成的 sharing 模块副本或用户文件。必要生产源码以摘要及仓库提交定位；未改 sharing 模块也可对照此前 `docs/evidence/2026-10-05-local-html/command-check`，不新增大段拷贝。

原始三份完整几何结果按字节 gzip 保存，展开后的摘要与本地原件一致，见 `compressed-payloads.json`；复现脚本会生成普通 JSON。其余合成输入及回执保持捕获字节。
