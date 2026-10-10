# 能力补强：2026-10-09

目标与完整条目仍见[唯一活动计划](../../../plans/agent-access.md)。本目录保存本轮代码、受控验证和官方接口核查，不代表全部能力已在安装版通过或 29 家真实接入已通过。

## 当前衔接：PDF/图片区域源码已验证，接续正式安装

PDF/图片区域意见及NEW-04恢复预览修复已完成[最终工程整合](visual-area-checks-complete/final-verification.json)：1,201输入稳定，前端331文件/3,977项及类型、打包、全仓格式通过；本轮Rust1,230项/6忽略按精确未变输入复用。[独立完整界面](visual-area/independent/implementation.json)双引擎各147项几何、30项生命周期、16项恢复预览通过，独立渲染各38项单列。实际PDF测宽1像素缺陷及修复、父层重入反例、驱动错误均保留。当前准备提交和候选；正式应用仍为下述2e976168，区域意见尚未安装，NEW-04不冒称正式故障恢复入口已验。

当前正式应用为 `2e976168` / 0.1.7 arm64，[XLSX矩形与阅读位置实机](workbook-range-candidate/installed-workbook-range.json)完成分项验证及冷恢复，NEW-03具体缺陷复验通过；最终正常退出。原未发送内容保持，1条可选sendPending缺省规范为false单列，旧原始失败保留。候选9/9、安装10/10与三份217,400条快照一致；[独立收口](workbook-range-candidate/native-closeout-independent.json)未冒称独立界面重演。当前接续PDF/图片区域及恢复预览修复；[维护衔接记录](workbook-range/checkpoint.json)已收齐本片提交、安装、分项实机和下一步，下文按阶段保留当时状态。

本片 XLSX 任意矩形与 DOCX 内层阅读位置修复已完成源码及受控检查，见[工程汇总](workbook-range-checks-final/final-verification.json)、[阅读位置修复](docx-reading-position-repair/implementation.json)、[表格完整界面](workbook-range/independent/implementation.json)、[解析兼容修复与独立Worker](workbook-range/content-types/implementation.json)。前端323文件/3,811项及类型、打包、全仓格式通过，1,171输入稳定；Rust按未变输入复用。完整App两浏览器各74断言、Worker各404、DOCX常规与窄窗共208断言分层记录。独立写出器原样本拒绝的实际失败及修复保留，原ZIP未改。正式安装及实机结果见首段；第二工作表实际可见，旧记录误称隐藏的[范围纠正](workbook-range/independent/hidden-sheet-scope-correction.json)单列，隐藏行列确有覆盖。PDF/图片区域、P22真实返工及全域其余条目继续开放。

此前XLSX单元格意见阶段的正式应用为 `4952c692` / 0.1.7 arm64，唯一 `/Applications/Farfold.app`，已完成[表格位置分项实机验证](workbook-feedback-candidate/installed-workbook-feedback.json)并正常退出；原4条输入、2组意见、3组待发逐值保留。此前e98的[正式窗口复验](text-selection-keyboard-candidate/installed-keyboard-scroll.json)已确认文字选段Enter和局部滚动修复，原4条输入、2组意见、3组待发逐值保留。XLSX单元格/合并范围意见的源码与受控浏览器检查已完成。此前 `cd66aae7` 的[实机初轮](text-feedback-candidate/installed-text-feedback-initial.json)所发现失败保持原记录。前一版本 `e8d76d4c` 的[修复复验](inspection-limit-candidate/installed-inspection-limit.json)确认大小限制提示、无效编码独立提示及16 MiB首段读取正常。候选独立核验9/9、安装10/10，三份217,400条数据一致；正常退出后原7项未发内容保持，无新Agent请求或权限变更。重复应用产物已精确移除。原[初轮失败](large-file-candidate/installed-large-file-initial.json)保留。前一P20版本 `fa235998` 的[候选独立核验](file-refresh-candidate/candidate-independent.json)9/9、[安装独立核验](file-refresh-candidate/install-independent.json)通过，三份217,400条数据一致，重复应用产物已精确移除。[正式刷新实测](file-refresh-candidate/installed-file-refresh.json)确认DOCX段落、XLSX行范围和PDF页跨版本保持或回到有效位置；损坏与移走文件保留旧快照并明确提示，编辑中的PDF意见与版本保持一致。正常退出后原3条输入、1组意见、3组待发逐值保留，测试副本均恢复；没有新Agent请求或权限变更。

