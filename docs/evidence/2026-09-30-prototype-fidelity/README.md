# 按认可原型恢复开发

目标：在既有 Farfold / ACP 工作能力上完整落实认可原型的 UI、交互与产品功能。每批只作过程检查；不以局部修复、工程检查或原型样例关闭完整交付。当前唯一计划仍为 `plans/runtime-neutral-lifemodel.md` 第 00 章。

## 当前安装：全页原型对齐候选七

最终候选七已于 2026-09-30 11:42 安装到唯一正式应用，349 文件冻结、复制与签名一致。全页核对确认的实现差距已修复；110 文件／881 项前端测试、类型、格式、打包通过，78 个 Tauri 文件与本轮已验证 Rust 版本一致。候选七实际完成三类内容入口返回、附件冷恢复与真实发送、宽窄窗、审批快捷键隔离、Codex／OpenCode 续接、停止状态与四类内容核对。两次正常退出分别 8／9 个跟踪进程全部结束，设置摘要一致。原 15 条索引、5 个启动配置、四组选择、原意见／队列／活动及 111 个原型文件未变，本轮临时稿已清。精确重复打包应用已移除，正式应用重新打开。

[候选七实测与边界](full-pass/candidate7-ui.md)明确区分当前与前次候选证据。完整 G2/G3 与 J1–J6 仍开放；新账号／密钥／更新／实际期限归档、完整键盘与全面性能未实测，外部 Agent 限制未被其他 Agent 的成功覆盖。Codex 仅返回普通文本的历史附件保持原文，原型通知仍是设计提案。

## 前次交付：候选四安装与有界实测

2026-09-30 03:22:42 将候选四更新到唯一 `/Applications/Farfold.app`，主程序摘要 `e3a35b78d507f36ff96ae5b6763b11550ec65f61ceb15d12892e90c8bbaadb33`。328 文件冻结与安装复制一致，签名通过。前端 102 文件／802 项通过，完整格式检查、类型与应用打包通过。候选四相对候选三仅改顶栏运行状态、附件成功提示及回归测试，Rust 68 个文件与本轮已通过 fmt／clippy／251 项测试的源码一致。见 [检查](candidate4-checks.json)、[源码](candidate4-source.json)、[安装](candidate4-install.json)。

候选四安装实测：

- 本次批准 Codex 有界命令，停止回复后工具仍未确认结束时，顶栏和侧栏保持“进行中”，草稿及暂停待发保留；权限变更保持禁用。截图 [停止状态](installed-stop-status-candidate4.jpg)。重启历史如实显示该命令有步骤未成功，不称其自然完成。
- OpenCode 用原模型真实续接，回复“最终安装版 OpenCode 续接成功”；见 [回复](installed-opencode-reply-candidate4.jpg)。
- 同候选正常退出后 11 个跟踪进程全部结束，设置摘要一致；冷恢复一份草稿及一条带附件待发，权限与附件均需明确确认，两步都未自动发出内容。明确继续后，Codex 实际回复“最终版附件队列完成”，另一份输入稿仍完整。见 [恢复核对](installed-attachment-review-candidate4.jpg)、[真实回复](installed-queue-reply-candidate4.jpg)、`candidate4-before-cold-quit.json`、`candidate4-after-cold-quit.json`。
- 最新真实文件差异 Version 3→4 保留在三栏内容中；[最终工作台](installed-workbench-final.jpg)。只清本轮输入稿与附件，原意见／队列／活动逐项摘要不变。清理后再次正常退出，8 个跟踪进程全部结束，设置摘要一致；见 `candidate4-final-before-quit.json`、`candidate4-final-after-quit.json`。
- 原 15 条索引、5 个启动配置及 111 个原型文件未变；总索引 17 条，包括本轮两条验收对话。完整源码仍对应冻结；[数据保全](candidate4-final-data.json)。仅移除精确重复打包 `.app`，正式应用摘要及签名仍通过；[删除证明](candidate4-cleanup.json)。没有自动提交、修改原型或变更外部 Agent 配置。
- 交付前最后读取确认：输入稿 0、选择 4、文件意见 1、待发队列 1；包括四组原选择在内的全部原摘要均未变。见 `final-unsent-summary.json`。应用保留打开，空白新对话仍是原 OpenCode／Nemotron 3 Ultra 选择，见 `installed-new-conversation-candidate4.jpg`；临时原型浏览器与服务已关闭。

