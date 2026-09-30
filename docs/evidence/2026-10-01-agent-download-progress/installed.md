# 安装结果：实际下载量、短测与冷恢复

2026-10-01 07:16–07:29，唯一正式应用为 `7a23471ff74a018e70aa5a69bc7294fb212e7149`，二进制 `cd602976da68121aab92d68f0137fcdc79ab8a0145d6c0a6906c4b02c01e7b63`。[安装收据](candidate-install.json)四文件相同、签名通过，[432 输入](candidate-source.json)至最终退出未变。前端 1,150 项、类型/构建/格式通过；后端 115 项输入不变，复用 494 Rust（3 既有忽略）及 fmt/clippy；[独立审查](review.md)无新增阻断。

## 已测操作

| 操作                   | 实际结果                                                                                                                                                                                        | 证据                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Junie 官方目录下载读数 | 实际从 58.3 MiB 增至 168.2 MiB，再观察到 211.7 MiB；总量 319 MiB。准备与程序管理两处数值相同，未展示估算速度/剩余时间                                                                           | [首份读数](01-download-first.png)、[同一下载两处显示](02-download-management.png)、[对应 AX](download-management.txt)                                  |
| 从程序管理取消同一下载 | 返回“安装已取消，原设置保持不变”，两处旧读数消失，安装入口恢复；Junie 未登记、无候选目录                                                                                                        | [取消截图](03-download-cancelled.png)、[登记核对](junie-cancelled-registration.json)、[取消后原数据核对](after-download-cancel.json)                   |
| Dirac 0.5.17 明确短测  | 保留 `~anthropic/claude-fable-latest` / Medium / Off；一次显式消息后 Agent 自行显示三次 API retry，随后提出 `API Request Failed` 处理请求。选择单次拒绝，界面确认已告知并结束；没有成功标记回复 | [原选择与消息](04-dirac-before-prompt.png)、[失败及批准入口](05-dirac-request-failed.png)、[单次拒绝结果](06-dirac-rejected.png)                       |
| siGit 1.5.11 明确短测  | 保留当前 `Qwen 2.5 3B - 32K ctx [Onde]`；实际返回尚未载入设备模型并提示 `/load`，未通过短测                                                                                                     | [原选择](07-sigit-before-prompt.png)、[实际结果](08-sigit-no-model.png)、[所存精确模型](new-test-sessions.json)为 `bartowski/Qwen2.5-3B-Instruct-GGUF` |
| 两条测试冷恢复         | 正常退出确认四个已观察身份结束后重开，同一两个 native session 均打开失败，界面提供重连/设置出口。未重试或补发消息                                                                               | [siGit 失败](09-sigit-cold-failed.png)、[Dirac 失败](10-dirac-cold-result.png)、[冷启动前退出核对](cold-restart-exit.json)                             |
| 返回原稿               | 原 Amp 已有设置的空稿返回，原未发字段保持                                                                                                                                                       | [原稿](11-original-draft.png)、[最终核对](after-exit.json)                                                                                             |

本次取消发生在下载阶段，不把它说成 Junie 安装或握手成功，也不覆盖此前初始化失败。未知下载总量、依赖安装与跨 Agent 进度隔离只在本片受控测试覆盖，未额外制造真实依赖重装。

[协议元数据](protocol-metadata-final.json)共六文件、两次 prompt，分别对应 Dirac/siGit 首测；冷恢复没有自动重发。恢复阶段两者都有成功初始化、出站 `session/load` 和非错误的入站响应，但前端仍失败。元数据不含响应正文，尚不能确定是否模型漂移、响应格式、历史或 Farfold 恢复处理导致，进入源码与受控复现调查。没有从该证据认定全部属于外部限制或已经修复。

siGit 的快捷指令按钮现场仅显示三个通用预设，见[菜单记录](sigit-commands.txt)；这不等于输入框 `/` 声明入口已检查，也不证明官方 `/load` 已执行。没有下载/载入本地模型或改账号。首发和续接都没有成功证据。

## 数据与退出

[07:29:24 核对](after-exit.json)：原 33 条索引和 37 个启动配置保持；新增两条明确失败测试，共 35 条索引。原未发字段的版本、草稿、选择、反馈、队列、活动项摘要保持；`agentSetup.v1` 和 `unsentWork.v1` 设置因本次准备/测试变化，不能声称 46 项设置全部不变。新测试的模型、推理与已有设置来源见[精确索引投影](new-test-sessions.json)。未读取全部外部配置/历史，因此不宣称其全量不变。

[累计八个采样身份](all-observed-processes.json)在最终退出时按全局 PID+启动时间核对均不存在；结果只限已观察身份。[重复应用清理](duplicate-app-cleanup.json)核对四文件后只移除本片构建副本，正式应用保留。下一步优先查清两项冷恢复失败；Messages 服务交付与 siGit 载入路线另做官方静态核对，不冒充已实现。
