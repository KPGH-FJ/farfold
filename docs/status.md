# Farfold 当前状态

更新：2026-10-10。当前阶段为**能力建设与逐项补强**，目标是可面向市场用户、具备一线多 Agent 桌面工作台水准。执行顺序与全部原始条目见[唯一活动计划](../plans/agent-access.md)，产品要求以 [PRODUCT.md](../PRODUCT.md) 为准。

## 当前基线与证据边界

| 层级         | 已有证据                                                                              | 不能据此推出                                             |
| ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 产品源码     | 418880a2归档/恢复与两处提示已实测；安全删除/独立恢复及新发现提示修复在开发            | 所有已列能力已补齐                                       |
| 工程检查     | 418880a2的1,296输入、七项检查通过，前端4,225项、Rust1,321项/6忽略；后续源码未整体验证 | 所有 Agent、系统权限及安装环境通过                       |
| 正式安装     | 当前 `418880a2` / 0.1.7 arm64；归档/恢复及NEW-05/06分项通过；已正常退出               | 全产品 UI/UX、通知送达、真实停止恢复与 29 家完整接入通过 |
| 历史真实使用 | 部分 Agent、模型和路径有成功、失败与未测记录，逐条保留当时配置与版本                  | 跨版本累计成功等于当前 29 家全部通过                     |
| 本轮能力审查 | 122 个唯一编号，基于源码、历史证据与同行官方资料/定向源码                             | 122 个缺陷、122 个已获批准的新功能或市场达标证明         |

安装细节见[正式落地](evidence/2026-10-09-prototype07-landing/README.md)和[最终布局安装](evidence/2026-10-09-prototype07-landing/prepared-draft-layout/README.md)。本轮源码与受控检查见[能力补强证据](evidence/2026-10-09-capability-hardening/README.md)。接续已调用已安装的官方 Claude 0.81.2 对接受控 HTTP 服务，确认实际路径、模型与测试认证头，并核本次进程组退出，见[路由实证](evidence/2026-10-09-capability-hardening/claude-service-delivery/installed-route.json)；不是实际模型回答、付费服务或新安装版 UI 证明。第三片[安装与数据保留](evidence/2026-10-09-capability-hardening/candidate/installed-data-retention.json)及[实际用量/冷恢复](evidence/2026-10-09-capability-hardening/candidate/installed-usage-progress.json)已有回执：Codex 1.13.1、gpt-6-astra / ultra 单次回复及累计用量显示，重启后正文恢复、未重报用量明确未知；继续发送仍需权限确认，本轮没有确认该权限或再次发送。第四片[安装与数据保留](evidence/2026-10-09-capability-hardening/fourth-candidate/installed-data-retention.json)核验完成，独立候选检查9/9通过，启动后110段对话可见；新能力仍逐项验证。OpenCode 1.18.31 在前三次 GUI 初始化超时后，本片重启恢复新草稿时再次自动准备并超时，没有手动点重试或发送。独立环境和真实传输探针均成功；第三次观测确认请求已写入、子进程卡在文件打开，macOS 同期出现桌面文件夹授权等待，结果仍未知且无可见弹窗。见[诊断回执](evidence/2026-10-09-capability-hardening/opencode-initialize-diagnosis.json)，不算恢复成功，不要求扩大到完全磁盘访问。

第六片源码已补强当前已加载内容检索与 Markdown 导出，七项工程检查通过（前端2,887项、Rust1,134项/5项忽略），安装版分项结果见下段。[检索定向证据](evidence/2026-10-09-capability-hardening/transcript-search/receipt.json)覆盖折叠文字、附件文字与定位恢复，29文件203项及受控Chrome31项通过；[导出定向证据](evidence/2026-10-09-capability-hardening/conversation-export-review.json)覆盖正文保真、工具状态、附件来源、范围说明与取消/失败保护，最终关联72项通过。全局历史正文索引、附件打包归档及其他未覆盖项仍保留。第五片实机检查后已正常退出；原7项未发内容逐值保留。

