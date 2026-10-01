# OpenCode 真实审批、文件产物与冷回放

2026-10-01 12:28–12:42 复用正式候选 `45e054d`，没有重装或改产品源码。二进制 SHA-256 为 `9c6212b74ffe645bd2b0a3befa17d9a69bd3d4a51beecfea26a5dc0f165ef309`，见[本轮身份](candidate-run.json)及[原安装收据](../2026-10-01-protocol-error-classification/candidate-install.json)。[445 项输入快照](candidate-source.json)至退出保持；复用该候选 535 Rust（3 既有忽略）、fmt/clippy 及 1,213 前端/类型/构建，来源见[原工程与安装记录](../2026-10-01-protocol-error-classification/installed.md)，没有重复运行产品检查。

**本片有限通过 J3 的真实拒绝、单次批准、批准并记住及文件差异查看，并通过 J5 的同一历史与差异冷回放。** 不代表全产品验收、所有 Agent 的审批组合或跨重启权限记忆通过。

## 请求与实际产物

沿用[停止队列片](../2026-10-01-opencode-stop-queue/README.md)与[并行片](../2026-10-01-agent-parallel/README.md)的 OpenCode 对话 `ses_f0a560db1ffeJTUeGpvCgi6hIG`，cwd 为 `/private/tmp/farfold-stop-queue-idn3cxh0`，保留 `opencode/nemotron-3-ultra-free` / 已有设置。唯一文件目标是根任务专门创建的 `/private/tmp/farfold-artifact-target-54r34ch8/proof.txt`，不属于该对话工作目录；[初始收据](artifact-before.json)保存两行初值及摘要。

| 明确请求           | 实际审批与结果                                                                                                                                        | 对应证据                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一次单文件编辑   | 出现真实审批后拒绝，界面结算为“已拒绝 · 已告知 Agent”，没有接着完成编辑；文件摘要与初始值相同。                                                       | [01 审批](01-real-permission-request.jpg)、[02 拒绝结算](02-rejection-settled.jpg)、[拒绝后文件](artifact-after-rejection.json)、[有限元数据](protocol-after-rejection.json)                                                             |
| 新的一次读取与编辑 | 前次拒绝结束后另发新请求，读取与编辑过程分别批准一次 `Allow once`，返回 `FARFOLD-ARTIFACT-EDIT-OK`，文件仅由 `state=before` 变为 `state=after`。      | [03 新审批](03-second-permission-request.jpg)、[04 完整输入](04-edit-approval-exact-input.jpg)及[AX](04-edit-approval-exact-input.txt)、[05 两次批准与完成](05-allow-once-edit-result.jpg)、[修改后文件](artifact-after-allow-once.json) |
| 单独只读请求       | 对同一自有父目录的访问卡选择 `Always allow`；经过 5 秒可撤销窗口，未撤销，随后读取完成，返回 `FARFOLD-ARTIFACT-REMEMBER-READ-OK`。                    | [08 范围](08-remember-directory-scope.jpg)及[AX](08-remember-directory-scope.txt)、[窗口采样](remember-grace-window.json)、[09 已提交与完成](09-remember-submitted.jpg)                                                                  |
| 最后一次明确编辑   | 将唯一 `state=after` 改为 `state=final`，返回 `FARFOLD-ARTIFACT-FINAL-OK`；本次没有新增审批。最终文件 38 字节，其他字节保持，目录仍只有 `proof.txt`。 | [10 完成](10-remember-followup-result.jpg)、[11 最后差异](11-final-file-diff.jpg)、[最终文件](artifact-final.json)、[前](protocol-before-remember-followup.json)/[后](protocol-after-remember-followup.json)有限元数据                   |

[06 产物窗格](06-file-artifact-pane.jpg)和[07 修改后视图](07-file-after-fragment.jpg)显示 `before → after` 及修改后片段；[11](11-final-file-diff.jpg)显示 `after → final`。对应 [06 AX](06-file-artifact-pane.txt)、[07 AX](07-file-after-fragment.txt)、[11 AX](11-final-file-diff.txt)均明确片段行号不代表文件中的行号。屏幕只证明所示片段；完整文件结果由上述任务自有文件收据单独核对，不能把片段视图说成完整文件预览。

04 虽命名为编辑审批，其“完整输入”实际只有 `filepath` 与 `parentDir`，不是 `oldString/newString`。08 同样是 `external_directory` 范围：固定官方提交 `014614d35b397775e5d397a490fc72368c894ec2` 的 [external-directory.ts](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/tool/external-directory.ts#L27-L40)将 `patterns` / `always` 设为父目录 `/*`，[ACP 映射](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/acp/permission.ts#L55-L64)传入该权限的元数据。本轮只能说明这一路线提交后，同连接的下一次文件操作未再要求审批；不能称为全局编辑允许、只针对该单文件的永久编辑授权或冷启动后仍有效。

## 冷恢复与范围

[冷退出核对](before-cold-exit.json)后重开同一正式应用与同一 native ID：[12 历史](12-cold-history.jpg)、[13 文件差异](13-cold-file-diff.jpg)及[AX](13-cold-file-diff.txt)可读，仍显示 `state=after → state=final`；[14 模型与来源](14-cold-model-source.jpg)及[AX](14-cold-model-source.txt)保留原 Nemotron / 已有设置。冷历史没有前次审批决定卡，不能称完整保存了所有审批标记。

[冷观察](cold-replay-processes.json)为 12:40:27–12:40:37，约 10 秒；期间及直到最终退出没有新增 prompt，[文件与请求核对](cold-replay-file-and-requests.json)确认最终文件不变、累计仍为 4 prompt / 4 permission。冷恢复后没有再次要求读写文件，故**跨重启的权限记忆未验证**；本次也没有测试撤销窗口内撤销或撤销已记住的权限。

[最终有限元数据](protocol-metadata-final.json)覆盖本轮 4 个当前日志文件、32 条 startup 状态记录：出站 4 initialize、2 session/new、2 session/load、**4 prompt、0 cancel、0 authenticate**，入站 **4 permission**，被拒绝的元数据记录数为 0。四次请求的审批数量依次为 1、2、1、0；最后一次编辑前后累计审批均为 4。两次 session/new 是 Amp 空稿准备，不代表新增持久历史。元数据仅含本轮时间窗内当前 `.jsonl` 的完整行与有限字段，不含旋转副本或正文，不声称完整协议审计。

## 数据保留与退出

[基线](data-before.json)为 36 条索引、37 个启动配置、46 项设置。[12:41:57 退出核对](after-exit.json)确认所有原索引及启动配置保持，无新索引；设置只 `unsentWork.v1` 变化，限本条测试对话的 activity。[原未发基线](unsent-before.json)对应的草稿、选择、反馈、队列及版本全部保持。最后返回原 Amp / Medium 空稿，见[15 截图](15-original-draft-restored.jpg)及[AX](15-original-draft-restored.txt)。

445 项输入和正式二进制未变，[累计采样](all-observed-processes.json)的 6 个 PID＋启动时间身份在最终核对中均不再存在；这只证明已采样身份结束，不声称捕获全部瞬时进程。本片没有重打包或产生新重复应用，沿用[此前精确删除证明](../2026-10-01-protocol-error-classification/duplicate-app-cleanup.json)。任务自有目标文件与目录为验收历史保留，没有删除用户数据。

继续按唯一活动计划处理未关闭的产品缺口。前序[工作目录初始化超时](../2026-10-01-opencode-stop-queue/workdir-timeout-diagnosis.md)、Autohand 安装确认、Messages 云端及全目录账号/首发/续接条件仍开放；本片真实审批与产物结果不替代这些出口。