P20 [七项工程检查](file-refresh-checks/final-verification.json)通过：1,073个输入稳定，前端3,183项、Rust1,195项/5项忽略。子预览受控浏览器23项、[父层实际浏览器](file-preview-refresh/parent-browser-independent.json)28项通过；后者为实际组件/Office解析器与模拟Tauri接口，不代替上述正式WebKit证据。隐藏、迟到读取和旧状态覆盖新预览的有效反例已修正。其他格式、真实Agent改写、Windows和全量122项/29家八项标准保持各自证据边界。

P17大文件流式核验、分块查看、可取消完整另存、退出/重启/清数据保护及超限位置退路已完成源码与[独立复核](large-file-segments/independent-review.json)。实际浏览器最终33项通过，原pending和隐藏/取消后重复读取反例已修复；[七项工程整合](large-file-checks-final/final-verification.json)通过（1,104输入稳定，前端3,251项、Rust1,230项/6项忽略；其中新增256MiB性能项已单独执行）。首轮仅证据JSON格式失败，保留原始记录并规范后单独复验全仓格式。P17已提交安装 `f71a3434`；[安装独立核验](large-file-candidate/install-independent.json)10项通过，三份217,400条数据一致。[实机初轮](large-file-candidate/installed-large-file-initial.json)确认16/256 MiB分段、完整另存SHA一致、全局保存入口及无效UTF-8尾部拒绝；257 MiB被拦下且Finder定位成功，但初始错误未说明限额，真实inspect字符串分类已最小修复；[工程复核](inspection-limit-checks-final/final-verification.json)前端3,258项通过，Rust源与夹具未变按输入复用；[独立浏览器](large-file-inspection-limit/independent/review.json)38过2失败转40项通过。一次取消尝试的结果实际已保存，不计取消成功。仅新增一次沿用设置的无工具链接回显；正常退出后原7项未发内容一致。其后 `e8d76d4c` 修复安装及受影响路径实机复验已完成，见首段；接续P21文字选段意见，其他格式位置与P22仍开放。PPTX与工作树设计研究仍有未关闭条件。此前[af66实机图片失败](eighth-candidate/installed-docx-first.json)和[6c36图片修复成功](docx-image-fix-candidate/installed-docx-images.json)保留，均为当时范围。

P21文字选段意见源码及整合已补：[runtime记录](text-feedback/runtime/implementation.json)、[组件记录](text-feedback/component-implementation.json)、[父层接线](text-feedback/parent-checks/implementation.json)分别保留改动、原始反例与测试层级。UTF-8/BOM/CRLF/重复文字/跨片行位置、明确选段、旧版草稿保留和只加入原输入框由各层核验；[整合检查](text-feedback-checks-final/final-verification.json)前端302文件/3,345项、类型/打包/格式通过，1,116输入稳定，未变Rust按输入复用。[独立实际浏览器](text-feedback/independent/receipt.json)61项已通过，鼠标拖选继承样式缺陷经[最小修复](text-feedback/component-pointer-fix.json)关闭。只有CSS变化，前端/类型及Rust按精确输入复用，打包已重跑；本片已提交安装 `cd66aae7`，候选独立9/9、三份217,400条数据相等；[实机初轮](text-feedback-candidate/installed-text-feedback-initial.json)确认实际拖选字节、当前片段、冷恢复及同路径换版的旧意见保留，原7项未发内容逐值保持；发现行号输入Enter未保留选区，点击选择按钮及随后Enter确认正常；后续e98修复与正式复验见本页末段。其他格式位置和P22仍开放。

2026-10-10 图片修复衔接：[同源WebKit反例与修复](docx-image-csp/receipt.json)及[独立复核](docx-image-csp/independent-review.json)已完成，生产配置仅在图片源增加本地blob，其他来源和指令保持。该轮修复前正式应用为af66f006，图片失败保留；其后6c36安装及分项成功见首段。修复首轮[全仓检查](docx-image-fix-checks/receipt.json)1,059输入未变，前端280文件/3,123项及类型/打包/Rust静态检查通过；Rust1,177通过、1项协议分类测试失败、5项忽略，当时另有并行PPTX研究文件排版问题。其后[真实配置锁反例与夹具修正](protocol-error-timing/receipt.json)保留原错误分类断言，并使派发前等待与响应超时分别有界；原失败具体调度未捕获。[最终整合](docx-image-fix-checks-final/final-verification.json)已七项通过，前端3,123项、Rust1,179项/5项忽略，1,059输入匹配。只有Rust测试文件在首轮后变化，因此前端/类型/打包复用字节相同输入的成功记录，最终重跑全仓格式及Rust检查。修复安装的私有退出记录、元数据恢复副本和217,400条新基线已完成；之后候选、安装及实机结果见首段。

