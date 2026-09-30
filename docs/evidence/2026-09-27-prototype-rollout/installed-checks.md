# 各候选安装现场（进行中）

## 当前候选九（焦点与IME局部通过，完整交付未完成）

**原型主体已进入正式源码和安装版，完整交付未完成。** 当前唯一正式安装为候选九，SHA `242b9e8b21323d2c05d1c3025648931b0ff6ebcd434a03128763a6f211904d94`；245文件冻结匹配。正常退出后，同版本新PID80159于19:25:11启动，原全局草稿保留未发。

[候选九独立回归](candidate9-installed-regression.md)已记录焦点归还、真实IME确认/明确发送/Codex回复、中文换行和同版本冷草稿/权限恢复。九轮[独立性能审计](candidate9-performance-validated.md)及[采集收尾](candidate9-performance-finalization.md)通过：1170正式/1206完整样本，最高p95输入31ms、切换90ms，当前负载完整覆盖；只有一名独立审计者完成该项核对，不代替完整资源预算或J1–J6。[19:31:35最终保全](candidate9-data-preservation.md)及[字段核对](candidate9-data-preservation.json)确认原62会话/10Agent/68忽略记录身份全部保留，当前83/10/81；原全局文字、附件、Agent/位置/服务/模型/思考选择逐字段一致，未处于发送或首次发送未知状态。收藏2、分组总数2，成员分别1/3；此前“组3”指安装验收组内3条对话。历史完整分组成员没有逐项基线，外部正文和秘密未审，不称所有用户数据完整审计。245源码、原型选定161文件及4个安装摘要匹配，新PID80159与唯一正式App身份一致。

候选七、八的其余真实旅程保留各自归属，不转记本候选；[OpenCode两次429服务限流](candidate8-opencode-failure.md)与[Pi零回答连接失败](candidate7-pi-native-outcome.md)分开。完整键盘/文字放大布局/资源指标未完成，新登录、新API秘密、记住授权和真实签名发布源仍需条件。各候选失败及[C5原始起点受损](candidate7-capture-path-incident.md)不删除；不得据两文件增量误认今天主体仅实现两文件。

## 候选八历史结果（确认键局部通过，焦点归还失败）

上一候选八安装历史：[安装身份](candidate8-installed.json)确认18:53:13.543 CST替换、PID76682于18:53:19启动，SHA256 `930e0e726806ccfc2799c1c99e045bdabffff1f23b867fd26ab66f39b0c56fe4`。[冻结244文件](candidate8-source.json)相比候选七仅Composer通用确认键保护及新增IME测试；前端370项、类型/限定格式/打包/签名通过，Rust只沿用未变化代码对应的候选七证据。正式安装与完整打包一致，精确重复.app已移除，旧候选七19个跟踪进程全部退出。

[候选八独立回归](candidate8-installed-regression.md)：截图130原草稿保留未发；131真实逐键 c/e/s/h/i 进入“ce shi”组合态；132一次Return仅确认、`ceshi`留输入框且无新用户消息；133第二次普通Return明确发起18:54请求、当时运行中。对应确认/发送现场修复通过；18:55该ceshi请求显示“请求未完成”，不计Agent成功；候选七误发送保留失败历史，全部候选七旅程及性能不直接转记候选八。队列和双审批已取得局部结果，完整键盘与产品验收未通过；候选九现已安装，焦点归还本次复验另列。

候选八新增局部通过：[134](screenshots/134-candidate8-queue-ime-confirm-not-saved.png)队列编辑真实组词Return仅确认、不保存；[135](screenshots/135-candidate8-queue-save-paused.png)第二Return才保存且待发仍暂停，之后仅移除本轮自建项；[136](screenshots/136-candidate8-chinese-space-shift-newline.png)Space选中文、Shift+Return只换行不发，随后仅清本轮输入。两Codex冷恢复均明确重设Ask for approval取得回执、Ultra保留；[137](screenshots/137-candidate8-two-approvals-input-focus.png)两审批同时存在，B输入区组词确认和Backspace后仍两项待处理。仅拒绝B后，界面已拒绝/已告知Agent/已停止，没有虚构拒绝标记正文（[138](screenshots/138-candidate8-deny-b-other-pending.png)）；A仍待处理（[139](screenshots/139-candidate8-a-still-pending-after-b-denied.png)）。A单次批准后18:58准确回复FARFOLD-C8-ALLOW-A（[140](screenshots/140-candidate8-a-approved-result.png)）；[效果核对](candidate8-approval-effects.json)确认A18:58:41.467736生成0字节目标、B仍不存在，从未使用记住授权。

**候选八新缺陷：权限确认弹窗关闭未回原触发按钮。** [初始焦点](candidate8-permission-keyboard-focus.json)与[后续](candidate8-permission-keyboard-followup.json)记录Esc后回body、再Tab到收起导航；未观察到背景按钮泄漏，不误写为弹窗焦点隔离失败。独立源码核查已确认选项同步卸载后弹窗才保存焦点、得到body；后续候选九仅窄修WorkspacePopover显式关闭先还焦点及相关测试，现已安装并复验具体焦点路径；不倒算为候选八通过。候选八两次OpenCode真实请求均失败：18:54明确发送ceshi后18:55未完成；19:01短标记后19:02未完成（[截图141](screenshots/141-candidate8-opencode-bounded-reply.png)、[状态](candidate8-opencode-reply-state.json)）。独立只读官方SQLite核对得到两次均OpenCode1.18.31、opencode/big-pickle、assistant error429、isRetryable=true、rate limit、parts=0，属于服务限流，不笼统记网络未知、不与Pi的Connection error混同。[限定官方记录核对](candidate8-opencode-failure.md)及[数据](candidate8-opencode-failure.json)另证parts/tokens/cost均0、无Retry-After或明确等待数字；该次协议返回未逐包捕获。不改模型或反复请求绕过限流。候选七Pi已有[自身失败结果核对](candidate7-pi-native-outcome.md)，四次Connection error、零内容/用量；原始协议包未捕获、网络层未知，不转记候选八。

文字放大要求为布局验收，当前契约/原型没有明确新增字号设置的承诺；安装无已支持页面缩放入口，保持未测，不自动增加功能。候选七[截图129](screenshots/129-candidate7-palette-escape-focus.png)仅关闭其搜索Esc回输入焦点的小范围用例，不是候选八或完整键盘通过。

