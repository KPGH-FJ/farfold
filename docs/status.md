# Farfold 当前状态

更新：2026-10-10。当前阶段为**能力建设与逐项补强**，目标是可面向市场用户、具备一线多 Agent 桌面工作台水准。执行顺序与全部原始条目见[唯一活动计划](../plans/agent-access.md)，产品要求以 [PRODUCT.md](../PRODUCT.md) 为准。

## 当前基线与证据边界

| 层级         | 已有证据                                                                                                                                                    | 不能据此推出                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 产品源码     | 大文件及提示修复 `e8d76d4c` 已提交安装；16/256 MiB分段与完整另存分项已验，257 MiB限额提示已实机修复验证                                                     | 所有已列能力已补齐                                       |
| 工程检查     | 提示修复前端296文件/3,258项通过，1,105输入匹配；未变Rust复用1,230项/6项忽略证据；原始失败与修正保留                                                         | 所有 Agent、系统权限及安装环境通过                       |
| 正式安装     | 当前安装 `e8d76d4c` / 0.1.7 arm64；唯一正式应用 `/Applications/Farfold.app`。三份217,400条快照一致；大小提示及相邻路径复验通过，正常退出后原7项未发内容保留 | 全产品 UI/UX、通知送达、真实停止恢复与 29 家完整接入通过 |
| 历史真实使用 | 部分 Agent、模型和路径有成功、失败与未测记录，逐条保留当时配置与版本                                                                                        | 跨版本累计成功等于当前 29 家全部通过                     |
| 本轮能力审查 | 122 个唯一编号，基于源码、历史证据与同行官方资料/定向源码                                                                                                   | 122 个缺陷、122 个已获批准的新功能或市场达标证明         |

安装细节见[正式落地](evidence/2026-10-09-prototype07-landing/README.md)和[最终布局安装](evidence/2026-10-09-prototype07-landing/prepared-draft-layout/README.md)。本轮源码与受控检查见[能力补强证据](evidence/2026-10-09-capability-hardening/README.md)。接续已调用已安装的官方 Claude 0.81.2 对接受控 HTTP 服务，确认实际路径、模型与测试认证头，并核本次进程组退出，见[路由实证](evidence/2026-10-09-capability-hardening/claude-service-delivery/installed-route.json)；不是实际模型回答、付费服务或新安装版 UI 证明。第三片[安装与数据保留](evidence/2026-10-09-capability-hardening/candidate/installed-data-retention.json)及[实际用量/冷恢复](evidence/2026-10-09-capability-hardening/candidate/installed-usage-progress.json)已有回执：Codex 1.13.1、gpt-6-astra / ultra 单次回复及累计用量显示，重启后正文恢复、未重报用量明确未知；继续发送仍需权限确认，本轮没有确认该权限或再次发送。第四片[安装与数据保留](evidence/2026-10-09-capability-hardening/fourth-candidate/installed-data-retention.json)核验完成，独立候选检查9/9通过，启动后110段对话可见；新能力仍逐项验证。OpenCode 1.18.31 在前三次 GUI 初始化超时后，本片重启恢复新草稿时再次自动准备并超时，没有手动点重试或发送。独立环境和真实传输探针均成功；第三次观测确认请求已写入、子进程卡在文件打开，macOS 同期出现桌面文件夹授权等待，结果仍未知且无可见弹窗。见[诊断回执](evidence/2026-10-09-capability-hardening/opencode-initialize-diagnosis.json)，不算恢复成功，不要求扩大到完全磁盘访问。

第六片源码已补强当前已加载内容检索与 Markdown 导出，七项工程检查通过（前端2,887项、Rust1,134项/5项忽略），安装版分项结果见下段。[检索定向证据](evidence/2026-10-09-capability-hardening/transcript-search/receipt.json)覆盖折叠文字、附件文字与定位恢复，29文件203项及受控Chrome31项通过；[导出定向证据](evidence/2026-10-09-capability-hardening/conversation-export-review.json)覆盖正文保真、工具状态、附件来源、范围说明与取消/失败保护，最终关联72项通过。全局历史正文索引、附件打包归档及其他未覆盖项仍保留。第五片实机检查后已正常退出；原7项未发内容逐值保留。

