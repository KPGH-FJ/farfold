# fast-agent 0.10.1 固定错误分类核对

本记录先只读同版本官方缓存、原探针和原收据，再建立受控分类器；真实新诊断另记于文末。没有修改产品源码、外部包、凭据或配置。原 `initialize-probe.py/json` 保留。

## 原 315 字节能与不能说明什么

原收据仅记录退出码 1、stdout 0、stderr 315 bytes、无协议响应。raw stderr 当时未保留，所以本轮不能回溯具体分支。315 bytes、耗时和异常类白名单为空都不能认定缺 Key/模型/配置/MCP；以下是源码存在的格式出口，不是对原失败的归因。

官方 `fast-agent-mcp==0.10.1` 缓存根目录为 `/Users/tw/Library/Application Support/ai.farfold.desktop/uv/cache/archive-v0/OQ2oi8KstG9JTZc2/fast_agent`。源码定位相对此目录：

| 出口                      | 定位                                                                                        | 输出与退出语义                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 启动/初始化中的框架错误   | `core/run_runtime.py:321–333`、`core/fastagent.py:1145–1213`、`core/error_handling.py:9–29` | 捕获 8 类框架错误，打印固定人类标题、动态 message/details、固定建议，再退出 1；不打印异常类或 traceback。因此旧过滤器可以返回两个空数组 |
| YAML 解析错误             | `core/fastagent.py:213–219`                                                                 | 固定 YAML 标题/建议，动态正文，退出 1                                                                                                   |
| CLI Click 错误            | `cli/commands/acp.py:227–249`                                                               | 修改 UsageError 退出码为 1；调用 Typer Rich 格式，失败才退回 Click `show`；错误类名可以完全不出现在输出中                               |
| 已进入 server loop 的错误 | `core/server_runtime.py:118–125`                                                            | 非 quiet 时打印 traceback，然后固定 `Server stopped with error:` 前缀加动态正文，退出 1                                                 |
| runner 自有超时           | `cli/runtime/runner.py:68–81`                                                               | 固定超时语句中含数值，退出 124；不能与退出 1 的原收据混为同一已测分支                                                                   |

Fast-agent 元数据固定要求 `typer==0.25.1`、`rich==15.0.0`。对应缓存 Typer 0.25.1 是 `archive-v0/GghNGF2jC0v3qfxA`，`typer/rich_utils.py:677–707` 将动态 `format_message()` 放入题为 `Error` 的 Rich Panel；使用错误面板标题不保留 Click 类型。缓存 Click 8.5.0 是 `archive-v0/QpzJ7mzAgpu4vXKf`，`click/exceptions.py:69–81`、`:97–123` 使用 `Error: {message}`；BadParameter 的参数/值正文是动态数据。另一个 Typer 0.27.2 缓存不作为本次版本依据。

## 分类器的白名单

[stderr_classifier.py](stderr_classifier.py)只在内存对最多 512 KiB 做 ANSI CSI/OSC 去除和固定匹配，输出固定枚举 ID、公开异常类名、格式标记及长度/截断布尔值。它不导入 FastAgent/Rich/Typer，不返回原行、动态正文、建议全文、路径值、URL 值、Key 或变量内容。

框架标题必须整行精确匹配；固定建议可容忍 Rich 换行，分开记录“标题匹配”与“标题及建议匹配”。固定映射是：

| 固定 ID                  | 标题                                  | 官方处理的类/范围           |
| ------------------------ | ------------------------------------- | --------------------------- |
| `yaml_parsing`           | YAML Parsing Error                    | ParserError                 |
| `server_configuration`   | Server Configuration Error            | ServerConfigError           |
| `provider_configuration` | Provider Configuration Error          | ProviderKeyError            |
| `agent_configuration`    | Workflow or Agent Configuration Error | AgentConfigError            |
| `mcp_server_startup`     | MCP Server Startup Error              | ServerInitializationError   |
| `environment_startup`    | Environment Startup Error             | EnvironmentStartupError     |
| `model_configuration`    | Model Configuration Error             | ModelConfigError            |
| `circular_dependency`    | Circular Dependency Detected          | CircularDependencyError     |
| `environment_selection`  | Environment Selection Error           | UnknownEnvironmentError     |
| `user_requested_exit`    | User requested exit                   | PromptExitError，不等于故障 |
| `cancelled`              | Cancelled                             | CancelledError              |
| `generic_error`          | Error                                 | 兜底；仍不能认定具体异常    |

