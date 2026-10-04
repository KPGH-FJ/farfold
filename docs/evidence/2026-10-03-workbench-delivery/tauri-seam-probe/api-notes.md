# Tauri 2.11.5 独立接缝探针 API 核对

仅核对本机缓存源码与编译接口。本记录未启动 GUI、未运行生产应用、未读取真实会话、环境值、凭据、profile 或浏览器数据。

## 已交付与验证

`context.rs` 提供 `pub fn context() -> tauri::Context<tauri::Wry>`，以内存中的单份合成 `index.html` 为资源；没有磁盘资源读取、生产配置宏、生产插件、生产能力文件。identifier 为 `dev.farfold.probe.seam-20261003`，产品名为 `SeamProbe`，窗口列表为空。页面包含唯一合成标识 `SYNTHETIC_MAIN_ONLY_20261003`。

CSP 禁止 HTTP(S)、WebSocket、iframe、表单和外部资源；仅 `connect-src ipc:` 允许 Tauri 的进程内协议。主页面本身没有脚本或样式。由原生 API 注入的测试脚本与框架初始化脚本不等同于允许网页载入外部脚本。后续实际执行仍须记录 invoke 是否成功，不能由 CSP 配置推断成功。

已执行以下**只编译 metadata、不运行程序**的检查，最终退出码 `0`：

```sh
rustc --edition=2024 --crate-type lib --emit=metadata \
  /Users/tw/Documents/Codex/2026-10-03/task-3/browser-seam-validation/context.rs \
  -L dependency=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps \
  --extern tauri=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libtauri-d531b6af9c1a1abc.rlib \
  -o /Users/tw/Documents/Codex/2026-10-03/task-3/browser-seam-validation/context-check.rmeta
```

首次检查指出 `Config.plugins` 是 `PluginConfig` 包装类型；本地 `tauri-utils-2.9.3/src/config.rs:3652` 定义确认为 `PluginConfig(pub HashMap<...>)`，因此改为 `config.plugins.0.clear()` 后通过。无其他编译改动。

## 最小真实主窗口

在独立探针二进制的 `setup` 中创建一次窗口，禁止使用生产 Builder、启动函数或插件注册函数：

```rust
use tauri::Manager;

let main = tauri::WebviewWindowBuilder::new(
    app,
    "main",
    tauri::WebviewUrl::App("index.html".into()),
)
.title("SeamProbe — synthetic data only")
.incognito(true)
.disable_drag_drop_handler()
.devtools(false)
.on_navigation(|url| {
    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && matches!(url.path(), "/" | "/index.html")
})
.on_download(|_, _| false)
.build()?;

// 此处为正式稳定 API 路径，无需 unstable feature：
app.get_webview_window("main").expect("probe main exists")
    .with_webview(|platform| {
        // macOS: platform.inner() 是本探针父 WKWebView 的指针。
        // 只交给探针自己的主线程 FFI；不复制其配置/控制器/脚本。
        let _synthetic_parent = platform.inner();
    })?;
```

`WebviewWindowBuilder` 的 `on_new_window` 可明确返回 `tauri::webview::NewWindowResponse::Deny`；此外合成页面自身不含任何链接、网络请求或弹窗代码。不要将外部 URL 放入该主窗口。

必须使用 `.incognito(true)`，**不要传入 `.with_webview_configuration(...)`**：本地 Wry 实现若收到现成 configuration，会直接保留它的 data store；只有未提供 configuration 的路径才按 incognito 选择非持久 data store。

同窗子 WK 应独立构建 `WKWebViewConfiguration + nonPersistentDataStore + 新空 WKUserContentController`，添加到 `platform.inner()` 对应父 view 的 superview；不调用 Tauri `add_child`、不向 Tauri 注册此 WK、不共享父 view 的 userContentController、URLSchemeHandler、初始化脚本或数据存储。

原生验证还应直接核对**主窗口和子窗口各自** `configuration.websiteDataStore.isPersistent == false`，以及二者 data store/controller 对象不相同。`.incognito` 配置只是来源证据，实际对象断言才是执行证据。

## 仅自有 invoke / channel 的真实回执