本轮已发现的原型页面与交互遗漏均已实现，最终只读覆盖复核没有发现其他确定缺项。这是本轮开发与有界安装实测的收口，不是完整 G2/G3 或 J1–J6 验收通过。新账号／密钥与服务能力、完整键盘及全面性能等边界见末节；不同候选证据继续独立保留。

## 候选三安装实测与现场收尾

候选三于 2026-09-30 03:11:16 安装，328 文件冻结、复制一致、签名通过；主程序摘要 `af8cf9469a691178e774e5664237c28c2bb0c92a2935e1f1a7fbc3fce18b5465`。102 文件／801 项前端测试通过，格式与类型通过，应用打包完成；Rust 68 个已检查文件未变。见 `candidate3-source.json`、`candidate3-install.json`、`candidate3-tests-final.log`、`candidate3-build.log`。首个未安装的构建另存 `candidate3-before-final-review-*`，不混用。源码覆盖复核见 `candidate3-coverage.md`。

候选三安装版实际结果：

- Cline 断连后准备页显示保留进度及重新连接解释，连接步骤不再错误打勾；手动检查连接回到真实账号步骤，未登录、未保存密钥。见 `installed-cline-recovery-candidate3.jpg`。
- 原 Codex 草稿、单行文件意见和 6 Astra／Ultra 恢复；三个快捷指令依次补入草稿，Escape 返回触发按钮，没有自动发送。见 `installed-shortcuts-candidate3.jpg`。
- 意见填写 `2–99` 被所示片段 1–4 行边界拒绝，`2–3` 可加入对应草稿；复制差异实际粘贴含 `-Version 2`／`+Version 3`，复制路径为对应文件。见 `installed-file-range-candidate3.jpg`。
- Codex 真实修改本轮两文件到 Version 4／Version 3，文件及 55 秒命令均仅本次批准；执行中另发 OpenCode 短请求，AX 曾显示 2 条进行中，OpenCode 实际得到“候选三 OpenCode 验收完成”。截图可能已落在短回复结束后，不能据单张截图推算重叠时长。见 `installed-approval-candidate3.jpg`、`installed-two-agents-candidate3.jpg`。
- Codex 停止回复，草稿两附件及暂停待发的一附件保留；工具没有立即终态，界面明确显示“回复已停止，仍有步骤未确认结束”。正常退出后跟踪的 11 个进程全部结束，全部设置摘要一致，原反馈／队列／活动未改。见 `installed-stopped-attachments-candidate3.jpg`、`candidate3-before-attachment-quit.json`、`candidate3-after-attachment-quit.json`。
- 同一候选冷启动，草稿及待发三项附件共用确认窗口；逐次权限确认后发送和继续发送仍被附件核对限制。将本轮专用文件临时移开，真实读取失败，未部分提交；稍后处理保留原草稿和队列。900×620 中三项可见，取消勾选失效文件再确认，正文／可读附件／待发仍保留且没有自动发送。文件随后已原位恢复。见 `installed-attachment-missing-candidate3.jpg`、`installed-attachment-narrow-candidate3.jpg`。
- 显式继续恢复待发后，真正收到“附件恢复待发验证完成”；输入框另一份草稿与附件未发送。见 `installed-attachment-reply-candidate3.jpg`。再次正常退出跟踪的 8 个进程全部结束，设置摘要一致，原未发内容摘要不变，见 `candidate3-final-before-quit.json`、`candidate3-final-after-quit.json`。

现场收尾发现：顶栏原只看回复是否在运行，与仍有未结束工具的侧栏不一致；已有测试和接入实现明确允许用户在回复停止后发起后续消息，故仅修正顶栏状态，不改变发送／队列语义。另将附件完成提示改为只说明已核对选择，避免显式发送后仍显示“尚未发送”。这两项已进入候选四并实测，候选三证据不改称候选四通过。

## 候选二历史安装

2026-09-30 02:28:06 已将候选二替换到同一正式应用。318 文件冻结与安装复制一致、签名通过，主程序摘要 `1dba4337cf264ffeea5fc796bc77df1ab52cecbe7adf1082e82d0fd31ae357e3`。见 [源码](candidate2-source.json)、[安装](candidate2-install.json)、[安装后保全](candidate2-after-install.json)。原 15 条会话、5 个启动记录及 111 个原型文件均未变。

