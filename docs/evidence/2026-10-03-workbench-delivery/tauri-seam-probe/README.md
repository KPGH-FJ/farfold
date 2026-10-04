# 真实 Tauri / WK 接缝受控验证

2026-10-03。独立短命可执行探针，未注册到 Farfold，未创建或安装 `.app`。

本轮已将“真实原生 WK 小样”推进到 **真实 Tauri 2.11.5 主视图 → 稳定 `get_webview_window("main").with_webview` → 独立原生 WK 同窗子视图**。首次执行退出码 0，原生检查 19/19 通过，主视图自己的 invoke 和 channel 往返均成功。

## 执行安全范围

- `context.rs` 自建内存 assets 和探针 identifier；不读生产配置、资源、MetaStore、Keychain、对话、凭据或环境值，不调用 Farfold setup/Agent/模型。
- 仅使用已缓存 Tauri 2.11.5 依赖离线编译，未安装依赖或修改仓库。`Context::new` 是框架公开但不承诺稳定的生成结果接口，仅供本次固定版本探针；正式接缝所用 `with_webview` 为稳定 API。
- 主 WK 显式 `.incognito(true)`，运行时再检查 `websiteDataStore.persistent == false`；子 WK 另建非持久数据仓库与空脚本控制器，不接默认或日常 profile。
- HTML 全部在源码中合成。主页面仅用 `tauri://localhost` 内存 asset；子页面仅 `loadHTMLString` / `about:blank`，导航白名单只接受 `about:blank`。CSP 禁止网络、frame、表单等目的地。没有公网、真实账号、真实网站或用户文件页面。
- 探针只注册 `probe_parent` 和 `probe_ready` 两个合成命令，校验 main + 本地来源。框架自己的 core/channel 属于真实 Tauri 运行时；未加载生产应用插件。
- 通道发送本探针自己的 9,020 字符 canary，实际经过 Tauri 大消息 channel fetch；没有猜测其他 channel id、读取真实通道、覆写内置插件或放出控制端口。
- 内部 15 秒超时、外部 25 秒上限。成功/失败写 JSON 后退出；本次成功前已关闭子 WK。没有安装动作。

## 成功证据

- `results/seam-20261003T171910Z.json`：19 个真实原生检查及主视图回执。
- `results/execution-20261003T171910Z.log`：实机运行日志。
- `results/latest-run.json`：实际 argv、退出码、结果/日志路径。
- `results/compile.log`：编译退出 0，成功日志为空。

主视图实际命令返回固定 `SEAM_INVOKE_CANARY`；实际 Channel 返回完整大消息。随后才调用官方 `with_webview`，并验证：

1. 接缝返回真正 WK，父与子同窗但不同视图，主 WK 非持久；子独立脚本控制器和非持久 store。
2. 子页面实际看不到 `__TAURI_INTERNALS__` / `ipc`，无法调用父 WK 的 `ipc` handler；不是只证明禁用按钮。
3. 固定隔离脚本世界返回真实子页面 DOM，剔除合成输入 canary。
4. 在读取尚未回调时关闭，收到取消而非正文；关闭后不能再读/调整位置，重复关闭无副作用，200 ms 后没有额外读取放出。

这些是一次受控页面上的接口证据，并非完整攻击面证明、任意网站兼容证明或生产验收。

## 复现与受控 MCP 调用入口

```sh
sh browser-seam-validation/build.sh
python3 browser-seam-validation/run_probe.py
```

运行需要 macOS GUI 权限。`run_probe.py` 使用 25 秒超时并保存结果。直接参数形式：

```text
seam-probe OUTPUT_JSON REQUEST_ID TASK_KEY LABEL REVISION
```

`OUTPUT_JSON` 必须位于 task-3 内现存父目录、是新的 `.json`；使用 `create_new`，不覆盖已有文件。其余字段只限简短身份元数据。该入口不接受 URL、JS、任意读取路径或控制端口；每次进程都创建新的受控真实 Tauri/WK 页面。成功回执顶层有 `requestId/taskKey/label/revision/url/title/text/observedAtMs/pass`，并附原始检查记录。

这些身份参数仅供外层受控 MCP 服务核对请求；此进程本身没有实现生产任务授权、秘密暂停、账号身份变化或 Agent 接管。不能把传入 taskKey 当作已完成生产鉴权。外层必须在启动前后核对授予和请求，并把失败回执视为失败，不能重放预存 JSON 当作新读取。

## 尚未完成

- 未修改/运行 Farfold 正式集成，未使用正式生产 BrowserWorkspace 状态机；既有草稿的 close ack、替换投递失败、导航乱序问题正在独立修复，不能由本正常接缝通过结果抵消。
- 本片没有正式 MCP 注入、Agent/模型或真实网站请求。兄弟任务的受控 MCP 验证将从 tools/call 实际启动此进程，其证据另存 `../mcp-controlled-validation/`。
- 未验证公开站点、登录、重定向/子资源、LAN 隔离、真实 UI 布局/焦点/遮挡或平台兼容性。
- UI 评审仍独立待用户反馈；不重复询问已选定的内嵌方向。

归档只取 `evidence-manifest.json` 的源文件、结果、日志和脚本，不带 `seam-probe`、`.o/.a/.rmeta` 或缓存。
