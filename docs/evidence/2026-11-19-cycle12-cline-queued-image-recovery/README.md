# 第 12 周期 Cline 两条待发与图片断线恢复

2026-11-19，北京时间，macOS arm64 正式 Farfold 0.1.7 `5e12e06d9`，CDHash `4e5bba7028bdabce14eb3dd531844654e8b611ce`。Cline 3.0.74 沿用已存的 `nvidia/nemotron-3.5-super-vl:free` 和 Act。从普通入口新建自有会话 `1795071291095_hnmj5_cli`，目录为 `/private/tmp/ff-c12-cline-multi.v0tlo1qh/work`。首条待发 B 自带 `cline-queue.png`，次条 C 为纯文本，均请求模型仅回复各自文本标记。[前次单条待发和独立图片草稿](../2026-11-19-cycle12-cline-queued-continue/README.md)

## 原任务在途断线

发送一次 A，Cline 请求运行 `/bin/sh ./front.sh`。两条消息先按 B、C 顺序加入待发，再只批准一次该命令。脚本于 14:55:57.146 写出原 Shell 2213 和 sleep 2215。14:55:57.207 的独立检查确认两者均在自有目录，Shell 的父进程为 Cline 共用服务 31026，sleep 的父进程为 Shell。14:55:57.350 仅使原 Farfold 1677 的自建 Cline 直连进程 2049 意外退出，事前核对对应官方登记、原目录与唯一进程归属。原进程作用域记录见本机试验根的 `owned-fault.json`。

正式 `protocol-v1-1795071290543-2.jsonl` 第 14 行 14:55:29.523 为唯一 A 发送，第 17–18 行为唯一工具审批及响应，第 20–24 行记录信号 9、原直连进程组结束与连接移除。24 行 SHA-256 `885cfcd277cbc438ba3b85b6d4414e07c9caba1678ca4e217e6274ab0c9431ac`，零停止请求。共用服务 31026 未被测试操作改动，原任务在断线后自然完成。`front-natural.txt` 修改时间为 14:56:21.157，29 字节，SHA-256 `e36912c1f2512d34bc8a224761ecca0a368c599680d2c00f12eb29b230a16cc6`。此时 Farfold 保留原请求结果未知。

## 同原会话恢复与一次继续

14:56:10.065 只读检查同一队列时，B 的文本和图像为第 1 项，C 为第 2 项，`uncertainIndex` 为 `null`，`outcomeUnknown` 为 `true`。B 的缓存解码为 137 字节 PNG，逐字节等于本机原件，SHA-256 `75ebf873a4d8a9f7ef958fed9245715b69363856888c02ada4d2619e73fe4f16`。队列按排序键、紧凑分隔符及 ASCII 转义序列化的 SHA-256 为 `98e8c7c61793ed78252e3415d3951dd2ce3bbb6e60463cfd1f127018dd1ccef4`。厂商历史此时只有原 A 和该工具调用。

同一原会话热重连无发送。`protocol-v1-1795071376108-3.jsonl` 第 9 行 14:56:16.616 发出唯一加载，第 12 行 14:56:18.381 返回，37 行 SHA-256 `dc17e959e4fa55500cb4b22b7c575f6b9144239d69010227d64891de31b15a12`。随后正常保存退出 Farfold。完全关闭时的本机 `closed-queue.json` SHA-256 `06cfddbfd580fd400f9bef24f3b95409747a5b5cc823ada17c411ea52f5ab994`，同队列摘要保持。重新启动并从侧栏打开同一原会话后，14:58:39.836 再次只读核对，队列摘要、原顺序与图片字节一致。厂商历史仅有 A、原调用、其结果及原助手回复四条。

冷开界面保留此前请求未确认、未自动重发的提示。待发 B 显示图片，C 仍在 B 之后。打开「核对附件」，确认原勾选项「图片 待发消息 1」，点「保留所选附件」。只点击一次「继续发送」。界面先显示 B 已发送，C 仍是一条待发，随后显示两条完成；B 仍有原图片入口。冷开和本次发送共用同一 `protocol-v1-1795071504899-0.jsonl`，原 ID 的前 17 行中第 9、14 行为 14:58:25.215 的唯一加载和 14:58:31.229 的回执，无发送、新建或停止。前缀 SHA-256 `50365bc87a48e4c01cd00e77b14d89ab7cb413d9c5ea857f8886b5e04c363f2d`。

| 真实后续请求 | 原连接时序                                                       | Cline 原历史                                               |
| ------------ | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| B            | 第 18 行 14:59:05.929 唯一发送，第 23 行 14:59:08.319 成功响应。 | 第 5、6 条为唯一 B 用户文字和准确回复，两条都只有 `text`。 |
| C            | 第 24 行 14:59:08.362 唯一发送，第 29 行 14:59:10.224 成功响应。 | 第 7、8 条为唯一 C 用户文字和准确回复。                    |

冷开协议前 29 行 SHA-256 `e2a9a6abc7e08dbb24e6677c6fd7ab1d74fd10821f244078d9f544990d5c8c29`，未新增工具审批。厂商 `1795071291095_hnmj5_cli.messages.json` 在 14:59:15.905 共八条记录，SHA-256 `371f255f4c81ed38ed3dd39247a152a051a0a2b1cce3897d0d96339b8f50761e`。原 `call-b98fddb2-45dc-4efb-8e1b-99112daf38bc` 仍只有一次调用与一次结果。原启动标记 `front-started.txt` 与自然完成标记的时间、内容均保持，启动文件 SHA-256 `26defb07bb194799129412482bfeefaf70e2ab32d1443a78fbc4eb457d00d5af`。队列清空，原 A 的未知保护仍留存。

## Cline 报告能收图，但当前发送实现只转交文字

Farfold 同一连接的原始请求字节诊断中，B 是 535 字节，C 是 224 字节。两段受控文字的 UTF-8 长度相同。原 PNG 的 Base64、MIME、原文件 URI 组成的紧凑 `image` 块与分隔符共增加 311 字节，吻合诊断差值。Farfold 发送入口将图片块的资料、媒体类型及文件 URI 一起交给协议。字节数不能代替接收方收到原图的证明。 [发送字段](../../../src/runtime/prompt_blocks.ts) · [请求字节诊断](../../../src-tauri/src/acp_client/process_bridge.rs)

实际 Cline 原会话 B 只有文字。对应该会话的两份 JSON 及厂商 Hook 和 Hub 事件，没有发现 PNG 数据或源图片路径。官方发行 `cli-v3.0.74` 的 `initialize` 报告支持图片，同一版本的 `prompt` 经 `extractTextFromContentBlocks` 只保留文字，传给 `sessionManager.send` 的也是该文字。当前通过的是原图保存与核对、明确继续后原 B 和 C 的文字各发送一次、原任务不重跑。图片经 Cline 官方入口送达模型的条件未通过，需厂商保留原图片块再按同一场景复验。 [声明图片能力](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/acp/acpAgent.ts#L128-L140) · [提取文字](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/acp/acpAgent.ts#L894-L899) · [传给处理器](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/acp/acpAgent.ts#L370-L378)