候选二 98 文件 / 757 项前端测试通过，见 `checks/candidate2-tests-final.log`；完整格式、类型、打包分别见 `candidate2-format-final.log`、`candidate2-typecheck-final.log`、`candidate2-tauri-build.log`。限制测试工作进程为 4 后完成全量，未修改超时阈值；68 个 Rust/Cargo 文件相对本轮 Rust 检查全部未变。以下安装结果仅属于候选二。独立复核又发现快捷指令、文件意见行范围、复制差异/路径和显式附件核对缺失，安装版发现冷恢复准备页缺少断连解释；修复进入下一候选后再验证，不将当前工作区称为候选二。

## 候选二安装版已测

- 选择器初始搜索聚焦，Escape 返回原触发按钮；真实长列表中原 Nemotron 打开即定位，按模型与服务搜索、无匹配提示、取消保留原选择。目录管理图标不再被 padding 压缩。见 `installed-model-current-candidate2.jpg`、`installed-explore-candidate2.jpg`。
- 冷启动保留后台新回复，打开正文后清除提示。Codex 原历史、未发送稿与 6 Astra / Ultra 保留，权限重新确认前发送暂停；确认后没有自动发送原稿。OpenCode 仍为 Nemotron / build。
- Codex 真实续接将本轮 `journey.md` Version 2→3、父目录 `approval-target.md` Version 1→2。真实文件和命令两次单独审批均仅选本次批准。900×620 窗口审批完整，内容覆盖层 Tab/Return 不批准背景请求，Escape 后请求仍等待；显式批准后命令和回复完成。见 `installed-approval-wide-candidate2.jpg`、`installed-approval-narrow-candidate2.jpg`、`installed-narrow-overlay-candidate2.jpg`。
- OpenCode 有界输出与 Codex 工作并行期间侧栏显示两条进行中；OpenCode 在约 86 秒主动停止，编辑稿保留；随后短回复得到“候选二双 Agent 验收成功”。Codex 结束得到“候选二续接完成”，处理中另加入的队列在结束后实际发送并得到“候选二排队验证完成”。不把后一次短回复称为与已结束命令同时运行。见 `installed-stopped-draft-candidate2.jpg`。
- 冷回放旧修改步骤仍显示 Version 1→2，新步骤为 Version 2→3；选择同一工具批次的另一文件时只显示对应文件内容。见 `installed-old-step-version-candidate2.jpg`、`installed-new-step-version-candidate2.jpg`。
- 本轮两条对话批量移入“原型验收 0930”、归档再恢复，收藏再取消，原工作位置不变；未发送文字使归档禁用并显示原因。复制整段对话不含输入稿或隐藏思考正文；“回到最新”实际返回末尾回复。见 `installed-library-group-candidate2.jpg`、`installed-archive-draft-guard-candidate2.jpg`、`installed-latest-reply-candidate2.jpg`。
- 历史查找显式限定本轮 `installed-work`，官方接口仅返回本轮 Codex；已加入项禁止重复选择，并能“打开已有对话”回到同一记录。见 `installed-history-preview-candidate2.jpg`。该结果不算新增外部历史带入或未加入项正文预览通过。
- 通用设置成对截图、快捷键与数据说明可用；更新如实说明未配置发布通道。深色 API 表单层次完整，未编辑退出没有新增服务，主题恢复纸白。Cline 手动重新检查连接后显示真实账号方式，未登录、未存密钥。见 `installed-general-candidate2.jpg`、`installed-api-dark-candidate2.jpg`、`installed-cline-account-candidate2.jpg`。
- 正常退出前保存本轮 Codex 未发文字与 Version 3 单行意见；退出后跟踪的 14 个应用/Agent 进程全部结束，全部设置摘要一致，原反馈、队列和活动逐项摘要未变。见 `candidate2-before-quit.json`、`candidate2-after-quit.json`。下一候选须继续验证这些未发送内容的恢复。

## 候选一安装与现场发现

候选一曾于 2026-09-30 02:08:05 +08:00 替换到 `/Applications/Farfold.app`。主程序 SHA256 为 `0fd8c85a6069f3ac52d13be680e1947304482250d5af4c962e7edbe481cdf533`。[candidate1-source.json](candidate1-source.json) 记录 317 个文件；[candidate1-install.json](candidate1-install.json) 记录复制差异为空、签名校验退出码 0。安装记录中的 `candidate-source.json` 是当次冻结清单，与候选一保留副本相同。

