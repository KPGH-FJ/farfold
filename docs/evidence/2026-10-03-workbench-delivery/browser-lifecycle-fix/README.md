# 浏览器生命周期窄修复草稿

仅写本目录；原 `browser-implementation-draft`、真实仓库和唯一计划均未修改。供 root 与独立 Tauri 探针复核后决定是否接入，尚未上线。

## 本次结果

- 原基准新增最小 RED：22 项中 19 通过、3 失败，分别证明关闭回执前丢 owner、替换直接覆盖 owner、旧导航完成错误恢复新页面 ready。`checks/red.log` 与当时测试文件保留。
- 最终 Rust **30/30**；原生受控探针 **10/10**；ObjC 在 `-Wall -Wextra -Werror` 下编译通过。最终证据见 `checks/green.log`、`checks/native-lifecycle-result.json`。
- 原生 probe 经生产 `ff_browser_navigate → loadRequest` 获得两个真实 `WKNavigation` 对象，注入旧 finish/fail/cancel，收到旧 token 41；重复终态和未知旧 start 不新增状态。另有真实异步 `about:blank` token 43 start/finish。故障注入与真正异步回执在结果中分列。
- 基准 hash 见 `basehash.json`；最终源和证据 hash 见 `evidence-manifest.json`。原 policy / policy_tests 已复制到本目录，字节未改；没有跨目录编译依赖。

## 最小改动

五个交接代码文件：`native/BrowserWorkspace.h`、`native/BrowserWorkspace.m`、`rust/browser_workspace.rs`、`rust/browser_workspace/native.rs`、`rust/browser_workspace/tests.rs`。另附独立 `checks/NativeLifecycleProbe.m`；两个未改 policy 文件为打包依赖。

1. **关闭 ACK**：内部 `closing` 保留 owner；读、导航、原生创建资格及迟到事件失效。仅主线程原生关闭执行完（停止加载、移除视图、取消读取、释放 context、清注册表）回执后清 Store 并发布 closed。主线程投递失败、回执断开或 8 秒超时保留归属，公开 error 可重试。没有新增公开 phase。
2. **替换**：先验证全部新参数，再在共享操作互斥内关闭旧页面并等待 ACK，随后 reserve/create 新页面；reserve 本身拒绝覆盖现有 owner。新 create/派发失败留下可明确关闭的新 reservation。旧页面已获关闭 ACK 后不会恢复旧页面；承诺是无 orphan，并不承诺替换失败保留旧页面画面。取消或超时的排队创建跳过执行；已开始创建但 ACK 接收方消失则立即清理该新原生实例。
3. **导航**：显式导航／普通用户链接在 `loadRequest` 返回时登记实际 WKNavigation→token；链接取消原请求后受控 loadRequest。start 不创建 token；finish/fail/cancel 使用自身对象的 token。Rust 同时核对 owner、token、内部 closing 及终态阶段。未知旧 start 无操作；取消已知导航得到其自身 blocked 终态；内容进程退出单独处理 ready 状态。相同 URL 的旧 policy 不抢先消费新请求许可。

内部 FFI 变化：`Status(context,event,navigation,url)->u64`，`navigate(id,navigation,url)->bool`，`close(id)->bool`。前端 BrowserInfo DTO 与 phase union 不变。应用须继续只管理一个共享 BrowserWorkspace；本次未引入多 manager / 多浏览器支持或业务账本。

## 证据边界与失败记录

- Rust 关闭派发/ACK失败路径是状态与 channel/deadline受控测试；原生 off-main 失败、owner 保留与 main close ACK 是真实 FFI 检查。这里没有声称已在真实 Tauri event-loop 中注入派发失败、取消或超时。
- 首轮原生失败源于测试的 `dispatch_sync(global)` 可同线程执行，误把页面真关闭；以 pthread 确保独立线程后保持原断言。原失败保存为 `checks/native-fixture-red-thread-dispatch.json`。
- 第二轮 9/10 暴露同 URL 的旧 action 先消费唯一 pending URL 许可，新请求未开始；改为保留到对应当前 didStart 后最终通过。原失败保存为 `checks/native-fixture-red-policy-permit.json`。最初受限执行环境未能连接 GUI service，仅为执行环境失败，未计入通过。
- 探针用隐藏合成 NSWindow、非持久 WK、about:blank；不联网、不读取用户页面、账号或凭据。原生迟到终态为人工插入真实对象回调，不冒称重现 WebKit 所有自然竞态。
- 当前范围是显式公开地址与普通链接。脚本、表单及完整站点兼容性暂不支持；重定向只在同一已映射 WKNavigation／允许 origin 证据内放行，未验证真实公网重定向矩阵。失败回退为关闭后明确打开地址，不能宣传任意公开网页兼容。
- browser_interfaces 已在独立目录完成新 ABI 真实 Tauri 窄复验 23/23，回执为 `../browser-seam-validation-v2/results/seam-20261003T174153Z.json`；该回执不包含本 Rust Store 命令的真实调度失败注入。旧 19 项接缝、旧 MCP 回执与本片单测不能拼接成同轮端到端证据。生产 UI、共享 broker、官方 Agent 请求均未接入，本片不改变 UI 待审边界。
