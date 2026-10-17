# 当前源码架构

## 当前源码与证据边界（2026-10-17）

当前[额外技能目录临时发现](evidence/2026-10-09-capability-hardening/extra-skill-discovery/verification.json)源码 `a8e84d7ea` 已推送安装。共用 `AgentExtensionInventory` 显式选择一个额外目录；后端 `extension_inventory` 接受最多4个有序原始路径并精确回显，将规范化目录身份固定后，经同一短进程 `skills/extraRoots/set` 严格 `{}` 确认，再 `skills/list`，各阶段和结束重核身份，仍不是文件系统原子扫描。报告同时含默认技能，非空额外目录的整份结果均为 `discoveryOnly`，不生成管理目标，后端管理入口独立拒绝；不自动追加子目录、不安装、不写持久配置或发送提示，当前对话采用未验。26文件冻结含22变更/4共享；完整工程、原冻结受控浏览器的明确复用、安装与正式分项分别留证。正式目录查询及保存退出已有本批分项，metadata/10旧草稿保持，但严格5处目录差异和未知写者未豁免；P40整项及旧重开、初始化原因均未闭合。

此前[退出等待与PNG预览保护](evidence/2026-10-09-capability-hardening/exit-and-preview-guards/verification.json)源码 `6a5fb61c2` 已推送安装。`DraftStartup` 复用共用等待对话框，同次撤回只提交一次，迟到回包按当前请求处理；退出锁改用既有 `draft_storage.acquireInteractionLock`，撤回确认、延后及卸载只释放自身，更新和工作位置维护锁保持。撤回不取消保存、不恢复队列，重启规则保持。`attachmentMediaAdmission` 在16 MiB/编码检查后经 `message_png_admission` 最多33字节IHDR/CRC核声明边长8192和画布16,777,216像素；其他允许图片声明下的PNG签名同闸，拒绝先于来源及解码器创建。18文件冻结含12变更/6共享，工程、受控组件、安装分层留证；本批未启动新版本，完整PNG/动画/实际解码与传输内存、正式退出/媒体和旧未知原因均未闭合。

此前[可信执行诊断与媒体配额](evidence/2026-10-09-capability-hardening/trusted-execution-followup/verification.json)源码 `bb76e7995` 已推送安装。`message_media_budget`/`use_message_media_budget` 仅约束 `MessageContent` 消息附件4实例/32 MiB已准入文件字节；收起、列表隐藏及卸载释放，明确重试才进入，同附件摘要承接仍在按钮上的焦点，不抢走已移开的焦点。历史用户图片、Office、像素/时长、实际codec与传输内存不在配额范围。Rust `process_io` 透明包装既有三路stdio，汇总父端成功字节、EOF、错误总次数及首错固定类别/操作；封装释放补一次观测槽，不保证磁盘恰好一条，不证明子读取、协议有效或OS结束。14文件联合冻结含2份未改共用源码，另核2份既有README；两份独立分项审查合并，工程/受控浏览器/安装分层留证。五文件分别完整临时写入、fsync后替换为新inode，非整体事务；新版本本批未启动，旧初始化/重开/数据写者未知保持。

此前[P13媒体预览准入](evidence/2026-10-09-capability-hardening/message-media-admission/verification.json)源码 `c73b42b4d` 已提交推送。`message_attachments` 保留原协议负载并提供预览准入结果；单项16 MiB解码字节，先按长度拒绝超限，再有界检查编码，不先解码或生成来源。`MessageContent` 只在用户明确展开时消费该结果，分别显示超限和格式错误；搜索展开不启动媒体，既有 `MessageAttachmentMedia` 播放、失败重试和释放逻辑未改。75项相关检查、独立编码差分、组件双引擎各31项及七项实际工程分层通过；唯一正式应用已更新为本片源码，候选9项及恢复后安装10项独审通过，三份本批新安装清单严格一致，重复候选应用已移除，新版本本批未启动。像素、时长、聚合资源和传输内存不因本片变为有界。首次安装五文件写入后校验退出1，内核签名缓存未因原位覆盖而刷新；经独审后仅对同一程序作新文件原子替换，实际架构和严格签名通过，原失败与独立恢复链保留。后续安装不得复用旧原位写入Mach-O的方法；每次仍须完整源码、候选、退出与数据门禁。

[此前09ad正式分项](evidence/2026-10-09-capability-hardening/native-closeout-20261017/verification.json)已启动并正常保存退出。旧测试历史可读，但真实附件搜索、差异及整理忙态的正例条件未建立；复制入口因设置未核对保存而禁用。默认OpenCode未返回初始化回应，超时终止及连接清理已确认，底层原因未知。NEW-24完整权限读回仍缺；执行暂停不等于源码全面禁发，无新提示不代表无加载或配置通信。运行后严格数据退出2及未知写入者保留，草稿、设置、附件与队列的具体保持范围见记录。

此前[官方当前完整上下文复制](evidence/2026-10-09-capability-hardening/session-fork/verification.json)复用共用 `ThreadState`、`Channel`、`HistoryReplayBuffer` 与 `openedThreadState`。`ThreadPage`/`SessionForkDialog` 仅按实际连接能力呈现确认与结果；`session_fork` 保留同一操作的未知、迟到和终态事实，`prepareNew` 只在确认释放的终态建立新确认owner。Rust `session_fork/coordinator`、`pump/fork` 和 `operations/owned_reply` 负责一次官方fork、同ID保留、源端load及明确close、独立load和实际结束前的保护；`meta_store/fork` 只向既有索引插入新子记录，不复制会话正文或建立事件账本。项目文件位置共享，原输入和队列保持，新对话不继承旧权限确认；关闭窗口不伪造回滚。源码50文件及完整工程、候选9项和受控39/42项各分层记证；WebKit普通Tab限制不改绿，正式09ad在该安装批当时未启动，本轮分项见上文，指定节点/回退/检查点及真实Agent仍缺实证或开发。

共用前端与 Tauri/Rust 沿官方 ACP/SDK/CLI 连接外部 Agent，既有架构边界保持。唯一正式应用当前为 `a8e84d7ea`，本批已核明确技能目录查询及保存退出，其他能力保持各自证据边界；此前09ad正式分项结果见上文；此前[P21整页意见与共用文件入口](evidence/2026-10-09-capability-hardening/pptx-feedback/verification.json)区分源码、受控界面、完整工程、安装与本机分项。该P21阶段安装基线三份清单一致；运行后严格两处差异和旧→新基线五处内容摘要变化分别保留，独审核到旧对话/隐藏记录、九份旧草稿及附件、队列和配置保持；设置变化为受控输入、意见及对应活动变化，Agent 更新时间写者未知，严格差异不豁免。此前P30的[本机分项](evidence/2026-10-09-capability-hardening/remembered-pages-install/verification.json)仅证明所覆盖路径；旧对话重连失败、旧许可本机撤回与真实 Agent 证明仍缺，上轮延迟严格差异及用户主动处理测试草稿的澄清保持。

此前P32扩展沿 `SelectedAttachmentSearch` → `AttachmentSearch` → `file_delivery_read_pptx_search`：完整1MiB源经现有 `search_source`、ZIP/CRC及实际读取槽，使用既有 `readPptxPreview` Worker和闭合模型。`attachment_search_pptx` 仅生成临时预览文字片段及part/shape/预览序号/段落/换行身份，不增加正文存储、Agent输入或新循环。格式生成项目符号/间隔明确披露；四类片段边界不拼接，PPTX结果始终partial。七字段及实际thread/item/attachment归属、文件变化、取消/迟到和真实未结束读取保护保持，命中只定位原消息附件节点。[本片证据](evidence/2026-10-09-capability-hardening/pptx-search/verification.json)区分14文件源码cd0097111、七项实际工程、双引擎各38项受控和候选9/安装10项独审；三份217,407条安装清单严格一致，候选副本已精确清理。该P32阶段的cd009安装后未启动，正式搜索、冷恢复及真实Agent仍未测。

