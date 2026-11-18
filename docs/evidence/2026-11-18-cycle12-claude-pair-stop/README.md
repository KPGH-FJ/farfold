# 第 12 周期 Claude 双前台隔离与实际停止

2026-11-18，macOS arm64，正式 Farfold `98d365c08`（0.1.7，CDHash `a373426cac1c3553e6b772ffaf423f1bed7303c6`），Claude Agent ACP 0.107.0，Claude Code 2.1.323。两条新对话在各自的自有目录 `/private/tmp/ff-c12-claude-pair-n18.rtw9bzkt/{a,b}`。模型与来源均为「已有设置」，所选 Haiku 别名为 `mimo-v2.6-flash`。两条原 Bash 调用的模型字段也均为 `mimo-v2.6-flash`。 [先前 MiMo 首答及续答](../2026-11-18-cycle12-claude-mimo/README.md)

## 双任务与停止

各手动发送一条指令，在各自待确认卡核明命令 `/bin/sh ./task.sh`，只选单次「批准」。脚本用 Shell 启动一个 `/bin/sleep` 子进程，将父子 PID 写到本目录的 `started.txt`，等待自然完成后才写 `result.txt` 并打印该任务自己的标记。A 与 B 分别等待 85 秒、62 秒。

| 样本 | Claude 原对话及 Bash 工具 ID                                            | 点停前进程与结果                                           |
| ---- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| A    | `a0557613-06b5-4ee9-8a18-53b50be9e58f`，`call_7a90da4574a84f8ba914939d` | 18:33:21 Shell 10143 和子进程 10144 同时存在，进程组 10142 |
| B    | `7040ca23-7982-4a71-ad08-079c8f4fa53c`，`call_d8ebfd3ab6bd4912a82ceaaa` | 18:33:27 Shell 10375 和子进程 10376 同时存在，进程组 10374 |

实际点停前用 `ps` 核对两组的原开始时间、父子关系及进程组，再用 `lsof` 核对两组都在各自原目录。此时两边均无结果文件，Farfold 同时显示两条进行中。18:33:43.695 仅在 A 点击「停止」。18:33:44.036 的观察已找不到 A 两个原进程，Farfold 显示「回复已停止」，A 最终没有结果文件。期间没有用系统命令发停止信号。

B 原 Shell 及子进程在点停后保持同一 PID、父子关系、开始时间与进程组。18:34:29 自然退出并写出 31 字节的 `FF_C12_CLAUDE_MIMO_PAIR_B_DONE\n`，SHA-256 为 `9660344dc40b63eb6c1cd60aca9ae9965fd06997d295da5ed9a8768e26df835a`。原 Bash 工具结果和助手回复都含准确标记，Farfold 显示已完成。

## 原请求与结束状态

两条协议原件 `protocol-v1-1794997906915-1.jsonl` 和 `protocol-v1-1794997940302-2.jsonl` 各有一次新建、一次手动发送和一次真实权限请求。A 有一次取消，B 零取消。Claude Code 原记录在 18:33:43.819 对 A 的同一 Bash 工具保存 `is_error: true`，使用通用的操作被拒措辞，未提供实际信号或退出码。此前明确批准及系统进程快照独立保留。Farfold 的处理过程显示有一步未成功。B 对其原工具保存成功及实际标记。工具状态、实际进程退出和成品三个依据独立核对。

小米同一脱敏 Key 的 `mimo-v2.6-flash` 在线记录，发送前为 4 次、37,952 Token、用量金额 ¥0.012435，18:35:11 核对为 8 次、64,547 Token、¥0.035576。增量为 4 次推理、26,595 Token、¥0.023141。另一脱敏 Key 的同模型记录保持 38 次。日用量只给合计，Farfold 侧两条手动发送由各自协议原件核实。 [小米日用量口径](https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get)

本批覆盖前台命令的单次批准、双任务隔离、实际停止与自然交付。后台任务、其他工具类型、草稿及待发恢复仍按原项核验。

## 被停止的 A 冷开续答

19:42 正常保存后退出，确认 Farfold 的原进程已结束。重新启动同一正式应用，从「搜索对话」精确打开 A。原指令与一条未成功的工具步骤显示在历史中，恢复后的对话为「未在运行」。模型仍显示「沿用已有设置」与 `mimo-v2.6-flash (haiku)`。Farfold 的唯一索引和 Claude Code 的唯一原记录均为 `a0557613-06b5-4ee9-8a18-53b50be9e58f`，工作目录、创建时间和标识前后相同。

