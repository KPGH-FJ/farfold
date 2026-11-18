# 第 12 周期模型续答、Mistral 停止与 siGit 范围

2026-11-17，macOS arm64。用户允许 CodeBuddy 用 `Hy4 / On` 单独实测，确认旧 MiniMax M2.7 无额度，要求用现有小米 MiMo 先做首答再按配置续答，并授权继续 Mistral Vibe 的实际验收。新测试使用自建目录和合成验收标记。首答和停止验证使用正式版 `9d43e7f89`，冷开及目录复验使用新安装的 `3077ce884`。

## CodeBuddy、MiniMax 实答

- **CodeBuddy**。正常新对话先复现旧选择 `hy4-preview-f / High` 不可用。从「去设置」确认本次草稿采用已报告的 `Hy4 / On (default)`，沿用已有服务。`01a1e738-a4f4-77a3-aa61-7306aa583f3e` 持久化为模型 `hy4std`。单次文本请求精确返回 `FF_C12_CODEBUDDY_HY4_20261117`，界面显示已完成。诊断 `protocol-v1-1794880610761-4.jsonl` 有一次新建、一次发送，无工具审批。认证身份、原旧对话的正文及续答仍待。选项应用范围为本次草稿。
- **MiniMax Code**。独立新对话从已有设置选择 `mimo-v2.6-flash`，以 `m:custom_provider%3Axiaomi:mimo-v2.6-flash:v:` 保存，首答精确返回 `FF_C12_MIMO_COLD_RESUME_20261117`，界面显示已完成。新版正式应用从侧栏冷开，显示相同测试目录、原正文、沿用已有设置及原 MiMo。只手动发一条未包含标记的原上下文追问，精确返回首条标记并完成。同一原标识 `mvs_321d563cabff4378ae25b0a0d82acc1b` 及已保存模型读回。首发诊断 `protocol-v1-1794880762084-7.jsonl` 是一次新建、一次发送。冷开 `protocol-v1-1794881679856-0.jsonl` 是一次加载、一次发送、零新建及零审批。其他历史的原服务、计费以及旧 M2.7 的原配置续答仍待。后台停止保持原失败记录。

## Mistral Vibe 实际停止、隔离与冷开

从 Farfold 各选独立测试目录，沿用已有设置，所选模型为 Mistral Medium 3.5（`mistral-medium-3.5`，选项同时显示官方别名 `mistral-vibe-cli-latest`），思考 High。两条消息唯一请求运行 `/bin/sh ./ff-owned-foreground.sh`，自建脚本只等待并写验收文件。两个批准卡均提示 Agent 未提供输入详情。展开各自同一时刻唯一在处理的步骤，核实准确命令及对应工作位置，各按一次 Allow once。该审批卡的输入展示缺口仍在。

停止前 10:05:54 核到 A 的 Shell 12208 与其 sleep 子进程 12210，B 的 Shell 12211 与其 sleep 子进程 12213。两者工作目录、启动时刻、父子关系和进程组各自匹配。仅按 A 的「停止」。10:06:14 后查 A 两个原进程均退出，未写完成标记。B 两个原进程仍在同一原目录和进程组，最终写出 `FF_C12_MISTRAL_STOP_B_20261117_COMPLETED`，界面显示已完成。A 的 `protocol-v1-1794880921528-9.jsonl` 有一次发送、一次审批请求、一次取消。B 的 `protocol-v1-1794880982579-10.jsonl` 有一次发送、一次审批请求、零取消。未使用外部进程信号。

更新后从侧栏冷开已停止的 A，原标识 `19318515-52d4-5784-4ac2-b11b84138596`、目录、正文、已有服务和 Medium 3.5 / High 均保持，旧命令步骤显示未成功。只手动发送一条不含标记的原上下文追问，准确回复 `FF_C12_MISTRAL_ISOLATION_A_20261117` 并显示已完成。诊断 `protocol-v1-1794881766576-1.jsonl` 有一次加载、一次手动发送、零新建、零审批，未重跑原脚本。B 标识仍为 `59da7902-8ba0-a439-f271-9c0e4d9d1be9`。本次覆盖两条前台命令、单条实际停止、另一条隔离完成，以及停后保持原模型的冷开续答。后台任务、断线未知和其他工具条件仍待。

## Claude Code 与小米 Messages

现有正式证据中，小米 `mimo-v2.6-flash` 在 Farfold 的独立 Messages 测试实答。正式 Claude Code 普通对话返回 `auth_required`。在合成服务上，所测官方适配器向流式 Messages 请求传的是占位 Bearer。真实小米请求未记录 HTTP 状态，支持继续查凭据交接，不能据此定性模型不兼容。小米有原生 Claude Code 配置。2026-11-17 复核公开代码，0.107.3 与既测 0.107.0 的 `src/providers.ts` 字节一致，Anthropic 分支仍设置占位 `ANTHROPIC_AUTH_TOKEN`，未安装该新版或使用真实 Key 重试。 [原正式结果](../2026-11-15-cycle12-pre-send/README.md) · [小米官方配置](https://mimo.mi.com/docs/zh-CN/tokenplan/integration/claudecode) · [0.107.3 官方实现](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.3/src/providers.ts#L171-L176) · [发布记录](https://github.com/agentclientprotocol/claude-agent-acp/releases/tag/v0.107.3)

## 正式安装与 21 家目录

正式安装源码 `3077ce884`，0.1.7 arm64，CDHash `7681fad3c738b873628c7caa4d1df018976c3f9b`，可执行文件 SHA-256 `2f0088a2a6a945858f634a1eb76023ff0bf5aca8130f8a70bff6cd937a1942b9`。正常保存并退出，在关闭态比对应用数据、WebKit 和应用缓存共 247,491 项的路径、类型和字节摘要，前后一致。SQLite 及 WAL 的隔离副本前后完整性通过。严格签名校验通过，构建目录重复应用已移除。正式侧栏显示 21 家，在探索及新对话选择搜索 siGit 都无匹配。只读核对 `registry:sigit` 登记仍存在。 [目录范围与接入结论](../2026-11-17-cycle12-retire-sigit/README.md)

全量前端 786 个文件 10,971 项通过。Rust 全量发布配置 2,805 项通过，11 项既有忽略。格式、类型、Clippy、生产前端及内部打包通过。21 家整家八项仍为 0/21。

11 月 18 日补核 CodeBuddy 自有短问：Hy4 / On 是界面与保存选择，原请求实际为 Hy4 Flash Free。短问的准确实答证据保持。 [模型复核](../2026-11-18-cycle12-codebuddy-stop-display/README.md#模型显示与实际请求不一致)
