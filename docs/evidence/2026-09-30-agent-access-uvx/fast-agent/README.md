# fast-agent 0.10.1 连接失败调查

本目录记录安装候选 `85235cd` 的一次真实失败、独立包调查，以及先后单独获授权的两次有界 `initialize` 探针。正式安装应用 SHA-256 为 `fbf8723a7b06ba6004d82d6cf8292d9c3bb3ed488fa29ab6b4273b0553551fb1`。未修改产品源码、外部 Agent、账号或配置；早先包调查没有执行 Agent 主函数，两次探针均未发送认证、会话创建或消息请求，原收据保留。

## 已知事实

- 正式应用中显式准备 uv/Python 成功。fast-agent 安装准备随后进入连接检查；检查失败，没有选用候选或创建 Agent 行。正式结果见 [失败截图](../04-fast-agent-connection-failed.png) 和 [数据复核](../after-fast-failure.json)：原 22 个会话、7 个 Agent 保留。
- [安全诊断](safe-diagnostics.json)：北京时间 18:02:32.943 发出 `initialize`，18:02:46.733 仅收到两块错误输出，共 14,549 字节；未观察到任何协议响应。18:02:47.285 连接层记录错误并关闭。它没有等待到 60 秒握手超时。原错误文本和异常类未保存，不能由字节数判定原因。
- [离线包复核](offline-package.json) 使用同一受管 uv 0.12.18、Python 3.12.13 和本次缓存，仅增加 `--offline`，安装到明确命名的系统临时目录。安装进程仅移除 `UV_CONFIG_FILE`，保留 HOME；两个命令退出均为 0，没有启动 Agent。
- uv 实际生成的 [启动脚本](generated-console-script.txt) 导入 `fast_agent.cli.commands.acp:main`，对应模块存在。依赖为 `fast-agent-mcp==0.10.1`、`agent-client-protocol==0.10.1`。
- [入口导入检查](entrypoint-import.json) 成功，`main` 可调用；[Typer 参数装配](command-assembly.json) 成功，得到 31 个参数。均没有调用 `main`、命令回调、Agent 对象或配置加载，错误输出为 0，进程组已回收。
- [进一步模块导入](startup-module-imports.json) 成功导入 FastAgent 和 ACPServer 类模块，没有构造对象。该进程使用写入、网络与子进程审计护栏，一次 `socket.bind` 尝试被拦截后由库吞掉。该结果仅证明此受限独立检查成功，不能等同未经护栏的正式启动。

## 官方发布包的独立问题

