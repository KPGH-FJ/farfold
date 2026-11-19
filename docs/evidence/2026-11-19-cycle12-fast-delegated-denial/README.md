# 第 12 周期 fast-agent 拒绝 Farfold 执行命令

2026-11-19，macOS arm64，正式 `2a4ee8627`，原目录 fast-agent 0.10.1。正常新对话使用原有设置，厂商实际记录为 `codexresponses / gpt-5.6-sol`。自建工作目录 `/private/tmp/ff-c12-fast-local-deny.WTkDv0RI`，程序为 `/bin/sh`、唯一参数 `./task.sh`，脚本执行即可生成 `result.txt`。

1. 普通入口手动发送一次。展开 Agent 第一层「完整输入」，核实原程序及参数，点一次「批准 Allow Once」。
2. Farfold 独立执行卡列出实际程序、参数与原目录。只点一次「拒绝」。同轮显示「已批准 · Allow Once」和「已拒绝 · 已告知 Agent」，原步骤为「有步骤未成功」。界面没有命令退出回执。
3. 原终端创建以拒绝结束，未返回终端 ID。原工具收错误 `Terminal execution error: Request cancelled`。同一轮准确回复 `FF_C12_FAST_LOCAL_DENIED` 并显示「已完成」。零重试、零 `session/cancel`，`result.txt` 未出现。原脚本前后 SHA-256 `823ed053ce801b404f4231ccd96a87bc61575927da46247b3724f0098278d28f`，Agent 正常保存本轮会话。

Farfold `protocol-v1-1795022573535-2.jsonl` 第 11、17、19、21、22、23、33 行对应唯一发送、Agent 权限请求、单次批准、独立终端创建请求、拒绝、同工具更新、结束。33 行摘要 `4efbf54c8f83149c5507883fcf2011e936de3eaccd62c20ba02df35b32f213e1`。厂商原会话 `2611190122-yq2qR7` 的 `history_agent.json` 第 1–4 条为用户发送、唯一工具调用、同工具错误、精确回复。原件摘要 `32f869b57b4b8667f1041e539121730dd1aa45f9038a21432013dbefe41ef256`。

本批覆盖两个审批层独立生效，以及 Farfold 拒绝时原命令和实际退出回执均不会被误认。记住及撤回、Agent 自管和远端工具按原条件。 [双任务实停对照](../2026-11-19-cycle12-fast-terminal-exit/README.md)

## 同一拒绝记录从搜索重开

2026-11-19 16:01，北京时间。同一 fast-agent 0.10.1 自建对话 `2611190122-yq2qR7`，从正式 Farfold 0.1.7 `5e12e06d9` 的搜索入口打开。原用户正文和回复 `FF_C12_FAST_LOCAL_DENIED` 均可见。原工具摘要显示「有步骤未成功」，详情显示「历史工具结果　工具错误」并保留 `Terminal execution error: Request cancelled`。未见本机命令退出回执或报告的文件位置。

Farfold `protocol-v1-1795075272146-4.jsonl` 第 8 行 16:01:14.114 是唯一原历史请求，第 13 行 16:01:14.247 成功，前 14 行 SHA-256 `c93c4dc6168c662a0b0db219953b85e69d27618aafbff770f23c87ae3871c075`。零新建、发送、取消、权限请求与终端事件。厂商四条原历史和脚本分别保持上文原摘要，`result.txt` 仍不存在。此结果覆盖原失败和原回复回读，以及无重跑、无伪造退出反馈。
