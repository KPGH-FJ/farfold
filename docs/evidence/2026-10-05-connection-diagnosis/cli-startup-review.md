# OpenCode / Cline 官方启动路径只读核查

日期：2026-10-05。范围：只读取已安装公开程序、包元数据和可辨识的内嵌 JavaScript；未运行真实 CLI，未读取用户配置、账号内容、日志、环境值、证书或对话。以下二进制偏移仅供复查已安装产物，不是兼容性版本锁定或散列要求。

## 直接结论

- Cline 官方 ACP 参数为 `--acp`，OpenCode 为 `acp` 子命令。
- 两者都内嵌 Bun，启动成功（`--version`）不等于已进入 ACP 输入循环。
- 两者的 `initialize` 方法自身均直接返回能力和版本；模型目录与会话设置处理位于后续 `session/new`。因此当前“已经发 initialize、零入站”不能归因于刚修的前端模型选择逻辑。
- Cline 在绑定 stdin **之前必定直接写一条 stderr**：`[acp] starting ACP mode over stdio…`。若完整子树的 stderr 字节计数确实为零，等待点通常位于该行之前，应优先区分 wrapper、Bun 初始化、动态模块导入，而非先怀疑 JSON 响应解析。
- OpenCode 绑定 stdin 前会等待全局配置与本地服务器启动。其 initialize 也不会先请求模型提供方。
- 仅源码不足以断言 Bun 非阻塞管道缺陷、网络故障或账号故障。下一项最有区分度的实验是同一官方命令、相同自建 cwd、相同继承环境，比较普通阻塞 pipe 与宿主启动方式，仅发 initialize 并保留标准输入至收到响应/上限。

## Cline 3.0.65

读取入口：`/Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:cline/install-so8oyQ/node_modules/cline/bin/cline`；包元数据声明官方仓库 `cline/cline`，`apps/cli`。

### Node wrapper

1. `fs.realpathSync(__filename)` 解析入口。
2. 构造继承现有环境的 childEnv，补官方 `CLINE_WRAPPER_PATH`。
3. 同步调用公开 `ca-certs.cjs` 的 `configureNodeExtraCaCerts`。
4. 找到 `bin/.cline` 缓存或平台包二进制。
5. `child_process.spawnSync(target, args, {stdio: "inherit", env: childEnv})`，等待子进程结束。

CA 步骤可能在 Bun 子进程出现前执行系统信任库枚举和文件 I/O：`tls.getCACertificates("system")`、证书合并与缓存检查。这里读取的是公开实现，未读取运行时证书或实际环境值。若进程树已经存在 `.cline` 后代，则该次等待不在 wrapper 的 CA 前置步骤；只看 Node wrapper 仍存活不能说它挂住，因为 spawnSync 本来就一直等待 Bun 子进程。

### Bun 主入口到 ACP

内嵌主入口 `async function sr()` 位于约 76,721,3xx：初始化客户端标识、stdout/stderr EPIPE 处理、启动自动更新检查、设置内部目录、初始化 telemetry；注册命令并 `await parseAsync`，随后在 `r.acpMode` 分支动态导入 ACP。

自动更新的公开实现（`chunk-q04xdhdt.js`、约 62,712,207 起）把 registry fetch 放进后台 Promise；主入口调用该函数时没有 await。没有证据表明这一 fetch 是当前同步阻塞点，不建议通过禁用更新或改用户环境绕过问题。

`chunk-4v04v5na.js`（约 76,697,170 起）依次：

- await 动态导入协议 SDK 与 AcpAgent；
- 直接 stderr.write 启动标记；
- `ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))`；
- `new AgentSideConnection(...).closed`。

此处没有“等到 stdin EOF 才开始 ACP”的实现；一般提示词从 pipe 读取至 EOF 的分支在 ACP 分支之后，不适用于正确的 `--acp`。

### initialize 与账号界限

`chunk-cgda93wf.js` 起点 76,829,491，`initialize` 约 +11,761：直接返回 protocolVersion、agentCapabilities、agentInfo、authMethods，无 await 模型请求。

但不能表述为“initialize 之前完全不接触配置”：AcpAgent 字段实例化 `ProviderSettingsManager`，该公开构造器会同步读取自身设置，并包含文件权限/迁移相关逻辑。手动诊断仍须使用官方接口，不以私有 HOME、env_clear、替换账号或重写配置制造假隔离。`session/new` 才进入认证可用性判断、模型目录与选中模型解析。

## OpenCode 1.18.31

读取程序：`/Users/tw/.opencode/bin/opencode`，Mach-O 内嵌公开 JS。

`command:"acp"` 约位于 65,224,171。handler 顺序：

1. await 动态导入 Server 与 ACP；
2. 标记当前 client 为 ACP；
3. `Cli.resolveNetworkOptions`，等待 `Config.Service...getGlobal()`；
4. await `Server.listen(...)`；
5. 建立指向该本地服务的 SDK；
6. 才向 `process.stdin` 添加 data/end/error 监听，创建 ndjson streams 与 ACP connection；
7. 记录 setup connection，`process.stdin.resume()`，等待输入结束。

因此 server/config 前置步骤可导致尚未进入 ACP 读循环；其中配置可能来自 Agent 自有设置，不应读取真实内容来定位。公开 ModelsDev 模块确有 registry/model fetch 与刷新机制，但源码不足以证明它位于这次 initialize 的阻塞链，不能直接判定网络原因。

`chunk-hkyvrb3z.js` 起点 75,606,818，`ACP.initialize` 约 +33,067：直接构造静态能力、登录方式说明和版本后返回；`ACP.newSession` 才解析目录、模型并向本地 SDK 创建会话。

## 最小对照建议

由主代理执行，避免并行操作实际应用：

1. 只在自建工作目录启动准确官方命令，不修改 HOME、原环境、账号、编辑草稿或正式 Agent 配置。
2. 一次普通阻塞 pipe 对照，只发一个换行结尾 initialize JSON-RPC；不发 authenticate、session/new、session/load 或 prompt。
3. 限时、保留 stdin 开启，不把提前 EOF 混入变量；只保存耗时、PID/PPID/进程 basename、stdout/stderr 字节数、JSON 方法/ID和成功/错误分类，丢弃意外正文或秘密。
4. Cline 可额外记“是否已出现 .cline 后代”和固定启动标记命中布尔值。不要把 spawnSync wrapper 的等待当根因。
5. 若普通 pipe 成功而宿主路径失败，用**受控无账号对端**逐项对比 fd 状态、pipe/socket 类型、输入 flush 与换行、进程组/退出清理；不要直接 patch 上游二进制或增加 Agent 特例。
6. 若普通 pipe 也失败，保留真实启动失败分类，继续隔离公开入口/模块阶段；不因此消耗用户模型消息预算或重试整个应用流程。

## 尚未证明

未证明 Bun 非阻塞输入问题、特定网络/账户故障、Cline 修复后实际模型选择成功、任一 Agent 新付费对话成功。父代理提供的 `--version` 耗时与当前零入站统计作为实验背景，不是本只读任务独立重测结果。