## 候选七历史结果（输入法误发送，后续另修）

**18:42候选七历史失败：中文输入法确认误发送；后续候选八对应复验另列。** 在已清空的本轮C4 FIRST OpenCode测试对话，恢复输入方式后真实逐键输入 c/e/s/h/i；[截图126](screenshots/126-candidate7-ime-composing.png)显示带下划线的组合态，辅助功能值为“ce shi”。按Return后意外发送“ceshi”并于18:42启动真实Agent（[截图127](screenshots/127-candidate7-ime-confirm-unexpected-send.png)、[状态记录](candidate7-ime-confirm-state.json)）。原全局用户草稿未触碰。该现场反例已交独立负责人窄修；[截图128](screenshots/128-candidate7-chinese-space-and-newline.png)进一步确认真实逐键zhongwen后Space得到“中文”且未发送、Shift+Return只换行，排除仅以粘贴冒充组词；它不推翻Return确认“ce shi”误发的反例。误发的ceshi请求18:43显示请求未完成。仅本轮测试输入已清，回到原全局草稿；后续修复仍须新候选现场复验，不能把C7收口为通过。

最新历史查找：[截图123](screenshots/123-candidate7-history-scope-dedup.png)通过官方OpenCode接口限定本轮installed-work，已加入的原测试会话不可重复勾选且可打开；[截图124](screenshots/124-candidate7-history-empty-not-imported.png)预览本轮14:13空会话后如实报告无正文、未加入，没有新增或重复。随后恢复默认查找范围并关闭。截图107图文冷恢复验收完成后，只清理本轮自建C5图文草稿与附件引用，原图片文件未删；原全局草稿完整未发。[18:43:07独立数据保护快照](candidate7-data-preservation.md)与[逐字段结果](candidate7-data-preservation.json)确认原62会话/10Agent/68忽略记录身份全部匹配，当前83/10/81；原全局文字、附件及Agent/目录/服务/配置/模型选择精确一致，唯一新增字段sendPending=false。其他输入草稿、意见与队列均为0；原型161及候选七源码243文件在该时点匹配、PID73632同正式SHA。该快照不替代正文或秘密完整性，也不把随后授权修复倒算为用户数据损坏。

候选七小窗口局部验收：1800×1240物理像素对应900×620逻辑尺寸。[截图117](screenshots/117-candidate7-minimum-file-panel.png)文件面板可读且关闭可回对话；[截图118](screenshots/118-candidate7-minimum-dark-settings.png)深色通用设置排版与控件可用；[截图119](screenshots/119-candidate7-minimum-api-cancel.png)API添加空表单底部取消与禁用保存可见，随后取消，未输入秘密、未保存。已恢复18:16续接时的纸白选择和1280×820窗口。此时尚未测中文输入法组词；后续18:42已发生确认组词误发送，详见最新失败。文字放大、完整资源/帧/长任务仍未测。

[截图120](screenshots/120-candidate7-diagnostics-exported.png)诊断导出成功，本轮新ZIP已从桌面精确移入本地证据目录；[candidate7-diagnostics.zip](candidate7-diagnostics.zip)已由[独立只读检查](candidate7-diagnostics-check.md)及[结构结果](candidate7-diagnostics-check.json)确认36条目、32份日志共9219条摘要通过字段/类型/枚举允许列表、尺寸和排除规则，原ZIP不变；没有用户自填说明，不推广为任意输入都会脱敏。[截图121](screenshots/121-candidate7-rename-favorite-group.png)仅本轮C7 FIRST OpenCode对话改名“C7整理验收”、收藏、加入既有安装验收组成功；[截图122](screenshots/122-candidate7-own-archive-restore.png)仅选该一条归档，再从已归档恢复，现场计数83条/收藏3/安装验收组内4条。该快照后已仅撤销本轮的分组、收藏和改名，精确恢复C7 FIRST OpenCode原名；现场回到83条/收藏2/验收组内3条。

[工具结束核对](candidate7-bounded-tools-finished.json)确认本轮两条sleep均已结束；这是后续自然完成的核对，不把停止回复解释为立即终止子命令。

性能后续[独立收尾核对](candidate7-performance-finalization.md)及[数字证据](candidate7-performance-finalization.json)于18:32:42 CST确认最终exit0、1207完整样本、storageFailure为空；原1201条完整前缀、18条边界及其余冻结输入未变，新增6条均在正式轮次之外。九轮900/270与最大p95 34/93ms重算通过，采集锁释放、原20进程及采集器PID70579均结束，同SHA新进程73632确认。原18:12运行中报告保留历史时点；资源、完整帧、长任务仍未测，不升级为真实AgentJ4或完整J1–J6通过。

候选七真实并行与停止边界：[停止前进程](candidate7-two-real-tools-before-stop.json)于18:29:42确认Codex sleep90与OpenCode sleep60同时存活（[截图113](screenshots/113-candidate7-two-agents-running.png)2进行中）。停止Codex回复后，[18:30:06进程快照](candidate7-after-stop-processes.json)仍见两条sleep；[18:30:15界面](candidate7-after-stop-state.json)及[截图114](screenshots/114-candidate7-tool-tail-unconfirmed.png)显示步骤正在处理、回复已停止、权限禁用与空输入发送禁用。OpenCode18:30准确返回 `FARFOLD-C7-OPENCODE-PARALLEL-OK`（[截图116](screenshots/116-candidate7-opencode-parallel-completed.png)），停止A未打断B。18:30:40才输入TAIL-DRAFT，距90秒开始已约93秒，不能用此时可发送证明尾程期间非空发送绕过保护；当前没有这类实际反例。尾程说明位于历史顶部、截图底部未见该解释，不能记当前位置说明已可见；也不把回复停止当作子命令被提前终止。

候选七长等待审批闭环：[批准前核对](candidate7-delayed-before-allow-once.json)于18:21:03确认等待1809.990718秒、目标仍不存在；[明确单次批准](candidate7-delayed-approval-action.json)后，[文件效果](candidate7-delayed-command-effect.json)确认18:21:11创建0字节目标，[截图101](screenshots/101-candidate7-delayed-approval-completed.png)显示准确回复 `FARFOLD-C7-DELAYED-APPROVAL-OK`。目录当时暂停但原审批可完成；随后点击输入区恢复目录，A-EDITED队列仍暂停，没有自动发送。该结果只覆盖同一请求等待超过30分钟后单次批准，不覆盖记住授权或其他异常。

