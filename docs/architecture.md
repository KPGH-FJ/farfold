# 当前源码架构

## 当前架构摘要（2026-10-09）

原型 07 已接入正式工作台，最近安装与有限实机核对见 [当前状态](status.md)；原型示例、工程检查和真实 Agent 工作仍分开记证。本文的模块职责以当前源码为准，带日期小节保留当时实现的范围；其中“本片”“首片”“当时未安装”等不是新的执行指令，也不能覆盖后续已实现能力。

- React/Tauri 共用一套工作台，官方 ACP 接入层连接外部 Agent。Agent 拥有推理、工具、账号、模型、历史与技能；Farfold 不建立第二个循环、不代写其配置。当前没有声明客户端文件/终端能力；未来是否需要承接官方回调由活动计划 ARCH-44 逐项核实，不能把这类回调一概等同第二个循环。
- 每个工作对话有独立进程，准备连接可按其用途复用；独立进程不隔离 Agent 自己共享的账号、配置和项目文件。模型/推理可在同一对话安全空闲时按官方能力变更，确认并保存后生效。
- 当前官方目录限用户保留的29项，八项标准与逐家真实验证边界见产品契约和状态页；目录过滤不是兼容性或验收成功证明。
- 无工作文件夹时保留草稿，不预开工作对话、不发送、不回退应用目录。未发送内容和准备选择已有持久保存；Agent正文仍由官方历史接口提供，不建正文账本。
- 文件可核验、查看、另存并提出版本意见；文字/Markdown/HTML与其他格式的呈现边界分别处理。网页已有公开页、本地单文件、多文件目录和开发服务器路径，工具声明包含读取、观察、点击和普通输入；生产截图明确不可用，工具实际接入覆盖仍有限。
- Windows 系统适配已进入源码，实机运行与macOS证据分开；公开分发、正式签名和更新渠道按用户决定延后，不作为本轮开发门槛。

## 完成提醒与附件媒体（2026-10-10 源码增量）

`success_notification.ts` 仅跟踪当前实际发送在内存中的完成候选；结合官方结束事件、实际呈现终态及工具、批准、提问、后台工作，满足条件才向共用通知服务提出完成提醒。`desktop_notifications.ts` 维护独立完成偏好与需要回应偏好，沿用共用声音、前后台判断及点击定位；历史回放、未知或失败不生成完成提醒。它不保存Agent消息或重建事件账本。

`desktop_notifications/tickets.rs` 复用现有渲染进程随机标记与请求序号，管理有界且不持久化的待派发票据；批准或提问失效、对话关闭及归属变化可精确撤回。后端在异步系统检查后及平台调用前重核偏好和票据；只有实际平台调用开始才越过撤回边界。已经开始调用不证明系统接收、显示或声音；未知结果不自动重发。

`MessageAttachmentMedia` 在已有媒体准入及用户明确展开之后处理图片/音频解码失败，重试只使用相同已准入内容。收起或换内容时清理自己的播放器；严格模式重新挂载只恢复原已准入来源。正式内容策略只增加本地与内嵌数据媒体来源，远程媒体仍被限制；搜索临时展开不获得媒体授权。工程、受控浏览器、正式应用及真实Agent证据分别见当前状态。

## 工作位置与后台任务（2026-10-10 源码增量）

`worktrees/` 通过官方 Git 管理明确选择的创建、已有目录接入、状态重查和清单元数据；使用精确提交及独立检出上下文，不执行仓库钩子或隐式下载，不复制原目录未提交/忽略内容。操作意图先保存，成功后核目录与 Git 身份；失败或未知保留材料，冷启动不自动重做。`WorktreeDialog` / `worktrees.ts` 经明确使用和新鲜检查只更新原未发送草稿，不改既有对话位置。创建状态与退出、更新、清除数据共用准入保护。

`recycle_manager.rs` / `recycle.rs` 新增自有工作树保留归档与原路径恢复；通过官方 Git 在同一文件系统移动完整目录，核实目录身份、索引和包含未提交、未跟踪及忽略内容的有界材料摘要。归档不作为新工作目录，不改历史对话位置，也不等于独立备份。影响预览、草稿保存基线、元数据比较写入与全局维护准入共同保护派发；所有相关连接确切退出后才移动。`worktree_maintenance.rs` 在同一 SQLite 连接封住迟到写入，专用比较写入只在持锁时短暂开放；实际工作结束并保存结果后才释放维护许可。文件检查与导出持有的准入随真实阻塞工作保留，不因前端等待结束而提前释放。

前端管理窗口位于草稿交互锁之外，独立维护许可与草稿位置使用许可分别持有；迟到的准备、取消和超时不自动再次派发。归档记录可以独立重新核查，不依赖最后一次操作仍在。源码与实际安装验证的边界见当前状态。

`remove_manager.rs` / `removal.rs` 承接已归档、自有且无额外材料的工作树删除。准备阶段先生成独立提交恢复副本，并实际检出核验；准备成功只进入等待确认，不授予普通开始接口删除能力。删除确认与具体操作、归档修订、恢复副本及摘要对应，复核后才调用不带强制选项的官方 Git 删除。目录身份、内容、提交根、草稿或维护归属变化均拒绝继续；取消、迟到和冷启动不自动获得删除许可。脏文件、未跟踪和忽略材料仍通过保留式归档处理。

`recovery_roots.rs` / `recovery_pack.rs` 收集所覆盖的提交、工作树私有引用和日志可达对象，有界生成包与清单，在源仓库外的专属目录保留。只保存必要位置和校验元数据；不修改源引用、索引、配置或远端。`recover_manager.rs` / `recover.rs` 经显式核验及开始操作，把副本恢复到用户选定的新文件夹，所得目录属于已有目录，仍需另行选择使用；不改旧对话位置，不自动迁移历史。恢复过程和结束时核对目录身份，失败保留未知材料；这些检查不构成对其他进程的文件系统排他锁。当前覆盖、容量限制及未验证环境见活动计划和证据。

`acp_client/async_tasks.rs` 仅在双方实际协商 AIR `asyncTasks` 后承接官方事件，并通过原连接 `_session/async_task/stop` 请求停止指定任务；任务归属、停止回执和最终事件分别处理。`AsyncTasks` 共用呈现，不按 Agent 名称分支；失联或溢出保持未知，后台未完工作阻止配置切换。已核合法事件的原文详情使用“后台任务更新”，未知或不匹配事件保留原文与未知说明；此分类不改变控制状态。它不新建执行循环或持久事件账本。工程、安装和真实 Agent 的验证边界见当前状态。

## 项目文件选择（2026-10-10源码增量）

`project_index`按文件数、目录深度、条目、路径文字容量和时间预算返回候选文件，明确报告截断、读取失败和排除范围，不维护持久项目索引。临时请求身份只用于有界取消和防重复；真实读取线程持有共享读取准入，观察超时不释放仍在执行的工作。目录枚举前后检查稳定身份变化，不能据此保证全树原子快照。选中文本复用`file_access`同句柄有界读取和前后身份检查，发送前仍统一重新核验附件。

`useProjectFiles`在草稿、位置或界面离开时退休旧结果，取消与重试只操作本次可见请求。`ProjectFileScanNotice`显示等待、范围及失败，提供系统文件选择入口；查询中仍可编辑输入。工程、受控界面和正式实测分别记录，未知扫描结束状态不显示已停止。

## Windows 平台适配（2026-10-06）

前端继续使用同一工作台；`file_paths.ts` 和 `platform_shortcuts.ts` 处理 Windows 路径与 Ctrl 操作。`process_platform`、`windows_process`、`pty` 与 `supervisor` 保持选定命令、参数、环境和工作目录，Windows 用由父进程持有的 Job 管理进程树；自身辅助入口先入组再启动外部程序，不实现 Agent 循环。

`auth/windows_vault.rs` 使用当前用户的系统凭据；`file_access/windows.rs` 以相对目录句柄逐层打开并拒重解析点，保留读取前后身份核对与精确临时导出。当前文件服务支持本机磁盘，UNC、链接和重解析目录不在本片范围。

`browser_workspace/windows` 独立创建 WebView2，页面没有应用桥；固定脚本在隔离环境内观察和操作，目录资源由原文件许可提供。网页共享以当前登录身份限制的私有命名管道连接，撤回与停止确认仍沿共用协议。`desktop_notifications/windows.rs` 使用系统实际状态，点击仅定位正在运行的应用；未实现冷启动通知激活。

Node/uv/Python 与 Registry 安装按官方 Windows 发行布局处理，不猜缺失的下载地址。`tauri.windows.conf.json` 提供当前用户安装包配置，Windows 工作流只在明确触发时运行验证、保留未签名产物，不发布。交叉编译与 Windows 实际运行、安装、签名、更新分开验收。

## 共用连接、模型与账号（2026-10-06）

`connection_identity.rs` 将准备连接与每个工作对话的独立进程分开；临时 `connectionId` 只用于事件、页面持有与精确关闭，不写持久会话绑定。`OpenReservations` 在新建/加载未确认时保留请求与已返回编号，直到实际进程回收；已活动或已存编号不能被新建结果覆盖。同Agent账号动作覆盖全部服务；独立进程不等于共享磁盘配置或凭据已隔离。

`session_config.rs` 依据实际响应合并现代配置与旧模型声明，沿单一UI和 `ModelGuard` 确认/保存/恢复。现代模型优先；旧setter的合法空对象仅按旧契约处理，思考选项必须得到所需更新；现代空响应及畸形通知继续阻止发送。原始事件保留，归一化配置另经现有Channel交付。

`account_status.rs` 只接受握手声明的 `_auth/status_update`；初始化期间的早到推送保留受限投影，声明确认后呈现。账号字段仅为内存中的种类、邮箱、档位，未知/退出会撤下旧身份，不落库或诊断。`connection_account.ts` 先监听再查询，准备与会话按连接范围选择；用户选定API服务不由Agent自身账号推送覆盖。

## 共用模型主控件识别补正（2026-10-05）

部分官方接口把 provider 与具体 model 同时声明为 model 类别。`modelConfigOption` 不再按数组第一项决定主模型：单项保留原能力兼容，多项时仅选择唯一明确的 model 标识或名称，歧义保持未确认。其他配置继续由原 `SessionOptionsList` 显示；所有同类配置仍由原保护与恢复链处理，不替 Agent 选择提供方、不改账号或引入品牌分支。安装实测触发与受影响验证见[取消补验与代表兼容核查](evidence/2026-10-05-installed-acceptance/supplement-1310/README.md)。

## 安装实测后的浏览器与文件修正（2026-10-05）