第六片[正式实机结果](evidence/2026-10-09-capability-hardening/sixth-candidate/installed-search-export.json)已补：正文与折叠详情计数/定位/临时展开回收、真实Markdown文件及再次保存取消反馈通过；关闭导出返回正确焦点。查找说明挤占工具栏、关闭查找焦点和导出隐私说明精度已在第七片安装复验。实机后已正常退出，原3条输入、1组意见、3组待发逐值不变；没有重新批准对话权限或发送新请求。第七片目录读取、PDF/图片版本意见与XLSX预览已整合及分项独立复核；XLSX真实Chromium38项通过。[最终工程整合](evidence/2026-10-09-capability-hardening/seventh-checks-final/final-verification.json)七项通过：前端267文件/2,983项，Rust1,153项/5项忽略，962输入匹配。首轮管道关闭失败的实际干扰进程未捕获；受控fork反例证实测试需要隔离，原即时断言保留，独立发现的输出等待也已修复复验。第七片已提交 `0de05b0a` 并安装，[正式界面实测](evidence/2026-10-09-capability-hardening/seventh-candidate/installed-preview-feedback.json)覆盖XLSX缓存值/公式详情/合并与隐藏行/隐藏工作表/分段读取、损坏与换版重读、PDF页级及旧版本意见、PNG和查找修正；一条新建Codex对话沿用既有6Astra/Ultra完成受限链接回显，没有工具调用或权限变更。正常退出后原3条输入、1组意见、3组待发逐值保留。第八片已实现受限DOCX预览及ARCH-43官方请求级与URL询问。三项全仓回归已修正并独立复核；最终源码输入1,058项保持一致，前端279文件/3,121项、Rust1,178项/5项忽略及类型、打包、Rust格式与clippy通过。生成回执格式修正后单独复验全仓格式，见[第八片整合记录](evidence/2026-10-09-capability-hardening/eighth-checks-final/final-verification.json)；已提交 `af66f006` 并安装，[第一次DOCX实机](evidence/2026-10-09-capability-hardening/eighth-candidate/installed-docx-first.json)确认中文/列表/合并表格、页眉页脚、长内容分段、损坏/隐藏提示与换版重读；当时PNG/JPEG内嵌图片被正式图片策略拒绝；随后修复及实机复验见下段。原7项未发内容保留且已正常退出。完整Office及剩余条目不据此关闭。

图片最小修复的[工程收口](evidence/2026-10-09-capability-hardening/docx-image-fix-checks-final/final-verification.json)已完成：生产策略仅新增本地Blob图片来源，独立WebKit由失败转成功，外部图片仍拦截。协议测试的受控配置锁反例证实派发前等待不应当作响应超时；修正测试边界后Rust1,179项通过，生产协议未改。原失败具体调度未捕获，额外测试lint检查的两项既有问题单列保留；修复已提交 `6c36cae0` 并安装，[正式图片复验](evidence/2026-10-09-capability-hardening/docx-image-fix-candidate/installed-docx-images.json)确认普通PNG/JPEG、EXIF6方向、同版本重读及收起重开均成功，合并单元格详情可打开和返回。本次沿用已有受控对话，没有新请求或权限变更；正常退出后原7项未发内容保持。P16完整Office仍未完成，接续P20自动检查与刷新。

