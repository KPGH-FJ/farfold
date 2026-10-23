# Farfold 源码架构

更新：2026-10-22。本页说明当前源码的职责与约束；产品要求以 [PRODUCT.md](../PRODUCT.md) 为准，实际通过、失败、未测和接续安排分别见[当前状态](status.md)与[唯一活动计划](../plans/agent-access.md)。

唯一正式应用为 /Applications/Farfold.app，标识 ai.farfold.desktop，内部版本0.1.7、macOS arm64；实际安装的功能源码、程序摘要与验证范围集中见[当前状态](status.md)。后续文档或测试整理提交不等于重新安装，受控样本与安装静态核验不构成真实 Agent 或P13整项验收。

本次整理前的完整架构记录已逐字保存在[原文快照](archive/2026-10-17-documentation-alignment/docs/architecture.md)，包括各批安装、成功、失败与未知记录，其他原件见[归档索引](archive/2026-10-17-documentation-alignment/INDEX.md)。快照内的相对链接按其原位置 docs/architecture.md 解析；整理前仓库提交为 e3be55b4ba5cf385cb39bdf523feb75c5a26edf6。快照中的“当前”“下一步”和最初只读网页片段属于当时记录，不是本页的现行接口目录。

## 产品边界与调用链

Farfold 是独立的多 Agent 桌面产品。React工作台只有一套对话、输入、审批、资料和设置界面；外部 Agent 自己负责推理循环、工具执行、账号、模型、权限、历史、压缩、停止与恢复。接入层只能使用官方 ACP、SDK或CLI，不修改官方程序，也不代建第二套 Agent loop。

主链路为：React组件 → 前端运行时控制器 → Tauri命令 → 接入管理器及官方协议库 → 外部 Agent进程。返回事件经事件泵与通道交给前端归一化呈现。原始事件与未知 envelope 保留；可读投影不是另存的 Agent正文账本。官方协议库声明见 [Cargo.toml](../src-tauri/Cargo.toml)。

首发范围仍为[29家 × 八项标准](agent-first-release.md)。目录条目、可安装、握手、认证、请求、恢复、工具和真实用户效果分别判断。当前缺口不因同一界面、代表样本或测试数量而缩小；NEW-24受影响的新真实发送继续暂停，完整权限读回、OpenCode初始化和历史自动重开请求者仍有未知，详见状态页。

## 源码入口与职责

| 范围             | 主要入口                                                                                                                                                                                                                      | 职责                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 应用与共用工作台 | [App.tsx](../src/App.tsx)、[ThreadView.tsx](../src/components/ThreadView.tsx)、[Composer.tsx](../src/components/Composer.tsx)                                                                                                 | 组合导航、对话、输入、审批与内容，不按 Agent复制页面 |
| Agent目录和准备  | [agents.ts](../src/runtime/agents.ts)、[first_release.rs](../src-tauri/src/acp_client/first_release.rs)、[agent_catalog.rs](../src-tauri/src/agent_catalog.rs)                                                                | 首发过滤、发现、安装信息和共用准备流程               |
| 连接与会话       | [sessions.ts](../src/runtime/sessions.ts)、[manager.rs](../src-tauri/src/acp_client/manager.rs)、[session.rs](../src-tauri/src/acp_client/session.rs)、[session_commands.rs](../src-tauri/src/acp_client/session_commands.rs) | 官方连接、请求归属、配置、发送及恢复                 |
| 事件与呈现       | [pump.rs](../src-tauri/src/acp_client/pump.rs)、[session_projection.ts](../src/runtime/session_projection.ts)、[session_types.ts](../src/runtime/session_types.ts)                                                            | 转发原始事件，呈现消息、工具、任务及未知状态         |
| 登录与服务       | [auth.rs](../src-tauri/src/auth.rs)、[pty.rs](../src-tauri/src/pty.rs)、[credentials.rs](../src-tauri/src/credentials.rs)、[service_config.rs](../src-tauri/src/acp_client/service_config.rs)                                 | 官方认证、登录终端、系统凭据与已核服务配置           |
| 草稿与退出       | [draft_storage.ts](../src/runtime/draft_storage.ts)、[DraftStartup.tsx](../src/components/DraftStartup.tsx)、[EmptyState.tsx](../src/components/EmptyState.tsx)                                                               | 未发送内容、恢复、首条消息前准备与保存退出           |
| 文件与资料       | [OpenedFileView.tsx](../src/components/OpenedFileView.tsx)、[document_input.ts](../src/runtime/document_input.ts)、[file_access.rs](../src-tauri/src/file_access.rs)                                                          | 明确选择后的文件读取、格式解析、版本与意见           |
| 消息媒体         | [message_attachments.ts](../src/runtime/message_attachments.ts)、[MessageAttachmentMedia.tsx](../src/components/MessageAttachmentMedia.tsx)、[use_message_media_budget.ts](../src/runtime/use_message_media_budget.ts)        | 预览准入、显式展开、共享配额与来源退役               |
| 搜索             | [loaded_search.ts](../src/runtime/loaded_search.ts)、[history_search.ts](../src/runtime/history_search.ts)、[attachment_search.ts](../src/runtime/attachment_search.ts)                                                       | 分开已加载正文、所选官方历史与当前附件文字           |
| 完整上下文复制   | [session_fork.ts](../src/runtime/session_fork.ts)、[session_fork.rs](../src-tauri/src/acp_client/session_fork.rs)                                                                                                             | 官方复制能力、父子归属及未知结果保护                 |
| 网页             | [BrowserWorkspace.tsx](../src/components/BrowserWorkspace.tsx)、[browser_workspace.rs](../src-tauri/src/browser_workspace.rs)、[browser_sharing.rs](../src-tauri/src/browser_sharing.rs)                                      | 多标签、文件预览、页面许可与工具通道                 |
| 技能与MCP        | [AgentExtensionInventory.tsx](../src/components/AgentExtensionInventory.tsx)、[extension_inventory/mod.rs](../src-tauri/src/acp_client/extension_inventory/mod.rs)                                                            | 官方清单与临时范围，修改另行审阅                     |
| 工作位置         | [worktrees.ts](../src/runtime/worktrees.ts)、[worktrees/mod.rs](../src-tauri/src/worktrees/mod.rs)                                                                                                                            | 并行目录准备、归档、删除与独立恢复                   |
| 通知             | [success_notification.ts](../src/runtime/success_notification.ts)、[desktop_notifications.ts](../src/runtime/desktop_notifications.ts)、[desktop_notifications.rs](../src-tauri/src/desktop_notifications.rs)                 | 实际请求结束条件、独立偏好、系统提交与返回定位       |
| 元数据与故障恢复 | [meta_store/schema.rs](../src-tauri/src/meta_store/schema.rs)、[storage_recovery.rs](../src-tauri/src/storage_recovery.rs)、[StorageRecovery.tsx](../src/components/StorageRecovery.tsx)                                      | Farfold自有记录、存储故障与受限恢复                  |
| 进程与诊断       | [process.rs](../src-tauri/src/acp_client/process.rs)、[supervisor.rs](../src-tauri/src/supervisor.rs)、[diagnostics.rs](../src-tauri/src/diagnostics.rs)                                                                      | 子进程归属、退出确认与白名单诊断                     |

## 接入、认证和服务配置

[first_release.rs](../src-tauri/src/acp_client/first_release.rs) 是29项当前允许名单；目录缓存与实时目录都需过滤。少数内置发现入口只是发现已有程序的方式，不代表首发只覆盖这些程序。安装只执行官方目录或用户明确配置的命令；归档下载摘要用于校验下载，不把 Agent二进制摘要或固定版本当握手兼容性。

通用接入对象保持 id、command、args、env；兼容性由 initialize握手确认。不得清空继承环境、建立私有HOME、替 Agent写用户配置，或从项目目录读取启动配置。Agent差异限于接入层核过的官方能力、认证方法和配置选项；组件不新增专属面板。旧阶段的三个适配器、注册表和专属面板不保留兼容实现，历史删除记录仅在归档中。