`EmptyState` 的原 `new` Composer 通过稳定 portal 宿主进入已预开草稿的 `ThreadPage`，保持一个输入实例、原附件及 remember/send/finish 首发链；不另开模型请求、不提前写历史索引。`ThreadView` 可凭实际 nativeSessionId 观察网页工具准备状态，仍由真实请求和用户许可决定读取。App 最多保留当前任务、准备中的新草稿及唯一页面拥有者三个界面壳；隐藏任务不接受新动作，分享 controller 继续观察原请求，首发不卸载原网页。

`browser_surface_guard` 的普通导航先等待真实隐藏回执，页面和待确认请求保持；明确关闭、替换页面、网页跳转或连接结束仍沿原失效链。隐藏失败的“关闭网页并继续”是用户明确选择的关闭，会取消原请求。BrowserWorkspace 卸载只定向关闭自身仍登记的 scope，覆盖替换后 owner，旧回调不抢回新任务；不维护第二个请求账本或重建 Agent 循环。

本地 HTML 的 `projectDirectory` 来自当前任务 cwd，独立于文件核实回执的 root；后端规范化项目与文件路径，派生稳定 HTTPS 来源及专用 WebKit UUID 分区。macOS 14+使用官方持久分区，旧系统返回 `localStoragePersistent=false` 并使用临时分区，公开网页仍临时。文件内容继续经完整 VerifiedFile 回执读入内存，领先 CSP、无应用桥和禁止联网/嵌套内容保持；未扩大目录读取权限。分区不随文件内容更新改变，路径迁移不自动迁移存档。

`browser_workspace_clear_html_storage` 只接受当前 task/label，从精确页面取分区，串行关闭后仅清该分区的数据。UI 先确认项目/文件；原生层的分区在途保护持续到官方回调，Rust 等待超时不提前开放重建，避免迟到清理影响新写入。存档由页面主动写入，不恢复JavaScript内存或Agent许可。文件交付“打开”统一分派到HTML或实际磁盘内容栏，再沿原重读/意见链；缺内部查看回调时才使用系统打开。

工程与安装证据见[本轮安装验收](evidence/2026-10-05-installed-acceptance/README.md)。真实安装版、受控WK与源码核查分别记结果，不能互相替代。以下日期小节保留各次实现的历史边界；涉及任务导航和临时存档时以上文当前行为为准。

## 技能与工具清单

`acp_client/extension_inventory/` 承接已核实官方入口的独立配置查询，界面通过同一个 `AgentDetails` 中的 `AgentExtensionInventory` 使用能力声明。当前分别读取官方 MCP 配置报告与技能报告：后者经固定 initialize → initialized → skills/list 请求，显示受限名称、纯文本说明、来源与部分读取失败。两类查询共用操作归属及进程清理；不把启用或认证字段当成连接成功、技能/工具执行或当前对话已生效。限定名显示缺陷已在两端修复，通过工程检查及39955ec6正式分项复验；完整工具及管理仍未完成。接入层之外不按 Agent 品牌分支。

能力读取签发短时内存标识，只在后端保存对应的实际程序选择；查询前后复核选择及目录，配置改变或标识过期拒绝继续。真实查询进程拥有配置锁和全局活动保护，观察者超时、取消请求和进程确切结束分别处理。标准输出只经有界白名单解析进入界面，原始输出及凭据不进入日志或持久存储；保留官方程序原有环境，不附加 Farfold 所选服务的密钥、不代写配置。该命令可使用程序自身已有登录状态和缓存，不承诺其内部行为无副作用。

前端只在明确选择目录并点击查询后执行，旧结果保留目录、时间和过期提示。界面关闭、切换目录或修改程序选择会退休旧请求归属；未知结果保持可查询状态，不自动重发。工程、正式窗口和实际官方命令的证据分别见当前状态，不能由源码入口推定 P39/P40/P41 完成。

## 官方 Node 工具接入与共享反馈（2026-10-05）

`acp_client/browser_capability.rs` 核 registry Codex 的直接入口或官方 npm 单入口公开 manifest，来源核定不替代 ACP 握手，也无版本/SHA准入。实际 Node 进程在 `process.rs` 按 Command 覆盖/继承语义固定 APP_SERVER_LOGS 与 CODEX_CONFIG 的有效值及缺省，只保存日志布尔和内联 MCP 三态；成功 spawn 后才公布到该连接。READY复用沿原事实，直接二进制不套 Node 条件。`session.rs` 在本次 new/load 入队前拒绝并撤销不安全offer；原因随现有 SessionEntry 保存到路由结束，BrowserSharing状态只返回受限原因，不保存秘密或新账本。

公开 Node/Codex 原函数的合成执行核磁盘不同名 MCP 递归保留，同时复现调试日志、内联 exact/dotted MCP 覆盖。Farfold不读写用户MCP配置，不热改活跃对话。`tools/list`完整写出回执仍仅证明目录提供，原页面许可和实际工具结果分别处理。[本片证据](evidence/2026-10-05-mcp-file-feedback/README.md)。

`browser_sharing.ts` 区分无可查询目标、断开、查询与失败，暂离保留观察但禁止动作。`browser_sharing_attention.ts` 仅保存当前 task/request，按controller所有者清理；`session_browser_attention.ts` 映射到现有 ThreadState/hasPendingRequests，刷新不持久化队列。未知回执保留pending并禁批准，可信结束才清；断连保留原未知结果保护。ThreadView显式返回原卡并尊重用户上翻位置。

`OpenedFileView` 先核对所选文件，再按格式读取文字、图片/PDF或Office内容。首次打开或手动重读失败撤下旧正文；自动刷新则在新快照准备成功后替换，失败保留旧快照并显示状态。反馈以原thread、规范路径、磁盘version/sha构成disk专用版本标识，复用fileFeedbackDrafts和原子take，只追加原输入，不伪造diff或toolCallId，不自动发送。隐藏、换任务、卸载、重读及版本变化使旧回调失效。 XLSX位置意见由实际捕获、已解析工作表、当前窗口与当前单元格生成短期有效的候选；只在明确确认后保存真实工作表关系ID、名称、行列范围和文件版本，合并单元格保留完整范围。隐藏内容须明确显示后才可作为目标，切换、隐藏、失败或重读立即撤回旧候选。保存坐标供历史意见表达，不作为当前文件仍在相同位置的证明；共用意见草稿和加入输入流程，不改变Agent执行。

DOCX段落/表格位置取自原始XML元素树：保存文档内部文件名和逐层元素子索引，保留属性节点、兼容包装与脚注分隔符的原始位置，不把显示序号当原文件坐标。Worker回值同时受实际捕获文件集合、路径深度与累计元数据预算检查。界面只有已显示且可定位的整段/整表可以成为候选，遗漏提示或全隐藏段落不能伪装成已显示正文；实际同文块仍用不同原坐标。明确确认沿共用Office意见流程，选择、分片、区域、表格窗口与详情切换分别管理候选，旧版本意见继续保留。自动准备替换只暂时阻止交互，不以隐藏视图的方式重启读取。实际安装覆盖以 `docs/status.md` 为准。

## 2026-10-04 桌面界面与读取确认增量

`desktop-workbench.css` 对现有工作台施加统一样式，App/ThreadView 控制同一内容栏的文件/网页模式；模型、推理、权限与发送仍由原组件和真实能力驱动。`ArtifactPane` 保持 BrowserWorkspace 挂载，`visible` 与路由 `active` 分离：收起调用 `browser_workspace_set_visible` 隐藏实际 WK，打开/恢复在途先保留占位，收到 hide/close 回执才释放；原路由关闭协调器继续处理退出与覆盖浮层。`onStateChange` 只交付地址、状态与页面修订，输入区网页提示不会改写 prompt。Markdown 列表、窄窗和暗色以实际组件合成渲染检查。

`browser_sharing/permission.rs` 在原连接内存中保存带 nonce 的待确认范围，经 `browser-sharing:changed` 发送 taskKey。`browser_share_respond` 重新核实目标、页面及请求身份；批准继续原 MCP id，拒绝、120 秒超时、标准取消、导航、关闭或断连结束原等待。批准前只读页面元数据，最终输出仍使用原停止屏障。前端 `browser_sharing.ts` 先监听再查询，过滤迟到操作；revision 属于工具连接，最新权威查询允许重连后归零，操作回执仍受顺序检查。`BrowserReadRequest` 放在原待回应区，`BrowserShareControls` 供现有内容栏共享状态及撤回；两者没有另发消息或正文持久化。

以下为当前模块职责与数据边界，已发生的安装与分项结果见 [status.md](status.md)，不以本文替代验收。客户端文件/终端能力（`fs_ops.rs`、`terminal_ops.rs`）已删除。产品要求见 [PRODUCT.md](../PRODUCT.md)。

## 全产品工作台

`App` 统一装配新对话、对话库、对话内容、Agent 发现与设置五类视图。`Sidebar` 提供新对话、全部对话、收藏、探索 Agent、按 Agent 查看及用户分组；状态筛选和搜索由 `ConversationLibrary` 处理。这些入口只改变浏览范围，不改变已有对话的 Agent、模型或工作目录。对话库复用现有索引和内存状态，支持标题/文件夹搜索、Agent/分组/状态筛选、收藏、重命名、批量归档与分组整理；对话顶栏查找只检索当前已呈现内容，没有新增跨历史正文搜索库。

`collections.ts` 将分组定义和对话到分组的关系保存在现有 MetaStore settings 的 `conversationGroups.v1` 中；写入串行，成功后才发布新状态，失败保留最后确认值。只有完整识别的旧格式才能载入；未知字段、损坏成员或无对应分组的关系整条拒绝，保持未就绪并允许重读，不静默裁剪后覆盖原值。未保存记录仍允许从空分组开始。删除分组只删除该分组和对应关系，不删除对话。收藏和归档继续使用 `sessions` 索引已有的 `pinned`、`archived` 字段；分组不是目录，也不承载正文。`CollectionActionScope` 防止重复动作，并使迟到结果不回填到已关闭或切换的整理界面。

新对话由 `EmptyState` 与同一个 `Composer` 完成。`drafts.ts` 管理新草稿、会话输入、队列编辑、文件意见和新对话选择；`draft_storage.ts` 将这些未发送内容与整理所需活动元数据一起保存到现有 MetaStore settings 的 `unsentWork.v1`，支持重启恢复。`setup_storage.ts` 另将准备步骤、选择与明确完成标志保存到 `agentSetup.v1`；它不保存认证或真实请求成功状态。`DraftStartup` 在两份记录成功读取前阻止编辑，格式未知或读取失败不会覆盖原值；异步保存串行合并新改动，发送和退出前等待保存及图片读取完成。这里保存的是用户未发送内容，不是 Agent 正文或事件历史。