P20 自动刷新已完成源码及独立复核：保护单文件版本，刷新失败保留旧快照并明确提示，编辑意见时延后替换，保留PDF页、工作表窗口和DOCX区域位置。隐藏与迟到结果竞态已有有效反例及修复；[七项检查](evidence/2026-10-09-capability-hardening/file-refresh-checks/final-verification.json)通过，1,073个输入稳定，前端3,183项、Rust1,195项/5项忽略。已提交并安装 `fa235998`；[父层受控浏览器](evidence/2026-10-09-capability-hardening/file-preview-refresh/parent-browser-independent.json)28项通过，实际组件/Office解析器与模拟Tauri接口边界明确。[正式应用复验](evidence/2026-10-09-capability-hardening/file-refresh-candidate/installed-file-refresh.json)确认DOCX段落、XLSX行范围、PDF页码跨版本保持或夹到有效范围；损坏/移走文件保留旧快照并明确提示；编辑中的PDF意见保留旧页和实际版本摘要。三份217,400条数据一致；无新Agent请求或权限变更，正常退出后原7项未发内容逐值不变。P20已有上述macOS证据，其他格式、真实Agent改写与Windows仍分项保留。P17接续已完成流式核验、分块查看、可取消完整另存、未知结果与退出保护，以及超限文件的位置退路；[最终工程整合](evidence/2026-10-09-capability-hardening/large-file-checks-final/final-verification.json)七项通过（前端3,251项、Rust1,230项/6项忽略，1,104输入一致）。新增忽略项为已另行执行的256MiB性能实验；现有真实Agent/Keychain忽略项不计通过。[独立复核](evidence/2026-10-09-capability-hardening/large-file-segments/independent-review.json)最终实际浏览器33项通过；原pending及取消/隐藏后重复读取反例已修复。P17已提交安装 `f71a3434`，[正式初轮实测](evidence/2026-10-09-capability-hardening/large-file-candidate/installed-large-file-initial.json)核到16/256 MiB首末分段及完整副本SHA一致、全局保存入口和无效编码尾部拒绝。257 MiB被拦截但提示误为检查位置，已定位inspect真实字符串与前端结构化错误分类不符；最小源码修复及独立浏览器40项已通过，[工程复核](evidence/2026-10-09-capability-hardening/inspection-limit-checks-final/final-verification.json)前端3,258项通过，未改Rust按相同输入复用既有证据。修复已提交安装 `e8d76d4c`；[正式修复复验](evidence/2026-10-09-capability-hardening/inspection-limit-candidate/installed-inspection-limit.json)确认257 MiB限额提示、无效UTF-8独立提示及16 MiB首段正常。候选独立核验9/9、安装10/10，三份217,400条快照一致；没有新Agent请求或权限变更，正常退出后原7项未发内容逐值保持。原失败保留。一次取消尝试的实际结果为已完成，不计取消成功。沿用既有配置仅新建一条无工具链接回显对话，原7项未发内容保持；不把本机实测当Windows、所有磁盘环境或真实Agent返工完成。

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
| 搜索与交互             | 缺跨对话正文搜索和完成通知；通知真实送达未全部关闭。键盘、读屏、长内容、准备完成至首次发送的页面变化仍需检查                              | 搜索与交互通知包                                                    |
| 数据与长期运行         | 已补非法草稿/启动配置/历史配置拒绝读取与原值保留、SQLite 容量耗尽旧快照保护；完整损坏恢复、物理磁盘满、长期运行和资源上限仍缺完整证据     | 数据维护与性能包；破坏性验证不使用日常用户数据                      |
| 并行工作目录           | 已能选已有目录/工作树，缺创建、分支与安全回收流程；同目录文件冲突与共享资源仍需处理                                                       | 工作树范围与基础设计；不承诺文件系统沙箱或自动合并                  |
| Windows                | 已有共用源码及历史交叉检查；真实系统运行、MSVC 包、凭据/终端/通知/浏览器与路径行为未完整验收。UNC/重解析目录限制及通知冷启动仍保留        | Windows 包；不把交叉编译当真实运行                                  |
| 分发及明确排除         | 签名、公证、公开分发、更新渠道待用户认可能力达标；编辑器、LifeModel 真实采集等仍按契约排除                                                | 独立后置，不计作已完成能力                                          |