第六片[正式实机结果](evidence/2026-10-09-capability-hardening/sixth-candidate/installed-search-export.json)已补：正文与折叠详情计数/定位/临时展开回收、真实Markdown文件及再次保存取消反馈通过；关闭导出返回正确焦点。查找说明挤占工具栏、关闭查找焦点和导出隐私说明精度已在第七片安装复验。实机后已正常退出，原3条输入、1组意见、3组待发逐值不变；没有重新批准对话权限或发送新请求。第七片目录读取、PDF/图片版本意见与XLSX预览已整合及分项独立复核；XLSX真实Chromium38项通过。[最终工程整合](evidence/2026-10-09-capability-hardening/seventh-checks-final/final-verification.json)七项通过：前端267文件/2,983项，Rust1,153项/5项忽略，962输入匹配。首轮管道关闭失败的实际干扰进程未捕获；受控fork反例证实测试需要隔离，原即时断言保留，独立发现的输出等待也已修复复验。第七片已提交 `0de05b0a` 并安装，[正式界面实测](evidence/2026-10-09-capability-hardening/seventh-candidate/installed-preview-feedback.json)覆盖XLSX缓存值/公式详情/合并与隐藏行/隐藏工作表/分段读取、损坏与换版重读、PDF页级及旧版本意见、PNG和查找修正；一条新建Codex对话沿用既有6Astra/Ultra完成受限链接回显，没有工具调用或权限变更。正常退出后原3条输入、1组意见、3组待发逐值保留。第八片已实现受限DOCX预览及ARCH-43官方请求级与URL询问。三项全仓回归已修正并独立复核；最终源码输入1,058项保持一致，前端279文件/3,121项、Rust1,178项/5项忽略及类型、打包、Rust格式与clippy通过。生成回执格式修正后单独复验全仓格式，见[第八片整合记录](evidence/2026-10-09-capability-hardening/eighth-checks-final/final-verification.json)；已提交 `af66f006` 并安装，[第一次DOCX实机](evidence/2026-10-09-capability-hardening/eighth-candidate/installed-docx-first.json)确认中文/列表/合并表格、页眉页脚、长内容分段、损坏/隐藏提示与换版重读；当时PNG/JPEG内嵌图片被正式图片策略拒绝；随后修复及实机复验见下段。原7项未发内容保留且已正常退出。完整Office及剩余条目不据此关闭。

图片最小修复的[工程收口](evidence/2026-10-09-capability-hardening/docx-image-fix-checks-final/final-verification.json)已完成：生产策略仅新增本地Blob图片来源，独立WebKit由失败转成功，外部图片仍拦截。协议测试的受控配置锁反例证实派发前等待不应当作响应超时；修正测试边界后Rust1,179项通过，生产协议未改。原失败具体调度未捕获，额外测试lint检查的两项既有问题单列保留；修复已提交 `6c36cae0` 并安装，[正式图片复验](evidence/2026-10-09-capability-hardening/docx-image-fix-candidate/installed-docx-images.json)确认普通PNG/JPEG、EXIF6方向、同版本重读及收起重开均成功，合并单元格详情可打开和返回。本次沿用已有受控对话，没有新请求或权限变更；正常退出后原7项未发内容保持。P16完整Office仍未完成，接续P20自动检查与刷新。

P20 自动刷新已完成源码及独立复核：保护单文件版本，刷新失败保留旧快照并明确提示，编辑意见时延后替换，保留PDF页、工作表窗口和DOCX区域位置。隐藏与迟到结果竞态已有有效反例及修复；[七项检查](evidence/2026-10-09-capability-hardening/file-refresh-checks/final-verification.json)通过，1,073个输入稳定，前端3,183项、Rust1,195项/5项忽略。已提交并安装 `fa235998`；[父层受控浏览器](evidence/2026-10-09-capability-hardening/file-preview-refresh/parent-browser-independent.json)28项通过，实际组件/Office解析器与模拟Tauri接口边界明确。[正式应用复验](evidence/2026-10-09-capability-hardening/file-refresh-candidate/installed-file-refresh.json)确认DOCX段落、XLSX行范围、PDF页码跨版本保持或夹到有效范围；损坏/移走文件保留旧快照并明确提示；编辑中的PDF意见保留旧页和实际版本摘要。三份217,400条数据一致；无新Agent请求或权限变更，正常退出后原7项未发内容逐值不变。P20已有上述macOS证据，其他格式、真实Agent改写与Windows仍分项保留。P17接续已完成流式核验、分块查看、可取消完整另存、未知结果与退出保护，以及超限文件的位置退路；[最终工程整合](evidence/2026-10-09-capability-hardening/large-file-checks-final/final-verification.json)七项通过（前端3,251项、Rust1,230项/6项忽略，1,104输入一致）。新增忽略项为已另行执行的256MiB性能实验；现有真实Agent/Keychain忽略项不计通过。[独立复核](evidence/2026-10-09-capability-hardening/large-file-segments/independent-review.json)最终实际浏览器33项通过；原pending及取消/隐藏后重复读取反例已修复。P17已提交安装 `f71a3434`，[正式初轮实测](evidence/2026-10-09-capability-hardening/large-file-candidate/installed-large-file-initial.json)核到16/256 MiB首末分段及完整副本SHA一致、全局保存入口和无效编码尾部拒绝。257 MiB被拦截但提示误为检查位置，已定位inspect真实字符串与前端结构化错误分类不符；最小源码修复及独立浏览器40项已通过，[工程复核](evidence/2026-10-09-capability-hardening/inspection-limit-checks-final/final-verification.json)前端3,258项通过，未改Rust按相同输入复用既有证据。修复已提交安装 `e8d76d4c`；[正式修复复验](evidence/2026-10-09-capability-hardening/inspection-limit-candidate/installed-inspection-limit.json)确认257 MiB限额提示、无效UTF-8独立提示及16 MiB首段正常。候选独立核验9/9、安装10/10，三份217,400条快照一致；没有新Agent请求或权限变更，正常退出后原7项未发内容逐值保持。原失败保留。一次取消尝试的实际结果为已完成，不计取消成功。沿用既有配置仅新建一条无工具链接回显对话，原7项未发内容保持；不把本机实测当Windows、所有磁盘环境或真实Agent返工完成。