第七片完成目录读取修复及[独立复核](directory-search-independent.json)、[PDF/图片版本意见](visual-feedback/receipt.json)和受限XLSX只读预览。PDF/图片关联179项、开发与打包Chromium各20项、坏PDF/取消5项通过，[独立复核](visual-feedback/independent-review.json)保留范围；修正PDF解析器动态加载竞态，同文件从15秒超时到成功绘制。XLSX[底层48项](xlsx-core.json)、界面关联63项、[真实Chromium38项](xlsx/independent-review.json)及[独立源码复核](xlsx/source-independent-review.json)通过。另修复第六片实机发现的查找说明样式、关闭焦点和导出隐私文案，已在第七片正式WebKit分项复验。

2026-10-10 接续：第八片首轮七项检查输入未变，格式、类型、打包及两项Rust静态检查通过；前端两项失败、Rust一项失败已保留在[eighth-checks](eighth-checks/receipt.json)。恢复时未知询问被吞与停止未知态负向答复被误挡分别修复；Rust旧夹具错误响应假设已修，生产后端未改。三项修正均已定向复验及独立复核；第二轮前端279文件/3,121项、Rust1,178项/5项忽略通过，1,058个输入稳定。第二轮仅格式检查发现首轮新生成回执排版不合规；两轮原始JSON字节另存receipt.raw.txt，规范后的JSON语义保持，单独复验全仓格式。最终证据汇总见[整合回执](eighth-checks-final/final-verification.json)。DOCX的[实现](docx/implementation.json)及[独立复核](docx-independent-review/receipt.json)、外部确认的[实现与两轮独立复核](nonform-interaction.json)均有分项成功证据，安装后的成功与图片失败另见首节，不把分项工程成功当实机全通过。

第八片DOCX分项记录：[后端独立复核](docx-backend-independent.json)核对版本化捕获、ZIP边界与原XLSX行为；[界面实现记录](docx-ui-implementation.json)保留入口失败/修复、负缩进裁切及重复图片资源反例。普通文档来自[独立写出器](docx-compatibility/receipt.json)，另用公开许可样本检查兼容性；浏览器成功不等于正式应用验证。外部确认已补会话打开期间、取消、迟到完成及未知请求归属；本片已提交安装并完成第一轮分项实测；当时正式应用正常关闭；随后图片修复及分项复验见首段。

[最终工程整合](seventh-checks-final/final-verification.json)覆盖962个最终输入，七项检查通过：前端267文件/2,983项，Rust1,153项/5项忽略。首轮管道关闭测试失败、3处Rust导入排序和4份冻结JSON排版问题保留原始记录；只精确排除原始JSON，不改写证据。原失败实际干扰进程未捕获，受控fork反例说明即时管道断言需要进程隔离，原六处故障注入及即时断言未削弱。独立复核再发现测试输出可能无限等待EOF，已改为匿名文件和有界读取，新增反例及7项定向通过，见[修复](stdio-output-capture.json)和[保留旧问题并追加关闭结果的复核](stdio-preparation-independent.json)。最后仅该Rust测试文件变化，因此重跑全部Rust检查和全仓格式，前端/类型/打包引用字节相同输入的完整检查，不混称同一轮执行。

第六片[正式实机](sixth-candidate/installed-search-export.json)已完成受控查找与真实导出，退出后原7项未发内容逐值一致。当前仍不关闭桌面文件夹许可等待、完整Office、区域标注或其他未覆盖条目，也未扩大Agent权限。

[检索](transcript-search/receipt.json)在原显示树纳入折叠文字、工具详情、长差异、计划、整理摘要与已接收附件文字；只临时展开当前命中，关闭后恢复并保留明确的手动选择。查找不读取外部文件、解码隐藏媒体或创建持久正文索引。29文件203项、生产样式/StrictMode受控Chrome31项通过；16万命中曾触发参数数量上限，改为逐项高亮后通过，实测成本和平台限制保留。右侧内容栏独立于检索范围。

[导出](conversation-export-review.json)保留已加载正文空白、仅媒体消息的附件来源、真实工具状态和流式片段标记，完整说明排除范围及本地路径风险；失败或取消不保留旧成功提示。元数据采用文本转义，实际渲染发现的首字符标题、列表、分隔线与代码围栏反例已补修；正文仍保留Markdown。最终关联72项、类型和格式检查通过；[独立实际渲染](conversation-export-independent.json)12项通过，无未关闭阻断。附件实体打包和完整迁移归档仍未完成。

以上检索/导出为第六片历史证据，最新进展见本页开头；定向测试不替代正式WebKit或真实Agent验收。

