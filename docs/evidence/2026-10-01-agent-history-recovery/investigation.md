# Dirac / siGit 冷恢复：读取保护与错误归类调查

2026-10-01。起点为正式候选 `7a23471` 的两项真实失败；本调查先只读对应脱敏收据、公开源码及 Farfold 恢复实现，再实施本片有限前端修复。没有再次启动真实 Agent、读取用户历史正文、凭据、外部配置或 stderr 正文。

## 实测事实与未知项

| 样本         | 已存测试 ID                            | 正式观察                                                                                                                                                                                                                                |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dirac 0.5.17 | `b888c42d-ea7c-4145-abba-e82f2029bc6d` | 首次短测失败后冷打开，界面显示“会话打开失败 / 重新连接失败，原内容已保留”；与 07:27:07 进程启动对应的 `protocol-v1-1790810827419-2.jsonl` 含成功 initialize、出站 session/load、一个无 error 的入站 response，之后两条 session/update。 |
| siGit 1.5.11 | `7a7b4261-aeff-4ec4-a521-6479a4239ac9` | 同样冷打开失败；与 07:26:13 进程启动对应的 `protocol-v1-1790810773188-1.jsonl` 含成功 initialize、出站 session/load；session/update 与随后无 error 的 response 同毫秒，数组中的 update 在前。                                           |

协议文件本身不含 Agent ID，以上对应结合 [冷恢复 cwd / 进程身份](../2026-10-01-agent-download-progress/cwd-restored.json)、[退出前启动时间](../2026-10-01-agent-download-progress/before-exit.json) 与两份界面时点核对；不能按数组位置给样本命名。

依据：[测试身份与原模型字段](../2026-10-01-agent-download-progress/new-test-sessions.json)、[Dirac 界面](../2026-10-01-agent-download-progress/dirac-cold-result.txt)、[siGit 界面](../2026-10-01-agent-download-progress/sigit-cold-failed.txt)、[协议元数据](../2026-10-01-agent-download-progress/protocol-metadata-final.json)。后者不保存请求 ID、response 的内部字段、更新类型或 Tauri channel 完成标记；时间相邻的 `response error:none` 不能单独证明 session_open IPC 已成功，也不能证明可读正文已回放。

调查前核对了 sessions、projection、附件判断、Rust session/pump/model_guard 等九项源码与 `7a23471` 的 [冻结输入](../2026-10-01-agent-download-progress/candidate-source.json)，均一致。本片后续源码与旧安装候选分开，不把本片受控测试写成上述正式失败的确证根因。

## 确定的 Farfold 机制

旧 [sessions.ts](../../../src/runtime/sessions.ts) 在 session_open 已返回 `resumed=true` 后，仍要求：本次 openToken 的完成标记已到达、未收到 connectionLost、回放至少包含可读用户消息或回复。正文判断见 [message_attachments.ts](../../../src/runtime/message_attachments.ts)：仅配置、命令声明、思考、工具或未知 envelope 不构成可读消息；有效附件可以构成可读消息。

这个准入保护是必要的。旧代码在空回放或标记缺失时抛出本地“未能完整读取对话内容”，统一 catch 又把它改为 `reconnectFailed` 并设置 `connectionLost=true`。因此能够明确复现的是**本地读取失败被错误显示为连接失败**；并未证明两项现场都命中了空回放分支。

Rust [session_commands.rs](../../../src-tauri/src/acp_client/session_commands.rs) 仅在后端打开成功、目标查询及 channel 回放检查通过后发送本次完成标记。部分后端后置错误仍可能使 IPC 失败。模型保护不匹配通常由 [model_guard.rs](../../../src-tauri/src/acp_client/model_guard.rs) 返回 ConfigCheck，再由前端阻止发送；它本身不是上述 `openError` catch 的抛错理由。新片保留这些保护与未知项。

## 已排除与仍待实证的候选

锁定 SDK 2.2.0 的 transport/incoming actor 按 FIFO 处理：通知动态处理器完成后才处理后续 response。Farfold 的 SessionRoute 同步把通知送入 inbox，load 前还有 route-registration fence。现有 [route_registration_tests.rs](../../../src-tauri/src/acp_client/route_registration_tests.rs) 明确验证 load 回复到达时，回复前的回放已在目标 inbox。因此“同一 wire 上回复前的回放仅因 SDK 动态路由尚未入队而错过 ready”没有得到源码支持；本调查没有重跑该测试。

Agent 在成功 load response **之后**才发出的更新不属于该屏障保证。安装元数据没有区分这些更新是否为配置、命令还是正文，不能据字节数推断内容，也不能把这个时序可能性写成当前根因。

Dirac 已安装的公开源码在 load 后调用 replay，找不到任务或读取历史失败时可直接返回、不产生正文；部分事件发送又不等待连接发送完成。这支持“load 成功但没有正文”作为候选，不证明该测试实际走了该分支。siGit 固定官方实现也允许未载入模型的提示在正常历史持久化之前返回，随后无历史的 load 仍成功；准确范围见 [官方空历史分支](upstream-empty-history.md)。没有检查两项外部历史文件。

## 最小修复与后续安装观察

本片保留原 readable / matching-marker 准入，在成功返回后的本地判断中生成有限的自有类型：`empty` 与 `incomplete`。真实 channel connectionLost 继续按连接失败处理；远端返回相同中文不转换成该本地类型。失败保留原正文、队列、未知执行和模型保护；成功 load 且本次无 loss 时清旧连接失败标记，不继承旧 owner 的实时工具状态。提供“重试读取”及显式独立新稿，不自动发送、不补造历史。成功结果中的 canonical cwd、service / serviceContext 用于保留原使用来源；缺少确认来源不能默认成已有设置。

无需新增后台诊断接口。本片正式安装复验若显示有限的“对话读取失败”文案，可直接证明：session_open IPC 成功后命中了哪一种本地准入失败；这仍不证明外部历史为何缺失。若仍为连接失败，则该窄候选被证伪，应继续核对应 IPC / lifecycle 层，而不能放宽正文准入。后续实际复验由根任务实施。

受控必要反例包括：配置-only 加匹配标记、可读部分但缺标记、真实连接丢失、远端同文案、canonical cwd 与冷 API 来源、新稿不继承正文/队列、不自动 prompt、迟到正文不放行、迟到真实 loss 只作用原 owner、成功重读仍执行模型保护。测试结果单独记录在 [前端实施](frontend.md)。