历史故障与局部成功原始入口：[macOS 第一批](evidence/2026-10-06-macos-batch1/README.md)、[代表实测](evidence/2026-10-06-real-use/README.md)、[源级补强及 Windows 检查](evidence/2026-10-06-product-development/README.md)。未在新证据中关闭的旧故障继续保留，但不把旧版本失败直接判为当前复现。

## 当前边界与下一步

- 首批仍为 [29 项](agent-first-release.md)，八项接入标准不减。只沿官方 ACP、SDK、CLI 承接能力，不修改 Agent/适配器，不私有 HOME，不代写其配置，不自建正文或事件账本。
- 2026-10-09 用户授权持续开发与必要验证，明确期间不使用 Farfold。已有明确选择的服务/模型可做有界真实测试；正式替换前核无活动工作、正常退出与数据保留。缺账号、密钥、换号或系统许可等具体条件逐项交接，独立工作继续。
- 新交互由开发方自查自纠；不再发起一次大规模 UI 改版。签名与更新渠道按用户要求后置，已撤销的整组六条旅程门槛不恢复。
- 首批已推进停止竞态、数据保护、布尔协商和配置确认；接续官方来源映射、历史回放可见性、数据恢复与真实负载剩余条件。29 家公开资料见[官方能力基线](evidence/2026-10-09-capability-hardening/official-capabilities.json)，其中旧源码缺口与本轮修正按增量证据对照，不把资料核查算作真实通过。
- 第五片整库恢复、PDF/图片预览与用户模板已完成源码整合及独立复核；[七项检查](evidence/2026-10-09-capability-hardening/fifth-checks-final/final-verification.json)通过，前端2,820项、Rust1,134项/5项忽略。首轮失败及修复证据保留；第五片已安装并启动，[数据留存](evidence/2026-10-09-capability-hardening/fifth-candidate/installed-data-retention.json)及[独立核验](evidence/2026-10-09-capability-hardening/fifth-candidate/install-independent.json)通过。[模板实机](evidence/2026-10-09-capability-hardening/fifth-candidate/installed-templates.json)覆盖创建/编辑/保存、关闭与重启恢复、保留草稿与附件且不自动发送；[预览实机](evidence/2026-10-09-capability-hardening/fifth-candidate/installed-visual-preview.json)覆盖临时受控副本两页PDF、Type3中文单字、PNG及损坏/密码反馈。桌面路径读取等候系统许可，未解决；该次尚无Office预览，后续XLSX/DOCX进展见前文；整库恢复未破坏日常数据进行验收。第六片已补强P12已加载内容检索和P35导出保真，分项实机结果见上文。运行中引导的[官方接口核查](evidence/2026-10-09-capability-hardening/official-steering-surfaces.json)发现旧接口能力声明不足以保证只作用于当前工作，ARCH-37继续未完成。

- 当前接续 P21：支持的文字、Markdown原文及大文件当前片段的准确选段意见；旧意见保留原版本与位置，不自动发送。PDF区域、Office位置、图片区域和P22真实返工仍未完成。

## 历史与维护记录

过去累计状态原文已逐字保存在[能力建设前状态快照](archive/2026-10-09-before-capability-hardening/docs/status.md)，原计划见[冻结计划](archive/2026-10-09-before-capability-hardening/plans/agent-access.md)。它们的“当前版本”“下一步”“未安装”“33 家”和旧实测授权均为当时记录，不能覆盖本页、当前契约或新用户指令。

本轮归档摘要、条目完整性与保护检查见[一致性整理回执](maintenance/2026-10-09-plan-consistency.json)；Markdown 分布与旧计划式证据去向见[清点回执](maintenance/2026-10-09-markdown-inventory.json)。资料整理不代表功能缺口已修复。
