# Farfold 首批 Agent 历史恢复模型切换与账号复用调研

调研日期为2026年10月5日，范围严格对应当前目录的33项。ACP提供这些能力所需的接口，但当前安装的33项并没有等价、完整地实现它们；Farfold客户端也遗漏了旧模型接口，并存在新接口返回值的兼容缺口。下面把已安装发行的源码事实、官方说明、能力声明和未知项分开。

## 范围与证据

当前安装记录在 2026-10-05T15:02:11.220178+00:00 只读提取。官方目录固定到提交 8ed458f223534a602cc6b74d186c3898a8428b2d，另保存当天12:18:53 UTC的官方探测快照。客户端源码取样对应HEAD dc9412718cada6a45ef23f2aa86719a2bac8257d，工作区有既有未提交变化；具体取样保存在源代码摘录中，不能把HEAD单独当成整个工作区的身份。

本轮只读取官方公开文档、精确发行/tag源码、公开发行包及本机已安装程序的公开代码。没有启动Agent、重新握手、登录/退出、读取凭据内容或用户对话、切换模型、升级、替换应用、发送请求。Devin只查公开资料。以下没有新增真实Agent成功结论；已有真实使用证据仍按原来的账号、模型与操作范围保留。

证据层级：**源码**表示实际实现已找到，包含必要的SDK请求注册检查；**官方说明**表示厂商发布的接口/版本说明；**声明**表示缓存initialize或官方探测中的字段；**未知**表示公开资料无法建立所需结论。源码成功路径不保证所有消息类型回放，也不等于真实冷启动或模型续答已通过。

## 协议与当前客户端