认证由协议方法驱动：Agent认证调用 authenticate，终端认证使用内嵌PTY。终端退出、网页返回和安装成功不能替代认证回执。服务说明、模型ID及密钥引用属于元数据；密钥保存在系统凭据存储，不进入数据库、事件或日志。保存服务不自动分发，明确选择服务才授权本次使用，见 [service_delivery.rs](../src-tauri/src/acp_client/service_delivery.rs)。

终端由[既有退出所有者](../src-tauri/src/pty.rs)持有同一Child、进程组与控制句柄；[startup_owner.rs](../src-tauri/src/pty/startup_owner.rs)把该工作线程前移到首个系统调用之前。每个管理器只允许一个未确认的启动，[startup_control.rs](../src-tauri/src/pty/startup_control.rs)在同一状态锁下裁定就绪与等待超时。失败、取消或析构阻塞时，认证输出闭包、配置保护和活动许可仍随原所有者保留；只有实际清退才可报告完成，未知状态不自动释放或重试。这些后续源码已随fa5689纳入macOS正式应用；选定Windows终端取消与认证退出分项另有成功证据，保留主句柄的无应答负控仍失败，不代表ConPTY全部退出路径已验。

服务交付与直接API测试是独立路径：测试支持某个接口，不证明所有 Agent能使用它。仅按已核官方配置方式交付，原来源失效不能静默换号、换模型或回退默认服务。配置对象与日志不携带密钥；启动诊断只记录受控事实。

## 对话、草稿和请求生命周期

无工作文件夹也可写草稿；选位置前不预开 Agent对话，不回退到应用默认目录。选择工作位置及准备完成的 Agent后，可在首发前准备同一草稿；这不等于发消息或登记已接纳历史。首条消息接纳后，一个对话保留一个 Agent、一个官方会话及其服务来源。

前端以 [session_types.ts](../src/runtime/session_types.ts) 与 [sessions.ts](../src/runtime/sessions.ts) 保存当前连接、消息投影、队列和请求状态。后端管理进程、会话与命令归属。模型和推理仅在实际提供、安全空闲、回执匹配且保存成功后成为新请求与恢复基线；普通配置通知不是用户切换请求的成功回执。配置未知、停止未确认、保存失败或待审批时，不静默继续。

[AsyncTasks.tsx](../src/components/AsyncTasks.tsx) 对官方后台任务仅显示已有能力所提供的状态与控制。[async_task_location.ts](../src/runtime/async_task_location.ts) 按相同连接/对话中唯一已加载的toolCallId查来源；缺失或重复不猜测。[showToolLocation.ts](../src/components/showToolLocation.ts) 在当前正文内按字面数据属性匹配唯一节点，明确展开其祖先、滚动并聚焦；点击前后复核归属，显式展开不被后来退出搜索撤回。此源码检查点尚未正式安装，不补造父子层级，也不把来源步骤状态当后台任务终态。

恢复标记保存实际已确认的配置和服务身份，不只保存显示文字。服务变化、旧配置缺字段或恢复失败会保留历史、草稿、附件和暂停队列，要求核对；默认配置不冒充原设置。配置与恢复入口见 [session_configuration.ts](../src/runtime/session_configuration.ts)、[session_config_recheck.ts](../src/runtime/session_config_recheck.ts) 与 [model_guard.rs](../src-tauri/src/acp_client/model_guard.rs)。

[delivery_flow.rs](../src-tauri/src/acp_client/delivery_flow.rs)让打开、预览与复制对话的Tauri通道只发送轻通知；界面逐项取出并精确确认原事件，缓冲/异步控制转交与消费分别计数。队列保存原事件及逻辑配额，退役不提前释放在途副本债务，窗口实际销毁才清理未归还的副本。[ingress_permit.rs](../src-tauri/src/acp_client/ingress_permit.rs)在官方SDK前按逻辑积压暂停后续读取，单个已接纳有限帧可越过水位；未知归属前缀超额明确结果未知而保留原工作。现有[delivery_observation.rs](../src-tauri/src/acp_client/delivery_observation.rs)采样另算，不用于筛除原始事件，也不把入缓冲当消费。[session_delivery_observer.ts](../src/runtime/session_delivery_observer.ts)只在外层解析交付封套。当前受控检查不证明React绘制、真实多Agent资源或RSS上限，安装版未验。

最新源码由 [history_admission.rs](../src-tauri/src/acp_client/history_admission.rs) 统一限制已有对话打开/读取的同时开始数、纯等待数和保留请求逻辑字节；[cold_history_open.rs](../src-tauri/src/acp_client/cold_history_open.rs) 在入队前后复核保存来源、模型和目标设置，获准后才准备临时网页工具与连接。许可保持到完整读取标记交付，超时或无人接收时随真实进程归属保留；最后释放不在队列、连接或活动状态锁内唤醒下一项。窗口销毁撤回尚未开始的等待，取消只接受当前窗口与请求令牌；已开始仍按原操作结果判断。前端 [HistoryReadStatus.tsx](../src/components/HistoryReadStatus.tsx) 展示独立读取状态，Agent原始事件不经该状态通道筛除。首发、预览、列表、分支及当前停止/审批不纳入此冷读取队列；这不提供传输背压、渲染消费确认或RSS硬上限。该机制已随3845完成完整工程与安装检查；正式界面一次既有Dirac读取的状态和回复回放已验，真实等待取消、并发突发与长期资源仍未验。a371另将审批登记后的事件发布移到审批表锁外，登记及原始请求保持；该修复已包含在5790安装源码中，不能由此推定全部审批真实路径已验。

当前正式版由[active_prompt.rs](../src-tauri/src/acp_client/active_prompt.rs)限制活动发送：初始策略为同时2项、等待8项、保留请求64 MiB逻辑字节，独立于冷读取配额；这不是量测后的最优值或实际内存上限。等待不持有工作位置切换锁，获准后仍复核来源、模型、权限和保存结果；[process_prompt_escrow.rs](../src-tauri/src/acp_client/process_prompt_escrow.rs)在实际交付后持有请求许可与工作责任，只有已知结束结果或原进程及进程组确已结束才释放。窗口与请求令牌限定取消对象，等待取消保留草稿和队列，停止与审批不排入该等待队列。[session_prompt_dispatch.ts](../src/runtime/session_prompt_dispatch.ts)区分等待、已交付与结果未知，迟到的接纳回包不把已结束的一轮重新标为运行。该批随fa5689完成新完整七项、独立源码复核、候选9项及安装10项；正式界面仅核既有Dirac读取和正常保存退出，未验实际发送等待、停止或长期资源，不能由此推定整项资源治理或29家已验。

Agent的原始事件包括未知字段进入总线；工具、异步任务、压缩和停止按真实事件更新。取消请求发出不等于已经停止，进程退出也不等于上一请求正常完成。未知结果阻止普通重试和自动重发，不清除已发生外部操作的事实。[session_process_ended.ts](../src/runtime/session_process_ended.ts)只接收独立的本地进程结束通道，核对原连接及当前状态对象后，才允许用户明确重新准备；旧未知结果、历史和未确认输入继续保留。普通事件中的同名字段、迟到旧连接通知及通道丢失均不能提供该许可；该批后端受控检查、统一七项工程、独立源码复核与fa5689正式安装已完成，实际结束通知后显式重新准备的界面路径尚未验证。

未发送内容与准备记录保存在meta_store的settings键中；文字、附件位置、意见与暂停队列可恢复，但附件需重新核验，保存失败明确呈现。保存退出采用单次共享操作和令牌校验，等当前保存完成；取消仅释放本次退出自己的锁，不释放更新、工作位置等其他操作的锁。重启仍受原有忙态与未知保护。