[截图102](screenshots/102-candidate7-unsaved-queue-before-cold.png)保留未保存队列编辑 `C7-QUEUE-EDIT-UNSAVED`。18:22:10进程快照后正常CmdQ退出，[退出后核对](candidate7-after-cold-exit.json)确认20个跟踪进程全部结束且无正式应用进程；[采集收尾](performance-candidate7-perf.metadata.json)为exit0、1207样本、storageFailure为空。确认无正式进程后，明确UI重开，[冷启动身份](candidate7-cold-relaunch.json)记录PID73632始于18:22:36、同SHA；[截图103](screenshots/103-candidate7-original-draft-after-cold.png)原全局草稿保留、83条对话、未发送。后续冷恢复：[截图104](screenshots/104-candidate7-unsaved-queue-after-cold.png)未保存队列编辑全文恢复，原目标无法确认时保存禁用、仅可加入输入框；[截图105](screenshots/105-candidate7-cold-permission-pauses-queue.png)加入成功，原A-EDITED队列不变，权限未知、队列暂停、发送禁用，Ultra保留。仅清理本轮未保存编辑后，明确选择Ask for approval并确认应用取得真实回执；[截图106](screenshots/106-candidate7-confirmed-permission-queue-still-paused.png)队列仍暂停。18:24随后手动继续，[截图110](screenshots/110-candidate7-queue-manual-continue-result.png)准确收到 `FARFOLD-C7-QUEUE-A-EDITED`，队列清空、Ultra保留；只计手动继续成功，不计自动发送。[截图107](screenshots/107-candidate7-image-draft-after-cold.png)图文草稿正文与64×64图片冷恢复完整、未发送。意见冷恢复：[截图108](screenshots/108-candidate7-feedback-after-cold.png)经显式全会话产物入口选 `candidate6-opencode-note.md`，查看V7A后回V7B，原C7意见与修改后片段第1行定位恢复；[截图109](screenshots/109-candidate7-feedback-appends-without-send.png)加入已有C7-PREFIX，两段与片段定位均保留、未发送，随后仅清理本轮输入。冷历史未提供本轮范围按钮，不假称旧轮次范围恢复。OpenCode18:26准确返回最初 `FARFOLD-INSTALLED-OPENCODE-20260927-OK`（[截图111](screenshots/111-candidate7-opencode-cold-continuation.png)）；Codex18:27准确返回最初 `FARFOLD-INSTALLED-CODEX-20260927-OK`、Ultra不变（[截图112](screenshots/112-candidate7-codex-cold-continuation.png)）。Pi18:28冷续问经过2/4/8秒三次重试后显示恢复及已完成，但没有目标回答；[截图115](screenshots/115-candidate7-pi-cold-message-no-answer.png)与[状态记录](candidate7-pi-cold-state.json)明确记本候选真实失败，不能继续列未测或成功；不据此归因网络层。

候选七界面补证：[截图94](screenshots/94-candidate7-unavailable-install-preparation.png)goose未连接的准备页不能继续；选择暂时返回后，[截图95](screenshots/95-candidate7-preparation-returns-draft.png)原输入与原Agent选择保留。原全局用户草稿18:11已恢复、未发送。18:16 fresh界面确认纸白已选；此前深色后检测到用户界面切换，该次缩窗未成功，不作小窗证据；后续截图117–119另记真实小窗结果。两条普通新对话首发已读到真实完成回复：OpenCode18:09准确返回 `FARFOLD-C7-FIRST-OPENCODE-20260927`（[截图96](screenshots/96-candidate7-opencode-first-message.png)），Codex18:11准确返回 `FARFOLD-C7-FIRST-CODEX-20260927` 且Ultra保留（[截图97](screenshots/97-candidate7-codex-first-message.png)）；两次无工具、无文件，不代表新账号认证成功。18:17 OpenCode仅printf轮次已完成，准确回复 `FARFOLD-C7-OUTPUT-DONE`；[截图98](screenshots/98-candidate7-output-only-current-round.png)点“本轮产物1”只显示命令输出 `FARFOLD-C7-OUTPUT-ONLY`，没有旧文件。[截图99](screenshots/99-candidate7-image-draft-before-cold.png)确认自建C5图文草稿在候选七完整保留未发。发送管理选中并核对本轮approval-cwd后，仅暂停该目录Codex；[截图100](screenshots/100-candidate7-scope-paused-approval-available.png)及[状态记录](candidate7-scope-paused-state.json)确认原17:50审批仍可批准/拒绝，A-EDITED待发仍暂停，输入区提供目录恢复入口且原稿保留。18:19:42目标 `candidate7-delayed-once.txt` 仍不存在，已等待1728.678秒，尚未批准；这是批准前快照，后续一次批准结果单列。

候选七[独立核对](candidate7-performance-validated.md)及[逐项来源](candidate7-performance-validated.json)于18:12:44 CST确认三场景各3轮计时、当前负载与三轮双路完整窗口覆盖通过：每轮100输入/30切换，共900/270，最高p95输入34ms、切换93ms，焦点/可见性排除0；当时完整raw为1201样本，其中1170正式样本。双路窗口22.611/22.420/22.516秒，最早完成仍晚于所属轮次结束13.896秒；不声称逐毫秒持续交付。PID70584、启动身份、安装包及243源码一致，原始[九轮数字报告](candidate7-performance-nine-rounds.json)保留。采集器当时仍running、未finalized；资源、完整帧、长任务等未测，不代表完整性能预算或J1–J6完成。

采集助手发生真实证据事故：18:01:28 CST（10:01:28 UTC）旧 `beginDualRound` 闭包把 `performance-candidate5-perf-dual64-r1-start-state.json` 覆写为候选七未计时观察；旧身份保护阻止后续round边界写入。候选五九轮在当时已独立审查通过，但这一原始起点当前受损，不能宣称现在完整重查仍通过，也不能把候选七内容冒充候选五原证据。[独立事故核对](candidate7-capture-path-incident.md)确认该起点7820字节旧摘要与当前7458字节不匹配，其他10项来源匹配，另一个元数据变化属于正常退出收尾；限定18文件及原Git路径未找到完整原件。候选七前6静态轮不受影响，之后固定候选七路径、独占创建的自包含助手重做C7-LIVE-R1/2/3三轮，其当前标记、负载与完整测量窗口已独立核验。误写尝试无正式轮次，不补作任何候选的通过证据。

