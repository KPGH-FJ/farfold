# Farfold 源码架构

更新：2026-10-17。本页说明当前源码的职责与约束；产品要求以 [PRODUCT.md](../PRODUCT.md) 为准，实际通过、失败、未测和接续安排分别见[当前状态](status.md)与[唯一活动计划](../plans/agent-access.md)。

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

服务交付与直接API测试是独立路径：测试支持某个接口，不证明所有 Agent能使用它。仅按已核官方配置方式交付，原来源失效不能静默换号、换模型或回退默认服务。配置对象与日志不携带密钥；启动诊断只记录受控事实。

## 对话、草稿和请求生命周期

无工作文件夹也可写草稿；选位置前不预开 Agent对话，不回退到应用默认目录。选择工作位置及准备完成的 Agent后，可在首发前准备同一草稿；这不等于发消息或登记已接纳历史。首条消息接纳后，一个对话保留一个 Agent、一个官方会话及其服务来源。

前端以 [session_types.ts](../src/runtime/session_types.ts) 与 [sessions.ts](../src/runtime/sessions.ts) 保存当前连接、消息投影、队列和请求状态。后端管理进程、会话与命令归属。模型和推理仅在实际提供、安全空闲、回执匹配且保存成功后成为新请求与恢复基线；普通配置通知不是用户切换请求的成功回执。配置未知、停止未确认、保存失败或待审批时，不静默继续。

恢复标记保存实际已确认的配置和服务身份，不只保存显示文字。服务变化、旧配置缺字段或恢复失败会保留历史、草稿、附件和暂停队列，要求核对；默认配置不冒充原设置。配置与恢复入口见 [session_configuration.ts](../src/runtime/session_configuration.ts)、[session_config_recheck.ts](../src/runtime/session_config_recheck.ts) 与 [model_guard.rs](../src-tauri/src/acp_client/model_guard.rs)。

Agent的原始事件包括未知字段进入总线；工具、异步任务、压缩和停止按真实事件更新。取消请求发出不等于已经停止，进程退出也不等于上一请求正常完成。未知结果阻止普通重试和自动重发，不清除已发生外部操作的事实。

未发送内容与准备记录保存在meta_store的settings键中；文字、附件位置、意见与暂停队列可恢复，但附件需重新核验，保存失败明确呈现。保存退出采用单次共享操作和令牌校验，等当前保存完成；取消仅释放本次退出自己的锁，不释放更新、工作位置等其他操作的锁。重启仍受原有忙态与未知保护。

## 文件输入、成果和意见

输入资料先检查 Agent实际声明的能力及工作位置。图片输入的8 MiB、尺寸和动画规则由 [image_bytes.ts](../src/runtime/image_bytes.ts) 管理；它与收到消息的媒体预览是两个入口。音频、PDF、DOCX、XLSX等资料依各自格式、大小、部分内容提示及明确确认处理，不以附件位置或旧确认代替当前文件核验。

[document_input.ts](../src/runtime/document_input.ts) 及格式模块把明确选择的内容转换为可发送表示；本地版本信息用于防止误发旧文件，不伪造官方工具回执，也不把Farfold定位字段送成 Agent协议内容。DOCX作者文字、XLSX保存值/公式、PDF可提取文字都各有省略和准确性边界，不声称还原完整视觉排版或OCR。

文件成果分开“工具报告”与“磁盘核验”。消息中的写入参数、路径或差异摘要只证明报告内容；明确打开文件后，[file_access.rs](../src-tauri/src/file_access.rs) 才按路径和文件句柄边界读取。项目索引有遍历数量、深度、名称和时间预算，不是持久全文索引；同句柄校验不提供整个文件系统原子快照。

[OpenedFileView.tsx](../src/components/OpenedFileView.tsx) 及 [workers](../src/workers) 实现文字、Markdown、Office及PDF的有限预览。PPTX始终是部分预览；表格范围、PDF文字和DOCX结构不等同源应用全部显示。HTML由网页预览处理，其他文件可交系统应用。

意见绑定原对话、规范路径和具体磁盘版本；DOCX结构位置、XLSX单元格范围、PPTX预览位置等只对实际已解析的内容有效。明确加入原草稿后才由用户发送，不自动提交。刷新、切换、隐藏和迟到回包需核对版本与归属；自动刷新失败保留旧预览并标明状态，不能把旧位置当新文件。只有 Agent真实修改及重新核验文件，才证明返工完成。

## 消息图片与音频预览

收到的媒体由 [message_attachments.ts](../src/runtime/message_attachments.ts) 保留原payload与顺序，先核允许MIME、规范Base64及单项最多16 MiB，再核下述已覆盖的声明结构。显式展开才生成媒体DOM；搜索、折叠、普通消息呈现不自动加载媒体。远程地址不因预览而抓取，未知格式与原协议内容仍保留。