第六片[首次全仓](sixth-checks/receipt.json)932个输入未变，6项通过；前端2,886项通过、1项旧SSR测试失败。旧夹具强制所有React useState为true，但展开状态已由独立内存模型管理；修正只让该测试指定真实模型的初始状态，原命令/目录断言保留且增加展开状态断言，生产源码未改。关联6文件46项通过，原始失败及修复记录见检索回执；其后最终全仓复验已通过，见下段。

第六片[最终工程检查](sixth-checks-final/final-verification.json)已通过：932输入未变，前端260文件/2,887项、Rust1,134项/5项忽略，七项检查全部具备成功结果。末轮格式失败仅首轮生成回执的排版，修正后单独复验全仓格式；原始失败记录不覆盖。随后已依赖闭合提交413226dc并完成正式安装及分项实测，见下段。

第六片已提交 `413226dc` 并更新唯一正式应用；[候选独立核验](sixth-candidate/candidate-independent.json)9项通过，[替换前后](sixth-candidate/installed-data-retention.json)217,400数据条目一致；后续已启动并完成分项实测，再正常退出。一次过早调用安装检查在读取尚未完成的快照摘要时失败，复制未开始、旧应用未变；原失败回执保留，待快照进程成功结束且前后相等后才重新安装。安装独立复核与实机查找/导出已完成；该片之后接续目录读取、PDF/图片意见和Office预览；最新进展见首段，阶段交付不结束计划。

## 第一批：停止竞态与保存保护

源码起点 `847f2487`，提交 `be1364ca`，macOS arm64；测试使用临时数据库、协议模拟进程和前端夹具，未启动真实 Agent、账号、模型或替换正式应用。

- 消息仍在本地准备附件、保存草稿或更新归档状态时，停止会保留并暂停待发内容，不向尚未派发的请求发送取消；明确拒绝准入时清除无意义的停止等待，结果未知则继续保护且不自动重发。
- 取消已经派发后，原请求终态之前迟到的审批及表单会回复取消，不重新要求用户操作；仍接收后续更新，其他对话和下一轮保持独立。
- 草稿中非法的发送标记、附件类型及附加字段整体拒绝读取，保留原记录，不以部分默认值覆盖。数据库中的非法参数、环境和历史配置同样明确报错。
- 模拟 SQLite 容量耗尽后旧未发送快照仍可读取，关闭重开后保持；这是数据库容量限制实验，不是物理磁盘满或完整数据库损坏恢复验证。

覆盖 ARCH-03、ARCH-25–ARCH-28、ARCH-41、ARCH-45、P03、H02、H03 的部分完成条件。**这些条目仍需剩余验证，未整项关闭。** 完整损坏恢复入口、历史外部命令停止残留、连续事件流下取消调度、安装版和逐家真实效果仍待处理。

## 验证与独立复核

- 新增前端 19 项、Rust 5 项。草稿 7 个非法输入、元数据 2 个非法记录测试先失败后通过；SQLite 容量实验在原实现已通过，只补证据，不冒称修复。
- 停止前端 11 项覆盖及红绿摘要见 [frontend-cancellation.json](frontend-cancellation.json)；后端 2 项及红绿摘要见 [backend-cancellation.json](backend-cancellation.json)。这两份是实际工具输出摘要，原始 stdout 未保留；其余 `.txt` 为运行保存的原始输出。
- 全量前端 **220 文件 / 2,542 项通过**，typecheck、build 通过，见 [frontend-checks.json](frontend-checks.json)。
- 首次全量 Rust 出现 7 项回归：严格解析环境变量时错误地改变了原有顺序，见 [首次日志](rust-test.txt)。已改为保留原 JSON Map 顺序并整体校验，复验 **1,045 项通过 / 4 项原忽略**，clippy、fmt 通过，见 [修正后检查](rust-env-fix-checks.json)。失败记录保留。
- 独立复核覆盖前后端停止归属、未知保护、草稿和元数据解析；环境变量回归修正亦复核通过。取消调度的[初期分析](cancel-starvation-analysis.json)当时尚无运行反例；后续有限积压的复现与修正见下节。

七项工程检查均通过；最终散列、条目与既有修改保护检查见 [first-increment-verification.json](first-increment-verification.json)。`inputs.json` 保存首次整合期间的源码散列；后续元数据顺序修正在最终回执单列，不能把最初散列当成全部检查的最终输入。

## 第二批：官方配置协商与确认

沿官方 schema 声明 `clientCapabilities.session.configOptions.boolean: {}`，仅增加已承接的布尔类型，原认证、表单和其他既有能力保持。协议对端夹具以声明为门禁，核对布尔值来回设置、明确拒绝不重试及旧 select 接口兼容；3 项测试由 2 失败变为全通过，既有配置模块 17 项通过。见 [boolean-negotiation.json](boolean-negotiation.json)。

