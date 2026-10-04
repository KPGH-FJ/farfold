# 阶段 0：真实 WKWebView 受控接口探针

2026-10-03 16:24:35 UTC · 仅本地无账号小样 · 未修改 Farfold 生产源码

## 结果

`result.json` 的 **24/24 项检查通过**。这是本机实际 macOS WKWebView 的页面加载、DOM 读取、点击与结果、原生截图及临时 Cookie 仓库隔离；不是 mock 浏览器，也不是 Farfold 安装版、Tauri 集成或 MCP/Agent 已可用证明。

`wk-fixture.png` 是对本小样页面调用 WebKit `takeSnapshot` 得到的截图，已查看确认包含 `Count: 1`。没有读取桌面画面。页面来自固定内存 HTML，全部导航只允许 `about:`，CSP 禁止外部连接和资源；没有网络监听端口、CDP、任意 JavaScript/URL 工具入口、现有浏览器 profile、账号或模型请求。

首次在执行沙箱内运行时停于 macOS LaunchServices/hiservices 连接错误，未进入有效页面验证，见 `execution.log`。仅该探针进程已结束。随后经自动审批允许 GUI 访问，在 35 秒外层超时保护下运行，退出码 0；成功记录见 `execution-host.log` 和 `result.json`。未创建或安装 `.app`。

## 实际覆盖与没有覆盖

| 项目 | 证据性质与结果 |
| --- | --- |
| 同一真实 WK 页面读取 → 点击 → 再读 | 原生 `evaluateJavaScript`：`Count: 0` → 点击固定 Increment 按钮 → `Count: 1`；另一个逻辑任务读到同一结果 |
| 可见页面与截图 | 独立临时 NSWindow 承载 WKWebView，原生截图返回；未安排真人手动接管，不能称人工接管已验收 |
| 临时隔离 | 两个新建 `WKWebsiteDataStore.nonPersistent()`；合成 Cookie 写入 A，B 没有该 Cookie；没有读取默认仓库，不证明所有持久化/重启场景 |
| 输入门控 | 暂停同 context 所有任务的新读取、点击、截图；调用计数证明被拒请求未派发至 WebKit；第二任务没有写控制权 |
| 迟到输出门控 | 真正待完成的 `callAsyncJavaScript` DOM 结果与 `takeSnapshot` 回调在交接后被丢弃；旧授权不能在重新分享后复活 |
| 观察与缓存 | 停止本小样周期观察器；交接清空缓存；从真实 WK script-message 桥送出的旧观察回流被拒 |
| console / trace | **仅合成 console/trace 通道**通过真实 WK script-message 桥送出虚构 canary；统一出口拒绝它们。没有声称已经完整拦截 WK、系统日志或任意第三方执行器的所有采集通道 |
| 身份变化与继续 | 小样显式触发身份变化后撤销所有任务授权；仅重新明确授权的任务可做新观察，其余任务继续被拒。尚未实现任意站点的账号变化自动识别 |
| 秘密 | 虚构 `SYNTHETIC_SECRET_CANARY_7b3a` 只出现在受控页面及拒绝输入；agent-facing emissions 中未出现。未写出秘密阶段截图；这不是对未来真实秘密场景的全面保证 |

仍未覆盖：真实人工输入、任意网站、OAuth 登录、跨源 iframe、弹窗、下载、导航竞态、WebKit 崩溃恢复、MCP 消费方、Agent 实际调用及新建/恢复使用工具。**本次在交接前已等固定点击完成，未证明在途写动作的取消/排空；生产接管必须先进入“接管中”，确认在途写动作已结束或准确报未知后才允许秘密输入。** 没有 OS 沙箱或整个进程安全边界承诺。

## Tauri 真实接缝与决策点

仓库 `src-tauri/Cargo.toml` 声明 Tauri `2.11.5`、`features=[]`；锁文件为 `tauri 2.11.5`、`tauri-runtime-wry 2.11.4`、`wry 0.55.1`、`objc2-web-kit 0.3.2`。本机已缓存对应官方源码，可只读核查：