P21 已补普通文字、Markdown原文及大文件当前片段的准确选段意见：按实际读取版本记录UTF-8字节与行范围，支持拖选和按行选择；明确操作才更新目标，原意见跨刷新与换版保留，加入原对话输入框后不自动发送。冷恢复位置始终按历史位置表达，不把保存的坐标当成当前文件证明。[整合检查](evidence/2026-10-09-capability-hardening/text-feedback-checks-final/final-verification.json)前端302文件/3,345项及类型、打包、格式通过，1,116输入稳定；未变Rust与共享夹具复用前次证据。[独立实际浏览器](evidence/2026-10-09-capability-hardening/text-feedback/independent/receipt.json)61项通过；发现继承样式阻止拖选，最小CSS修复经原样反例复验，首次驱动按键/鼠标问题单列而不冒称产品失败。该片提交安装 `cd66aae7`，候选独立9/9、三份217,400条快照一致；已实机核验拖选、片段和旧版意见；随后Enter/滚动修复已安装e98并实机复验，原失败时的7项未发内容逐值保持；[初轮结果](evidence/2026-10-09-capability-hardening/text-feedback-candidate/installed-text-feedback-initial.json)保留按行输入Enter失选失败，不计全项通过；PDF区域、Office位置、图片区域及P22仍开放。

P21 XLSX 单元格/完整合并范围意见已提交并安装 `4952c692`；[正式窗口分项实测](evidence/2026-10-09-capability-hardening/workbook-feedback-candidate/installed-workbook-feedback.json)确认零值/空白/缺公式缓存、实际键盘确认、查看不串目标、跨窗口仍保留 X99:AA102、真实非顺序工作表标识、换版与重启保留旧意见，以及无当前编辑目标时自动读取新内容。候选独立9/9、安装10/10，三份217,400条数据一致；一条新建受限链接回显对话沿用 Codex 6 Astra / Ultra，意见各加入一次且未发送，冷恢复权限未确认。正常退出后原4条输入、2组意见、3组待发逐值保留；新增仅本轮受控输入和意见。此为4952阶段记录；随后DOCX安装与初轮实机见下文。任意表格矩形、PDF/图片区域与P22仍未完成。

P21 DOCX 已补原文件段落/整张表格位置意见：正文、页眉页脚和受支持的附加区域均保留实际 XML 部件及元素路径；只确认当前可见内容，重复文字不串位置，长段落与分窗表格明确对应原完整段落/表格。切区、取消选择、隐藏和换版会收回旧选择，已写意见保留原版本，加入输入框不自动发送。[工程整合](evidence/2026-10-09-capability-hardening/docx-feedback-checks/final-verification.json)前端315文件/3,651项、类型/打包/全仓格式通过，1,145输入稳定；未变Rust与共享夹具按明确输入复用。[独立双浏览器](evidence/2026-10-09-capability-hardening/docx-feedback/independent/receipt.json)各89项DOCX及15项XLSX自动刷新回归通过；另各11项精确隐藏文字补验通过，不重复计能力。两处整页溢出红测经局部滚动修复通过，原始失败保留。上述为源码与受控浏览器证明；随后8c2f安装和初轮实机见下段。完整Office兼容、其他位置/区域与P22继续未完成。

