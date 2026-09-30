# D1 / D3 / D4 / D5 原型覆盖核对

2026-09-30，本轮重新按 `AGENTS.md`、`PRODUCT.md` §4/§7、活动计划 §00.14（含 §00.14.7）与唯一 `workbench/README.md` 核查。以下依据当前源码与本轮实际查看的图片；不是沿用 C4 的完成声明，也不代表完整安装验收。

原型源路径前缀：`.design/2026-09-26-agent-access-redesign/workbench/src/`。生产路径前缀：`src/`。表中的“源码覆盖”只表示找到对应真实实现及操作链，仍需最终安装候选按实际能力逐项验证；不把 mock、示例数据或旧候选证据升级为当前成功。

## 本轮实际查看的成对图片

- `03-new-pair.jpg`：左原型、右正式，已归一到相同逻辑尺寸。主标题、居中输入、底部选择工具栏、来源说明及建议入口结构相近。真实 Agent 未提供的思考/权限选项不能照搬样例。
- `05-{prototype,installed}-agent-picker.jpg`：标题、搜索、当前勾选、添加其他 Agent 均在；正式版 Claude Agent/Cline 占位图标被拉宽已报告主任务修复。不同条目准备状态属于真实数据差异。
- `06-{prototype,installed}-model-picker.jpg`：正式版约 400 项真实模型，具搜索、滚动和已选定位，底部确认/准备/API 管理可见；不要求复制原型短模型列表。
- `07-prototype-add-menu.jpg` / `07-installed-add-menu-before.jpg`：确认新稿添加入口的结构和 Agent 命令入口缺失，本轮已改源码，待最终安装复拍。

本子任务未操作桌面或浏览器。其他页面与运行状态仅作源码对照，实际观测由主任务另记。

## 逐项映射