Rich Error Panel、普通 `Error:`、server-stop 前缀和 Python traceback 标头仅标格式。没有框架标题/公开异常类时，即使识别出面板也维持 `categoryUnclassified=true`。类名只取公开固定集合，行首/面板行首加冒号的独立类名；不输出未知类名或源代码中的名称。

这些结果是“观察到固定模板/公有类”，不能靠模板 ID 自动声称根因、账号类型、具体提供方或修复。两个标题同时出现会如实保留列表，不擅自选择一个；动态正文恰含固定文本仍可能造成标记，不把标记当程序内 exception 对象的直接收据。

## 受控验证与新探针变更

[14 项测试](classifier-tests.json)通过，执行的是自有脚本的合成字节与官方源码 AST 静态读取；未导入或启动 Agent。覆盖全部固定标题/建议存在于当前 0.10.1、ANSI/OSC、Rich 换行、面板只标格式、未知/嵌入标题不捕获、公开类名不输出正文、不同秘密正文不改变枚举结果、无效 UTF-8 与输出边界。

新 [initialize-classified-probe.py](initialize-classified-probe.py)复用原预检、真实 HOME/登录 shell、同版本离线重建、一次 initialize、输出/时间上限及精确回收；只增加固定分类和 Typer/Rich/Click 公有版本收据。新收据是 `initialize-classified-probe.json`，以 exclusive-create 防止覆盖；未增加 auth/session/new/prompt 或 debug/日志选项。配置/环境前检变化则停止，不通过清环境、换 HOME 或 guard 制造启动条件。

## 新诊断结果

在根任务确认该格式定位与受控测试足以支持新诊断后，获授权执行一次新探针。命令使用 `/bin/zsh -lic` 启动自有脚本，保持登录 shell/真实 HOME；原收据未覆盖，也没有失败重试。新原始脱敏收据为 [initialize-classified-probe.json](initialize-classified-probe.json)。

- 2026-09-30 21:30:48.780–21:31:02.565（北京时间），Agent PID 2661，13.785 秒，退出 1；stdout 0、stderr 315 bytes，无协议响应，未触发读取/输出上限。
- 新分类同时取得 `matchedFixedHeadingIds=["model_configuration"]` 与 `matchedFixedHeadingAndSuggestionIds=["model_configuration"]`；格式标记是 `fixed_friendly_heading`。公有类名与公开源码帧仍为空，未输出原始正文；分类输入未截断。
- 这是观察到官方 `Model Configuration Error` 标题与固定建议的证据，源码 `fastagent.py:1183–1188` 对应 ModelConfigError 处理。没有取得 exception 对象、实际模型名或细分错误正文，所以不能写成已定位具体无效模型/提供方/参数，也不能把它自动归为认证或要求登录。
- `fast-agent-acp`、`fast-agent-mcp`、`agent-client-protocol` 均为 0.10.1；格式依赖为 Typer 0.25.1、Rich 15.0.0、Click 8.5.0。两次存在性前检均通过：环境覆盖列表空、已知全局配置/秘密文件不存在、任务 cwd 空；没有读取配置内容。
- 仅发送一次 initialize，没有 auth/session/new/prompt；官方任务 cwd 仅出现 `.fast-agent` 和 `.fast-agent/sessions` 目录，未观察到文件写入。
- venv 工具两个命令退出 0。已观察到的进程为 2647、2653、2655、2661；同身份和进程组无残留。精确任务目录 `/var/folders/zy/7b1d9d0955bdjkj8ql938qcc0000gn/T/farfold-fast-agent-initialize-0cmuaz4f` 已删除，受管工具/共享缓存保留。

新结果为后续只读追踪 ModelConfigError 的构造来源提供范围；不自动覆盖 18:02 安装版失败或 19:14 旧探针的根因。两次独立探针 stderr 同为 315 bytes 也不是“根因相同”的直接证据。没有继续启动/安装或调整模型、凭据、依赖；下一动作由根任务依据该范围决定。

