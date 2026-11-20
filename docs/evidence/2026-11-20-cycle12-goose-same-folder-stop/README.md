# 第 12 周期 Goose 同一工作文件夹的双任务停止

2026-11-20，北京时间。macOS arm64 正式 Farfold `72e971df5`（0.1.7），主进程 `58970`，CDHash `5bf21663b6f7caa4e341c9ebc4476d60bb4e299c`。Goose `1.59.1`。从之前自有对话的「用相同设置再开一段」进入两次，先正常保留已有 Amp 草稿。分别选择同一独立目录 `/private/tmp/ff-c12-n20-gap-followup-80hlt28e/goose-same`，两条草稿均确认选中 Nemotron 3.5 Super VL (free) / Off。Goose 原会话记录确认 OpenRouter 和 `nvidia/nemotron-3.5-super-vl:free` 两次相同，未换账号或服务。[上一批原配置和用量证据](../2026-11-20-cycle12-goose-queue-recheck/README.md)

## 两条任务与单独停止

13:50:23.984 在 A 只发送一条自有请求，原对话 `20261120_2`。原工具只调用 `/bin/sh ./task-a.sh`，`timeout_secs=200`，原 Shell `62087` 和 sleep `62090` 实际运行。13:51:01.504 在 B 只发送一条，原对话 `20261120_4`。原工具只调用 `/bin/sh ./task-b.sh`，`timeout_secs=100`，原 Shell `62309` 和 sleep `62311` 实际运行。这一配置没有出现额外审批。两脚本均在同一所选目录，分别写自己的测试标记。A、B 读取同一目录，不争用同一个目标文件。

13:51:24.211 按 UID 501、精确 cwd、进程诞生时间、父子归属和命令确认四个工具进程都仍实际运行。A 原 Goose 连接 `61871`，进程组 `62087` 包含 A 的 Shell 与 sleep。B 原连接 `62294`，进程组 `62309` 包含 B 的 Shell 与 sleep。两条连接都为正式 Farfold 的直接子进程。界面同时显示两条进行中。

13:51:34.003 从原 A 界面点一次「停止」。A 显示「回复已停止，仍有步骤未确认结束」及「步骤结果未知」。B 仍显示进行中。13:51:45.143 独立查证 A 原 Shell 和 sleep 已退出，没有写出 `task-a.result.txt`。B 的原 Shell/sleep PID、父进程、组及诞生时间保持，当时仍运行。13:51:53.341 B 写出原 `task-b.result.txt`，预期整文件 29 字节 `FF_C12_GOOSE_SAME_B_19FDBAC2` 加终止换行。原 B 工具进程自然退出。13:52:08.797 在原 B 对话看到准确同一答复和「已完成」。

本机 Goose 原存储中，A 原工具 `call-0309b7aa-82a9-498a-b141-20fb5f369577` 的回执 `isError=true`，文本为 `Tool call was interrupted before completing`。同一原工具在 Farfold 仍显示结果未知。B 原工具 `call-df4443c3-7abf-4a40-923c-547585cbb4a0` 回执 `isError=false`，文本命中预期，下一条原助手回复相同。本批覆盖同目录两条前台工作互不串扰、A 的实际停止及 B 的自然交付。未重启、续答、发第三条或重复触发旧断线情形。中断工具状态正式显示仍待确切官方回传。

| 证据                                        | 确认范围                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol-v1-1795153801475-9.jsonl`         | 前 52 行 SHA-256 `8405beeab994f736c3b4035b70fc3298e91ebb2756f49622f60ab3b50934e692`。第 16 行唯一 A，48 行唯一 `session/cancel`，52 行原请求结束回应。                                                       |
| `protocol-v1-1795153847465-11.jsonl`        | 前 73 行 SHA-256 `6d4fd751cacee221f62ba46cc4331773cf1527514089e170a43c3f5df27b9703`。第 16 行唯一 B，73 行完成，零停止。同期有一条只读取模型的临时准备对话，零发送。                                         |
| `~/.local/share/goose/sessions/sessions.db` | A 第 395 行用户请求、397 工具、401 失败回执。B 第 398 行用户请求、400 工具、402 成功回执、403 实际助手回复。两条各只一次 shell 工具。                                                                        |
| 本机进程原件                                | `goose-same-live.json` SHA-256 `51ef49ff7649f9b6d9f077990a7844fe9ad72d92a47bbc7ca14b85d727d9f7f5`，`goose-same-after-stop.json` SHA-256 `700d8d736a8ea360883dff42e6b5e1e7a464f2362b379b5870ff14c1cb73fb6e`。 |
| B 成品                                      | `task-b.result.txt` SHA-256 `03e86c2c6c623b5d39211d5aa22a497f0d1f124f3d47e4f0c7a05d51e3fbfbc1`，无 A 成品。                                                                                                  |
