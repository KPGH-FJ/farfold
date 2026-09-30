# Agent 能力盘点与 P1 实验入口

核对日期：2026-09-27。只读生产源码、正式应用元数据中的 Agent 定义/缓存握手/安装收据键、已安装程序版本与包清单；未读取 Keychain 或外部账号配置，未安装/升级/改程序。以下第一版不包含新模型请求或安装版验收。已按 AGENTS、PRODUCT、architecture/status、计划 00.14 及当前原型读取；父任务另行统筹原型和安装版。

## 结论与边界

- 当前产品源数据为 **41 个官方目录条目 + 3 个既有自定义验收条目**，不是原型十品牌或旧六样例。核心三条目录身份继续为 `codex/opencode/pi`，其余 `registry:<id>`。原型另使用 `claude-agent/gemini-cli/kimi-cli` 显示身份，生产对应 `claude-acp/gemini/kimi`，不可直接搬原型 ID。
- 正式库现场有 **10 条登记**：Codex/OpenCode/Pi、Gemini/Qwen/Amp/Cline，以及 `custom-`、`custom-mcp`、`custom-opencode`。自定义条目是历史验收入口，不等于品牌重复安装，保护其历史，不自动清理。
- 目录缓存抓取时间为 **2026-09-26 10:17:43.369 +08:00**。按当前 `registry_launch` 规则重算：**20 npx、18 二进制、3 无当前安装路线**。这是可选择安装路线，不能称 38 条已能成功安装/使用。
- 本机自动发现只扫描三核心定义；已在本机安装的任意其他品牌不会因此自动发现。目录刷新只负责发布清单，不能代替依赖与可用性检查。
- Farfold 共享服务交付仅声明 Codex Responses、OpenCode Chat Completions/Responses；其余条目与自定义接入沿用已有设置。`validated_api_types` 是代码静态声明，不是当前版本/账号/服务自动实测结果。
- **明确可补代码**：认证暂离生命周期、操作返回归属、版本来源一致性、Node 要求、目录分发保真与安装格式。**不能凭原型补成功**：权限“重新读取”、新服务交付、账号权益、列表/正文/续发。需要实际官方返回。

四类结论逐能力使用：A=已实测可复用（仅已链接旧实测组合，须最终候选复验）；B=可实现但需补代码；C=官方能力不支持或有冲突（也包括当前声明确实不提供）；D=条件不足待验证。一个 Agent 可同时有 A/B/C/D，不设泛化“全面可用”。

## 当前源码链与通用约束

| 用户动作              | 现有生产链                                                                                                       | 当前依据与必要修改/实验                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 探索/本机发现/自定义  | `AgentHub` → `agents.cards` → `agent_catalog.rs`、`agent_discovery.rs`；自定义随机 ID                            | 保留完整目录来源，实际枚举见下；自动发现只有三定义，未知依赖不推测。目录条目不是发布方背书或完整支持证明。                                                                          |
| 安装/选程序/取消/回退 | `ProgramManager` → `agent_install/install_job/installations/node_runtime` → 候选 initialize、回收确认 → 原子选择 | 支持 npx 和 darwin-aarch64 tar.gz/tgz/zip。uvx 丢弃；goose tar.bz2被拒。Node最小18与部分包>=20/22不符。新路线应复用收据/取消/原子选用，禁止外部安装覆盖。                           |
| 程序依赖/官方入口     | `acp_client/preparation.rs` → `AgentPrerequisites/AgentAccountLinks`                                             | 明确声明仅 Amp CLI 与 Amp/Qwen官方链接。其他品牌不能直接复制原型注册按钮，须核实链接、程序与认证声明。                                                                              |
| 登录/服务配置/返回    | `AgentAuthSection`、`InlineTerminal`、`LoginTerminal` → `auth.rs`、`manual_auth.rs`、`auth_compat.rs`            | 标准 agent/terminal、旧 terminal-auth、已核实Qwen扩展；不解析说明猜命令。终端在视图 dispose 时 close；需改为目标归属的可暂离生命周期。agent认证60秒预算；未知与迟到完成需真实校验。 |
| 新服务选用            | `CredentialSettings/ServicePicker` → `credentials` Keychain → `service_config/service_connection`                | 显式选用才交付；源码只支持两Agent三格式路线。账户登录不等于权益或回复。不可因API诊断通过给其他Agent宣布支持。                                                                       |
| 权限/模型/思考        | `ConfigOptions` → `session/set_config_option` / `session/set_mode` → `pump`回执/更新                             | 普通mode不等于全局权限。没有现成通用读取配置按钮链；需看new/load/set返回和通知的实际语义。模型/思考固定继续检查model_guard，不为探针改变用户值。                                    |
| 旧对话查找/正文/继续  | `ImportConversations/history_import` → `session_discovery` → `session/list/load` → 原有投影                      | list、load、可续发三独立能力；当前缓存Amp不load，Gemini/Cline不list。load成功未必正文完整/原配置保持，仍需真实结束边界。                                                            |