候选七产物现场：[截图91](screenshots/91-candidate7-replacement-clearly-fragment.png)真实单行编辑明确显示“修改前/后·片段第1行”及非文件行号说明，17:50 OpenCode准确回复原标记；17:52完成V7B与HTML编辑并回复 `FARFOLD-C7-FILES-OK`。[截图92](screenshots/92-candidate7-version-and-feedback-return.png)同路径V7A/V7B往返时旧版隐藏新版定位，回新版保留 `FARFOLD-C7-FEEDBACK-KEEP` 与片段定位，留作冷恢复核验。[截图93](screenshots/93-candidate7-static-html-preview.png)完整HTML差异的静态预览显示 `FARFOLD-C7-STATIC-PREVIEW`，脚本尝试改为 `SCRIPT-RAN` 但画面未改；只证明此脚本用例未执行，未实测网络资源隔离。本轮范围仅两文件及输出，无旧文件。

候选七[截图89](screenshots/89-candidate7-original-draft-restored.png)记录原全局草稿保留未发。[长等待审批起点](candidate7-delayed-approval-start.json)精确为17:50:53.339 CST（[截图90](screenshots/90-candidate7-delayed-approval-start.png)）：同一Codex请求只申请本轮 `candidate7-delayed-once.txt` 的单次touch批准，该请求保持至18:21:03仍待处理、目标不存在，累计1809.990718秒；随后主执行任务仅批准一次，18:21:11创建0字节目标并收到准确完成回复，详见下列独立时序。[官方只读核对](candidate7-installed-regression.md#批准并记住的只读范围核对)已确认allow_always可对应对话内许可或规则前缀等范围，不能推定为只记住唯一路径；本请求确切optionId尚未读取，所有扩大许可均不在本次授权内，未实施。

[17:48–17:49有界连接检查](pi-connectivity-check.md)另证当前官方公开端点存在传输障碍：三种地址族选择TLS失败，单次显式代理对照CONNECT503、目标TLS未开始；不归因17:02旧请求、不判账号/额度或永久能力不支持。官方接入包丢失失败语义继续独立记录。

候选七[安装身份](candidate7-installed.json)确认17:48:19替换唯一 `/Applications/Farfold.app`，0.1.7 / `ai.farfold.desktop`，SHA256 `a34a31e94cc0a7450683a3482295c20d64a310a7cfa4d6ba97c813bd29d3abf5`，首个进程PID70584于17:48:27启动；正常退出后，18:22:36明确重开为同SHA的PID73632。[最终冻结](candidate7-source-final.json)243文件一致，相对候选六7文件变化（3生产、3前端测试、1个Rust测试同步）；[初次冻结](candidate7-source.json)保留。前端59文件360项、后端同步修正后246项通过（3忽略）、类型、全仓格式、cargo fmt/clippy、打包及签名通过，完整安装包相同；精确重复.app于17:49:08移除，正式安装唯一。原全局草稿在界面完整保留、未发送。候选七已取得片段行号、版本意见归属与静态网页预览的局部现场结果（截图91–93），九轮计时、当前负载及双路完整窗口覆盖已独立核对通过，尚无完整旅程或全部性能预算通过结论；旧候选结果不转记本候选。 见[候选七回归](candidate7-installed-regression.md)。

候选七工程中的[原后端失败](checks/candidate7-cargo-test.log)保留为245通过、1失败、3忽略：恢复拒绝回执先唤醒测试，而同一会话的打开保留状态随后才释放；测试立即再次打开造成竞态。仅测试增加精确清理边界等待并加强原错误断言，生产代码未改；[五次定向](checks/candidate7-config-guard-targeted.log)和[全后端复测](checks/candidate7-cargo-test-after-sync.log)通过。该修正不掩盖原失败，也不以固定延迟或放宽生产保护通过测试。

## 候选六历史结果

[安装身份](candidate6-installed.json)确认17:30:50替换唯一 `/Applications/Farfold.app`，0.1.7 / `ai.farfold.desktop`，主程序 SHA256 `84ff5dd0708d73adf7c5d4c31924be6f42e4ed6bf2c025031f2811bbd92ae4d2`；PID65707始于17:30:53，243个冻结文件、签名和完整包均一致。安装前候选五PID62495所属[18个跟踪进程全部结束](candidate6-after-old-exit.json)，本轮精确重复打包.app已于17:31:18移除。候选六启动全局原稿完整可见、未发送；[候选六独立复验](candidate6-installed-regression.md)已确认当前轮范围、同路径版本及意见定位保护（截图82–85）；17:35仅输出轮次、切换对话和关闭重开仍定位该输出（截图86），V6B磁盘53字节及两行内容核对准确，图文草稿跨更新保留（截图87）。但真实编辑片段被误标为文件绝对行号（磁盘第2行显示第1行），这是候选六确定生产缺陷；候选七已完成通用范围判读窄修并安装，现场复验单列。候选六未启动性能计时、0轮，不做完整性能结论。17:40:58附近候选六已正常退出，[10个跟踪进程全部结束](candidate6-after-exit.json)；采集器PID52907正常exit0、7样本、storageFailure为空，0性能轮。[截图88](screenshots/88-candidate6-codex-cold-permission-paused.png)确认Codex冷恢复保留Ultra，继续前要求重新确认权限且发送禁用。该次退出后未再打开候选六，候选七随后独立安装。候选五任何旅程/性能结果均不转记候选六，原现场失败继续保留历史归属。

候选六[冻结243文件](candidate6-source.json)，相对候选五仅10文件变化（8生产、2新增测试）；前端59文件356项、后端246项（3默认忽略）、类型、格式、cargo fmt/clippy/Tauri打包通过。

## 候选五历史结果（含同候选冷恢复）

[安装身份](candidate5-installed.json)确认16:38:14替换唯一 `/Applications/Farfold.app`，PID58909始于16:38:25；0.1.7 / `ai.farfold.desktop`，主程序 SHA256 `b0d4cf6b47ff3fe175ad330d8d991bffd22b952307b6732deb603dfe63339d78`，241个冻结文件摘要、签名与包内容一致，[重复.app已删除](candidate5-duplicate-removal.json)。[源码冻结](candidate5-source.json)相对候选四仅13文件变更（目录8、历史5含新增测试）；前端57文件343项、后端246项（3忽略）、类型、[最终全仓格式](checks/candidate5-format-final.log)、cargo fmt/clippy及Tauri打包通过。

- [截图56](screenshots/56-candidate5-original-draft-preserved.png)确认原稿启动保留；后续从Amp新空白出口返回后按CmdN，原稿仍在，原文未发送。这不替代16:26已完成的精确只读核对。
- goose准确显示“当前尚不能在此安装”（[截图57](screenshots/57-candidate5-goose-install-limit-correct.png)）；准备页安装禁用，但官方入口及添加已安装程序出口保留（[截图58](screenshots/58-candidate5-unsupported-install-preparation.png)）。本次验证准确限制与可用出口，没有执行goose安装。
- Amp准确显示不支持恢复历史，没有无效重连（[截图59](screenshots/59-candidate5-amp-history-limit-correct.png)）；新空白对话出口可用（[截图60](screenshots/60-candidate5-amp-new-empty-exit.png)），未发送消息、索引79不变。不计Amp恢复或首发成功，不承诺旧正文已恢复。
- 候选五[性能独立核对](candidate5-performance-validated.md)及[数字证据](candidate5-performance-validated.json)确认三类模拟负载各3轮、正式9轮全部完成，每轮100输入/30切换，共900/270；各轮p95最高输入33ms、切换118ms，双64KiB三轮测量窗口完整处于两路持续输出期间。预热混合窗口不计正式矩阵。后续[采集元数据](performance-candidate5-perf.metadata.json)确认正常exit0、1335样本、storageFailure为空；16:47的1/9仅为旧快照。该结果只关闭候选五对应模拟计时矩阵，不代表全部性能预算、真实Agent并行或J1–J6通过。

候选五其他局部结果详见[安装回归](candidate5-installed-regression.md)：Codex一次命令审批、尾程保护/自然完成解除，OpenCode V5文件/意见、诊断本地导出及900×620表单边界分别留证。

候选五同候选冷恢复补证：[20个原进程身份全部结束](candidate5-after-cold-exit.json)，随后新实例PID62495仍为同SHA候选五，启动原因未确认。全局用户原稿保留未发送（截图74）；独立图文草稿（截图75）、未保存队列编辑（截图76）及V5文件第2行意见（截图77）恢复。编辑目标无法确认时只提供加入输入框，已加入并仅清理本轮编辑，原A-EDITED队列不变；重新确认权限后仍暂停，17:20手动继续才收到 `FARFOLD-C5-QUEUE-A-EDITED`。文件意见追加到已有PREFIX，两段同在且未发送，随后仅清理本轮输入；图文草稿继续保留备候选六更新。OpenCode17:22冷续问准确返回 `FARFOLD-INSTALLED-OPENCODE-20260927-OK`（[截图79](screenshots/79-candidate5-opencode-cold-continuation.png)）；Pi17:23冷后短消息四次重试仍无回答（[截图78](screenshots/78-candidate5-pi-cold-recheck.png)），网络层原因未知。Codex17:24冷续问准确返回 `FARFOLD-INSTALLED-CODEX-20260927-OK`，Ultra保留（[截图80](screenshots/80-candidate5-codex-cold-continuation.png)）。候选五OpenCode/Codex冷续问成功，Pi失败，分别记账。

候选五仍有真实失败：[Pi请求失败语义证据](candidate5-pi-failure-semantics.md)记录四次连接失败、零工具/目标回复；已安装官方接入包丢失结构化失败可解释界面结束表现，本次原始协议回执未捕获，不冒称逐字读取。不能计J4成功，也不按品牌/重试文字或私有历史兜底。另“本轮产物2”错误打开旧V1，手动选V5才正确，属于候选五安装缺陷。

17:26:58[官方发布核对](candidate5-pi-official-fix-status.md)仅覆盖当前登记的 `pi-acp` / `svkozak/pi-acp`：最新发布0.0.34及当时主分支仍缺失败语义，相关PR104/133均未合并、发布；未发现这一包已发布的对应修复。不以升级0.0.34作为已知修复，不执行未发布分支或修改外部Agent；Pi阻塞保留，网络层原因仍未知。

候选六确定生产缺陷是编辑片段误标文件绝对行号；候选七真实单行替换场景已复验修正（截图91/92）。其余能力按[九项只读复审分类](coverage-map.md#当前剩余工作分类)保留已有实现欠最终候选验证或外部条件，不继续把旧缺口误列待开发。当时下一步为候选七独立现场复验；候选六性能未启动、0轮，旧候选旅程和计时不转记新候选。

## 候选四历史结果（已正常退出）

15:01:17安装，新进程51630始于15:01:29；240个冻结生产源码/依赖/资源文件摘要一致，主程序 `e8a030bb776cf311059c46e5b5de30afd54474cf15377710eca9da452f9b39db`，签名与包内容一致，重复.app已删除。前端56文件329项、后端243项（3忽略）、类型、全仓格式、cargo fmt、clippy和Tauri打包均通过。见[candidate4-source.json](candidate4-source.json)、[candidate4-installed.json](candidate4-installed.json)、[candidate4-duplicate-removal.json](candidate4-duplicate-removal.json)及 `checks/candidate4-*`。安装前正常退出的15个本轮进程全部结束。

- 图片64x64.png、`FARFOLD-IMAGE-DRAFT-KEEP-20260927`文字、OpenCode选择和普通对话位置从候选3恢复，未自动发送（[截图40](screenshots/40-candidate4-image-draft-restored.png)）。此条仅记录跨候选草稿保全；候选四同候选冷恢复另见下面15:14–15:18补证。
- 原Codex审批对话恢复后权限必须重新确认，Ultra保持。新的单次touch审批真实显示完整命令、approval-cwd及可展开原始输入，仅含预期本轮空文件目标（[截图41](screenshots/41-candidate4-codex-command-approval.png)）。明确批准一次后目标文件确实存在且0字节，正文返回 `FARFOLD-CANDIDATE4-APPROVAL-OK`。未选择记住授权，不能据此关闭全部审批分支。
- 另一原Codex对话同样明确确认权限后启动sleep90/printf；加入本轮A并编辑为A-EDITED，保存后队列保持暂停。实际步骤开始后停止回复，横幅和1进行中保留、权限禁用。归档被阻止，显示明确“请先处理此对话的任务和未发送内容，再归档”（[截图42](screenshots/42-candidate4-archive-reason.png)）。
- Pi在上述尾程窗口返回原上下文标记，实际发送时AX观察到2进行中。[截图43](screenshots/43-candidate4-pi-during-tail.png)取得时Pi已经完成，不能单凭该截图证明并行；本次Codex时序文件也不独立证明另一Agent的请求时间。
- 尾程随后自然完成：官方记录15:04:39.888开始、15:04:47.624回复中止、15:06:09.772命令完成，exit0且stdout仅 `FARFOLD-CANDIDATE4-TAIL-20260927` 加换行。中止后仍执行约82.148秒，总时长约89.884秒。见[candidate4-tail-timing.json](candidate4-tail-timing.json)；该记录不是精确点击或UI绘制时间，也不表示命令被提前停止。现场随后可见尾程提示消失、权限恢复，A-EDITED队列仍暂停（[截图44](screenshots/44-candidate4-tool-ended-queue-paused.png)），完成本次自然结束后的解除保护观察。
- 15:08原OpenCode对话实际创建 `candidate4-opencode-note.md`，两行V4内容，并回忆原标记。本次只记录原对话工具/上下文继续，冷续问结果另记。

15:14–15:18同候选补证，详见[冷恢复与普通首发报告](candidate4-cold-and-first-message.md)和[截图45–52索引](candidate4-cold-evidence-index.json)：

- 15:14:12记录本轮22个进程，经应用正常退出后15:14:25均已结束；随后同SHA正式程序冷启动。图片、文字、OpenCode选择与普通对话位置恢复且未自动发送（截图46）。
- Codex未保存队列编辑恢复，目标不能确认时保存禁用、可加入输入框（截图47）；加入已有PREFIX后两段均在，原A-EDITED仍暂停。明确重新确认Ask for approval并取得真实回执后也不自动继续，手动继续才于15:16返回A-EDITED。
- 重新选择两行V4产物后，文件意见及“修改后·片段第2行”恢复；加入已有PREFIX只追加、不发送（截图48）。随后只清理本轮测试意见/前缀输入。
- 冷续问未再给原标记且禁止工具：OpenCode15:15、Pi15:16、Codex15:17均返回各自最初标记（截图49/50及报告）。只覆盖已有Big Pickle、GLM-4.5-Air/off、6 Astra/Ultra。
- 移除本轮图片草稿后，在普通新对话位置逐一首发，无工具、无文件读写；OpenCode/Pi于15:17、Codex于15:18分别返回 `FARFOLD-C4-FIRST-OPENCODE-20260927`、`FARFOLD-C4-FIRST-PI-20260927`、`FARFOLD-C4-FIRST-CODEX-20260927`，索引72→75。Codex先明确确认Ask for approval并等待回执（截图51）；没有新登录、新密钥保存、服务修改或权限提升。

[15:14:56数据快照](candidate4-data-preservation.json)原62/10/68条身份哈希全部保留，当前72/10/76；后续首发/性能样本不在该快照。[15:15:39文件核对](candidate4-integrity-now.json)原型161项及候选四源码240项均与清单一致。原用户草稿16:26已通过UI恢复文字和选择；[只读核对](candidate4-original-draft-restored.json)确认新草稿及选择精确匹配[保护记录](original-draft-preserved.json)，custom-/synthetic、普通位置、无服务、附件为空，其他草稿/意见/队列均0，原文未发送（[截图53](screenshots/53-candidate4-original-draft-restored.png)）。核对没有写DB。

性能已在1280×820逻辑窗口准备两组128KiB及两组1000消息模拟负载（[负载回执](candidate4-performance-loads.json)、截图52）。早前采集器跨进程时钟校验失败已窄修，20项纯数据测试通过；16:11的27样本/0轮次仅为历史快照。[history-r1](candidate4-performance-history-r1.json)于16:22–16:24得到100输入/15切换，p95 31/84ms，后半轮窗口切换打断、已结束，timingPass=false；[history-r2](candidate4-performance-history-r2.json)于16:31–16:32得到完整100输入/30切换，p95 33/111ms，前台/焦点排除0，timingPass=true。仅候选四一轮千条历史计时成功，不代表各场景三轮及总体性能通过；双路持续输出仍须独立证明。采集器随后exit0、storageFailure为空、最终280样本；候选四正常CmdQ退出，16:34:07[核对3个本轮进程全部结束](candidate4-after-final-exit.json)。

[中断与恢复记录](interruption-and-resume.md)保留15:24锁屏事实、2551.380秒事件空窗及原因未知；16:19后恢复执行，用户已明确允许继续界面验收，锁屏和窗口协调不再作为当前阻塞。此前0轮次与原稿未回填是当时状态，已由后续性能轮及16:26精确恢复证据更新。

候选四新增两项真实失败：[goose平台误归设备不支持](screenshots/54-candidate4-goose-platform-misclassification.png)、[Amp无历史恢复却提供重连](screenshots/55-candidate4-amp-unrecoverable-reconnect-conflict.png)。原失败按候选四保留；候选五修复及准确提示/出口的安装版复验见本页当前段落，不将历史失败改写为当时通过。

以下按候选保留原始历史记录，不拼接为最终全旅程通过。

身份见 `candidate1-installed.json`：0.1.7 / ai.farfold.desktop，主程序 `2e829735faa7ef22f4987eac452f7c791f0d09586fba070efad14637ab54cbaf`；229个源码/依赖/资源摘要匹配。唯一正式路径 `/Applications/Farfold.app`，重复打包应用已移除，见 `candidate1-duplicate-removal.json`。没有提交或重置既有工作区。

安装前后数据身份逐条一致：原62条对话、10个Agent、68条历史隐藏记录全部仍在，见 `data-pre-install.json` / `data-post-install.json`。不比较正常变化的更新时间，也不读取秘密或复制正文。

## 运行实例纠正与原草稿保留

第一次迁移后退出，未恢复原文本和选择。当时磁盘是新包，但运行实例始于05:39:54 UTC，早于05:42:01安装；05:43:09才出现下一次启动。故首次迁移和截图09不归为新候选成功或持久化故障，`candidate1-first-exit-processes.json`也只记录该旧实例的退出。旧实例被关闭状态检查唤起为现场操作推断，启动时间先后为日志观测事实。

真正的新候选进程35553始于13:43:09 CST。重新用界面粘贴原文并选择原Agent，`unsentWork.v1`已实际保存文字、`custom-`、模型`synthetic`，见 `original-draft-preserved.json`。正常退出后无正式应用或该实例子进程，再次启动原文 `FARFOLD-DRAFT-KEEP-20260926 (do not send)`、性能验收（模拟）、Synthetic load恢复，见截图10/11。原文从未发送。保全记录用于后续验收暂用输入框后恢复原文与原选择。

## 当前现场结果

- 发现页显示44个条目、10个已添加；搜索Codex后1个结果。版本区分Agent程序0.155.1和接入组件1.12.0，三阶段“连接程序→使用方式→确认使用”可见。实际检查连接成功后进入使用方式，沿用已有设置可进确认页。
- Codex已有账号、6 Astra的可选短测试准确返回 `FARFOLD-e86435d4-7179-4e72-833e-ac7ba7350965`，暂离准备页后可返回查看完整通过回执（截图13）。测试没有附带原草稿；返回新对话原文和性能验收选择保留（截图12）。点击使用不同Agent会先显示草稿冲突确认，选择返回原草稿后原文/Agent仍在。该短测试不替代普通输入首发、工具或历史验收。
- 诊断流程已现场完成“问题说明→真实预览→返回编辑→再次预览→确认导出→结果”。实际本机 ZIP 为 `/Users/tw/Desktop/farfold-diagnostics-20260927-055619-2.zip`，SHA256 `67ba54785b07bb66a7e72b8f6a4761e30c19e386e122a483498f67018d806150`；ZIP 可读取、用户说明与确认界面一致，记录见 [candidate1-diagnostics-export.json](candidate1-diagnostics-export.json) 和 [截图15](screenshots/15-candidate1-diagnostics-export.png)。包中有32份限量连接日志和白名单元数据，manifest记录10个Agent、63条对话。此处通过的是本机预览往返及实际导出；未测试过期、导出失败等分支，也不据说明匹配宣称逐条完成所有脱敏与快照一致性验收。
- API表单现场输入尚未加入列表的模型名称后，保存被阻止，保留输入并显示添加或清空的提示；取消编辑后旧服务条目保留。未保存新密钥、未读取模型目录或发送API测试，不能据此关闭密钥保存/轮换或Agent实际服务交付验收。
- 更新页真实显示更新来源未配置的状态；本轮未执行应用内下载和安装更新。LifeModel页显示尚未启用的静态声明，没有将入口显示记作采集、学习或注入成功。
- **候选1实测失败，源码已修、待候选2复验**：普通新对话选择Codex、验收目录、6 Astra/Ultra，明确设置Ask for approval并收到回执后，点击发送停留在原输入且没有可见错误。索引仍63，数据库原输入保留、sendPending=false；对应脱敏协议记录最后只有set_config_option及成功response，未有session/prompt，见 [失败记录](candidate1-permission-first-send-failure.json)。源码定位为空队列也被权限变更设置queuePaused=stopped，确认后未解除；首发被当成排队后再移除并拒绝。随后的内部草稿更换还可能清掉错误。当前源码已允许在空队列、无未知/待处理且发送条件满足时接纳用户明确提交的新消息，已有待发仍须另行继续；错误改按实际输入上下文保留，并已增加普通首发回归。候选1不含此修复，不能把该路径计为J2通过。

候选2待安装，需首先复验上述普通首发和错误保留，再按受影响范围核对已测路径。其余真实消息、权限效果、并行、工具审批、产物、冷续接及七域完整往返尚未完成。候选1局部成功、现场失败和源码修复分别保留；缺条件分支见 coverage-map，不以工程测试或不同候选的局部结果代替同一最终候选完整验收。

## 候选2安装与首发复验（进行中）

2026-09-27 14:05:13 CST替换唯一正式应用；新实例PID38514始于14:05:17。230个文件摘要与candidate2-source.json一致，主程序cf039899ec267552075289ed072ac07c5ae1f794fb3c0f78543c8076ee3e4682；签名、包一致性通过，重复打包应用已删除。前端49文件302项及类型通过；后端未变化沿用候选1工程结果。仅候选2新增普通首发/错误生命周期修复，候选1结果不等于候选2复验。原验收输入、Codex和验收目录/Ultra在重启后恢复。界面明确选择Ask for approval并应用后点击发送，已实际创建第64条索引并进入执行，等待正文。

### 候选2已观测（截至14:15 CST）

- Codex普通首发6 Astra/Ultra返回指定标记；Pi既有GLM-4.5-Air/off与OpenCode既有Big Pickle均返回各自标记。OpenCode另经过设置高级暂停当前证据目录→原稿保留/不可发送→明确恢复→手动首发成功。截图17/20；并行时序及数据身份见candidate2-runtime-evidence.json。
- Codex执行sleep90期间A/B两条排队，编辑A保存为A-EDITED仍暂停；切到Pi首发，界面曾显示2进行中，再返回Codex工具仍在执行。截图18拍摄时Pi已完成，不能单独证明并行。停止只结束回复：官方记录命令14:06:55开始、14:07:51回复中止、14:08:25命令自然完成（89.878秒、exit0）。不能写工具提前停止成功。步骤实时状态保留了实际尾程，但全局运行与生命周期保护尚待候选3修复。
- OpenCode通过实际写入工具创建installed-work/candidate2-opencode-note.md，内容精确核对52字节、两行正确；没有出现审批，因此不计J3审批通过。真实差异第二行可选，意见FARFOLD-FEEDBACK-KEEP-20260927保留未加入对话，截图21。
- 新草稿FARFOLD-DRAFT-FILE-KEEP-20260927+上述附件，Codex暂停A-EDITED/B和B-UNSAVED编辑稿，OpenCode文件意见共同保留到正常退出。跟踪14个正式应用及子进程全部退出，见candidate2-before-cold-exit.json/candidate2-after-cold-exit.json。
- 同候选冷启动，草稿文字/文件/目录/OpenCode选择恢复，截图22/23。Codex原历史与Ultra恢复；B-UNSAVED编辑稿完整但明确提示无法确认原目标，禁用保存，可加入输入框，截图24。背后原A-EDITED/B仍在，权限提示需重新确认、发送与队列继续禁用，截图25。明确选Ask for approval并取得回执后队列仍暂停；B-UNSAVED加入已有输入确实追加保留前文且不改原B。移除本轮B，再手动继续A-EDITED才实际发送。等待该次正文和其余冷续问。

候选2另已实测两处界面缺陷：OpenCode模式标题直出Session Mode；暂停工作位置后底部错误提示先选择Agent/准备Agent。候选3正在做通用修正。每个候选证据分开，最终复验仍未完成。

14:19补证：三Agent原上下文续问均返回最初标记，截图27–29；OpenCode文件意见文字/第二行定位恢复（26），加入已有输入仅追加且不发送。仅本轮3条可批量移至安装验收0927分组，cwd仍installed-work；OpenCode改名/收藏、Pi归档再恢复成功。侧栏OpenCode后列表Agent切Pi，标题/1条结果实际改Pi，无旧同维度叠加。原1个收藏变2、只新增本轮收藏；原分组不改。

14:23历史带入：Pi官方查找能看到本轮已建立样本（禁重复加入）和P1直接实验FARFOLD-P1-PI-274DBBE58B。选择后预览显示两条真实用户/Agent正文，未仅凭列表判成功；选中唯一P1样本加入显示已加入1条、同条checkbox禁用，索引67/Pi9；正在打开核对原模型信息缺失的限制。OpenCode查找只返回最晚09-25及更早条目，未找到本轮09-27，正在按真实接口范围调查，不能记全面列表成功。

## 候选3安装与针对性复验（进行中）

2026-09-27 14:39:36 CST替换唯一正式应用，PID46480始于14:39:48；237个源码/依赖/资源摘要一致，主程序07d20194162e37f2149ac755263397b6578fe2c6895fd08c68ea6e8892e664c2。签名和全部包文件一致；重复打包应用已移除，见candidate3-installed.json / candidate3-duplicate-removal.json。工程检查：54文件321项前端、242项后端（3项忽略）、类型、格式、cargo fmt、clippy及完整Tauri打包通过。不能用这些替代安装旅程。

14:40恢复后的本轮受控审批草稿、OpenCode选择和approval-cwd完整；67条既有索引、原2个收藏及本轮3条分组可见。提交read ../approval-source/read-once.txt后，实际工具读取成功、准确返回FARFOLD-APPROVAL-20260927-READ-ONCE，但没有请求审批，因此本次不计审批通过；索引增加为68。

14:41打开原Codex验收对话，历史正文/Ultra恢复，发送前再次要求重新确认权限。明确选Ask for approval→确认应用后才解除门槛。随后发出仅sleep90/printf的本轮无害工具请求，正在复验工具尾程。

14:42工具尾程：实际Bash步骤运行后停止回复，界面正确显示“回复已停止，仍有步骤未确认结束”、侧栏1进行中、权限禁用（截图32）；Pi在同一执行窗口成功返回原标记，发送时AX显示2进行中，截图31取得时Pi已完成，因此截图本身不作为双运行证据。归档请求被阻止且索引68不变，但只显示通用“操作未完成，请重试”（截图33）；定位为整理作用域丢弃具体异常，待候选4通用修正。随后本轮操作者按CmdQ正常退出，源码语义为保存后结束Agent进程，不是要求活跃任务退出确认；因此此次**没有继续观察到工具自然完成**，不能记为尾程自然结束解除保护已验证。将另做完整有界观察，不将此操作推断为产品退出失败。

14:45–14:46历史查找：显式installed-work查到4条，其中本轮标记对话已加入禁重复；改为real-agent-work/opencode-af9f2abeed后旧列表/预览/选中清空，主动查询只得P1样本。预览真实两条用户/两条Agent正文后选择并加入1条，索引69且重复禁用。打开能显示原历史，但原模型元数据无法确认，诚实暂停发送并提供新对话出口（截图34），不计该导入对话续发成功。新对话OpenCode选项标题已显示“工作模式”，官方值build保留。

14:47–14:48真实Codex命令审批：在approval-cwd新对话保留6Astra/Ultra、明确Ask for approval后，请求仅touch本轮相邻approval-source空标记文件的一次性审批。审批确实出现；切设置暂停该目录后返回，已有批准/拒绝仍可操作。**范围展示失败**：卡片只有Run command/运行命令；步骤详情只有terminalId，无法核对完整命令（截图35）。操作者选择拒绝，界面确认“已拒绝·已告知Agent/已停止”，目标文件仍不存在；没有批准或常驻授权。恢复此位置后未自动发送。正在定位官方是否提供字段，不能用原提示内容替代审批请求实际范围。

14:49–14:50 OpenCode真实审批成功：新普通对话（未选项目）请求读取同一个本轮approval-source/read-once.txt，官方确实请求访问该目录及具体文件；与此前从repo内cwd直接读取不请求审批的样本分开。窗口经可见界面拖动到900×620逻辑像素（截图1800×1240），点击“查看”后完整卡片及批准/记住/拒绝可见、长路径换行，无遮挡（截图36）。仅选择批准一次，界面标注Allow once，随后实际读取并回复准确标记。没有选择永久/会话记住，没有扩大到其他文件。

14:52仅附件首发：本轮attachment-only.txt已选后，临时移至同目录held名称（字节保留）。发送被阻止且附件/空文本保留，索引仍71；提示重新选择或移除，另有无关“去设置”入口需候选4窄修。恢复原路径后再明确发送，索引72，附件正文完整显示，OpenCode准确返回FARFOLD-ATTACHMENT-ONLY-20260927。标题为“新会话”，没有将空文字误判为空提交。随后新草稿文字FARFOLD-IMAGE-DRAFT-KEEP-20260927及仓库64x64.png已加入并保留，尚未发送。

14:54–14:56视觉局部：最小900×620窗口的审批查看、新草稿图片、设置深色可操作（截图36–38）。宽窗口尺寸以实际图像尺寸为准，系统缩放受当前可用桌面高度约束，不能写成精确1440×900。主题已从深色恢复原“跟随系统”。候选3更新页仍真实显示未配置发布通道；LifeModel明确尚未启用，不读取/采集/提供内容。