DOCX 已提交安装 `8c2f5e29`，候选独立9/9、安装10/10，三份217,400条快照一致。[正式实机初轮](evidence/2026-10-09-capability-hardening/docx-feedback-candidate/installed-docx-feedback-initial.json)确认同文段落/页眉位置、键盘确认、取消保留意见、换版归属、自动刷新、长段/整表目标及冷恢复；一次受限链接回显，三条意见各加入一次且未发送。发现NEW-03：收起后点同文件重开，长段内分页与表格窗口回到开头；意见不丢，当时接续修复；其后2e976168复验见下文。原5条输入、3组意见、3组待发的内容及其他字段保持；严格逐值检查发现1条输入的可选sendPending从缺省规范为false，原失败与具体差异保留，不冒称完全逐值相同。新增仅本轮受控对话，最终正常退出；[独立收口复核](evidence/2026-10-09-capability-hardening/docx-feedback-candidate/native-closeout-independent.json)核实正式包及数据副本，未把界面观察冒称独立实机复验。该阶段XLSX任意矩形仍在开发，后续安装结果见下文。

XLSX 任意矩形与 NEW-03 阅读位置修复在完成源码检查后，已提交安装2e976168并完成下述分项实机复验。矩形保留用户声明的准确坐标，不因合并单元格或显示窗口扩大、截短，包含隐藏行列需再次确认；未完成输入也保护当前内容。独立写出器原样本暴露的默认内容类型漏读已修，原文件未改，宏文件保护保留。[最终工程](evidence/2026-10-09-capability-hardening/workbook-range-checks-final/final-verification.json)前端323文件/3,811项及类型、打包、全仓格式通过，1,171输入稳定；Rust及共享夹具按未变输入复用。[DOCX修复](evidence/2026-10-09-capability-hardening/docx-reading-position-repair/implementation.json)双浏览器常规与窄窗共208断言通过，表格完整界面双浏览器各74项、独立解析各404项分开留证。早先拒绝、驱动错误预期与修复均保留。检测变化后若因编辑延后，会提示明确重读；没有编辑保护的自动刷新另测。其他区域、完整Office兼容和P22仍未完成。

## 全量盘点与完成口径

[能力审查报告](evidence/2026-10-09-host-capability-audit/index.html)保留 ARCH-01–ARCH-50、P01–P50、H01–H22 共 **122 项**。原分类为源码具备 51、部分具备 37、缺少 13、待实证 8、范围待定 10、明确后置/契约排除 3。

“112”与“122”的差值恰为 10 项范围待定，但这不能证明用户原意是排除这 10 项；112 中也包含 3 项后置/排除内容。全部原始编号保留在活动计划，合并工作包只合并实现，不抹去任何条目。已实现条目继续补所缺验证；范围决定和后置不计成功。

[29 项 × 八项标准跟踪](evidence/2026-10-09-host-capability-audit/agent-standard-coverage.json)有 232 格，当前标注为尚未重新逐家验证本版，不是 232 个失败，也不覆盖旧成功证据。每家八项要求均保留；没有完整证据不能宣布该家达标。

## 未关闭的重点与全量去向

下表便于定位风险，**不是缩减后的任务清单**；全部 122 项及具体完成条件在活动计划逐项列出。

| 领域                   | 当前未关闭内容                                                                                                                            | 去向                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 停止与恢复             | 已修本地准备/迟到交互竞态与运行中队首取消延后，受控 FIFO/并发/未知测试通过；真实负载未量测，历史部分 Agent 的外部命令残留仍未统一归因     | 执行停止恢复包；分 Farfold、协议/接入层、Agent、服务/认证及环境定位 |
| 账号、服务、模型、历史 | 29 家官方资料基线已留证，10 家取消面仍未知；布尔协商和设置确认已补。SDK/CLI 补充、账号作用范围、新 API、恢复保持及真实生效仍需逐家闭合    | 接入、配置与历史包；官方限制仍标未完成                              |
| Agent 能力承接         | 运行中引导、完整上下文分支、压缩状态、用量、子任务、非表单询问、skills/MCP 的完整呈现和管理不足                                           | 官方能力与扩展包；不重造 Agent 循环或历史                           |
| 日常资料与成果         | 文件拖入已有源码及71项关联检查，仍待实机；多种附件真实读取、PDF/Office/图片内嵌查看、成果清单、版本意见、完整导出和实际返工仍需补强或实证 | 输入与文件成果包                                                    |
| 浏览器                 | 生产截图禁用；自有工具的已核接入形式有限；受控动作、撤回、导航与后续观测需完整闭环                                                        | 浏览器包；登录及敏感动作保持范围边界                                |
| 搜索与交互             | 已加载正文搜索已分项实测；未加载历史/附件实体检索、通知真实送达，以及键盘、读屏、长内容和首次发送前页面变化仍需补齐验证                   | 搜索与交互通知包                                                    |
| 数据与长期运行         | 已补非法草稿/启动配置/历史配置拒绝读取与原值保留、SQLite 容量耗尽旧快照保护；完整损坏恢复、物理磁盘满、长期运行和资源上限仍缺完整证据     | 数据维护与性能包；破坏性验证不使用日常用户数据                      |
| 并行工作目录           | 创建/分支/已有位置接入、归档和原路径恢复已有正式分项证据；安全删除与独立副本恢复开发中，同目录冲突及共享资源仍需补齐                      | 继续安全回收与剩余边界验收；不承诺文件系统沙箱或自动合并            |
| Windows                | 已有共用源码及历史交叉检查；真实系统运行、MSVC 包、凭据/终端/通知/浏览器与路径行为未完整验收。UNC/重解析目录限制及通知冷启动仍保留        | Windows 包；不把交叉编译当真实运行                                  |
| 分发及明确排除         | 签名、公证、公开分发、更新渠道待用户认可能力达标；编辑器、LifeModel 真实采集等仍按契约排除                                                | 独立后置，不计作已完成能力                                          |

