# 正式浏览器命令的隔离验证（2026-10-04）

已通过两条真实路径：`results/destroy-20261004T021757Z.json`、`results/exit-20261004T021823Z.json`。两次进程均正常退出，分别验证 main Destroyed 与最终 Exit 时有活跃页面的清理。此包完成即停止，未继续浏览其他网站。

## 实际运行的范围

直接以 `#[path]` 引用仓库 `src-tauri/src/browser_workspace.rs` 及其原始子模块，原生对象直接编译仓库 `native/BrowserWorkspace.m`。没有替换生产命令或 URL 策略，也没有链接/运行 Farfold lib、setup、MetaStore、Keychain、用户窗口、Agent、MCP 或模型。仅 Tauri 2.11.5 自有内存 Context、合成主页面与一个独立非持久 WK sibling；只匿名打开本轮已授权的 `https://example.com/`。无 `.app` 构建/安装、无日常 profile。

正式模块内容及 SHA256 在 `production-source-provenance.json`；`production-source/` 是运行后核对 hash 一致的只读归档副本。相较 backend-staging 原冻结包，只有 root 的 policy.rs let-chain Clippy 修正，正式 hash 为 `27cfa9885538eb2b41003e6e0eacd8eb4338ce6d02f262aed4572a17fcd4bdea`。其余正式生产浏览器源与冻结候选保持一致。

`context.rs` 的手写 Context::new 属于本版本限定的验证器，不是产品接缝方案。没有新增产品环境开关或插件权限。合成 evidence helpers 仅读此次探针的事件/视图状态和请求退出，不进入产品。

## 本次得到的证据

每条实际主页面 invoke 路径均完成 8 项检查：

1. 真实 `browser_workspace_open` 创建页面并返回 owner。
2. 从正式 `browser-workspace:state` 事件看到该 owner 的 ready。
3. Witness 在 main 的同一父视图下找到唯一独立 WK sibling；其 websiteDataStore 非持久、userScripts 为空。
4. 真实 `browser_workspace_snapshot` 返回当前 WK 的 URL、标题、正文与 revision（本次实际标题为 Example Domain）。
5. 真实 close Promise 成功后，Witness 保留的同一对象已脱离 superview。
6. 同一旧 task/label 再 snapshot 被正式命令拒绝。
7. 再 open 得到不同 owner 并实际加载完成。
8. 第二页确实仍附着，然后由真正的 main Destroyed / Exit 事件调用正式清理；事件处理后 Witness 确認 detached。

Witness 只保留被观察 WK 对象以核对 detachment，不读取私有 registry、内存地址、其他窗口或资料。没有 userScripts 是局部证据，不能单独证明完整 IPC 隔离；无应用桥的完整边界仍由独立 WK 的代码结构与此前探针支持。

## 命令与回执

- `sh build.sh`：strict clang（正式原生源+独立 Witness）与缓存 Rust/Tauri 依赖编译，退出码 0；`results/compile.log` 无错误输出。
- `python3 run_probe.py destroy`：退出码 0，8/8 步骤，main Destroyed 和 Exit 观察均 detached。
- `python3 run_probe.py exit`：退出码 0，8/8 步骤，Exit 观察 detached。

每个运行有独立 JSON 与原始日志；脚本使用新结果路径，不覆盖旧证据。`execution-summary.json` 记录结果、退出码与源码 hash。源码清单排除可执行文件、对象、静态库与缓存。

## 仍有的边界

这关闭了此前“只有 native 探针，没有实际生产 Rust 命令”的证据缺口。它不是完整 Farfold 运行验证，不包含产品 UI 操作、全部插件命令 guard 回归、打包、任务切换浮层时机、网络失败路径、原生 close-all 回调重入压力测试或系统沙箱。navigate/resize 已注册和编译，本次未额外调用；不把它们记为真实 UI 交互已验。没有 Agent 共享、ACP/MCP 生产启动与秘密/账号交接。

正式仓库集中 Rust/前端测试和 UI 审核由根任务执行；本包不据匿名 example.com 的成功推断任意站点兼容性。