关键源码：`src-tauri/src/agent_catalog.rs:177`（支持路线）、`:235`（缓存）、`:446`（目录合并）；`agent_discovery.rs:220`（只遍历定义）；`node_runtime.rs:20`（最小18）；`agent_install.rs:65`（归档）；`acp_client/service_config.rs:31`（服务矩阵）；`acp_client/preparation.rs:25`（依赖）；`acp_client/operations.rs:153`（认证预算）；`auth.rs:444`（认证）；`src/runtime/login_terminal.ts:1`（终端所有权）。

## 十个原型品牌及 Amp 的逐项判定

下列“声明”均来自当前正式库保存的最近握手，不是本次新握手。包版本/程序版本本轮只读复核；不代表账号与模型可用。

| 条目 / 当前本机                                              | 安装与依赖                                                          | 认证、API                                                                                                  | 权限与历史                                                                                                      | 判定、下一实验                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Codex：组件1.12.0；CLI0.155.1；目录1.13.1                    | registry npx；`CODEX_PATH`指向已有CLI；组件另带@openai/codex依赖    | 声明api-key、chat-gpt；中央Responses已实现。旧候选3已有账号6 Astra/Ultra短回复通过                         | 声明load/list、logout；权限须新会话真实configOptions。旧high→ultra与部分服务续发失败继承                        | A：旧短回复/特定工具与历史样本；B：统一权限/认证生命周期；D：本轮同参数新建、冷load、续发及新登录；不能以Ultra成功关闭High漂移。 |
| OpenCode：实际程序1.18.31；登记version仍1.15.13；目录1.18.32 | 直接`opencode acp`或二进制；版本字段旧值必须分清                    | 声明opencode-login旧terminal-auth；Chat/Responses中央交付已实现                                            | 声明load/list/resume/close；过去审批记住、拒绝、停止、部分冷续答通过；不能把mode当权限                          | A：已链接旧工具/停止/冷恢复；B：版本呈现与统一认证；D：本轮短回复/当前默认来源/模型、权限作用与冷续发。                          |
| Pi：组件0.0.33；CLI0.80.5；目录0.0.34                        | npx组件+已有Pi CLI；包要求Node>=20                                  | 实际声明terminal `--terminal-login`；中央新服务为空，官方已有设置继续                                      | load/list/delete；MCP http/sse均false；旧续发失败字段丢失，不能把end_turn算成功                                 | A：旧部分正常请求；B：终端暂离/失败呈现；C：本组合不声明MCP；D：当前短回复、coldload、错误原字段；新服务缺官方可靠交付路线。     |
| Cline：组件/程序3.0.65；已登记                               | npx `cline --acp`；本机已装（status旧主记录未单列）                 | 声明cline、cline-pass、openai-codex；无中央服务交付；不能套用六样例的“方法未读取”                          | load=true但无list；image=true，embeddedContext=false；权限未知                                                  | D：账号/请求/审批/停止/恢复均未取得本轮证据；C：当前声明无全局查找；B：消费真实方法及官方注册返回；先新握手核实来源。            |
| Qwen：manifest0.24.5；保存握手0.24.6；目录0.24.6             | npx `--acp --experimental-skills`；包Node>=22                       | 声明openai `_meta.type=terminal,args=[--auth-type=openai]`，已核验交互设置兼容；中央服务未开放             | load/list/resume声明；权限未知。旧安装终端打开/返回/重连成功，仍AuthRequired                                    | A：旧终端打开/返回路径；B：版本来源与登录生命周期；D：可用账号、真实请求/工具/冷恢复；不得把终端退出算认证完成。                 |
| Claude Agent：未登记；目录0.81.2                             | npx @agentclientprotocol/claude-agent-acp；未现场安装，依赖尚未核实 | 当前上游仓库可读；线上功能不代替本机声明，无共享API实现                                                    | 本机权限/list/load未知                                                                                          | D：安装/依赖/完整声明及账号条件；B：统一能力容器可复用。不得从品牌推出订阅必需或固定三档权限。                                   |
| Gemini CLI：本机0.61.0                                       | npx `--acp`；包Node>=20；旧安装取消/重试有证据                      | 声明oauth-personal、gemini-api-key、vertex-ai、gateway；只有明确api-key扩展可识别，gateway不是自动中央交付 | load=true但无list；image/audio/embeddedContext均声明true；效果未测                                              | A：旧定向安装/取消样本；B：Node门槛；C：当前无list；D：账号/模型/权限/冷恢复/音频真实结果。                                      |
| goose：未登记；目录1.52.0                                    | 官方darwin归档tar.bz2，当前catalog不接受，安装器亦不解该格式        | 本机方法未知，无中央服务交付                                                                               | 本机权限/history未知                                                                                            | B：通用bz2支持与安全解包/回退可补；D：安装后initialize/认证/所有工作旅程。不是Agent官方不支持macOS。                             |
| Kimi CLI：未登记；目录1.52.0                                 | 官方darwin-aarch64二进制tar.gz，源码可进入候选流程；未安装          | 本机方法未知；无中央服务交付                                                                               | 本机权限/history未知                                                                                            | D：候选安装、认证、实际请求与恢复；B：统一容器可复用。不能把原型login样例当声明。                                                |
| fast-agent：未登记；目录0.10.1                               | 官方uvx `fast-agent-acp==0.10.1 -x`，当前schema丢弃uvx              | 本机方法未知；中央新服务没有实现                                                                           | 官方文档说明ACP工具权限与会话列表；`-x`优先使用客户端终端，而Farfold不声明该能力；真实本地fallback/文件能力未知 | B：通用uvx分发/依赖/收据；D：无客户端文件/终端前提下的真实工具路线；不为它恢复Farfold代跑或私有HOME。                            |
| Amp：组件0.9.0；CLI0.0.1790380893-geeadb1                    | 二进制组件+单独Amp CLI；现有依赖准备已补，实际--version通过         | terminal-auth `--setup`；官方settings链接曾到auth.ampcode.com；旧真实请求要求认证                          | load=false，无list，当前官方组合不提供历史恢复                                                                  | A：旧依赖/终端打开取消/官方网页跳转；C：当前load/list缺失；D：账号与首发/工具/停止；不创建空白成功历史。                         |

