# 第 12 周期 Kilo 停止后的步骤显示

2026-11-18，macOS arm64。正式 Farfold 0.1.7 源码基线 `98d365c08`，CDHash `a373426cac1c3553e6b772ffaf423f1bed7303c6`，可执行文件 SHA-256 `749040dacd7f55051eec89b9184449d6c4ca6832cfe78621d5f4480921545a56`。旧 A 原目录已不存在。本次从正常新对话在独立自建目录 `/private/tmp/ff-c12-kilo-stop-display-o2ru79sk`，沿原 Kilo 7.8.1 的 Kilo Gateway 免费 Nemotron 3 Ultra / None。新草稿自动应用已保存的选择一次。只发一条，并单次批准 `/bin/sh ./task.sh`。Kilo 保存的请求模型为 `kilo/nvidia/nemotron-3-ultra-550b-a55b:free`、`none`。 [旧 A 的原工具结果](../2026-11-18-cycle12-kilo-stop-receipt/README.md) · [正式应用基线](../2026-11-18-cycle12-s1-preparation/README.md)

## 真实停止和冷开

- 自建脚本的等待时长为 75 秒。20:38:47.564 观察到 Shell 23228 和 sleep 23229 同属进程组 23228，sleep 的父进程为 23228。20:39:04.565 只点此对话的「停止」。20:39:04.745 两个原进程均已退出，只比点击晚 180 毫秒。其后超过原定自然结束时间仍无完成标记。未从外部发送停止信号。时间均为 UTC+8。
- 实时界面显示「回复已停止」。展开这一条「查看处理过程」，Bash 仍显示勾号和「执行 · 步骤已结束」，没有给该步骤显示中止。再展开「技术详情」，原工具结果中的 `User aborted the command` 才可见。
- 正常保存退出并重开正式应用后，从侧栏打开同一条，标题和目录匹配，Farfold 的索引仅有一个原会话 `ses_e1156951bffe0bWPczCR2k6T4V`。冷开显示「未在运行」和历史消息，实时的「回复已停止」提示未出现。处理过程内仍是同一条 Bash 的勾号与「执行 · 步骤已结束」，技术详情仍保留中止原文。协议只记录一次 `session/load`、零新建、零发送、零审批。Kilo 存储始终只有该样本的一条用户消息和一个 Bash 工具记录，两份进程文件保持原 PID 与首次写入时间，未重跑。

## 原工具与协议映射

Kilo 保存的原工具为 `call-4179a208-31b9-473b-96f9-40e789b97176`。同一条记录显示 `status: completed`、`metadata.exit: null`，输出 `<shell_metadata>` 内有 `User aborted the command`。工具记录没有独立的结构化中止字段。同一工具所关联的助手消息有 `MessageAbortedError`，该字段属于原消息。

Kilo 7.8.1 的实时处理把原工具 ID 和 `completed` 传给 ACP，`rawOutput` 保留输出文本与工具元数据。冷加载同一会话的消息并把存储的工具部分交给同一个处理函数，因此会保留原工具 ID、状态和结果。历史工具映射未将助手消息的 `MessageAbortedError` 转为单独的工具状态。当前可核的 `exit: null` 缺少退出码，仍需可归属的结构化中止信号来区分原因。 [实时分支](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/opencode/src/acp/event.ts#L344-L385) · [工具状态及原输出](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/opencode/src/acp/tool.ts#L186-L235) · [加载与回放](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/opencode/src/acp/service.ts#L213-L246) · [同一工具映射](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/opencode/src/acp/event.ts#L127-L139)

Farfold 保留收到的工具状态与原输出，步骤显示由收到的状态决定。真实停止有证，步骤摘要仍缺能直接看懂的中止结果，实时和冷开都复现。此次只记录实测和原因，零代码及账号配置改动。 [状态投影](../../../src/runtime/session_projection.ts#L463-L477) · [步骤呈现](../../../src/components/thread-items.tsx#L440-L457)

## 原件定位

| 原件                                                       | 位置                                                                                               | SHA-256                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/private/tmp/ff-c12-kilo-stop-display-o2ru79sk/task.sh`   | 自建命令                                                                                           | `0631fe1f94e68a58a850c9ceb8f3db457458e45dc25b23b21d7bff27bbf78867` |
| `~/.local/share/kilo/kilo.db`                              | 原工具记录 `prt_1eeaa727a001u9vVeDMfx70Z64` 的原 JSON                                              | `eea022e11c3f353352903255e18191d8abf12ce9a5f802de190291eddb8be3a9` |
| `~/.local/share/kilo/kilo.db`                              | 原助手消息 `msg_1eeaa5ea50011jV324775YL2wW` 的原 JSON，关联原请求 `msg_1eeaa5e81001DooxeqToVGRBDX` | `6b3f2830aca63314d5b251d0b4eda13a34e66a1ed28d6403578438a61693c068` |
| `~/Library/Logs/Farfold/protocol-v1-1795005427336-2.jsonl` | 实时，第 8、13、16、17、20、21、23 行                                                              | `ec6958654471198ee3cf75be86e41afbc88770805751edd26f7be269810139e4` |
| `~/Library/Logs/Farfold/protocol-v1-1795005663235-0.jsonl` | 冷开，第 8、10–12 行                                                                               | `dfa9fedac4801864267357927eb3450dac91be5f161c0c8353119a5c04ad019a` |