[PyPI 0.10.1 元数据](https://pypi.org/pypi/fast-agent-acp/0.10.1/json) 指向的 [官方 wheel](https://files.pythonhosted.org/packages/c8/5d/d23a2a602c49ba0fbce30a9beeeb884f80638b035a200bfc5b02ec1b4b92/fast_agent_acp-0.10.1-py3-none-any.whl) 于 2026-08-04 发布，大小 5,874 字节，SHA-256 为 `61f970f52a01e38c1c151a65c9c8a08ca2357fe0f4bcb9073897170f6898837b`。本次只在内存读取官方 wheel 文件清单，没有安装或执行它。

这个 wheel 只有 5 个 `dist-info` 文件，没有 `fast_agent_acp` 模块，却声明 `fast-agent-acp = fast_agent_acp.cli:main`。依赖包又声明同名脚本指向存在的 `fast_agent.cli.commands.acp:main`。离线重建实际得到后一入口，因此不能把 wrapper 缺模块写成本次正式失败的根因；原失败候选已回收，原脚本内容不再可核对。

## 仍未知

正式那次启动的具体异常，以及命令回调之后在哪一步退出，仍未定位。缺账号、模型配置、CLI 装配、依赖接口或网络问题都没有被证据认定为根因。独立导入与参数装配也不能替代正式安装版连接成功。

上述包调查没有扩大为 Agent 主函数或独立握手。后续真实探针须先确认实际配置查找路径、继承的 `FAST_AGENT_HOME` 是否存在及是否启用既有 MCP；保持真实 HOME，并明确任务自有工作目录中的官方日志/会话目录可能写入范围。不得修改外部 Agent、自动改变依赖版本或以写入/网络护栏产生的错误替代原错误。

临时目录的精确清理见 [cleanup.json](cleanup.json)；受管 uv、Python 与共享下载缓存保留。

## 0.10.1 启动链只读核对

本节只读了本次缓存中的官方 `fast-agent-mcp==0.10.1` 源码，没有导入模块、执行命令回调或运行 Agent。源码目录为 `/Users/tw/Library/Application Support/ai.farfold.desktop/uv/cache/archive-v0/OQ2oi8KstG9JTZc2/fast_agent`；以下定位均相对于该目录，行号对应本次缓存版本。缓存不是另一份活动计划，也不能替代原失败进程的异常证据。

| 核对项                    | 源码定位                                                                                                                                                                                   | 结论与副作用边界                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 回调到消息循环            | `cli/commands/acp.py:190–224`、`cli/runtime/runner.py:48–66`、`cli/runtime/agent_setup.py:1526–1549`、`core/run_runtime.py:289–311`、`core/server_runtime.py:129–152`                      | 回调先构造请求，加载设置并初始化 context，打开执行环境、创建 bootstrap Agent，然后才运行 ACP 消息循环。`core/direct_factory.py:339–366` 在启动循环前调用 `agent.initialize()` 和 `attach_llm()`；配置、模型或依赖错误可以发生在收到协议请求前。本次没有认定其中哪一步造成原失败。                                                                                                                 |
| `initialize` 的范围       | `acp/server/agent_acp_server.py:250–376`、`:854–869`                                                                                                                                       | 官方 `run_agent` 负责 stdio 路由；`initialize` 记录客户端信息和能力并返回协议、Agent、能力和认证声明，本身不执行 `session/new` 或 `prompt`。启动前的动作不受这个较小的请求范围限制。                                                                                                                                                                                                              |
| 主配置与秘密发现          | `home.py:67–155`、`:159–172`、`config.py:2660–2703`                                                                                                                                        | home 选择为 `--home` 优先，其次继承的 `FAST_AGENT_HOME`，再其次 `cwd/.fast-agent`；相对环境路径按 cwd 解析。不向父目录递归。先找活动 home 主配置，再找 cwd；秘密随选中的主配置同目录加载。没有主配置时也会找 home/cwd 的秘密文件。同一目录多个受支持别名会报歧义。                                                                                                                                |
| 真实 HOME、全局插件与环境 | `config.py:1948–2023`、`:2094–2112`、`:2179–2206`                                                                                                                                          | 除主配置外，还会读取 `FAST_AGENT_HOME` 或真实 `~/.fast-agent` 中主配置的全局插件选择；空 cwd 不能排除这项读取。设置还读取 cwd 的 `.env` 和继承的环境，嵌套字段用 `__`。普通 `HOME` 会从 settings.home 来源中过滤，不能把保留真实 HOME 等同于禁用全局插件读取。                                                                                                                                    |
| 默认会话目录              | `config.py:2258`、`context.py:226–230`、`session/session_manager.py:682–701`、`paths.py:97–112`                                                                                            | 默认启用会话历史；context 初始化就创建活动 home 下的 `sessions/`，所以仅握手也可能建空目录。实际新会话子目录和 metadata 在 `session/new` 路径创建（`acp/server/agent_acp_server.py:635–676`、`session/session_manager.py:709–740`）。                                                                                                                                                             |
| 默认日志与可覆盖出口      | `config.py:1743–1752`、`paths.py:116–121`、`context.py:161–201`、`core/logging/transport.py:130–152`、`:176–180`                                                                           | 默认是 warning 级文件日志，写到活动 home 下的 `fast-agent-log.jsonl`，会建父目录并追加事件；显式 `logger.path` 不再自动放在活动 home。现有配置或环境还可启用 HTTP 日志或遥测，遥测默认禁用（`config.py:1563`）。`FAST_AGENT_INTERACTIVE_DEBUG_TRACE` 也能指定额外追加文件（`ui/interactive_diagnostics.py:13–46`），runner 启动时已有调用。                                                       |
| `-x` 与 MCP 启动          | `cli/shared_options.py:194–199`、`cli/runtime/request_builders.py:530`、`cli/runtime/agent_setup.py:1404–1408`、`agents/mcp_agent.py:196–203`、`:443–460`、`mcp/mcp_aggregator.py:745–763` | 目录原参数 `-x` 是开启本地 shell 工具。没有额外服务器或卡片参数时，生成 Agent 的 `servers=[]`，不会仅因配置中列出了服务器就启动全部 MCP。被明确选中的 client-managed MCP 会在 bootstrap 初始化时连接，`load_on_start=false` 才跳过；这可能发生在 `initialize` 响应之前。默认本地 shell 环境的 `open()` 为空实现（`tools/local_shell_executor.py:122–123`），启用工具不代表启动即执行 shell 命令。 |

主配置别名是 `fast-agent.yaml`、`fast-agent.config.yaml`、`fastagent.config.yaml`；秘密别名是 `fast-agent.secrets.yaml`、`fastagent.secrets.yaml`（`home.py:18–29`）。上述内容说明应检查的路径与阶段，没有读取这些用户文件的内容，也没有读取或展示凭据。

源码还有两个需要保留的区别：ACP serve 模式不会弹出交互式模型选择器（`cli/runtime/model_bootstrap.py:34–43`），但启动仍会解析配置或 `FAST_AGENT_MODEL`（`cli/runtime/agent_setup.py:876–914`、`core/model_resolution.py:225–260`）。因此不能把缺少响应直接归因于缺账号，也不能声称 `initialize` 不受模型设置影响。

## 后续最小真实探针的前置条件（未执行）

1. 仅检查路径存在性和相关环境字段是否存在，不读取配置内容或秘密：确认任务自有 cwd 为空，默认 `cwd/.fast-agent`、继承的 `FAST_AGENT_HOME` 实际目标以及真实 `~/.fast-agent` 的上述配置路径是否存在，检查 cwd 的 `.env`。环境检查包括 `FAST_AGENT_HOME`、`FAST_AGENT_RUNTIME_HOME`、`FAST_AGENT_MODEL`、`FAST_AGENT_INTERACTIVE_DEBUG_TRACE`，以及日志、遥测、MCP、模型、执行环境、skills、会话历史对应的单字段或 `__` 嵌套覆盖。保留真实 HOME；不得输出环境值。父 shell 与正式应用的环境若未核对，只能标为另一启动条件。
2. 若发现既有配置、全局插件配置或相关环境覆盖，先停止，查明有效设置、MCP 选择和可能的外部写入/网络出口；不能靠清除环境、换 HOME 或审计拦截伪造原始条件。存在性检查无法证明文件内未启用某项能力。本次没有执行这个预检，不能声称当前机器已满足条件。
3. 若上述配置与覆盖均不存在，可用前次已核实的受管工具和离线缓存，在任务自有位置重建同版本 venv，沿实际 console script 用原 `-x` 参数运行，Popen 只设置任务 cwd。不要添加 `--workspace`：`cli/home_helpers.py:83–87` 会由它自动生成 home 并改写 `FAST_AGENT_HOME`；也不加 `--home`、`--no-home`，不修改外部配置、不调用浮动版本。允许官方默认日志与空 `sessions/` 目录写入任务 cwd 下的 `.fast-agent`，这仍是真实启动副作用。
4. 只发送一条协议版本 1 的 `initialize`，客户端能力为空；不发送 `authenticate`、`session/new` 或 `prompt`，不响应执行/文件/权限请求。保持 stdin 打开，并行排空 stdout/stderr，最长等待 60 秒。收到结果后关闭 stdin 并有界等待正常退出，必要时只终止该探针进程组，检查子孙进程全部结束。不要用提前关闭 stdin 的管道误判启动失败。
5. 记录启动与退出时间、退出码/信号、是否收到匹配请求 ID 的协议响应和必要能力字段。错误证据只提取白名单异常类型、已知源码模块相对路径和行号；不保存 raw stderr、异常消息、代码行或变量值，不自动把官方日志复制进仓库。信息不足仍保留未知。审计 guard 产生的失败不能替代真实启动结果。

这个探针即使成功，也只证明指定版本、cwd 和继承环境到达了 `initialize`；不证明登录、模型读取或实际回复成功，也不会覆盖候选 `85235cd` 的原始失败。本节未执行探针、未启动 Agent、未修改源码、账号或配置。

## 一次真实 initialize 探针（2026-09-30 19:14，北京时间）

在完成上述只读调查后，获授权执行了唯一一次真实探针，没有失败重试。执行脚本为 [initialize-probe.py](initialize-probe.py)，原始脱敏收据为 [initialize-probe.json](initialize-probe.json)；前置存在性检查另见 [probe-preflight.json](probe-preflight.json)。

- 实际通过 `/bin/zsh -lic` 继承登录 shell 环境，保留真实 HOME，没有清空或覆写环境，没有 `--home`、`--workspace`、`--no-home` 或审计 guard。脚本启动前、离线重建后各查一次：相关环境覆盖均不存在，真实 `~/.fast-agent` 的五个已核实配置/秘密路径均不存在，任务 cwd 为空。没有读取配置内容或秘密。
- 使用同一受管 uv 0.12.18、Python 3.12.13 和共享缓存离线重建，两个安装工具命令退出码均为 0。确认 `fast-agent-acp`、`fast-agent-mcp`、`agent-client-protocol` 都是 `0.10.1`，生成入口仍为 `fast_agent.cli.commands.acp:main`。
- 19:14:13.076 启动任务 venv 内的 `fast-agent-acp -x`，仅发送一次 `initialize`。19:14:25.657 检查结束，共 12.581 秒，Agent 退出码为 1。stdout 为 0 字节，没有协议响应；stderr 共 315 字节，没有达到输出上限。60 秒总预算中预留 6 秒用于回收，未触发主动读取时限。
- 错误输出中没有提取到白名单异常类或公开依赖源码行号。没有保存 raw stderr、异常消息、代码行、局部变量或完整环境；因此本次仍不能指出具体异常。不能从 315 字节、耗时或退出码猜测为缺密钥/模型/MCP/依赖问题。
- 任务 cwd 内只观察到 `.fast-agent/` 和 `.fast-agent/sessions/` 两个目录，没有文件写入。未发送 `authenticate`、`session/new` 或 `prompt`；没有创建 Farfold Agent 行或操作正式应用。
- Agent PID 为 77528，本次轮询未观察到其后代。安装工具阶段另跟踪到 PID 77514、77521、77523。按进程组和递归 PPID 收集 PID/启动时间身份，结束后同身份均不存活，组内也无残留；这证明已观察到的进程完成回收，不把有限采样写成对未观察后代的绝对证明。
- 精确任务目录 `/var/folders/zy/7b1d9d0955bdjkj8ql938qcc0000gn/T/farfold-fast-agent-initialize-y8o1s9h5` 已按本次归属标记清理，复核路径不存在。受管 uv、Python 和共享缓存保留；没有需要保留或复制的官方日志文件。

本次是独立登录 shell、任务自有 cwd、离线重建 venv 下的启动失败。18:02 安装候选的原进程、cwd 和应用继承环境没有由本探针还原，两个失败的 stderr 字节数也不同。因此只增加“一次同版本独立启动未到 initialize”的证据，不替代安装版失败，也不认定两者根因相同。若后续需要更细的错误分类，须先确定公开固定错误文案的脱敏规则，再决定是否授权新的诊断；本次没有继续执行。

## 固定分类后的独立诊断（2026-09-30 21:30，北京时间）

后续按上述边界核对同版本固定错误格式，14 项受控分类测试通过后，另获授权执行一次新探针。新 [收据](initialize-classified-probe.json)只记录公开枚举：模型配置标题及固定建议同时匹配，退出 1、stdout 0、stderr 315 bytes、无 initialize 响应；动态正文丢弃，自有进程/目录完成回收。详细范围、固定 ModelConfigError 可能分支、官方入口及来源指纹见 [classifier-notes.md](classifier-notes.md)。没有执行第三次探针。

该结果仅说明新独立条件观察到 `Model Configuration Error` 模板，实际子原因和 18:02 安装版原根因仍未知。官方 0.10.1 明确支持 `fast-agent-acp -x --model <用户选定模型>`，不必手改配置；`fast-agent model setup` 仅写模型引用、不设置默认模型，且需使用根 CLI 而非 ACP wrapper。下一次真实连接前必须先取得用户的模型/账号选择，不能猜默认模型、自动交付凭据或把终端完成当连接成功。当前产品握手失败后尚无可操作的未连接程序；最小产品改动是在“重新准备”创建的新候选上先审阅用户启动参数，再做原连接检查/成功提交。若采用官方终端路线，才还需保留未连接程序及其官方根 CLI 动作；本轮没有实现这些改动。
