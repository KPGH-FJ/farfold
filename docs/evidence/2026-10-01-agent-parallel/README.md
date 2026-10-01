# OpenCode 与 fast-agent 真实并行

2026-10-01 12:19–12:27 复用正式候选 `45e054d`，没有重装或改产品源码。二进制 SHA-256 为 `9c6212b74ffe645bd2b0a3befa17d9a69bd3d4a51beecfea26a5dc0f165ef309`，见[本轮身份](candidate-run.json)与[原安装收据](../2026-10-01-protocol-error-classification/candidate-install.json)。445 项输入至退出未变；复用该候选 535 Rust（3 既有忽略）、fmt/clippy 及 1,213 前端/类型/构建，来源见[前片工程与安装记录](../2026-10-01-protocol-error-classification/installed.md)，本片没有重复运行产品检查。

**本片有限通过两个真实 Agent 的重叠运行、切换后后台完成、各自回复和实际命令输出查看。** 这是 J4 双样本补验，不代表全部并行组合或 J3 审批通过。返回 A 时 A 已经完成，没有测得“返回时仍在运行”这一更窄状态。

## 对话、选择与实际结果

A 复用[停止队列片](../2026-10-01-opencode-stop-queue/README.md)的新 OpenCode 对话 `ses_f0a560db1ffeJTUeGpvCgi6hIG`，cwd 为 `/private/tmp/farfold-stop-queue-idn3cxh0`。B 恢复 fast-agent 原连接测试 `2610010054-BZNiH6`，cwd 为应用 conversations。均沿用已有设置；OpenCode 保留 `opencode/nemotron-3-ultra-free`，fast-agent 显示“默认模型”，具体模型与推理值仍未声明。

| 观察              | 证据与范围                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 原历史与来源      | [01 fast-agent 历史](01-fast-existing-history.jpg)、[02 来源](02-fast-original-source.jpg)保留两条原测试回复与已有设置；[03 OpenCode 原模型](03-opencode-original-model.jpg)保留 Nemotron。没有重新选模型或交付新凭据。                                                                          |
| A 实际运行        | A 明确请求仅执行一次 `python3 -I -B -c 'import time; time.sleep(60); print("FARFOLD-PARALLEL-OPENCODE-A-20261001")'`。[04 运行界面](04-opencode-running.jpg)显示正在处理；[进程采样](opencode-running-processes.json)记录 OpenCode `69973` 及 Python 子进程 `70076`，实际 cwd 均为本轮自有目录。 |
| 切 B 后两项进行中 | 切到 B 只发送一次固定回复请求，[05 截图](05-both-running.jpg)及[AX](05-both-running.txt)明确显示“2 进行中”。这是本次 UI 重叠运行证据；稍后的[进程采样](simultaneous-processes.json)仍有两个 Agent 进程，但 A 的 Python 已结束，不能把该采样称为两个工具同时执行的证明。                          |
| B 成功及返回 A    | [06 B 结果](06-fast-result.jpg)显示精确正文 `FARFOLD-PARALLEL-FAST-B-20261001` 并完成；[07 返回 A](07-opencode-return-completed.jpg)时 A 已后台完成，精确正文为 `FARFOLD-PARALLEL-OPENCODE-A-20261001`，先前历史仍可见。                                                                         |
| 实际输出查看      | [08 产物栏](08-opencode-real-output.jpg)及[AX](08-opencode-real-output.txt)显示本次 Python 命令和对应精确输出标记。这里只验证真实命令输出可查看，没有真实文件 diff 或审批操作。                                                                                                                  |

[完成时](protocol-completed.json)及[最终有限元数据](protocol-metadata-final.json)共 3 个当前日志文件；最终 25 条 startup 状态记录，出站 3 initialize、1 session/new、2 session/load、**2 prompt、0 cancel、0 authenticate**，未观察到 permission 请求。两条 prompt 对应本轮 A、B，不把历史中既有标记再计为新请求。元数据只覆盖本轮时间窗、完整行和当前 `.jsonl`，不含旋转副本或正文，不声称完整协议审计。

## 数据保留与退出

[基线](data-before.json)为 36 条索引、37 个启动配置、46 项设置。[退出前](before-exit.json)及 12:27:11 的[退出后核对](after-exit.json)确认索引无新增或删除、37 个启动配置保持；唯一索引摘要变化是 fast-agent 的配置编码规范化。

[专项核对](fast-config-normalization.json)以原配置逐字替换当前行的该字段后重算摘要，与基线 `ae742fd0f4b6dd98aa24ab6925ab02f1ef1c3464c1f8d2f24d76dbd7ef9b5540` 一致，证明该行其余字段相同。配置仅从 V1 `{model:null, thoughtLevel:null, _farfoldService:{kind:existing}}` 转为 V2 `{choices:[], _farfoldService:{kind:existing}}`；未声明值仍未知，不代表替用户更换或确认了实际模型/推理等级。

设置只有 `unsentWork.v1` 变化，具体为本轮两条测试对话的 activity；[原未发基线](unsent-before.json)对应的草稿、选择、反馈、队列及版本保持。最后回到原 Amp / Medium 空稿，见[09 截图](09-original-draft.jpg)。445 项源码输入与正式二进制摘要保持；[累计采样](all-observed-processes.json)中的 5 个 PID＋启动时间身份最终均不再存在，只证明已采样身份，不声称捕获全部瞬时子进程。

本片没有重打包或产生新的重复应用，沿用[此前精确删除证明](../2026-10-01-protocol-error-classification/duplicate-app-cleanup.json)。下一步按唯一活动计划核对 J3 小文件产物与真实审批条件；本片没有 permission 请求，不能代替该旅程。此前[仓库目录初始化超时](../2026-10-01-opencode-stop-queue/workdir-timeout-diagnosis.md)、Autohand 安装确认、Messages 云端及全目录账号缺口继续开放。