1. 该进程仅注册 `probe_*` 合成命令，例如 `probe_ping`、`probe_channel`、`probe_report`。在自定义 handler 中核对实际调用者的 label `main` 和精确 `tauri://localhost/` 或 `/index.html`，再分派。命令只返回固定标识、计数或合成内容，不读取路径、系统对象或生产状态。
2. 不使用 `invoke_system` 覆盖实际 IPC，不伪造 `__TAURI_INTERNALS__`，不覆盖内置 channel 插件。`with_global_tauri=false` 只隐藏 `window.__TAURI__`，并不会关闭真实 `__TAURI_INTERNALS__`，应如实验证。
3. 主页面使用自身真实 `window.__TAURI_INTERNALS__.invoke('probe_ping', ...)` 获取合成回执。测试 JS 通过自己的 `transformCallback` 分配回调，向 `probe_channel` 传入 `__CHANNEL__:<本次回调 id>`。Rust 参数用 `tauri::ipc::Channel<String>`，仅发送本探针生成的字符串。
4. 先发送短标识，再发送大于 8192 字节的合成 JSON 字符串，可分别经过直接 eval 与真实内置 channel fetch 路径。主页面核对内容、长度、消息顺序，再通过 `probe_report` 报告。此为进程自己创建、自己消费的 channel；不要枚举/猜测队列 id，不构造跨进程或生产 fetch。
5. 若使用 `Builder::channel_interceptor` 记录合成大小和发送次数，必须返回 `false` 保留真实通路；返回 `true` 会消费消息，不能用于声称验证原实现。
6. 在独立原生子 WK 的真实页面 world 中检验 `__TAURI_INTERNALS__`、`__TAURI__`、`ipc` 和 `webkit.messageHandlers.ipc` 不可用，随后尝试调用子页面自己可见的桥，记录无法发送。父页面可收到自己的 `probe_ping`/channel，并不意味着子页面可收到。
7. 不将父页面 invoke key、回调 id 或任何桥对象复制给子页面。不要为了负例而注册 Tauri 子 webview、注入桥或全局替换网络函数；这些会改变被验证的路线。

这里验证的是“真实 Tauri 父视图 + 不注册的原生子 WK”的接缝隔离与正常父通路，不是对 Tauri 内置队列做渗透测试。合成通路成功不代表生产布局、跨任务收回、持续导航或真实网页已验收。

## 直接 rustc 路径

本机已经有兼容的编译缓存，优先只传入实际使用的 `--extern`，其余由 `-L dependency` 解析。不要另选 `tauri_utils` 的其他哈希副本；Context 使用 `tauri::utils` 重导出避免类型版本/feature 不一致。

```sh
CARGO_PKG_NAME=seam-probe rustc --edition=2024 probe.rs \
  -L dependency=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps \
  --extern tauri=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libtauri-d531b6af9c1a1abc.rlib \
  --extern serde=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libserde-fdec50919a33418e.rlib \
  --extern serde_json=/Users/tw/Desktop/farfold/src-tauri/target/debug/deps/libserde_json-5705a60d2ac33a2e.rlib \
  -L native=. -l static=seam_probe_native \
  -l framework=AppKit -l framework=WebKit \
  -o seam-probe
```

以上完整链接命令是模板：`probe.rs` 和原生静态库由主协作者制作，本子任务未编译或运行该二进制。`CARGO_PKG_NAME` 是为 Tauri command 宏提供的固定编译常量，不是读取环境值。编译生成物必须只写本探针目录，不使用 Cargo 安装、更新、构建生产工程或运行生产 target 下的程序。

## 缓存源码证据与 API 边界

缓存根：`/Users/tw/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`。

| 事实 | 源码位置 |
|---|---|
| Context 构造签名与显式“不保证稳定”的声明 | `tauri-2.11.5/src/lib.rs:342,487` |
| Assets trait 的 get/iter/csp_hashes | `tauri-2.11.5/src/lib.rs:313` |
| Config/AppConfig 默认值及空窗口列表类型 | `tauri-utils-2.9.3/src/config.rs:3003,3583` |
| `.incognito` 转发 | `tauri-2.11.5/src/webview/webview_window.rs:1052` |
| 已有 configuration 复用；否则 incognito 选择 nonPersistentDataStore | `wry-0.55.1/src/wkwebview/mod.rs:226–246` |
| stable `with_webview`，只需 wry feature | `tauri-2.11.5/src/webview/webview_window.rs:2371` |
| PageLoad Finished hook 可启动固定 eval 脚本 | `tauri-2.11.5/src/webview/webview_window.rs:421` |
| 实际 `__TAURI_INTERNALS__.transformCallback/invoke` | `tauri-2.11.5/scripts/core.js:51,81` |
| channel JSON 阈值 8192、队列及原生 fetch 流程 | `tauri-2.11.5/src/ipc/channel.rs:36,144–194,313` |
| channel_interceptor 返回 true 会消费消息 | `tauri-2.11.5/src/app.rs:1692` |
| 内置 channel fetch 特殊 ACL 分支 | `tauri-2.11.5/src/webview/mod.rs:1818` |
| Builder 自动注册框架 core/channel；与生产插件无关 | `tauri-2.11.5/src/app.rs:2398–2412` |

`Context::new` 是公开可调用接口，但源码明确不作为稳定 API。此手写 Context 仅用于已核对的固定 2.11.5 独立探针；正式应用仍应保留原有官方配置生成流程。不要将“此次能编译”描述为跨版本稳定承诺。