`pending_conversation.ts` 在首发前保存实际已打开的 Agent、目录、对话和来源；发送结果不确定时保留这个目标，查看与恢复不按当前新稿选择猜测，也不自动重发。接纳后只清理仍属于所提交快照的输入，后续编辑继续保留。`queue_edit.ts` 在本次运行中用原消息对象确认编辑目标；重启保留编辑内容，但不会按索引或相同文字猜测重复消息的归属。

新对话的 `EmptyState` 仅使用用户明确选择并保留的工作文件夹；按2026-10-07规则，无位置时可编辑草稿，发送或使用文件入口才请求选择，取消保留输入。未选时不预开工作对话或发送，清除位置不回落到默认目录，迟到选择或旧发送回调不能越过位置检查。文件夹入口在输入区持续可见，与消息附件和 Agent 选项分开。已有对话保留原 `cwd`。`app_default_working_directory` 仍为全局 Agent 准备在应用数据目录下提供稳定的 `conversations` 子目录，macOS 对应 `~/Library/Application Support/ai.farfold.desktop/conversations`，并校验规范化路径没有指向其他位置；它不再是未选文件夹的新对话默认位置，不取用户 HOME、不重写 Agent 配置，也不创建私有 HOME。

`agent_readiness.ts` 共用已有准备完成记录、明确保存的选择和已知认证/配置阻塞，为新建选择提供资格判断；准备完成的已登记 Agent 不要求进程当前运行。侧栏历史分类另按目录范围及已准备或有历史判断，不随连接断开消失。完整 `agents.cards` 继续提供探索、设置和历史；仅登记/安装不进入新建候选。资格读取不启动 Agent、不认证或发消息；新对话在实际工作位置另核当前来源和请求条件，待命不代表认证当前有效。

`App` 在切换主要视图时保留开始页和当前对话挂载；Agent 发现、设置与访问过的 API 页也保留。隐藏页面通过 `active` 限制输入、审批快捷键、预开操作及顶层弹窗，未保存的 API 表单只留在内存，暂离后可恢复。返回栈保存原对话 key、设置页签，以及 Agent 页的目标、use/manage 意图、准备上下文、筛选/弹窗状态和原草稿快照；从准备页经 API 设置管理另一 Agent 后，仍能返回原入口。

从已有对话直接管理其 Agent 时，`agent_repair.ts` 传入只读来源、模型与思考上下文；按错误定位账号、模型或程序，完成返回原对话，不改首次准备进度或既有选择。普通探索不携带这个只读上下文；卡片的显式新建与非只读准备完成以 `new-conversation` 表达新建意图，同 Agent 或跨 Agent 都进入新草稿。历史导入的准备返回优先保留原查找。应用新选择前，`draft_choice.ts` 检查是否会覆盖另一个入口留下的草稿，需确认时先保留原稿。后台执行仍由现有会话管理器负责，没有第二套消息、审批或执行实现。

`connection_intent.ts` 只保存本次应用内限制自动连接的操作意图，阻止组件刷新越过该限制；显式选择、打开或准备动作才重新允许。它是内部保护，不提供已取消的用户面“断开”步骤；程序及账号操作由后端释放安全空闲连接并核实结束，活动工作继续受保护。`connection_hold.ts` 用本地 IPC 为当前页面持有精确连接，切页释放，处理迟到获取与清理；没有模型心跳或前端回收计时器。后端 `ConnectionLife` 在同一锁内管理页面持有、会话保留、操作及关闭，当前只对没有以上保留且空闲30分钟的连接回收。任何仍有会话或未确认会话交付的连接保持，不能只凭恢复能力声明结束。关闭原因随原事件通道即时发布；历史恢复保留未知结果和暂停队列，不发送旧内容。

## Agent 与 API 配置

`AgentHub` 使用 `agents.cards` 展示官方目录、本机发现和自定义接入，支持发现/已添加、搜索、来源和安装可用性筛选。首次准备完成记录经保存确认且没有待处理账号/配置阻塞的条目提供新对话入口；进程未运行时显示待命并按需连接，未完成时主按钮和设置均续同一准备。首次使用与日常管理共用 `AgentSetup` 的程序/账号与服务/模型页签，视觉与键盘顺序一致：未连接进入程序，新接入连接成功先进入账号与服务，由用户按实际条件继续选模型；已有保存步骤、来源与模型不重置，明确的认证要求进入账号；进行中或结果未知的登录保持可访问。明确完成才保存新建选择并交回原稿，不自动发送；旧会话管理只返回原会话。关闭和暂离不提交新建选择。两种入口共用 `AgentPrerequisites`、`ProgramManager`、`AgentAuthSection` 和来源选择，不复制管理面板。

`setup_storage.ts` 在 MetaStore 的 `agentSetup.v1` 中分别保存准备进度与明确确认的新建选择。探索卡片和输入区切换 Agent 使用已确认选择，准备进度仍按入口隔离；写入成功才发布确认，失败可重试，移除后的迟到写入不能恢复选择。旧记录只能在完成标记、入口与选择一致时迁移，否则回到确认步骤。完成准备不是登录或模型请求的成功凭据。

R5 接入呈现复用上述页面。`AgentConnectionPicker` 将真实可执行的认证方法、官方终端设置动作与已声明的 API 服务能力组合为同一纵向单选列表；选择只保留意图，`access_primary.ts` 把表单当前动作交给唯一底部按钮，并在执行前复核当前目标和禁用状态。官方设置仍由原 PTY 执行，取消审阅回到列表并保留选项；完成摘要区分真实认证、设置检查和仅连接检查，失败或取消记录不因重查成功被覆盖。

接入第二步的 `ServicePicker mode="service"` 只选择服务身份与修订，可在进度中保留空模型；第三步 `ServiceModelPicker` 要求明确选择该服务支持的模型，才允许读取模型设置与完成准备。已确认的新建选择仍要求非空有效模型，不默认取第一个。服务摘要只有有效来源且结束编辑时显示；更换服务恢复选择区，读取失败、旧修订、缺失服务和不支持格式继续保护。通用服务页的其他调用方仍使用原服务与模型一起选择方式。

`acp_client/first_release.rs` 仅维护用户主动缩减后的当前 29 项精确目录 ID。`catalog_list` 与目录安装/准备按此范围提供条目；远端原始缓存保留，范围判定不改变协议兼容性。客户端仍合并所有已有登记，自定义、本机程序与历史不删除；当前范围和历史证据见[目录说明](agent-first-release.md)。

安装前的公开启动模型字段由 `acp_client/recipes.rs` 核实声明，`installation_parameters.rs` 生成通用字段和审阅身份。准备页只读缓存，不因打开页面刷新网络；实际安装在配置锁内取得同一目录快照，核验审阅后才准备工具及程序。身份包含公开分发环境，原用户环境不进入摘要或界面。`AgentInstallOptions` 供首次安装与更新共用；可选空值沿用官方启动设置，公开目录回退只作说明，不覆盖会话选择。输入保存在既有准备进度，确认后的字面参数进入原安装收据；不能完整保留的旧额外参数拒绝更新，失败与取消不改变原目标。当前核实入口仅覆盖 fast-agent 0.10.1 的官方 `--model` 公开名称或模型代号，真实效果见对应候选证据。

`agent_preparation.ts` 通过普通 `threads` 打开独立检查草稿读取模型选项；读取、失败重试与可选短消息测试分别呈现，只有用户明确测试才发送。测试结果要求消息已接纳、回复精确匹配及成功终态，不能将连接或读取选项当作请求可用。程序、账号、服务或显式模型选择变化使旧结果失效；旧准备只能补充省略的默认值，不能覆盖调用方的新选择。模型设置返回同时校验当前入口，迟到结果不回填到另一个选择。它只拥有准备显示和本次操作，不新增执行器或正文存储。

配置动作后的明确读取要求由同一准备控制器持有，目录、新稿与已有未接纳草稿都消费该要求；只有当前明确读取成功并应用原选项后解除，失败、迟到或选择变化继续保留。读取错误与之后真实消息失败分别记录，失败结果不能把额外默认选项写回用户选择。动作审阅与运行使用同一规范化目录，但不改用户显示或保存的路径。准备页通过 `preserveOrigin` 保留原对话，独立准备进度沿既有入口隔离，返回不覆盖其他目录的未完成进度。

模型读取还比较本次明确请求的选项与实际返回值；不一致时保留调用方选择和本次失败，只在明确重试后重新读取。顶层 `modes` 合成的模式在普通选项更新时保留，真实同名或同类别配置优先。新草稿恢复合成模式使用标准 `session/set_mode`，不将它作为任意配置 ID 发送；既有对话的模型、思考以最近确认并保存的选择恢复；实际不一致仍保护发送，权限恢复保护继续生效。

设置中的 Agent 与账号进入统一 `AgentHub` 的“我的 Agent”，返回时恢复原设置页和此前准备上下文。`AgentAccessSettings` 与专属 `AgentCard` 已删除；自定义命令在 `CustomAgentDialog` 明确提交后登记，取得真实标识再进入共享 `AgentSetup`。登记成功与目录刷新失败分别处理，避免重试重复添加。`ProgramManager` 在共享程序页读取和管理实际安装，命令/参数仍在高级入口；普通使用不要求先选择项目。上述模块的2026-09-30原始实现记录不代表当前安装状态；最近安装与分项验收以状态页为准。

`CredentialSettings` 是独立 API 配置页。`credentials.rs` 在现有 settings 中保存服务身份、提供方说明、基础地址、接口格式、多个模型及系统凭据引用；Key 不回读界面、不进入数据库或日志。旧记录保留，字段不完整时需补充，不能由名称猜测接口或模型。`credential_editor.ts` 提供与后端一致的基础地址校验和实时保存条件，字段错误通过可访问描述就地呈现；测试成功不是保存的必要条件。旧逐 Agent/env 使用关系仅作为历史兼容项显示和撤销，不再提供新授权向导；旧连接使用状态的内存观察和界面已删除。

`ApiTestPanel` / `api_test.rs` 提供显式读取模型列表与单模型短请求，保存前后均可测试。测试是独立的有界 HTTP 诊断：限制等待、响应大小与并发，不跟随重定向、不自动重试，支持取消；取消不表示服务端已经停止执行。结果不写入持久成功状态，也不等同于通过 Agent 完成工作。