- `tauri-2.11.5/src/webview/mod.rs:1929` 提供 `eval_with_callback`，回调返回 JSON 字符串；`:1668` 的 `with_webview` 可进入原生页面句柄。
- 同文件 `:997` 的 `incognito` 在 macOS 使用 nonPersistent DataStore；`wry-0.55.1/src/wkwebview/mod.rs:235` 为实际调用。
- 同文件 `:1088` 的 `data_store_identifier` 在 macOS >= 14 才可用；不可把任意 `data_directory` 当作 WK profile 路径。
- `tauri-2.11.5/src/window/mod.rs:1127–1129` 的同窗口 `add_child` 受 `feature="unstable"` 门控。现有 features 并未启用；生产内嵌须明确特性/容器选择，不应承诺现配置直接可用。
- `tauri-2.11.5/src/webview/mod.rs:1066–1076` 的 Chrome 扩展路径在 macOS/WK 不支持。Chrome 的官方扩展不能直接当作当前 WK 插件。

[Tauri Webview](https://docs.rs/tauri/2.11.5/tauri/webview/struct.Webview.html) · [Tauri WebviewBuilder](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewBuilder.html) · [Apple WKWebView 控制接口](https://developer.apple.com/videos/play/wwdc2020/10188/) · [Apple nonPersistent](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/nonpersistent%28%29)

**建议阶段 0 结论：** 原生 WK 路线具备实现固定页面读写/结果与本地门控的技术接缝，可继续研究现有窗口中独立远程内容容器；本探针没有选定生产执行器。启用 Tauri 实验性子视图、采用原生桥、或改成外部共享浏览器，均须形成具体范围后由 root 衔接规划与用户决定。远程网页不能继承主应用 IPC 权限；未审好隔离前不接真实网站。

## Google OAuth 的硬限制与回退

Google 官方政策禁止将授权请求送入开发者可控制的 embedded user-agent，包含脚本注入、请求改写及 Cookie 读取能力；native-app 文档点名 WKWebView 可能返回 `disallowed_useragent`。不能改 UA 绕过。

[Google secure browser policy](https://developers.google.com/identity/protocols/oauth2/policies#use-secure-browsers) · [Google disallowed_useragent](https://developers.google.com/identity/protocols/oauth2/native-app#disallowed_useragent)

系统浏览器/`ASWebAuthenticationSession` 的授权回调只证明对应授权响应；不能推导 WK 获得系统浏览器 Cookie、某第三方站点登录态或同 profile 接管能力。Google/第三方网站须依官方允许路径办理；需要继续外部共享时，向用户说明真实控制范围并明确确认，不自动改选外部路线，不复制 Cookie/token 搬回 WK。

[Google 授权回调](https://developers.google.com/identity/protocols/oauth2/native-app#handlingresponse) · [Apple ASWebAuthenticationSession](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)

## ACP/MCP 受控 peer 的最小建议（未改生产）

可复用现有 `acp_client/preparation_mode_tests.rs:44–61` 的官方 crate 双端 dispatch，它已捕获 `session/new`/`session/load` 的完整 params；或 `process_cwd_tests.rs:34–41` 的受控子进程记录模式。不要另起 Agent 或模型来证明参数传递。

未来 root 若接入可选配置，最少覆盖：默认关闭仍传空列表；显式授权的非秘密 stdio 配置在 new/load 精确保留；未支持的 HTTP/SSE 依据真实声明拒绝或不呈现；恢复原工具选择，不套当前其他任务配置；取消、失效或撤销时不默默补开空白会话。测试材料只使用合成命令/参数；不要把秘密令牌写进快照。

这些测试**只能证明 Farfold 序列化、路由和恢复选择**。真正 MCP initialize/tools/list/callTool 回执及真实 Agent 会不会调用，必须另列独立证据；本小样没有该项。桥的输出门控要覆盖消息、资源、图像、日志等全部通道，且不可向 Agent 暴露绕过门控的原始 WK/CDP 句柄或端口。

## 复现

所有命令仅在本目录执行；需要本机已有 Command Line Tools 和 GUI 访问。GUI 受限时应记录阻塞，不重试真实账号。运行最多 35 秒，结果写回本目录。

```sh
xcrun swiftc -parse-as-library -swift-version 5 -module-cache-path module-cache -framework AppKit -framework WebKit WKControlledProbe.swift -o wk-controlled-probe
python3 run_probe.py
```

源码、回执和截图可由 root 明确复制到项目证据目录；二进制和 `module-cache/` 只是本地临时编译输出，不应纳入源码或证据提交。