旧实测的直接依据：`docs/evidence/2026-09-26-agent-onboarding/README.md`、`2026-09-26-agent-market-validation/README.md`、`2026-09-25-product-experience/README.md`、`2026-09-23-service-validation/README.md`、`2026-09-23-reliability/README.md`及status对应记录。这里没有重新执行它们，因此所有 A 只表示旧证据可定位，不关闭本轮验收。

## 完整生产目录快照

下表来自现场缓存，不冒充线上最新版本。未在上表单列的条目全部为 D（账号/请求/权限/历史未验证）；“npx/binary”只表示本源码可构造候选安装。安装依赖、Node要求和官方认证仍需逐类别验证，不从简介推断。

| Registry ID        | 显示名称           | 缓存版本   | 当前源码安装路线      |
| ------------------ | ------------------ | ---------- | --------------------- |
| agoragentic-acp    | Agoragentic        | 1.3.0      | npx                   |
| amp-acp            | Amp                | 0.9.0      | binary                |
| antigravity-acp    | Google Antigravity | 1.2.1      | binary                |
| auggie             | Auggie CLI         | 0.36.0     | npx                   |
| autohand           | Autohand Code      | 0.2.1      | npx                   |
| claude-acp         | Claude Agent       | 0.81.2     | npx                   |
| cline              | Cline              | 3.0.65     | npx                   |
| codebuddy-code     | Codebuddy Code     | 2.158.0    | npx                   |
| codex-acp          | Codex              | 1.13.1     | npx                   |
| cortex-code        | Cortex Code        | 1.0.73     | binary                |
| corust-agent       | Corust Agent       | 0.6.0      | binary                |
| crow-cli           | crow-cli           | 0.1.24     | binary                |
| cursor             | Cursor             | 2026.09.18 | binary                |
| deepagents         | DeepAgents         | 0.1.7      | npx                   |
| devin              | Devin              | 3000.11.3  | binary                |
| dimcode            | DimCode            | 0.5.12     | npx                   |
| dirac              | Dirac              | 0.5.16     | npx                   |
| factory-droid      | Factory Droid      | 0.227.0    | npx                   |
| fast-agent         | fast-agent         | 0.10.1     | 无：uvx未建模         |
| gemini             | Gemini CLI         | 0.61.0     | npx                   |
| github-copilot-cli | GitHub Copilot     | 1.0.88     | npx                   |
| glm-acp-agent      | GLM Agent          | 1.12.0     | npx                   |
| goose              | goose              | 1.52.0     | 无：bz2压缩格式未支持 |
| grok-build         | Grok Build         | 1.0.41     | npx                   |
| harn               | Harn               | 0.10.143   | binary                |
| junie              | Junie              | 3419.16.0  | binary                |
| kilo               | Kilo               | 7.8.1      | binary                |
| kimchi             | Kimchi             | 1.1.36     | binary                |
| kimi               | Kimi CLI           | 1.52.0     | binary                |
| minimax-code       | MiniMax Code       | 0.2.7      | npx                   |
| minion-code        | Minion Code        | 0.1.44     | 无：uvx未建模         |
| mistral-vibe       | Mistral Vibe       | 2.25.8     | binary                |
| nova               | Nova               | 1.1.47     | npx                   |
| opencode           | OpenCode           | 1.18.32    | binary                |
| pi-acp             | pi ACP             | 0.0.34     | npx                   |
| poolside           | Poolside           | 1.0.16     | binary                |
| qoder              | Qoder CLI          | 0.2.14     | npx                   |
| qwen-code          | Qwen Code          | 0.24.6     | npx                   |
| sigit              | siGit Code         | 1.5.10     | binary                |
| stakpak            | Stakpak            | 0.3.88     | binary                |
| vtcode             | VT Code            | 0.96.14    | binary                |