新工作通过 `ServicePicker` 选择沿用 Agent 已有设置，或选择兼容 API 配置及模型。选择携带记录修订，服务地址、接口、密钥或模型集合变化后保留原选择并要求用户重新选择，不自动采用新修订。`acp_client/service_config.rs` 转换已验证的官方启动配置，`service_connection.rs` 隔离来源并校验恢复；两者复用现有管理器，不新增 Agent loop 或模型代理。当前源码开放 OpenCode 的 Chat Completions/Responses/Messages 与 Codex 的 Responses；OpenCode 分别使用官方 `@ai-sdk/openai-compatible` / `@ai-sdk/openai` / `@ai-sdk/anthropic` 配置。Pi、Claude、Cline 及其他当前未声明此能力的接入沿用已有设置，不能由 API 测试支持的格式推导 Agent 配置能力。

`api_endpoint.rs` 共用中央 API 检查与 OpenCode 服务配置的 Messages 基础地址规则：仅官方 HTTPS 默认端口根地址补 `/v1`，自定义地址或前缀保持原选择，服务身份与修订不改。OpenCode 的每个模型明确实际 `id` 与模型级接口实现/地址；秘密保持独立环境交付，已继承 inline 中同 ID 的不同完整配置继续拒绝。实际 OpenCode 1.18.31 的两来源首次请求与冷续接证据见 [Messages 探针](evidence/2026-10-01-agent-service-messages/actual-opencode-messages-results.md)。该验证使用本地受控服务，没有证明安装版 Keychain/云端请求或磁盘、组织策略后合配置的全部情况；安装候选与范围另见当前状态。

真实服务配置证据来自 V0 直连探测，见 [OpenCode](evidence/2026-09-23-service-validation/opencode/README.md) 与 [Codex](evidence/2026-09-23-service-validation/codex/README.md)。另有 [OpenCode 1.18.31 Responses 补验](evidence/2026-09-23-service-validation/opencode/responses-validation.md)：使用与生产相同结构的服务配置，确认新会话直接采用所选模型，并覆盖工具调用、两来源隔离和冷恢复。该补验运行真实 Agent 与本地受控服务，不代表任意外部服务、真实模型能力或安装版跨 Agent 复用已通过；Codex 外部服务的冷恢复同时报告服务失败，仍按失败保留。本轮生产路径的安装版验证另行记录，不能用直连探测或单测代替。前序 [接入与密钥验收](evidence/2026-09-22-agent-access-v2/README.md) 保留为历史证据。

`authentication.ts` 在同一目录/来源状态中区分会话创建与实际请求的认证要求。模型列表可能在未认证时返回，因此 `session_open` 成功只可解除创建阶段要求，不能解除 `session_prompt` 的明确认证失败。实际正常回复才清除请求要求；准备页仍允许用户显式读取模型及发送短测试，但不会自动请求，也不凭模型列表放行已知认证失败的使用选择。

## 从应用入口到 Agent

前端 [main.tsx](../src/main.tsx) 挂载 [App.tsx](../src/App.tsx)。App 组合上述工作台、命令面板和已有对话带入弹窗；没有按 Agent 分开的工作台组件。

Rust [main.rs](../src-tauri/src/main.rs) 调用 [lib.rs](../src-tauri/src/lib.rs)。入口先启用性能记录并准备 Tauri context 与 TLS provider，再注册单实例、对话框、打开链接和更新插件，以及 PTY/更新状态。setup 中创建数据目录、初始化日志、清理已登记的遗留进程，然后创建 ACP 管理器、MetaStore、LifeModel 默认设置及目录/Node 状态。当前没有旧版开发身份隔离检查；开发与安装共用 `ai.farfold.desktop`，不能据此假定开发模式有独立数据。

主要调用链：

```text
React 页面 / Composer
  → runtime/agents.ts 或 runtime/sessions.ts
  → Tauri invoke 命令
  → acp_client/manager.rs（连接）与 session_commands.rs（会话动作）
  → 官方 agent-client-protocol crate
  → 外部 Agent 进程
  → session pump 原始事件
  → 每会话 Tauri Channel
  → sessions.ts 内存状态归一化
  → 统一 ThreadView / 审批 / 产物窗格
```

## 模块与职责

| 责任                               | 当前源码入口                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面装配与导航                     | [App.tsx](../src/App.tsx)、[Sidebar.tsx](../src/components/Sidebar.tsx)                                                                                                                                                                                                            |
| 对话库与分组元数据                 | [ConversationLibrary.tsx](../src/components/ConversationLibrary.tsx)、[collections.ts](../src/runtime/collections.ts)                                                                                                                                                              |
| 新对话、持久草稿与准备目录         | [EmptyState.tsx](../src/components/EmptyState.tsx)、[drafts.ts](../src/runtime/drafts.ts)、[draft_storage.ts](../src/runtime/draft_storage.ts)、[new_conversation.ts](../src/runtime/new_conversation.ts)、[conversation_directory.rs](../src-tauri/src/conversation_directory.rs) |
| Agent 发现与准备                   | [AgentHub.tsx](../src/components/AgentHub.tsx)、[AgentSetup.tsx](../src/components/AgentSetup.tsx)                                                                                                                                                                                 |
| Agent 卡片、状态、连接与设置客户端 | [agents.ts](../src/runtime/agents.ts)                                                                                                                                                                                                                                              |
| 会话状态、消息队列、恢复与操作     | [sessions.ts](../src/runtime/sessions.ts)、[session_types.ts](../src/runtime/session_types.ts)                                                                                                                                                                                     |
| 侧栏分组与产物归一化               | [sidebar.ts](../src/runtime/sidebar.ts)、[artifacts.ts](../src/runtime/artifacts.ts)                                                                                                                                                                                               |
| 会话、消息输入、模型与审批展示     | [components/](../src/components/)                                                                                                                                                                                                                                                  |
| 目录与本机发现                     | [agent_catalog.rs](../src-tauri/src/agent_catalog.rs)、[agent_discovery.rs](../src-tauri/src/agent_discovery.rs)                                                                                                                                                                   |
| 安装、候选检查与安装记录           | [agent_install.rs](../src-tauri/src/agent_install.rs)、[install_job.rs](../src-tauri/src/install_job.rs)、[installations.rs](../src-tauri/src/installations.rs)、[node_runtime.rs](../src-tauri/src/node_runtime.rs)                                                               |
| 登录、钥匙串与登录终端             | [auth.rs](../src-tauri/src/auth.rs)、[pty.rs](../src-tauri/src/pty.rs)                                                                                                                                                                                                             |
| API 记录、直接测试                 | [credentials.rs](../src-tauri/src/credentials.rs)、[api_test.rs](../src-tauri/src/api_test.rs)                                                                                                                                                                                     |
| 服务配置转换与来源隔离             | [service_config.rs](../src-tauri/src/acp_client/service_config.rs)、[service_connection.rs](../src-tauri/src/acp_client/service_connection.rs)                                                                                                                                     |
| 连接和生命周期                     | [manager.rs](../src-tauri/src/acp_client/manager.rs)、[supervisor.rs](../src-tauri/src/supervisor.rs)                                                                                                                                                                              |
| 会话命令与协议分发                 | [session.rs](../src-tauri/src/acp_client/session.rs)、[session_commands.rs](../src-tauri/src/acp_client/session_commands.rs)、[pump.rs](../src-tauri/src/acp_client/pump.rs)                                                                                                       |
| 项目文件列表与读取                 | [project_index.rs](../src-tauri/src/project_index.rs)                                                                                                                                                                                                                              |
| 元数据与索引合并                   | [meta_store.rs](../src-tauri/src/meta_store.rs)、[session_index.rs](../src-tauri/src/acp_client/session_index.rs)                                                                                                                                                                  |
| 已有对话查找、预览与带入           | [ImportConversations.tsx](../src/components/ImportConversations.tsx)、[history_import.ts](../src/runtime/history_import.ts)、[session_discovery.rs](../src-tauri/src/acp_client/session_discovery.rs)                                                                              |
| 日志与诊断                         | [logging.rs](../src-tauri/src/logging.rs)、[tap.rs](../src-tauri/src/acp_client/tap.rs)、[diagnostics.rs](../src-tauri/src/diagnostics.rs)                                                                                                                                         |
| 更新校验与安装                     | [managed_update.rs](../src-tauri/src/managed_update.rs)、[update_feed.rs](../src-tauri/src/update_feed.rs)、[update_metadata.rs](../src-tauri/src/update_metadata.rs)                                                                                                              |
| LifeModel 预留                     | [lifemodel.rs](../src-tauri/src/lifemodel.rs)、[LifeModelSettings.tsx](../src/components/LifeModelSettings.tsx)                                                                                                                                                                    |
| 登录操作与准备状态                 | [auth_activity.ts](../src/runtime/auth_activity.ts)、[auth_actions.ts](../src/runtime/auth_actions.ts)、[agent_preparation.ts](../src/runtime/agent_preparation.ts)                                                                                                                |
| 未发送意见、队列编辑与首发目标     | [drafts.ts](../src/runtime/drafts.ts)、[queue_edit.ts](../src/runtime/queue_edit.ts)、[pending_conversation.ts](../src/runtime/pending_conversation.ts)、[FileFeedbackDrafts.tsx](../src/components/FileFeedbackDrafts.tsx)                                                        |
| 请求结果与尾程显示                 | [completion.ts](../src/runtime/completion.ts)、[round_result.ts](../src/runtime/round_result.ts)、[artifact_view.ts](../src/runtime/artifact_view.ts)                                                                                                                              |
| 活动元数据与后台归档整理           | [archive_activity.ts](../src/runtime/archive_activity.ts)、[auto_archive.ts](../src/runtime/auto_archive.ts)、[meta_store/archive.rs](../src-tauri/src/meta_store/archive.rs)                                                                                                      |
| 草稿恢复与保存退出                 | [DraftStartup.tsx](../src/components/DraftStartup.tsx)、[draft_exit.rs](../src-tauri/src/draft_exit.rs)                                                                                                                                                                            |

`event_bus` 是旧计划中的概念名，当前没有该 Rust 模块；事件通过 pump 与每会话 Channel 传递。`src/runtime/` 是前端状态目录，不承担 Agent loop。

## 发现、安装与认证

`program_progress.ts` 为目录、准备页、程序管理与依赖安装共用下载读数展示，只在下载阶段显示安装事件报告的累计字节；有有效总量时同时显示总量。缺少测量保留阶段文案，其他阶段不沿用旧下载量。不新增安装状态或估算进度，原操作归属、迟到事件保护与取消流程保持。

