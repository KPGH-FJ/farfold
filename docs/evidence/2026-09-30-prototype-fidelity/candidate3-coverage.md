# 候选三源码覆盖复核

仅为当前源码与认可原型的只读对照，不代替安装版验收或真实账号／服务能力验证。

| 原型页面／行为                                     | 生产入口                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 新对话、Agent／来源／模型选择及明确确认            | `EmptyState.tsx`、`NewConversationPickers.tsx`                                           |
| 发现、准备、日常管理、认证返回及冷恢复连接解释     | `AgentHub.tsx`、`AgentSetup.tsx`、`AgentSetupNavigation.tsx`                             |
| 对话步骤、审批、提问、停止、待发编辑及快捷指令     | `ThreadView.tsx`、`Composer.tsx`、`PermissionControl.tsx`                                |
| 步骤内容、真实差异／路径复制、意见行范围           | `ArtifactPane.tsx`、`FileArtifactView.tsx`、`file_feedback.ts`                           |
| 草稿及待发附件恢复、勾选移除、可读性检查、明确继续 | `AttachmentRecovery.tsx`、`attachment_review.ts`、`recovered_attachments.ts`、`queue.ts` |
| 整理、跨 Agent 筛选、保留历史、带入与返回          | `ConversationLibrary.tsx`、`ImportConversations.tsx`                                     |
| API、通用设置、数据与快捷键说明、LifeModel 边界    | `CredentialSettings.tsx`、`GeneralSettings.tsx`、`LifeModelSettings.tsx`                 |

最终只读复核发现的唯一新增确定遗漏为：移除自定义 Agent 接入但保留历史后，Agent 筛选选项缺失。现已合并当前目录、完整历史索引和当前筛选值，保留名称并稳定去重；新反例先失败、修复后通过。该修复之后未发现其他确定的原型功能遗漏。

附件恢复独立审查覆盖：草稿与队列所有权、取消／切页后的迟到结果、未知发送保护、队列编辑标记、全部检查成功后再同步应用、正文与顺序保全、确认不自动发送。未发现阻断问题。

新身份登录、真实密钥、外部权益与全部 Agent／模型组合仍须相应实际条件。API 来源补登录受官方接口能力限制；本轮没有借原型模拟状态宣称接入成功。通知与 LifeModel 真实采集／注入按已认可原型和产品契约保持说明边界。