[composer_attachment_import.ts](../src/runtime/composer_attachment_import.ts)按原草稿代次及仍属于该草稿的精确附件对象持有导入责任；每次实际结果写入前重核该归属。保存继续等待所有仍归属原草稿的未完成输入；切换对话或退出锁不解除等待。用户移除输入后可释放相应保存等待；这不取消或假称实际File/系统读取已结束。原任务继续自然收尾，迟到内容不能加入新文字或另一个附件，拒绝与错误亦不能重新取得旧输入的写入权。该结构只管理当前未发送输入，不增加事件账本或另一套运行控制者；受控settings写入不替代真实退出/重启和存储故障验证。

[draft_images.ts](../src/runtime/draft_images.ts)另以共用两项名额限制跨批次剪贴板候选准备，涵盖实际File读取返回、编码与候选检查；原缺失、大小门槛优先，忙态在arrayBuffer及Base64编码前拒绝。名额等该准备真正返回、拒绝或抛错后释放，草稿撤回不释放它。它与系统文件读取的两项限制、浏览器解码的两项限制彼此独立；不排队或自动重试，也不把被拒绝的图片字节称为已经保存。

[audio_input_draft.ts](../src/runtime/audio_input_draft.ts)为仍归属当前音频审阅的读取登记保存等待，[useAudioComposerAttachments.tsx](../src/components/useAudioComposerAttachments.tsx)初读和确认重读共用该责任。取消、移除或归属失效时退役该等待；仅仍归属本次的附件恢复原对象，已移除的附件不重建。真实读取仍由调用方等待，系统许可不在此释放。迟到的有效内容不能覆盖新文字、恢复旧附件或提示已保存。文档输入原有取消等待与共用存储代码保持；受控组件与设置写入仍不替代正式退出/重启、真实文件读取或长期内存验证。

## 文件输入、成果和意见

输入资料先检查 Agent实际声明的能力及工作位置。图片输入的8 MiB、尺寸和动画规则由 [image_bytes.ts](../src/runtime/image_bytes.ts) 管理；它与收到消息的媒体预览是两个入口。音频、PDF、DOCX、XLSX等资料依各自格式、大小、部分内容提示及明确确认处理，不以附件位置或旧确认代替当前文件核验。

普通图片文件的[VisualFilePreview.tsx](../src/components/VisualFilePreview.tsx)先复用[visual_preview.ts](../src/runtime/visual_preview.ts)的七字段身份、文件大小及编码长度门，再调用同一[draft_images.ts](../src/runtime/draft_images.ts)容量检查。已有两项解码Promise未结束时，在字节展开和结构扫描前返回既有忙态；空闲使用同一份解码后字节核实际长度与文件声明相等，再做原格式、MIME、静态图片及像素检查，避免普通文件入口重复展开。原PDF字节和线程路径不变。忙态只延后深层校验，不把未知或损坏内容当作有效；超时、隐藏和取消也不据此证明物理解码或内存已经退役。

[document_input.ts](../src/runtime/document_input.ts) 及格式模块把明确选择的内容转换为可发送表示；本地版本信息用于防止误发旧文件，不伪造官方工具回执，也不把Farfold定位字段送成 Agent协议内容。DOCX作者文字、XLSX保存值/公式、PDF可提取文字都各有省略和准确性边界，不声称还原完整视觉排版或OCR。明确确认的文档文字在[prompt_blocks.ts](../src/runtime/prompt_blocks.ts)发送边界转换为官方普通文字块，只发送已审阅正文，不携带供接收方重新提取的原文件位置。本地来源、版本与消息附件显示先于该转换保留；普通资源及没有该本地确认字段的历史路径不变。普通文字路径与资源专属准入不同，官方历史是否保留结构化附件和多文档来源名称仍需分别验证。

文件成果分开“工具报告”与“磁盘核验”。消息中的写入参数、路径或差异摘要只证明报告内容；明确打开文件后，[file_access.rs](../src-tauri/src/file_access.rs) 才按路径和文件句柄边界读取。项目索引有遍历数量、深度、名称和时间预算，不是持久全文索引；同句柄校验不提供整个文件系统原子快照。

[OpenedFileView.tsx](../src/components/OpenedFileView.tsx) 及 [workers](../src/workers) 实现文字、Markdown、Office及PDF的有限预览。PPTX始终是部分预览；表格范围、PDF文字和DOCX结构不等同源应用全部显示。HTML由网页预览处理，其他文件可交系统应用。 DOCX图片由[DocumentImages](../src/runtime/document_images.ts)按当前显示者引用计数共用Blob URL；[DocxDocumentView.tsx](../src/components/DocxDocumentView.tsx)在失败时先撤本节点来源，再释放自己的引用，最后一个显示者释放才撤销URL。当前来源及存活状态校验隔离迟到错误，换源或卸载清理幂等；不自动重试，不据URL撤销推断原文档字节或物理解码内存已经释放。

[xlsx_sheet.ts](../src/runtime/xlsx_sheet.ts)为每张已选工作表使用16,385项Uint32列索引（65,540字节数据区），以样式编号加一保存覆盖，默认样式0也能拒绝重叠。有效区间总覆盖不超过16,384列；区间检查与填充有界，单元格按行/列默认与显式样式优先级读取，列布局保持输入顺序。XML、单元格及展开文字原上限不变；这不是总解析内存或耗时保证。

[xml_namespace_scope.ts](../src/runtime/xml_namespace_scope.ts)供DOCX/PPTX解析器共用只读声明作用域：无本地声明时共用父作用域，有声明时仅保存本地自有数据并冻结，祖先声明不复制到每个节点。前缀继承、局部覆盖、兄弟隔离及MC分支和MustUnderstand规则保持，特殊名称不触发原型设置。原XML预算及未知格式拒绝不变；本批受控验证中真实Worker所用输入是自有合成parts，文件身份为逻辑夹具标签，不能称为系统文件/ZIP核验或完整Office排版证明。

PDF外层[预览](../src/runtime/pdf_preview.ts)及内层[绘制线程](../src/workers/pdf_render.worker.ts)均将`messageerror`接入各自原有失败路径：外层清画布、计时与取消监听，结束自己的线程并归还原共享名额；内层固定失败消息使迟到结果不再发布成功，已返回的位图由原分支关闭。没有增加第二套名额或等待期限；受控事件与浏览器分项不证明真实反序列化故障、物理线程树停止或内存释放。

PDF文件预览在[组件](../src/components/VisualFilePreview.tsx)先核原文件身份、MIME与编码长度，再向原共用绘制入口交付延后取字节的方法；[pdf_preview.ts](../src/runtime/pdf_preview.ts)取得既有名额后才调用实际字节校验与展开。入口仍接受直接字节；准备失败或取消在原`finally`归还自己的名额，未新增资源池或自动重试。真实受控WebKit验证真实解析、画布像素、满额拒绝和隐藏后迟到位图清理；只暂留已完成结果的交付，不证明物理解析忙态、进程内存或正式应用界面。

意见绑定原对话、规范路径和具体磁盘版本；DOCX结构位置、XLSX单元格范围、PPTX预览位置等只对实际已解析的内容有效。明确加入原草稿后才由用户发送，不自动提交。刷新、切换、隐藏和迟到回包需核对版本与归属；自动刷新失败保留旧预览并标明状态，不能把旧位置当新文件。只有 Agent真实修改及重新核验文件，才证明返工完成。

## 消息图片与音频预览

收到的媒体由 [message_attachments.ts](../src/runtime/message_attachments.ts) 保留原payload与顺序。明确展开后，[use_message_media_budget.ts](../src/runtime/use_message_media_budget.ts)先做轻量资格和单项最多16 MiB检查，再取得共用4实例、32 MiB逻辑字节配额，随后才扫描规范Base64及下述已覆盖声明；取得配额并通过检查才生成媒体DOM。失败或退役释放本次配额，重试由用户明确触发；这不是实际解码内存或RSS上限。搜索、折叠、普通消息呈现不自动深查或加载媒体，远程地址不因预览而抓取，未知格式与原协议内容仍保留。当前正式版的 [MessageContent.tsx](../src/components/MessageContent.tsx) 将Markdown图片替换为同一安全网页/文件来源入口；已有外层链接的图片只保留文字标签，避免嵌套操作。不从Markdown图片生成img、预加载或另一套自动抓取流程；安装与浏览器覆盖见状态。