19:43:22 只手动发送一条不含原标记或原命令的续问。19:43:27，助手从旧上下文准确写出 `FF_C12_CLAUDE_MIMO_PAIR_A`、`/bin/sh ./task.sh` 和新的验收标记 `FF_C12_CLAUDE_MIMO_STOP_RESUME_1943`，各占一行。原 Claude Code 记录的响应模型为 `mimo-v2.6-flash`，Farfold 显示「已完成」。

A 对应协议 `protocol-v1-1795002170981-0.jsonl` 记录一次 `session/load`、一次手动 `session/prompt`、零 `session/new`、零权限请求及零新取消。重开前、手动发送前、发送后，原记录均只含原先的一次 Bash 调用及一次对应结果。原 `task.sh` 和 `started.txt` 的字节摘要与修改时间保持，A 没有 `result.txt`。这证明本条重开和续答均未重跑原任务。

小米同一脱敏 Key 的当日 `mimo-v2.6-flash` 在线记录从 19:42:05 的 10 次、89,613 Token、¥0.036822，变为 19:45:30 的 12 次、115,352 Token、¥0.038739。另一个脱敏 Key 在两次查询间保持 38 次。此次对账增量为 2 次推理、25,739 Token、用量金额 ¥0.001917，第二次推理的用途未单独核实。 [小米日用量口径](https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get)

## B 冷开取回结果

同次重启后，从侧栏只读打开原 B，读取成功工具步骤、命令 `/bin/sh ./task.sh` 与原完成标记。冷开的「文件与输出」报告 0 个文件位置。通过「打开文件」从原目录手动选取 `result.txt`，Farfold 预览显示同一完成标记，磁盘 31 字节及 SHA-256 与上一批一致。B 的协议 `protocol-v1-1795002259433-1.jsonl` 为一次加载、零新建、零发送。

运行结束时看到了「本轮产物 1」。该计数也包含命令输出，当时未展开列表核文件位置。这次恢复了 Bash 的文本输出，原工具详情未给出文件直达入口。Claude 官方的文件变更报告范围不含 Bash，自动关联仍需原回放中的结构化文件位置或原对话报告的文件链接。[产物计数](../../../src/runtime/reported_artifacts.ts) · [Claude 官方报告范围](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.0/docs/air-extensions.md#agent-file-change-report)

## B 通过官方 Read 冷开直达同一成品

原 Bash 工具 `call_d8ebfd3ab6bd4912a82ceaaa` 保存了 `command`、`timeout` 和对应成功结果，stdout 只有完成标记，结果没有 `result.txt` 的精确位置。所用 0.107.0 的 Bash 回放由官方报告器提供命令、输出和结果。对照 0.108.0，新版补了前台 Bash 输出流，仍无成品位置。官方 Read 则报告工具的原路径和行号，Farfold 已支持通过该位置按钮预览文件。[Bash 实现](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.0/src/tool-calls/reporters/bash.ts#L16-L84) · [0.108.0 发布说明](https://github.com/agentclientprotocol/claude-agent-acp/releases/tag/v0.108.0) · [Read 实现](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.0/src/tool-calls/reporters/read.ts#L16-L35) · [Farfold 工具位置](../../../src/components/thread-items.tsx)

19:55:11 从正式 Farfold 的同一 B（原 ID `7040ca23-7982-4a71-ad08-079c8f4fa53c`，已有小米设置）发送一条只读指令。19:55:17 Claude Code 的官方 Read `call_3e87eee110be4a6794d7e2f2` 只读取原 B 目录的 `result.txt`。工具结果及 19:55:19 助手回复均为预期完成标记，服务响应为 `mimo-v2.6-flash`。协议 `protocol-v1-1795002259433-1.jsonl` 在本批窗口内为一次手动发送，零新建、零权限请求。原 Bash 调用仍只有一次。

19:56 正常退出并确认原进程停止，重启同一正式版。侧栏打开同一 B，从新的 Read 历史工具步骤点绝对路径按钮，直接预览同一 `result.txt`。界面读到准确标记和另存入口。原 Bash 历史步骤仍只呈现命令结果。冷开协议 `protocol-v1-1795002984619-0.jsonl` 为一次加载、零新建、零发送。原对话 ID、创建时间、脚本、启动记录和 31 字节成品的修改时间、SHA-256 均与本批开始一致。本批沿用现有实现，无应用代码改动。

小米同一脱敏 Key 的 `mimo-v2.6-flash` 日用量由 19:54:40 的 12 次、115,352 Token、¥0.038739 变为 19:57:27 的 15 次、153,421 Token、¥0.040746，其他脱敏 Key 的同模型次数保持 46。此次仅有一条用户消息，日用量聚合了该工具交互窗口的 3 次推理。[小米日用量口径](https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get)

现有工具文件位置、成果来源和产物计数的三个定向测试文件共 37 项通过。该工程检查与实际冷开记录分别核对。