历史故障与局部成功原始入口：[macOS 第一批](evidence/2026-10-06-macos-batch1/README.md)、[代表实测](evidence/2026-10-06-real-use/README.md)、[源级补强及 Windows 检查](evidence/2026-10-06-product-development/README.md)。未在新证据中关闭的旧故障继续保留，但不把旧版本失败直接判为当前复现。

此前增量已提交安装 `2e976168` / 0.1.7：[正式窗口分项验证](evidence/2026-10-09-capability-hardening/workbook-range-candidate/installed-workbook-range.json)通过XLSX准确矩形、隐藏行列确认、部分合并、无效输入保护、手动重读与自动刷新、跨版本意见及冷恢复；NEW-03同文件重开阅读位置通过。候选独立9/9、安装10/10及三份217,400条快照一致；旧未发送内容保持，1条可选sendPending缺省规范为false单列，最终正常退出。第二工作表实际可见，旧记录误称隐藏的范围已纠正，原始证据未改。前述8c2f和待安装说明为对应阶段记录，不覆盖本段。随后区域安装结果见下段。

PDF/图片区域意见已提交安装 `a47a6652` / 0.1.7 arm64，候选独立9/9、安装10/10及三份217,400条数据一致。[正式窗口分项验证](evidence/2026-10-09-capability-hardening/visual-area-candidate/installed-visual-area.json)覆盖旋转PDF页的键盘区域、图片反向拖选/边界裁切、四位小数、明确确认、目标切换保留文字、无效输入、翻页/收起、换版旧意见及冷恢复。一次受限无工具链接回显沿用 Codex 6 Astra / Ultra 和既有服务权限；图片意见只加入原输入一次，保留前缀且未发送。正常退出后原7条输入中6条逐值相同、1条仅sendPending缺省规范为false；5组意见和3组待发逐值相同。新增仅本轮受控输入和PDF意见。NEW-04源码与受控恢复预览已通过，真实故障恢复入口仍未验，不破坏用户数据制造入口。该区域阶段完成后继续P19清单和P22真实返工；最新结果见下文，全量计划未完成。

P22 已在正式 `a47a6652` 上完成一条有界真实 Codex 返工：[正式窗口与磁盘证据](evidence/2026-10-09-capability-hardening/real-rework/installed-rework.json)核到沿用 6 Astra / Ultra、既有服务与权限，两次请求分别生成文件和按意见修改。实际工具先核旧 SHA，再只将目标行 draft 改为 ready；明确重读显示新内容，另一条未发意见仍属于旧版本，实际完整另存 93 字节与新文件逐字节相同。保存选择器取消未产生文件；受控移走后重读明确失败，恢复原文件后可重新打开。正常退出后旧8条输入中7条逐值相同、1条仅sendPending缺省规范为false；旧6组意见和3组待发逐值不变。[独立核对](evidence/2026-10-09-capability-hardening/real-rework/independent-review.json)另核官方两次请求、文件字节、私有数据副本及正式包链。此为macOS/Codex/小Markdown正常返工及选择器取消证明；运行中Agent/复制取消、失败返工、结果未知、其他格式和环境仍未完成。

