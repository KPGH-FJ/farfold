# OpenCode 真实停止、队列暂停与冷续接

2026-10-01 12:07–12:19 复用正式候选 `45e054d`，没有重新安装或改产品源码。二进制 SHA-256 为 `9c6212b74ffe645bd2b0a3befa17d9a69bd3d4a51beecfea26a5dc0f165ef309`，见[本轮身份](candidate-run.json)及[原安装收据](../2026-10-01-protocol-error-classification/candidate-install.json)。445 项输入至退出未变；沿用该候选的 535 Rust（3 既有忽略）、fmt/clippy 和 1,213 前端/类型/构建结果，本片不重跑未变工程检查，来源见[前片安装记录](../2026-10-01-protocol-error-classification/installed.md)。

**本片有限通过 OpenCode 的实际请求/步骤呈现、确认停止、单条队列暂停、冷恢复及明确续发。** 这些结果覆盖 J2/J5 和停止路径的一部分，不代表 J3 审批、J4 多 Agent 并行、全部历史停止标记保留或完整产品验收。

## 真实结果

| 路径         | 观察与证据                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保留原模型   | [01 原选择](01-original-opencode-model.jpg)与[04 中性目录选择](04-neutral-original-model.jpg)均为 OpenCode Zen / Nemotron 3 Ultra Free。沿用已有设置，没有改成其他模型或来源。                                                                                                                                                                                                           |
| 首发与排队   | 在 `/private/tmp/farfold-stop-queue-idn3cxh0` 发出 A，要求仅执行一次 `python3 -I -B -c 'import time; time.sleep(45); print("FARFOLD-STOP-WAIT-A")'`。[05 运行中](05-real-tool-running.jpg)、[06 排队](06-queued-while-tool-running.jpg)显示真实步骤运行期间仅加入一条 B；[进程采样](active-first-task.json)观察到 OpenCode `68077` 及其 Python 子进程 `68199`，两者实际 cwd 均为该目录。 |
| 确认停止     | [07 停止结果](07-stop-request.jpg)显示“已停止”、步骤耗时 34.4 秒及“待发消息已暂停”。[08 详情截图](08-stopped-tool-detail.jpg)显示原命令/目录，[对应 AX](08-stopped-tool-detail.txt)记录 `User aborted the command`，不是命令自然完成。Python `68199` 在[冷退出前全局身份核对](before-cold-exit.json)已不在，B 尚未发送；[停止时协议计数](protocol-stopped.json)只有 1 prompt、1 cancel。 |
| 冷退出与恢复 | [冷退出后](after-cold-exit.json)此前六个已观察身份均结束。[09 冷历史与队列](09-cold-history-queue.jpg)恢复 A 的历史及一条暂停的 B，[10 模型与来源](10-cold-model-source.jpg)仍显示原 Nemotron / 沿用已有设置。[10 秒观察窗口](cold-paused-window.json)内没有出站 prompt，[冷恢复元数据](protocol-cold-paused.json)中的累计 prompt 仍为 1。                                               |
| 明确继续 B   | 点击“继续发送”后仅新增一次 prompt；[11 回复](11-explicit-continue-result.jpg)及[AX](11-explicit-continue-result.txt)显示精确正文 `FARFOLD-QUEUE-COLD-CONTINUE-B` 和“已完成”。[继续后元数据](protocol-after-continue.json)累计 2 prompt，[自有队列](own-queue-after-continue.json)已清空。                                                                                                |

本次 native ID 始终为 `ses_f0a560db1ffeJTUeGpvCgi6hIG`，模型 `opencode/nemotron-3-ultra-free`、来源 `{kind: existing}` 保持一致；[冷退出前](own-queue-before-cold.json)、[退出后](own-queue-after-exit.json)、[冷恢复暂停时](own-queue-cold-paused.json)的队列均仅有同一条 B，`uncertainIndex=null`。这证明本次队列与选择保留，不把恢复截图未呈现的旧停止标记一并认定为保留。

## 单列失败：仓库目录初始化超时

首次在仓库内空 `work-area` 准备相同请求，见[02 输入保留](02-first-prompt-ready.jpg)。随后[03 界面](03-workdir-initialize-timeout.jpg)及[AX](03-workdir-initialize-timeout.txt)显示连接检查超时；[当时元数据](protocol-before-send.json)证明该连接出站 initialize 观察后约 60 秒仍未收到匹配响应，没有 session/new 或 prompt。清理记录为 SIGTERM 后 `childReaped/groupEnded/connectionRemoved=true`。

后续改用[本轮自有中性空目录](neutral-workdir.json)，[实际 cwd 采样](active-neutral-directory.json)正确并完成上述旅程。两次先后观察不能证明目录是唯一因果变量，原目录未重复尝试。具体阻塞原因仍未知，见[只读窄调查](workdir-timeout-diagnosis.md)；不以成功路径覆盖这次失败。

## 数据、观察范围与退出

[最终协议元数据](protocol-metadata-final.json)限定本轮时间窗，共 7 个当前日志文件、52 条有限 startup 状态记录；出站 7 initialize、6 session/new、4 set_config_option、1 session/load、**2 prompt、1 cancel、0 authenticate**。普通 set_config_option 记录不等于用户主动改选模型；本次选择是否保持以界面及自有会话配置核对为准。采集只含安全元数据、完整行和当前 `.jsonl`，不含旋转副本，不声称完整协议审计。

[基线](data-before.json)为 35 条索引、37 个启动配置、46 项设置。[恢复原稿](12-original-draft-restored.jpg)及[核对](original-draft-restored.json)确认回到原 Amp 空稿；12:19:09 的[最终退出核对](after-exit.json)确认所有原索引、原启动配置及[原未发字段](unsent-before.json)保持，新增的唯一索引是上述测试对话。设置仅 `unsentWork.v1` 因本轮新增对话活动变化，没有新增设置键；不能写成整项设置完全未变。

[累计采样](all-observed-processes.json)记录 10 个 PID＋启动时间身份，最终均不再存在；只证明已采样身份，不声称捕获所有瞬时后代。445 项源码输入和正式二进制摘要保持。[目录与应用核对](workdir-and-app-check.json)确认中性工作目录及仓库 `work-area` 仍为空；中性目录为后续历史恢复保留，正式应用保留，无重复 `.app`。本片没有重打包，沿用[前片精确清理证明](../2026-10-01-protocol-error-classification/duplicate-app-cleanup.json)。

下一步按唯一活动计划在同候选补 OpenCode 与 fast-agent 的真实并行；本片不预先计入并行成功。项目目录初始化超时、Autohand 安装确认、Messages 云端与全目录账号/首发/续接缺口继续开放。