Agent消息的正文与媒体顺序由 [message_content_order.ts](../src/runtime/message_content_order.ts) 保留为已有正文的字符范围和附件索引范围，仅用于内存呈现，不复制负载、不持久化事件。相邻文字片段合并为一个Markdown段；主对话和已读取历史预览使用同一呈现，搜索按连续文字段解析，导出在对应位置列附件来源。完整覆盖校验失败或旧消息没有顺序信息时保留原布局，不猜测丢失的顺序。稳定的段键及全消息附件索引用于保留展开状态、媒体来源与搜索定位。

PNG检查签名、IHDR和有界容器布局；[message_apng_admission.ts](../src/runtime/message_apng_admission.ts) 核APNG控制块、帧序号、矩形与声明数量。JPEG、GIF、WebP、BMP由 [message_raster_admission.ts](../src/runtime/message_raster_admission.ts) 分派。支持范围内画布每边最多8192像素、总量最多16,777,216像素。GIF/WebP/APNG另限128动画帧、完整画布像素乘帧数最多67,108,864、遍历记录最多65,536；APNG独立默认图额外计入像素总量。PNG/APNG固定控制数据核CRC，压缩像素与其他负载不做全量CRC或解压；标准`image/apng`复用同一PNG准入。跨允许MIME标注的已识别格式也受相应约束。

AVIF入口 [message_avif_admission.ts](../src/runtime/message_avif_admission.ts) 使用有界容器、项目关联及序列检查，核已识别的画布、派生图片、辅助图片和样本声明，并沿共用画布、帧数、像素工作量与记录预算计额。项目清单iinf内free/skip作为不透明填充跳过，仍由共用遍历器核范围并计记录，不改变infe数量或ipco属性索引。容器尺寸不等于AV1位流的最大或中间帧尺寸；未知版本、编码布局及缺少可计额声明的兼容内容保持原支持，明确留为未覆盖，不能据此宣称全部AVIF受同样资源约束。

[message_avif_items.ts](../src/runtime/message_avif_items.ts) 对已解析项目的确定本地`iloc`范围统一核文件或`idat`边界，覆盖普通编码图片、辅助项目及网格，不只在读取网格前检查。核`base_offset`与各段声明，不扫描图片负载；外部数据引用、未知寻址和未给出长度的布局仍未覆盖，范围通过不代表AV1内容有效。 已知`ipma`关联确定后才对实际关联的`ispe`应用画布预算；未关联属性仍核结构、非零尺寸及记录预算，不把无用声明当作实际画布。关联版本或标志未知时无法确认其未使用，保留既有的已知尺寸保守校验。

[message_avif_layers.ts](../src/runtime/message_avif_layers.ts) 解析已识别`a1lx`的空间层声明；按关联画布、声明层数与已有派生使用次数保守计入67,108,864像素工作量政策。空间层不当动画帧，不因`a1op`或`lsel`选择减少计额；该策略不推定解码器实际处理了哪些层。未知保留位保持未覆盖，但不跳过其他已知尺寸或工作量预算。

音频入口 [message_audio_admission.ts](../src/runtime/message_audio_admission.ts) 对已识别经典RIFF/WAVE做容器边界、填充和有界分片遍历；线性PCM、IEEE浮点、已知标准扩展及普通18字节fmt/cb0的G711标签6/7按各自确定的存储帧核600秒消息预览策略。普通20字节fmt/cb2、4位单/双声道IMA标签17另核每通道块几何，只计最后完整块之前的完整前缀；已知前缀采样数超过600秒时拒绝，其余一律保持部分覆盖，不把末块容量、fact或平均字节率当作准确播放时长。部分尾块不套用线性帧对齐要求。当前正式版对fmt50/cb32、4位单/双声道、七组标准系数且块采样几何匹配的MS-ADPCM标签2复用该前缀政策；不把fact裁剪或末块填充当准确时长，未知系数和布局保持部分覆盖。存在播放列表时，确定的直接data仍核独立存储预算；列表的裁剪、循环及实际播放时长不据此推定。未知编码、扩展、其他容器及wavl保留兼容路径，不套用PCM公式。该策略不等于格式限制、实际播放/循环时长、解码有效性或解码与重采样内存保证。

经典WAVE未识别时，共用入口另调 [message_flac_admission.ts](../src/runtime/message_flac_admission.ts) 核`fLaC`标记、首个且唯一的STREAMINFO及有界元数据；也核选定前置ID3存储边界，标签与FLAC元数据共享记录预算，原始来源字节保持。前置ID3只是选定解码器的兼容布局，不是FLAC规范要求。已知总采样数与采样率沿600秒声明策略；未知总量由[message_flac_frame_observer.ts](../src/runtime/message_flac_frame_observer.ts)观察选定单声道16位常量帧的完整范围、CRC及连续编号。正数总量也在同一剩余记录预算内观察，只有已验证累计采样下界超600秒才提升为拒绝；不完整、校验不足或记录上限耗尽时保留原正数声明策略，不能据此宣称完整计额或格式有效。未知总量原有无效、超复杂及部分覆盖结果保持。零采样率、保留元数据和其他帧布局的未知边界保持。跨原允许音频MIME核实际标记，不新增格式入口；不读取嵌入图片或URI，不解码PCM，不核实际解码内存或完整播放。

其他音频另由 [message_adts_admission.ts](../src/runtime/message_adts_admission.ts) 识别ADTS并有界遍历帧边界；对已知AAC-LC采样率和块数用整数时间基计入同一600秒声明策略。CRC保护或未知配置保留未覆盖，仍保留独立已知的超限判断；ADIF、其他AAC容器及帧负载语义不在此路径的证明范围。它不增加MIME支持或解码器能力，也不等于实际播放时长或内存保证。

[message_mpeg_audio_admission.ts](../src/runtime/message_mpeg_audio_admission.ts) 对MPEG LayerIII已索引码率帧沿版本、采样率、填充和帧边界累加声明采样数，以整数时间基核同一600秒策略。Xing/VBRI时长不代替实际遍历的帧声明；CRC保护帧保留部分覆盖，已知超限仍拒绝。自由码率、其他层和未知尾部不搜索猜测下一同步点，保留未覆盖；不解码音频、不核位储存器或完整负载，不保证实际播放时长和解码内存。实际签名检查跨原允许音频MIME，未增加格式入口。

FLAC、ADTS与MPEG共用 [message_audio_prefix.ts](../src/runtime/message_audio_prefix.ts) 核连续前置ID3v2.2/2.3/2.4修订0标签的已知头标志、存储字节范围及v2.4可选尾标记，随后只在声明边界识别音频；标签与对应音频帧或FLAC元数据共享65536条记录预算。未知版本、修订和标志保持未覆盖，不搜索标签内部或尾部同步点；标签内容、嵌入图片、URL、去同步及压缩语义不解码。播放保留原始完整来源，不裁掉标签、不改字节；这仍是选定声明准入，不是标签内容正确、完整播放或解码内存证明。

[message_mp4_audio_admission.ts](../src/runtime/message_mp4_audio_admission.ts) 另核首个`ftyp`的选定经典ISO/M4A容器，只遍历固定层级、有界盒范围及声明表，不读取`mdat`样本负载。对已识别`soun`音轨，以该轨刻度分别核`mdhd`时长与`stts`的样本计数乘间隔，沿600秒策略，64位值用BigInt比较；不取影片或视频时钟，也不把并行音轨、声道倍乘成时长。盒、品牌和时间表条目共享65536记录预算。未知版本/标志/品牌、零或未知时间、时钟不一致、编辑映射及分片保持部分覆盖，独立已知超限仍拒绝；不验证完整编解码内容，不推断去除AAC前导/尾部采样后的准确播放或实际内存。原允许MIME和播放字节保持，未知容器不通过搜索内部同步点猜测格式。