PNG检查签名、IHDR和有界容器布局；[message_apng_admission.ts](../src/runtime/message_apng_admission.ts) 核APNG控制块、帧序号、矩形与声明数量。JPEG、GIF、WebP、BMP由 [message_raster_admission.ts](../src/runtime/message_raster_admission.ts) 分派。支持范围内画布每边最多8192像素、总量最多16,777,216像素。GIF/WebP/APNG另限128动画帧、完整画布像素乘帧数最多67,108,864、遍历记录最多65,536；APNG独立默认图额外计入像素总量。PNG/APNG固定控制数据核CRC，压缩像素与其他负载不做全量CRC或解压；标准`image/apng`复用同一PNG准入。跨允许MIME标注的已识别格式也受相应约束。

AVIF入口 [message_avif_admission.ts](../src/runtime/message_avif_admission.ts) 使用有界容器、项目关联及序列检查，核已识别的画布、派生图片、辅助图片和样本声明，并沿共用画布、帧数、像素工作量与记录预算计额。容器尺寸不等于AV1位流的最大或中间帧尺寸；未知版本、编码布局及缺少可计额声明的兼容内容保持原支持，明确留为未覆盖，不能据此宣称全部AVIF受同样资源约束。

[message_avif_layers.ts](../src/runtime/message_avif_layers.ts) 解析已识别`a1lx`的空间层声明；按关联画布、声明层数与已有派生使用次数保守计入67,108,864像素工作量政策。空间层不当动画帧，不因`a1op`或`lsel`选择减少计额；该策略不推定解码器实际处理了哪些层。未知保留位保持未覆盖，但不跳过其他已知尺寸或工作量预算。

音频入口 [message_audio_admission.ts](../src/runtime/message_audio_admission.ts) 仅对已识别经典RIFF/WAVE做容器边界、填充和有界分片遍历；明确的线性PCM、IEEE浮点及标准扩展格式才按data字节、帧对齐和采样率核算，并采用600秒的消息预览策略。未知压缩编码、其他容器、wavl和播放列表保持原播放路径，不套用PCM时长公式。该策略不等于格式限制、实际播放/循环时长或解码与重采样内存保证。

经典WAVE未识别时，共用入口另调 [message_flac_admission.ts](../src/runtime/message_flac_admission.ts) 核原生`fLaC`标记、首个且唯一的STREAMINFO及有界元数据。已知总采样数与采样率沿600秒声明策略；总量为零的未知值、零采样率的非音频数据和保留元数据保持未覆盖，独立已知的超限仍拒绝。跨原允许音频MIME核实际标记，不新增格式入口；不扫描音频帧、嵌入图片或URI，不核实际解码内存或帧内参数变化。

[use_message_media_budget.ts](../src/runtime/use_message_media_budget.ts) 共用4个实例、32 MiB配额，按Base64所代表的文件字节计额；失败、折叠、卸载和来源变化按各自租约退役。[MessageAttachmentMedia.tsx](../src/components/MessageAttachmentMedia.tsx) 移除旧图片来源并处理重复挂载；音频暂停、清来源及重新加载沿其生命周期处理。可明确重试，不自动重复占用。

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

附件查找每次最多20文件、单源文件1 MiB、可检索文字合计16 MiB。各格式的页、段落、单元格或片段边界保留；PPTX/PDF未匹配不等于完整文件无匹配。它读取当前选中文件，不自动打开历史、连接 Agent或读取网页。

Markdown导出仅覆盖当前已加载的可读消息；资料包按实际选取文件打包，不补全 Agent完整历史。导出不是数据恢复备份。

“复制当前对话”调用 Agent官方复制能力，在本次处理时保存完整当前上下文；不是指定历史节点分支。父对话保留、子会话独立，项目文件仍共享；新连接不恢复旧网页等许可，不自动发送。复制已经派发而结果未知时禁止盲目再建。它不同于“用相同设置再开一段”和“从一条消息准备新稿”，后两者不复制完整历史，见 [session_fork_strings.ts](../src/runtime/session_fork_strings.ts)。

## 网页、标签和许可

前端每个对话管理标签与选中页，后端 [tab_commands.rs](../src-tauri/src/browser_workspace/tab_commands.rs)、[page_store.rs](../src-tauri/src/browser_workspace/page_store.rs) 管理真实页面身份。手动浏览、文件预览和 Agent读取是不同授权。隐藏或收起可保留页面与许可；明确关闭、换页或连接结束撤回旧范围，旧页面回包不得沿用到新页。

