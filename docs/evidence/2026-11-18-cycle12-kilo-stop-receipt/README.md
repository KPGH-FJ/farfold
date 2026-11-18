# 第 12 周期 Kilo 双任务停止回执复核

2026-11-18 只读复核 Kilo 7.8.1 的两条自有前台任务。原正式 Farfold 沿用免费 Nemotron 3 Ultra / None，在两个独立目录各单次批准 `/bin/sh ./task.sh`。只点 A 停止，原实测确认 A 的 Shell 和 sleep 退出、无完成标记，B 的原进程继续并交付。以下时间为 UTC+8。 [原双任务、进程快照和冷续答](../2026-11-17-cycle12-four-agent-control/README.md)

## 原工具与结果

| 样本 | 原会话、请求和工具                                                                                                                                                                                                                      | Kilo 保存的结果                                                                                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | 会话 `ses_e17bb90cfffeMk7gkLNKrc7mii`，目录 `/private/tmp/ff-c12-kilo-isolation-a-84xb7smi`，原用户消息 `msg_1e84660260017EDs1fljvrJDHN`，助手消息 `msg_1e84678d2001GHjBvsa7rtkL8N`，Bash `call-f3d09f07-d4e1-4f2b-9648-6d9480bbdca3`。 | Farfold 于 14:56:52.867 发出停止，11 毫秒后 Kilo 写入原工具终态。该条的 `status` 是 `completed`，同时 `metadata.exit` 为 `null`，原工具结果报告 `User aborted the command`，同一原助手消息保存 `MessageAbortedError`。本条 `completed` 表示工具记录已收尾，实际结果为中止。 |
| B    | 会话 `ses_e17b8ff34ffe3FPlMMV2XhwDFf`，目录 `/private/tmp/ff-c12-kilo-isolation-b-p_g059r2`，原用户消息 `msg_1e848654f0012xwEG22n7naW29`，助手消息 `msg_1e8487ee2001i0w1rLlHP8Ine0`，Bash `call-254fb095-ebbc-45e7-b885-7706e6e7f584`。 | 14:57:33.247，Kilo 写入 `status: completed`、`metadata.exit: 0` 和 B 的准确完成标记。B 原连接零停止。                                                                                                                                                                       |

两条工具记录均通过原会话和消息 ID 连接到各自原请求，工具输入匹配原命令。从保留的 Farfold 诊断看，A 的停止后 23 毫秒有工具类更新，B 后续收到完成响应。A 冷开有一次加载、多条历史工具类更新及一次原计划的手动续问，零新建、零重发。诊断保存的是事件类别，A 实时与冷开时是否显示同一工具中止仍未核实。本次补证仅确认 Kilo 保存的原工具结果。

## 原件定位

以只读不可变模式查询 `~/.local/share/kilo/kilo.db` 已写入主库的两条原记录，仅按自有会话、消息及工具记录 ID 取值。查询期间主库、WAL 和 SHM 摘要保持一致。主库当时 SHA-256 为 `3a7c8ac99ea05fe7ebbf17572e47c90a9a1eae069f7293ac127d4b66ea5d8ca6`。本次零启动、零新会话、零工具执行、零模型请求，未更改 Agent、账号或配置。

| 原件                                                       | 位置                                                  | SHA-256                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| A 工具记录                                                 | `part.id=prt_1e8468029001bhKQmVYmvofBh0` 的原 JSON    | `abbd14815f6cdd9b2dd0cbbe66e09ea7ab9d30dcaafb11b5bedcf8d492de5a4c` |
| A 助手消息                                                 | `message.id=msg_1e84678d2001GHjBvsa7rtkL8N` 的原 JSON | `789f3ffba60209ded0134425e5bf2d1acf244b1e1e8c5b5e26f1fb42f1ac7c86` |
| B 工具记录                                                 | `part.id=prt_1e84887640010DM7syH5AvvwQe` 的原 JSON    | `a4ec2e6c49b3970155d544786fd883eb6f926ebf2ccc99ad4e36a9af3038631e` |
| B 助手消息                                                 | `message.id=msg_1e8487ee2001i0w1rLlHP8Ine0` 的原 JSON | `22313ce6895ba47286862daf1ace07a1c539e6d6be3631d47211a0f13e78bebd` |
| `~/Library/Logs/Farfold/protocol-v1-1794898154603-5.jsonl` | A 实时，第 13、26、29、32–35 行                       | `90f12dcaa695193230d757d8f02cf3fe8ad163ab8f8e7b6fdc78c8050ad6c8a4` |
| `~/Library/Logs/Farfold/protocol-v1-1794898324538-6.jsonl` | B 实时，第 13、25、28、31–33、49 行                   | `be7e942b0ae28694144082b0ac1897732c3fb6ee7751c645988d37e63fa7ea21` |
| `~/Library/Logs/Farfold/protocol-v1-1794901675291-0.jsonl` | A 冷开及手动续问，第 8、10–15、18 行                  | `bcdf0497506567478e1740543f142144febf04aab756e2dc541efc9045cc903d` |