[message_mp4_fragments.ts](../src/runtime/message_mp4_fragments.ts) 对已识别的分片声明另核音轨预算：以已知`tkhd`标识连接`soun`音轨与`mdhd`刻度，沿`trun`、`tfhd`、`trex`的字段存在顺序取采样间隔，同轨的已知片段用BigInt累计到600秒策略。全体盒与显式样本表共用65536记录预算；无逐项列时用采样计数直接相乘，不按巨大计数分配数组或循环。零值、未知字段、轨道或刻度保持部分覆盖，不能遮蔽其他独立已知超限。经典表与分片声明分别核验，不合并以免重复计量；不把片段起始时间间隙、编辑映射、并行轨道或声道推为实际播放时长，不核`mdat`地址或负载、完整编解码有效性或内存。

[message_ogg_audio_admission.ts](../src/runtime/message_ogg_audio_admission.ts) 对选定连续Ogg Vorbis及Opus逻辑流检查已声明音频区间的下界。按包边界排除Vorbis三个头包或Opus两个头包，仅在同一连续流内相减已完成音频页的已知非负采样位置；非结束页建立起点，连续且不回退的结束页可作为末端。Opus仅覆盖版本1、映射族0的单/双声道头，固定按48000时钟计算，忽略头部输入采样率；还保守扣除全部开头丢弃采样，避免起点仍在待丢弃前缀时误拒。得到的下界超过600秒才拒绝。在有界文件末端，仅对全体完整结束、编号全程唯一、未交错且具有同一已识别映射和时钟的顺序链累计非负区间；每段均扣自己的开头丢弃采样。未知、复用、并行、缺少已知结束点或后续矛盾会撤回新增合计资格，原独立超长区间判断保持。该差值消去常量起始偏移，不拿结束位置直接当总时长，不把并行流、声道或头页的零位置相加。页、分段和包遍历共用65536记录预算；丢页、未知映射及不可确定的区间保持部分覆盖，非超限不宣称完整预算通过。不核完整CRC、头部评论/设置内容与音频负载，也不推定实际播放、解码内存或全部Ogg编码支持；共用入口保留原MIME与来源字节。

[use_message_media_budget.ts](../src/runtime/use_message_media_budget.ts) 共用4个实例、32 MiB配额，按Base64所代表的文件字节计额；失败、折叠、卸载和来源变化只退役各自租约。当前媒体加载失败时，[MessageAttachmentMedia.tsx](../src/components/MessageAttachmentMedia.tsx) 先失效当前节点并移除来源，音频先暂停、清来源及重新加载，再通知共用持有者释放配额；迟到错误与失败节点的重复挂载不恢复来源。错误反馈、原文和来源信息由附件保留，显式重试重新申请配额后才创建媒体；配额不足单独提示，其他附件释放不会自动重试。

新增源码的[MessageAudioCompatibility.tsx](../src/components/MessageAudioCompatibility.tsx)在原音频实际加载失败后提供明确兼容重试；macOS使用[audio_preview.rs](../src-tauri/src/audio_preview.rs)及[AudioPreview.m](../src-tauri/native/AudioPreview.m)的官方AudioToolbox内存读写回调。完整FLAC/无前置标签ADTS输入与完整WAVE输出各限16 MiB，单/双声道、8–96 kHz、600秒；系统按4096帧块交付，输出缓冲按受限几何容量增长。原始来源不改，最多两个真实解码工作同时进行，调用取消不提前释放尚在运行的工作名额。前端先从原共用池保留16 MiB，经来源摘要、完整WAVE及有限浮点检查后才建立本次Blob，退役播放节点后撤销。Windows明确不提供该兼容路径。AAC可能包含不同的前导/尾部采样，界面说明时长可能与原预览不同；未猜测裁剪。实际解码与受控WebKit播放分项已有证据，正式IPC、可听声音、系统解码内存和完整格式覆盖仍未验，逻辑字节配额不是RSS上限。

历史用户消息中的内嵌图片由 [UserMessageContent.tsx](../src/components/UserMessageContent.tsx) 在明确展开、祖先可见且取得同一共用配额后，调用原 [draft_images.ts](../src/runtime/draft_images.ts) 检查；8 MiB、静态格式、尺寸及两项尚未结束检查的限制保持。关闭、隐藏、换源及卸载撤下本次来源并释放自己的预览配额，迟到结果不能恢复展示；再次显示或其他媒体释放配额不会自动打开，失败后须明确重试。[draft_images.ts](../src/runtime/draft_images.ts)先核原有常量时间缺失/长度门槛，已有两项检查未结束时在Base64展开及结构扫描前返回忙态；空闲下原校验保持。两项检查的名额仍等解码Promise实际结束才释放，超时或退役不证明物理解码已停止、RSS已下降。原消息与复制内容保持，正式消息和完整资源验证另见状态。

[text_image_links.ts](../src/runtime/text_image_links.ts)在原历史用户文字路径中只检查围栏前至多四个空格；仅真正可能关闭围栏的标记才检查本行剩余文字，行内代码不再查询无用的行尾。原支持格式、代码字面量、原文及UTF-16偏移不变；默认已加载历史搜索继续只索引文字片段，识别为图片的Base64不成为查找字段。受控浏览器核对原文字段与实际DOM Range，不建立正文账本，也不代表真实Agent历史或正式搜索效果已完整验证。

[message-media-visibility.tsx](../src/components/message-media-visibility.tsx) 将工具组、工具详情及保留对话路由的可见性逐层相交，内层展开不能覆盖已隐藏的祖先。[App.tsx](../src/App.tsx) 按实际显示的页面键传递路由可见性，沿原顺序保留带网页或草稿的页面；搜索和带入浮层仅暂停交互，不误作页面隐藏。保留的隐藏文字节点继续存在，但消息媒体来源和配额退役，并撤回此前的媒体展开意图；回到页面或查找揭示不会自动加载，仍需用户明确展开媒体。该边界不核系统休眠、窗口后台、网页内媒体或解码器内存的生命周期。

本地文件的默认应用打开与消息内媒体播放分开：[selected_location.rs](../src-tauri/src/file_delivery/selected_location.rs) 的既有安全媒体名单补AVIF、FLAC，仍核原文件版本、位置及不可执行边界；没有内置预览的文件使用中性说明，不承诺任意后缀都能默认打开。该改动已随3845安装，尚未实际调用系统打开，不新增内嵌解码、格式有效性或正式消息媒体证明。

以上是字节、已覆盖声明结构和DOM生命周期约束，不是实际解码器分配、传输内存、动画循环或播放时长保证。APNG/AVIF完整动画、未覆盖AVIF/音频资源边界、长期使用、正式消息媒体和完整P13仍开放；受控浏览器文件显示不证明动画帧推进或真实 Agent效果。

## 历史、查找、导出与复制

Agent历史仍归 Agent所有。列表、正文读取与继续对话分别处理；默认查询范围由官方接口实际提供，不猜测全局范围，也不扫描私有历史作后备。Farfold只保存对话索引和必要来源信息，不建事件账本。

| 查找入口     | 实际数据来源                                               | 不覆盖的范围                                   |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------- |
| 对话资料     | 已登记标题、工作位置等元数据                               | 全量历史正文                                   |
| 已加载正文   | 当前内存中多个已加载对话的用户消息、回复及已接收附件文字   | 未加载历史、附件文件、思考、工具详情           |
| 读取所选历史 | 明确选择的尚未加载对话，经已核官方程序/SDK临时读取返回文字 | 未返回或未选历史、完整分支保证、自动恢复或发送 |
| 所选附件内容 | 明确选取的当前本地文字、DOCX、XLSX、PDF、PPTX的可解析文字  | 附件历史版本、OCR、音频、网页及全格式正文      |