P19 成果清单已提交安装 `394bb91a` / 0.1.7 arm64。[正式窗口与文件核对](evidence/2026-10-09-capability-hardening/reported-files-candidate/installed-reported-files.json)确认同一真实 Codex 请求的两次补丁报告去重为两个文件，来源次数2/1、单步与本轮切换、实际读取、移动失败/恢复、完整另存22字节、换版旧意见及重启恢复。沿用 6 Astra / Ultra、既有服务和权限；官方外层工具记录为两次 Code Mode `exec` 包裹内部 `tools.apply_patch`，没有 shell 写文件，不声称满足提示的字面“无exec”。正常退出后旧8条输入、7组意见、3组待发逐值保持，新增仅受控意见，冷恢复没有再次发送或确认权限。[工程检查](evidence/2026-10-09-capability-hardening/reported-files-checks/final-verification.json)1,215输入稳定，前端338文件/4,057项及类型、打包、格式通过；未变Rust1,230项/6忽略按精确输入复用。候选独立9/9、安装10/10，三份217,400条数据一致。此为macOS/Codex分项证明，其他Agent、失败/取消/未知与全量能力仍未完成。[独立收口](evidence/2026-10-09-capability-hardening/reported-files-candidate/native-closeout-independent.json)核对69处引用、正式包和三份私有数据副本；官方记录保留原快照前缀，恢复仅追加一条设置事件，没有新增请求或工具。接续网页请求生命周期和跨对话已加载正文检索。

## 当前边界与下一步

- 首批仍为 [29 项](agent-first-release.md)，八项接入标准不减。只沿官方 ACP、SDK、CLI 承接能力，不修改 Agent/适配器，不私有 HOME，不代写其配置，不自建正文或事件账本。
- 2026-10-09 用户授权持续开发与必要验证，明确期间不使用 Farfold。已有明确选择的服务/模型可做有界真实测试；正式替换前核无活动工作、正常退出与数据保留。缺账号、密钥、换号或系统许可等具体条件逐项交接，独立工作继续。
- 新交互由开发方自查自纠；不再发起一次大规模 UI 改版。签名与更新渠道按用户要求后置，已撤销的整组六条旅程门槛不恢复。
- 首批已推进停止竞态、数据保护、布尔协商和配置确认；接续官方来源映射、历史回放可见性、数据恢复与真实负载剩余条件。29 家公开资料见[官方能力基线](evidence/2026-10-09-capability-hardening/official-capabilities.json)，其中旧源码缺口与本轮修正按增量证据对照，不把资料核查算作真实通过。
- 第五片整库恢复、PDF/图片预览与用户模板已完成源码整合及独立复核；[七项检查](evidence/2026-10-09-capability-hardening/fifth-checks-final/final-verification.json)通过，前端2,820项、Rust1,134项/5项忽略。首轮失败及修复证据保留；第五片已安装并启动，[数据留存](evidence/2026-10-09-capability-hardening/fifth-candidate/installed-data-retention.json)及[独立核验](evidence/2026-10-09-capability-hardening/fifth-candidate/install-independent.json)通过。[模板实机](evidence/2026-10-09-capability-hardening/fifth-candidate/installed-templates.json)覆盖创建/编辑/保存、关闭与重启恢复、保留草稿与附件且不自动发送；[预览实机](evidence/2026-10-09-capability-hardening/fifth-candidate/installed-visual-preview.json)覆盖临时受控副本两页PDF、Type3中文单字、PNG及损坏/密码反馈。桌面路径读取等候系统许可，未解决；该次尚无Office预览，后续XLSX/DOCX进展见前文；整库恢复未破坏日常数据进行验收。第六片已补强P12已加载内容检索和P35导出保真，分项实机结果见上文。运行中引导的[官方接口核查](evidence/2026-10-09-capability-hardening/official-steering-surfaces.json)发现旧接口能力声明不足以保证只作用于当前工作，ARCH-37继续未完成。

- P21 的文字、XLSX单元格/合并范围/任意矩形、DOCX段落/整表、PDF/图片区域意见已分项安装验证，NEW-03具体阅读位置缺陷已复验关闭；P19成果清单已安装并分项实机通过，P22有界真实返工已验、失败和运行中取消等余项继续。NEW-04恢复预览修复已安装，实际故障入口仍待验证；这些分项不代表完整P21完成。

## 历史与维护记录

过去累计状态原文已逐字保存在[能力建设前状态快照](archive/2026-10-09-before-capability-hardening/docs/status.md)，原计划见[冻结计划](archive/2026-10-09-before-capability-hardening/plans/agent-access.md)。它们的“当前版本”“下一步”“未安装”“33 家”和旧实测授权均为当时记录，不能覆盖本页、当前契约或新用户指令。

本轮归档摘要、条目完整性与保护检查见[一致性整理回执](maintenance/2026-10-09-plan-consistency.json)；Markdown 分布与旧计划式证据去向见[清点回执](maintenance/2026-10-09-markdown-inventory.json)。资料整理不代表功能缺口已修复。