`acp_client/recipes.rs` 保存经过官方资料核验的程序依赖与组件适用范围，`preparation.rs` 结合实际程序与公开版本形成通用诊断；`dependency_install.rs`、`AgentPrerequisites` 和 `AgentAccountLinks` 消费准备信息。依赖样本包含 Amp CLI、Pi 与 Autohand，未知组件范围不套用已知要求，低版本诊断不替代 `initialize`。Scoped npm 包按完整包目录、公开清单和命名入口核验；Autohand 补充仅覆盖已核对的 0.2.1 组件，不虚构整个 CLI 的最低版本。公开账号说明覆盖已声明的 Amp/Qwen、Codex、OpenCode、Claude 与 Cline 路线，部分链接按实际认证方法 ID 限定。OpenCode 指向所选服务说明，Claude 订阅与 Console 分开，Cline/ClinePass 与 ChatGPT 分开；未知方法不套用其他账号入口。外部注册返回只表示继续准备，不置认证成功或权益可用。依赖安装复用配置锁、候选检查和收据，同源有界下载；打开会话在配置锁内核对依赖。

兼容候选通过 `npm_release.rs` 核对官方发行、发布时间、入口与 Node 要求；`node_runtime.rs` 检查实际 Node，`program_launch.rs` 固定其绝对路径与官方程序入口，仅转发参数。`prepare_candidate` 向既有 `installations.v1` 保存未选程序，不改注册目标或关闭连接；程序清单中的明确选用另经现有工作保护与连接检查。收据与包目录检查约束受管安装来源，不建立任意 Agent 的连接版本白名单，也不升级日常外部 CLI。

`dependency_environment.rs` 在启动环境最终合并后按已核配方交付程序。需要纯命令名的声明使用已选路径的安全文件名，并只在本次进程 PATH 前置该目录；持久选择仍是绝对路径，失效选择不回退。`managed_programs.rs` 为新伴随安装计算 `companion-programs/agent-<编码 ID>` 父目录，避免目录条目 ID 的冒号破坏 PATH；不增加映射表、不迁移旧目录。`installations` 仅凭原有程序收据接受新或旧的精确父目录，组件安装范围保持。官方解析器和受控子进程、实际 Agent 与安装旅程证据分别记录，见[伴随程序本片](evidence/2026-10-01-agent-access-companion-program/implementation.md)。

`AgentAuthSection` 根据实际 `authMethods` 决定单方法直接显示或多方法先选择，再呈现该方法的登录、账号准备和高级配置；选中方法随准备进度保留。`auth_actions.ts` 将明确操作交给每 Agent 一个内存 `AuthActivity` 和可续看的 `BufferedLoginTerminal`，所有权不随页面卸载或隐藏消失。完成及重查调用 `auth_recheck`：持有配置锁，只替换启动目录的已有设置连接，等待旧进程确认结束后握手；其他目录、API 来源及候选连接保持原状。原连接若已经开始工作则拒绝关闭，登录完成与检查未完成分开显示。`auth_blockers.ts` 仍根据同 Agent 的执行、待处理审批/问题、发送及停止未知等真实工作状态保护账号变更，点击时再次检查；普通未发送稿和暂停队列不作阻塞。共享账号变更对 API 任务的影响尚未核实，不凭重连范围缩小就放宽认证准入。同 Agent 操作未结束时阻止另一登录及破坏性程序变更，界面仍可暂离。账号认证只针对已有设置；选用 API 来源时转向 API 设置。命令退出、重新连接、账号权益与真实请求结果保持分离。

折叠终端有明确 `terminalOutcome` 后显示“查看终端记录”，包括随后仍在检查连接的阶段；无结束结果时保留继续交互的入口。查看记录只展开原 `BufferedLoginTerminal`，不创建账号操作或重新运行命令。

`acp_client/handshake.rs` 在官方 SDK 的同一次 `initialize` 响应中形成一个连接所有的 `Handshake`：普通能力仍按官方类型解码，认证声明单独保留有界、已核验的类型与必要字段。公开快照去除终端参数、环境值和执行元数据；执行材料只留在该活连接内。`auth_methods` 按工作目录与来源选择精确连接，没有对应活连接时缓存只作不可执行说明，不能从其他目录或 API 连接借用登录能力。普通认证和退出在执行前再次核验当前声明，失败不回退到持久快照。

旧终端扩展的 `terminal-auth.env` 同样保留在活连接内，执行时与旧顶层 `env` 合并；同名异值拒绝而不猜优先级，标准终端声明仍优先。名称、类型和大小校验与精确程序/脚本核验继续生效，环境与参数不进入公开快照、缓存或日志。所有可执行终端登录复用同一个 `AgentAuthSection` 和 `InlineTerminal`，账号区标题不因使用/管理入口变化。

旧实验 `env_var` 声明只提供环境变量名称及尚不可自动执行的出口；未知、畸形或重复方法也不能退化为普通 `authenticate`。这属于旧声明的兼容保护，官方已撤下的实验类型不会被当作现行协议或已完成 Key 交付。前端切换 Agent、工作目录或来源后立即失效旧方法；连接状态事件只重新读取声明，不发起连接或认证。用户明确配置的官方命令仍沿已有高级入口执行。

官方服务配置作为独立的通用 `service_configuration` 准备动作返回，不改写 `authMethods`。`acp_client/preparation_actions.rs` 依据配方和既有受管安装记录派生动作，在配置锁内重新比较用户审阅的程序与参数，并预约同 Agent 所有来源的空闲准入。它使用普通电脑环境，不能读取或交付 Farfold 保存的服务密钥。前端通过 `AgentPreparationActions` 审阅副作用，再复用同一个 `AuthActivity`、终端和取消所有权；操作描述独立于后续认证方法列表，退出和重查结果可以继续查看。明确配置操作使原目录进入模型显式重读状态，连接重查或重开界面不自动创建模型读取草稿。以上当前源码的安装验证范围另见 [status.md](status.md)。

标准终端认证保留原命令/参数再追加声明参数，允许空附加参数；任意方法 ID 不能代替协议类型。`acp_client/auth_compat.rs` 只为核验过身份和入口的 Qwen 终端扩展提供官方交互设置及“返回检查”。终端所有权保留至确认回收，流程结束后安全重新连接；认证向单一空闲的已有设置连接发送，不广播到服务连接。Qwen 既有模型提供方配置优先级使通用服务覆盖尚不可保证，故未开放其 Farfold 共享 API 配置。

`acp_client/auth_route.rs` 统一登录方法的显示、执行和协议准入。标准终端声明保持优先；旧扩展必须符合结构并匹配实际执行文件及脚本入口，已核实的伴随程序和 Kilo 固定声明补充留在接入层。`auth_route/copilot.rs` 为已核对的官方包范围验证唯一受管收据、同版主包与平台导出、规范化扁平布局及最近解析位置；生成已选 Node/loader 的登录参数，查询与实际执行各自重新派生证明。未知参数或非空环境不补充；旧终端嵌套环境不能在声明过滤后误变成空环境，标准 Terminal 语义不受旧元数据影响。无法核验时返回固定原因，保留其他方法、手动配置和重查；不解析描述文字猜命令，不在读取凭据后才发现目标不符。

登录、退出、手动运行及官方配置先取得已有 `AuthActivity` 所有权，再等待同目标模型准备稿真实关闭。`session_draft_cleanup.ts` 的严格模式保留失败稿和原目标供重试，只在确认关闭后移除；普通非账号清理维持原语义。开始前的取消意图留在该活动中，不因取消通知失败后的展示状态变化而再次启动。另一目录或 API 来源的准备稿不由此自动关闭，后端账号工作保护仍生效。

`install_job.rs` 管理逐 Agent 安装和候选检查的取消、阶段通知与配置锁。安装先在独立暂存目录准备；安装、已有程序选择及保留的回退命令共用 `check_and_select`，经官方 initialize 检查并确认候选进程回收后，才用 MetaStore 事务一起写入启动目标、上一选择和安装收据。候选不改当前握手，选用成功后清空旧能力，正式连接重新获取。取消、失败或回收结果未知不选用；未知时保留仍可能在用的目录和对应连接 owner，阻止重复启动。npm stderr 持续排空，只将受控错误码和退出状态转成提示，不展示原始安装输出。

`installations.rs` 在现有 settings 保存安装收据。选择精确到安装实例；程序版本与接入组件版本分别记录和显示。只允许卸载归属明确、未选择且未被接入或候选检查使用的实例；外部安装和缺少可信收据的旧安装不能自动删除。移除接入保留程序、用户配置、历史与已知实例，并撤销该接入的旧密钥授权。升级不会自动断开已有任务，也不等于升级了独立的 Agent 程序。

`credentials.rs` 保存完整服务记录及系统凭据引用（macOS Keychain、Windows系统凭据存储）。替换密钥先写新凭据条目，再提交引用；失败保留已保存版本，删除清理失败可重试。服务地址或接口变化要求重新填写 Key；旧全局授权仍存在时先撤销，防止将已有密钥默默送到新地址。新工作明确选择服务才生成该连接的环境，保存本身不自动分发或重连。旧单 Agent Keychain 与逐变量授权继续兼容，但不是新服务配置的主流程。

目录保留 OpenCode、Codex、Pi 三个本机发现定义；官方 ACP registry 缓存保留原始条目，日常目录及安装/准备准入仅提供 `first_release.rs` 中的当前29项。自定义、本机发现和已有历史按各自规则保留，不因目录过滤删除用户数据；通用条目使用 `registry:<id>`，三个既有身份保持不变。发布信息包括版本、简介、HTTPS 官方说明/仓库链接与图标；界面分别呈现来源、是否已添加和当前设备是否有支持的安装路径，不把目录收录或已安装等同于真实任务可用。简介在 `agents.ts` 转换工程词，来源链接以统一说明按钮呈现。另有用户明确配置的自定义命令入口。

设备适用性与 Farfold 安装能力分别计算：官方提供当前设备分发方式，不代表 Farfold 已实现该分发的安装。二进制发行按 `registry_platform()` 选择当前 macOS/Windows 目标；支持的HTTPS归档类型、Windows独立可执行文件、npx和具名精确版本uvx分别由安装器核验。Windows不支持的归档类型不会从macOS能力推导为可安装；其他归档或包规格保留声明并如实说明限制。平台代码存在不等于已取得该平台实机安装证据。没有本地安装路径时仍可查看官方说明或添加已有程序。参数与公开环境声明保持原义并拒绝覆盖 HOME；通用条目复用下载、归档校验、候选检查及原子选择。`catalog_list` 只读缓存，本机扫描和目录刷新在后台进行，完成推送 `catalog:updated`；3 小时 TTL 决定刷新，网络失败保留最后成功目录。

`managed_paths.rs` 集中受管目录编码和精确根检查。普通新安装使用 `agent-installations/agent-<字节百分号编码>/install-*`，伴随程序保持自己的既有命名空间；旧 `agents/<单目录组件 ID>` 收据仍可核对，程序不迁移。逐级拒绝符号链接，要求根是已核验父目录的直接子目录；普通和伴随新根不能互认。安装清单、Kilo/Copilot 登录目标及 goose 配置动作共用此边界，各自原版本/参数/包结构条件继续生效。路径编码只规避 Farfold 加入的分隔符，不是对任意祖先路径兼容性的保证。

