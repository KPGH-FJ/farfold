# Autohand 官方伴随程序：只读准备依据

本次只读核对 batch2 证据、已安装组件的公开包文件、当前通用准备代码及官方资料。没有安装、升级或运行 Agent/CLI，没有执行登录、读取用户配置或凭据，没有修改产品源码。下列 PATH 方案是静态可实施范围，不是实际首发、登录或恢复通过。

## 现场与固定组件

[batch2](../2026-10-01-agent-access-directory-batch2/README.md) 的正式候选为 `38c6ba9`。[公开登记](../2026-10-01-agent-access-directory-batch2/autohand-registration.json)为：

- registry ID：`registry:autohand`。
- 组件包：`@autohandai/autohand-acp@0.2.1`；其 `bin.autohand-acp` 为 `./dist/index.js`。
- 已选启动形状：绝对 Node 程序加一个绝对 `dist/index.js` 参数。已安装组件根为 `/Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:autohand/install-DmctEe/node_modules/@autohandai/autohand-acp`。
- 连接成功，但声明 `autohand-install`，旧终端目标为 `npm install -g autohand-cli`；该自动入口禁用，创建对话失败、模型未读到、首发与恢复未测。

读取了上述组件根的 `package.json`、`README.md`、`dist/acp-agent.js`、`dist/utils.js`，未读取包外用户数据。官方固定 [v0.2.1 README](https://raw.githubusercontent.com/autohandai/autohand-acp/v0.2.1/README.md) 明确要求已配置的 `autohand` CLI，并提供 `AUTOHAND_CMD` 的路径或命令名交付接口；[v0.2.1 acp-agent.ts](https://raw.githubusercontent.com/autohandai/autohand-acp/v0.2.1/src/acp-agent.ts) 与已装组件的下列启动形状一致。

当前禁用符合既有目标验证：全局 npm 安装不是已连接 Node/组件入口，也不是已核实的伴随登录路线。调查时的 [recipes.rs](../../../src-tauri/src/acp_client/recipes.rs) 仅有 Amp/Pi 伴随声明；[auth_route.rs](../../../src-tauri/src/acp_client/auth_route.rs) 的旧声明必须通过目标验证，不把这个全局安装转成普通 `authenticate`。

## 官方程序发行与版本范围

官方程序为 **`autohand-cli`**，命令入口 **`autohand`**，并非错误说明文本里另一个包名。2026-10-01 02:47:19 UTC 对[官方 npm 完整元数据](https://registry.npmjs.org/autohand-cli)进行一次有界 `curl --compressed` 读取：退出 0、277567 字节、完整 JSON 解析成功。此前一次未压缩读取未能确认完整 JSON，不作为发行依据。

| 公开字段          | 本次核对结果                                                               |
| ----------------- | -------------------------------------------------------------------------- |
| npm 稳定发行      | `0.9.8`；发布于 `2026-09-22T01:36:06.793Z`，已满 7 天                      |
| 包身份 / 官方仓库 | `autohand-cli` / `https://github.com/autohandai/code-cli`                  |
| Node engines      | `>=22.0.0`                                                                 |
| `bin.autohand`    | `dist/index.js`                                                            |
| 同发行其他 bin    | `ah`、`agent`、`autohand-code`；准备声明只选 `autohand`                    |
| npm postinstall   | `ensure-node-pty-helper-permissions.mjs` 与 `ensure-ink-cursor-intent.mjs` |

上述 `0.9.8` 是本次公开发行观察，不是写死的兼容版本或安装选择。现 [npm_release.rs](../../../src-tauri/src/npm_release.rs) 可选取满足公开发行日期、命名入口、Node engines 的明确候选，再安装精确包规格。[官方 v0.9.8 package.json](https://raw.githubusercontent.com/autohandai/code-cli/v0.9.8/package.json) 的 version 字段仍为 `0.8.2`，因此 tag 文件不能单独证明 npm 归档的版本或实际 `--version`；后续须沿现有实际 manifest、入口和版本检查，失败保留原选择，不通过静默换版本绕过。

**没有核到覆盖整个 CLI 的最低兼容版本。** 固定 v0.2.1 README 的 External Permission Mode 段明确：外部权限回调需要 CLI `v0.6+`。该要求只适用于此接口，不能泛化成 initialize 或所有使用方式的版本门槛；若准备路线采用这项能力，可以准确记录这一已核要求和来源。实际权限模式保持用户/目录原选择，本轮未读用户环境或替用户改模式。

## AUTOHAND_CMD 的三条启动路径

已装 `dist/acp-agent.js` 与固定源码可定位：

| 路径     | 已装代码                                                    | 官方行为                                                                            |
| -------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 程序检查 | `findAutohandBinary` / `checkCliInstalled`，约 2724–2780 行 | `AUTOHAND_CMD` 原字串作为 command，直接 spawn `--version`，继承当前进程环境         |
| 新消息   | `buildAutohandCommand`，约 2376–2465 行                     | 先 `parseEnvArgs(AUTOHAND_CMD)`，首 token 作 command；生成环境保留 `...process.env` |
| 恢复运行 | `runAutohandResume`，约 1641–1672 行                        | 原字串作为 command，直接 spawn `resume`；生成环境保留 `...process.env`              |

因此，父目录含空格的裸绝对路径可以通过检查，但消息路径会拆开它；为整条路径加引号又会令检查和恢复按含引号字面路径查找。不能直接给受管绝对路径加引号交付。`dist/utils.js` 的 `parseEnvArgs` 识别空白、单双引号与反斜杠，也不应把包含这些字符的 basename 当成一个已证明安全的单 token。

**纯命令名路线静态相容。** 当前受管 Node 包装程序名是 `launch-program`，没有空格。它作为 `AUTOHAND_CMD` 时，新消息得到同一个 token，检查和恢复也使用同一个命令名；三条路径均保留 PATH。前置已选绝对程序所在目录，可让 Node 查找到同一包装程序，包装内部沿已验证的绝对 Node 与包入口执行。这里未实际执行三条路径。

## 最小实现范围与守卫

可复用现 [preparation.rs](../../../src-tauri/src/acp_client/preparation.rs)、[dependency_install.rs](../../../src-tauri/src/dependency_install.rs)、[program_launch.rs](../../../src-tauri/src/program_launch.rs) 与程序库存/候选选择流程：

1. 在接入层增加固定组件范围的伴随声明：官方 registry 来源、组件包名、登记形状、manifest 声明 bin 与 canonical 入口都必须一致。现 `registered_version` 的根识别只适配 unscoped 包；直接填入 `@autohandai/autohand-acp` 会找不到根，须增加有界 scoped 识别，拒绝无关同名包及逃出包根的入口。
2. 从准备页明确安装所需程序，在受管目录准备 `autohand-cli` 的 `autohand` 命名入口，复用 Node engines、包装验证、取消与候选收据。保留原外部程序，不运行全局安装、不改全局 PATH 或 shell 配置，不自动执行账号动作。
3. 持久 AgentRow 与历史继续保存**所选绝对程序路径**，`program_env` 仍是官方 `AUTOHAND_CMD`，不是 PATH。仅在启动环境副本，将该路径派生为安全 basename，并前置其绝对父目录；不新建外部链接或第二套选择库存。
4. 在 [manager.rs](../../../src-tauri/src/acp_client/manager.rs) 的 prepared/凭据/伴随环境全部合并后统一派生。现 `entry.or_insert` 不会改 prepared 环境里已有的绝对 `AUTOHAND_CMD`，也不足以保证派生 PATH 后不会被后续覆盖。PATH 基础须尊重当前有效的显式 PATH，否则保留继承值；不清空用户环境。
5. 拒绝空白、引号、反斜杠、控制字符或不能构成一个明确命令名的 basename；父目录若不能通过标准 PATH 拼接也应拒绝，不能用外部别名绕过。显式坏选择不回退到另一同名程序。先验证目标绝对可执行路径、包装与包入口归属，再派生 PATH；脚本 `.js` 本身不能充当可执行 basename。转换只适用于已核声明，不授予路径新的 ownership。

**认证仍需独立接线。** 固定组件在 CLI 存在但账号检查未通过时声明 `autohand-login` → `autohand login`。当前伴随认证例外仅覆盖已验证的 Amp 等路线，不能自动获得 Autohand 权限；若该片同时开放登录，须精确核对当前方法、官方 CLI 所支持的 argv，以及当前所选伴随绝对目标，查询与执行都重新验证，拒绝先于环境/凭据/PTY。准备动作可以先实现，账号按钮保持原守卫；不能把安装说明作为登录成功。

该组件还把 `AUTOHAND_CMD` 指向存在文件当成测试 stub，并在部分认证/创建路径跳过账号检查。命令名方式通常不会触发绝对路径的这个分支，但工作目录恰有同名文件时仍可能命中；不能以创建对话或空 authenticate 成功收据证明账号已登录，首发须单独实测。

## 副作用与验证边界

- npm 安装会执行所选包及其依赖的安装脚本、写本次候选与 npm 自有缓存；官方 0.9.8 的两项直接脚本修包内 helper 权限和 Ink 文件。全部依赖脚本与归档实际内容尚未运行核实，不能承诺外部零写入，也不把 main 分支新增的安装动作当此固定发行已发生的事实。
- Agent/官方 CLI 自己读取账号配置与管理历史；Farfold 不读取或写这些文件，不造私有 HOME，不填默认 Key、模型或权限值。
- 必要受控反例：含空格父目录的包装三路径、basename 不安全、显式坏路径且另一个同名程序可见、显式 PATH 合并、scoped 包/入口归属、候选取消与旧目标保护、同名 cwd 文件不能冒充账号成功。此处均是下一片测试要求，没有执行。
- 实际安装后仍须分开验证：伴随准备、重新连接、账号声明/可用出口、用户明确模型选择、首次请求及冷恢复；本轮没有新增任何通过项。

## 追加：冒号目录与待执行受控探针

原静态结论还有一个具体路径限制：实际旧父目录含 `registry:autohand`，冒号在 macOS PATH 中是分隔符，不能作为一个目录段直接前置。根任务的新设计把新伴随候选放到 `data/companion-programs/agent-registry%3Aautohand/...`，旧安装不迁移；所选绝对路径与 `program_only` 收据仍须按新真实根精确验证。这里记录的是拟实施布局，尚不是安装事实，不改变上文的三路径静态结论。

[official-command-path-probe.mjs](official-command-path-probe.mjs) 已编写，**尚未执行**。已装 `dist/utils.js` 静态检查只有导出函数定义，没有 import 或顶层配置读取/进程动作；探针先核该公开文件的精确 2561 字节与 SHA256 `8496c0d013fd21e479b89453886830ca78f9b5d9b0075779d2c73eed4906b3c9`，再从同一已核字节载入并只调用 `parseEnvArgs`，不载入 Agent 主模块。

探针在唯一任务临时根里创建假的 `launch-program` 包装与纯 Node 入口，正例父目录含空格但用 `%3A` 避免冒号。直接 spawn 命令名模拟检查/恢复，使用官方解析器模拟消息参数；另含裸空格路径、引号路径、冒号 PATH 的反例，以及一个受控超时回收例，共 13 项。正例临时 PATH 前置后保留继承 PATH；冒号反例仅使用任务自有 PATH 段，禁止失败时执行用户同名程序。其余环境继承，假子进程只移除 `NODE_OPTIONS`，避免 preload 读取外部内容；不读其值、不改持久环境或 HOME。

所有子进程仅执行 `/bin/sh`、当前绝对 Node 与自建入口；先校验可派发目标在本次根内，使用进程组、逐例与全程期限、TERM/KILL 收尾，确认退出和组不存在后才精确删除本次临时根。输出仅固定枚举、布尔、计数、受控 PID，不保存正文/环境/错误文本；若清理未知则保留根并只报告本次残留路径。此证据范围是**官方解析器加 Node 受控进程**，不能替代 Autohand 安装、初始化、登录、首发或冷恢复旅程。

根任务审阅后可执行：`node docs/evidence/2026-10-01-agent-access-companion-program/official-command-path-probe.mjs > docs/evidence/2026-10-01-agent-access-companion-program/official-command-path-result.json`。当前仅进行语法/格式静态检查，不把待执行项计为通过。

### isStub 的精确静态范围

固定已装 `dist/acp-agent.js` 只有三处 `isStub`：`authenticate` 292–294 行直接成功返回；`newSession` 323–332 行跳过账号检查后继续正常创建；`executePrompt` 736–743 行跳过账号检查后继续正常处理用户请求。判断都是 `existsSync(process.env.AUTOHAND_CMD)`，相对命令名按 **Agent 进程 cwd** 解析，存在目录也会为真，不是核实所选程序或实际账号。

该分支不会把实际请求变成模拟响应：后续仍按所选模型、模式与用户内容处理，782–795 行按原 `AUTOHAND_PERMISSION_MODE` 建权限回调，797 行起调用正常命令编译，826/877 行使用客户端终端或直接 spawn CLI。`loadSession` 1135–1245 行没有 `isStub` 或该账号检查；`runAutohandResume` 1641 行起仍直接 spawn 命令名，没有 stub 专属替代执行。此处只核官方源码，没有读取任何工作项目路径或启动程序。

所以，同名 cwd 项主要改变**账号准入**，不改变 CLI 目标、权限选择或恢复执行路径，却可能让未确认账号的创建/发送被放行。若要避免纯命令名交付意外进入这个测试分支，可在声明驱动的 SearchPath 交付中，针对实际 canonical 连接 cwd 的一个 `cwd/basename` 做存在性冲突拒绝；不读取内容、不删除或改名，不把冲突项当所选可执行程序。该建议尚未实施，也不能代替 CLI 首发与账号验证。