候选一已被后续候选替换。以下保留候选一的有限安装核验和当时失败；焦点、模型搜索和图标问题已在候选二修复并实测。当前工作区与历史安装不能混称为同一最终候选。本轮已完成上述开发及有界实测，未关闭 G2/G3 或完整 J1–J6。

## 保全基线与已落地范围

- [before-install.json](before-install.json) 保存本轮起点：15 条会话索引、5 个 Agent 启动记录、13 项设置与 111 个原型文件/资源摘要，不含正文或秘密。此前 14 条索引不能当成本轮起点。恢复时的旧正式版为 2026-09-28 候选四；`before-agent-settings.jpg` 保留重复设置列表这一历史反例。
- [before-unsent.json](before-unsent.json) 保留原文件意见、队列和选择逐项摘要；[after-checks.json](after-checks.json)、[before-replacement.json](before-replacement.json) 记录替换前原会话与启动配置没有变化。安装现场继续保留原 15 条会话和 5 个启动记录，新增 2 条 QA 对话；未更换旧对话的来源、模型或思考选择。[candidate1-mid-validation.json](candidate1-mid-validation.json) 记录原会话、启动与原型未变；本轮新选择/准备状态按实际操作变化。
- 设置已接统一“我的 Agent”与嵌套返回；独立自定义接入、目录用途筛选和中文说明、首次准备子步骤、日常账号管理、API/通用/LifeModel 层次均进入候选一。旧 AgentAccessSettings、AgentCard 及专属测试/目录样式已删。目录资料来源见 [directory-sources.md](directory-sources.md)，未知与自定义条目不猜分类。
- 新对话选择器、草稿返回、对话/内容顶栏、可见内容复制、回到最新、就地整理、归档禁用原因、步骤产物直达、全局搜索归档/分组及历史带入出口已进入候选一。新回复只保存 Farfold 整理元数据，真实回复触发，历史回放不制造新回复；退出等待待写状态。这些源码与工程结果不代替全部真实旅程验收。

## 候选一工程证据

| 检查              | 结果与原始日志                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 前端全量测试      | 97 文件、746 项通过：[frontend-tests.log](checks/frontend-tests.log)                                                                   |
| 类型检查、格式    | 通过：[typecheck.log](checks/typecheck.log)、[format.log](checks/format.log)                                                           |
| 前端与应用打包    | 完成：[build.log](checks/build.log)、[tauri-build.log](checks/tauri-build.log)                                                         |
| Rust fmt / clippy | 通过：[rust-format.log](checks/rust-format.log)、[clippy.log](checks/clippy.log)                                                       |
| Rust 测试         | 251 通过、0 失败、3 项原有忽略：[rust-tests.log](checks/rust-tests.log)；源码清单见 [rust-checks-source.json](rust-checks-source.json) |

首轮准备页两项失败保留在 [frontend-tests-first.log](checks/frontend-tests-first.log)，不再作为当前工程结果；早期导航/整理与目录回归分别保留在 `checks/navigation-and-collections.log`、`checks/directory-navigation.log`。上述全量结果属于候选一，不覆盖安装后新增修复。

## 候选一安装版已测

以下为主任务在同一候选一上的实际操作结果；原型截图只作设计参照，不混入安装证据。