此前整理活动保护批次新增 `compaction_activity` 内存活动保护：接入层区分历史、当前活动及终态，原始事件先于含准确连接/对话归属的活动信息交付；界面只消费该活动事实作准入，不扫描历史卡片。进行中或未知整理继续持有工作资格，保护异步派发、配置、归档、账号和更新；断线、实际进程结束及迟到普通回包不冒称独立整理完成。恢复期间提前送达的活动信息按准确归属接收。[该批记录](evidence/2026-10-09-capability-hardening/compaction-activity/verification.json)分开记29文件源码、第二轮完整工程、原28文件双引擎各29项的明确复用及候选9/9与安装10/10。三份217,407条安装清单严格相同，候选副本已精确清理；该阶段正式40c4安装后未启动，核心忙态、实机界面/冷恢复与真实Agent未测。不包含手动压缩、fork或完整权限恢复。

新入口为 `BrowserRememberedPages.tsx`、`browser_remembered.ts`，经既有 `BrowserTabs`/`BrowserWorkspaceScope` 打开新页面；后端 `browser_workspace/remembered_pages.rs` 核对当前实际页面，`meta_store/remembered_pages.rs` 仅保存网址清单及必要归属/CAS 字段。既有索引和创建时间必须一致；记住顺序稳定、空清单推进修订、删除对话与记录原子清理。重启读取只加载元数据，不创建页面或恢复旧许可；忘记记录不关闭活页。

历史 P16 预览切片：P16 的[普通 PPTX 视觉预览](evidence/2026-10-09-capability-hardening/pptx-preview/verification.json)原实现 `e0605006c` 已提交；后续默认模板兼容修复 `c7466f69f` 已提交并安装。`file_delivery/presentation.rs` 复用有界 ZIP 读取与真实读取槽；`pptx_package/theme/layout/text/shapes/parse` 明确关系、继承和直接覆盖，Worker 内外的闭合模型检查及二进制/实际解码保护被动显示。`PptxFilePreview`/`PptxSlideView` 仅绘制基础 SVG、普通文字及本地 Blob 图片；共用 `office_preview_prepare` 在新内容准备完成后才替换旧页，保留七字段来源、临时阅读位置、切页归属和未知读取保护。不生成文档 HTML、不加载外部资源，该切片本身不新增正文存储、搜索、Agent 输入或意见锚点；后续意见扩展见下文。

此前P21增量沿 `FilePreviewPicker` → 既有七字段核实 → `OpenedFileView` 打开文件；取消保留内容，真实请求结束前阻止并发选择，归属变化永久撤回旧返回。`PptxSlideView` 提供当前整页的两步确认，`OfficeFeedbackSource` 的实际对象、选择 token、资源 lease 与父级来源共同约束保存；翻页、隐藏、刷新、图片错误和交互阻断同步撤回旧候选。意见对象保留文件版本/SHA，PPTX 锚点四字段为 kind、文件内 part、预览序号与预览总页数；预览序号不当作文件页码；界面摘要与交付定位依据分别表达。共用 `FileFeedbackEditor` 保持单套意见 UI。

意见加入输入经共用 `FileFeedbackDestination` 指定实际可见目标，并沿 `DraftLocationOwner` 核实准备新对话的原归属；加入与消费原子完成，失败保留双方内容，临时忙碌阻断不改变身份。复用既有未发内容持久化，保留历史版本意见，不保存幻灯片正文、不自动发送。最终[七项工程](evidence/2026-10-09-capability-hardening/pptx-feedback/engineering.json)全部实际通过，18,946 输入稳定；完整 App 两引擎各 74 项受控检查通过。本机已核两页预览、定位意见及有意冷启动恢复，默认模板明确部分预览；这些分项不关闭 P16/P21，旧失败及自动重开未知归因保持。