历史需要分开核对：session/list负责发现外部历史；session/load负责读取并回放；session/resume只恢复上下文，不回放正文。ACP要求load回放完成后才返回。没有list并不妨碍按已知ID恢复Farfold已经记录的会话。[官方会话协议](https://agentclientprotocol.com/protocol/v1/session-setup)。

模型分为C与L两条接口族：C为configOptions及session/set_config_option；L为models及session/set_model。两条都实现时优先归C。N表示没有公开所需的标准模型选择，或现有命令会清历史；U表示精确安装版的公开证据不足。C18、L7、N2、U6是接口分类，不是兼容或真实成功数量；C包括Copilot和Poolside的官方文档级证据。[配置协议](https://agentclientprotocol.com/protocol/v1/session-config-options)。

Farfold当前源码把configOptions投影到统一配置界面并请求新setter；models虽从后端原样返回，前端没有消费，也没有旧模型setter请求或current_model_update投影。因此L七项的模型能力目前未连通。历史发现和加载则已有标准list/load通路。认证继承正常环境与HOME，按agent/terminal方式执行；这仅保留复用条件，不证明各家当前账号有效。[客户端源码取样](farfold-source-excerpts.json)。

缓存initialize中，**31项声明loadSession，26项声明session/list**。无load的两项为Amp与Corust；无list的七项为Cline、Amp、Gemini、CodeBuddy、Dirac、Corust、Stakpak。不能把31写成31项完整恢复成功，也不能把26写成26项真实历史列表已验证。[安全摘要与边界](root-facts.json)。

## 33 项当前安装版本

表中“有实现”仅为源码结论；“声明”和“未知”保持原层级。更细的跨进程持久性、加载、正文回放、继续、模型与认证八项判断及逐条出处见[完整33项数据](all-33.json)。

| Agent及安装版             | 历史与恢复                                       | 模型接口及限制                        | 已有认证复用                                  |
| ------------------------- | ------------------------------------------------ | ------------------------------------- | --------------------------------------------- |
| Amp 0.9.0                 | 无列表、无加载；只能当前进程继续                 | N：只有服务档位配置，不暴露底层模型   | 混合：底层amp可复用；adapter另存API Key       |
| Google Antigravity 1.2.1  | 列表/加载有声明；正文与冷恢复未知                | U：协议模型路线公开证据不足           | 统一账号体系有文档；本机凭据复用未知          |
| Auggie CLI 0.36.0         | 持久列表/加载/回放；回放内容有限                 | L：旧models/set_model                 | 原auggie CLI登录/环境配置                     |
| Autohand Code 0.2.1       | 持久列表/加载；仅文字回放；读取失败可返回成功    | L：旧接口可达；新setter未注册         | 原Autohand Home配置与token                    |
| Claude Agent ACP 0.81.2   | 持久列表/加载/正文回放/续答有实现                | C：模型/思考配置                      | 原Claude CLI/SDK登录与配置                    |
| Cline CLI 3.0.65          | 无列表；可恢复正文；模型/提供方按当前默认重建    | C：模型/提供方/模式                   | 原Cline CLI凭据；不能推断IDE共用              |
| Codebuddy Code 2.160.0    | 无列表；持久加载/回放；受持久化与显示设置影响    | C：同时支持旧接口                     | 原CodeBuddy CLI；IDE凭据共用未知              |
| Codex ACP 1.13.1          | 持久列表/加载/正文回放/续答有实现                | C：模型/思考配置；同时有旧接口        | 原Codex环境/CODEX_HOME账号                    |
| Corust Agent 0.6.0        | 无列表、无加载；冷恢复不支持                     | U：模型探测被认证拦截                 | 未知：只见浏览器OAuth声明                     |
| Cursor 2026.09.28         | 持久列表/加载/正文回放有实现                     | C：会同步同进程所有已加载会话         | 原agent CLI登录；IDE凭据共用未知              |
| Devin 3000.11.3           | 列表/加载声明；ACP正文与冷恢复未知               | U：CLI新建默认模型不证明同会话切换    | 官方说明复用devin auth login/API Key          |
| DimCode 0.5.16            | 列表/加载声明；ACP正文与冷恢复未知               | U：旧方法存在信号；执行/新配置未知    | CLI配置复用是文档推断；存储实现不可核         |
| Dirac 0.5.17              | 列表未接通；需持久任务与配置快照才可加载/回放    | C：按任务修改并持久化                 | 原CLI提供方配置与ChatGPT OAuth                |
| Factory Droid 0.230.0     | 持久列表/加载/回放；会吞单块回放错误             | C：setter返回空；Farfold无法确认保存  | 原Droid CLI令牌/API Key                       |
| fast-agent 0.10.1         | 持久列表/加载；仅当前活动Agent的正文；异常可吞掉 | N：模型命令会重建会话/清历史          | 原fast-agent配置、secret与OAuth               |
| Gemini CLI 0.62.0         | 无列表；可持久加载正文；回放未等待完成           | L：旧models/set_model                 | 原Gemini CLI OAuth/API/Vertex配置             |
| GitHub Copilot CLI 1.0.89 | 列表/加载有官方证据；正文与冷恢复未知            | C：官方发行说明证据，未见公开实现     | CLI OAuth/token/gh后备，官方说明              |
| Goose 1.52.0              | 持久列表/加载；回放用户可见内容                  | C：按会话重建提供方并保留历史         | 原Goose配置与提供方凭据                       |
| Grok Build 1.0.46         | 安装版列表/加载声明；精确实现与正文未知          | U：main为C，不能覆盖安装1.0.46        | 精确安装版实现未知；main有复用路径            |
| Junie 3419.24.0           | 列表/加载声明及CLI恢复文档；ACP正文未知          | U：CLI模型命令不证明ACP切换           | 官方CLI凭据；不保证任意IDE授权共用            |
| Kilo 7.8.1                | 持久列表/加载/回放；单条回放失败可吞掉           | C：同时支持旧接口                     | 原Kilo CLI凭据；authenticate本身空成功        |
| Kimchi 1.3.0              | 持久列表/加载/回放；缺文件可成功加载为空         | C：同时支持旧接口；Agent可持久化默认  | 原Kimchi凭据；不是独立Pi的账号目录            |
| Kimi CLI 1.52.0           | 需cwd列历史；持久加载；重复加载不回放            | L：同时写全局默认模型/思考            | 原Kimi Code OAuth；普通API配置不等于ACP已认证 |
| MiniMax Code 0.2.7        | 持久列表/加载/正文回放/续答有实现                | C：模型/思考配置                      | 原mcode数据目录、登录与配置                   |
| Mistral Vibe 2.25.8       | 持久列表/加载/正文回放/续答有实现                | C：模型/思考配置                      | 原Vibe环境文件与提供方凭据                    |
| Nova 1.1.49               | 持久列表/加载；可空建；回放晚于响应              | L：按会话修改并保存                   | 原nova setup配置                              |
| OpenCode 1.18.31          | 持久列表/加载/正文回放/续答有实现                | C：同时支持旧接口                     | 原OpenCode CLI/服务配置                       |
| Pi ACP 0.0.34             | 持久列表/加载/正文；每连接仅一个活动Pi           | C：转交Pi模型/思考命令                | 原Pi环境与HOME配置                            |
| Poolside 1.0.16           | 列表/加载/持久性有官方说明；正文未知             | C：官方文档级，执行范围仍未实测       | 官方说明复用pool login保存凭据                |
| Qoder CLI 0.2.14          | 按项目列历史；持久加载；回放未等待完成           | L：初始只暴露旧models；C setter未广告 | 官方明确普通CLI已有登录无需重登               |
| Qwen Code 0.24.7          | 持久列表/加载；标准load等待完整回放              | C：同时支持旧接口；不写全局默认       | 原Qwen CLI设置与凭据                          |
| siGit Code 1.5.11         | 持久列表/加载；旧无cwd记录漏列；缺历史可空建     | C：按会话修改并保存                   | 原siGit账户与配置                             |
| Stakpak 0.3.88            | 无列表；load只设UUID，没有正文恢复/回放          | L：忽略sessionId，修改进程共享模型    | 原Stakpak配置/官方API Key                     |

## 当前明确的差异

**旧模型接口缺口影响7项。** Gemini、Auggie、Autohand、Kimi、Nova、Qoder、Stakpak有旧模型入口或旧模型状态。当前客户端没有对应通路。Qoder虽另有新setter，初始new/load只给旧models，客户端仍无法发现模型；其既有执行引擎如何采用新模型还有未核尽的部分。

**Autohand存在SDK注册缺口。** 0.2.1源码有新配置setter和选项，但其SDK0.12.0没有注册session/set_config_option；旧set_model已注册。只检查类方法或返回选项会误判。

**Factory存在响应确认缺口。** 0.230.0 setter执行模型更新后返回空对象。当前客户端只凭响应中的configOptions确认并保存模型；普通配置通知不能授权本次变更。空响应会导致解码或确认失败，不能称已可用。接口可能已改变Agent实际模型，而Farfold无法确认保存；这是需要保持暂停并重新检查的结果未知状态，不能自动重试。

**模型不一定按会话隔离。** Cursor2026.09.28在setter后遍历同进程sessions，把共享模型同步给所有已加载会话；Stakpak0.3.88的旧setter忽略sessionId，修改进程共享model。Kimi切换还写全局default_model/default_thinking。这些是静态实现事实；其他会话或正在运行请求究竟何时受影响没有实测。不能用每会话Farfold元数据假装Agent端隔离。

**Amp和fast-agent不能套用任意同对话模型切换。** Amp0.9.0只有amp-mode服务档位，adapter重启后也没有ACP历史恢复。fast-agent0.10.1的/model switch会创建/替换会话并clear_agent_histories，不能作为保留同会话上下文的模型切换；公开0.10.42仍明确拒绝标准配置setter。

**load成功不保证读到了原历史。** Stakpak只设UUID，根本未读取或回放正文。Autohand读取失败仍返回loaded文字；Kimchi1.3.0、Nova1.1.49、siGit1.5.11有缺失历史时创建同ID空会话的路径。Kimi已在内存的会话重复load直接返回，不再回放；fast-agent、Kilo、siGit、Factory等回放路径还会吞掉部分发送错误。它们不能被统一标成完整历史恢复。

**回放完成时序有差异。** Gemini0.62.0、Qoder0.2.14没有等待streamHistory；Nova1.1.49用setImmediate把回放安排在响应之后。Farfold导入完成标记依赖load结束后的事件顺序；源码已揭示兼容风险，但本轮没有实测丢字/空白，不能把风险写成已复现失败。也不能用随意加等待时间证明完整回放。

**恢复正文与恢复配置不同。** Cline3.0.65不按会话保存provider/model，冷load按当前默认重建；Auggie与Autohand也有从当前默认重建配置的路径。Farfold保存旧选择并检查实际返回值是必要的，但不证明这些Agent会自动恢复原模型。

**公开证据不足须继续保留。** Antigravity、Corust、Devin、Dimcode、Grok已安装1.0.46、Junie的模型路线为U。Antigravity、Devin、Dimcode、Copilot、Junie、Poolside的ACP正文/冷恢复细节仍不可确认；Grok公开main有完整路径，但无法证明就是1.0.46发行实现。U不是判定不支持。

## 账号复用与账号管理

多数可核项使用原CLI/SDK自己的账号与配置，所以没有必要在Farfold重新实现登录系统。但“同品牌账号”“同CLI本机凭据”“IDE已有登录”“API Key配置”必须区分。Cursor、CodeBuddy、Junie不能从CLI复用推出任意IDE账号自动复用；Antigravity统一账号权益的官方说明，也不直接证明本机登录文件可免登录共用。

Amp是混合情形：底层amp CLI继承环境，可能使用已有CLI登录；adapter自己的setup另保存amp-acp凭据并交付AMP_API_KEY，authenticate检查的是该来源。Kimchi使用自己的Kimchi/Pi harness存储，不等于用户独立Pi目录。Kimi ACP要求Kimi Code OAuth，普通提供方配置存在不代表通过该认证。

authenticate回空对象也不统一代表执行过登录：Pi、OpenCode、Goose、fast-agent、Auggie、Kilo等存在no-op/确认方法/只检查已有设置的实现。必须区分认证入口、设置检查、当前账号有效和实际模型请求。用户应按Agent真实的终端/浏览器方式完成认证。[官方认证协议](https://agentclientprotocol.com/protocol/v1/authentication)。

缓存中只有Claude、Codex、Dirac、Antigravity、Kimchi、Poolside声明标准auth.logout。其他程序有CLI退出命令或专有扩展，也不能等同设置页已连通标准退出：Codex有账号查询/退出和状态推送；Claude有状态推送和退出；Vibe用auth/status及auth/signOut；Grok main、Kimchi、CodeBuddy等有自有查询入口。CodeBuddy用户信息扩展还可能带token/accessToken，不能直接显示或记录完整结果。本轮没有读取任何此类真实回执。

## 版本与来源

以下始终以安装版作主结论。Kilo7.8.1、Kimchi1.3.0、siGit1.5.11已补查精确旧tag；新版siGit1.6.0在历史缺失时改为报错，不能倒推旧版已修复。目录、当日探测、npm/PyPI最新与安装版可能不同：例如Claude安装0.81.2、探测0.85.1、目录0.86.0；fast-agent目录/安装0.10.1而PyPI0.10.42；Qwen目录/安装0.24.7而npm0.25.0。没有因此执行升级。

官方ACP目录收录不等于由Agent厂商维护：Pi与Amp是社区adapter，Codex/Claude为协议生态维护的适配器，很多其他项是厂商原CLI内置的ACP服务。来源影响可用接口与凭据复用，不能按统一“原生”标签忽略。各项source字段记录维护来源与实际检查的文件。

## 每项主要来源

下列链接指向精确版本的实现或第一方说明；完整行号、多个功能的不同出处、版本差异与本地公开发行片段位置都保存在三组JSON中。

- Amp 0.9.0：[来源1](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/server.ts), [来源2](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/index.ts)。

- Google Antigravity 1.2.1：[来源1](https://antigravity.google/docs/ide/extensions), [来源2](https://antigravity.google/docs/ide/extensions/zed/)。

- Auggie CLI 0.36.0：[来源1](https://docs.augmentcode.com/cli/acp/agent), [来源2](https://docs.augmentcode.com/cli/reference)。

- Autohand Code 0.2.1：[来源1](https://github.com/autohandai/autohand-acp/blob/v0.2.1/src/acp-agent.ts), [来源2](https://registry.npmjs.org/@autohandai/autohand-acp/0.2.1)。

- Claude Agent ACP 0.81.2：[来源1](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.81.2/src/acp-agent.ts#L2429), [来源2](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.81.2/src/acp-agent.ts#L2448)。

- Cline CLI 3.0.65：[来源1](https://github.com/cline/cline/blob/cli-v3.0.65/apps/cli/src/acp/acpAgent.ts#L127), [来源2](https://github.com/cline/cline/blob/cli-v3.0.65/apps/cli/src/acp/acpAgent.ts#L246)。

- Codebuddy Code 2.160.0：[来源1](https://www.codebuddy.ai/docs/cli/acp), [来源2](https://www.codebuddy.ai/docs/cli/cli-reference)。

- Codex ACP 1.13.1：[来源1](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/CodexAcpServer.ts#L791), [来源2](https://github.com/agentclientprotocol/codex-acp/blob/v1.13.1/src/CodexAcpServer.ts#L857)。

- Corust Agent 0.6.0：[来源1](https://github.com/rustingai/corust-agent-release), [来源2](https://github.com/rustingai/corust-agent-release/releases/tag/v0.6.0)。

- Cursor 2026.09.28：[来源1](https://cursor.com/docs/cli/acp), [来源2](https://docs.cursor.com/en/cli/reference/parameters)。

- Devin 3000.11.3：[来源1](https://docs.devin.ai/cli/acp/zed), [来源2](https://docs.devin.ai/cli/reference/commands)。

- DimCode 0.5.16：[来源1](https://www.dimcode.dev/en/docs/acp/), [来源2](https://www.dimcode.dev/en/docs/cli/)。

- Dirac 0.5.17：[来源1](https://github.com/dirac-run/dirac/blob/v0.5.17/cli/src/acp/AcpAgent.ts), [来源2](https://github.com/dirac-run/dirac/blob/v0.5.17/cli/src/agent/DiracAgent.ts)。

- Factory Droid 0.230.0：[来源1](https://docs.factory.com/ide-integrations), [来源2](https://docs.factory.ai/changelog/release-notes)。

- fast-agent 0.10.1：[来源1](https://github.com/evalstate/fast-agent/blob/v0.10.1/src/fast_agent/acp/server/agent_acp_server.py#L320), [来源2](https://github.com/evalstate/fast-agent/blob/v0.10.1/src/fast_agent/acp/server/session_store.py#L316)。

- Gemini CLI 0.62.0：[来源1](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpRpcDispatcher.ts#L40), [来源2](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpRpcDispatcher.ts#L106)。

- GitHub Copilot CLI 1.0.89：[来源1](https://github.com/github/copilot-cli/blob/main/changelog.md#L2502), [来源2](https://github.com/github/copilot-cli/blob/main/changelog.md#L2665)。

- Goose 1.52.0：[来源1](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/server.rs#L1824), [来源2](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/server/load_session.rs#L382)。

- Grok Build 1.0.46：[来源1](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs#L635), [来源2](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/session_setup.rs#L923)。

- Junie 3419.24.0：[来源1](https://github.com/JetBrains/junie-acp-release/releases/tag/3419.24), [来源2](https://junie.jetbrains.com/docs/junie-cli-acp.html)。

- Kilo 7.8.1：[来源1](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/service.ts#L94), [来源2](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/service.ts#L143)。

- Kimchi 1.3.0：[来源1](https://github.com/getkimchi/kimchi/blob/v1.3.0/src/modes/acp/server.ts#L430), [来源2](https://github.com/getkimchi/kimchi/blob/v1.3.0/src/modes/acp/server.ts#L462)。

- Kimi CLI 1.52.0：[来源1](https://github.com/MoonshotAI/kimi-cli/blob/1.52.0/src/kimi_cli/acp/server.py#L42), [来源2](https://github.com/MoonshotAI/kimi-cli/blob/1.52.0/src/kimi_cli/acp/server.py#L115)。

- MiniMax Code 0.2.7：[来源1](https://registry.npmjs.org/@minimax-ai/code/0.2.7), [来源2](https://registry.npmjs.org/@minimax-ai/code/latest)。

- Mistral Vibe 2.25.8：[来源1](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/vibe/acp/agent.py#L452), [来源2](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/vibe/acp/agent.py#L556)。

- Nova 1.1.49：[来源1](https://github.com/Compass-Agentic-Platform/nova), [来源2](https://registry.npmjs.org/@compass-ai/nova/1.1.49)。

- OpenCode 1.18.31：[来源1](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/acp/service.ts#L95), [来源2](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/acp/service.ts#L209)。

- Pi ACP 0.0.34：[来源1](https://github.com/svkozak/pi-acp/blob/v0.0.34/src/acp/agent.ts#L909), [来源2](https://github.com/svkozak/pi-acp/blob/v0.0.34/src/acp/agent.ts#L938)。

- Poolside 1.0.16：[来源1](https://github.com/poolsideai/pool), [来源2](https://docs.poolside.ai/cli/pool)。

- Qoder CLI 0.2.14：[来源1](https://docs.qoder.com/cli/acp), [来源2](https://docs.qoder.com/cli/authentication)。

- Qwen Code 0.24.7：[来源1](https://github.com/QwenLM/qwen-code/blob/v0.24.7/packages/cli/src/acp-integration/acpAgent.ts#L1050), [来源2](https://github.com/QwenLM/qwen-code/blob/v0.24.7/packages/cli/src/acp-integration/acpAgent.ts#L5734)。

- siGit Code 1.5.11：[来源1](https://github.com/getsigit/sigit/blob/v1.5.11/src/main.rs#L1438), [来源2](https://github.com/getsigit/sigit/blob/v1.5.11/src/main.rs#L1472)。

- Stakpak 0.3.88：[来源1](https://github.com/stakpak/agent/blob/v0.3.88/cli/src/commands/acp/server.rs#L1570), [来源2](https://github.com/stakpak/agent/blob/v0.3.88/cli/src/commands/acp/server.rs#L1601)。

## 保存的证据与未覆盖项

- [33项合并数据](all-33.json)：每项八种能力、证据层级、限制、来源与版本；三组原始核查记录：[核心](group-core.json)、[商业](group-commercial.json)、[其余](group-remaining.json)。

- [安装能力安全摘要](root-facts.json)：只含非秘密安装版本、方法声明及本轮边界；未保存用户会话、凭据或账号内容。

- [固定目录快照](registry-scope-pinned.json)、[官方当日探测](protocol-matrix-latest.json)、[客户端源代码摘录](farfold-source-excerpts.json)。

官方探测只覆盖首批31项，缺fast-agent、Qoder。它没有测试session/load或新配置setter，模型探测使用占位modelId与多数无效sessionId；invalid_params/resource_not_found被算作方法存在，不能证明切换成功。Nova还把不存在session错误编码成method_not_found，发行代码却明确注册旧setter，说明必须读取错误正文与实现。此快照只作旁证。

这份记录不是新增开发计划或验收门槛。下一步修复应继续沿现有统一UI和活动计划处理：旧模型接口兼容、Factory返回值确认、恢复完整性及配置范围。不能因此替Agent维护第二套历史、修改Agent配置、硬编码模型、自动更换账号或追加真实模型请求。源码/官方说明已核；真实账号、跨进程恢复、真实续答、切模型执行及多会话影响仍按逐项记录保留未测。
