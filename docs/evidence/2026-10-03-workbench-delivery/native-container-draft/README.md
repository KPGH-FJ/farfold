# 内嵌公开网页：受控验证与未集成草稿

2026-10-03。用户已选“保留内嵌，先做公开网页”。本目录只提供可审核草稿与证据；没有修改 Farfold 仓库、注册生产命令、安装应用或开放真实网页。

## 已确认

- **独立原生 WK 同窗小样 16/16 通过**：`checks/native-isolation-result.json`。父 WK 有合成 `__TAURI_INTERNALS__`、`ipc` 与真实 WKScriptMessageHandler；另建的原生 WK sibling 使用独立配置、空脚本控制器和临时数据仓库。子页面实际检测不到合成应用桥，不能调用父处理器，能通过固定的隔离脚本世界读取自己的 DOM；关闭后读取/调整位置失败，重复关闭无副作用。仅内存页面，无网络、账号、真实 Tauri 通道或模型。
- `native/BrowserWorkspace.m` 的生产分支以 clang `-Wall -Wextra -Werror` 编译成功。`FF_BROWSER_TEST_FIXTURE` 只在独立小样启用，生产编译没有测试加载/检查 API。
- **Rust 草稿 19/19 边界测试通过**：`checks/rust-tests.log`。用仓库已有编译依赖直接离线 rustc 检查，覆盖 URL/caller、任务归属、旧实例关闭、导航/关闭后的迟到读取、密码输入标记。没有重跑生产全量测试；编译记录见 `checks/rust-compile.log`（成功时为空）。
- 前一轮真实 WK 读/点击/截图与双向秘密交接 canary 证据仍在相邻 `../browser-probe/`，适用其原有范围，不能与本轮拼成生产实现完成。

## IPC 决策

放弃直接把远程页面注册为 Tauri child 的本片草稿：当前 Tauri 2.11.5 普通远程命令有 ACL，但内置 `__TAURI_CHANNEL__` fetch 路径存在单独豁免；仅中心 custom invoke guard 不能证明所有通道都隔离。未探测任何真实通道数据，未改写或 fork 内置插件。

当前草稿通过官方 `main.get_webview_window(...).with_webview(...)` 取得主 WK 句柄，只用其 NSView 父容器挂载一个**不向 Tauri 注册**的新 WK。它不继承主视图配置、不安装脚本消息处理器、不提供自定义 IPC scheme、任意 eval、原始句柄或控制端口。固定只读内容脚本用 `WKContentWorld`，并不把应用能力交给页面。

独立小样是真实原生父/子 WK，但父桥为合成：**正式 Tauri `with_webview` 容器接缝尚未实机验证**，不能将 16/16 当成生产 IPC 隔离验收。

## root 的最小整合接缝（本次未执行）

1. 原生路线沿当前稳定 `get_webview_window("main").with_webview`；**不需要 Cargo `unstable`，不新增 Rust 依赖**。如将来采用该草稿，build.rs 用系统 clang 编译 `native/BrowserWorkspace.m`、ar 打包，链接 AppKit/WebKit；只支持当前 macOS arm64，最低 macOS 11。
2. `lib.rs` 增加 `mod browser_workspace`、`manage(BrowserWorkspace::default())` 及五个命令：open / navigate / resize / snapshot / close。当前只有用户手动打开和读取，**没有 Agent 分享、暂停/接管、MCP 或工具调用接通**。
3. 中心 custom invoke handler 先验证 `browser_workspace::caller_allowed(invoke.message.webview_ref())`，拒绝非 `main` 或非本地应用来源，再调用原 `generate_handler!`。该 guard 不覆盖插件路径，不能独立当作全部 IPC 保护。
4. 将 `capabilities/default.json` 的 `"windows":["main"]` **替换为** `"webviews":["main"]`，不同时保留两者。Tauri 匹配是 OR；不添加 remote capability。现有插件权限保持同范围。
5. `ui_transport::emit_event` 从 `app.emit` 改为 `app.emit_to(EventTarget::webview("main"), ...)`。新网页状态本身已只发给 main。独立 WK 不安装 Tauri 事件监听，但共有出口仍应准确限定接收方。
6. UI 容器以逻辑 CSS 像素提供 bounds；后续操作必须同时携带 `taskKey + label`，事件按 revision 接受。切页/遮挡先关闭原生页面并确认结果；CSS 隐藏不能替代关闭，失败须留重试出口。前端草稿与本地演示另在 `frontend/`，先供用户审核，不在本片仓促接入 App/ThreadView。

建议中心 handler 形态：

```rust
.invoke_handler(move |invoke| {
    if !browser_workspace::caller_allowed(invoke.message.webview_ref()) {
        invoke.resolver.reject("此页面不能操作应用");
        return true;
    }
    tauri::generate_handler![ /* 原命令及上述五个新命令 */ ](invoke)
})
```

## 严格剩余边界

- 页面 URL 由用户明确提供，只允许公开 HTTPS 常见形式；明显账号/OAuth/秘密参数及跨 origin 自动跳转拒绝。**规则不能识别所有登录、DNS/内网/子资源访问，不是通用网络沙箱。** 不扩大本片为完整公网安全浏览器。
- 新建临时仓库，不连接日常 profile，不保存登录。不承接真实登录、OAuth；Google 禁止可控嵌入 user-agent 的已核官方限制继续有效。
- 默认不分享给 Agent；本片没有 MCP 接线，也没有 pause/control-owner UI。复制正文或未来工具使用需明确后续范围。
- 当前固定读取排除输入/表单/可编辑区域，遇密码或验证码输入标记拒绝内容；这不是所有秘密识别。页面结果仍是不可信站点内容。
- 原生草稿拒弹窗、子框架导航、下载、文件选择、媒体请求与脚本交互对话框。它没有证明所有网站兼容。
- 后续工作包：用户审本地交互 → 实际 Tauri 容器布局/遮挡/切页收回和异步导航生命周期验证 → 一条获准公开网址完整读取 → 再决定官方工具桥。任一步未核实不得以本小样替代。

## 证据与复现

`evidence-manifest.json` 冻结本轮核心源码、探针源码、结果及日志；不包含二进制、`.o/.a`、缓存。`checks/commands.txt` 保留成功编译/检查命令。GUI 小样运行需要 macOS 图形访问，已在25秒外层超时内完成并退出。

所有写入限于本目录。未修改共享源码、唯一计划或现有 Git 改动；没有真实账号、凭据、环境值、会话内容、桌面读取、安装或模型请求。