已加载查找在worker内按字段和总量限额执行，迟到结果需校验当前范围。官方历史读取使用临时任务与归属控制，只接受已核入口；已注册方式只证明其返回的保存记录，不推断当前分支或可继续效果。取消/超时不冒充实际停止，SDK内部读取与分配也不被外部输出限额完全约束。入口见 [history_search_controller.ts](../src/runtime/history_search_controller.ts) 与 [history_search](../src-tauri/src/acp_client/history_search)。

[loaded_search_markdown.ts](../src/runtime/loaded_search_markdown.ts)用与消息相同的Markdown/GFM解析提取可见字段；图片取与MessageContent相同的说明或空说明标签，保留其所在连续文字段，目标网址/Base64不入字段，也不加载图片。搜索命中仍须通过[loaded_search_dom.ts](../src/runtime/loaded_search_dom.ts)的原消息归属与完整字段严格相等检查，才能映射实际DOM Range；未扩展持久索引或读取范围。

已加载正文及所选附件结果共用 [search_snippet.ts](../src/runtime/search_snippet.ts) 截取匹配前后摘要；保留56/88个UTF-16单位的窗口上限，仅在外缘切开有效代理对时向内缩一个单位，避免制造原文没有的替代字符。匹配内容、来源版本及定位范围不变，不归一化原文，也不保证整个组合字素都留在窗口内。

附件查找每次最多20文件、单源文件1 MiB、可检索文字合计16 MiB。各格式的页、段落、单元格或片段边界保留；PPTX/PDF未匹配不等于完整文件无匹配。它读取当前选中文件，不自动打开历史、连接 Agent或读取网页。

筛选范围变化或附件移除后，失效选择继续阻止读取和结果跳转。[SelectedAttachmentSearch.tsx](../src/components/SelectedAttachmentSearch.tsx) 提供明确的“清除失效选择”出口：只移除当前来源校验不通过的选择，保留仍有效的文件，并撤回旧结果；清除不读取文件，也不自动开始新查找。未结束的读取继续限制操作。

Markdown导出仅覆盖当前已加载的可读消息；资料包按实际选取文件打包，不补全 Agent完整历史。导出不是数据恢复备份。

“复制当前对话”调用 Agent官方复制能力，在本次处理时保存完整当前上下文；不是指定历史节点分支。父对话保留、子会话独立，项目文件仍共享；新连接不恢复旧网页等许可，不自动发送。复制已经派发而结果未知时禁止盲目再建。它不同于“用相同设置再开一段”和“从一条消息准备新稿”，后两者不复制完整历史，见 [session_fork_strings.ts](../src/runtime/session_fork_strings.ts)。

## 网页、标签和许可

前端每个对话管理标签与选中页，后端 [tab_commands.rs](../src-tauri/src/browser_workspace/tab_commands.rs)、[page_store.rs](../src-tauri/src/browser_workspace/page_store.rs) 管理真实页面身份。手动浏览、文件预览和 Agent读取是不同授权。隐藏或收起可保留页面与许可；明确关闭、换页或连接结束撤回旧范围，旧页面回包不得沿用到新页。

公开网页使用隔离网页存储；macOS本地HTML专用存档按规范项目/文件范围区分。多文件项目和本地开发服务器通过各自路径、来源与网络规则预览，不把只读预览策略称为操作系统沙箱。网页没有Tauri应用桥，页面内容也不能直接成为工作台指令。

当前网页工具包括观察、读取快照以及经确认的节点点击和普通输入；生产截图仅在系统可检查封闭内容且前后页面/许可一致时工作，编辑区、整页编辑、框架或证据不足均拒绝。每次截图单独确认，已有文字许可不包含截图；首次截图不产生长期文字许可，失败不降级返回文字，在途请求直到实际回传确认仍可撤回。旧macOS能力不足继续不可用；Windows已取得受控网页经真实WebView2与辅助进程的生产接口分项实测，macOS27、正式界面、远程网页与真实Agent交付仍未验，具体范围见[当前状态](status.md)。节点身份、页面版本与许可需在执行时核对；敏感输入、登录或页面请求不能自行扩权。交付点击命令不等于网站业务动作完成。

输入执行前后若发现受保护控件，或已派发输入但无法确认结果，撤回该页原共享许可；晚回包不能继续交付原许可的内容。保留实际派发与未知结果，不自动重试，也不把撤回许可说成敏感网页操作已通过。

[browser_sharing.rs](../src-tauri/src/browser_sharing.rs) 与接入层临时工具配置建立本次连接通道：macOS用私有Unix socket，Windows用当前用户管道，权限令牌不持久保存。辅助进程先消费临时秘密再进入普通应用初始化；准备、确认、连接结束与资源清理有独立归属。该接入不是29家网页能力验收。

[remembered_pages.rs](../src-tauri/src/browser_workspace/remembered_pages.rs) 只在用户逐页核对并确认无秘密后保存公开网址、所属对话与顺序。重启只列清单，点击后才打开；不保存旧读取许可，不自动恢复页面。关闭页面保留清单，忘记或清空只移除相应记录。

## 技能与MCP清单、管理

能力由已核官方接口决定，共用 [AgentExtensionInventory.tsx](../src/components/AgentExtensionInventory.tsx) 展示。选择工作位置、切换范围或检查读取方式不等于实际查询；清单有来源、范围、时间和部分失败提示。MCP配置报告不证明连接、具体工具调用或当前对话生效；技能报告也不证明已经安装或执行。

临时任务核对程序、工作位置、配置及能力身份，按固定官方调用查询，不发送对话消息，不附加Farfold保存的服务密钥。官方程序仍可能使用已有登录、访问网络或维护自己的缓存。取消、超时及组件关闭不会把尚未结束的任务当作停止；保留清理许可与已派发写入事实，不自动重试。

额外技能目录仅用于一次明确查询：UI先支持单目录，请求结构最多4个有序目录；与默认技能合并，不是只列额外目录。后端在初始化、设置确认与列表读取间复核目录身份，设置ACK和返回范围必须匹配。非空额外目录得到的整份报告均只读，无管理目标，后端也拒绝绕过；不安装技能，不持久配置，不使当前对话自动采用，见 [extra_skill_roots.rs](../src-tauri/src/acp_client/extension_inventory/extra_skill_roots.rs)。

普通范围的技能启停及部分MCP管理属于独立审阅流程；必须取得当前有效目标、确认实际修改内容，满足忙态与清理门禁后才调用官方方式。管理入口并非所有来源、操作或29家全支持，配置修改成功也不替代当前对话实际采用及具体工具测试。

技能包管理使用同一共用类别，见 [plugin_management/mod.rs](../src-tauri/src/acp_client/plugin_management/mod.rs) 与 [plugin_management_controller.ts](../src/runtime/plugin_management_controller.ts)。先明确查询来源，再选择来源并明确读取其中的技能包；接口不接受界面传来的来源路径或任意名称，也不回退到全量查询。来源报告的编号仅指向短期内存中的名称、根目录和完整官方来源身份；每次技能包读取前后重新核对，审阅、确认及只读核对继承同一范围。缺少配置依据的安全来源可以只读查询，管理仍须已确认的配置来源与项目；歧义来源及官方远程全量入口不用于此范围查询。

固定官方CLI执行查询、审阅、确认、取消及只读核对，不使用尚未承诺稳定的插件RPC，也不新增Agent执行循环。目标、审阅和操作仅存内存；写入ACK与读回分别判断，后续查询保留最近一次实际派发的原操作事实。共享配置保护覆盖已知同类程序及后续连接；外部程序和未知包装器不作完全隔离保证。所有读取与清理仍受既有时限和输出预算约束；来源列表和所选来源报告均不作全量清单证明，空结果不作全部未安装证明；安装、启用报告不证明当前对话采用。交付层级见[当前状态](status.md)。

