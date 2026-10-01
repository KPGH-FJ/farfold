# 准备选项保留：安装版有限验证

2026-10-01 21:47–21:57，源码 `ae23da5` 已安装到唯一 `/Applications/Farfold.app`，二进制 `45214b2d68d0bc93806ad83357663a6d06a0a3a88dc920d887a65f441400f94a`。复制差异为空、签名检查通过；[安装身份](candidate-install.json)、[455 输入清单](candidate-source.json)与[最终退出](after-exit.json)相互一致。受控损坏格式测试与本次正常 UI 旅程分别计证，不向正式设置注入异常。

| 阶段                                                                                          | 实际观测                                                                                                                |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [01](01-original-empty-draft.jpg) / [AX](01-original-empty-draft.txt)                         | 原 Amp / 已有设置空稿。                                                                                                 |
| [02](02-preparation-original-medium.jpg) / [AX](02-preparation-original-medium.txt)           | 从新稿模型选择进入准备与连接；Amp 已连接，Medium 已读取、沿用已有设置，仍提示“当前选择尚无成功回复”。没有主动改选模型。 |
| [03](03-returned-draft-preserved.jpg) / [AX](03-returned-draft-preserved.txt)                 | 暂时返回目录页，继续草稿入口可达；本画面没有显示输入标记，不能单凭它证明稿件正文。                                      |
| [04](04-original-draft-after-preparation.jpg) / [AX](04-original-draft-after-preparation.txt) | 明确继续草稿后，`FARFOLD-SETUP-OPTION-DRAFT-20261001` 原样可见，Amp / 已有设置保持。                                    |
| [05](05-cold-draft-preserved.jpg) / [AX](05-cold-draft-preserved.txt)                         | 正常退出后冷启动，同一标记和原来源仍可见。                                                                              |
| [06](06-cold-preparation-original-medium.jpg) / [AX](06-cold-preparation-original-medium.txt) | 再次进入准备页，Medium 已读取、沿用已有设置；仍无当前选择成功回复。                                                     |
| [07](07-original-empty-draft-restored.jpg) / [AX](07-original-empty-draft-restored.txt)       | 只经 UI 清除本片标记，恢复原 Amp / 已有设置空稿；最终未发数据核对补充原选择保持。                                       |

[基线](data-before.json)有 36 条索引、40 个 Agent 与 49 项设置。[第一次退出](cold-exited.json)时原未发字段均保持，只有自有 `composers.new` 增加；冷启动后保留标记。[清除后的核对](before-final-exit.json)及[最终退出](after-exit.json)中，原 36 索引和 40 行 Agent 摘要不变、无新增索引/设置，整份 `unsentWork.v1` 与全部原字段恢复，无新增未发根字段或容器键。Agent 比较覆盖基线 40 行，不扩大为新增 Agent 全表计数证明。[派生核对](comparison.json)保存上述原输入摘要和有限判定。

49 项原设置中仅 `agentSetup.v1` 的整体摘要变化。基线没有其 `progress`、`pending`、`completed` 或 `selections` 的内部快照，无法定位实际差异。源码说明正常新稿准备入口会创建或更新按 Agent/目录/选择分隔的进度；页签对应 step 0/1/2，连接后进入模型页、读取返回选项也可能保存进度，暂返并不回退已保存步骤。入口见 [AgentHub 的首次进度保存](../../../src/components/AgentHub.tsx:315)、[AgentSetup 的读取选项保存](../../../src/components/AgentSetup.tsx:364)及 [setupStorage.remember/flush](../../../src/runtime/setup_storage.ts:249)。这是正常导航可写进度的源码推断，不能据此断言本轮只改了 step、内部选择全保持或精确还原旧进度。UI 的原 Medium/已有来源与未发选择保持是独立观测。

[协议快照](protocol-metadata-final.json)覆盖安装至最终退出：2 文件、16 启动摘要、2 initialize、4 session/new、4 session/set_config_option、10 response、8 update、2 条仅字节数的 stderr 标记，记录拒绝数 0；prompt、authenticate、cancel、permission、load、list 均为 0。确有配置请求；它们与准备/恢复现有选择路径相容，但此元数据没有参数值，不能证明具体设置了什么。UI 未主动改变 Medium，也不能写成“零模型配置请求”。两文件最终摘要均为 accepted、reaped、groupEnded 和 connectionRemoved，TERM 请求为 true、KILL 为 false、退出 signal 15；这不把摘要条数当进程数。

[有限进程采样](all-observed-processes.json)的 4 个身份最终均不在，正式应用后代列表为空；不声称覆盖瞬时进程。[重复应用清理](duplicate-app-cleanup.json)精确匹配本轮 4 个应用文件后移除 bundle，正式应用保留。[原始字节保护](raw-format-preservation.json)的 7 份观测 JSON 未重写。

[工程证据与缺陷范围](README.md)：隔离红测 6 失败/26 通过，修复后 33 通过；完整前端 1,279 项、类型/构建/格式/打包通过。首次全量命令仅参数解析失败，未执行测试；原失败日志保留。141 个后台输入不变，复用四并发 575 通过、3 既有忽略，不另跑 Rust。[源码审查](source-review.md)是安装前记录，后续本页补充正常安装结果。

本片未执行新登录、首条消息、真实服务密钥交付、模型主动改选或正式损坏输入；不能把正常 UI 保留提升为异常正式数据拒绝的安装证明，也不关闭账号、未完成程序与全目录同候选出口。