原型目录恰有10条：codex/opencode/pi/cline/qwen-code/claude-agent/gemini-cli/goose/kimi-cli/fast-agent。Amp只在生产当前登记/目录中，必须进入本轮验收计划。自定义验收条目3个保留既有ID、启动选择和历史；不从其自定义名称启用中央API品牌逻辑。

## 已实读官方资料与资料限制

- [官方实时Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)：2026-09-27浏览读取；明确fast-agent/minion-code为uvx、goose为tar.bz2。线上Factory Droid已0.228.0，缓存仍0.227.0，证明缓存不是最新发布保证。独立Python直取返回403，不据此判断产品目录刷新失败。
- [fast-agent ACP文档](https://fast-agent.ai/acp/)：明确客户端终端优先、本地shell选项、默认工具权限和会话列表；未安装验证。不会照抄文档中的latest或no-home启动方式。
- [Claude Agent官方接入仓库](https://github.com/agentclientprotocol/claude-agent-acp)：确认当前官方目录指向的项目，未把main能力视为本机能力。
- 原型 `agent-auth-capabilities.md` 与 `account-capabilities.js` 只作为已有研究线索；其中官方认证、订阅和设备码细节本轮没有逐条重做登录实验。Kimi/goose候选文档URL未获取到有效页，保留未知，不以错误URL作为不支持证据。

## P1 最小实验与可独立开发项

1. **现有核心三Agent**：同登记命令/原HOME/原env，单独证据目录；initialize/new真实取选项、当前权限与模型/思考值；只发短文字唯一token，不调用文件/命令工具。正常结束后冷load，比对原模型/思考，完全一致才续发。记录正常回复、明确失败、无正文end_turn和结构化失败的区别。此层仍不代表安装验收。
2. **权限**：先识别明确权限语义，不把模式当权限；只对当前值幂等设置（不扩大权限），核实set返回与通知及冷load值。当前值无权威读取时保留未知，不写“重新读取成功”。真实审批效果另需受控文件目录与最终安装候选。
3. **认证**：真实无账号条件只停止依赖分支；先补所属目标、来源、工作位置、暂离/返回/取消/迟到结果与受影响账号范围。认证方法数量不触发强制登录；终端退出码不代表可用。
4. **目录安装**：能独立补通用分发结构、格式与Node需求判定；每类至少一个真实候选检查和取消回退，再覆盖声明支持的条目。新增共享外部程序/升级不得夹带执行。
5. **API与历史**：核心现有路由保留；新品牌共享服务须先证明无外部配置写入的官方交付、来源隔离和模型确认。Amp诚实不支持恢复；Gemini/Cline区分load和list。Qwen/Pi新服务与Codex恢复矛盾不能靠复制凭据、改模型或更新外部Agent掩盖。

本报告不修改生产代码、原型、用户数据或计划。后续探针结果追加于此并指向本轮单独证据，不覆盖旧失败记录。

## P1 真实 ACP 探针补充（2026-09-27）

父任务随后明确授权独立实进程实验。使用正式登记的原命令/参数/公开环境、继承HOME；新建本轮 evidence 子目录，不读Keychain、不登录、不修改外部程序/配置、不向模型交付新秘密。以下均是直接ACP层，**不是安装版J1–J6验收**。

| 组合                                                    | 首条短请求                                                                                         | 冷load原选择与正文            | 续发                                  | 范围                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------- | ----------------------------------------------------- |
| Codex组件1.12.0 / CLI0.155.1，gpt-6-astra/ultra         | 正常end_turn且准确token，无工具                                                                    | 同一模型/ultra，历史含原token | 准确回忆原token，正常end_turn，无工具 | 本机已有账号、原有设置；不覆盖旧high漂移或外部API失败 |
| OpenCode1.18.31，opencode/big-pickle                    | 正常end_turn且准确token，无工具                                                                    | 同一模型，历史含原token       | 准确回忆原token，正常end_turn，无工具 | 未声明独立thought选项；不推广其他服务/模型            |
| Pi组件0.0.33 / CLI0.80.5，zai-coding-cn/glm-4.5-air/off | 收到token及正常end_turn，无工具；首探针把组件启动说明也累计进回复，严格聚合比较为false，原证据保留 | 同一模型/off，历史含原token   | 准确回忆原token，正常end_turn，无工具 | 本轮样本通过不关闭旧失败信息丢失；未重发首条          |

Pi聚合差异定位：官方已装组件 `dist/index.js:818` 的 `sendStartupInfoIfPending()` 把启动信息作为 `agent_message_chunk`；`:2010`附近构造new响应后异步发送。它不是本轮模型服务失败。首探针记录未分离new阶段与prompt阶段，不能以聚合exact_marker=false把正确模型回复写成失败；后续仅冷load原样本，清空回放缓冲后发一次续问，确认为exact_previous_marker=true。原始三份probe、Pi补测、脚本都保留在 [real-agent-work](real-agent-work/)。

**权限关口发现实测冲突：** Codex返回的配置类别是`mode`，说明明确是“Approval and sandboxing preset for the session”；选项id=`read-only`的实际名称却为`Ask for approval`，并不是只读文件沙箱。已装组件代码的read-only与agent都用workspaceWrite/on-request，区别为人工审批与自动审查。生产不能从id翻译成“只读”。OpenCode同为mode但值为build；Pi只给model/thought，不能套用这三档。

另建Codex专用实验会话，把agent改为更窄的人工审批档read-only；`session/set_config_option`回执完整返回read-only，模型/推理不变，短文字请求成功且无工具。结束进程后用原命令冷`session/load`，**返回mode=agent而非read-only**，模型/ultra保持；未再发送、未设置回agent或full access。详见 [codex-permission-probe.json](real-agent-work/codex-permission-probe.json)。官方已装组件源码 `getOrCreateSessionWithHistory`（dist/index.js:33678）新建状态时直接使用`AgentMode.getInitialAgentMode()`；set配置只改组件会话状态，实际下一轮将该档位交给runTurn。该事实与实测一致。

因此：

- set回执可以确认本连接下一轮将用的档位；本实验没有触发文件/命令审批，不宣称已经验证全部实际权限效果。
- coldload确实能返回新连接的当前档位，**但会重置档位，不能作为无副作用的“重新读取权限”**。结果未知时必须保留发送保护，并选择经验证的显式恢复方案；不能自动采用load值声称原选择已恢复，也不能把缓存值当权威。
- 原型固定三档名称和读取动作需要按实际官方语义落地；这是核心权限承诺的具体风险，已即时报告父任务。未经决定不擅自改外部组件或增添配置代理。
- 本次所有探针只产生Agent自己的实验历史，未登记到Farfold会话索引。没有删除历史。正常关闭后Pi曾在瞬间快照出现子进程；后续精确PID/本轮进程组复核均已消失，见 [cleanup-recheck.json](real-agent-work/cleanup-recheck.json)。不据瞬间快照宣称长期残留。

## 候选3前 OpenCode 查找范围调查与窄修（2026-09-27）

候选2安装现场观察：带入已有对话选择OpenCode，默认查找约46条旧记录，含多个目录，无更多按钮；本日P1及安装验收对话可以恢复，却未出现在该列表。以下调查只解释本机OpenCode 1.18.31，不推广其他Agent。

**因果核对。** 修复前 `history_import.ts` 只传Agent和游标；`session_discover` 因此连接默认 `conversations` 目录，向官方列表请求省略 `cwd`。已核对的[OpenCode 1.18.31列表实现](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/acp/service.ts#L234)将显式 `cwd` 交给官方服务，省略时使用服务默认范围；[对话服务](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/session.ts#L518)按当前项目查询，[项目解析](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/project/project.ts#L195)允许无Git位置归于共同的global项目。因此出现多个目录不证明查到了所有项目。原界面没有暴露这个范围或原文件夹查找入口；搜索只筛已返回的标题/位置，不查询日期或未返回历史。本次不足100条且没有游标的样本，不支持“Farfold丢掉了下一页”的判断。

**真实只读对照。** 探针起始 `2026-09-27T14:26:51.093318+08:00`，使用正式登记命令 `/Users/tw/.opencode/bin/opencode acp`，原参数、继承环境，进程目录为本轮 `installed-work`。`initialize` 实际返回版本 **1.18.31** 及列表能力，随后只有三次 `session/list`。目录全称均以 `/Users/tw/Desktop/farfold/docs/evidence/2026-09-27-prototype-rollout/` 为前缀：

| 查询参数                                  | 返回条数 | 本轮安装对话出现 | 本轮P1对话出现 | nextCursor |
| ----------------------------------------- | -------- | ---------------- | -------------- | ---------- |
| 不传cwd；进程位于 `installed-work`        | 36       | 是               | 是             | 无         |
| cwd=`installed-work`                      | 4        | 是               | 否             | 无         |
| cwd=`real-agent-work/opencode-af9f2abeed` | 1        | 否               | 是             | 无         |

安装对话ID为 `ses_f1e847aa3ffe58vmkLKunrZrZ3`，P1对话ID为 `ses_f1ed281cdffeC0CG4QTig5dY55`。同一进程的显式目录对照已证明这两条仍可通过官方列表找到；结合安装现场默认目录结果及官方源码，范围未呈现是本次漏找的原因。探针仅输出计数及这两个已知ID的身份字段，不输出其他历史标题或身份，不请求正文、不读取秘密；没有 `session/new`、`session/load`、`session/prompt`、认证或工具调用。Agent向客户端发起的请求为0，stderr为0字节；关闭标准输入后正常 **exit 0**。没有修改Agent配置、删除历史或登记新会话。探针回执保留于本任务工具输出，本段是该回执摘要，不冒充安装版操作。

**已实现，待安装验收。** 按后续明确授权，仅改五个文件：`src/runtime/history_import.ts`、`src/runtime/import_strings.ts`、`src/components/ImportConversations.tsx`、`src/runtime/history_import.test.ts`、`src/components/ImportConversations.scope.test.tsx`。新增通用可选“查找位置”，同时传 `connectionCwd`/`cwd`；默认不限定并准确标为Agent默认范围，不猜全局、不按品牌分支。用户改变位置后释放旧预览，清空旧结果、搜索、选中和游标，再由用户主动查找；迟到文件夹选择、列表及预览不会覆盖新目标，旧预览按其实际令牌关闭。搜索无匹配时仍保留官方“加载更多”入口。

四个定向测试文件共 **22项通过**，类型检查及上述五文件格式检查通过；含范围传递、恢复默认、清理选择/预览/游标、迟到结果及预览所有权回归。候选3源码现已冻结打包中，**尚未完成这条安装验收**：须在唯一正式应用分别选两个本轮原文件夹，确认对应ID出现，切换范围不沿用旧选择且不会自动加入/发送。直接列表对照、源码回归和候选3安装旅程分别记账；J1–J6仍未全面通过。