公开网页使用隔离网页存储；macOS本地HTML专用存档按规范项目/文件范围区分。多文件项目和本地开发服务器通过各自路径、来源与网络规则预览，不把只读预览策略称为操作系统沙箱。网页没有Tauri应用桥，页面内容也不能直接成为工作台指令。

当前网页工具包括观察、读取快照以及经确认的节点点击和普通输入；生产截图仍因系统安全证据不足不可用。节点身份、页面版本与许可需在执行时核对；敏感输入、登录或页面请求不能自行扩权。交付点击命令不等于网站业务动作完成。

[browser_sharing.rs](../src-tauri/src/browser_sharing.rs) 与接入层临时工具配置建立本次连接通道：macOS用私有Unix socket，Windows用当前用户管道，权限令牌不持久保存。辅助进程先消费临时秘密再进入普通应用初始化；准备、确认、连接结束与资源清理有独立归属。该接入不是29家网页能力验收。

[remembered_pages.rs](../src-tauri/src/browser_workspace/remembered_pages.rs) 只在用户逐页核对并确认无秘密后保存公开网址、所属对话与顺序。重启只列清单，点击后才打开；不保存旧读取许可，不自动恢复页面。关闭页面保留清单，忘记或清空只移除相应记录。

## 技能与MCP清单、管理

能力由已核官方接口决定，共用 [AgentExtensionInventory.tsx](../src/components/AgentExtensionInventory.tsx) 展示。选择工作位置、切换范围或检查读取方式不等于实际查询；清单有来源、范围、时间和部分失败提示。MCP配置报告不证明连接、具体工具调用或当前对话生效；技能报告也不证明已经安装或执行。

临时任务核对程序、工作位置、配置及能力身份，按固定官方调用查询，不发送对话消息，不附加Farfold保存的服务密钥。官方程序仍可能使用已有登录、访问网络或维护自己的缓存。取消、超时及组件关闭不会把尚未结束的任务当作停止；保留清理许可与已派发写入事实，不自动重试。

额外技能目录仅用于一次明确查询：UI先支持单目录，请求结构最多4个有序目录；与默认技能合并，不是只列额外目录。后端在初始化、设置确认与列表读取间复核目录身份，设置ACK和返回范围必须匹配。非空额外目录得到的整份报告均只读，无管理目标，后端也拒绝绕过；不安装技能，不持久配置，不使当前对话自动采用，见 [extra_skill_roots.rs](../src-tauri/src/acp_client/extension_inventory/extra_skill_roots.rs)。

普通范围的技能启停及部分MCP管理属于独立审阅流程；必须取得当前有效目标、确认实际修改内容，满足忙态与清理门禁后才调用官方方式。管理入口并非所有来源、操作或29家全支持，配置修改成功也不替代当前对话实际采用及具体工具测试。

## 数据、工作位置和系统生命周期

### 持久化归属

[meta_store/schema.rs](../src-tauri/src/meta_store/schema.rs) 当前保留 agents、sessions、settings、dismissed_sessions 四表。内容是Farfold自有接入登记、对话索引、设置与相应整理记录；草稿、准备记录、分组、网页清单等放入受限设置结构。Agent消息、工具事件及完整历史不另建账本。

服务密钥归系统凭据存储，项目成果归用户选定目录，Agent历史/账号/模型配置归各 Agent。工作位置只是请求及文件操作上下文，不保证不同对话的项目文件、账号、依赖和端口隔离。[lifemodel.rs](../src-tauri/src/lifemodel.rs) 仅保留默认关闭设置与空钩子，没有真实采集或注入。

### 并行工作位置与维护

[worktrees](../src-tauri/src/worktrees/mod.rs) 通过官方Git创建或接入独立目录；从提交内容创建，不复制原目录未提交修改，不执行项目钩子或自动访问网络。“使用”更新明确的新稿，不改既有历史的工作位置，也不自动合并项目更改。

归档前核对连接、进程、工作位置与资料；保留未提交、未跟踪和忽略材料的实际捕获范围，不能称为任意文件全量备份。后台工作仍持有独占操作许可，前端超时、取消等待或卸载不能提前释放。恢复与删除均复核真实目录和材料，不能只信元数据标记。

删除仅针对符合条件的本应用归档位置，先建立并验证独立恢复资料，再经精确确认使用非强制Git操作。独立恢复从已验证材料显式生成新目录，不修改原仓库引用、索引或远端；恢复后仍需另行选择使用，见 [recovery_pack.rs](../src-tauri/src/worktrees/recovery_pack.rs) 与 [remove_manager.rs](../src-tauri/src/worktrees/remove_manager.rs)。

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
