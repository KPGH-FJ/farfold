# 第 12 周期四家并行、实际停止与重开

2026-11-17，macOS arm64，正式 `/Applications/Farfold.app` `a036904e1`，CDHash `3a0a31f4d81fd0b19866dff0d610c610a1b22e56`。从正常入口使用既有服务和指定模型，样本为两个独立自有目录的有界本机 Shell 和 sleep，不触及其他工作。

## Kilo、CodeBuddy 和 Devin

每家在 Farfold 分别核对并单次批准两条准确的 `/bin/sh ./task.sh`，确认两组原进程均在运行后，仅在 A 按停止。核对 A 的 Shell 和 sleep 退出且无完成标记；B 的相同原 PID、父子关系、进程组和目录保持，最终写出自己的标记并显示已完成。未从外部对测试进程发送信号。

| Agent 与原选项                           | A 原 ID 和 Shell、sleep                              | B 原 ID 和 Shell、sleep                              | 核对结果                                                 |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Kilo 7.8.1，免费 Nemotron 3 Ultra / None | `ses_e17bb90cfffeMk7gkLNKrc7mii`，18199、18200       | `ses_e17b8ff34ffe3FPlMMV2XhwDFf`，18201、18202       | 14:56:17 两组均在，14:57:20 A 已退出、B 保持，B 独立交付 |
| CodeBuddy 2.184.0，Hy4 / On              | `01a1e86e-8bb4-7b42-87e2-bcfced1c8bd7`，22777、22778 | `01a1e86f-01f5-7e92-a4d6-403642aeb919`，22780、22781 | 15:37:08 两组均在，15:37:21 A 已退出、B 保持，B 独立交付 |
| Devin 3000.12.57，SWE-2 Flash Medium     | `humorous-library`，24759、24760                     | `horse-basil`，24779、24780                          | 15:44:20 两组均在，15:44:34 A 已退出、B 保持，B 独立交付 |

三个 A 的诊断 `protocol-v1-1794898154603-5.jsonl`、`protocol-v1-1794900920519-15.jsonl`、`protocol-v1-1794901296382-24.jsonl` 各一次新增、一条手动请求、一次权限请求、一次取消。三个 B 的对应诊断 `protocol-v1-1794898324538-6.jsonl`、`protocol-v1-1794900950757-16.jsonl`、`protocol-v1-1794901382407-25.jsonl` 各一次权限请求、零取消。

CodeBuddy、Devin 的原已保存选择不可用时，准备页面分别呈现原选择与当前可用的 Hy4 / On、SWE-2 Flash Medium。先取消返回草稿，独立输入及工作目录读回，再明确接受本次测试的当前设置。Devin 两条审批卡复用了「该步骤报告的输入」，直接显示同一命令。全程选单次批准。其他账号切换、计费范围、记住批准、待发和实际断线场景需要另验。

正常保存退出前给三条 A 各写一段未发送的自有文本，重启后从搜索回到原对话，原正文、目录、配置和测试草稿分别保持。核对后替换自有草稿，各手动发送一条不含原标记的续问，三条均确切返回第一条的标记并完成。`protocol-v1-1794901675291-0.jsonl`、`protocol-v1-1794901682491-1.jsonl` 和 `protocol-v1-1794901700076-2.jsonl` 分别覆盖 Kilo、CodeBuddy、Devin，各一次加载、一次手动发送、零新建和零审批。原命令未重跑，三条各保留同一原 ID。样本只覆盖前台任务和冷开草稿，未新增队列或附件复验。

## Dirac 0.5.21 与 0.6.0 的停止对照

0.5.21 的首组长命令各在 30 秒后由官方工具移交后台，两条自然完成。A 在 15:05:02 已留下结果，15:05:21.126 才有取消。B 的重复执行请求被拒，后来仅结束自有测试回复。该组证明实际并行，未覆盖运行中停止。