- 新对话 Agent 选择器输入 `codex` 能筛选；Escape 关闭后原草稿与选择保留。探索目录“轻量”仅显示 Pi，打开详情再返回仍保留分类；自定义接入取消可返回。截图：[installed-new-conversation.jpg](installed-new-conversation.jpg)、[installed-explore-candidate1.jpg](installed-explore-candidate1.jpg)。
- 从设置 API 页进入 Agent 账号、打开 OpenCode 日常管理，关闭并返回设置后仍在 API 页；已建立的 OpenCode 对话保留 Nemotron。跨这些页面返回时原草稿正文完整。截图：[installed-agent-model-candidate1.jpg](installed-agent-model-candidate1.jpg)。
- API 空服务表单临时填写 `example.invalid` 与模型、未填密钥时，保存和测试保持禁用；Escape 后明确确认放弃，没有新增配置。没有保存密钥或发起 API 测试。截图：[installed-api-editor-candidate1.jpg](installed-api-editor-candidate1.jpg)。
- 新建真实 OpenCode 对话，保持 Nemotron / build，仅请求短回复并收到 `原型对齐验收成功`。后台“新回复”筛选显示 1 条；打开正文后提示清除。消息复制后粘贴仅为正文。此结果不扩展为其他模型、账号、工具或权限路线通过。截图：[installed-unread-candidate1.jpg](installed-unread-candidate1.jpg)。
- 空产物内容栏能打开、关闭。此项只证明开关与空态，不证明真实产物定位或完整内容功能。截图：[installed-thread-empty-content-candidate1.jpg](installed-thread-empty-content-candidate1.jpg)。
- Codex 选择恢复为 6 Astra / Ultra；选择本轮专用 `installed-work` 后保持不变，真实修改 `journey.md` Version 1→2，并完成一次 15 秒命令后回复。修改步骤直达仅该步差异，执行步骤直达仅该步输出；复制后粘贴包含指定命令与实际输出。未触发审批，不能算审批路线通过。截图：[installed-codex-step-diff-candidate1.jpg](installed-codex-step-diff-candidate1.jpg)。
- 全局搜索同一查询可见普通目录的 OpenCode 与专用文件夹的 Codex。自动化 AX 只报当前选中项，一度被误判为搜索范围缺失；[实际截图](installed-global-search-candidate1.jpg) 反证并撤回此推断，没有据此修改数据层。
- 正常退出前，OpenCode 后台有界任务已结束并显示新回复，Codex 保留本轮未发稿。退出后本次跟踪的 15 个应用/Agent 进程全部结束，设置摘要无变化，原反馈、待发、活动逐项摘要未变。见 [退出前](candidate1-before-quit.json)、[退出后](candidate1-after-quit.json)。这是候选一退出证据，尚未替代候选二冷恢复或同候选完整退出验收。

## 现场反例与未完成项

- 候选一选择器初始焦点落到关闭按钮、关闭后触发器焦点丢失；400 项模型缺少搜索定位。`installed-model-picker-candidate1.jpg` 保留现场。候选二修复并安装复验通过。
- 候选一管理按钮的图标被全局 padding 压成约 2px；候选二定向 CSS 修复并安装复验通过。
- 第二版首次全量检查保留在 `checks/candidate2-tests.log`：754 项通过，两个测试的模块导入钩子超时并连带清理失败。相同两文件限制测试并发后 20 项通过，见 `checks/candidate2-timeout-recheck.log`；随后全量 757 项通过。首次格式失败仅新增证据文件格式，已修正，不把失败日志改写成通过。
- 候选二冷恢复 Cline 账号准备仅有“前往连接程序”而无原因解释，第一步仍显示完成勾。截图 `installed-cline-blank-preparation-candidate2.jpg` 保留失败；候选三修复并实测。快捷指令、手填意见范围、真实差异／路径复制及恢复附件勾选确认均已进入正式应用，证据按上文候选分列。
- “需要你时提醒／提醒声音”与当前认可原型一致为说明行，不是已承诺可用功能被降成占位。原型 `src/SettingsGeneral.jsx:235–252` 标为“设计提案／尚未提供”，`tests/settings-review-render.test.mjs:28–35` 明确禁止可保存开关。本轮未实现或申请系统通知权限；LifeModel 真实采集与注入也仍按 PRODUCT 明确排除。
- 完整 G2/G3 与 J1–J6 仍开放：新身份登录、新密钥／轮换、权限记住、真实签名更新、实际期限归档、完整键盘、全面性能及各外部服务限制未因本轮源码覆盖或已测旅程而关闭。旧官方历史带入实测只覆盖已加入项，未将其扩展为未加入历史的真实导入成功。
- 已复核现成 `2026-09-27-prototype-rollout/performance_capture.py` 可采集安装版现有计时入口，但必须重新准备当前候选的大文本／双路／千条历史样本并实际交互，且不覆盖全部帧、长任务和进程资源预算。本轮未运行该专项，不引用旧候选性能或 mock 作为通过。
- 候选四第一次格式检查遇到受控测试文件正恢复原位，同时两份新证据 JSON 需格式化；失败日志 `candidate4-format.log` 保留。测试文件已恢复，两份 JSON 格式化后，完整 `candidate4-format-final.log` 通过。没有据此修改产品源码或放宽规则。
