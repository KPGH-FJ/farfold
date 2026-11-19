# 第 12 周期后台任务停止

2026-11-19，macOS arm64 正式 Farfold 0.1.7，源码 `5e12e06d9`，CDHash `4e5bba7028bdabce14eb3dd531844654e8b611ce`，可执行文件 SHA-256 `7619c1eeb923c17b0051bec76dcd810ce5cfeb6187d5a7ffa892776230572232`。两个正式样本分别从正常新对话进入自建目录 `/private/tmp/ff-c12-n19-verify.o6X6wIFJ/{opencode-bg,claude-bg}`，各手动发送一次。两边的脚本都记录本次 Shell 和 `/bin/sleep` 的 PID，等待子进程自然结束后才写各自的 `background-natural.txt`。时间均为 UTC+8。

## OpenCode 回复停止后，原后台命令继续运行

OpenCode 原登记程序握手 2.2.7。沿用 Farfold 已保存的小米 Chat Completions、`mimo-v2.6-flash`、Build。原对话 `ses_e0deee0dbffeBkD93o0dogqk4Q`。在同一条实际回复中，官方 `shell` 工具 `call_75415031c3444e1480e47762` 以 `background: true` 执行 `/bin/sh ./background.sh`。厂商原消息序号 5 报告 `shellID` 为 `sh_1f21170fe001vD8zAaxUI5K1PB`、后台结果 `running`；同一厂商任务表亦记录该原会话、同 ID 的 Shell `running`。该步完成只表示工具已经把命令交给后台。12:29:51.757 的本机文件记录 Shell 36268、同组子进程 36269，进程组 36268。

12:30:15.471 原回复的官方 `question` 仍待响应时，从 Farfold 只点一次普通「停止」。界面显示「回复已停止」，原问题未作回答。12:30:25.630 核到相同两个 PID 和相同任务仍运行。本机到 12:31:41.768 自然写出 `FF_C12_N19_OPENCODE_BG_NATURAL` 加一个 LF，共 31 字节，SHA-256 `7edca442acfe7ffde0b543114fb0e1361606530a020dac3ee1a584ae58584a40`。12:32:06.705 核两个原 PID 已退出，厂商任务表已无这条活动任务。原厂商会话在序号 28 收到后台自然结束的合成通知。Farfold 出站仍只有最初的一个 `session/prompt`，没有向该会话补发。

原诊断 `protocol-v1-1795062570374-19.jsonl` 第 8、11、47、48、49、52 行为本轮新建、唯一手动发出、问题到达、唯一取消、问题回执及原回复结束。52 行截取时 SHA-256 `962fc546e360d173246ea822dc163915492b8cbb410ab427a1354b1d97c5d537`。自建脚本和 PID 记录 SHA-256 分别为 `46b0752dc7694e67d044d9a945e1d18b2f72fd41eb26d017cc0d84cad3e26495`、`333645f55f3a13821a25bdd19b81eba94d65758d1ee722331e99f602cc9a1d10`。

该次普通停止实际结束了原回复，**未停止原后台 Shell**。官方 `session/cancel` 取消的是活动回复，后台 Shell 有自己的任务记录和停止入口。官方按 Shell ID 停止的原生 HTTP 服务由当前 ACP 程序独立启动并持有访问凭据，Farfold 正常入口目前没有可调用的同源精确后台停止通路。既有前台实际停止证据继续按原样本成立。 [官方后台 Shell](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/tool/plugin/shell.ts#L219-L247) · [普通取消](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/acp/turn.ts#L425-L435) · [精确 Shell 删除](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/protocol/src/groups/shell.ts#L71-L85) · [独立服务启动](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/cli/src/services/standalone.ts#L17-L55) · [既有前台证据](../2026-11-18-cycle12-opencode-paused-queue/README.md)

## Claude 主回复结束后，只停止原后台任务

Claude Agent ACP 0.107.0，Claude Code 2.1.323。沿用 Claude Code 已有小米 Messages 与 Haiku 别名，原生回复记录的实际模型为 `mimo-v2.6-flash`。原对话 `873e9b08-bb53-4e74-9f7d-eafb2cadc7ef`。厂商原记录第 22 行为 `Bash` 工具 `call_c353697f70184896b0d445d1`，参数 `run_in_background: true`。第 24 行结构化 `backgroundTaskId` 为 `bv4tprn1q`，对应命令 `/bin/sh ./background.sh`。本次无 `session/request_permission`，该步骤沿用原设置。

12:30:57.891 自建记录写入 Shell 36826、子进程 36827。12:31:04.815 主回复已结束，原生回复及正式界面均有 `FF_C12_N19_CLAUDE_BG_STARTED`。后台任务仍单独列出 `/bin/sh ./background.sh` 和「停止任务」。12:31:25.987 核两个原 PID 在该自建工作目录，属于进程组 36825。12:31:33.777 只点该任务的「停止任务」。界面出现「已停止」，12:31:41.219 两个原进程均已退出。原脚本自然结束时点约为 12:32:47.891，12:33:43.870 复查两个原 PID 均不存在，仍无目标文件。与此同时，前述 OpenCode 后台样本按原时限自行结束和交付。此分项覆盖 Claude 同一已结束回复之下的独立后台 Bash 停止及与另一 Agent 的隔离。

原诊断 `protocol-v1-1795062549362-17.jsonl` 第 8、26、51–53、67、70–73 行分别定位新建、唯一手动发送、后台报告窗口、主回复结束和独立停止请求、更新及结果。停止使用该适配器的 `_session/async_task/stop`，协议诊断将其归到 `other`。全段无普通 `session/cancel`。74 行截取时 SHA-256 `064f2a69838ddaca5ac0e01422301f0ce304e0283cb749d1edfc59e893e97407`。同一厂商历史第 32 行写入该后台 ID 和相同 `tool_use_id` 的 `task-notification`，原状态为 `killed`。32 行截取时 SHA-256 `2fd62052f12af32bd8eb8ce2b5acfdb87221a9dcf563436c377494b6c7be30d3`。自建脚本和 PID 记录 SHA-256 分别为 `63e05cd2fb3e7f6ece7db854458b806fc33686264908f7e6b44878936c615192`、`93339461124ca872cceac28092d7bb7a35c48b79e4f431da49ddaf4c149fbb7b`。 [官方独立停止协议](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.0/docs/air-extensions.md#async-tasks) · [既有前台和待发证据](../2026-11-19-cycle12-claude-paused-queue/README.md)

## Goose 当前入口

本机 Goose 1.59.1 的当前登记参数是 `acp`。该版已移除背景子 Agent，普通取消只向准确会话的当前活动回复发取消信号。官方另有计划任务及其独立停止接口，普通登记未传入 `--enable-scheduler`。因此当前正式入口没有可定位并独立停止的官方后台任务。本批保留既有前台真实停止证据和当前后台能力缺口，未改变启动参数、启用计划任务或用 Shell `&` 模拟官方后台任务。 [后台子 Agent 变更](https://github.com/aaif-goose/goose/pull/12729) · [当前版启动选项](https://github.com/aaif-goose/goose/blob/v1.59.1/crates/goose-cli/src/cli.rs#L833-L848) · [当前版普通取消](https://github.com/aaif-goose/goose/blob/v1.59.1/crates/goose/src/acp/server.rs#L2367-L2383) · [既有前台证据](../2026-11-19-cycle12-goose-paused-queue/README.md)