| 域 / 操作                              | 原型组件与入口                                                       | 当前生产链                                                                                                              | 本轮结论 / 安装验证边界                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 默认新稿、建议填入                  | `NewConversationV2.jsx:126–337`                                      | `components/EmptyState.tsx:711–817`；共用 `Composer`                                                                    | 源码覆盖；本轮 03 图已核主结构。建议只填草稿，不发送。                                                                                                        |
| D1 Agent 搜索、勾选、去准备、返回      | `NewConversationV2.jsx:343–383`                                      | `NewConversationPickers.tsx:101–178`；`EmptyState.tsx:518–535,821`；App 原入口栈                                        | 源码覆盖；已确认选择保持、未确认转准备的守卫仍在。05 图占位图标问题由主任务修复。跨页/窄窗焦点仍需新候选复验。                                                |
| D1 来源/模型选择、明确应用、管理 API   | `NewConversationV2.jsx:387–498`                                      | `NewConversationPickers.tsx:183–494`；`EmptyState.tsx:537–636,832`                                                      | 源码覆盖；完整真实选项校验、应用回执核对、保存确认快照仍在；400 项搜索不重排也不自动应用。06 图已核。                                                         |
| D1 思考与权限的位置                    | `NewConversationV2.jsx:216–243`                                      | `EmptyState.tsx:681–682`；`ReasoningControl` / `PermissionControl`                                                      | 工具栏位置覆盖；选项只取真实能力。没有选项不构造示例值；具体真实效果待按 Agent 验证。                                                                         |
| D1 文件、文件夹、原始工作位置          | `NewConversationV2.jsx:139–158,500–570`                              | `Composer` 附件；`EmptyState.tsx:390,749–771`；资料夹回调复用 `pickProject`                                             | 原选目录、移除资料夹、附件保留均在。本轮把加号改为居中三项弹窗，文件夹仅接原回调；不改变目录/草稿归属。待安装验证系统选择器取消与焦点返回。                   |
| D1 Agent 命令入口                      | `NewConversationV2.jsx:527–533,573–599`                              | `Composer.tsx` 的 `addContents` 真实 `availableCommands` 列表                                                           | 原先只有键入 `/` 的能力，缺鼠标入口；本轮补入新稿弹窗。无声明命令显示真实空态，不复制 `/help`、`/compact` 示例。选择只填入草稿。                              |
| D1 文本/仅附件、首发失败保留、结果未知 | `NewConversationV2.jsx:254–301`；README 草稿规则                     | `Composer.tsx` 的 `canSend/doSend`；`EmptyState.tsx:403–471`；`runtime/new_conversation.ts` / `pending_conversation.ts` | 源码覆盖；等待接纳再消费草稿，未知目标有显式恢复/放弃处理。真实首发、失败/未知需最终候选按可用环境验证。                                                      |
| D1 草稿切页/重启、附件明确核对         | `DraftRecoveryNotice.jsx`、`AttachmentRecoveryDialog.jsx`            | `drafts.ts` / `draft_storage.ts`；`AttachmentRecovery.tsx` / `attachment_review.ts`；Composer 恢复门                    | 源码覆盖；未核对附件禁止发送/继续队列，确认不自动发。旧稿/意见不迁移、不清空。当前新候选冷恢复待实测。                                                        |
| D3 固定身份、就近新开                  | `ConversationComposer.jsx:218–267`                                   | `ThreadView.tsx:755–801` 身份弹层；固定 `SessionOptionsList` / `ReasoningControl`；App `goNew`                          | 字段和固定规则原已覆盖；缺“选择其他设置新开对话”已由主任务补接当前新稿，保持原稿和现有身份。                                                                  |
| D3 消息、附件、复制、回到最新          | `ConversationTranscript.jsx`；`Conversation.jsx` 对话区              | `ThreadView.tsx:546–628,727`；`thread-items.tsx` 的消息附件/复制按钮                                                    | 源码覆盖；用户/Agent 消息、原始附件、可读复制、上翻停止跟滚和回到最新均在。长消息/中文/窄窗待最终图与键盘验证。                                               |
| D3 步骤展开、状态、真实内容入口        | `ConversationEngineering.jsx` / `WorkspaceConversation.jsx`          | `ThreadView.tsx:480–542`；`ToolStep` / `ToolDetail`；真实 `toolActivityState`                                           | 源码覆盖；普通步骤折叠，审批另列可见；仅存在内容时提供入口。工具尾程不冒充结束。                                                                              |
| D3 恢复失败、模型/来源不一致的出口     | `Conversation.jsx` recovery/readonly/unknown 分支                    | `ThreadView.tsx:358–463`；`history_continuation` / sessions 恢复路径                                                    | 源码覆盖；无法恢复不伪装空白成功，保持旧身份并提供对应检查或新稿。真实历史能力仍按 Agent 返回判断。                                                           |
| D4 待处理提示、审批原请求、真实选项    | `ConversationTranscript.jsx:34–59`；`ConversationParts.jsx:233–344`  | `ThreadView.tsx:650–727`；`ApprovalCard` / `ToolInput`；`interaction_actions.ts`                                        | 源码覆盖；选项 ID/原始输入归原请求，明确一次/记住/拒绝；提交失败/未知保留真实状态。记住批准的真实效果仍需安装证明。                                           |
| D4 提问选择、补充、提交/取消           | `ConversationTranscript.jsx:60–140`                                  | `ElicitationCard.tsx`；`interaction_actions.ts:149`                                                                     | 按实际 schema 渲染字段，不复制原型固定问题；保留每个请求的输入，提交/取消归同一请求。真实 form 能力及布局待实测。                                             |
| D4 停止等待期间审批/提问保护           | `ConversationTranscript.jsx:47,85,114,132`                           | `ThreadView` 禁用传递/快捷键守卫；`ElicitationCard`；`ApprovalCard`；`interaction_actions`；`sessions.cancel`           | 确认原生产遗漏，本轮补齐。仅停止等待禁用；未知不假成功、不删除原请求。停止时撤回未提交本地批准，防 5 秒倒计时跨过停止失败后自动提交；已提交请求仍等真实回执。 |
| D4 权限更改、扩大确认、未知恢复        | `PermissionControl.jsx` / `useConversationPermission.js`             | `PermissionControl.tsx:18–184`；`sessions.setConfig/confirmConfig`                                                      | 源码覆盖；真实选项/描述、确认、回执匹配；运行、工具尾程、审批、停止等待时保护变更。未知暂停发送，恢复不自动续队列。                                           |
| D4 运行时停止与鼠标加入待发            | `ConversationComposer.jsx:322–360`                                   | `Composer.tsx:1296–1329` → 原 `doSend/threads.send`                                                                     | 原生产按钮互斥导致仅 Enter 可入队，本轮恢复同时可见的停止/待发按钮。原准入与停止守卫不变；待安装验证鼠标路径。                                                |
| D4 快捷填入 / 项目文件查找             | `ConversationComposer.jsx:169–207,285–318`                           | `Composer` 本地快捷指令；本轮添加菜单 → `findProjectFile` → 原 `@` 查询                                                 | 本地快捷模板原已覆盖；本轮补“查找项目文件”显式入口。保留既有正文/附件，仅补 `@` 并聚焦，不发送。                                                              |
| D4 待发列表、编辑、移除、继续          | `Conversation.jsx:1080–1169,1332–1390`                               | `Composer.tsx:862–1100`；`queue_edit.ts` / `queue.ts`                                                                   | 源码覆盖；独立编辑稿、目标校验、暂停保留、明确继续，未知请求不自动重发。位置恢复使用通用 `setLocation`，仍不发队列。                                          |
| D4 停止等待/失败未知/重试/真实结束     | `ConversationComposer.jsx:39–73`；README 停止规则                    | `Composer` 停止状态；`stop_confirmation.ts`；`sessions.cancel`；`applyTurnEnd`                                          | 源码覆盖。失败按可能送达呈现未知而非宣称未发送；回复停止和工具真正结束独立。真实等待、重试和原请求归属需最终候选观察。                                        |
| D4 多对话独立、切页后状态              | README 草稿与对话；Conversation `active`                             | thread key 独立状态；App 保留页；组件 `active` 守卫；Sidebar 状态                                                       | 源码覆盖，不引入全局执行锁；本轮未操作 App，不能将过往双 Agent 实测转标。                                                                                     |
| D5 三栏、内容入口、范围、关闭/调宽     | `Conversation.jsx:1262/1279`；`WorkspacePanel.jsx:266–380`           | `ThreadView` 独立 `ArtifactPane`；`ArtifactPane.tsx:271–343`；内容 CSS                                                  | 源码覆盖；顶栏下显示步骤/本轮范围，返回本轮/全部内容；空内容仍显示诚实空态。当前宽窄窗尺寸、顶栏结构待成对图确认。                                            |
| D5 代码差异/前后文本/并排/复制         | `WorkspacePanel.jsx:81–147,333–380`；`ConversationParts.jsx:564–615` | `FileArtifactView.tsx:125–243,426–600`；`artifact_view.ts`                                                              | 源码覆盖；统一/并排、前/后、复制 ± 差异和真实路径；行号按已返回片段/文件证据标识，不读磁盘补全文。                                                            |
| D5 文稿前后对照/阅读/源码              | `WorkspacePanel` document 模式                                       | `FileArtifactView.tsx:318–329,568–591`                                                                                  | 源码覆盖；实际 Markdown 判定，可读前/后和源码；没有旧文本不造旧版本。真实文件输出及长文布局待安装验证。                                                       |
| D5 静态网页/源码/窄宽预览              | `WorkspacePanel.jsx:255–264,384–404`                                 | `FileArtifactView.tsx:246–263,490–505,595–601`；`artifact_view.ts:139–170`                                              | 源码覆盖静态预览，外链/脚本/导航禁用。只用返回 HTML，不加载项目磁盘或网络资源；没有充分 HTML 结构则无假预览。                                                 |
| D5 运行输出、活动筛选、复制            | `ConversationParts.jsx:687–714`；`WorkspacePanel.jsx:425–446`        | `ArtifactPane.tsx:143–193,355–396`；`runtime/artifacts.ts`                                                              | 原缺筛选，本轮补全部/命令/日志/工具错误；错误只取真实 tool status，包含失败命令。复制当前筛选内容，空筛选不可复制，迟到复制结果不串范围。                     |
| D5 意见位置/范围、带回输入             | `FileFeedback.jsx`                                                   | `FileArtifactView.tsx:608–691`；`file_feedback.ts`；`fileFeedbackDrafts.take`                                           | 源码覆盖；行点击、可选手输范围、片段边界校验，带回同对话草稿且不自动发。切侧/非法范围不冒充有效位置。                                                         |
| D5 版本意见、切文件/关闭/重启找回      | `FileFeedback.jsx`；README 草稿规则                                  | 内容摘要+thread/path 的意见；`FileFeedbackDrafts.tsx`；`ThreadView.tsx:738`；`draft_storage.ts`                         | 源码覆盖；旧版本意见保留独立入口，未重读位置明确提示，内容不可重放仍能找回意见。新候选冷恢复需实证。                                                          |
| D5 窄窗焦点与背景审批隔离              | 原型内容栏覆盖和弹层退出                                             | `ArtifactPane.tsx:76–139`；CSS 1100px；`ThreadView` inert 快捷键检查                                                    | 源码覆盖：覆盖主区 inert、关闭按钮接焦点、关闭恢复可用旧焦点；IME/内层弹层优先。侧栏仍可导航，非全局模态锁。最终安装需复验 Tab/Shift-Tab/Esc/窗口缩放。       |