## 数据、工作位置和系统生命周期

### 持久化归属

历史631批次的交付记录：631已交付的详情呈现仅在展开或搜索时准备正文，完整原始事件和未知字段仍在既有状态保留；搜索节点映射使用单向游标，维持UTF-16边界与全部命中，历史完整数组在完成边界转交所有权。受控浏览器夹具与正式Dirac17处搜索分列，不由此宣称全局事件退役、背压、RSS或长期资源完成。 当前逐项消费、历史读取与所有权转交的实现及验证边界见[当前状态](status.md)，不沿用本段描述作为当前传输能力结论。

[meta_store/schema.rs](../src-tauri/src/meta_store/schema.rs) 当前保留 agents、sessions、settings、dismissed_sessions 四表。内容是Farfold自有接入登记、对话索引、设置与相应整理记录；草稿、准备记录、分组、网页清单等放入受限设置结构。Agent消息、工具事件及完整历史不另建账本。

服务密钥归系统凭据存储，项目成果归用户选定目录，Agent历史/账号/模型配置归各 Agent。工作位置只是请求及文件操作上下文，不保证不同对话的项目文件、账号、依赖和端口隔离。[lifemodel.rs](../src-tauri/src/lifemodel.rs) 仅保留默认关闭设置与空钩子，没有真实采集或注入。

### 并行工作位置与维护

当前Windows公开新建、同对象归档/还原、独立资料生成、冷恢复及确认删除已接入各自受限路径，见[create.rs](../src-tauri/src/worktrees/create.rs)、[recycle.rs](../src-tauri/src/worktrees/recycle.rs)、[recover.rs](../src-tauri/src/worktrees/recover.rs)与[removal.rs](../src-tauri/src/worktrees/removal.rs)。目录、Git程序、引用、索引及材料仍按原对象和支持范围核验，不支持的对象拒绝处理；源码接通不等于整个Windows生命周期已验收。

Windows资料树与受控独立Git目录共用[recovery_pack.rs](../src-tauri/src/worktrees/recovery_pack.rs)中的唯一Manifest，沿[recovery_material_windows.rs](../src-tauri/src/worktrees/recovery_material_windows.rs)持久保存、重开、独立重建并完整复核。普通资料与完整安全资料显式区分：普通格式保留内容、EA、ADS及可读取的owner/group/DACL/完整性标签，不冒充完整SACL；旧完整安全记录不降级，生产不自动启用权限。当前已有受控Windows成功分项，也仍有进程结束无法确认导致的公开恢复失败；最新运行、具体条件与正式安装边界统一见[当前状态](status.md)。逻辑预算、前后复核与有限样本均不构成原子快照、RSS上限或完整平台证明。

<details>
<summary>早期Windows组件与运行记录（历史边界，不代表当前入口或未完成清单）</summary>

当前631增量中，Git有限输入在Windows命令重建之后安装；资料对象以同一持有文件核完整卷/128位身份、范围、哈希和前后版本。[private_bare_windows.rs](../src-tauri/src/worktrees/private_bare_windows.rs)及[git_source_export_windows.rs](../src-tauri/src/worktrees/git_source_export_windows.rs)已有受限内部消费者，但真实Windows新增7项/5项均在来源只读连接前提失败，尚未证明消费成功；后续29433以生产者原文件哈希、当前完整身份与关闭写句柄后的严格读取配对补交接；中间存在写入共享窗口，后续复核并不称连续不可变。公开变更入口与Manifest1部分资料拒绝门保持，不因内部模块存在就称完整归档或恢复。

[worktrees](../src-tauri/src/worktrees/mod.rs) 通过官方Git创建或接入独立目录；从提交内容创建，不复制原目录未提交修改，不执行项目钩子或自动访问网络。“使用”更新明确的新稿，不改既有历史的工作位置，也不自动合并项目更改。

Windows现有目录沿“检查、明确接入、重查”路径保存私有完整卷与文件身份；[read_context.rs](../src-tauri/src/worktrees/read_context.rs) 在一次只读操作期间持有经核查的本地目录、元数据和Git程序句柄，限定只读命令及配置环境，结束前重查身份。Unix原身份表示保持。目录凭据不是持续文件系统授权；当前正式应用中的Windows新建、归档、删除、恢复及依赖实际准备仍在入口拒绝，不能由已有目录接入推为整个生命周期完成。依赖元数据检查已有源码；后续9文件通过同一持有目录对象的完整扫描锁、原始UTF-16与完整128位身份配对22个固定名称及真实叶元数据，错误不变成缺失或部分成功。该源码已包含在5790的macOS安装中，但Windows实际执行未验，不代表材料完整保存、依赖安装或服务就绪；同步锁及内核等待不被15秒响应期限中止，新建、归档、删除、恢复仍拒绝。已有目录相关源码已安装到macOS应用，Windows真实运行尚未验证。

后续[material_windows.rs](../src-tauri/src/worktrees/material_windows.rs)以同一持有对象核默认数据、扩展属性、命名数据流及所有者、组和DACL；另读已存储完整性标签，不能将标签缺失推定为没有有效系统策略或完整SACL为空（[Windows说明](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)）。安全描述符使用有界缓冲并计入共同观察工作预算。[material_links.rs](../src-tauri/src/worktrees/material_links.rs)按完整卷/128位身份及原始UTF-16名称摘要核树内硬链接成员；树外或排除名称未计齐即拒绝，不越界寻找名称，也不声称原子快照。[material_owner.rs](../src-tauri/src/worktrees/material_owner.rs)统一保留无法确认清退的原句柄与读取上下文，此后拒绝再次观察，直到实际进程结束。

普通部分观察保留为Windows测试控制；已有两处归档消费者显式选择完整安全信息读取，由[security_full.rs](../src-tauri/src/file_access/windows/security_full.rs)在同一强权限对象上请求完整描述符，子对象继承同一用途。只使用当前令牌已具备的权限，不自动调整权限，不回退部分结果；实际返回的两次数据均计入预算，失败保留所处阶段，不能由拒绝码猜测某项权限。`windowsDefaultDataEaStreamsLinksFullSecurityV1`仍是部分资料类型，现有Windows操作入口和所有部分资料的完整恢复拒绝门保持；完整资料载体、硬链接重建、命名空间事务及恢复仍有内部开发，NTFS与完整SACL尚无完整成功证据。该批已随fa5689纳入macOS正式安装；Windows CI `39212793966`已完成失败，所选资料16项实际12通过/4失败、具体根因待证，不以步骤绿色显示、本机或交叉检查代替真实Windows行为。

631当时窗口的Windows资料16项实际16通过，准备元数据新增4项3通过/1失败，当前元数据配对的5项因筛选名错误实际0测试；旧失败不覆盖。有限输入7项和资料句柄6项通过，首次导入/源导出12项仍在前提前失败。后续源码的[私有提交根](../src-tauri/src/worktrees/git_source_roots_windows.rs)与SourceGraph沿同一持有来源核提交根及对象ID/类型/大小，实际进入恢复包捕获分支；对象观察本身不保存树资料字节。单节点测试组件的[实际字节消费](../src-tauri/src/file_access/windows/material_fragment_consumer.rs)已补独立文件读回，仍在成功后清退，不能作为可交付树。原staged拒绝与索引保护保持；完整可逆树/硬链接、唯一Manifest组合、公开恢复及最后命名空间仍有内部缺项。613选定Windows实际失败及后续源码检查分别见[新记录](evidence/2026-10-19-windows-recovery-components/verification.json)，不以交叉静态或未应用提案代替接线或实测。

