# 第 12 周期并行停止、文件交付与审批详情

2026-11-17，macOS arm64。双任务与文件交付从正式 Farfold `3077ce884` 的正常入口执行。每条任务使用独立自建目录，保留原账号、模型和权限来源。程序测试只使用自有前台脚本和合成标记。

## OpenCode 与 Goose 同家双任务

**OpenCode** 两个自建对话各选择已配置的 Xiaomi `mimo-v2.6-flash` / Build。11:45:44 点停前有两组实在运行的进程，A Shell 44998 和 sleep 44999，B Shell 45023 和 sleep 45024。两组在各自原目录，互不共享进程组。只在 A 点「停止」。11:46:03 A 的两个原进程已退出，无完成标记，B 的原进程、目录和启动时间保持。B 最后写出 `FF_C12_OPENCODE_B_DELIVERED_20261117`，界面显示已完成。诊断 A `protocol-v1-1794887033181-4.jsonl` 一次取消，B `protocol-v1-1794887115243-5.jsonl` 零取消。原 A `ses_e18655d2affe45XPhn2fExzuJe`，B `ses_e18641ca3ffegIL2qsPRMo0esJ`。

**Goose** 两条均沿用已有 `nvidia/nemotron-3.5-super-vl:free` / Off。11:50:10 查到执行中的 A Shell 45273 和 sleep 45274，B Shell 45357 和 sleep 45358。只点 A「停止」。11:50:40 A 两个原进程均已退出，未写完成标记，B 的两个原进程仍在同一原目录及组。B 之后写出 `FF_C12_GOOSE_B_DELIVERED_20261117` 并显示已完成。A 的实时工具终态未确认，应用仍显示「回复已停止，仍有步骤未确认结束」。诊断 A `protocol-v1-1794887291989-9.jsonl` 一次取消，B `protocol-v1-1794887353357-10.jsonl` 零取消。原 A `20261117_1`，B `20261117_2`。两家均未发送外部进程信号；范围限原请求在本机运行的自有前台脚本。

更新应用前在两条停止后的自有对话中各加入一段未发送文字和一份本地文本附件。正常保存并退出后，从新版侧栏冷开两条 A，原目录、正文、模型、两份草稿和附件分别读回。OpenCode 仍是 Xiaomi MiMo / Build，Goose 仍是 OpenRouter 的原免费 Super VL / Off。Goose 仍显示「此前请求结果未确认，未自动重发」。核对后仅移除两份自建测试附件并替换自建测试草稿。各手动发送一条不含原标记的上下文问题，两家均准确回复原标记并完成。`protocol-v1-1794888288823-0.jsonl` 与 `protocol-v1-1794888340020-1.jsonl` 各一次加载、一次手动发送、零新建和零审批。原 ID 不变，原命令未重跑。真实断线、已有待发队列、后台工作和各类其他终态仍须按原条件验收。

## 文件返工、审批与验收字节

- **CodeBuddy Hy4 / On**。先在本次独立草稿确认选择。只批准三次经核对的当前操作：读取 `input.txt`，在原目录新写 `result.txt`，只读硬盘校对。成品 78 字节与预期逐字节匹配，末尾一个 LF，原文件原样保持。通过「本轮产物 → 查看文件」读到结果，完整另存入口可见。自有会话 `01a1e7a3-3252-7dcd-9bcf-72ca4b835e8f`，诊断 `protocol-v1-1794887593758-14.jsonl` 有一次发送、三次审批。成品 SHA-256 `475634f41b5b2996ab7b3e633bc289ec500ce0afb614e7dc0dd47fbb83bfa21f`。
- **Kilo Gateway 免费 Nemotron 3 Ultra / None**。自有会话 `ses_e1862f709ffentnZM78UnOBIsS`。本轮产物可打开，模型回复声称恰好一个末尾 LF，实际成品 72 字节，缺 LF，原文件 73 字节保持。只读核同目录原会话的官方工具记录 `prt_1e79d7ef2001LAAp3YvZ10xA3E`：所传 `state.input.content` 已缺 LF，写入参数与磁盘文件一致，成品 SHA-256 `fba7c7426a5d5a33ac2e5045777bda205bcdefac2365461cced9910c16348bee`。现有证据把问题定位到写入前，模型生成与 Agent 的写前处理仍不能区分。诊断 `protocol-v1-1794887187752-7.jsonl` 一次发送、零审批。保留字节验收失败和打开入口正例。
- **Dirac 免费 Nemotron 3 Ultra / Medium**。自有会话 `905d2324-97fb-4bb9-bc77-729f07c6582d`。两次审批均明确指向 `result.txt`，展开输入核到两次都缺末尾 LF。分别单次拒绝，随后从应用停止此测试。原文件 74 字节保持，无 `result.txt`。诊断 `protocol-v1-1794887657022-16.jsonl` 一次发送、两次审批、一次取消。本样本确认能在批准前看清文件路径和内容，成品交付没通过。

## Mistral 审批输入来源

既有正式反例的审批请求只带工具标识，工具活动已报告命令。官方 ACP 允许以工具更新表示权限请求。`c923ccb10` 在同一连接、会话与本次请求中，仅从完全匹配且仍等待批准的工具补显示输入。审批参数与选项由原请求提供。重复标识、开始执行、报告新输入或输出时撤去补充内容；已失去所见依据且尚未提交的延迟决定也随之失效。其他 Agent 同样复用这套判断。 [Mistral 实现](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/vibe/acp/agent.py#L866-L874) · [ACP 权限请求](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)

**Mistral 正式复验仍失败。** 用现有 Medium 3.5 / High 在原测试工作位置新建自有对话 `5a24558c-f41f-e650-c868-4f42b454be2c`，唯一待处理步骤的技术详情能读到 `/bin/sh ./ff-owned-permission.sh`，审批卡仍显示 Agent 未提供输入详情。核对技术详情后只批准一次，脚本返回预期标记并成功结束。`protocol-v1-1794888399196-3.jsonl` 一次发送、一次审批请求；操作更新比审批早 8 毫秒。脱敏诊断没有足够字段确认同一标识和实际状态。所核 Vibe 2.25.8 的旧执行路径可在权限请求前将操作标成 `in_progress`，符合这次表现。该状态也可能表示已经执行，所以正式复验仍需要确认所经状态、完全匹配的标识及输入来源，或直接从官方审批请求取得详情。 [Vibe 操作状态](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/vibe/app_server/_projector.py#L248-L270) · [ACP 状态映射](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/vibe/acp/session_updates.py#L623-L635)

## 工程检查与正式安装

源码 `c923ccb10`，macOS arm64 正式 `/Applications/Farfold.app`，0.1.7。CDHash `73c8c75dea688325042fe9c5e66e622f6a61f808`，可执行文件 SHA-256 `4cbd9547e451f488f711d5ba9e36724b1b88f5a31e4cbf910d7458d01b3c8dc1`。已核严格签名，构建目录中的重复应用包已移除。关闭态应用数据、WebKit 和应用缓存共 247,491 项前后摘要一致，SQLite 与 WAL 的隔离副本完整性通过。

前端全量 786 个文件 10,976 项通过。Rust 全量发布配置 2,811 项通过，另有 11 项既有忽略。格式、类型、Clippy、生产构建和内部打包通过。首发 21 家八项继续，整家通过 0/21。
