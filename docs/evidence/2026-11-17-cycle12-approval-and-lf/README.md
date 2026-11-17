# 第 12 周期审批命令、精确文件交付与早期停止

2026-11-17，macOS arm64。正式应用通过正常入口使用已选服务和模型。文件、命令和结果核对使用独立自建目录及合成内容。

## Mistral Vibe 审批命令定位

诊断版 `b9a09493b` 沿用 Mistral Medium 3.5 / High 新建自有测试对话。审批卡仍显示未提供输入详情。同一请求的处理过程显示 `/bin/sh ./ff-owned-permission.sh`。核对后只批准这条命令一次，脚本返回测试标记。诊断 `protocol-v1-1794895567597-1.jsonl` 第 205 帧记录 `requestHasInput:false`、请求状态省略。紧邻前一条入站事件的会话及工具标识精确相同，类型 `tool_call`、状态 `in_progress`、有输入、无输出和内容。这里的标识、命令及参数值未进入诊断日志。以往 Farfold 的补显示要求收到 `pending`，所以这种实际事件不会进审批卡。 [原先正式反例](../2026-11-17-cycle12-stop-delivery-approval/README.md#mistral-审批输入来源) · [Vibe 状态映射](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/vibe/acp/session_updates.py#L623-L635)

`a036904e1` 复用共用卡片。当前连接、同一会话及本次由 Farfold 送出的请求内，审批缺输入时，可展示精确对应的首个工具事件所报告的输入，并标注来源。始终保留原审批内容和选项。同一标识重复、输入改变、已报告输出或出现无法判断的变化时清掉补显示。停止、工具执行权和终态判定沿原规则。

**正式版复验通过。** 同样沿用 Medium 3.5 / High。自有对话 `bcebd408-a7a7-ffb1-d510-11e69e65c2ad` 的首条回答只作文字确认，没有工具请求。提示实际提交一次工具审批后，卡片在处理过程折叠时直接显示「该步骤报告的输入」和完整命令 `/bin/sh /private/tmp/ff-c12-vibe-fixed-vfmRAIJp/ff-owned-permission.sh`。只按一次 Allow once，唯一脚本返回 `FF_C12_VIBE_FIXED_20261117`，对话显示已完成。`protocol-v1-1794896669068-1.jsonl` 为两次手动发送、一次权限请求，第 91 帧再次证明原请求无输入、紧邻同一工具 `in_progress` 且有输入无输出。验证范围是同一请求的 Bash 审批和完成路径。

## Kilo 与 Dirac 的换行

- **Kilo 7.8.1，Kilo Gateway 免费 Nemotron 3 Ultra / None**。原失败的 Kilo 本地工具记录确认 `write` 在落盘前只收到 72 字节，已缺原件的末尾 LF，其文件读取正常文本视图也无从区分这两种末尾字节。新独立样本从正常入口逐次批准 `/bin/cp input.txt result.txt`，由其编辑工具只改副本的状态行。原件逐字节保持，成品 73 字节，末字节 `0a`，摘要 `daee9feb7d922d60ea8d4c21b5b9209c56cf3f80373508ba62cf99012782d3fd`。从对话交付链接实际打开，可见完整另存入口。 [官方读取](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/tool/read.ts#L354-L366) · [编辑工具](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/tool/edit.ts#L154-L193)
- **Dirac 0.5.21，OpenRouter 免费 Nemotron 3 Ultra / Medium**。原失败两次 `write_to_file` 在 Dirac 自有记录中的原始助手工具参数都是 73 字节，和它发给 Farfold 的审批输入一致，均缺末尾 LF。新独立样本从正常入口只批准一次 `/usr/bin/sed 's/^Status: draft$/Status: ready/' input.txt > result.txt`，原件保持。成品 74 字节，末字节 `0a`，摘要 `bff401e0cf0ef80fcfc37e2ae5255d6c3e00958ebed3f32f015a8728ccc2fc97`。从 Farfold「打开文件…」实际打开；其命令结果还未给出精确成品直达入口。 [官方参数处理](https://github.com/dirac-run/dirac/blob/v0.5.21/src/core/task/stream/ToolUseHandler.ts#L16-L39) · [命令工具](https://github.com/dirac-run/dirac/blob/v0.5.21/src/core/task/tools/modules/execute_command/ExecuteCommandTool.ts#L160-L193)

两条替代路径均通过本次字节验收。原完整写入路径的失败保留。现有记录从各家收到或解析后的工具参数起，模型发出的原始流和服务解析步骤仍缺逐段证据。

Kilo 新样本 `ses_e17edf205ffeAcPiHro6EE9HgS` 的官方本地记录对应自建工作目录，顺序为 `bash → read → edit → read`，全部完成。正式版冷开同一对象，原正文、文件链接、免费 Ultra / None 和已有设置保留。手动一次不含标记的上下文追问，准确回原标记并显示完成；`protocol-v1-1794896986756-3.jsonl` 为一次加载、一次手动发送、零新建、零权限请求。Dirac 样本 `82dfcd9d-fd58-47c4-b6c2-e75fb03d768a` 的 `protocol-v1-1794895038033-7.jsonl` 为一次发送、一次权限请求。

## MiniMax MiMo 前台早期停止

MiniMax 0.2.7 沿已有小米 MiMo 新建自有对话。第一次准备双任务时 B 已独立完成；该次 A 的 `session/cancel` 距命令启动的 PID 文件约 42.22 秒，A 最终写出完成标记，不能用于证明早期停止。

第二次另开目录，在同一次可见操作中等待 Bash 命令出现后点「停止」。14:19:31.322 捕获原 Shell 89104 和 sleep 89106，父子关系、进程组和目录对应。`protocol-v1-1794896276816-5.jsonl` 发出一次取消，距 PID 标记文件写入 1.133 秒。14:19:56 原 Shell 与子进程已退出，14:20:45 再查无完成标记，超过计划运行 48 秒。应用保留「回复已停止，仍有步骤未确认结束」。这一轮覆盖单条前台任务的早期停止；已移交后台的原反例和同家同时执行的其他范围继续分别核。 [原后台反例](../2026-11-17-cycle12-history-and-stop/README.md#minimax-code-已移交后台的命令停止失败)

只读核对原 `mvs_0b9e8261dc114cf2a960e95a37134dc1` 的官方本机任务记录。唯一 Bash 任务的 `executionMode` 保持 `managed_foreground`，状态 `canceled`，14:19:31.192 创建、14:19:32.368 结束。原任务事件无自动移交；该版命令程序的前台移交阈值为 15 秒。源码更新并重开后，原正文、原 ID、原工作位置和小米模型均保持，未自动重发。一条手动续问准确回复 `FF_C12_MINIMAX_FOREGROUND_EARLY_20261117`。`protocol-v1-1794896870277-2.jsonl` 有一次加载、一次手动发送、零权限请求和零新建。旧工具终态跨界面仍按未确认保护，旧后台实际未停的失败保持。

## 工程检查与正式安装

诊断版 `b9a09493b` 后更新到正式 `a036904e1`。最终 `/Applications/Farfold.app` 为 0.1.7 arm64，CDHash `3a0a31f4d81fd0b19866dff0d610c610a1b22e56`，可执行文件 SHA-256 `6f73b4e054a3298a8ef974794813294e6c4240f872309647efd38938e9aa2fe5`。两次均正常保存退出，分别核对关闭态应用数据、WebKit 和缓存共 247,491 项前后摘要一致，SQLite 及 WAL 的隔离副本完整性通过，严格签名验证通过。构建目录中的重复应用包已移除。

最终前端 786 个文件 10,978 项通过，Rust 发布配置 2,814 项通过，另有 11 项既有忽略。格式、类型、Clippy、生产构建、内部打包和独立代码复核通过。第 12 周期按 21 家八项续验，整家通过仍为 0/21。