普通设置和受保护设置一样，只有回执包含匹配的类型与所选值才确认成功；字段消失或依赖变化不能冒称所选值已生效，也不据此断言 Agent 已回滚。对话已不存在或等待中被替换时，旧请求明确失败；其清理不会删除同 key 新请求。新增前端 11 项，完整前端 221 文件 / 2,553 项、typecheck、build 通过；有效红测、首次夹具钩子错误及修正后的原始输出均保留，见 [configuration-confirmation.json](configuration-confirmation.json)。

本片补充 ARCH-18、ARCH-20、ARCH-22 的部分条件；不据协议模拟对端推断任何真实 Agent 的设置已生效。

## 第二批：取消调度与控制顺序

通过真实 manager、pump 和标准输入输出连接受控对端，使用协议分派屏障证明：运行中已排取消时，原实现仍先消费完 32 条更新才派发取消。最终只在运行中检查控制队列的单个队首；队首是取消时及时处理，普通命令仍留在原分支，不越过更早的发送或设置，不改变更新先于原请求终态的顺序。

5 项最终测试通过：有限更新积压、发送→取消、取消→后续明确发送、超时取消、调用者离开；另复验迟到交互 2 项、工具尾程 3 项和恢复 4 项。中间双通道方案虽通过积压用例，却被发送顺序反例否定，已完整撤回；其原始日志仅保留调查经过，不能作为最终方案证明。

限制保持明确：前方已有普通命令时仍按原保护顺序等待；无法抢占同步事件回调；未量测真实长期洪流、超时延迟或外部工具停止。各阶段原始日志与明确结论见 [cancel-starvation.json](cancel-starvation.json)，ARCH-28、ARCH-45、H08 未因此整项关闭。

## 前两批整合基线

前端 **221 文件 / 2,553 项通过**；Rust **1,053 项通过 / 4 项原忽略**；七项工程检查通过，独立复核未见阻断。源码冻结与现存修改保护、精确 29 家名单、全部 122 个原始条目和本轮文档链接检查见 [final-verification.json](final-verification.json)。原始 `.txt` 保留运行输出的空行和尾空格，不为差异检查重写原日志。

## 29 家官方资料基线

[official-capabilities.json](official-capabilities.json)逐项覆盖当前精确 29 家：当日 registry、公开官方/维护者文档、所核源码版本、已有接入、未知和下一步分别记录。取消面 19 项有源码或文档依据，10 项仍缺足够公开依据；没有逐家执行账号、模型、恢复或停止。这里是资料基线，不是 29 家接入完成表。

该表是调查时点快照；其中 boolean 协商的源码缺口已在第二批修正。其他公开接口、来源映射、回放、账号状态及未知点仍按原记录继续处理，不因完成表格关闭缺项。

## 后续衔接

2026-10-09 用户已授权持续开发与必要验证，期间不使用应用。已正常退出正式应用，核到109段对话、0个运行任务、7条未发内容；退出后正式进程计数为0，数据目录逐项哈希与SQLite恢复副本已保留在本机，副本完整性检查为ok。未触及独立存活、归属未确认的旧Cline进程。

第三批增量提交 `af487016`，已完成整合并更新唯一正式应用：

- [上下文、累计token与费用](usage-receipt.json)：共用用量入口，保留真实单位、未知和断连边界；64项关联前端及4项stdio通过，独立复核见[回执](usage-independent-review.json)。
- [消息身份](history-message-identity.json)和[历史读取标记](history-replay-boundary.json)：保留不同消息和附件归属，只用匹配标记前的内容确认历史，后续合法事件仍按实时处理；最终标记回归207项通过。
- [Claude官方来源交付](claude-service-delivery/receipt.json)：声明、设置与回读均在接入确认前完成，45项关联检查通过。[已安装官方0.81.2进程](claude-service-delivery/installed-route.json)向受控HTTP服务请求的地址、路径、模型、测试认证头和结束/进程退出均通过；响应由受控服务生成，不是实际模型服务或安装版UI证明。
- 本机资料读取失败时的恢复壳、结构化错误和副本导出已补；完整恢复导入继续待做。恢复页面静态预览被浏览器URL安全策略阻止，不以SSR或源码检查冒称视觉验收，也不改坏日常数据库来取截图。

