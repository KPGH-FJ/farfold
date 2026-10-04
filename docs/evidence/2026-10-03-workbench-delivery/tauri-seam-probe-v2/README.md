# 修复后 ABI：真实 Tauri / WK 窄复验

2026-10-03。仅验证已冻结 `../browser-lifecycle-fix/native/` 新 ABI 在真实 Tauri 2.11.5 主视图中的正常接缝。未修改或启动 Farfold，未创建/安装 `.app`，未使用网络、账号、日常 profile 或模型。

**结果：退出码 0，23/23 检查通过；主视图实际 invoke 与大消息 channel 往返成功。**

## 已执行

- 沿用前一版的独立内存 Context、自有主视图和仅探针命令；主 WK 显式 incognito，运行时确认非持久数据仓库。Context 不读取生产配置/数据，未加载生产插件。
- 通过稳定 `get_webview_window("main").with_webview` 取得真实主 WK，接入使用独立空脚本控制器和非持久仓库的原生 WK。
- 使用新生产原生函数 `ff_browser_navigate(id, 71, "about:blank")`。真实 `loadRequest` 返回的 WKNavigation 经实际异步 start / finish 回调均保留 token 71；没有手工绑定导航对象或伪造该回调。
- 完成导航后，探针专用代码向该空白页面写入固定合成 DOM，随后由原生固定隔离脚本读取。此测试布置不作为正式工具导出，不提供任意 eval/URL/控制端口。
- 页面实际没有 Tauri 桥或父 IPC handler；真实正文正确返回，合成输入值被排除。
- 新 `ff_browser_close -> bool` 在清理后确认，取消正在读取的内容；后续读取、调整位置和重复关闭符合预期，200 ms 后没有迟到正文。

原始结果在 `results/seam-20261003T174153Z.json`，实机日志在同目录 `execution-20261003T174153Z.log`。`results/latest-run.json` 保存 argv 和退出码。编译成功，`results/compile.log` 为空。内部 15 秒、外层 25 秒限制；探针已退出。

## 独立只读复核结论

对 `browser-lifecycle-fix` 的本次范围未发现仍需阻断草稿归档的新增问题。复核推动补齐的三处均已落代码：

1. 主线程 ACK 8 秒 deadline；未执行的过期闭包跳过，关闭身份保留供重试，不在确认前发布 closed 或放行替换。
2. 创建已执行但 ACK 无法送达时立即关闭新原生视图，避免接收方取消造成遗留页面。
3. 策略取消通过该 WKNavigation 自身 token 发出 blocked 终态；迟到旧取消由状态机过滤，避免当前页面永久 loading。

原有修复同时保留关闭 owner 到真实 ACK，串行替换，并把原生 WKNavigation 对象绑定到导航 token。实现方另存 Rust 30/30 与独立原生生命周期 10/10；其中手工迟到终态注入明确作为故障注入，另有真正异步 about:blank 完成证据。

## 证据边界

- 本次 23/23 是**修复后 native 在真实 Tauri 主视图的接缝**，没有连接新的 Rust BrowserWorkspace 命令调度状态机，没有在此进程进行主线程派发失败/超时/取消故障注入。
- Rust 状态单测、独立 native 生命周期检查与本次 Tauri 接缝是分层证据，不能写成 v2 Rust 命令调度或 MCP 整链通过。
- 前一版 `browser-seam-validation` 19/19 以及 `mcp-controlled-validation` live 成功对应修复前 ABI；继续保留其自身范围，不能拼接成修复后整链验收。
- 未访问公开网站、执行真实登录、检查日常浏览器 profile，未验证真实产品 UI 布局/焦点/遮挡、账号交接或通用网络沙箱。

## 复现与归档

```sh
sh browser-seam-validation-v2/build.sh
python3 browser-seam-validation-v2/run_probe.py
```

仅用本机现有 clang/rustc 和只读 cached rlibs；GUI 运行需受控批准。二进制参数入口与前一版相同，但本轮未将此 v2 入口接到 MCP。

`native-source-provenance.json` 记录复制来源与 SHA256；归档时原生 `.h/.m` 与生命周期修复目录逐字一致。仅归档 `evidence-manifest.json` 所列源码、脚本、日志和回执；排除 `seam-probe`、`.o/.a` 及缓存。按 root 指示，本次不继续扩测。
