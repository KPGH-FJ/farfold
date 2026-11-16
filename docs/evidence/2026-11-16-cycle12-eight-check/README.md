# 第 12 周期八项验收续查

2026-11-16，macOS。当前首发 22 家、176 个验收格。Gemini CLI 和 Antigravity 按用户要求暂缓，本次不启动或请求两家服务。当前八项逐家结果见[唯一验收表](../2026-11-15-cycle12-continuation/acceptance-roster.json)。

## Autohand 前台停止

正式 Farfold 0.1.7，Autohand 0.9.11。两条真实对话在两个自建文件夹沿用已有服务和 Fantail，各单次授权 `/bin/sh ./wait-owned.sh`。A 与 B 各有 Shell 和 sleep 子进程同时运行，进程组独立。只点 A 的「停止」，回复停止、两个处理步骤标为结果未知。约 9.5 秒后 A 的 Shell 已退出，但它的 sleep 仍活跃并由 PID 1 接管。B 的原 Shell 和 sleep 当时仍运行，随后自然写出 B 的正确标记，Farfold 收到该标记并显示 B 已完成。A 没有写出完成标记，测试子进程随后到期自然退出。仅本轮各一条请求，未发送其他停止信号。

官方适配器收到 ACP 取消后触发原请求的 AbortSignal。同版本前台命令路径未在该调用中单独创建命令进程组，取消只终止直接子进程。已核的稳定发行仍为 0.9.11，正向停止须等官方前台终止覆盖子进程。SDK 的进程树终止只管理由 SDK 自己启动的进程。Farfold 的原请求未知保护保留，未改用自动关闭整条连接。[取消入口](https://github.com/autohandai/code-cli/blob/v0.9.11/src/modes/acp/adapter.ts#L1089-L1099) · [命令停止实现](https://github.com/autohandai/code-cli/blob/v0.9.11/src/actions/command.ts#L320-L345) · [官方 SDK](https://github.com/autohandai/code-agent-sdk-rust/blob/main/docs/API_REFERENCE.md#run)

## 外部条件与不能合并的结果

- **Amp** 原登记适配器 0.9.0，正式程序检查的 Amp CLI 已就绪，实际同一路径官方程序版本为 0.0.1790740844-g023754。已有设置读到 Medium，零模型请求。厂商 CLI 的 `account list` 返回无保存账号，同一程序一次只读线程列表因需认证退出。目录适配器的旧密钥和厂商 CLI 登录分别管理，使用的身份需分别核。用户需先恢复原厂商账号，之后核原 T-ID 线程。目录可用的 0.13.0 有适配器自己的 S-ID 映射，不能直接代替原厂商线程。云端与工具实际停止仍待确切原请求回执。[官方账号](https://ampcode.com/docs/cli#manage-cli-accounts) · [原线程导出](https://ampcode.com/docs/threads#export-a-thread) · [目录适配器 0.13.0](https://github.com/tao12345666333/amp-acp/releases/tag/v0.13.0)
- **MiniMax** 原正文和 M2.7 已冷开，当前 M2.7 官方返回 50110 余额或额度不足，原账号未能确认，新服务不能作为原对话续答。需确认中国区原账号与可用额度。已核同版官方第三方入口，可验另一条独立新对话。[原对话](../2026-11-16-cycle12-original-config/README.md) · [额度回执](../2026-11-16-cycle12-qwen-exit/README.md) · [第三方 API](../2026-11-16-cycle12-service-diagnosis/README.md#minimax-外部-api)
- **Claude** 托管 Messages 继续暂停。重新核对适配器 0.107.0、其官方 SDK 0.3.323 与较新的官方预览包，托管认证设置会进入子进程参数；原小米兼容请求还有认证头占位问题。宿主环境的官方入口可以交付环境变量，但该适配器读回父进程配置，不能核实实际生效的独立来源。可独立验用户选定的 Claude 订阅或 Anthropic Console 官方登录，现有 API 配置原样保留。[原暂停依据](../2026-11-16-cycle12-original-config/README.md#claude-环境核对) · [官方宿主环境](https://code.claude.com/docs/en/env-vars#provider-routing)
- **Pi** 当前目录适配器 0.0.34 接收网页工具配置但未传给运行中的 Pi。上游两个提案仍未发版，已验证的官方 SDK 1.5.2 能注册会话内工具，未在正式版接线。替代入口须保持原会话所有权、只读预览、已保存配置、审批与撤回，并证明助手进程身份。没有变更共享网页授权规则。[SDK 回执](../2026-11-15-official-alternatives/pi.md) · [官方适配器提案](https://github.com/svkozak/pi-acp/pull/164) · [另一提案](https://github.com/svkozak/pi-acp/pull/145)
- **siGit** 同版 1.5.11 在 ACP 中已明确支持 OpenAI 兼容环境或官方配置。界面报告本地 Onde 的就绪早于模型实际加载，进程级覆盖也可能保留本地模型名。先核定本地来源与缓存。当前无需用户先提供 Key。 [同版官方实现](https://github.com/getsigit/sigit/blob/v1.5.11/src/main.rs#L4250-L4312)

## Cline 文件交付

正式 Cline 3.0.74 在普通新对话沿已有服务和免费 Nemotron 3.5 Super VL。仅发送一次，先核这一个 `notes.md` 读取，后批准指定路径的 `result.md` 写入各一次。成品两节及负责人、日期与原稿核对正确，原文件摘要相同，在 Farfold 对话内容的「打开文件…」选择副本后完整预览。Cline 本轮没有提供可归属的结构化写入位置、差异或资源，未自动出现本轮成品入口。其 ACP 收尾只带状态和 rawOutput，工具后置钩子可替换原结果。待厂商提供同一实际写入的结构化回执，现有查看入口仍可用。[Cline ACP 更新](https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/session-updates.ts#L137-L147) · [结果处理](https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/agents/src/agent-runtime.ts#L2621-L2677)

## Qoder 新对话与文件交付

本机 Qoder CLI 1.1.89 的正常新对话完成握手和打开，Farfold 记住的 `qfmodel` 未被当前程序提供，提示设置未确认，零发送。新版本允许从原模型选择器直接点「检查模型设置」。实际读回用户经 Qoder 官方 Custom 配好的 `mimo-v2.6-flash`。正式界面显示旧值和新值，已有服务及 Default 一致。手动采用当前配置，将 Farfold 的新对话默认选择从旧值更新为这条已配置的小米模型。回到原草稿，未发验收文字仍可见。

同目录普通新对话重新核对使用小米和 Default，只发一条。批准新副本 `result.md` 的写入一次，界面完成。打开「本轮产物」并选择该文件，核对分类、负责人和日期，原样本字节保持。[正式回执](results.json)

## Qoder 停止及发送名额

11 月 16 日在正式版以 Qoder CLI 1.1.89 的已有设置和已配置的 MiMo 创建两个自建空目录对话。A、B 保存的官方模型值相同。每条仅发送一次，分别单次批准确定的只读等待命令。A 的 `/bin/sleep 120` 子进程 PID 57062 归属 Shell 57059，工作目录匹配 A。此前一轮在发送前超时、零 `session/prompt`，原草稿保留。

A 运行时，B 的界面显示「正在等待发送」，B 连接尚无 `session/prompt`。在 A 按「停止」后，协议 `protocol-v1-1794828307815-63.jsonl` 记录 19:29:46.384（UTC+8）发送 `session/cancel`、19:29:46.391 收到请求响应。独立进程检查确认 A 的 Shell 和子进程均已退出，未等到 120 秒自然结束。界面显示「回复已停止，仍有步骤未确认结束」，该工具实时终态仍未知。

B 的 `protocol-v1-1794828504057-65.jsonl` 在 19:29:46.392 实际发送，单次批准后命令进入独立的 Shell 57284 和子进程 57287，随后返回 `FF_C12_QODER_B_NATURAL_END`，正式界面显示完成。此次覆盖实际停止和排队释放，缺两条实际命令同时运行的隔离证据。

源码的发送名额为全局两个，同一 Agent 可使用两个。正式界面另有一条 OpenCode 协议报错后的对话明确显示「当前连接仍保留一个任务名额」。用户逐条授权后，从正常界面单独关闭该连接。界面确认关闭，原历史与未发送内容按界面范围保留；对应协议记录 `protocol-v1-1794825345946-43.jsonl` 确认归属进程组退出并移除连接。

复验使用新的独立空目录。A 的原标识 `e885dad4-67c9-48e8-ab07-666dd98c2fc3`，B 的原标识 `194aee7f-0fb0-4ad3-83f0-19775fbfe9e0`，两条均沿用已有设置并保存同一 MiMo。各发一条，分别批准一次。停止前从 PID 与工作目录核两条同时运行：A 的 Shell 和 sleep 为 61605、61608，B 为 61610、61613。19:38:07.154 从 A 按「停止」，A 连接的 `protocol-v1-1794829019199-68.jsonl` 记录 `session/cancel`，7 毫秒后收到响应。19:38:19 两个 A PID 都已退出，B 的两个原 PID 仍在执行。界面保留 A 的工具步骤结果未知。

B 的 `protocol-v1-1794829044139-70.jsonl` 在 19:39:03.976 收到工具更新，19:39:09.905 收到终态响应，全程无取消通知。正式界面显示 `FF_C12_QODER_PAIR_B_NATURAL_END` 和「已完成」。A 当时的连接检查仍提示暂时无法安全单独关闭。

### Qoder 停止后冷开续答

在正式版 0.1.7（CDHash `2d46978b6a5c4f3283c817420e242b364de7f2b7`）核两组验收进程均已退出，在退出保护界面保存退出，再打开正式应用。从侧栏打开 A，原消息和「此前请求结果未确认，未自动重发」可见。「模型与来源」显示沿用已有设置、`mimo-v2.6-flash`、Default。首条命令保持停止。打开时只有一次 `session/load`，没有自动发送。

从原输入框发一次不含原标记的上下文追问，要求只回复第一条用户消息开头的验收标记，并明确不执行命令。收到 `FF_C12_QODER_PAIR_A`，正式界面显示「已完成」。`protocol-v1-1794834778265-0.jsonl` 记录 1 次 `session/load`、1 次手动 `session/prompt`、0 次 `session/new`，续问从出站到匹配答复约 1.96 秒，发送后零工具更新和审批。Farfold 索引仅有原标识 `e885dad4-67c9-48e8-ab07-666dd98c2fc3`，目录及官方 Custom 保存的小米 MiMo 保持。A 停止时缺失的原工具终态仍保留为未确认。

## Copilot 原账号、原对话和 Auto 路由

用户确认当前为原 GitHub 账号。正式 Farfold 从「带入已有对话」选择 Copilot 和原工作目录，官方列表找到 `FARFOLD_COPILOT_A_20261006`，预览读回原消息和回复。只加入该条，索引从 0 条到 1 条，原标识 `f42b41e3-2978-4ce8-ac4d-7b92dce52646`，目录保持。预览、加入和打开各阶段没有模型请求。从「恢复原对话设置」核对并保存与旧回执一致的已有服务和 Auto，再打开「模型与来源」核对保存值。

只发一条需要原上下文的短续问，未给出预期标记。`protocol-v1-1794835087081-4.jsonl` 记录一次 `session/load` 和一次手动 `session/prompt`，零 `session/new`，续问无工具和审批。约 20.7 秒后，Copilot 原会话事件记录 `session.error`，`errorType=query`，无状态码，报告 Auto 内部尝试两次后网络错误。同一毫秒的 ACP 更新仅为助手正文，6 毫秒后协议响应无错误码。界面显示「已完成」，实际未返回预期标记。保留原账号、服务和 Auto。本次查询的官方状态页显示 Copilot 与模型提供方运行正常，单次故障原因仍待确认。反馈修复需核同一请求能否从官方接口收到可识别的失败信号。[SDK 失败事件](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events#sessionerror) · [GitHub 状态](https://www.githubstatus.com/)

### Copilot Auto 同条件复验

同一轮只读取失败时对应进程的官方日志。没有找到该次已认证选模请求的目标地址、HTTP 状态或 DNS、TLS 失败细节。当前三个官方公共连通性端点返回 HTTP 200 且通过 TLS 验证。公共连通性与历史失败分别记录，保留原网络、账号及配置。

当前正式版 0.1.7（CDHash `7aefe7b0116d761bf7dcfcbed3ab392e0bd4aadd`）从侧栏打开原标识 `f42b41e3-2978-4ce8-ac4d-7b92dce52646`。原目录、沿用已有服务、Auto 保持。手动发一次不含原标记的上下文续问，界面约 18.1 秒后完成，准确返回 `FARFOLD_COPILOT_A_20261006`。官方原会话中有新 `assistant.message` 和 `assistant.turn_end`，该轮无 `session.error`。`protocol-v1-1794836414146-2.jsonl` 有一次 `session/load`、一次 `session/prompt`，零新建、零工具调用或审批。Copilot 另外通过助手文字显示其自行排队的远端索引提示。原索引仍唯一，当前已认证 Auto 路由复验通过。

第一次的失败反馈仍未修正。Farfold 现有路径以匹配的终态和结构化失败决定本轮状态，并按非空助手内容判断有回复。该次没有收到可归一化的错误，错误句又走助手正文，所以显示完成。同类终态与正文混用已在 Copilot CLI 的公开问题记录。当前官方 SDK 读取事件需要自己的会话连接，按会话取整段事件；该失败原事件关联的是之前的恢复事件，没有对应轮次或用户消息标识。当前 ACP 未发现能交付本轮结构化失败的接口。保留真实正文，未按文字猜测状态。[公开问题](https://github.com/github/copilot-cli/issues/5266) · [官方 ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) · [SDK 读取实现](https://github.com/github/copilot-sdk/blob/v1.0.34/nodejs/src/session.ts#L3073-L3112)

## Cline 和 Amp 的官方备选入口

- Cline 3.0.74 对应 SDK 0.2.0。公开历史入口即使设 `hydrate:false`，仍调用可能改写失联会话的列表。内部元数据列表跳过该步骤，但公开打开同一存储仍执行初始化和迁移。保留按已知 ID 的 ACP 读取，当前缺可验证的同存储只读发现入口。[公开入口](https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/runtime/host/host.ts#L55-L68) · [列表实现](https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/session/services/persistence-service.ts#L516-L564)
- Cline 发布的历史搜索脚本有只扫描清单的 `--no-db` 模式。独立样本确认状态和文件不变；本机实测仅将两份已核自有测试元数据链接进临时目录，按文件交付样本的原目录查找，返回唯一原 ID `1794814385032_IEsyY_cli`，与 Farfold 索引和原目录核同。原清单、正文、SQLite 和现有附属文件，共 7 项的摘要、修改时间未变。未读取 transcript、未导出、未发模型。原脚本的目录匹配为子串，重复 ID 先于过滤被合并，输出含完整提示词，接口没有分页；可证明这两个样本内的只读发现，完整 Farfold 列表仍需能确定范围、处理冲突和控制输出的官方方式。只读 SQLite 模式在没有附属文件的 WAL 夹具中也曾把错误变为空列表。[官方脚本](https://github.com/cline/skills/blob/26378461e978f2b4e2e6d67b57121b86b2a79ba5/skills/cline-session-search/scripts/search_sessions.py#L115-L187) · [选项和输出](https://github.com/cline/skills/blob/26378461e978f2b4e2e6d67b57121b86b2a79ba5/skills/cline-session-search/scripts/search_sessions.py#L480-L545)
- Amp ACP 0.13.0 对旧线程续答仍追加显式 `--model`。已发布的 TypeScript SDK 也将其映射到同一 CLI 参数。官方 CLI 与 SDK 的覆盖选项限新线程，交互界面另有切换模型入口；公开 API 和插件没有可调用的同一旧线程模型设置入口。同一旧线程沿用原 MiMo 的实测正例保留。显式选择后继续仍待官方组件或可验证的同线程接口。[组件](https://github.com/tao12345666333/amp-acp/blob/v0.13.0/src/amp-transport.ts#L205-L243) · [官方模型切换](https://ampcode.com/docs/model-selector#switch-models-in-a-thread) · [API 规范](https://ampcode.com/api/v2/openapi.json)

### Cline 原目录与重复 ID

同版官方脚本的两组隔离对照复现了不同问题。原目录和邻近名称目录各放不同 ID，`--cwd` 给出两条，按能解析的实际目录进行精确比较后只留目标一条。两个不同目录各放同 ID 时，脚本先合并清单再应用目录过滤。其公开输出与仅有幸存记录的对照完全相同，即使加上同一目录条件也无法识别冲突。五份夹具的文件摘要和修改时间未变，未读取实际数据库或正文，未发送请求。

当前发布的 Cline CLI 3.0.74 和 SDK 0.2.0 不提供符合这组要求的另一条只读列表。ACP 只声明按已知 ID 加载，载入流程使用调用方给出的目录，成功回放不能反证它是原目录。通用 Farfold 列表也会在构建页面时按 ID 取首条，未来接入须在该步骤之前验证原始记录。可接入的条件是官方入口只读、能准确说明原目录，并在其过滤或去重前暴露冲突，或返回明确的冲突结果。当前保持已知 ID 的正常入口，范围不明确的完整列表不进入正式版。[脚本分组与过滤](https://github.com/cline/skills/blob/26378461e978f2b4e2e6d67b57121b86b2a79ba5/skills/cline-session-search/scripts/search_sessions.py#L172-L215) · [Cline 已知 ID 读取](https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/acpAgent.ts#L249-L292)

### Cline 双前台实际停止

正式 Farfold 0.1.7，CDHash `7aefe7b0116d761bf7dcfcbed3ab392e0bd4aadd`，正式登记与握手均为 Cline 3.0.74。沿用已有服务及 `nvidia/nemotron-3.5-super-vl:free`，两个自建目录各一条请求和一次批准。首轮 B 的等待夹具超过 Cline 默认 30 秒命令限制而超时，后来提出的额外命令在 Farfold 拒绝。使用 23 秒的 B 夹具重新验证。

复验时本机在 22:01:07.787（UTC+8）同时观察到 A 的 Shell 8126、sleep 8128，B 的 Shell 8150、sleep 8152，各属独立进程组及各自目录。从 Farfold 只按 A 的「停止」，A 协议于 22:01:08.569 发出取消，界面显示回复已停止。22:01:08.656 A 两个进程已退出，B 原两个进程仍在。B 于 22:01:30.784 自然退出，正式界面返回 `FF_C12_CLINE_TIMED_B_NATURAL_END` 并显示完成。协议 `protocol-v1-1794837587893-8.jsonl`、`protocol-v1-1794837610648-10.jsonl` 各只发一次，B 无取消。此证据覆盖两条前台命令实际隔离与停止。

正常保存退出后，从侧栏冷开 A 的原 ID `1794837588192_xoYMw_cli`。在原目录沿用已有服务、相同免费 Nemotron 和 Act，发一条不含原标记的上下文续问。约 5.2 秒准确返回 `FF_C12_CLINE_TIMED_A`。`protocol-v1-1794837874154-0.jsonl` 记录一次 `session/load`、一次手动 `session/prompt`、零新建、零续问工具或审批。原索引唯一，停止命令未重跑。覆盖从已保存索引恢复，未验证 Cline 正式列表发现。

## 等待官方的复验条件

- **Copilot 失败反馈。** 等官方在同一次 ACP 请求返回协议错误，或提供能准确对应这次请求的结构化失败事件。发布后用原 Auto 服务或官方可控夹具，从 Farfold 触发一次失败，核实际请求、失败显示、草稿与待发保护以及无完成通知、无自动重发。原账号及 Auto 正常续答的正例保留。[Copilot 公开问题](https://github.com/github/copilot-cli/issues/5266) · [ACP 错误规范](https://agentclientprotocol.com/protocol/v1/schema#error)
- **Amp 显式 MiMo 续答。** 等组件新版能核对已有线程的实际模型与显式选项一致并省略仅用于新建的 `--model`，或等 Amp 发布可对既有线程使用且能读回的模型设置接口。恢复后从 Farfold 冷开同一 T-ID，保持显式 MiMo 与原推理设置，发送一次依赖原上下文的短问；官方导出核新问答归原线程，官方用量核一次推理走同一小米连接。已有沿用原 MiMo 续答的正例仍适用。[当前组件发布版](https://github.com/tao12345666333/amp-acp/releases/tag/v0.13.0) · [官方模型说明](https://ampcode.com/docs/model-selector#switch-models-in-a-thread)

## Devin 普通新建的旧设置恢复

原正式版从「探索 Agent → Devin → 开始新对话」保留测试文字，选择独立空目录。新建使用已保存的 `swe-2-high`、`high` 和 Code，提示「已保存的选择当前不可用」，发送禁用，零模型请求。

通过正常退出安装新的唯一正式应用 0.1.7 arm64，CDHash `7aefe7b0116d761bf7dcfcbed3ab392e0bd4aadd`。原草稿和目录仍在。从相同入口看到相同拦截，点「检查模型设置」。表格同时核对原模型和推理等级：`swe-2-high` 对应当前 `SWE-2 Flash Medium`，旧 `high` 对应「未提供选项」。清楚标明仅用于这份草稿，已有服务和 Code 匹配。明确点「沿用当前设置 → 用这些设置返回草稿」，原文字、目录和新选项读回，确认前零真实请求。

从同一草稿手动发一条短问，约 2.52 秒准确收到 `FF_C12_DEVIN_DRAFT_REPAIR_OK`，无工具和审批。读取用的 `protocol-v1-1794835755582-1.jsonl` 零发送，`protocol-v1-1794835730412-0.jsonl` 恰有一次 `session/prompt`。该目录仅一条本机索引，原标识 `grave-newt`，保存已有服务、`swe-2-flash-medium`，无已确认的推理等级。Agent 全局保存记录 `agentSetup.v1` 变更前后字节摘要相同，Devin 的原默认选择保持，既有历史索引和旧工作位置未确认记录保留。

工程验证含 212 项相关前端测试、786 文件 10,959 项全量前端测试，格式、类型、前端生产构建与正式应用打包通过。Rust 格式、Clippy 与测试通过，共 2,805 项成功、11 项既有忽略。正式实测覆盖原已有服务，托管服务的等效恢复及切换所有者的保护以本轮受控检查为限。

## 工程与安装

正式版 0.1.7 arm64，CDHash `463a103256d1d42addd5f74e01b2e772427b40b6`。候选固定 2,633 项输入，生产构建与打包通过。四个关联前端测试文件 122 项通过，文档仍保持 151 条原条件。安装比对 236,586 项保护记录摘要一致，元数据副本完整，重复产物已移除。

用户反馈 Farfold 的 Amp 适配器独立密钥终端登录失败。已区分当前界面的「Amp API Key Setup」与原厂商 CLI 的 `amp login`，已告知该已安装 CLI 的官方登录方式。用户选择在 MiniMax 官方配置添加小米，待有效配置读回后单独验新对话。Gemini CLI 和 Antigravity 保持暂缓。 [本轮验收表](../2026-11-15-cycle12-continuation/acceptance-roster.json)