## ModelConfigError 启动分支（只读核对）

下表只描述固定 0.10.1 的可能分支，不从标题推定本次实际进入哪一条。公开源码指纹见 [model-route-source.json](model-route-source.json)；没有保存动态异常正文，也没有再次运行 Agent。

| 可能来源                 | 同版本源码定位                                                                                    | 能说明的边界                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 没有任何有效模型来源     | `config.py:2234–2244`；`core/model_resolution.py:225–278`；`core/direct_factory.py:563–611`       | `Settings.default_model` 默认 `None`，引用默认空。Agent 指定模型、CLI `--model`、配置 `default_model`、`FAST_AGENT_MODEL` 都未提供有效值时，工厂明确抛出 `ModelConfigError("No model configured", ...)`。这是与独立探针空 cwd/覆盖不存在相符的源码条件，仍不是取得了本次具体异常正文 |
| 无法解析模型引用         | `core/model_resolution.py:58–132`、`:250–278`                                                     | 引用格式、namespace/key 缺失、空值或循环可能报相同类别；解析还存在候选回退，不能只凭一个坏引用断言启动必失败                                                                                                                                                                         |
| 模型规格或提供方组合无效 | `llm/model_factory.py:349–575`、`:765–825`、`:1053–1070`；`llm/model_overlays.py:332–351`、`:680` | 查询参数、未知模型/提供方、transport/模式或 overlay 属性等也可以报这个类别；标题不包含实际模型/提供方/参数                                                                                                                                                                           |

`core/direct_factory.py:339–366` 在 Agent 初始化时创建并挂接 LLM；`core/run_runtime.py:301–311` 先初始化 Agent，再进入 server mode。`cli/runtime/model_bootstrap.py:34–43` 仅允许 interactive REPL 且输入输出为 TTY 时打开启动模型选择器，ACP serve 不满足此条件。因而固定版本存在“必须先提供模型、才能开始协议服务”的官方路径，不能把所有无 initialize 响应归为缺账号，也不能等握手后才处理启动模型。

## 官方模型入口与写入范围（只读核对）

