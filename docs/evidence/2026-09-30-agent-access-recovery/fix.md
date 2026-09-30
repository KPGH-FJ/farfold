# 已结算短测的重查恢复

2026-09-30；修复基线 `85235cd6768045396258ff0bf66cdee55403a1b6` 加本次工作区差异。本记录只覆盖控制器及真实前端会话状态的回归，IPC 用受控响应；修复后的正式安装验证由根任务继续，尚未据此宣称安装版通过。

## 问题与根因

根任务在前一正式候选记录：Amp 显式短测返回认证失败后，重新检查连接已经更换进程，但准备页面一直显示“暂离并保留进度”，模型来源不可选择。前一候选的原始观察保留在 [uvx 证据](../2026-09-30-agent-access-uvx/)，不与本次修复结果合并。

源码核对及红测证实：`AgentPreparation.invalidate()` 给已结算的 attempt 标记取消但仍保留观察；正常重查关闭旧连接时，`observe()` 的取消分支仅因 `connectionLost` 把它改成 `unknown`。`AgentSetup.operationPending` 因此继续为真，外观类似认证忙状态；不是由 `AgentAuthSection` 忘记归零本地 busy 所致。

真实会话状态已经区分空闲断开与未完成请求断开，分别由 `connectionOutcomeUnknown=false/true` 表示。但准备控制器的 `outstanding()` 原先未计入该字段，导致真正未完成请求断开后 `canPrepare()` 又可能放行。

## 最小修改

- [agent_preparation.ts](../../../src/runtime/agent_preparation.ts)：失效时，仅对已有明确结束收据（或明确拒绝/排队未发送）、发送回执已返回、且没有未决执行的 attempt 解除观察；保留对应对话、消息和选择事实，准备结果改为失效。`replyReceived !== undefined` 表示结束来自 `applyTurnEnd` 的真实请求收据（认证失败且无回复也会写 `false`），区别于断线生成、缺此字段的合成终态。
- 未完成请求仍保留原 attempt；`outstanding()` 增加已有的 `connectionOutcomeUnknown`，避免连接结束就丢掉未知结果保护。
- [sessions.preparation-recovery.test.ts](../../../src/runtime/sessions.preparation-recovery.test.ts)：使用实际 `threads`、`AgentPreparation` 与 `recheckAuthentication`，从通道注入模型读取、短测结束和旧连接关闭的真实顺序。

没有修改认证协议、安装、服务配置、契约或正式应用；没有读取账号凭据、调用外部 Agent 或修改用户数据。

## 回归与边界

| 用例                                           | 本次结果                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| 短测已明确认证失败 → 失效 → 正常重查关闭旧连接 | 准备保持失效，可显式重新读取模型；原请求认证要求保留 |
| 短测已明确成功 → 失效 → 正常重查关闭旧连接     | 不再显示结果未知；原成功不继续充当当前验证           |
| 正在运行 → 失效/取消 → 连接丢失                | 保留未知状态，不允许重复短测或重新准备               |
| 停止未确认 → 连接丢失                          | 保留未知状态，不允许重复短测或重新准备               |
| 发送是否接收未知 → 失效 → 连接丢失             | 未确认输入和原对话仍保留，不允许重复发送             |
| 重查及显式模型读取                             | 不自动发送新消息，保留已建立测试对话及结束事实       |

[红测](preparation-recheck-red.log)：新 5 例中 4 例失败，分别复现两类已结算误报和两类实际未知保护遗漏；原 uncertain 输入保护通过。

[绿测](preparation-recheck-green.log)：以下 4 个定向文件共 30 例通过。既有取消发生在发送回执返回前、迟到结果、待审批、认证分层与原选择保护用例也在本次定向范围内。

```sh
corepack pnpm exec vitest run src/runtime/sessions.preparation-recovery.test.ts src/runtime/agent_preparation.test.ts src/runtime/sessions.auth-recovery.test.ts src/runtime/sessions.preparation.test.ts
```

格式检查与差异空白检查通过。全量检查、打包和修复后的正式安装旅程未由本子任务执行；真实 Amp 重查后继续读取模型、认证失败保护和正常离开准备页面须由根任务验证。