冻结源码整合：前端 **229 文件 / 2,606 项通过**，Rust **1,086 项通过 / 4 项原忽略**；typecheck、build、cargo fmt、clippy 通过。首次格式检查及第一次复查分别发现新证据 JSON 格式问题，已修正；所有原始失败输出保留。最终合并结果见 [第三批检查](continuous-checks/final-verification.json)，本机资料导出独立复核见 [记录](storage-independent-review.json)。本次尚不能证明恢复导入、物理磁盘满、真实上下文整理或全部 Agent 标准已通过。

继续整合、更新唯一正式应用并验证具体能力，随后开发下一增量。核查资料、夹具、协议探测、真实进程路由、安装版与实际模型效果分别记录；阶段提交不作为整个计划的停止点。

## 第三批安装与下一批衔接

候选独立核验9/9通过，见[候选回执](candidate/candidate-independent.json)。正式替换前后217,400个数据条目逐字节一致，见[数据保留](candidate/installed-data-retention.json)；重复候选.app已删除，保留压缩包和唯一正式应用。Codex 1.13.1 / gpt-6-astra / ultra 一次真实回复、上下文和累计用量显示、Escape关闭返回焦点均实机通过；冷恢复正文保留、未回报用量显示未知，见[实机记录](candidate/installed-usage-progress.json)。没有确认冷恢复权限或再次发送，不扩称完整恢复继续已验。

OpenCode 1.18.31 两次GUI初始化在60秒超时，未见协议响应；对应进程已正常完成受控清理。相同登记命令和工作目录的独立[握手探测](opencode-initialize.json)成功，GUI与shell环境不宣称相同，原因继续调查。

第三批结束时记录的后续增量：官方上下文整理生命周期已有[定向证据](compaction/receipt.json)；已知消息/工具扩展详情、v1工具补丁语义、启动阶段副本导入继续实现与检查。[设置读取差异](config-read-difference.json)已补确认前的具体对照，旧选择不自动改变；80项关联检查通过、独立复核未见阻断，当时尚未安装；随后已纳入下节第四片，当前状态见本文首段。全部122项和29家八标准保持，以上均不代表全计划完成。

文件拖入已补到共用输入区：仅向当前可见且可编辑的目标添加，拖动中切换草稿、清空、退出或开始发送时不串入；复用既有附件核验且不自动发送，相同文件位置不重复加入。见[源码和定向检查](file-drop.json)，8文件71项通过；一次空草稿夹具错误已纠正，原输出保留。正式桌面拖入、Windows实际操作和跨路径别名去重不在此证明范围。

## 第四片整合与后续

本片覆盖官方上下文整理生命周期及其独立结果、未消费扩展字段详情、v1工具更新null语义、确认设置前的差异、有效资料副本恢复，以及桌面文件拖入。恢复只替换明确选中的草稿/准备记录，先保存当前完整副本，核原值未变后事务恢复；未知回执只核对不重复恢复，重新载入后队列仍暂停。见[恢复证据](storage-restore.json)和[独立复核](storage-restore-file-drop-independent-review.json)。物理坏库整库替换仍未实现，也未在日常数据库上制造损坏。

[冻结整合](fourth-checks-final/final-verification.json)：872个输入，前端242文件/2,719项、Rust1,104项通过（4项既有手动忽略＋1项新增真实初始化诊断默认忽略），七项检查通过。初次三处合并后的格式不一致已修，全部原始失败输出保留；最终复跑覆盖格式修正后的精确源码。本片提交 `63ed89ff` 已更新唯一正式应用，独立候选9/9通过；替换前后217,400个数据条目一致，见[安装回执](fourth-candidate/installed-data-retention.json)。启动后110段对话可见；新增交互分别实测，不以安装成功关闭全项。

OpenCode 第三次GUI重试加入只读观测：448字节请求留在子进程输入管道、无输出，主线程等候文件打开；系统同期记录桌面文件夹授权请求而未观察到结果。独立环境和生产传输均约0.6秒完成初始化，见[诊断](opencode-initialize-diagnosis.json)。尚无可见系统弹窗，未更改许可或要求完全磁盘访问；计划追加NEW-01继续处理。阶段提交后仍继续既定能力建设。

## 第五片衔接

继续推进物理损坏后的整库恢复、P16 图片/PDF内容预览及运行中补充的官方能力核查。Office视觉预览、完整29家标准和其余122项继续保留。运行中补充已找到官方旧版本也声明supported但忽略active-only参数的反例，不能仅凭该声明或品牌名安全启用；不通过版本pin或空请求试探绕过。正式应用63ed89ff重启时对已选择OpenCode自动准备并再次超时，未手动重试、未发送；随后只在空白草稿选择已有Codex进行输入验证。