P21实机后两项修复已完成工程检查：按行输入Enter的WebKit焦点交接修复通过[独立键盘复核](evidence/2026-10-09-capability-hardening/text-feedback/webkit-enter/independent-review.json)；NEW-02大文件预览改为局部滚动，完整App双浏览器156项通过，见[原反例和修复](evidence/2026-10-09-capability-hardening/text-feedback/native-scroll-review/receipt.json)。[最终整合](evidence/2026-10-09-capability-hardening/text-selection-keyboard-checks-final/final-verification.json)七项具备成功证据，前端3,349项，1,116输入稳定；最终仅CSS变化，打包/全仓格式重跑，未变输入的检查明确复用。已提交安装 `e98e2a46`，[正式复验](evidence/2026-10-09-capability-hardening/text-selection-keyboard-candidate/installed-keyboard-scroll.json)确认两种行号输入Enter、明确二次确认与长文件局部滚动；4条输入、2组意见、3组待发逐值不变，已正常退出。没有新Agent请求、权限变更或全产品达标结论。

本轮真实停止已在 `394bb91a` 完成一次有界 Codex 实测，沿用 6 Astra / Ultra 与既有权限。[正式停止记录](evidence/2026-10-09-capability-hardening/real-stop/installed-stop.json)及[独立核查](evidence/2026-10-09-capability-hardening/real-stop/independent-preliminary.json)确认回复收到中断，但此前启动的单个命令仍运行至45秒并正常写出完成标记；Farfold先显示步骤未确认，随后接收同一命令迟到完成，未启动第二条命令。这不满足“所有外部工作已取消”，ARCH-28/29及29家停止覆盖保持未完成，也尚不能归因为接入层缺陷。正常退出后旧8条输入、8组意见、3组待发逐值不变；整对象严格相等失败仅因新增本次活动记录，原失败保留。此后已接续网页请求取消/超时保护和已加载跨对话搜索的整合与安装验证，结果见后续阶段。

此前网页请求生命周期与跨对话已加载正文搜索源码及独立验证阶段，正式应用为 `394bb91a`；后续安装结果见下文。[网页请求记录](evidence/2026-10-09-capability-hardening/browser-request-lifecycle/implementation.json)补齐每次请求独立取消、排队/执行期限及迟到回调一次回收；撤销单次请求不会误撤页面许可，实际网页脚本结束前仍保留忙碌状态。独立macOS受控回调58项、真实WKWebView脚本14项通过；Windows路径已改，但交叉检查在依赖编译器缺失处停止，不能声称Windows已验证。[搜索独立实测](evidence/2026-10-09-capability-hardening/loaded-history-search/independent/implementation.json)两浏览器各48项通过，修复长Markdown阻塞、Worker实体解码与多路更新饥饿；仅查已加载消息/回复/已收到的附件文字，支持准确跳转、失效提示和取消，无持久正文索引，不自动加载历史。P32未加载历史/附件实体、P27生产截图及其他原条件继续未完成。[整合检查](evidence/2026-10-09-capability-hardening/browser-search-checks/final-verification.json)对应1,234输入：前端345文件/4,098项，Rust1,242项/6忽略，类型和打包通过；完整格式结果以回执为准。一次Rust回归出现3项失败，隔离与后续正常全量复验通过，原失败保留，具体触发原因尚未定位，不能归因为已证实的并发干扰。

网页请求与已加载正文搜索已提交安装 `ece08cd5` / 0.1.7 arm64，候选独立9/9、安装10/10及三份217,400条数据快照一致。[正式分项验证](evidence/2026-10-09-capability-hardening/browser-search-candidate/installed-browser-search.json)确认空载范围提示、两段已加载历史搜索、键盘/点击跳转高亮、无匹配，以及受控本机网页打开、手动文字快照、页面变化重读、收起重开与关闭。正常退出后原8条输入、8组意见、3组待发及整体未发送对象逐值相同，124条会话身份不变；两段官方历史各只追加一次设置事件，无新请求或工具。NEW-05：正文搜索框无障碍名称沿用资料搜索文案，源码已修，尚未随新版安装复验。上述手动网页检查不等于真实Agent网页取消验证；单次请求取消、超时和迟到回调仅有此前受控原生证据。P32未加载历史/附件实体及全部原条件继续未完成。该安装阶段后接续安全工作树与官方后台任务停止；当时的ece08安装版尚未承接官方AIR任务能力。后续源码进展见下段，仍不能据源码推断此前45秒命令已可成功终止。

[本片独立收口](evidence/2026-10-09-capability-hardening/browser-search-candidate/native-closeout-independent.json)复核87处引用、正式包及两份私有数据副本，未把凭据/用户原数据库纳入读取，也未把证据核查冒称第二次实机操作。网页/搜索分项收口后，继续工作树和后台任务停止；完整计划仍未完成。