## 能力与证据边界

- `c5-24-location-resumed.jpg` 中冷恢复的文件链接与 `<context>` 正文属于普通用户文本。实际安装的官方 `@agentclientprotocol/codex-acp 1.13.1` 在 `dist/index.js:34308–34318` 将资源转成普通文本且 `text_elements` 为空；`39394–39403,39449–39452` 的历史转换只返回文本及消息 ID，没有可靠的附件来源标记。Farfold 后端保留事件原文，前端仅按声明的内容类型识别附件；不能凭文本格式猜测还原或隐藏用户正文。本结论依据该安装版本的转换源码与截图，未捕获原始协议包、未读取用户历史。
- 真正结构化附件的紧凑呈现与原型存在明确差距：原型 `ConversationParts.jsx:147–162` 显示文件项，C6 的 `MessageContent.tsx` 仍直接展开完整 URI 和文本。后续源码已改为默认收起的文件项，显式展开保留原有路径、文本与支持的媒体，并隔离附件键盘操作与对话审批；相关 21 项测试、类型及定向格式检查通过，尚待下一安装候选的真实资源样本验证。此局部呈现调整不解析、也不能还原上述 Codex 普通文本历史。
- 原型 `WorkspacePanel` 的结构化 `data.tests/findings`、失败测试关联代码是模拟结构；当前官方工具事件没有统一等价字段。当前显示真实输出/明确失败标记，不解析自然语言造测试通过数、耗时或关联文件。
- 命令输出有现存 64 KiB 捕获上限、200 行默认显示及截断提示；本轮筛选没有扩大已收到的内容，也不将其称为完整原始日志。
- 静态 HTML 只展示本次返回内容和允许的内联样式；不宣称动态应用或外部资源已经成功运行。原型注入的示例 CSS/图片不是当前正式事件能力证据。
- 账号、权限作用效果、记住批准、真实提问能力，以及新候选停止未知/重启/完整键盘，不能从上述源码和单元测试推出安装通过。

## 本片验证

新增回归先在原实现失败：鼠标待发、项目文件入口、新稿添加弹窗；输出筛选/筛选后迟到复制；停止等待期间批准/回答和本地倒计时；停止立即失败后旧批准不得自动提交。修复后定向结果见 `conversation-targeted.log`，类型结果见 `conversation-typecheck.log`。主任务最终安装和集成检查另记，不能以本片结果关闭 G2/G3。