历史源码`e24361c57`、`4e7ef1b83`及后续组件已随e7批次纳入正式安装；当时的未安装、CI待取和未运行说明不再代表当前状态。`ff17f29cb`为Windows固定Git操作保留原选定程序和持有范围，转换成同对象核验的DOS程序、目录参数及固定环境路径表示；原只读策略、执行/清退所有者、Unix行为及公开变更拒绝门保持。目录捕获、FFDIR1读回和新建目录恢复仍是测试注册的内部组件；部分读取与显式完整安全信息读取不混用，目标和载体在成功后清退，未知清退所有者保留。后续Windows运行`39370766363`固定`d004486a7`，304项选定正控245通过/59失败；四项Changed核到已归属硬链接操作前后仅分配量304→4096，具体分配机制未知。当前只在两处该操作前后调用独立非分配量比较，保留完整身份、内容、普通安全信息、时间与属性；内部快照稳定、原严格比较、同时别名、链接数及后续成员核验不变。新增独立一项比较安全控制，原304项断言保持；同源码f019的Windows运行39374585697中，四个原失败及新增1项实际通过，原304项仍255通过/49失败。该批已纳入macOS正式安装，完整Windows仍未完成。后续1dbcc测试诊断从原始同次Job查询保留BOOL及成功时的计数、失败时的错误，原保守判断和清退不变；39382612570实机原304项264通过/40失败，9条成功查询的非零计数不证明具体进程存活或原因，旧5项Unknown本次未复现。此查询源码与6fa正式源码相同，完整Windows及失败原因仍开放。本机、交叉检查与macOS安装不代替真实Windows行为。当前结果见[状态](status.md)；混合树、regular/alias拓扑、持久载体、唯一完整Manifest及公开操作仍有内部缺项，非原子前后复核和逻辑预算不构成RSS或全局背压证明。

</details>

当前[git_activity_observation_tests.rs](../src-tauri/src/windows_process/git_activity_observation_tests.rs)仅在Windows测试中记录原Job首次活动查询、同一原Child的零等待、一次最多32个关联ID的观察，以及原停止分支已有的有限成员状态；[current_members.rs](../src-tauri/src/windows_process/current_members.rs)另在首次不完整观察时记录原调用结果。诊断不改变生产判断，不追加重试或终止权限；关联ID、已持对象及完整/部分/失败列表分别说明，不能证明全部历史成员已结束。实际未确认结束的分支继续保留原所有者，具体失败与系统证明边界见[当前状态](status.md)。

归档前核对连接、进程、工作位置与资料；保留未提交、未跟踪和忽略材料的实际捕获范围，不能称为任意文件全量备份。后台工作仍持有独占操作许可，前端超时、取消等待或卸载不能提前释放。恢复与删除均复核真实目录和材料，不能只信元数据标记。

删除仅针对符合条件的本应用归档位置，先建立并验证独立恢复资料，再经精确确认派发。Unix沿非强制Git移除；Windows沿[remove_windows.rs](../src-tauri/src/worktrees/remove_windows.rs)复核已持有的原资料树后，通过原对象句柄删除，不按路径扫删或用强制Git移除代替。独立恢复从已验证材料显式生成新目录，不修改原仓库引用、索引或远端；恢复后仍需另行选择使用，见[recovery_pack.rs](../src-tauri/src/worktrees/recovery_pack.rs)与[remove_manager.rs](../src-tauri/src/worktrees/remove_manager.rs)。

### 存储故障与恢复

[StorageRecovery.tsx](../src/components/StorageRecovery.tsx) 在进入工作台前检查存储状态；只读、满盘、权限、损坏等由后端结构化原因分类，不解析任意错误文字猜测。可明确重试、查看资料位置或导出；可验证快照与未验证原文件副本分别标记，失败材料保留，不伪造成功副本。

[restore_commands.rs](../src-tauri/src/storage_recovery/restore_commands.rs) 在元数据库可用、但草稿或准备记录读取失败且尚未进入工作台时，允许从有效副本恢复相应项目；[database_commands.rs](../src-tauri/src/storage_recovery/database_commands.rs) 仅在无可编辑元数据库的存储故障壳提供完整Farfold元数据库恢复。预览捕获独立材料，确认前复核当前状态并保留原材料；完整库替换后重启复查，未知时核对原结果，不重复恢复。恢复不替换 Agent历史、系统凭据或项目，不是全应用数据备份/迁移承诺。

### 进程、通知与诊断

后端持有实际子进程及进程组和管道归属，标准错误持续排空；停止请求、退出码、管道EOF及进程组是否仍在分别处理。归属未确认时保留关闭状态，不按名称杀进程或批量清临时目录。[supervisor.rs](../src-tauri/src/supervisor.rs) 只回收能验证归属的遗留进程，旧不可信记录不用于终止其他进程。

通知有“需要处理”和“完成”两项独立偏好，默认关闭。完成提交从真实发送路径登记请求，只有匹配的正常结束、无未解决审批/工具/任务及失败信号等条件满足才进入系统提交，历史回放或单纯显示回复不触发。失效提醒会在可撤回阶段复核归属；系统已经接收不等于实际显示、声音或点击定位，这些以各自证据判断。

协议与启动诊断使用固定类型、字节数、错误类别等白名单，不保存提示词、正文、密钥或任意标准错误。父端管道诊断仅统计实际成功read/write字节、EOF与固定错误，并在相关包装器释放后汇总；不证明子进程已读、协议成功或操作系统资源全部退役。默认OpenCode初始化与重开根因仍未知。

研发只保留唯一正式应用，候选通过源码、工程、身份、架构、签名、归档、独审和数据保持后才替换。当前安装工具按每个同目录新临时文件完整写入、同步并原子更名，避免原位改Mach-O；五文件安装不是整个应用包的单次原子事务，失败保留现场，不自动重试、还原或启动。安装后移除精确候选副本，保留源码、ZIP与证据；不建立备份应用。

## 平台边界

macOS arm64是当前内部使用平台。公开签名、公证、分发及更新渠道仍按产品决定后置，本地ad-hoc签名或内部候选不代表公开可分发。开发模式与正式应用使用同一标识及数据目录，不能作为隔离测试环境同时运行。

Windows沿同一UI和协议模型实现：[process_platform.rs](../src-tauri/src/process_platform.rs) 及平台进程模块处理退出与进程树，PTY处理登录终端；凭据使用系统存储，[file_access/windows.rs](../src-tauri/src/file_access/windows.rs) 通过句柄和重解析点校验本地路径。UNC等未覆盖范围不自动视为支持。

[browser_workspace/windows](../src-tauri/src/browser_workspace/windows) 使用WebView2并保持网页与应用桥分离；工具通道使用当前用户管道。[desktop_notifications/windows.rs](../src-tauri/src/desktop_notifications/windows.rs) 的点击定位需要应用仍运行，不承诺冷启动激活。Windows依赖布局、安装配置与交叉编译分别留证，不能替代真实系统的路径、凭据、终端、通知、浏览器和恢复验证。

Linux、移动端、多窗口、编辑器及远程项目等边界按产品契约，不因共用源码存在而扩大。无需恢复已撤销的整组六条旅程或另一台Mac门槛；尚未覆盖的29家八项标准、长期稳定性与Windows实机等继续由活动计划追踪。

[docx_parse.ts](../src/runtime/docx_parse.ts)在单次解析内按不可变部分树缓存完整主动内容检查，并为脚注/尾注创建字面ID索引。索引的重复标记只在该ID被引用时拒绝；被读取部分内未被引用的注释节点仍须经过整树检查，原XML/块/文字上限、故事顺序与来源路径保持。缓存不跨文件或解析调用。

[thread-items.tsx](../src/components/thread-items.tsx)的共用工具输入沿[SearchDisclosure](../src/components/transcript-search.tsx)的renderBody按需生成完整JSON；命令和目录摘要始终可读。用户展开或临时搜索物化时生成全文，退出搜索按原用户选择保留或退役；不新增输入副本、事件存储或审批动作。
