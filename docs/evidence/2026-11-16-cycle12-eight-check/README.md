# 第 12 周期八项验收续查

2026-11-16，macOS。当前首发 22 家、176 个验收格。Gemini CLI 和 Antigravity 按用户要求暂缓，本次不启动或请求两家服务。当前八项逐家结果见[唯一验收表](../2026-11-15-cycle12-continuation/acceptance-roster.json)。

## Autohand 前台停止

正式 Farfold 0.1.7，Autohand 0.9.11。两条真实对话在两个自建文件夹沿用已有服务和 Fantail，各单次授权 `/bin/sh ./wait-owned.sh`。A 与 B 各有 Shell 和 sleep 子进程同时运行，进程组独立。只点 A 的「停止」，回复停止、两个处理步骤标为结果未知。约 9.5 秒后 A 的 Shell 已退出，但它的 sleep 仍活跃并由 PID 1 接管。B 的原 Shell 和 sleep 当时仍运行，随后自然写出 B 的正确标记，Farfold 收到该标记并显示 B 已完成。A 没有写出完成标记，测试子进程随后到期自然退出。仅本轮各一条请求，未发送其他停止信号。

官方适配器收到 ACP 取消后触发原请求的 AbortSignal。同版本前台命令路径未在该调用中单独创建命令进程组，取消只终止直接子进程。已核的稳定发行仍为 0.9.11，正向停止须等官方前台终止覆盖子进程。SDK 的进程树终止只管理由 SDK 自己启动的进程。Farfold 的原请求未知保护保留，未改用自动关闭整条连接。[取消入口](https://github.com/autohandai/code-cli/blob/v0.9.11/src/modes/acp/adapter.ts#L1089-L1099) · [命令停止实现](https://github.com/autohandai/code-cli/blob/v0.9.11/src/actions/command.ts#L320-L345) · [官方 SDK](https://github.com/autohandai/code-agent-sdk-rust/blob/main/docs/API_REFERENCE.md#run)

## 外部条件与不能合并的结果

- **Amp** 原登记适配器 0.9.0，正式程序检查的 Amp CLI 已就绪，实际同一路径官方程序版本为 0.0.1790740844-g023754。已有设置读到 Medium，零模型请求。厂商 CLI 的 `account list` 返回无保存账号，同一程序一次只读线程列表因需认证退出。目录适配器单独管理的旧密钥与厂商 CLI 登录不是同一身份。用户需先恢复原厂商账号，之后核原 T-ID 线程。目录可用的 0.13.0 有适配器自己的 S-ID 映射，不能直接代替原厂商线程。云端与工具实际停止仍待确切原请求回执。[官方账号](https://ampcode.com/docs/cli#manage-cli-accounts) · [原线程导出](https://ampcode.com/docs/threads#export-a-thread) · [目录适配器 0.13.0](https://github.com/tao12345666333/amp-acp/releases/tag/v0.13.0)
- **MiniMax** 原正文和 M2.7 已冷开，当前 M2.7 官方返回 50110 余额或额度不足，原账号未能确认，新服务不能作为原对话续答。需确认中国区原账号与可用额度。已核同版官方第三方入口，可验另一条独立新对话。[原对话](../2026-11-16-cycle12-original-config/README.md) · [额度回执](../2026-11-16-cycle12-qwen-exit/README.md) · [第三方 API](../2026-11-16-cycle12-service-diagnosis/README.md#minimax-外部-api)
- **Claude** 托管 Messages 继续暂停。重新核对适配器 0.107.0、其官方 SDK 0.3.323 与较新的官方预览包，托管认证设置会进入子进程参数；原小米兼容请求还有认证头占位问题。宿主环境的官方入口可以交付环境变量，但该适配器读回父进程配置，不能核实实际生效的独立来源。可独立验用户选定的 Claude 订阅或 Anthropic Console 官方登录，现有 API 配置原样保留。[原暂停依据](../2026-11-16-cycle12-original-config/README.md#claude-环境核对) · [官方宿主环境](https://code.claude.com/docs/en/env-vars#provider-routing)
- **Pi** 当前目录适配器 0.0.34 接收网页工具配置但未传给运行中的 Pi。上游两个提案仍未发版，已验证的官方 SDK 1.5.2 能注册会话内工具，未在正式版接线。替代入口须保持原会话所有权、只读预览、已保存配置、审批与撤回，并证明助手进程身份。没有变更共享网页授权规则。[SDK 回执](../2026-11-15-official-alternatives/pi.md) · [官方适配器提案](https://github.com/svkozak/pi-acp/pull/164) · [另一提案](https://github.com/svkozak/pi-acp/pull/145)
- **siGit** 同版 1.5.11 在 ACP 中已明确支持 OpenAI 兼容环境或官方配置。界面报告本地 Onde 的就绪早于模型实际加载，进程级覆盖也可能保留本地模型名。先核定本地来源与缓存。当前无需用户先提供 Key。 [同版官方实现](https://github.com/getsigit/sigit/blob/v1.5.11/src/main.rs#L4250-L4312)

## Cline 文件交付

正式 Cline 3.0.74 在普通新对话沿已有服务和免费 Nemotron 3.5 Super VL。仅发送一次，先核这一个 `notes.md` 读取，后批准指定路径的 `result.md` 写入各一次。成品两节及负责人、日期与原稿核对正确，原文件摘要相同，在 Farfold 对话内容的「打开文件…」选择副本后完整预览。Cline 本轮没有提供可归属的结构化写入位置、差异或资源，未自动出现本轮成品入口。其 ACP 收尾只带状态和 rawOutput，工具后置钩子可替换原结果。待厂商提供同一实际写入的结构化回执，现有查看入口仍可用。[Cline ACP 更新](https://github.com/cline/cline/blob/cli-v3.0.74/apps/cli/src/acp/session-updates.ts#L137-L147) · [结果处理](https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/agents/src/agent-runtime.ts#L2621-L2677)

## Qoder 新对话与文件交付

本机 Qoder CLI 1.1.89 的正常新对话完成握手和打开，Farfold 记住的 `qfmodel` 未被当前程序提供，提示设置未确认，零发送。新版本允许从原模型选择器直接点「检查模型设置」。实际读回用户经 Qoder 官方 Custom 配好的 `mimo-v2.6-flash`。正式界面显示旧值和新值，已有服务及 Default 一致。手动采用当前配置，将 Farfold 的新对话默认选择从旧值更新为这条已配置的小米模型。回到原草稿，未发验收文字仍可见。

同目录普通新对话重新核对使用小米和 Default，只发一条。批准新副本 `result.md` 的写入一次，界面完成。打开「本轮产物」并选择该文件，核对分类、负责人和日期，原样本字节保持。[正式回执](results.json)

## 工程与安装

正式版 0.1.7 arm64，CDHash `463a103256d1d42addd5f74e01b2e772427b40b6`。候选固定 2,633 项输入，生产构建与打包通过。四个关联前端测试文件 122 项通过，文档仍保持 151 条原条件。安装比对 236,586 项保护记录摘要一致，元数据副本完整，重复产物已移除。

用户反馈 Farfold 的 Amp 适配器独立密钥终端登录失败。已区分当前界面的「Amp API Key Setup」与原厂商 CLI 的 `amp login`，已告知该已安装 CLI 的官方登录方式。用户选择在 MiniMax 官方配置添加小米，待有效配置读回后单独验新对话。Gemini CLI 和 Antigravity 保持暂缓。 [本轮验收表](../2026-11-15-cycle12-continuation/acceptance-roster.json)