P30 的[实现与检查](evidence/2026-10-09-capability-hardening/remembered-pages/verification.json)区分相关测试、受控完整界面、工程及上述有界正式冷恢复。首次交付仍全部 29 家及八项标准；P27 生产截图的系统安全证据及 NEW-24 完整权限回执仍缺。最新执行衔接见[当前状态](status.md#当前续接2026-10-17)。

## 阶段实现与验证摘要（2026-10-14，对齐前记录）

以下日期/提交小节用于说明源码与各阶段证据；其中“当前”“下一步”是当时表述，不恢复旧执行顺序或未完成声明。

P30 的[运行期间多标签](evidence/2026-10-09-capability-hardening/browser-tabs/verification.json)已完成本片源码与受控验证：同一对话可保留多个页面实例，明确切页先撤回旧页共享与未交付读取，再等待隐藏确认；普通收起或离开对话只隐藏同页。已保留页面按稳定顺序呈现，切回对话不重新创建或关闭另一对话页面；取消、失败、迟到回执和明确关闭分别保持原归属。

后端 178 项定向通过；前端先完成 241 项定向，最后布局恢复增量的 74 项相关回归、类型及格式检查通过（两组覆盖相交）。最终完整 App 的 Chromium/WebKit 各 141 项检查、13 个场景通过，1,109 个输入前后稳定，使用受控命令和合成网页，页面错误与外部请求均为 0。旧 138 项通过漏检反向保留，后续真实反例、诊断和修复证据均保留。本片未新建持久浏览清单；重启恢复、正式网页、真实 Agent 与 Windows 分项待验，P30 和 NEW-24 不关闭。本片受控证据与下述正式工程、安装及本机验证分别记录。

本片前两轮完整工程均在同一个服务配置终端测试的 3 秒就绪等待处失败，PTY 记录为空，原日志未区分超时或通道关闭。三轮临时诊断通过但未复现，原失败原因仍未知。后续仅修正测试稳健性：夹具启动预算改为 10 秒，保留完整就绪信号、所有权、取消及精确回收断言，明确等待失败类别，并在断言前释放输出锁以免二次中毒；没有修改终端生产逻辑。第三轮正式工程通过不回写前两次失败，也不把诊断通过写成生产故障已修复。

本片[第三轮完整工程](evidence/2026-10-09-capability-hardening/browser-tabs-checks/verification.json)七项实际通过：2,538 个输入稳定，前端 503 文件 / 6,116 项，Rust 1,692 项通过、6 项忽略。源码 `aabbbb063` 已推送 main；[候选独立检查](evidence/2026-10-09-capability-hardening/browser-tabs-candidate/candidate-independent.json)9/9、[安装独立检查](evidence/2026-10-09-capability-hardening/browser-tabs-candidate/install-independent-final.json)10/10。

[安装回执](evidence/2026-10-09-capability-hardening/browser-tabs-install-review/verification.json)确认唯一正式应用已更新为 `aabbbb063` / 0.1.7 arm64，安装前、替换前及安装后三份 217,400 条完整清单逐字节相同（`eb77d425…`），原字节备份保留；重复 App 产物已精确移除，正式应用和 ZIP 归档保留。该安装回执只描述启动前阶段；随后本机分项已实际观察到合成页面切换、收起/文件区往返、B 关闭重开、两对话同源 B 双向状态保留及手动文字快照，并经“保存并退出”核到精确正式进程为 0。首次快照超时不计成功，解锁后的第二次才有结果；滚动只按无障碍工具的归一化值记证，不宣称像素不变。运行后的严格数据比较仍未执行，不能把安装时三份清单相同扩大为运行后数据不变。重启恢复、真实 Agent、Windows、P30 整项与 NEW-24 仍未完成，旧严格数据差异未豁免。

源码入口为 `BrowserWorkspace.tsx` 与共用 `BrowserWorkspacePage.tsx`、`browser_tabs.ts` 和 `browser_workspace.ts`；后端 `browser_workspace` 按页面保存所有权与选择状态，macOS/Windows 创建页面先隐藏。选择控制序号与实际导航分开；`App` 保留所有仍有页面或打开请求的对话，页面清理仍等待真实关闭回执。此处平台实现不代表 Windows 或正式网页已运行验证。

P18 的[共用工具差异比较](evidence/2026-10-09-capability-hardening/diff-summary/verification.json)已完成本片源码与受控验证：消息与内容栏共用有界逐行比较，仅已精确对齐的正文显示增删统计；缺少修改前文本与已知空文本分开，超出比较预算时保留两侧原文并中性提示。空白、Unicode、LF/CRLF 与末尾换行保持，换行变化标注两侧各自的片段行号。失败、未完成、未知结果及输入意图不提升为已写入；点击明确文件位置才核验当前内容。

前端定向 10 文件 / 117 项、独立纯比较 13 项通过；完整 App 的 Chromium/WebKit 各 147 项检查、17 个场景通过，使用合成工具报告与受控文件返回，1,098 个输入前后稳定。原产品反例、旧断言及测试脚本失败和五轮浏览器脚本失败均保留；迟到保护的浏览器证据限定为文件检查期间切换对话。

本片[第二轮完整工程](evidence/2026-10-09-capability-hardening/diff-summary-checks/verification.json)七项实际通过：2,059 个输入稳定，前端 500 文件 / 6,080 项，Rust 1,681 项通过、6 项忽略。首轮仅格式、类型通过，前端 6,079 通过 / 1 项旧断言失败，后四项未启动；[修正记录](evidence/2026-10-09-capability-hardening/diff-summary-correction/publication.json)保留原失败，修改仅限一个 SSR 测试断言，原 15 文件不变，原浏览器运行未执行新断言。

源码 `fcd7b266` 的候选构建和独立 9 项检查已通过；正式更新结果为 `fcd7b266` / 0.1.7 arm64 已安装且尚未启动。安装前与替换前两份完整清单均为 217,400 条且逐字节相同（`eb77d425…`），原字节备份已完成；安装后的第三份完整清单与前两份逐字节相同；最终独立 10 项检查实际通过；重复 App 产物已移除，唯一正式应用及 ZIP 归档保留。公开依据见[安装回执](evidence/2026-10-09-capability-hardening/diff-summary-install-review/verification.json)及[最终独立核验](evidence/2026-10-09-capability-hardening/diff-summary-candidate/install-independent-final.json)。本片正式界面分项尚未测试，未启动真实 Agent；工具报告不作为磁盘写入证明，P18 整项和 NEW-24 仍未完成。

NEW-26 的[系统文件面板本机分项](evidence/2026-10-09-capability-hardening/file-dialog-native/installed-native-scoped.json)在已安装的 `9c278d82` 上复验：实际鼠标选择 140 字节 WAV、2554 字节 PDF 均使“打开”可用，并把文件位置加入草稿。PDF 明确范围后显示 1,311 字节、3 页部分文字；第二项同意未勾选，未保存新 PDF 正文。预览取消、仅移除本次临时附件及再次面板取消后，原两附件、33 字节标记、Ultra 与发送禁用可见保持；已正常退出并核到正式进程为 0。旧失败和本轮控件编号失效保留；旧原因仍未定位，未改源码，不将本次复验写作代码修复或 XLSX 已测。没有发送或批准 Agent 权限动作，不据此宣称官方请求计数为零。

本轮严格数据比较实际退出 2，独立第二副本核对仅定位到一条 Agent 的 `updated_at` 变化，具体写入者未知，原差异未豁免。135 条会话、171 条屏蔽、53 项设置、整个未发内容原始字符串及全部 10 份草稿精确保持；33 字节标记、完整 140 字节音频、PDF 完整保存表示 1311 字节及两附件全部 7 项来源字段相同，临时文件附件无残留。两份工作副本在独立读取前后的摘要稳定；本机正常选择、取消保稿和 PDF 读取条件已有本轮分项证据，不将原严格比较改为通过。

P32 的[所选本地 PDF 附件临时文字搜索](evidence/2026-10-09-capability-hardening/pdf-search/verification.json)已完成本片源码与受控验证：`file_delivery_read_pdf_search` 提供有界捕获，复用 `readPdfInput` 的生产 Worker 与 `pdf_search_text.ts`；勾选文件、查看明确的全部页范围后，按“开始”才读取；结果可能含不可见文字，始终按部分内容说明。每个实际文字片段及页面分别匹配，不跨片段拼接，不搜索包装或说明；不做 OCR，整份解析失败时不保留先前页面的命中。每个完整源文件 ≤1 MiB，与文字、DOCX、XLSX 共用最多 20 个文件、实际检索文字合计 ≤16 MiB 的预算及批次解析顺序；来源七字段、完整文件摘要、取消和迟到返回保护保持。

后端定向 18 项、前端 9 文件 / 262 项通过；完整 App 的 Chromium/WebKit 各 76 项检查、11 个场景通过，使用生产 PDF Worker 与受控文件返回，1,096 个输入稳定，页面错误和外部网络请求均为 0。原缺少 PDF 路由的失败、测试夹具参数错误、开发服务首次依赖重载及无文字样本定位脚本失败分别保留。[本片七项工程检查](evidence/2026-10-09-capability-hardening/pdf-search-checks/verification.json)在 2,029 个稳定输入上全部实际退出 0：前端 498 文件 / 6,034 项，Rust 1,681 项 / 6 忽略。

源码 `2a720169` 已推送 main，唯一正式应用已更新为该版本 / 0.1.7 arm64；[候选检查](evidence/2026-10-09-capability-hardening/pdf-search-candidate/candidate-independent.json)9/9、[安装独立检查](evidence/2026-10-09-capability-hardening/pdf-search-candidate/install-independent-final.json)10/10。[安装记录](evidence/2026-10-09-capability-hardening/pdf-search-install-review/verification.json)中，安装前、替换前及安装后三份 217,400 条完整清单相同，数据库备份保持；重复打包应用已精确移除，正式应用和候选 ZIP 保留。本片安装与清理均实际退出 0，安装后尚未启动。正式附件搜索命中、来源跳转和真实 Agent 仍未验证，NEW-24 与 P32 整项保持开放；此前严格数据比较差异未豁免。

P32 的[所选本地 XLSX 附件临时内容搜索](evidence/2026-10-09-capability-hardening/xlsx-search/verification.json)已完成本片源码与受控验证：`file_delivery_read_workbook_search` 提供有界捕获，复用 `readWorkbookInput` 的 `visible-saved-cells` 结果及 `xlsx_search_text.ts`；明确开始后只查找可见工作表范围内的保存值、公式缓存及实际保存且允许读取的公式文字；各单元格及字段分别匹配，不计算、不补写或展开公式，不搜索显示格式、标签或属性。隐藏、可见性未知及合并覆盖内容不参与，无可见工作表明确拒绝；缓存可能过期及省略范围说明常显。每个完整源文件 ≤1 MiB，与 DOCX、UTF-8 文字共用最多 20 个文件、实际检索文字合计 ≤16 MiB 的预算；来源变化、取消和迟到返回仍撤回结果。 DOCX 与 XLSX 共用批次解析顺序及两项读取上限；位置保留真实工作表身份、单元格和字段，仍跳转到消息中的来源附件。

后端定向 40 项、前端定向 190 项通过；完整 App 的 Chromium/WebKit 各 162 项检查、17 个场景通过，使用生产文档 Worker 与受控文件返回，源码稳定、页面错误和外部网络请求均为 0。原未命中及字符串检查、夹具排版失败保留并区分。[本片七项工程检查](evidence/2026-10-09-capability-hardening/xlsx-search-checks/verification.json)在 1,842 个稳定输入上全部实际退出 0：前端 496 文件 / 5,962 项，Rust 1,674 项 / 6 忽略。

此前 XLSX 搜索源码 `c89b8f82` 已推送 main，并曾安装为 0.1.7 arm64；[候选检查](evidence/2026-10-09-capability-hardening/xlsx-search-candidate/candidate-independent.json)9/9、[安装独立检查](evidence/2026-10-09-capability-hardening/xlsx-search-candidate/install-independent-final.json)10/10。[安装记录](evidence/2026-10-09-capability-hardening/xlsx-search-install-review/verification.json)中，安装前、替换前及安装后三份 217,400 条完整清单相同，数据库备份保持。重复打包应用已移除，正式应用和候选 ZIP 保留。清理脚本在删除后引用已删目录，原退出 1 保留；独立恢复工具未再删除，经正式文件及 ZIP 核对后补齐回执。安装后尚未启动，附件搜索命中与来源跳转仍未在正式窗口验证；NEW-24 与 P32 整项保持开放；本片 PDF 搜索的工程与安装结果见上文。

P32 的[所选本地 DOCX 附件临时文字搜索](evidence/2026-10-09-capability-hardening/docx-content-search/implementation.json)复用共用搜索面板、有界来源检查及现有文档 Worker：`file_delivery_read_docx_search` 只在明确开始后读取完整来源，`docx_search_text.ts` 只提取作者文字，保留段落、单元格与文档区域位置；图片、隐藏或省略内容两侧不拼接为命中。同批文档串行解析，最多两项读取；每源文件 ≤1 MiB、最多 20 个文件，实际 UTF-8 检索文字合计 ≤16 MiB。结果仍跳转到真实来源附件，来源变化、取消或迟到返回撤回结果，不建立持久正文索引。

前端 v1 定向 109 项、v2 的可见省略提示及字符串 6 项通过，后端定向 24 项通过。完整 App 的 Chromium/WebKit 最终各 60 项检查、11 个场景通过，使用真实文档 Worker 与受控文件返回，源文件稳定且无页面错误或外部网络请求。原 DOCX 未命中、预取预算、提示折叠及测试脚本错误均保留并区分。[本片七项工程检查](evidence/2026-10-09-capability-hardening/docx-search-checks/verification.json)第二轮在 1,799 个稳定输入上全部实际退出 0：前端 494 文件 / 5,885 项，Rust 1,666 项 / 6 忽略。首轮 Rust 音频取消后清理测试失败保留；仅两份测试改为等待真实取消完成事件，未修改生产取消语义。

此前 DOCX 搜索源码 `52d21a3` 已推送 main，并曾安装为 0.1.7 arm64；[候选独立检查](evidence/2026-10-09-capability-hardening/docx-search-candidate/candidate-independent.json)9/9、[安装独立检查](evidence/2026-10-09-capability-hardening/docx-search-candidate/install-independent-final.json)10/10。[安装](evidence/2026-10-09-capability-hardening/docx-search-candidate/installation.json)前、替换前和安装后三份 217,400 条完整清单相同（SHA-256 `eb77d4255cab06d3096378b2123365a9555c97e23aef3cf5b264185c504b6849`），数据库备份保持；重复打包应用已精确移除，正式应用和候选 ZIP 保留。安装后尚未启动；附件读取、匹配及来源跳转正例仍未在正式应用验证。安装与受控通过不提升 NEW-24 或 P32 整项结论。

P27 的[截图不可用请求保护](evidence/2026-10-09-capability-hardening/screenshot-unavailable/implementation.json)已完成源码定向 2 项及相关回归 58 项：`screenshot=true` 按原请求身份拒绝，普通文字路径保持；生产截图能力仍缺少。P32 的[所选本地文本附件临时搜索](evidence/2026-10-09-capability-hardening/attachment-content-search/implementation.json)已完成本片源码与受控验证，明确选择后才读取，不连接 Agent 或建立持久正文索引。前端 v1 定向 6 文件 / 68 项、Chromium 与 WebKit 各 55 项通过；当前 v3 仅累计两处文案修正，v2、v3 各补字符串检查 2/2，未重跑完整浏览器。后端有界读取、来源核验及共用读取池已有定向验证。本片已提交并安装 `9c278d82`；P27 生产截图及 P32 整项仍未完成。

此前 P27/P32 正式版本为 `9c278d82` / 0.1.7 arm64，源码已推送 main。[本片七项工程检查](evidence/2026-10-09-capability-hardening/attachment-search-checks/verification.json)在 1,756 个稳定输入上全部实际退出 0：前端 491 文件 / 5,821 项，Rust 1,658 项 / 6 忽略；[候选独立检查](evidence/2026-10-09-capability-hardening/attachment-search-candidate/candidate-independent.json)9/9、[安装独立检查](evidence/2026-10-09-capability-hardening/attachment-search-candidate/install-independent-final.json)10/10。安装前、替换前及安装后三份 217,400 条完整清单相同（SHA-256 `f07c39cbd8bca17c11d9fdf368014d11f44eb21f9b9432b68492c7e8e328a73f`）；唯一正式应用已替换，重复打包应用已精确移除，候选 ZIP 保留。

[本片正式界面有限观察](evidence/2026-10-09-capability-hardening/attachment-search-native/installed-native-scoped.json)核到共用搜索范围与空态：首次 134 个对话未加载，明确打开一条既有专用 XLSX 历史后为 133 个，仍无附件候选。257 个 ASCII 字节关键词显示 256 个 UTF-8 字节上限提示；没有已选文件时开始按钮本已禁用，不作为已选文件长度门禁的独立实证。菜单点击未生效的原事件保留，End/Return 随后完成选择；收尾恢复资料范围，原 33 字节标记、两附件及 Ultra 可见保持。未操作发送或批准权限，不据此宣称官方请求计数为零。已正常保存退出，随后精确正式进程为 0；未知工作不改记完成或停止。实际附件读取、匹配和来源跳转正例尚未正式验证，P27 生产截图与 P32 全部原条件仍开放。

本片正式运行后的严格数据比较实际退出 2，独立逐字段核对仅定位到一条 Agent 和一条会话的 `updated_at` 变化，具体写入者均未知，原差异未豁免。53 项设置全部原值、整个未发内容原始字符串及全部 10 份草稿精确相同；33 字节标记、完整 140 字节音频、PDF 完整保存表示 1311 字节及两附件全部 7 项来源字段保持。两份捕获后工作副本在独立读取前后的摘要与文件状态稳定；这证明上述保留范围，不把原比较改写为通过，也不证明未知工作已完成。

[正式 PDF 的 `@` 入口分项](evidence/2026-10-09-capability-hardening/pdf-at-route-native/installed-native-scoped.json)在此前 `36c56a82` 上完成：2554 字节合成 PDF 明确选择读取范围后取消，原文件位置保留；再次明确范围并同意部分读取后保存。2998 字节加密样本被拒绝，取消后只移除本轮负例附件。正常退出和精确进程为 0 后另行启动，确认 PDF 与音频恢复；查看不解除恢复检查，明确保留所选附件后重新核对成功，发送仍禁用，未向真实 Agent 发消息。最终再次正常退出。

[独立界面与数据核对](evidence/2026-10-09-capability-hardening/pdf-at-route-native/data-publication.json)分别保留原始证据。以前一轮音频冷恢复后的快照为基线，本轮严格比较实际退出 2：一条 Agent 仅更新时间变化，具体写入者未知；本轮既有草稿仅新增上述 PDF。原 135 条会话、171 条屏蔽、39 条其他 Agent、52 项其他设置、其他 9 份草稿和未发内容其余字段保持；33 字节标记及完整 140 字节音频与 7 项来源字段准确保持，`sendPending` 仍为 `false`。第二副本核到 PDF 完整保存表示 1311 字节、3 页及全部 7 项来源字段；完整文字及页项与既有独立受控结果一致，仍是明确同意的部分读取，不证明可见版式、OCR 或全部文件字符串。原 exit 2、两处差异和此前差异均未豁免。当时 NEW-26 系统文件面板仍开放，后续本机有限复验见首段；NEW-24、真实 Agent 接收及 P08 整项仍开放。

PCM WAV 输入沿用共用附件：`draft_attachment/audio.rs` 识别候选，`file_delivery/audio_input.rs` 验证完整文件及来源，实际发送连接核音频能力和每条消息 16 MiB 总量；前端负责明确审阅、确认、保存归属与恢复复核，发送仅含官方音频字段。`draft_audio_encoding.ts` 在单次既有草稿快照内去重相同音频字符串，保持原子写入、旧格式兼容及 32 MiB 保存限制，并限制 256 处引用与 96 MiB 展开量。[前端](evidence/2026-10-09-capability-hardening/audio-input/frontend/publication.json)、[后端](evidence/2026-10-09-capability-hardening/audio-input/backend/publication.json)及[独立复核](evidence/2026-10-09-capability-hardening/audio-input/independent/publication.json)已完成本片受控验证；当前 v2 只比受测 v1 多一份测试排版变化。本片工程、安装及有限正式分项见下文；真实 Agent 接收仍待验。

此前音频正式版本为 `36c56a82` / 0.1.7 arm64，源码已推送 main。[音频七项工程检查](evidence/2026-10-09-capability-hardening/audio-input-checks/verification.json)在 1,736 个稳定输入上全部通过：前端 488 文件 / 5,763 项，Rust 1,650 项 / 6 忽略；[候选](evidence/2026-10-09-capability-hardening/audio-input-candidate/candidate-independent.json)9/9、[安装独立检查](evidence/2026-10-09-capability-hardening/audio-input-candidate/install-independent-final.json)10/10。安装前、替换前及安装后三份 217,400 条完整清单字节一致，重复打包应用已精确移除，唯一正式应用与候选 ZIP 保留。

[正式音频分项](evidence/2026-10-09-capability-hardening/audio-input-candidate/installed-native-scoped.json)通过 `@` 项目文件入口完成 140 字节合成 PCM WAV 的完整预览、取消保留文件位置、明确确认并保存，以及有正确进程退出证据的冷恢复与重新核对。当前连接未声明音频输入，附件保持完整音频且发送禁用；未向真实 Agent 发送。当时系统文件面板的 WAV“打开”不可用，NEW-26 尚未关闭；`@` 入口成功不证明系统面板已修复，后续本机有限复验见首段。早期两份进程检查误用了可执行文件名大小写，原失败保留，后补的正确检查不追认此前冷恢复；用户解锁后已另做真实冷恢复。两次运行后的严格数据比较均实际退出 2，原结果和两处差异保留：一条 Agent 的更新时间，以及本轮原有草稿新增完整音频与 `sendPending` 缺省变为 `false`，具体历史写入者未证。独立第二副本核到原 135 条会话、171 条屏蔽、39 条其他 Agent、52 项其他设置及其他 9 份草稿不变；两次捕获之间，53 项设置逐原值相同，整个草稿原始字符串、33 字节标记、140 字节音频全文件哈希及 7 项来源字段跨真实冷恢复完全一致，仅同一 Agent 更新时间再变。这两轮捕获与独立核对仅通过 SQLite 打开第二工作副本及新合并副本，不把局部保持写成全部数据不变。NEW-27 的 16 MiB 发送/待发容量及 NEW-28 的错误归属全路径仍只有受控证据，有限正式分项不替代这些完成条件。

原型 07 已接入正式工作台，最近安装与有限实机核对见 [当前状态](status.md)；原型示例、工程检查和真实 Agent 工作仍分开记证。本文的模块职责以当前源码为准，带日期小节保留当时实现的范围；其中“本片”“首片”“当时未安装”等不是新的执行指令，也不能覆盖后续已实现能力。

- React/Tauri 共用一套工作台，官方 ACP 接入层连接外部 Agent。Agent 拥有推理、工具、账号、模型、历史与技能；Farfold 不建立第二个循环，配置变更经官方接口，不直接改写其配置文件。当前没有声明客户端文件/终端能力；未来是否需要承接官方回调由活动计划 ARCH-44 逐项核实，不能把这类回调一概等同第二个循环。
- 每个工作对话有独立进程，准备连接可按其用途复用；独立进程不隔离 Agent 自己共享的账号、配置和项目文件。模型/推理可在同一对话安全空闲时按官方能力变更，确认并保存后生效。
- 当前官方目录限用户保留的29项，八项标准与逐家真实验证边界见产品契约和状态页；目录过滤不是兼容性或验收成功证明。
- 无工作文件夹时保留草稿，不预开工作对话、不发送、不回退应用目录。未发送内容和准备选择已有持久保存；Agent正文仍由官方历史接口提供，不建正文账本。
- 文件可核验、查看、另存并提出版本意见；文字/Markdown/HTML与其他格式的呈现边界分别处理。网页已有公开页、本地单文件、多文件目录和开发服务器路径，工具声明包含读取、观察、点击和普通输入；生产截图明确不可用，工具实际接入覆盖仍有限。
- Windows 系统适配已进入源码，实机运行与macOS证据分开；公开分发、正式签名和更新渠道按用户决定延后，不作为本轮开发门槛。

## 已登记历史的官方SDK部分读取（2026-10-13 来源修正与正式分项复验）

`acp_client/history_search/launch`仅从用户已选择的官方Claude程序入口与其安装内公开包声明解析SDK；`claude/claude_read`按保存的准确历史标识与目录执行固定的信息→文字→信息只读调用。没有查询模型、恢复对话、修改配置、另建Agent循环或读取私有历史的替代路径。程序环境沿用既有选择；未知入口、危险预载或来源变更拒绝读取，保护与真实进程/进程组/管道清理共用现有执行机制。

共用types/controller/Panel/Results识别官方SDK的部分覆盖回执，开始前及结果中都说明已登记范围、分支与上下文续接未证。带来源的用户文字仅放行用户角色的官方{kind:"human"}形态；任务、未知及混杂来源、元信息、压缩摘要、排队/本地命令、思考与非文字分段保持排除。返回的是官方保存的用户/回复文字，可能包含已处理的附件上下文或获批准的续写，并非逐字键盘输入；不另行读取附件文件。官方消息UUID与原分段位置只随临时结果保留，不伪造旧Codex定位或建立持久账本。成功仍为部分覆盖，空返回保持未核实；来源重查及取消、过期、删除再出现、A→B→A撤权保护保持。SDK内部读取与分配不构成硬I/O/内存限制或原子历史快照保证。

[当前修正证据](evidence/2026-10-09-capability-hardening/claude-history-origin-fix/implementation.json)保留63f正式有界读取的失败：候选9项、安装10项已过，三份217,400条清单一致，实际1页/1段文字，但已知用户文字及前缀均0匹配，预览/打开未执行。来源过滤真红后Node19项、Rust类12项、独立23项通过；选择器仅追加一个既有共用样式选择器，双浏览器各23项通过，原生空白原因未唯一定位，后续候选的本片正式效果另见下段。三处修正的原七项工程全部实际通过；[追加范围说明的复查](evidence/2026-10-09-capability-hardening/claude-history-origin-fix/checks/run-02/verification.json)在1,578稳定输入上实际执行四项前端并通过（442文件/5,203项），三项后端因相关输入未变明确复用原结果（Rust1,610项/6忽略），本轮未再执行，不算新安装验证。63f原轮正常退出后数据按完整字段保持，仅Claude providers缺失→空对象及更新时间变化获接受，具体写入者未证。原源码25项引用已转为历史引用，旧失败及原记录保持；P32整体与29家原标准未完成。

此前 PDF/权限版本为 `e5995b219` / 0.1.7 arm64，源码已推送 main。[PDF 与权限保护整合检查](evidence/2026-10-09-capability-hardening/pdf-permission-checks/verification.json)在 1,703 个稳定输入上七项全部实际通过：前端 481 文件 / 5,643 项，Rust 1,634 项 / 6 忽略。保存配置期间漂移及首发拒绝后重试绕过确认的两轮原始失败均保留，5 项竞态对照与 37 项发送回归通过。[正式安装](evidence/2026-10-09-capability-hardening/pdf-permission-candidate/installation.json)独立候选 9/9、安装 10/10；安装前、替换前、安装后三份 217,400 条完整清单字节一致。重复打包应用已精确移除，唯一正式应用与候选 ZIP 保留；这只证明安装时的数据保持，正式界面运行后的核对另记。

完整 App 的权限/PDF 组合受控检查在 Chromium、WebKit 各 32 项通过；实际打包的两级 PDF 工作线程在纯静态服务各 3 个样本通过，服务字节与产物哈希一致。正式界面已核到权限“下次消息的选择”、当前完整权限未知说明和取消后原选择保留；文件面板选中 PDF 后“打开”不可用，XLSX 对照相同，当时未定位原因，也未把 PDF 路径交到解析器。当时的正式读取与附件冷恢复缺证现由上述 36c `@` 有限分项补充；当时系统文件面板未获成功验证，后续本机有限复验见首段；未定位旧原因或改动源码，真实 Agent 接收仍未验证。新的真实请求继续暂停，NEW-24 完整权限恢复、P08 全项和其余计划条件保持未完成。

[本片正式分项](evidence/2026-10-09-capability-hardening/pdf-permission-candidate/installed-native-scoped.json)当时已正常保存退出，精确正式进程为 0；该轮冷恢复仅证明 33 字节未发标记完整，不能记作 PDF 附件恢复；后续 36c `@` 附件恢复另见本节新分项。H17 既有结束后未知结果保持，未确认、重核或改记成功/停止。退出后的严格数据比较实际退出 2：原 135 条会话、171 条屏蔽、39 条其他 Agent、52 项其他设置及全部 9 份旧草稿保持；新增草稿仅本轮准确标记和空附件，另一处仅 Agent 更新时间变化，具体写入者未知。独立第二副本核验通过，原比较与两处差异保持，不宣称全部字段相同。NEW-26 当时记录本机文件面板入口阻塞，尚无成功实际鼠标点击对照；后续本机有限复验见首段，仍不把辅助操作失败直接归为产品解析缺陷。

此前正式应用 `92aa4a27` 的[XLSX与DOCX来源修复正式分项](evidence/2026-10-09-capability-hardening/xlsx-input-candidate/installed-native-scoped.json)完成候选9/9、安装10/10，安装前后三份217,400条清单逐字节相同，唯一正式应用已正常保存退出。沿用已有Codex来源及6 Astra / Ultra完成两次XLSX真实请求，独立官方记录核对20/25/1/1条全部单元格的字段、值、类型、公式、缓存及顺序精确一致，四份完整附加正文匹配，记录中0次工具调用；两份普通提示各仅移除一个末尾换行，原拟发送文字和官方记录均保留。冷恢复保留三份全文和全部范围选择，查看不授予发送许可；明确核对附件、重新确认权限后也不自动重发。NEW-20在正式DOCX及XLSX均核到文件变化拦截、查看/取消保留错误、当前完整文字实际确认并保存后清除旧错误；DOCX源文件及25,744字节全文准确还原，无第三请求。NEW-21的缺失/空/有缓存对照和NEW-22的标签、普通Tab/方向键/Space/Return/Escape、深色/窄窗均已有本机正式分项；NEW-23三种失败→重试的源码与受控结果保持，正式故障注入及重试仍未测试。

此前 92aa 正式验证后的唯一数据捕获实际退出0；原完整比较退出2且不改写，三处差异单列未豁免：Codex更新时间、受控DOCX位置的一条新屏蔽记录，以及自有DOCX草稿sendPending缺省→false。独立第二副本逐字段核对保留全部134条旧会话、170条旧屏蔽、39条其他Agent、52项其他设置、全部8组意见与3组待发、8份其他旧草稿和自有DOCX普通全文；仅新增准确自有XLSX会话及活动，四项准确自有活动/选择位置/来源版本变化事先逐哈希声明。本轮只读复核两份已捕获副本及合成验证：新屏蔽身份与前后已索引会话均不重合；相同握手可更新时间，sendPending缺省在后续变更保存时可归一为false，true不会降级。三处历史具体写入者仍未知；屏蔽记录也不证明官方历史为空或关闭成功，不能写“全部数据逐值不变”或“原比较通过”。原数据、首份捕获及完整schema保持，私有正文、数据库和账号信息不公开。

新增NEW-24：官方接入恢复未重建旧具体文件/网络权限，旧DOCX完整官方字节前缀保持，仅追加764字节设置事件，其中permission_profile由managed restricted变为disabled；官方源码的disabled确为不限制文件且启用网络。具体有效配置来源未定位，选择权限的回包只确认下一次普通请求，不能证明立即更改当前工作。XLSX第二次实际请求仍workspace-write/network=false，但reviewer由auto_review变为user，期间设置经历disabled→managed；因此不能写“所有权限未变”。已补共用权限作用时点说明及受控命令保护：回包只确认“下次消息的选择”，当前完整权限保持未知；对已核会绕过普通下发的review/compact/工作型goal在发送前拒绝，保留暂停队列、附件及来源，配置完成不自动重发。完整App的Chromium和WebKit各32项通过，原夹具、开发服务重载及按钮名称定位失败保留；尚非正式应用或真实命令验证。另已修复保存期间收到模型/权限更新仍误发送及首发拒绝后继续待发绕过确认的竞态：成功保存后先固定原配置，再处理通知和核查；5项受控反例/对照及37项发送回归通过，1项真实Agent测试仍忽略。原两轮真红保留，不把受控协议成功写为实机或完整权限恢复。本片完整权限恢复尚缺同一官方连接的可用读写接口；不伪造接口、修改官方程序或另起Agent循环。新的真实请求暂不继续；完整P08、122项原条件、29家八项标准和Windows仍开放。

PDF 的[源码及受控分项](evidence/2026-10-09-capability-hardening/pdf-input/implementation.json)已通过完整字节捕获6项、解析相关11文件85项；完整App真实解析工作线程在原源码各71项，新MIME及URI增量各74项实际退出0，分属两次稳定源码范围。新增NEW-25保留格式声明变体、无后缀重读、旧回调误勾和不同URI沿用范围的原失败：当前源码已补保护，原独立MIME四项窄复验及同路径编码对照通过。明确范围前不读取，全文始终部分读取；损坏、加密、超限或无正文不生成已批准前缀。当时仅覆盖受控文件接口与Agent接纳；后续36c的正常`@`入口已补正式读取、真实冷恢复及有限数据核对，严格比较仍为exit 2，真实Agent接收未验；本片七项工程、实际打包工作线程和正式安装分别留证，检查结果以本片新回执为准；原92aa检查不复用作新片达标。

[此前 92aa 七项工程检查](evidence/2026-10-09-capability-hardening/xlsx-input-checks/verification.json)在1,642个稳定输入上全部实际通过：前端463文件/5,421项，Rust1,617项/6忽略；受控Chromium与WebKit完整App各122项、42个真实Worker。原首轮5项超时与当时未开始打包的失败保留，原因未定位；顺序执行通过不证明根因。上述工程及正式分项只对应92aa范围，后续 PDF 整合与 e599 安装结果见本节首段，不据此关闭全计划。

此前DOCX正式版本 `b862b79d` 的[旧分项收口](evidence/2026-10-09-capability-hardening/docx-input-candidate/installed-native-final.json)继续保留当时25,744字节输入、31×7表格及1290字符末格、正文和附注的两次无工具请求证据；旧133条会话与当时数据比较不作为本轮134条新基线。旧首问歧义、备份侧文件失败、比较退出2及具体更新时间写入者未知仍保持。

此前来源与选择器阶段的正式应用为 `3bcd43dc` / 0.1.7 arm64，[本片正式复验](evidence/2026-10-09-capability-hardening/claude-history-origin-fix-candidate/installed-native-followup.json)已完成：候选9/9、安装10/10，三份新的217,400条数据清单一致。共用界面仅选同一条已登记Claude历史，三次官方读取按已知标记→不存在标记→已知标记返回部分覆盖的1页/2段文字，匹配1→0→1；两次纯文字预览与从第二次正向结果打开的原对话用户文字一致。占位和选中Claude名称在正式截图可见，鼠标菜单及Space/Up/Down/Return保持正确选择。NEW-18/19仅此本机、本片官方human文字路径复验；原空白原因未唯一定位，其他主题与历史未测。原对话只见用户历史，回复、当前分支和上下文续接未证；没有经界面发送prompt或批准权限/配置，P32整体及29家八项标准仍未完成。

3bcd本轮已正常保存退出，退出回执与随后正式进程不存在分别留证，不据退出警告推断全部外部工作完成或停止。133条完整会话、170条屏蔽、53项设置原值、整个未发8/8/3及活动、工作树清单、schema保持，0新增；唯一Claude更新时间变化经root窄逐值接受，其他列保持，具体写入者未证。重复打包应用已精确移除，唯一正式应用和候选ZIP保持；私有数据只保留本地证据、摘要和哈希。

P08 DOCX显式文字输入已完成本片源码：从完整已读取结构生成正文、完整表格及附注文字，保留附注标记的来源；部分读取须单独同意，图片仅说明省略及原有文字说明，不冒称图片内容已读取。审阅、确认和发送按原文件版本、完整内容哈希及文字哈希核验；取消、换目标与迟到结果不替换原输入。共用草稿、待发队列、编辑重发及从消息新建保留已确认文字和已知来源，官方历史缺少来源时保留文字并要求重新读取确认；冷恢复重新读取及审阅后才可发送。实际发送连接同时提供能力声明与发送柄，能力未知或不支持时拒绝，保留原忙碌、权限、模型及期限检查；正式消息只列官方字段，本地来源、版本与同意信息不交给Agent。

[本片工程检查](evidence/2026-10-09-capability-hardening/docx-input-checks/verification.json)对应1,605个稳定输入：run-02四项前端实际退出0（451文件/5,265项）；三项后端在run-01实际退出0（Rust1,617项/6忽略），因唯一变化是旧浅树测试的附件组件定位、其余1,604输入及后端/配置/夹具/协议均未变，run-02明确复用。run-01前端实际退出1及当时打包未执行保持原记录，不改写为首轮全过。

独立静态复核检查27个文件、10处边界，未确认阻断问题；[完整App及真实Worker受控验证](evidence/2026-10-09-capability-hardening/docx-input/independent/summary.json)在WebKit与Chromium各81项实际退出0，生产输入稳定，无页面错误或外部请求。原会话夹具、发送按钮定位及普通WebKit Tab失败保留，受控Option+Tab/Chromium Tab与正式窗口当前普通Tab的结果各按实际环境记证，不推断未读取的系统偏好。b862正式DOCX初轮另见本节当前段落，冷恢复采用原有明确“保留所选附件”后完整重读核对；不要求另开第二个完整文字弹窗。当时的工程和受控成功只对应b862范围；后续92aa正式分项及正在开发的PDF增量见当前段落。P08整项、其他输入格式、全部122项原条件、29家八项标准及Windows仍未关闭。

P16已有新的只读expected-host身份候选研究，但方案未选择、未执行，隔离及文档预览仍未验证；原P16及全部剩余完成条件保持。

## 所选未加载历史的临时检索（2026-10-13 首片与刷新修复）

`HistorySearchPanel/Results`接入共用对话库的搜索范围；`history_search_controller/types`保持准确请求、短期读取确认及界面归属，按实际范围和终态呈现。最多明确选择同Agent的20条已有索引；点击检查只核入口和来源，点击开始才启动读取。`acp_client/history_search`从现有元数据取得目录和真实历史标识，首条已核官方方式使用固定只读metadata与完整分页接口，无resume、prompt或配置修改。Agent差异仅在接入层，界面按能力显示。

请求与两任务预算、账号操作范围、退出/维护许可随真实工作保留到子进程/进程组/管道结束。当前行命中文字先临时保留，真实清理、目录与来源再次核实后才同锁公开；取消、来源变化、已加载同Agent或准确入口别名的对话均保留准确状态。只检索官方返回的用户消息与回复文字，结果保存于内存、单独查看文字快照，打开原对话继续现有保护路径；不伪造已有消息定位，不读取附件/工具/思考，不建持久搜索或正文账本。

共享 `session_index_refresh` 在每次索引读取返回后比较当前记录的全部JSON字段，仅复用完全相等的当前对象；来源或字段变化、删除再出现和A→B→A仍产生新对象，不保留旧行历史。它修复一分钟正常刷新误撤回搜索结果的问题，Panel/controller的准确请求、已加载排除及真正变化撤权规则保持。

[本片证据](evidence/2026-10-09-capability-hardening/history-search/implementation.json)分别列定向、实际Rust回执互通、受控完整App、工程及独立复核。66a2bbfc正式首查返回正确用户文字后刷新丢结果，原失败列NEW-17并保留。[500a0570已复验同一历史预览](evidence/2026-10-09-capability-hardening/history-search-refresh-candidate/installed-refresh-native.json)自然等待148,478毫秒仍保留，范围/无匹配/再次命中及单独打开原对话准确；本轮正常退出后数据独立核对完成，仅Codex更新时间变化经逐值接受。其他Agent、附件内容与Windows继续保留原条件。

## 所选附件归档与工具正文导出（2026-10-12 已安装分项验证）

`ConversationExportHost`统一工作对话和对话列表入口，打开时冻结已加载内容；`conversation_export`默认Markdown，明确勾选才加入安全文本围栏中的工具文字、差异两侧和终端输出。`conversation_archive_snapshot/selection/input`负责声明附件候选、用户选择和规范输入，`conversation_archive_jobs/parse`跟踪准备、启动、取消及准确状态，`ConversationArchiveJobsStatus`接入共用文件保存活动和退出保护。

后端`file_archive`与`file_copy_jobs/archive`复用实际保存任务槽位和退出许可，五个严格主窗口命令以操作编号和输入摘要匹配。`file_delivery/archive_stream`流式生成正文、清单及选中附件，锚定实际文件和父目录、排他发布并读回核对；单项来源失败不静默省略，清理或发布不确定保留未知。生成的编号成员仅保留有限常见后缀提示，不证明内容格式；清单不自动带本机来源路径，正文内用户已有文字保持且有隐私说明。无历史自动读取、远程抓取、持久正文账本或新Agent循环。

[源码/后端/界面/独立与工程证据](evidence/2026-10-09-capability-hardening/attachment-archive/implementation.json)分别记录：实际Rust输入/状态6/14组、定向后端37项、前端249项、完整App两引擎各23项；全量前端5,071项、Rust1,578项/6忽略，格式为精确保留历史回执后复查。`a5a24810`已安装并完成[原生选择器到实际ZIP分项](evidence/2026-10-09-capability-hardening/attachment-archive-candidate/installed-archive-native.json)，两项附件和替代文件、清单及字节核对、取消选择器与失效源文件保护已有证据。写入中原生取消、未知清理、其他Agent及Windows仍需各自实证。

## HTTP MCP添加（2026-10-12 正式分项验证）

沿用`mcp_add`的检查、确认、状态、取消与只读核对流程，HTTP能力独立声明。旧本地程序输入保持原结构，HTTP输入严格区分并保留完整地址；语法检查不规范化原值，不主动访问地址。公开回执仅保留安全标识，地址限定在当次表单/审阅和有期限的私有操作中；撤回不使仍在执行的工作丢失追踪。自身写入使清单过期时仅撤回旧审阅，主动关闭仍精确取消。官方接口只写一个默认停用条目，两范围完整配置和精确传输报告都匹配才能确认；只读观察不升级此前未知写入。见[源码和受控证据](evidence/2026-10-09-capability-hardening/mcp-http-add/implementation.json)。`8cfb2ccb`已安装并完成[正式分项验证](evidence/2026-10-09-capability-hardening/mcp-http-add-candidate/installed-mcp-http-add.json)：原样地址、撤回、单次添加、只读核对、同名拒绝及原配置语义恢复；专用端点观测期0次连接只证明该端点范围。七项工程及候选9/9、安装10/10通过，有限实测数据差异明确限页签位置和更新时间。已有启动环境测试偶发超时仅增强诊断，后续全量通过但原因未定位；连接、认证、诊断与其他Agent保持未完成。

## MCP精确移除（2026-10-11 已安装分项验证）

`skill_management/mcp_remove` 与 `mcp_remove_plan` 复用共用请求、审阅、实际进程清理和两任务限额，增加独立移除类别；旧启停布尔值及添加协议保持。只接受原完整清单中已有、明确停用、来源无歧义的条目，经官方配置接口写准确的带引号键路径及空值，不清空父容器。全量配置在两种目录范围中匹配同一准确候选，完整配置报告确认名称缺失后，才随实际清理完成一并发布结果。共用界面将移除、停用和只读核对区分，并保留原请求事实。

[源码与受控证据](evidence/2026-10-09-capability-hardening/mcp-remove/implementation.json)包括七项工程全过、双浏览器各31项和独立复核。本片已提交安装 `8fa557c0`，完成[正式分项验证](evidence/2026-10-09-capability-hardening/mcp-remove-candidate/installed-mcp-remove.json)和[独立收口](evidence/2026-10-09-capability-hardening/mcp-remove-candidate/native-independent.json)：停用的本地条目审阅撤回、重新确认移除、独立核对及新清单缺失均已实测，父容器保留其他条目，原完整配置语义恢复且用户数据保持。此覆盖不包括HTTP、空父容器或其他来源/Agent；不据配置缺失推断连接已断开、工具已停止或凭据已清除。

## 本地MCP添加（2026-10-11 已安装分项验证）

`McpAddForm`与共用`SkillChangeReview`由官方能力驱动，输入变更产生新身份并撤销旧审阅；程序路径和每个参数按准确字符串展示，空参数与字面文字可区分。输入只存本次界面及操作内存，不进入Farfold设置或诊断；确认后由官方程序保存，不承诺任意输入不含凭据。名称、路径、参数数量与字节数有明确边界，前后端共用固定控制/格式字符范围。

`skill_management/mcp_add*`沿用有限操作登记、两项并发、活动/账号/配置保护与实际进程清理。添加、已有MCP启停和技能使用三个独立操作类型；审阅、状态、取消及提前取消不能跨类型消费。完整清单即使没有可管理条目仍保留准确名称，审阅与确认重新核查同名和所有配置层，经`config/value/write`只新增一个`enabled:false`的stdio条目；不执行填写的程序。两范围配置回读和固定单项报告分别核对，程序、参数或未知传输字段不匹配不能因同为停用而报成功。只读核对保留此前写入回执及未知结论，不追认历史成功。官方版本检查不是跨进程事务保证；连接、工具、认证和其他Agent未由该片证明。 七项工程检查通过（1,480输入稳定，前端4,774项、Rust1,531项/6忽略）；实际Rust回执与前端解析互通、受控双浏览器各23项通过，独立窄审无剩余阻断。本片已提交安装51c5159f；正式窗口完成精确参数审阅、撤回、默认停用添加、只读复核、同名拒绝及官方完整配置层语义恢复。候选9/9、安装10/10，安装前后三份217,400条快照相同；正常退出后131条会话、168条屏蔽、53项设置原值、整个未发8/8/3与工作树清单保持，仅Codex更新时间变化。执行标记未触发不代表MCP连接/工具可用；没有界面消息不等于没有官方会话准备。后续精确移除仍经官方接口且保持原P41条件，见[当前状态](status.md)。

## MCP启用偏好（2026-10-11 已安装分项验证）

`extension_inventory/mcp_targets.rs`只在内存保留同次官方清单的准确目标，公共回执不含命令、环境、地址或请求头。`skill_management/domain.rs`复用技能操作的有限状态、并发限额、过期和进程清理，技能与MCP的操作和审阅身份不能串用；`mcp_plan.rs`核对两种目录范围下的最高用户配置层，经官方接口只改已有完整条目的enabled字段。写入后完整层语义和单项报告重新核对，不确定结果只允许另行只读观察，不自动重发。

共用`SkillChangeReview`由能力与目标类型驱动；MCP明确提供启用和停用两种审阅动作，不根据报告替用户决定意图。配置报告与实际连接/工具使用分开；不建立第二个Agent循环、持久操作账本或Agent专属面板。已提交安装26a55a7b，完成受控界面、报文互通和专用条目的正式启停、审阅撤回、只读核对及官方配置恢复；实际连接/工具可用及完整添加/诊断仍未完成，证据见[当前状态](status.md)。

## 技能启用偏好（2026-10-11 已安装分项验证）

`acp_client/skill_management/` 提供五个有限操作：审阅、确认、状态、取消和只读核对。目标来自同次官方技能清单保留的私有映射，不接受前端任意配置路径或值。审阅保留准确程序选择、目录、用户或所选方案配置层及完整规则；确认消耗短期票据，重新核查后经官方配置接口修改。未知字段与顺序按官方JSON语义保留，不声明保留配置文件注释和排版。官方版本字段也不是跨进程原子锁。

查询与修改共用并发限额；实际进程、子进程组和管道结束前持续持有活动、账号及配置保护。关闭、取消和到期撤销原审阅权限，写入后的不确定结果不自动重发；迟到回读只证明当前观察值。审阅只在操作结束时原子公开，迟到清理不改写已确定终态。`SkillChangeReview` 接入已有Agent详情，共用界面由能力和具体条目的可管理性驱动，不按Agent名称分叉。配置保存、技能报告及当前对话适用性分别呈现。本片已提交安装`4d3bd81e`，七项工程、独立复核及专用项目技能的正式启停/审阅撤回/官方配置恢复分项已测，见[当前状态](status.md)。NEW-16的共用提示已由f381e63b修正：读取票据失效与归属变化均有准确说明，显式重查不自动派发后续查询；40项关联测试通过；26a55a7b在正式MCP清单的自然过期许可上复验准确提示及两步显式恢复，原技能过期场景未重测。当前对话采用、P40全项和其他Agent继续未完成。

## 完成提醒与附件媒体（2026-10-10 源码增量）

`success_notification.ts` 仅跟踪当前实际发送在内存中的完成候选；结合官方结束事件、实际呈现终态及工具、批准、提问、后台工作，满足条件才向共用通知服务提出完成提醒。`desktop_notifications.ts` 维护独立完成偏好与需要回应偏好，沿用共用声音、前后台判断及点击定位；历史回放、未知或失败不生成完成提醒。它不保存Agent消息或重建事件账本。

`desktop_notifications/tickets.rs` 复用现有渲染进程随机标记与请求序号，管理有界且不持久化的待派发票据；批准或提问失效、对话关闭及归属变化可精确撤回。后端在异步系统检查后及平台调用前重核偏好和票据；只有实际平台调用开始才越过撤回边界。已经开始调用不证明系统接收、显示或声音；未知结果不自动重发。

`MessageAttachmentMedia` 在已有媒体准入及用户明确展开之后处理图片/音频解码失败，重试只使用相同已准入内容。收起或换内容时清理自己的播放器；严格模式重新挂载只恢复原已准入来源。正式内容策略只增加本地与内嵌数据媒体来源，远程媒体仍被限制；搜索临时展开不获得媒体授权。工程、受控浏览器、正式应用及真实Agent证据分别见当前状态。

此前正式 `6c37a012` 分项核到系统接受后台完成提醒及关闭偏好时不提交；接受回执不代表实际显示或点击。原设置、旧对话和未发送内容保留，媒体与过时提醒撤回仍只有受控证据；详见[正式验证边界](evidence/2026-10-09-capability-hardening/notification-media-candidate/installed-notification-media.json)。

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

DOCX显式文字输入复用现有版本化捕获和Worker解析：`document_input.ts`承担读取、确认、完整版本与哈希核验；`docx_input_text.ts`遍历完整已读取AST，不从视觉窗口或截断摘要拼输入；`document_input_types.ts`闭合校验确认状态、限额和来源。`noteReference`仅标识真实附注位置，作者写出的`[1]`仍为正文；表格、嵌套单元格和已读取故事均保留结构与范围说明。已知来源文字总量含结构说明受256 KiB限制，超限整体拒绝；无来源历史文字保留受既有32 MiB未发总量约束，不能据此取得发送资格。

`DocumentComposerAttachments`与`DocumentInputReview`只实现共用审阅，`document_input_draft.ts`核原草稿、附件和确认归属；草稿/队列/消息流程保存本地来源，`prompt_blocks.ts`输出官方字段白名单。官方回传不信任输入中的本地来源，已知本地投影仅在严格相等的官方消息对应时保留；缺来源的DOCX文字为`local:null`，不得退回链接发送。`acp_client/session.rs`从同一次取得的实际连接同时核`embeddedContext`并取控制柄，保持现有发送保护；未创建新的Agent执行循环或历史正文账本。

## 2026-10-04 桌面界面与读取确认增量

`desktop-workbench.css` 对现有工作台施加统一样式，App/ThreadView 控制同一内容栏的文件/网页模式；模型、推理、权限与发送仍由原组件和真实能力驱动。`ArtifactPane` 保持 BrowserWorkspace 挂载，`visible` 与路由 `active` 分离：收起调用 `browser_workspace_set_visible` 隐藏实际 WK，打开/恢复在途先保留占位，收到 hide/close 回执才释放；原路由关闭协调器继续处理退出与覆盖浮层。`onStateChange` 只交付地址、状态与页面修订，输入区网页提示不会改写 prompt。Markdown 列表、窄窗和暗色以实际组件合成渲染检查。

`browser_sharing/permission.rs` 在原连接内存中保存带 nonce 的待确认范围，经 `browser-sharing:changed` 发送 taskKey。`browser_share_respond` 重新核实目标、页面及请求身份；批准继续原 MCP id，拒绝、120 秒超时、标准取消、导航、关闭或断连结束原等待。批准前只读页面元数据，最终输出仍使用原停止屏障。前端 `browser_sharing.ts` 先监听再查询，过滤迟到操作；revision 属于工具连接，最新权威查询允许重连后归零，操作回执仍受顺序检查。`BrowserReadRequest` 放在原待回应区，`BrowserShareControls` 供现有内容栏共享状态及撤回；两者没有另发消息或正文持久化。

以下为当前模块职责与数据边界，已发生的安装与分项结果见 [status.md](status.md)，不以本文替代验收。客户端文件/终端能力（`fs_ops.rs`、`terminal_ops.rs`）已删除。产品要求见 [PRODUCT.md](../PRODUCT.md)。

## 全产品工作台

`App` 统一装配新对话、对话库、对话内容、Agent 发现与设置五类视图。`Sidebar` 提供新对话、全部对话、收藏、探索 Agent、按 Agent 查看及用户分组；状态筛选和搜索由 `ConversationLibrary` 处理。这些入口只改变浏览范围，不改变已有对话的 Agent、模型或工作目录。对话库复用现有索引和内存状态，支持标题/文件夹搜索、Agent/分组/状态筛选、收藏、重命名、批量归档与分组整理；对话顶栏查找只检索当前已加载内容，没有新增跨历史正文搜索库。

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