第四片实机继续：文件选择添加、相同文件去重、移除通过；两次Finder跨窗口拖动的目标投递未确认，保持拖入未验，不归因产品，见[输入记录](fourth-candidate/installed-input-progress.json)。同一受控Codex对话中实际流式回复后停止、明确已停止后继续回复，以及运行中排一条消息→停止后队列暂停保留→明确继续发送→收到指定回复均通过，见[停止与队列实机记录](fourth-candidate/installed-stop-queue.json)。未启动外部工具、未确认新权限；不外推其他Agent、外部命令停止或冷恢复。

共用连接超时提示已改为明确原因未知，先查看待处理的登录或文件夹访问提示，再检查启动设置；31项关联检查通过，见[提示改进](connection-timeout-guidance.json)。这只改善下一步说明，不代表NEW-01已修复，也不要求扩大系统权限。

P09 用户模板已补创建、编辑、保存、删除和加入当前草稿，单份未完成编辑随未发送内容保存；整份旧值比较后写入，保存失败或结果未知均保留修改，明确核对后才继续编辑。关联前端120项、后端6项通过，根侧复核未见剩余阻断，见[模板证据](prompt-templates/receipt.json)。仍待第五片工程整合与安装版操作验证，不将该源码结果记作P09全项完成。整库恢复正在补首次准备失败后的可重试路径；PDF预览正在复核字体、图片超限、警告与工作线程退出，Office预览仍未实现。

第五片定向收口：[整库恢复](storage-database-restore.json)51项Rust、62项前端通过，[独立复核](storage-database-independent-review.json)发现的旧准备记录导致重选入口锁死已修复；原件、副本和旧记录保留，未知阶段不自动移动。[PDF/图片预览](visual-preview.json)99项前端、21项Rust及生产前端打包通过，[独立复核](visual-preview-independent-review.json)未见阻断；真实像素样本包括两页图文与自制Type3中文单字，不覆盖普通嵌入中文字体文档、正式WebKit或Office。

[首次全仓整合](fifth-checks/receipt.json)冻结918个输入且前后未变，当次未通过：前端2,803项通过、17项旧附件测试失败；Rust1,133项通过、1项终端启动标记测试失败、5项忽略；另有一处类型复杂度与一份复核JSON格式问题。类型检查、前端打包、Rust格式通过。失败原始日志保留，后续修复与复验见下；没有用前述定向成功替代全仓结果。

第五片[最终整合](fifth-checks-final/final-verification.json)已通过七项检查：918个受测输入未变，前端252文件/2,820项，Rust1,134项/5项忽略。附件测试仅隔离模板读取，原断言未松动；终端测试改用实际PTY内建就绪回执，仍等3秒，保留原全仓失败原因未定位的界限；类型别名与回执格式已修正。复验原始失败与成功均保留，最后只重验发生变化的回执格式。正式应用已正常退出并保存私有恢复副本：退出前111段对话、7条未发内容、0个运行任务。第五片 `ce9659d1` 随后已安装并启动，三份私有全清单217,400项一致；原库含WAL，先捕获主库/WAL/SHM，再仅在第二私有工作副本执行SQLite备份。正式bundle与ZIP一致，重复.app已移除。见[安装留存](fifth-candidate/installed-data-retention.json)及[独立核验](fifth-candidate/install-independent.json)。模板与预览实际桌面验证进行中，P12当前已加载对话内容检索开始补强。

第五片实机增量：[模板](fifth-candidate/installed-templates.json)创建/编辑/保存/复用、关闭和重启恢复、已有文字及附件保留且不自动发送；[预览](fifth-candidate/installed-visual-preview.json)临时受控副本显示两页图文、Type3中文单字与PNG，密码和损坏文件有反馈。桌面路径在文件读取阶段15秒返回等待提示，系统记录匹配当前正式进程的桌面文件夹授权等待，尚未解决；临时副本成功不关闭NEW-01，也不证明普通中文字体或Office。新增一段自有检查对话，正式侧112段，未扩大Agent或系统权限。接续P12查找折叠内容及P35已加载对话导出保真。

第五片验证后已正常退出，精确正式进程与浏览器助手均为0。通过安装前备份与退出后私有捕获副本只读比较，原3条输入、1组文件反馈、3组待发共7项逐值不变；未将真实请求产生的新对话或用量变化误报为“全数据未变”。当前正式版仍为ce9659d1，P12/P35开发与定向验证进行中。

