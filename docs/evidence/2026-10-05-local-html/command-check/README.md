# 本地 HTML：真实 Tauri 命令与原生页面接缝验证

2026-10-05（Asia/Shanghai），独立离屏内存窗口，**22/22 通过**。

## 当前有效证据

- [最终命令结果](results/sharing-20261004T172909Z.json)
- [执行与摘要回执](results/receipt-20261004T172909Z.json)
- [生产输入和测试输入摘要](results/build-inputs.json)
- [实际 main 页面调用](workflow.js)、[独立入口](probe.rs)、[内存 context](context.rs)

直接编译当前正式 `browser_workspace.rs`、`local_html.rs`、`native.rs`、`page_read.rs`、文件交付代码、MCP sharing / transient transport 代码，以及 `BrowserWorkspace.m`。Rust 的 sharing 子模块以逐字相同的 fixture 拷贝解决独立编译路径，manifest 在构建、执行前后均检查拷贝与生产文件相同。生产和测试输入在本轮构建及运行期间未变化。

测试通过实际主页面 `window.__TAURI_INTERNALS__.invoke` 调用正式 `file_delivery_inspect`，将完整核实回执经 JSON 传入 `browser_workspace_open_html`，收到真实 WK ready 事件。使用固定测试见证代码确认独立临时 WK 无注入脚本，内联 JavaScript、按钮点击及 Canvas 执行成功，且页面没有 Tauri 全局桥。

实际隐藏命令使原生 HTML view 隐藏；恢复命令显示同一可执行 view；关闭确认后它脱离父视图。修改合成磁盘文件后，旧回执以“文件或位置已变化，请重新检查”拒绝，且未创建新 view；重新核实后打开新 owner，再正常关闭。

实际手动 snapshot 命令拒绝本地 HTML；有效参数的显式分享命令拒绝创建 scope；实际 stdio MCP helper 完成 initialize / tools-list 后，以同一 id 40 返回读取错误，不包含页面正文、不产生公开网页读取审批。helper 正常退出，socket 和其临时目录已移除。

## 范围

此证据仅证明正式 Rust 命令参数解码、真实 WK 执行与生命周期、文件版本校验、本地页禁止公开快照/分享和实际 MCP 拒读。它不证明正式 React UI 布局、文件选择器、用户游戏在安装版中的实际行为或真实 Agent 结果。

仅使用本目录新建的 `fixture/controlled.html`。没有启动正式 `/Applications/Farfold.app`、正式 setup、真实 Agent、账号、模型或网络；不读取用户会话、凭据、配置、终端或桌面画面。沿用应用标识但不创建或注册 `.app` 包；main 窗口 incognito、visible(false)、离屏位置，无磁盘页面资源。测试二进制使用已有 Rust rlib 缓存和系统编译器，无新增依赖。

## 首轮纠正

`sharing-20261004T172817Z.json` 为初轮记录，其中显式分享检查误用了 `expectedRevision`，只取得缺少 `expectedPageRevision` 的参数错误，**不能用该条证明本地 scope 拒绝**。已修正字段并收紧三种拒绝原因断言，最终结论仅采用 `172909Z` 结果；保留首轮供审计，不合并计数。

## 复现

本归档保留当次脚本、绝对路径和摘要，不声称已移植为通用测试包。原执行目录为 `/Users/tw/Documents/Codex/2026-10-03/task-3/html-preview-20261005/command-check`；在那里执行 `sh build.sh` 后运行 `python3 -B run_probe.py`，只覆盖专用合成 fixture 并产生新结果。迁移执行目录须先调整固定夹具/结果/依赖位置，重新生成并验证摘要；不能将旧回执当作迁移后通过。图形执行需同样授权。
