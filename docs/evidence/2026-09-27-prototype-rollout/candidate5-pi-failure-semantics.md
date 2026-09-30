# 候选五 Pi 本轮失败语义证据

结论：**本轮真实请求失败，当前完整交付未闭合。** Pi 自己的记录报告连接错误；已安装的官方接入包丢失失败语义，能够解释界面为何显示“已完成”。不是 Farfold 将 `error_done` 判为成功。未修改生产代码、Agent、安装版本或产品契约，未重发请求。

## 限定来源与实际结果

- 候选五主程序 SHA256：`b0d4cf6b47ff3fe175ad330d8d991bffd22b952307b6732deb603dfe63339d78`；身份见 [安装记录](candidate5-installed.json)。
- 只读取这条自有验收会话在 `2026-09-27T09:02:00Z`（17:02）至 `09:03:00Z` 之间的官方记录；原会话 ID 仅保存 SHA256，见 [允许字段明细](candidate5-pi-failure-semantics.json)。未复制提示正文、其他用户正文、推理或凭据。
- 第 14 行在 `09:02:10.608Z` 含本次精确目标标记。第 15–18 行依次为 `09:02:15.701Z`、`09:02:22.735Z`、`09:02:31.759Z`、`09:02:44.784Z`，均为助手 `stopReason: error`、`errorMessage: Connection error.`、内容空、用量全零。
- 该时窗工具调用记录 0、工具结果记录 0、目标助手回复 0；不能记 `/bin/sleep 60` 执行或并行验收成功。具体网络层原因未知，不能从这句错误继续归因。
- 操作者现场显示由重试文字进入“已完成”，见 [截图 64](screenshots/64-candidate5-pi-retry-without-task-result.png)。

## 失败语义丢失位置

只读进程检查确认 PID `61129`（父 PID `58909`）执行以下已安装包，`package.json` 版本为 `0.0.33`：

`/Users/tw/Library/Application Support/ai.farfold.desktop/agents/pi/0.0.33/node_modules/pi-acp/dist/index.js`

| 源码行    | 已核实行为                                                                |
| --------- | ------------------------------------------------------------------------- |
| 1174–1178 | `auto_retry_end` 无条件输出 `Retry finished, resuming.`，不判断是否成功。 |
| 1205–1210 | `turn_end` / `agent_end` 不传递助手失败。                                 |
| 1212–1215 | `agent_settled` 在未取消时一律结束为 `end_turn`。                         |
| 2434–2436 | `prompt` 结果为 `error` 时，未取消也转为 `end_turn`。                     |

Farfold [completion.ts](../../../src/runtime/completion.ts#L22) 在 22–43 行将明确 `error` / `failure` 判失败，只将 `end_turn` 判 `done`；`error_done` 会落入 `unknown`。现有 [FailureTracker](../../../src-tauri/src/acp_client/failures.rs#L10) 可归一化所支持的结构化失败，但本次已安装包并没有传出这份 Pi 错误。

## 证据边界与安全后续

本次原始 ACP 回执 envelope **没有捕获或落盘**；[诊断记录](../../../src-tauri/src/acp_client/tap.rs#L30) 只保留时间、方向、事件类型、字节数和协议错误标记。因此“本次收到 `end_turn`”是已运行包源码、Pi 官方结果与现场表现的对应解释，不能写成已逐字读取本次回执。

安全解决需官方接口保留可归属本次请求的结构化失败，然后沿 Farfold 既有通用失败处理呈现。不能按品牌或重试文本猜测，不用私有历史给产品兜底，不修改外部 Agent。只改“已完成”文案不能补回失败语义，也不能解决错误漏报后的自动续队列边界；当前 [PRODUCT 术语](../../../PRODUCT.md#L82) 的调整必须另行报告决策。