`uv_runtime.rs` 准备通用 uv/Python 安装工具；目录类型和包语法校验留在 `agent_catalog/uvx.rs`。依赖动作需用户明确点击，与 Agent 包安装分开，且首次未注册条目也可执行。工具下载使用已核实官方归档/摘要，有界展开、检查后在共享发布锁与安装任务提交保护下保留。每次 Agent 安装建立独立受管 venv，禁用安装器隐式下载 Python，通过实际包元数据验证入口后复用候选连接、回收与选用流程。venv 保持原绝对路径，卸载 Agent 不删除共享工具或用户配置。`requiredForInstall`/`requiredForUse` 区分两类依赖；安装工具不会成为已安装 Agent 的使用前提。

| Agent    | 当前启动路径                                                               |
| -------- | -------------------------------------------------------------------------- |
| OpenCode | 本机发现的 `opencode acp`，或 registry 二进制安装                          |
| Codex    | registry 的 `@agentclientprotocol/codex-acp`；发现 CLI 后注入 `CODEX_PATH` |
| Pi       | registry 的 `pi-acp`；发现 CLI 后注入 `PI_ACP_PI_COMMAND`                  |

发现扫描登录 shell PATH、常见用户目录、nvm 与 Homebrew，按真实路径去重；nvm 目录按数值版本排序并有界扫描多份安装。旧计划提到的遍历 `/Applications/*.app` 尚未实现。连接兼容性由 initialize 决定，不校验已安装 Agent 的二进制摘要。

应用不捆绑 Agent 或 Node。npm 所需 Node 优先复用本机 node/npm（源码最低检查为 Node 18），否则下载固定 Node 22 发行包并校验下载摘要。目录采用同一 camelCase 缓存结构；旧缓存没有的新来源字段在后续成功刷新后补齐。无缓存且刷新失败时显示错误与重试，本机发现和已登记 Agent 仍可呈现。这与最初“复用已打包 Node”的方案不同，历史后续记录已记载 Node 改动。

自定义接入用 SQLite 随机 ID 和仅新增 INSERT，名称与同一解释器不再决定身份；旧 ID、历史与 Keychain 引用保留。新增、程序替换、环境更新和握手保存为独立操作；程序替换原子清空能力，握手按实际启动配置条件写入，迟到旧握手不能覆盖新程序。配置锁由实际后台操作或登录进程持有，不随界面取消等待提前释放。

环境来自登录 shell 并继承进程环境，没有私有 HOME 或 `env_clear`；登录 shell 环境探测有超时与输出上限，交互式启动脚本不会卡住主线程。登录根据 authMethods 分发到 authenticate 或声明的 PTY 参数，不解析自然语言说明；API Key 类型在设置中转到独立 API 配置页，不宣称完成账号登录。认证要求仅来自明确的 AuthRequired，并按 Agent、项目、服务来源隔离，不由登录方式数量推断；握手同时带 `_meta["terminal-auth"]`，兼容仍以旧约定下发登录命令的 Agent。`manual_auth.rs` 保存按 Agent/认证方法区分的显式命令、独立参数与可选变量名；不经 shell 拼接。密钥仍在 Keychain，旧引用继续有效。保存配置、命令退出和真实请求成功是不同状态。

## 真实文件交付（2026-10-03 源码增量）

`ArtifactPane` 将原对话 `cwd` 交给 `FileArtifactView` 内的 `FileDeliveryActions`，沿现有内容栏提供核实、手选、打开、定位、另存与明确文本导出。自动候选只来自已完成的协议diff；write/edit输入不作已写入证明。`file_delivery.ts` 另有结构化resource链接/location的解析底座，尚未接成所有文件卡片入口，不能视为已经覆盖全部Agent。用户选择器的单文件结果或用户明确点击的绝对文件路径走 `inspectSelected`；`inspectLink` 将相对路径交原 `cwd` 范围核实，没有目录扫描或父目录持久授权。

`file_delivery_commands.rs` 仅允许本地主界面调用，阻塞文件工作交工作线程；`file_delivery.rs` 在明确根目录内以目录描述符和无符号链接逐层打开普通文件，核对路径、元信息与内容摘要。核实回执只在内存；后续读取、复制和打开都重核版本。文件上限32MiB，纯文本预览1MiB；复制/文本导出在目标目录写临时文件，再以不覆盖方式发布，已有目标拒绝覆盖。保存位置发生变化时保留明确失败，不自动重试。

当前磁盘文本是独立只读预览，不替换Agent返回片段或复用旧意见坐标。组件按原任务和精确内容版本隔离；关闭、切换和迟到选择不能回填或继续交付；任意文件动作失败清除旧确认。意见仍加入原输入框，发送及保护复用既有链路，没有代发动作。实际Agent改写、再核实和重开新版本尚无本片真实样本。

系统打开只接受文档扩展且非可执行的目标；其他文件可定位后由用户决定。系统应用仍按路径读取，核实与外部读取之间存在跨进程替换间隙，不能声称原子打开。源码没有新增Agent文件工具、浏览器远程文件权限、正文账本或持久成果定位。阶段0网页探针保留为各自候选的独立证据；已提交的正式手动浏览器入口见下节；本轮共享后端与未完成边界另列其后。

## 本地 HTML 成果运行（2026-10-05 源码增量）

本节保留单文件首片的实现边界。当前已增加多文件目录和开发服务器路径；单文件存档行为以上文安装修正说明为准，不能把下述首片的非持久模式或单文件限制套到所有预览方式。

文件核实与浏览器页面服务增加单文件 HTML 入口：系统选择器或已核实文件交付 `VerifiedFile`，`browser_workspace_open_html` 经主界面来源核验，再由 `local_html::read_document` 调用现有 `read_text` 重核精确版本、UTF-8 和 1MiB 上限。只向独立 WK 交付内存文档，不授予文件目录读取权限。主应用 CSP 与原静态 diff iframe 保持原有边界。

同一 `BrowserWorkspaceScope` 处理公开网页与本地 HTML 的替换、隐藏和关闭，先取得旧页关闭回执再开新页。前置文档 CSP 限制常规外部资源与连接，独立非持久数据存储及合成来源使本地存储在当前页面内可用，不写文件成果或账户资料。此处不是操作系统网络沙箱。`localFileName` 仅说明本地页面类型；共享许可、手动快照、固定读取及原生读取入口均拒绝此类型，不能将文件页面交给既有公开网页 MCP。

用户主动刷新会重新核实同一文件，再替换旧页；选择器取消、隐藏或切换任务后的迟到结果不能打开新页面。核实失败保留已有页面与原文件，读取失败不得标为打开成功。真实检查结果与正式安装状态以状态页及本片证据为准。

## 内嵌公开网页（2026-10-04 源码增量）

`browser_workspace.rs` 与 `native/BrowserWorkspace.h/.m` 提供单个非持久WK页面，作为主应用视图的独立同窗视图，不注册为Tauri网页，不注入应用脚本或IPC桥。`build.rs`使用系统clang/ar，无新增依赖或实验性接口。主页面自定义命令统一核验真实main标签与应用来源，capability仅选main网页，UI事件也仅发main。

五个手动命令为open/navigate/resize/snapshot/close；真实关闭确认前保留所有者，失败可重试，操作锁保证替换先关旧页。每次导航关联实际WKNavigation对象，读取结果核任务、页面与导航版本；旧结果不回流。main窗口销毁或最终退出先撤销操作资格，再同步移除网页；可取消的退出请求不提前销毁。只接受公开HTTPS网址形态，并拦截已知登录域名、路径与秘密参数；这不是网络隔离、完整登录识别或秘密交接承诺。

内容栏通过`BrowserWorkspace`呈现网址、手动读取与关闭；`browser_surface_guard.ts`协调关闭确认和最新导航意图，覆盖浮层与任务切换等待收回，失败保留全局重试入口。文件与网页共用现有内容栏，不新增Agent专属页面。临时页面和读取结果只在内存，不保留登录态。`ae89254`里程碑尚未注入浏览器MCP；后续共享后端见下节。

正式Rust命令和原生模块在独立内存Tauri窗口中完成匿名公开页面打开、读取、关闭及两类退出清理；受控主页面不运行Farfold setup、Agent或用户存储。该结果不代替完整产品布局、安装版或Agent共享验证，见[命令证据](evidence/2026-10-04-embedded-public-web/command-validation/README.md)。

## 固定公开页只读共享后端（2026-10-04 源码增量）

本节记录最初仅有 `read_page_snapshot` 的范围。当前工具目录另有 `observe_page`、`click_page_node`、`input_page_node`；生产截图仍明确不可用。下述“唯一工具”只描述该首片，不代表当前总能力，现行声明见 `browser_sharing/protocol.rs`。

`acp_client/transient_mcp.rs`将一次性工具配置随已有`session/new`或`session/load`请求传递，使用官方`McpServerStdio`的command/args/env字段，不进入Agent登记、settings或保存的会话配置。打开失败、取消或路由结束撤销本次许可，成功路由持有实际工具所有者；准备预览沿用无扩展入口。`browser_capability.rs`集中核已审官方Codex ACP来源与启动形状，其余入口保持未核，不靠名称或握手自报身份放行，不设版本pin或二进制摘要门槛。Agent自有MCP和配置继续由Agent管理。

`browser_sharing.rs`在已有main调用来源检查下提供status/allow/stop。工具初始化、工具列表实际写出、用户明确授页分别判断；new/load成功不代表页面已分享。允许操作核当前对话身份、页面与确认时的revision，固定任务、页面、导航及URL；`browser_workspace/page_read.rs`在真实观察开始和结果接纳时再检查。唯一工具`read_page_snapshot`无选择参数，不能指定网址、其他任务、脚本、点击或填写；导航、关闭、同文档URL变化或检测到登录输入使当前许可失效，恢复不复用旧许可。

普通UDS连接同一可执行文件的早期stdio工具模式，由工具程序持有最终stdout。随机临时凭证只经本次MCP env交接，工具模式在线程及应用初始化前消费并清除自己的该变量，不写Farfold配置或诊断。停止先禁止新观察，再等待最后输出的`stopped`回执；未写的待发正文丢弃，部分正文已输出或存在旧待转发请求时关闭stdout后确认，已写字节无法追回。通道断开或超时不冒称停稳，实际所有者和待停止许可保留至确认或最终应用退出；最终退出本身不构成用户级停止回执。手动导航和关闭等待共享停止确认，旧页面/旧revision的迟到停止不能撤销后来明确授予的许可。

