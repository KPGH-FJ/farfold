# Copilot 1.0.89 登录入口：只读诊断

2026-10-01。只读本批公开登记、界面文本、Farfold 路由源码、已安装官方包的公开文件和官方网页；未启动 Agent/应用/登录、未读凭据、用户配置、数据库或协议正文，未改生产源码或运行测试。

**结论：官方有可核实的 `copilot login` 入口，当前 Farfold 没有核实 Copilot npm 启动器与其平台程序之间身份关系的补充。界面禁用符合现有保护；本次实际声明中的执行命令未包含在允许读取的证据里，尚不能确认究竟是哪一种路径导致拒绝。**这也不证明当前账号未登录或必须重新登录。

## 已观察与静态依据

- [公开登记](copilot-registration.json)：`registry:github-copilot-cli`，包和 `agentInfo.version` 均为 `1.0.89`；选中程序为绝对 Node 路径，参数为受管目录 `install-UPmD8l/node_modules/@github/copilot/npm-loader.js`、`--acp`。公开方法 ID 为 `copilot-login`，名称为 `Log in with Copilot CLI`。`containsExecutionFields:false` 是公开快照的既有边界，不能据此还原实际执行命令。
- [现场账号页](copilot-auth.txt)：描述为 `Run \`copilot login\` in the terminal`；“开始登录”禁用并显示“此登录声明未能确认对应程序，请在更多登录方式中明确配置登录命令”。未点击登录；更多登录方式、重查仍可见。模型读取完成但未提供可选模型，不是账号/请求成功证据。
- 已装 `@github/copilot/package.json` 第 16–18 行将 `copilot` 入口声明为 `npm-loader.js`，其平台可选依赖全部固定为 `1.0.89`。`npm-loader.js` 第 7 行按平台/架构 `import.meta.resolve` 相应包，再用 `spawnSync` 将 `process.argv.slice(2)` 原样传给该包入口，`stdio` 继承。没有经 PATH 查找另一个 `copilot`。
- 同一受管目录的 `@github/copilot-darwin-arm64/package.json` 声明 `name`/`version` 为该平台包/`1.0.89`，`os=darwin`、`cpu=arm64`，`exports["."]="./copilot"`。因此，“同一已注册 Node + 同一 npm-loader + `login`”转发到这份平台程序是可检查的静态调用关系；本次没有执行该命令来验证登录效果。
- [GitHub 官方登录文档](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)明确提供 `copilot login` 和 CLI 内 `/login`。登录可能打开浏览器、等待授权并使用官方凭据存储，不能描述成无副作用的本地检查。[官方 1.0.89 发行页](https://github.com/github/copilot-cli/releases/tag/v1.0.89)对应本次版本；当前通用文档不单独证明该版本的完整声明内容。

上述包文件均位于本批登记记录中的 `managedRoot` 下；只查看公开清单/启动器，没有扫描其他安装或用户配置。官方仓库 [issue #3161](https://github.com/github/copilot-cli/issues/3161)曾记录 **1.0.42** 的同名旧 `terminal-auth` 方法使用绝对 `copilot` 命令及 `["login"]`，只作为历史形状线索，不能替代当前 1.0.89 的运行声明。

## 当前拒绝路径

[auth_route.rs](../../../src-tauri/src/acp_client/auth_route.rs) 第 115–139 行要求解释器启动的旧终端声明指向同一 Node 加同一绝对脚本，或直接指向同一脚本；不会因为另一个程序同名就视为同一目标。如果当前声明指向该 npm 包内部的平台二进制，它既不是选中 Node，也不是 `npm-loader.js`，该分支会返回未知。这是**条件可证的源码路径，尚非本次运行归因**。声明为其他路径、缺失文件或畸形字段也会得到相同固定提示。

同文件第 283–317 行只提供现有 Kilo 补充、Amp 伴随程序和上述同程序校验；[auth_compat.rs](../../../src-tauri/src/acp_client/auth_compat.rs)只补充 Qwen 官方配置入口，[recipes.rs](../../../src-tauri/src/acp_client/recipes.rs)没有 Copilot 登录补充。`protocol_method` 第 38–49 行同时禁止旧终端声明退回普通 `authenticate`，因此不能通过忽略旧元数据解除禁用。

## 最小后续范围与反例

下一步先在被授权的真实连接内仅投影这一个方法的公开类型、命令路径与参数形状，或取得版本固定的官方声明源；不保存整个回复、环境值或秘密。在确认具体形状前不写宽泛例外。

若确认是同包平台二进制 + `["login"]`，可在接入层沿现有配方/身份核验增加窄补充：核对注册目录与当前受管收据、官方包名称和版本关系、`bin`/平台包 `exports`、规范化后仍位于该安装目录的实际入口、原 `[npm-loader.js, --acp]` 与精确方法 ID/旧声明参数。输出冻结的已注册 Node、同一绝对 npm-loader、`login`；不再次按 PATH 解析，不解析 description，也不增加 UI 品牌分支。不能把 `login` 接在 `--acp` 后面，不能改标准 Terminal 的字面追加语义。

最小受控回归应覆盖：同包 launcher→平台入口；另一安装/同名 PATH 程序/目录逃逸拒绝；平台包版本不匹配、清单或入口缺失拒绝；未知参数或方法不补充；标准 Terminal 原样追加；未知旧声明继续在环境/Keychain/启动前拒绝且不发 `authenticate`。实际安装验收另需明确点击后核实精确目标、暂离/取消回收；这些受控与真实验证本次均未执行。