1. **直接参数是完整的官方启动入口。** `cli/commands/acp.py:134–140` 使用 `CommonAgentOptions.model()`；`cli/shared_options.py:106–113` 明确支持 `--model`/`--models`。该值进入 `acp.py:78–115` 的请求，模式仍为 serve、transport 仍为 ACP。保留目录原 `-x` 参数，argv 可以是 `["-x", "--model", "<用户明确选定的模型规格>"]`；这里的占位符不是推荐或默认模型，也不是已运行的命令。Farfold 不需要替外部程序写配置文件才能表达这一选择；凭据及真实握手/回复仍须另行验证。[官方 ACP 文档](https://fast-agent.ai/acp/)也展示 `--model`，其中浮动 `@latest` 示例不作为本次安装指令。
2. **`model setup` 是引用配置，不会设置默认模型。** `cli/commands/model.py:1854–1895` 要求交互终端，默认 `--target env`，允许 `project` 和 `--dry-run`；`:245–292` 调用 references handler。`commands/handlers/models_manager.py:1524–1565` 最终调用 `ModelReferenceConfigService.set_reference`；`llm/model_reference_config.py:107–151`、`:326–337` 仅更新 `model_references.<namespace>.<key>`，没有写 `default_model`。因此仅运行 setup，尤其在 `default_model=None` 时，不能声称下一次 ACP 就有模型。
3. **引用路线须同时明确引用入口。** 如果用户在官方 `fast-agent model setup` 中把 `$system.default` 指向其选择，可通过 argv `["-x", "--model", "$system.default"]` 使用该引用。`$system.default` 应作为一个字面参数传入，不经 shell 展开；引用值必须由用户选择，不能由 Farfold 猜测或覆盖。`--target env` 写活动 FastAgent home 的主配置，`project` 写当前配置或 cwd 的 `fast-agent.yaml`（`model_reference_config.py:212–232`），保持既有 YAML 其他字段；这是官方程序的持久化动作，不是只读检查，也不等于全局 HOME。准备与后续启动必须使用同一实际 cwd/home 语义；不新建私有 HOME。
4. **入口不能误挂在 ACP wrapper。** 包元数据 `entry_points.txt` 声明 `fast-agent = fast_agent.cli.__main__:main` 和 `fast-agent-acp = fast_agent.cli.commands.acp:main`；`cli/main.py:24–41` 把 `model` 挂在根 CLI。`acp.py:26–37`、`:227–242` 的转发集合没有 `model` 或 `config`。因此官方准备动作需要核验同安装包的根 `fast-agent` console script，不能把 `model setup` 追加在原 ACP 命令上冒充支持。临时探针 venv 已清理，本记录没有声称生产安装中已核验该 sibling 文件。
5. **`config model` 不存在。** 尽管根帮助中有过笼统模型说明，`cli/commands/config.py:608–634` 及该模块实际命令只有 shell/display/migrate-mcp/show-mcp，不提供设置 `default_model` 的模型子命令。官方 scaffold 的说明也要求自行提供 `default_model` 或 `--model`（`cli/commands/setup.py:158–169`），其模板 `resources/setup/fast-agent.yaml:1–26` 把默认模型和引用示例全部注释；不能用 scaffold 自动造默认值。
6. **交互选择可能包含认证副作用。** `ui/adapters/tui_io.py:337–373` 的模型 picker 在用户选择 activation 时调用 `:276–292` 的官方 OAuth `handler.login()`；配置加载也可读取官方已有配置/秘密及凭据来源。这条准备动作需要说明并取得实际用户选择，不能把它描述为纯模型元数据读取、只写公开引用或由 Farfold 自动授权 Key。此次只读取公开源码，没有调用 picker、login 或 Keychain。

## 最小下一步与产品缺口

**参数路线无需先新增终端动作才能验证。** 最小真实下一步是先取得用户明确的模型规格及已有可用账号条件，再以同版本官方命令保留 `-x`、加上述 `--model` 参数进行单独有界连接验证；本轮没有取得该选择，没有执行第三次 Agent，也没有自动选择模型/交付 Key。这只能验证新条件是否到达 initialize，不能回填 18:02 原失败根因或直接宣称首发成功。

若目标是目录条目从零在 Farfold 中完成，当前还有真实产品缺口：`src-tauri/src/agent_install.rs:245–266` 在握手失败且检查进程已回收时没有持久化安装候选，只在进程归属未确认时保留文件收据；18:02 实测也未创建 Agent 行。因此现有基于已注册 Agent 的服务终端动作不能在这个失败条目上直接运行，也不能在已不存在的失败 candidate 上追加参数。

**最小可实施改动是把参数审阅放在目录“重新准备”的连接检查之前。** 用接入层已核实的官方参数声明暴露通用输入，由用户确认模型规格；保留目录原包/version/`-x`，把 `--model` 及用户值作为两个 argv 项附加到本次新 candidate。该选择不改全局目录、不替用户挑值、不分发 Key；服务依旧使用正常环境，审阅与执行需核对同一声明/值。失败候选已经清理时用现有同版本缓存准备新候选，再带确认参数执行 `probe_launch`，仍只在 initialize 成功后按当前事务提交。该路线不必先放宽提交标准或新增终端动作；模型/认证/消息仍分别验证。具体 IPC/前端实现尚未进行。

若改用官方 `model setup` 交互路线，则还需要**在连接之前保留未选安装程序，并提供同包根 CLI 的准备动作**；仅基于已注册 Agent 的当前动作不够。该扩展可复用既有安装收据/候选、PTY、lease 和取消机制，不把未握手程序写成已兼容 Agent、不伪造 authMethods、不新增执行器或账本。

如果先实施官方 model setup 动作，出口仍应是“官方引用配置结束 + 用户明确的引用启动参数”，再做 initialize；仅“终端退出 0”不证明有默认模型、认证、模型读取或回复。现阶段优先最小参数路线，不为本样本增加默认模型或无依据的 `config model` 动作。后续选择/认证/真实消息属于另行授权和验证的阶段。
