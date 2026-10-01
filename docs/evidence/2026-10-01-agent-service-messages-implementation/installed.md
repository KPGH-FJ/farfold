# Messages 接入：实现与安装版部分验证

`637e1ef` 于 2026-10-01 10:19 安装到唯一 `/Applications/Farfold.app`，二进制 `80be4987bfa542147a418edde15753dadfd42f8ad6a25cbd5ab79a8ac3dbec83`。四文件复制一致、签名检查退出 0；[安装收据](candidate-install.json)、[437 项输入冻结](candidate-source.json)及[退出核对](after-exit.json)一致。本片已安装功能，但 **Messages 的安装版密钥交付、真实云端首发和续接尚未验收**。

## 已实现与工程验证

- OpenCode 增加 Messages；中央 API 检查与 Agent 配置共用基础地址规则，每个模型明确 API ID 与接口实现。其他 Agent 的准入保持。见[后端实现及红绿](backend.md)、[独立审查](review.md)。
- [完整 Rust 检查](checks-rust-final.json)为 501 通过、3 项既有忽略，fmt/clippy 退出 0。[312 个前端输入](frontend-reuse.json)与前片一致，复用 1,211 项全量、后续相同文案归位的 184 项定向和类型检查；本候选[重新打包](checks-bundle-final.json)及[全仓格式](checks-format-final.json)通过。Vite 仍有既有大块体积提示，无打包错误。
- 实际 OpenCode 1.18.31 与本地受控服务的两来源首次/冷续接已通过，见[独立探针结果](../2026-10-01-agent-service-messages/actual-opencode-messages-results.md)。这与下面的正式界面验证分层，不能合成生产 IPC、Keychain 和云服务全链通过。

## 本候选实际界面

| 路径                | 结果与证据                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API 目录 → 添加     | [目录为空](01-api-empty.png)，与只读服务元数据一致。表单可选三种接口；选择 Messages 后无 Key/模型时，读取、测试和保存禁用，见[表单](02-messages-unsaved.png)及[完整 AX](02-messages-unsaved.txt)。没有填写密钥、保存或发送 API 请求。                               |
| 未保存返回          | 取消出现保护提示；取消该提示后把本轮格式选择恢复为初始 Chat，再正常关闭空表单，目录仍为空。未确认放弃用户数据。                                                                                                                                                     |
| 原 OpenCode 历史    | 原 `ses_f0e8e5a03ffeHDMo5rR4YFfsaM` 冷读取成功，五组历史固定回复全部可见，最新为 `FARFOLD-HISTORY-RECOVERY-OK`，见[历史](03-opencode-history.png)。[只读选择](04-opencode-selection.png)保持已有设置及 OpenCode Zen/Nemotron 3 Ultra Free，没有改模型或发送新消息。 |
| OpenCode 管理 → API | [没有已保存服务](05-opencode-api-empty.png)时选择值为空、保存设置禁用；页面说明保存后仍需回来选择。随后恢复原本机配置选项，暂时返回，没有保存新来源。此结果不能证明已保存 Messages 服务能选用。                                                                     |
| 返回原稿            | 原 Amp / 已有设置空草稿保持，见[返回](06-original-draft.png)。                                                                                                                                                                                                      |

运行时间约 10:19:10–10:25:36。两份[协议元数据](protocol-metadata-final.json)中，Amp 初始化与新稿准备、OpenCode 初始化/旧历史读取及管理页模型准备均有记录，**零 prompt、零 authenticate**。不把 `session/new` 的模型准备算作新会话索引或实际回复。

## 原数据与退出

[退出核对](after-exit.json)中原 35 条索引、37 个启动配置、原未发内容/选择/反馈/队列/活动摘要全部保持，没有新索引。设置仅 `agentSetup.v1` 因本轮管理页操作变化；没有声称所有设置逐字不变。

[已观察身份集合](all-observed-processes.json)共 3 个，按 PID + 启动时间全局核对均已结束，正式应用后代为空；采样不能扩大为所有未观察进程的生命周期证明。[精确清理](duplicate-app-cleanup.json)核对同候选四文件后仅删除仓库打包副本，正式应用保持。

## 保留缺口与下一步

当前没有已保存 API 服务。Messages 的正式服务保存、Keychain 交付、中央真实读取/短测、选用与云端首次/冷续接需要具体服务和用户提供的授权条件，继续标为条件缺失未测。没有用假配置或已有设置的历史恢复代替这些出口；M4 与本计划整体未完成。

安装观察同时发现旧提示缺陷：全新空表单尚未填写 Key，仅切换格式就要求“重新填写密钥”，恢复原格式后提示仍在，见图 02。下一片收窄提示出现条件，保留实际地址/格式变更后的秘密清空与重新填写保护。本候选保留该失败，不倒填为已修复。