正式模块加受控MCP对端的真实WK同页链路17/17、最终helper真实管道/UDS检查12/12、共享核心16/16通过，源码摘要与运行回执见[本片证据](evidence/2026-10-04-shared-public-page/README.md)。没有运行正式应用setup或真实Agent，不以这些结果代替安装布局或账号验证。新共享交互仍待评审，生产界面没有授权新按钮；不动态给活跃会话补工具或自动重开。代表默认公开源码未见直接保存本次MCP env，不保证外部debug、包装器或其他版本的行为；隔离依赖可信Agent的官方会话实现，不是操作系统沙箱。登录、秘密输入及账号切换的完整暂停/恢复仍未开放。

## 会话和存储

恢复保护由 `acp_client/model_guard.rs` 统一判定。现有 `sessions.config_options` 保存 `_farfoldConfig:2` 的完整 `choices` 集合：模型与推理选项按唯一 ID 保存类型、类别和值，同类别允许多个不同 ID。比较按 ID、类型和值，已保存 ID 后来改变或省略界面类别不解除保护；界面仍遵循 Agent 的显示顺序。`model_guard/format.rs` 严格读取新版及旧 v1/键值格式；未知版本、重复 ID 和旧键值中无法判断角色的记录不能静默丢弃或猜测。打开历史不自动迁移原记录，没有新表或另一份基线。

首次实际接纳消息才记录，记录失败不把已发消息误报为未发；显式选项确认后更新，普通通知只更新当前值。`pump/restore_config.rs` 仅对来源严格匹配的已保存 V2 选择，通过官方 `session/set_config_option` 在同一对话恢复模型及关联思考选项，不接受返回默认值作为新基线。原始通知保留；完整回执、已收到的迟到通知、来源、忙态及保存结果全部确认后才发布最终检查。逾期不发送下一项，已发送请求的锁保留至实际结束。打开、通知、发送拒绝使用同一 `configCheck`，以 `protectedIds` 向界面传递原记录与当前声明的保护范围；前端负责提示和操作限制，后端每次发送仍校验。缺少旧推理记录可显式确认完整当前集合，已知漂移、未记录的新增模型及未知原模型不能通过确认绕过。已选 API 继续要求唯一且精确匹配的服务模型；多类别支持不扩大密钥交付范围。元数据保存使用现有 MetaStore，不写入 Agent 请求或私有配置。

协议与连接等待使用异步响应通道和有界超时，连接并发去重通过异步锁与就绪状态完成；SQLite、Keychain、文件和进程查询仍隔离在阻塞工作线程。`MetaStore::run` 共享同一数据库连接，不创建第二份存储。前端 `session_projection.ts` 保存纯事件归一化，`sessions.ts` 协调传输和状态；`thread_notifications.ts` 按会话订阅并合并文本显示通知，原事件按到达顺序立即应用。审批/结束/失败立即冲刷，后台窗口有计时兜底。

恢复模型漂移时旧会话仍只读，可显式创建同 Agent/项目的新草稿，不迁移历史或待发消息，不自动发送；该出口不修复外部模型漂移。未支持的询问方式返回取消并保留原请求供查看，暂停队列、显示说明，不伪造已接受。末尾整段粘贴的 `@文件名` 可进入文件选择，文件仍需用户显式选择。

连接按 Agent、工作目录、用途、有效服务配置修订和工作对话身份区分；每个工作对话拥有独立进程，不能因同一来源而复用另一对话进程。准备连接可按准备用途复用，候选检查仍在同一管理器中由各自 owner 负责生命周期；共享账号与配置的操作保护另按真实作用范围执行。新建用 session/new，历史恢复用 session/load；显式带入历史时按能力查询 session/list。本地会话索引刷新不等待 Agent 连接或历史查询。前端选 Agent/目录时预开草稿取模型选项（防抖 + 同目标去重，失败不自动重试；发送时按需补开），第一条 prompt 才主动登记新对话索引；显式带入的历史另由成功预览后的提交登记。丢弃草稿会关闭会话并设置隐藏标记。恢复回来的模型与最近确认并保存的记录不一致会如实提示，不会默默声称一致。 Farfold 已有对话名称优先，Agent 标题只填补空名称；恢复先读本地名称，自动索引更新在 SQLite 内原子填空，并保留当前收藏/归档，避免回放或迟到更新覆盖手动整理。使用原有 title 字段，不增加标题账本。

服务来源保存在现有 `sessions.config_options` 的 `_farfoldService` 中，不新增表或会话账本。新对话选择服务后，由官方 `OPENCODE_CONFIG_CONTENT` 或 `CODEX_CONFIG` / `MODEL_PROVIDER` 环境入口交付配置，密钥只通过独立环境变量引用；不写用户配置文件、不更改 HOME。保存服务身份及地址/接口指纹、所选模型，连接复用另纳入当前密钥和配置修订。恢复遵循原记录，缺少旧记录不能猜成用户选定的新 API；地址、接口、模型移除或服务删除会阻止继续发送，不能静默改用别的来源。更换 Key 不强行终止已运行进程，新连接才取新值。配置交付后核对 Agent 实际选择的模型；通用模型/推理恢复保护仍独立生效。

`configOptions` 由一套能力驱动控件呈现：草稿和安全空闲的既有对话可选择真实模型/思考选项，忙态、审批、工具、停止未知、断线或配置未确认时阻止变更。`session_configuration.ts` 集中处理配置操作，暂存设置中的普通差异；后端确认目标值并保存后，原子返回完整选项、配置检查、权限与非秘密服务身份，前端一次发布，模型变化刷新关联强度。普通通知不能冒充显式配置成功。`configuration_pause.ts` 只在内存记录配置暂停来源，其他暂停写入立即撤销该标记。`session_config_recheck.ts` 管理用户明确重查；后端先核实空闲及恢复能力，仅移除本地句柄，不远端关闭或删除。失败保留内容，后续明确重试仍核对原归属和来源；成功只能解除本次可核实的空配置暂停，不自动发送队列。权限仍使用独立通用控件；其他 select/boolean/未知类型保留会话选项菜单。顶层 `modes` 仍路由到 `session/set_mode`；恢复权限需真实确认。

SQLite 当前有四张表：`agents`、`sessions`、`settings`、`dismissed_sessions`。sessions 保存 Agent、目录、Agent 会话 ID、标题、置顶、归档、配置选项和时间；不保存完整对话或轮次账本。`farfold.sqlite3` 是新元数据库，不迁移旧 Host 会话库。

主题以 MetaStore 的 `themeMode` 为准；仅在该键不存在时读取旧 localStorage 值，保存成功才删除旧键。初始化迁移合并为单次在途读取，正常运行不双写。

`archive_activity.ts` 只保存每段对话最新活动时间和是否已观察到明确结束，不保存轮次或事件账本。它与草稿、队列和意见在同一 `unsentWork.v1` 快照中提交；待提交或保存失败的活动不能作为归档依据。发送前先保存未结束状态，收到有回答/工具结果的正常结束，或已知失败/停止，且无尾程和待处理请求后才记录结束。编辑未发送内容更新活动时间；手动恢复归档重新等待完整期限，浏览、改名和分组不重新计时。

`auto_archive.ts` 订阅现有会话、草稿和活动变化，并周期性检查已确认记录；只整理超过期限、非收藏、无未发送内容、无活动和待处理事项的对话。当前未加载到内存的对话可凭已保存的明确状态参与，未知旧历史保持原位；每次异步写前重新判断，错误可重试。`archive_admission.ts` 在等待草稿保存后同时检查原索引路径与本次核实规范路径的两个精确目标，`expectedCwd` 仅用于否决跨层不一致。后端 `session.rs` 保留两目标的既有操作保护，`meta_store/archive.rs` 在原事务内再次核对索引身份、目录及两目标的草稿、图片、队列、文件意见和待发送目标；无法核实目录时拒绝归档，取消归档仍可更新本地状态。一次操作的目录复核不锁住外部文件系统，也不迁移索引、保存别名表或推导最近祖先。整理只改变现有索引的归档标志和更新时间，不启动 Agent、不执行模型请求，不属于 Agent loop；[本片工程与安装边界](evidence/2026-10-01-archive-directory-identity/README.md)分开记录。

审批和表单按请求 ID 分别保存，表单值与状态归请求所有；`interaction_actions.ts` 共用归属、重复提交和四态回复处理。远端单请求取消、轮次终态、会话/连接结束同步清理；点击停止本身不提前失效。快捷键仅由当前可见会话授权，设置、命令面板、编辑控件和输入法组词不能触发背景审批。

Agent 正文、待审批和产物派生数据只在内存中，重启后由官方历史回放恢复；用户未发送队列与编辑内容单独随草稿持久化，并以暂停状态恢复。协议事件原样进入归一化，未知内容可保留为原始块，不复制进 MetaStore 或诊断日志。

`completion.ts` 保留请求结束原因与失败类别，`round_result.ts` 另行判断已收到回答、工具结果、仍在等待工具或没有结果。`end_turn` 本身不是“已取得结果”；输入参数、计划、思考和工具句柄也不能冒充输出。明确失败、停止、未知、没有结果或仅有在途工具会暂停后续队列；只有正常终态且有回答或工具结果才允许继续，失败工具仍在自己的卡片中显示失败。迟到工具结果按已有内存工具 ID 更新原轮次的结果与产物，不改变旧终态或自动解除队列暂停。

`MessageContent` 按消息对象弱引用缓存同步 Markdown 解析树；文本变化替换该条派生产物，组件状态仍归 React。此缓存避免切换会话重复解析历史，不构成总内存上限；收益与内存须由安装版实测。

历史事件缺少原始时间时，消息时间及工具计时保持未知；工具不会将回放接收间隔显示为执行耗时。只有实时观测到开始和结束的工具才显示本地观测时长，首次只收到完成事件也显示“耗时未知”。这不新增时间账本或数据库字段。

Farfold 不声明文件读写与终端两类客户端能力：Agent 用自己的实现干活，Farfold 只转发审批与表单。产物窗格的差异卡与命令卡由 Agent 汇报的 `tool_call`/`tool_call_update` 内容推导（`type:"diff"` 块、execute 类调用输出，或 edit 类调用参数里带的 filePath/content），不再有 Farfold 侧的文件代跑或 PTY 代跑。空闲回收在有未答审批/表单或在途消息时豁免连接。