文字选段实机后的修复：行号Enter焦点交接与大文件预览局部滚动已完成，分别有[独立键盘复核](text-feedback/webkit-enter/independent-review.json)和[完整App原反例及156项检查](text-feedback/native-scroll-review/receipt.json)。[最终整合](text-selection-keyboard-checks-final/final-verification.json)七项要求具备成功证据，前端3,349项、1,116输入保持；最终仅CSS增量，打包和全仓格式重跑，其余相同输入结果复用。该工程检查时正式应用仍为cd66；其后替换与真实WKWebView复验见下段。

2026-10-10 P21键盘/滚动修复闭合：`e98e2a46`已安装唯一正式应用，候选独立9项、安装独立10项通过；[三份217,400条数据](text-selection-keyboard-candidate/installed-data-retention.json)完全一致。[正式窗口复验](text-selection-keyboard-candidate/installed-keyboard-scroll.json)确认小文件结束行、大文件起始行的Enter保留选区、二次明确确认及NEW-02局部滚动，4条输入/2组意见/3组待发逐值不变，正常退出。原失败保留；没有新Agent请求或权限变更。下一片正在实现XLSX位置意见与真实写出器兼容，其他P21/P22范围仍开放。

XLSX位置意见已补源码：实际单元格/完整合并范围与当前文件版本关联，明确确认才更换目标，旧意见保留并只加入原输入框。普通写出器原样ZIP暴露的空inline单元格/公式空缓存兼容问题已修；[父层自动刷新修复](workbook-feedback/refresh-repair/parent-repair.json)区分视图活动与临时交互锁，保留旧网格且不触发自身取消循环。原失败与驱动问题分别保留。[最终工程检查](workbook-feedback-checks-final/final-verification.json)前端308文件/3,484项、类型/打包/全仓格式通过，1,128输入稳定；本次重跑完整前端，未变Rust明确复用。[双浏览器最终12场景286项](workbook-feedback/independent/receipt.json)通过，涵盖普通/隐藏工作表、明确位置确认、跨窗口完整合并、旧版意见保留与自动刷新阶段的旧网格交互锁。已提交 `4952c692` 并替换正式应用，候选独立9/9、安装10/10，三份217,400条数据一致。[正式窗口分项实测](workbook-feedback-candidate/installed-workbook-feedback.json)另核单元格与完整合并范围、非顺序工作表标识、键盘确认、隐藏/换版/重启意见保留及自动刷新可见结果。仅新建一条受限链接回显对话；意见未发送、冷恢复权限未确认，退出后原4条输入、2组意见、3组待发逐值不变。任意矩形、DOCX位置、PDF/图片区域和P22继续未完成；并行DOCX工作树变化未进入此安装版本。[原生收口独立核对](workbook-feedback-candidate/native-closeout-independent.json)另确认正式包、回执链及私有副本数据一致；界面操作证据仍来自本轮原生窗口观察。

## DOCX 段落与表格位置意见

原文件位置链、意见生命周期和共用父层分别见[解析实现](docx-feedback/source/implementation.json)、[位置校验](docx-feedback/runtime/implementation.json)、[界面实现](docx-feedback/ui-implementation.json)和[父层整合](docx-feedback/parent-implementation.json)。重复文字按实际 XML 部件/元素路径区分；只确认当前可见对象，分段/分窗明确对应原完整段落/表格，旧意见不随浏览位置、换版或取消选择改写。加入输入框不自动发送。

[独立受控验证](docx-feedback/independent/receipt.json)保留原样ZIP、独立XML坐标、真实Worker与完整App结果：两个引擎各89项DOCX及15项XLSX自动刷新回归通过；精确隐藏文字另各11项补验不重复计能力。首次整页溢出的两处反例经局部滚动修复通过，冷依赖优化和测试字面量修正分别记录。原96处结构位置不等于96处可见或可提意见对象。[叶层审查](docx-feedback/leaf-independent/review.json)保留取消焦点重入反例与修复，同文件新对象替换单测1/1通过。

[工程整合](docx-feedback-checks/final-verification.json)前端315文件/3,651项及类型/打包/全仓格式通过；1,145输入稳定，Rust与共享夹具字节未变，三项Rust检查明确复用既有成功证据。正式应用仍为4952，本片待候选和实机验证；完整Office、任意表格矩形、PDF/图片区域及P22没有因此关闭。

DOCX已提交安装8c2f5e29，候选9/9、安装10/10及三份217,400条数据核对通过。初轮实机的成功与NEW-03阅读位置失败均保留在[正式回执](docx-feedback-candidate/installed-docx-feedback-initial.json)，不将源码/浏览器通过提升为全项实机通过。原意见/输入内容保留；1条sendPending缺省→false规范化单列，不改写严格逐值检查的失败。接续修复同文件重选与内层阅读位置，并开发XLSX任意矩形。
