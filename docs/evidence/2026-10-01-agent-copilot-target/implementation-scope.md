# Copilot 同包登录目标的实施边界

2026-10-01。这是下一片的接入层证据设计，不是新活动计划。当前仅只读核对[初始化观察](observation.json)、[探测脚本](probe.py)、[原后续设计](../2026-10-01-agent-access-directory-batch5/copilot-followup-design.md)、现有认证/安装源码及同一已装包的公开清单、loader；没有运行应用、Agent、登录或 Cargo，没有修改生产源码或用户配置。

## 本次可以推进的依据

一次实际 `initialize` 确认：原 `copilot-login` 旧声明的绝对目标等于已选安装根内、同版平台包的导出程序；不同于登记的 Node 和 loader。参数精确为 `['login']`，方法及终端声明未声明非空环境覆盖。此前[安装版固定拒绝原因](../2026-10-01-agent-auth-route-diagnostics/installed.md)与这个关系一致，但本探测仍不是安装版登录验收。

公开包内容再次核对：主包 `@github/copilot@1.0.89` 的 `bin.copilot` 为 `npm-loader.js`，可选依赖 `@github/copilot-darwin-arm64` 固定同版；平台包为同版、`os=['darwin']`、`cpu=['arm64']`、`exports['.']='./copilot'`。loader 使用 `import.meta.resolve` 解析平台包，再由 `spawnSync` 原样转发 `process.argv.slice(2)`。不从描述文字提取参数，不调用 CLI 查版本，不以文件摘要作为程序准入条件。

## 最窄准入关系

1. 仅 `registry:github-copilot-cli`、登记来源 `registry`、组件版本 `1.0.89`，已登记绝对 Node 与原参数精确 `[绝对 npm-loader.js, '--acp']`。这个版本限定是已核对补充的适用范围；不禁止其他版本安装连接，也不自动升级或降级程序。
2. 沿 `installations.v1` 找唯一匹配当前 command/args/version 的 `managed`、非 `programOnly` 收据。规范化安装根必须是正式数据目录 `agents/registry:github-copilot-cli` 的直接子目录；父目录和根被重定向、无收据、其他安装或不唯一时不补充。路径本身不产生所有权。
3. 有界读取当前根内主包与平台包清单，逐项核对名称、版本、bin、固定平台依赖、平台与导出。loader、清单和导出程序规范化后均须在同一已选根内，登录目标须精确等于该导出且可执行。不能把“同根的某个文件”当作同程序证明。
4. **核验 loader 的实际解析位置。**`import.meta.resolve` 可能先命中更近的 `node_modules`；只核对根下 sibling 平台包会出现“验证 A、运行 B”。最小实现可只支持已核实的扁平安装布局，并拒绝更近层同名平台包；若支持其他布局，应有界核对最近实际解析包。不能靠二次 PATH 查找或运行 Node 探测补这个关系。
5. 只接受当前目标连接的实际声明：未标无效、缺省 `type`、ID 精确 `copilot-login`、旧终端对象结构合法、绝对目标匹配、参数精确 `['login']`、方法与终端环境为缺省或空对象。畸形、非空环境、其他参数或缺少实际声明仍走原固定拒绝出口；不将失败转成 `authenticate`。
6. 成功只产生冻结的已登记 Node、同一绝对 loader、`login` 参数；替换接入用的 `--acp`，不在其后追加登录。保留原 shell/HOME/用户登记环境语义，不保存秘密或扩大已有凭据授权。标准 Terminal 始终先按协议原义处理，不被此旧声明补充改写。

## 建议文件范围

- [recipes.rs](../../../src-tauri/src/acp_client/recipes.rs)：仅放已核对的官方适用范围及来源。
- [auth_route.rs](../../../src-tauri/src/acp_client/auth_route.rs)及必要小 helper：核同包、收据、解析位置并生成调用；保持现有固定错误原因、无效声明优先和 typed Terminal 权威。不建立新存储或全局路径映射。
- [auth.rs](../../../src-tauri/src/auth.rs)：方法查询与实际执行共用同一范围证明。实际运行时重新派生，不能把较早 UI 查询结果当授权；仍须当前目录、已有来源的实际连接，拒绝在 `environment_for`、Keychain 和 PTY 启动之前发生。
- 对应认证路线/实际命令派发测试：可沿现有测试夹具新增受控包目录，不操作真实安装包、账号或配置。UI 继续使用统一 terminal 入口，无品牌分支。

既有 `managed_kilo` 布尔证明若需扩展，使用当前调用内的小型证明值携带已核实目标即可；不把补充写进数据库、缓存为可执行声明，或放宽所有解释器的同程序判断。

## 必要反例与安装出口

受控用例先红后绿：同包合法 loader→平台导出成功且 argv 不含 `--acp`；其他安装、同名 PATH 程序、缺失/重复/非选中收据、外部 symlink/目录逃逸、清单/版本/os/cpu/导出不匹配、更近层平台包遮蔽均拒绝；同方法 ID 的未知参数、畸形/非空环境、无效标记不补充；拒绝不读取或交付凭据、不创建 PTY、不发 `authenticate`。标准 Terminal 字面追加行为、普通 Agent、Kilo、Amp、Qwen 既有路线必须保持。

当前 startup 片安装退出后才开始这片源码。工程及独立审查通过后，在同一正式安装候选上：原 Copilot 重查 → 方法可运行 → 明确点击启动 → 核对冻结目标/工作目录 → 暂离重入 → 普通取消 → 返回原稿 → 退出并核对观察进程与原数据。未提供新凭据时只验证启动与取消，不声明登录成功；早取消需单独受控或实际证据，不由普通取消推出。

进程边界保留：探测直接子进程已 wait 回收，但即时 `processGroupAbsent=false`；后续[按选中程序和启动时间核对](process-followup.json)为零，不等于所有后代均已审计。三表摘要保持也不证明全部外部配置未发生写入。