产物顶栏入口查看全对话；本轮入口只使用结束时捕获的既有工具项 ID 选取文件和输出，范围失效不借用全对话结果。迟到差异可更新原轮次计数与内容，回放后没有对应内存范围时保留未知。`artifact_view.ts` / `FileArtifactView` 提供文件选择、差异、Markdown 阅读与 HTML 静态预览；工具日志只来自 Agent 已汇报内容。未明确保证完整内容与起始行的差异/参数按片段显示，反馈行号也限定为片段坐标。具备完整 HTML 文档结构的返回内容可预览，但不反推磁盘文件完整；空 sandbox 与 CSP 保持禁止脚本、网络和导航。

`fileFeedbackDrafts` 按对话、文件路径和返回内容标识保存未提交意见及行选择，内容标识不包含产物正文；切换同路径版本不会串用行号或擦掉另一个版本的意见。`FileFeedbackDrafts` 提供已保存意见入口，版本不可定位时仍可查看、复制或加入原对话输入再编辑，不猜测文件当前状态。加入输入框通过 `take` 同次更新输入和移除对应意见，随同一持久快照提交，不自动发送。

`work_policy.rs` 继续在现有 settings 保存版本化默认值及规范化路径覆盖值，并迁移旧开关。策略更新和新工作准入使用同一项目锁；历史恢复、停止和已有审批不受工作关闭影响。开始页与会话页通过 `work_policy.ts` 遵守原有关闭记录，Composer 提供明确恢复工作权限的操作，保存失败不更新有效策略。Agent 准备流程不再以项目选择或项目开关作为前置步骤。

`session_types.ts` 明确区分 draft/established；身份固定 Agent、对话与服务来源，不再永久锁住模型/思考。后端串行处理配置与消息，真实忙态和未确认配置拒绝切换；成功显式设置后用现有 MetaStore 更新最近确认基线，不另开历史或新增账本。恢复按上述官方确认流程应用严格匹配的已保存选择，不能确认时继续保护发送；个别 Agent 的恢复问题仍未关闭，按活动计划继续补强与验证。审批状态继续由既有状态与 `interaction_actions.ts` 协调。

`queue.ts` 定义暂停和准入规则；会话协调在 `sessions.ts`。队列仅在后端确认接纳后移除；关闭、断线、失败、停止或结果不确定均保留队列并暂停。重开开关不自动发送；结果不确定的条目不能自动重试。重连用临时状态接收新历史，成功后替换，失败保留原内容；旧通道的迟到事件被忽略。

`session_recovery.ts` 仅在本次恢复 IPC 成功返回后，将本地历史准入失败区分为无可读正文或完整标记缺失；远端同文案不获得该类型。历史失败继续阻止发送、保留原内容/队列/模型保护，按已确认的工作目录和服务来源提供重读及独立新稿；缺少确认来源时不能默认回退。失败通道只继续接收所属操作的真实连接丢失，迟到正文和标记不能解除读取保护。连接、历史完整性与未知执行结果分别呈现，不用一种失败替代其他状态。

## 已有对话查找与带入

`ImportConversations` / `history_import.ts` 调用 `session_discover`，复用当前管理器发送官方 `session/list`。连接目录与可选查找目录过滤分别传递；不限定位置时使用 Agent 官方默认范围，不能宣称全局。用户可明确选择原文件夹重新查找；Agent 和位置共同区分本次运行的查找草稿，返回已查范围可恢复其结果、游标、搜索词和选择，不混用另一范围。切换前释放实际预览，并使旧请求的迟到结果失效；标题/目录搜索只过滤当前已加载结果。`cursor` / `nextCursor` 保留官方分页语义。未声明列表能力返回 `unsupported`，有效空列表与请求/格式错误保持区分，不以 Farfold 索引伪造官方结果。目录存在性、已加入/已打开状态只辅助选择；`canLoad` 仅表示声明加载能力。

`session_import_preview` 基于同一个 `session/load` 和每会话 Channel 加载内容；`history_import.ts` 将收到的 `update` 交给既有 `session_projection.ts`，正文仅保留在临时内存。后端在既有打开预留锁和 SessionEntry 中记录临时 `previewToken`：已有打开的目标拒绝预览，预览期间普通打开不能替换其路由，预览不能发送消息或修改配置。关闭与提交都校验确切的 token；迟到或错误的关闭不能结束之后打开的正式会话。该 token 只管理本次打开的归属，不形成持久定位体系或第二份会话账本。

界面仅在对应回放完整结束，且包含用户或 Agent 的可读文字/附件后允许加入。`session_import_commit` 验证仍拥有成功预览，再由 `MetaStore::import_session` 在同一事务中按 Agent 与原会话 ID 查重、写入索引并撤销隐藏标记；已有索引保留用户标题、收藏等元数据。提交失败不留下新成功索引，预览失败本身不登记；界面提交后先关闭自己的预览，再通过普通打开路径进入对话。

带入不复制 Agent 历史，不读取私有日志或凭据，不猜测原模型、推理等级及 API 来源。新索引没有已知配置时保留未知，现有恢复保护照常生效；成功查看历史不等于可以继续发送。当前实现与合成进程测试覆盖这些接口和竞争保护，真实 Agent、安装版内容回放及继续工作的证据仍须按具体 Agent/服务分别记录。

## 进程、诊断与更新

管理器按连接实例拥有独立关闭信号和完成通知；life 中的短临界区统一请求准入与空闲回收。请求在入队前取得持有权和绝对截止时间，过期不发送；有副作用的请求超时仅结束等待，其隔离占位保留至真实终态。打开会话先注册临时路由吸收回放，仅成功交付后成为可操作会话。`process.rs` 从官方 SDK 配置取得原 command/args/env，通过同一锁定的 `async-process` 启动并持有确切 Child，再接官方 ByteStreams；仅补 SDK 启动配置缺少的真实 `current_dir`，保留进程组、三管道和既有回收。普通连接使用已验证的工作目录，安装候选检查继续使用应用数据目录；不改父进程目录或 HOME，目录消失时失败而不回退。它单独排空 stderr，TERM 宽限 2 秒；用户关闭及正常退出总等待 5 秒。结果未确认时保持 closing 和原 owner，不能重复启动同键连接。`supervisor` 的 pids.json 记录 macOS 出生身份，仅对已验证记录进行启动恢复；旧不可信记录不授权终止。正常退出等待实际 owner，不再按进程名或 PID 差集归属。启动不再扫描或按前缀删除临时目录；安装器仅删除自己当前创建的明确暂存路径，遗留文件不做全局回收。

新协议日志的普通事件只记录格式版本、时间、方向、受控事件类型、字节数和错误类别；普通应用日志也不保存自由文本。`startup_diagnostics.rs` 在每条连接内保存唯一初始化请求的内存关联，分别记录匹配响应、解码接受、启动阶段、真实 Child 退出与回收、我方停止信号请求、连接移除和候选清理结果。落盘仅含固定枚举、布尔和有界数字，不含请求 ID；停止信号请求不推成进程自行退出或已被信号结束。最终摘要有独立有界写入预算，普通事件队列满或轮转停止不抹去已有退出事实；候选目录仅在释放结果可确认时删除。

typed 出站及真实入站错误可在原 v1 普通记录中追加固定错误类别、响应 ID 是否为空及观察时是否尚未接受初始化；不保存任意错误码、ID、方法、message 或 data。出站保持六类，入站另外保留认证要求、请求取消和资源未找到三个标准类别；只在官方 bridge 观察到 Error 时分类，本地解码、EOF 或超时不冒充远端错误。状态不可立即读取则省略整组，白名单重建只接受完整合法字段。空 ID 也可能属于合法请求，观察标志也不表示具体请求阶段或根因；不新增 prompt/认证请求关联。此组仍受普通队列、文件和导出预算限制，不拥有 v2 摘要保留保证，缺记录不能排除错误。

`diagnostics.ts` / `diagnostics.rs` 使用问题说明→完整预览→本机导出的流程，导出必须匹配仍有效的 `previewId`，使用这份已生成快照，不临时加入新记录。每个日志总读取不超过 256 KiB，大文件读取不重叠的头尾窗口；每文件最后一个合法启动摘要优先进入最多 32 文件、2 MiB 的受限日志预算。自动收集项按白名单重验，只含受限日志、设置、版本和统计，排除启动参数、环境值、完整握手、标题、工作路径、正文和密钥；旧自由文本日志不导出。用户自填问题说明会明确提示按原样入包，不自动上传。源码机制的实现与实际安装验证分别见 `docs/status.md` 及本片证据。

`DraftStartup` / `draft_exit.rs` 协调正常退出与更新重启：暂停队列，等待未发送内容与准备进度保存后，用匹配的退出 token 确认；保存失败保留应用，旧确认不能授权新退出或穿过安装过程。`managed_update.rs` 的进程内准入锁让更新安装与连接、登录、安装等实际活动互斥，安装成功后保留重启所有权直至保存重启；等待界面结束不提前释放真实操作。

更新检查显式记录未检查、检查中、存在更新、确认最新、检查失败。每次检查先清除旧候选，仅已配置且检查成功可显示最新；错误经统一文案转换。更新源仍未配置，公开分发、正式签名和更新渠道由用户延后；当前内部维护不以这些设施作为开发门槛，也不能宣称线上更新验证通过。

## LifeModel

只有三个默认关闭的 settings 键和 `context_blocks_for_prompt()` 空返回，前端为静态说明与示例。没有当前可用的 Proposal/Canonical 数据处理闭环，也不能把历史实验模块的能力归到当前版本。

## 文件链接与窗口内容坐标修正（2026-10-05）

`MessageContent` 的缓存树从 Context 取得当前任务的 `onOpenFile`；完整行内路径、Markdown 文件链接、附件名称和 `ToolStep` 结构化位置共用这一回调，代码块/原始输出不激活。`ThreadView` 先通过既有页面关闭协调器取得回执，再把一次选择交给 `ArtifactPane`；`OpenedFileView` 只保留内存中的核实回执和当次文字。HTML 经原 `htmlRequest` 打开，Markdown 禁止 HTML、远程图片与链接加载。隐藏、卸载或身份变化作废迟到读取；同一路径再点击重新核实，恢复已完成视图不重复打开 HTML。原差异与文件意见仍保持独立。当前文件的外部打开沿原版本校验与文档类型限制，新增 html/htm，仍拒绝可执行文件。

独立 WK 的 CSS 坐标原点应是主 WK 的 `safeAreaRect`，不是整个 `NSView.bounds`；本机带标题栏时两者相差 28 点。位置乘主页面的 `pageZoom` 后按坐标方向转换，不乘屏幕倍率、不写死偏移。缓存最后接收的 CSS 矩形，并在所属父视图/窗口几何通知后合并到主线程重映射，处理窗口快速恢复但 DOM 数值未变的情况。创建与显示仍严格检查有效范围；普通 resize 容忍在途旧尺寸。关闭移除观察者，弱回调检查关闭状态，不重载页面或改变共享许可。