0.5.21 的短前台组沿用 OpenRouter 免费 Nemotron 3 Ultra / Medium。15:39:33，A 的 Shell 23171 与 sleep 23172，B 的 Shell 23173 与 sleep 23174，各在自有目录执行。`protocol-v1-1794901067907-18.jsonl` 于 15:39:34.642 发出一次取消。15:39:46，A Shell 已退出，原 sleep 仍活跃、工作目录和进程组不变、父进程变为 PID 1。B 原进程不受影响并独立交付。A 的原工具记录只有一次调用，未发生前组的 30 秒移交。界面显示回复已停止，但实际子进程未随之停止。 [0.5.21 终端清理逻辑](https://github.com/dirac-run/dirac/blob/v0.5.21/src/integrations/terminal/standalone/StandaloneTerminalManager.ts#L147-L164)

在正式设置的「管理程序与版本 → 重新下载 / 更新」选官方目录的 0.6.0。实际安装包与同一登记的选用版本均确认 0.6.0，旧 0.5.21 安装仍可选。新版在释放终端前等待进程清理。用原服务、相同模型和同样长度的两个新短样本复验。15:54:57 两组 Shell 与 sleep 实际同时运行。仅点 A 停止。15:55:10，A 原 26659、26660 均已退出且无标记，B 原 26661、26662 保持，后来写出 `FF_C12_DIRAC_NEW_ISOLATION_B_DONE` 并显示完成。诊断 `protocol-v1-1794901996817-8.jsonl` 为 A 一次取消，B `protocol-v1-1794902031142-9.jsonl` 零取消。A 新 ID `1212f764-198d-4312-97a2-66b98d9bc3ab`，B `ed80c4f3-eb6b-45d8-83c0-24621d0b954f`。当前正例仅覆盖短前台工作，长任务移交后的停止未获得新版实测。 [官方登记](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) · [0.6.0 终端清理逻辑](https://github.com/dirac-run/dirac/blob/v0.6.0/src/integrations/terminal/standalone/StandaloneTerminalManager.ts#L138-L153)

## Dirac 停止后历史缺正文

0.6.0 重开两个准确的 A，一个始于 0.5.21，一个始于 0.6.0。两次 `session/load` 成功并发出工具历史，但正式界面提示「未能读取对话内容」。在各自只有一次批准的已取消样本中，Dirac 的本机任务日志存在原用户提示，ACP 日志没有用户或助手消息块，只有工具等更新。作为对照，已完成的新版 B 同样缺用户消息块，但至少有助手结果并能显示该结果。三个重开均零模型请求。源码命中已有 ACP 历史时直接返回，不走后备的用户消息重建。可见内容和模型实际仍持有的原上下文须分别核验。现有恢复保护要求实际收到可读正文，不能把工具历史当作原对话正文。 [Dirac 历史回放](https://github.com/dirac-run/dirac/blob/v0.6.0/cli/src/agent/DiracAgent.ts#L2316-L2365)

原旧版 A `2b6cbb39-cd55-462f-8ea9-db128db92dd4`、新版 A 和新版 B 的读取诊断分别为 `protocol-v1-1794901931130-6.jsonl`、`protocol-v1-1794902201918-0.jsonl`、`protocol-v1-1794902247945-1.jsonl`。各一次加载，零新建、零发送。需官方回放补出原用户正文，或官方提供按原对象的只读读取方式。`dirac history` 是交互界面，当前没找到可无副作用读取此原对象的官方机器接口。0.6.0 留在现选登记；旧程序和历史保持。 [官方历史命令](https://github.com/dirac-run/dirac/blob/v0.6.0/cli/src/commands/history.ts#L17-L60)

## 独立复核的官方候选

- **MiniMax**。现选安装和官方 ACP 目录仍为 0.2.7。公开 npm 0.7.7 的实际包已把活跃请求取消带入原会话、原轮次的后台清理逻辑，无活跃请求的分支仍提前返回。待官方目录更新，或明确选择该官方程序后，验 A 脚本转后台且仍有活跃请求时只停 A，核原进程及 B 结果。当前 0.2.7 的负例保持。 [官方目录](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) · [0.7.7 发布包](https://www.npmjs.com/package/@minimax-ai/code/v/0.7.7) · [官方停止语义](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/tui-capabilities.md#stopping-a-conversation-and-its-background-work)
- **Copilot**。已选 1.0.89，当前官方目录有 1.0.112。正常更新可独立安装并保留回退，原账号复用和程序信号转发须复验。发布说明未确认旧错误反馈已修，仍要等同类真实失败来核验。 [官方发布](https://github.com/github/copilot-cli/releases/tag/v1.0.112) · [同类上游问题](https://github.com/github/copilot-cli/issues/5266)
- **Pi**。现选正式适配器 0.0.34 仍缺网页转发。可先独立用原 OpenRouter 免费模型验 Pi 自管的本机 Shell 和文件。官方 SDK 的新会话网页方案仍需明确选定实际程序、验证签名页面助手的直接子进程归属，再做真实权限、撤回和截图。 [适配器发行](https://github.com/svkozak/pi-acp/releases/latest) · [Pi SDK](https://docs.pi.dev/latest/sdk)