工作位置创建/已有位置接入、准确起点、新稿归属与未知材料保护，以及官方后台任务独立停止已完成本片源码和独立复核。[七项整合检查](evidence/2026-10-09-capability-hardening/worktree-task-checks/run-02/verification.json)对应1,277个稳定输入，前端354文件/4,180项、Rust1,293项/6忽略通过。首轮Rust源码守卫把安全的try_state误认成必需state，已精确修正并补无数据库退出及不可绕过活动工作的测试；生产路径未因该误报改动，原失败保留。后台任务需实际能力协商、当前连接和任务事件；停止回执不等于任务终态。NEW-05无障碍文案随本片修正。该源码阶段随后已提交安装8780df9e，实机分项结果见下段。工作树归档/恢复/删除及全部剩余条件继续保留。

`8780df9e` / 0.1.7 arm64 已安装并完成[工作树与后台任务分项实机验证](evidence/2026-10-09-capability-hardening/worktree-task-candidate/installed-worktree-tasks.json)。新建分支、已有分支、接入和移除清单均核到实际 Git 结果；原索引、未提交、未跟踪和忽略文件保持，明确使用位置才切换草稿，冷启动后重新核查通过。一次真实 Codex 6 Astra / Ultra 请求中，明确点击后台任务的停止按钮，同一任务报告 stopped，进程在自然期限前退出，超过60秒仍无自然完成文件；此前停止回复未终止命令的失败仍有效，不推广到29家。恢复原空白TR新稿并正常退出后，原8条输入、8组意见、3组待发及124条旧会话完整记录相同，只新增本轮受控会话与活动记录。列表正文搜索的NEW-05已实机修复，全局搜索入口的范围名称仍需新版复验；已知任务事件仍显示“未识别的更新”，作为NEW-06继续修正。当前接续H15归档/恢复及维护保护；永久删除、其他边界与完整计划均未完成。 [独立收口](evidence/2026-10-09-capability-hardening/worktree-task-candidate/native-closeout-independent.json)核对77处引用、正式包及两份私有数据副本；这是证据复核，没有冒称第二次实机操作。

工作树保留归档与原路径恢复已完成本片源码，七项工程检查通过：1,296输入稳定，前端360文件/4,225项，Rust1,321项/6忽略。归档保留完整目录，不改历史对话位置；材料或归属变化、未发内容、活动及未知进程阻挡操作。目录移动、取消、独立重查、写入隔离及实际连接退出均有定向证据；独立复核发现的孤立草稿借用全局位置、写入恢复失败误报成功等反例已修复，原红例保留。完整界面双引擎各27项及维护提示增量各8项通过；11份实际Rust输出经生产TS解析与负向校验共16项通过。全局搜索范围名称与合法后台任务事件标题已修正。该源码阶段随后已提交安装418880a2，分项实机结果见最新记录；安全删除与独立恢复副本继续开发，H15及全部原条件不据此结项。 [工程回执](evidence/2026-10-09-capability-hardening/worktree-recycle-checks/run-01/verification.json)，[后端独立复核](evidence/2026-10-09-capability-hardening/worktree-recycle/independent/backend-independent.json)，[源码闭合](evidence/2026-10-09-capability-hardening/worktree-recycle-checks/source-closure.json)。

`418880a2` / 0.1.7 arm64 已安装并完成[归档恢复与提示分项实机验证](evidence/2026-10-09-capability-hardening/worktree-recycle-candidate/installed-archive-restore.json)：未发内容阻挡归档；归档与原路径恢复保持暂存区、未暂存、未跟踪、忽略文件、符号链接、执行权限及空目录；归档释放受控空闲连接，原对话位置和历史不变。冷启动必须重新核查，原位置被占时拒绝覆盖；恢复后同一 Codex 6 Astra / Ultra 对话继续成功。NEW-05 全局正文搜索范围名称已确认；NEW-06 真实60秒任务的启动与自然完成均使用准确标题并保留原始事件。12秒前样本没有任务事件，不计覆盖。四次受控请求中前两次无工具，后两次仅执行等待命令及查询其结果；模型、服务和权限未扩大，冷恢复明确重选原权限模式。恢复原空白TR新稿并正常退出后，125条旧对话完整记录与原8条输入、8组意见、3组待发逐值相同；只新增一条受控对话及其活动。实机另发现归档位置通用报错、重复阻挡提示、恢复目标冲突和恢复结果文案问题，列为NEW-07/08继续修复。H15安全删除与独立恢复副本正在开发；全量计划仍未完成。

[本片独立收口](evidence/2026-10-09-capability-hardening/worktree-recycle-candidate/native-closeout-independent.json)核对88处公共引用、24处私有引用、41组图文、正式包、三份只读数据副本和官方请求记录；七组检查通过，现存提示缺陷继续保留。独立复核没有再次操作正式窗口。
