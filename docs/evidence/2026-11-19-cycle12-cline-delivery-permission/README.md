# 第 12 周期 Cline 成品直达、拒绝与撤销待提交批准

2026-11-19，macOS arm64 正式 Farfold 0.1.7 `5e12e06d9`，CDHash `4e5bba7028bdabce14eb3dd531844654e8b611ce`。从普通新对话使用 Cline 3.0.74 已有服务、免费模型 `nvidia/nemotron-3.5-super-vl:free` 和 Act。自动批准关闭。四条验收消息同属原会话 `1795061864402_p7fUF_cli`，工作目录 `/private/tmp/ff-c12-n19-verify.o6X6wIFJ/cline`，均由手动发送。既有旧成品样本的临时目录已清理，使用新的自建文件与目录。 [原手动预览证据](../2026-11-16-cycle12-eight-check/README.md#cline-文件交付)

## 从对话直接打开成品

1. 唯一一次批准写入精确路径 `result.txt` 的 `editor` 步骤。Agent 随后又请求 `read_files` 读取该文件，从原读卡拒绝。原轮最后回复 `FF_C12_N19_CLINE_DONE`。写入工具输入和磁盘成品都只有 `FF_C12_N19_CLINE_RESULT` 的 23 个字节，均无末尾 LF。原请求明确要求 LF，因此保留字节一致与末尾换行缺项，多提出一次读取也按实际行为留证。
2. 从该轮「本轮产物 1」进入，显示 0 个文件位置，唯一输出来自刚被拒绝的读取。写入原步骤未出现文件直达路径。Cline 活动回执仅报告工具状态与 `rawOutput`，重开回放将工具结果展平为文本。官方执行器的输出可能携带 `query`、`result`、`success`，后置钩子仍可在上报前完整替换它。自动「本轮产物」仍需同一实际写入步骤提供可靠的结构化路径、差异或本地资源。 [活动更新](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/acp/session-updates.ts#L137-L147) · [历史回放](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/acp/session-load.ts#L137-L155) · [工具结果处理](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/sdk/packages/agents/src/agent-runtime.ts#L2636-L2677)
3. 在同一对话发一条纯文字续问，要求只给该成品链接。Agent 正文准确返回 `[打开成品](./result.txt)`，零工具或审批。点正文中的「打开成品」，直接预览准确内容。此处验证已有的正文文件链接，自动从工具提取产物独立待验。

[自建原稿](fixture/input.txt) 40 字节，SHA-256 `f7a27924710375baa04b6845c5657494b91dde58d81f64bca93a7884a6112b71`。[实测成品](fixture/result.txt) 23 字节，SHA-256 `c2ea98e715d0184086fe472471d80a1a28965c113e9f3cabcd4ecbd9589bd1b2`，与同一写入步骤 `new_text` 的摘要相同。

## 拒绝与提交前撤销

- **直接拒绝。** 核对 `deny.txt` 的实际 `editor` 申请，点一次「拒绝」。界面显示「已拒绝 · 已告知 Agent」，原工具结果标为错误并说明该调用被用户拒绝。随后答 `FF_C12_N19_CLINE_DENIED`。目录没有 `deny.txt`。
- **撤销待提交批准。** 核对 `undo.txt` 的实际 `editor` 申请。选「批准并记住」后，在 Farfold 的 5 秒延迟提交窗口内约 1.4 秒点「撤销」。同一张审批卡重新等待选择，随后仅点「拒绝」。独立核对原请求只发出最后那次拒绝，未发批准。原工具结果标为错误并说明该调用被用户拒绝，回复 `FF_C12_N19_CLINE_UNDO_DENIED`，目录没有 `undo.txt`。 [Farfold 撤销实现](../../../src/runtime/interaction_actions.ts#L110-L155)
- **已生效的持久规则。** 同版 Cline 虽声明 `Allow always`，实际处理只返回和 `Allow once` 一样的单次批准结果，缺少可查询或逐条撤回的规则。独立的 `auto_approve` 是当前对话全部工具的布尔开关，本批没有启用。此处只覆盖撤销待提交选择，没有创建持久授权或验到撤回后续工具的规则。 [官方批准语义](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/acp/permissions.ts#L73-L85) · [官方自动批准作用域](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/acp/acpAgent.ts#L703-L710)

## 原件定位

Farfold `protocol-v1-1795061863594-2.jsonl` 当次 65 行，SHA-256 `f77855acbff6c618365e3b351a0e39b557b72f4a73bbd9c74fc29287fa74074d`，一次新建、四次手动发送、四次审批请求和四个审批响应，零取消或重建。原 Cline `.cline/data/sessions/1795061864402_p7fUF_cli/1795061864402_p7fUF_cli.messages.json` 当次 16 条消息，SHA-256 `653e14a0654ecead541ff84b5844ae12a744bd4461c4190d348353d871b3f826`。两组证据按同轮及原工具合看，Farfold 协议诊断记录响应帧，原 Cline 消息分别记录执行或拒绝结果。时间为 UTC+8。

| 场景 | Farfold 协议行                                                 | Cline 原记录                                                                                                                                            |
| ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FILE | 14 唯一发送，16／17 一次写入批准，22／23 额外读取被拒，32 结束 | 消息 2／3 为 `call-819d023f-c753-4a92-af64-6ccf23ec4f15` 的写入与结果，4／5 为 `call-3ccb22ca-1e0d-4225-8a3d-39807bfcfe6a` 的额外读取与拒绝，6 为原答。 |
| LINK | 33 唯一发送，38 结束，零审批和工具                             | 消息 7 为只要链接，8 为确切的相对路径 Markdown 链接。                                                                                                   |
| DENY | 39 唯一发送，41／42 原审批与拒绝，51 结束                      | 消息 10／11 为 `call-4126c654-d80e-4c2c-ab82-e19b1003387d` 的请求与拒绝，12 为原答。                                                                    |
| UNDO | 52 唯一发送，54 原审批，55 唯一响应，12:27:02.911，65 结束     | 消息 14／15 为 `call-58b2da0c-606b-420e-90ce-3d2a8a297a98` 的请求与最终拒绝，16 为原答。                                                                |

四轮的实际回复由同一 `nvidia/nemotron-3.5-super-vl:free` 返回。本次保留安装、账号、服务及原工作配置，未更改程序，也未新建撤回规则。其余工具、自动成品与持久规则仍依各自原条件。
