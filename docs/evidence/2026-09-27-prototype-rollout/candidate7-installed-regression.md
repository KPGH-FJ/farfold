# 候选七安装版独立回归

## 后续候选九当前状态

**原型主体已进入正式源码和安装版，完整交付未完成。** 当前唯一正式安装为候选九，SHA `242b9e8b21323d2c05d1c3025648931b0ff6ebcd434a03128763a6f211904d94`；245文件冻结匹配。正常退出后，同版本新PID80159于19:25:11启动，原全局草稿保留未发。

[候选九独立回归](candidate9-installed-regression.md)已记录焦点归还、真实IME确认/明确发送/Codex回复、中文换行和同版本冷草稿/权限恢复。九轮[独立性能审计](candidate9-performance-validated.md)及[采集收尾](candidate9-performance-finalization.md)通过：1170正式/1206完整样本，最高p95输入31ms、切换90ms，当前负载完整覆盖；只有一名独立审计者完成该项核对，不代替完整资源预算或J1–J6。[19:31:35最终保全](candidate9-data-preservation.md)及[字段核对](candidate9-data-preservation.json)确认原62会话/10Agent/68忽略记录身份全部保留，当前83/10/81；原全局文字、附件、Agent/位置/服务/模型/思考选择逐字段一致，未处于发送或首次发送未知状态。收藏2、分组总数2，成员分别1/3；此前“组3”指安装验收组内3条对话。历史完整分组成员没有逐项基线，外部正文和秘密未审，不称所有用户数据完整审计。245源码、原型选定161文件及4个安装摘要匹配，新PID80159与唯一正式App身份一致。

候选七、八的其余真实旅程保留各自归属，不转记本候选；[OpenCode两次429服务限流](candidate8-opencode-failure.md)与[Pi零回答连接失败](candidate7-pi-native-outcome.md)分开。完整键盘/文字放大布局/资源指标未完成，新登录、新API秘密、记住授权和真实签名发布源仍需条件。各候选失败及[C5原始起点受损](candidate7-capture-path-incident.md)不删除；不得据两文件增量误认今天主体仅实现两文件。

## 后续候选八当前状态

上一候选八安装历史：[安装身份](candidate8-installed.json)确认18:53:13.543 CST替换、PID76682于18:53:19启动，SHA256 `930e0e726806ccfc2799c1c99e045bdabffff1f23b867fd26ab66f39b0c56fe4`。[冻结244文件](candidate8-source.json)相比候选七仅Composer通用确认键保护及新增IME测试；前端370项、类型/限定格式/打包/签名通过，Rust只沿用未变化代码对应的候选七证据。正式安装与完整打包一致，精确重复.app已移除，旧候选七19个跟踪进程全部退出。

[候选八独立回归](candidate8-installed-regression.md)：截图130原草稿保留未发；131真实逐键 c/e/s/h/i 进入“ce shi”组合态；132一次Return仅确认、`ceshi`留输入框且无新用户消息；133第二次普通Return明确发起18:54请求、当时运行中。对应确认/发送现场修复通过；18:55该ceshi请求显示“请求未完成”，不计Agent成功；候选七误发送保留失败历史，全部候选七旅程及性能不直接转记候选八。队列和双审批已取得局部结果，完整键盘与产品验收未通过；候选九现已安装，焦点归还本次复验另列。

候选八新增局部通过：[134](screenshots/134-candidate8-queue-ime-confirm-not-saved.png)队列编辑真实组词Return仅确认、不保存；[135](screenshots/135-candidate8-queue-save-paused.png)第二Return才保存且待发仍暂停，之后仅移除本轮自建项；[136](screenshots/136-candidate8-chinese-space-shift-newline.png)Space选中文、Shift+Return只换行不发，随后仅清本轮输入。两Codex冷恢复均明确重设Ask for approval取得回执、Ultra保留；[137](screenshots/137-candidate8-two-approvals-input-focus.png)两审批同时存在，B输入区组词确认和Backspace后仍两项待处理。仅拒绝B后，界面已拒绝/已告知Agent/已停止，没有虚构拒绝标记正文（[138](screenshots/138-candidate8-deny-b-other-pending.png)）；A仍待处理（[139](screenshots/139-candidate8-a-still-pending-after-b-denied.png)）。A单次批准后18:58准确回复FARFOLD-C8-ALLOW-A（[140](screenshots/140-candidate8-a-approved-result.png)）；[效果核对](candidate8-approval-effects.json)确认A18:58:41.467736生成0字节目标、B仍不存在，从未使用记住授权。

**候选八新缺陷：权限确认弹窗关闭未回原触发按钮。** [初始焦点](candidate8-permission-keyboard-focus.json)与[后续](candidate8-permission-keyboard-followup.json)记录Esc后回body、再Tab到收起导航；未观察到背景按钮泄漏，不误写为弹窗焦点隔离失败。独立源码核查已确认选项同步卸载后弹窗才保存焦点、得到body；后续候选九仅窄修WorkspacePopover显式关闭先还焦点及相关测试，现已安装并复验具体焦点路径；不倒算为候选八通过。候选八两次OpenCode真实请求均失败：18:54明确发送ceshi后18:55未完成；19:01短标记后19:02未完成（[截图141](screenshots/141-candidate8-opencode-bounded-reply.png)、[状态](candidate8-opencode-reply-state.json)）。独立只读官方SQLite核对得到两次均OpenCode1.18.31、opencode/big-pickle、assistant error429、isRetryable=true、rate limit、parts=0，属于服务限流，不笼统记网络未知、不与Pi的Connection error混同。[限定官方记录核对](candidate8-opencode-failure.md)及[数据](candidate8-opencode-failure.json)另证parts/tokens/cost均0、无Retry-After或明确等待数字；该次协议返回未逐包捕获。不改模型或反复请求绕过限流。候选七Pi已有[自身失败结果核对](candidate7-pi-native-outcome.md)，四次Connection error、零内容/用量；原始协议包未捕获、网络层未知，不转记候选八。

文字放大要求为布局验收，当前契约/原型没有明确新增字号设置的承诺；安装无已支持页面缩放入口，保持未测，不自动增加功能。候选七[截图129](screenshots/129-candidate7-palette-escape-focus.png)仅关闭其搜索Esc回输入焦点的小范围用例，不是候选八或完整键盘通过。

**18:42候选七历史失败：中文输入法确认误发送；后续候选八对应复验另列。** 在已清空的本轮C4 FIRST OpenCode测试对话，恢复输入方式后真实逐键输入 c/e/s/h/i；[截图126](screenshots/126-candidate7-ime-composing.png)显示带下划线的组合态，辅助功能值为“ce shi”。按Return后意外发送“ceshi”并于18:42启动真实Agent（[截图127](screenshots/127-candidate7-ime-confirm-unexpected-send.png)、[状态记录](candidate7-ime-confirm-state.json)）。原全局用户草稿未触碰。该现场反例已交独立负责人窄修；[截图128](screenshots/128-candidate7-chinese-space-and-newline.png)进一步确认真实逐键zhongwen后Space得到“中文”且未发送、Shift+Return只换行，排除仅以粘贴冒充组词；它不推翻Return确认“ce shi”误发的反例。误发的ceshi请求18:43显示请求未完成。仅本轮测试输入已清，回到原全局草稿；后续修复仍须新候选现场复验，不能把C7收口为通过。

最新历史查找：[截图123](screenshots/123-candidate7-history-scope-dedup.png)通过官方OpenCode接口限定本轮installed-work，已加入的原测试会话不可重复勾选且可打开；[截图124](screenshots/124-candidate7-history-empty-not-imported.png)预览本轮14:13空会话后如实报告无正文、未加入，没有新增或重复。随后恢复默认查找范围并关闭。截图107图文冷恢复验收完成后，只清理本轮自建C5图文草稿与附件引用，原图片文件未删；原全局草稿完整未发。[18:43:07独立数据保护快照](candidate7-data-preservation.md)与[逐字段结果](candidate7-data-preservation.json)确认原62会话/10Agent/68忽略记录身份全部匹配，当前83/10/81；原全局文字、附件及Agent/目录/服务/配置/模型选择精确一致，唯一新增字段sendPending=false。其他输入草稿、意见与队列均为0；原型161及候选七源码243文件在该时点匹配、PID73632同正式SHA。该快照不替代正文或秘密完整性，也不把随后授权修复倒算为用户数据损坏。

日期：2026-09-27。本页仅记候选七。安装及工程通过不代表真实请求、产物、冷恢复或性能通过；旧候选结果保留原归属。

## 身份与修复范围

候选七[安装身份](candidate7-installed.json)确认17:48:19替换唯一 `/Applications/Farfold.app`，0.1.7 / `ai.farfold.desktop`，SHA256 `a34a31e94cc0a7450683a3482295c20d64a310a7cfa4d6ba97c813bd29d3abf5`，首个进程PID70584于17:48:27启动；正常退出后，18:22:36明确重开为同SHA的PID73632。[最终冻结](candidate7-source-final.json)243文件一致，相对候选六7文件变化（3生产、3前端测试、1个Rust测试同步）；[初次冻结](candidate7-source.json)保留。前端59文件360项、后端同步修正后246项通过（3忽略）、类型、全仓格式、cargo fmt/clippy、打包及签名通过，完整安装包相同；精确重复.app于17:49:08移除，正式安装唯一。原全局草稿在界面完整保留、未发送。候选七已取得片段行号、版本意见归属与静态网页预览的局部现场结果（截图91–93），九轮计时、当前负载及双路完整窗口覆盖已独立核对通过，尚无完整旅程或全部性能预算通过结论；旧候选结果不转记本候选。

生产改动限 `artifacts.ts`、`artifact_view.ts`、`workspace_strings.ts`：协议diff原path/oldText/newText/source/status保留，未提供完整性或起始行保证时按片段坐标呈现，反馈中明确写“片段第N行”。静态网页预览仅对Agent返回的diff中具有完整HTML文档结构的内容开放，输入参数合成卡不开放；原sandbox/CSP不变，预览不等于磁盘文件当前状态。不按品牌、不读取磁盘补猜坐标、不改外部Agent。

相对候选六的7个文件变化包含3生产、3前端测试与1个Rust测试同步；后者不改变生产打包输入。完整变更清单见最终冻结。

## 原失败与后续通过分别记录

候选七工程中的[原后端失败](checks/candidate7-cargo-test.log)保留为245通过、1失败、3忽略：恢复拒绝回执先唤醒测试，而同一会话的打开保留状态随后才释放；测试立即再次打开造成竞态。仅测试增加精确清理边界等待并加强原错误断言，生产代码未改；[五次定向](checks/candidate7-config-guard-targeted.log)和[全后端复测](checks/candidate7-cargo-test-after-sync.log)通过。该修正不掩盖原失败，也不以固定延迟或放宽生产保护通过测试。

原失败定位 `config_guard_tests::persisted_effort_blocks_real_dispatch_and_legacy_confirmation_is_explicit` 第二次打开：第一次故意携带思考选项恢复而被拒绝；`operations::execute` 先发送终态回执，外层 `run` 返回时才释放打开保留状态。多线程接收者可先于释放再次打开。未发现保留状态泄漏，但回执不等于外层清理完成；现有 `discovery_tests` 已使用相同精确边界等待。

最小修正仅在该测试等待同一Agent/cwd/会话的保留状态可重新取得（3秒上界、yield而非固定sleep），并把首次拒绝从任意错误加强为确切“恢复会话不能修改模型或思考深度”。不增加真实打开重试、不放宽未知/关闭时的生产保护。原全套245通过/1失败/3忽略保留；修正后定向5次和全套246通过/3忽略另列。若今后要让对外回执承诺可立即再次打开，应另行处理终态完成顺序，不能据此提前释放未知或真实关闭中的保护。

## 已观察与仍待回执

候选七[截图89](screenshots/89-candidate7-original-draft-restored.png)记录原全局草稿保留未发。[长等待审批起点](candidate7-delayed-approval-start.json)精确为17:50:53.339 CST（[截图90](screenshots/90-candidate7-delayed-approval-start.png)）：同一Codex请求只申请本轮 `candidate7-delayed-once.txt` 的单次touch批准，该请求保持至18:21:03仍待处理、目标不存在，累计1809.990718秒；随后主执行任务仅批准一次，18:21:11创建0字节目标并收到准确完成回复，详见下列独立时序。[官方只读核对](candidate7-installed-regression.md#批准并记住的只读范围核对)已确认allow_always可对应对话内许可或规则前缀等范围，不能推定为只记住唯一路径；本请求确切optionId尚未读取，所有扩大许可均不在本次授权内，未实施。

候选七产物现场：[截图91](screenshots/91-candidate7-replacement-clearly-fragment.png)真实单行编辑明确显示“修改前/后·片段第1行”及非文件行号说明，17:50 OpenCode准确回复原标记；17:52完成V7B与HTML编辑并回复 `FARFOLD-C7-FILES-OK`。[截图92](screenshots/92-candidate7-version-and-feedback-return.png)同路径V7A/V7B往返时旧版隐藏新版定位，回新版保留 `FARFOLD-C7-FEEDBACK-KEEP` 与片段定位，留作冷恢复核验。[截图93](screenshots/93-candidate7-static-html-preview.png)完整HTML差异的静态预览显示 `FARFOLD-C7-STATIC-PREVIEW`，脚本尝试改为 `SCRIPT-RAN` 但画面未改；只证明此脚本用例未执行，未实测网络资源隔离。本轮范围仅两文件及输出，无旧文件。

候选六行号误标在上述候选七真实单行替换用例已复验修正；不推广为所有差异形状与文件操作。九轮计时、当前负载与三轮双路完整窗口覆盖已独立核对通过；独立核对时采集器仍运行，后已正常收尾为exit0/1207样本/无存储错误；资源/完整帧/长任务未测。

[17:48–17:49有界连接检查](pi-connectivity-check.md)另证当前官方公开端点存在传输障碍：三种地址族选择TLS失败，单次显式代理对照CONNECT503、目标TLS未开始；不归因17:02旧请求、不判账号/额度或永久能力不支持。官方接入包丢失失败语义继续独立记录。

继续保护原全局草稿和本轮图文草稿。其他不足按[九项分类](coverage-map.md#当前剩余工作分类)区分已有实现待最终候选验证及外部条件；Pi真实失败、官方发布语义限制、新账号/API秘密交付、记住授权及真实签名更新等不假记完成。完整J1–J6及最终交付仍未通过。

## 批准并记住的只读范围核对

已读取当前安装包 `@agentclientprotocol/codex-acp` 1.12.0 的非秘密程序文件：[dist/index.js](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/codex/1.12.0/node_modules/@agentclientprotocol/codex-acp/dist/index.js:25747>)，并独立核对同版本[官方选项映射](https://github.com/agentclientprotocol/codex-acp/blob/v1.12.0/src/permissions/options.ts#L22)。`allow_always` 是选项类别，不是唯一路径承诺。

| optionId                           | 返回给Codex的decision                       | 范围                                                    |
| ---------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `allow_once`                       | `accept`                                    | 本次命令请求                                            |
| `allow_for_session`                | `acceptForSession`                          | 本对话内同命令；额外权限/网络上下文对应那些权限或该host |
| `accept_execpolicy_amendment`      | `acceptWithExecpolicyAmendment`及原提议前缀 | 命令前缀规则                                            |
| `apply_network_policy_amendment:N` | 原网络策略决定                              | 对该host的后续许可/禁止                                 |

[官方返回处理](https://github.com/agentclientprotocol/codex-acp/blob/v1.12.0/src/permissions/CodexApprovalHandler.ts)只按收到的原optionId查原decisions，返回 `{decision: selectedDecision}`；取消或无法匹配则取消。已装文件26077–26095、26141–26145对应同一处理，不按按钮kind或提示文字另猜范围。

`acceptForSession`也不能夸大为整段对话内任何命令：官方[命令批准缓存键](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/runtimes/unified_exec.rs#L87)还包含命令、目录、环境身份、可执行程序、tty及权限；[会话缓存](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/sandboxing.rs)仅对匹配键复用批准。

当前待审批请求的完整options/availableDecisions未在这次只读调查中取得，不能判断泛化“批准并记住”实际对应上述哪项。此次明确禁止会话/前缀许可，故任何扩大许可选项均不能点击，也不能描述为只记住这个文件。主执行任务后来按既有计划仅选择原allow_once，18:21单次批准结果见下节；没有选择扩大许可。本调查没有操作UI、发Agent请求、改配置/凭据或实施任何权限决定。

## 九轮计时与证据事故

候选七[独立核对](candidate7-performance-validated.md)及[逐项来源](candidate7-performance-validated.json)于18:12:44 CST确认三场景各3轮计时、当前负载与三轮双路完整窗口覆盖通过：每轮100输入/30切换，共900/270，最高p95输入34ms、切换93ms，焦点/可见性排除0；当时完整raw为1201样本，其中1170正式样本。双路窗口22.611/22.420/22.516秒，最早完成仍晚于所属轮次结束13.896秒；不声称逐毫秒持续交付。PID70584、启动身份、安装包及243源码一致，原始[九轮数字报告](candidate7-performance-nine-rounds.json)保留。采集器当时仍running、未finalized；资源、完整帧、长任务等未测，不代表完整性能预算或J1–J6完成。

采集助手发生真实证据事故：18:01:28 CST（10:01:28 UTC）旧 `beginDualRound` 闭包把 `performance-candidate5-perf-dual64-r1-start-state.json` 覆写为候选七未计时观察；旧身份保护阻止后续round边界写入。候选五九轮在当时已独立审查通过，但这一原始起点当前受损，不能宣称现在完整重查仍通过，也不能把候选七内容冒充候选五原证据。[独立事故核对](candidate7-capture-path-incident.md)确认该起点7820字节旧摘要与当前7458字节不匹配，其他10项来源匹配，另一个元数据变化属于正常退出收尾；限定18文件及原Git路径未找到完整原件。候选七前6静态轮不受影响，之后固定候选七路径、独占创建的自包含助手重做C7-LIVE-R1/2/3三轮，其当前标记、负载与完整测量窗口已独立核验。误写尝试无正式轮次，不补作任何候选的通过证据。

## 准备页返回与当前待回执

候选七界面补证：[截图94](screenshots/94-candidate7-unavailable-install-preparation.png)goose未连接的准备页不能继续；选择暂时返回后，[截图95](screenshots/95-candidate7-preparation-returns-draft.png)原输入与原Agent选择保留。原全局用户草稿18:11已恢复、未发送。18:16 fresh界面确认纸白已选；此前深色后检测到用户界面切换，该次缩窗未成功，不作小窗证据；后续截图117–119另记真实小窗结果。两条普通新对话首发已读到真实完成回复：OpenCode18:09准确返回 `FARFOLD-C7-FIRST-OPENCODE-20260927`（[截图96](screenshots/96-candidate7-opencode-first-message.png)），Codex18:11准确返回 `FARFOLD-C7-FIRST-CODEX-20260927` 且Ultra保留（[截图97](screenshots/97-candidate7-codex-first-message.png)）；两次无工具、无文件，不代表新账号认证成功。18:17 OpenCode仅printf轮次已完成，准确回复 `FARFOLD-C7-OUTPUT-DONE`；[截图98](screenshots/98-candidate7-output-only-current-round.png)点“本轮产物1”只显示命令输出 `FARFOLD-C7-OUTPUT-ONLY`，没有旧文件。[截图99](screenshots/99-candidate7-image-draft-before-cold.png)确认自建C5图文草稿在候选七完整保留未发。发送管理选中并核对本轮approval-cwd后，仅暂停该目录Codex；[截图100](screenshots/100-candidate7-scope-paused-approval-available.png)及[状态记录](candidate7-scope-paused-state.json)确认原17:50审批仍可批准/拒绝，A-EDITED待发仍暂停，输入区提供目录恢复入口且原稿保留。18:19:42目标 `candidate7-delayed-once.txt` 仍不存在，已等待1728.678秒，尚未批准；这是批准前快照，后续一次批准结果单列。

## 长等待单次批准与正常退出冷启动

候选七长等待审批闭环：[批准前核对](candidate7-delayed-before-allow-once.json)于18:21:03确认等待1809.990718秒、目标仍不存在；[明确单次批准](candidate7-delayed-approval-action.json)后，[文件效果](candidate7-delayed-command-effect.json)确认18:21:11创建0字节目标，[截图101](screenshots/101-candidate7-delayed-approval-completed.png)显示准确回复 `FARFOLD-C7-DELAYED-APPROVAL-OK`。目录当时暂停但原审批可完成；随后点击输入区恢复目录，A-EDITED队列仍暂停，没有自动发送。该结果只覆盖同一请求等待超过30分钟后单次批准，不覆盖记住授权或其他异常。

[截图102](screenshots/102-candidate7-unsaved-queue-before-cold.png)保留未保存队列编辑 `C7-QUEUE-EDIT-UNSAVED`。18:22:10进程快照后正常CmdQ退出，[退出后核对](candidate7-after-cold-exit.json)确认20个跟踪进程全部结束且无正式应用进程；[采集收尾](performance-candidate7-perf.metadata.json)为exit0、1207样本、storageFailure为空。确认无正式进程后，明确UI重开，[冷启动身份](candidate7-cold-relaunch.json)记录PID73632始于18:22:36、同SHA；[截图103](screenshots/103-candidate7-original-draft-after-cold.png)原全局草稿保留、83条对话、未发送。后续冷恢复：[截图104](screenshots/104-candidate7-unsaved-queue-after-cold.png)未保存队列编辑全文恢复，原目标无法确认时保存禁用、仅可加入输入框；[截图105](screenshots/105-candidate7-cold-permission-pauses-queue.png)加入成功，原A-EDITED队列不变，权限未知、队列暂停、发送禁用，Ultra保留。仅清理本轮未保存编辑后，明确选择Ask for approval并确认应用取得真实回执；[截图106](screenshots/106-candidate7-confirmed-permission-queue-still-paused.png)队列仍暂停。18:24随后手动继续，[截图110](screenshots/110-candidate7-queue-manual-continue-result.png)准确收到 `FARFOLD-C7-QUEUE-A-EDITED`，队列清空、Ultra保留；只计手动继续成功，不计自动发送。[截图107](screenshots/107-candidate7-image-draft-after-cold.png)图文草稿正文与64×64图片冷恢复完整、未发送。意见冷恢复：[截图108](screenshots/108-candidate7-feedback-after-cold.png)经显式全会话产物入口选 `candidate6-opencode-note.md`，查看V7A后回V7B，原C7意见与修改后片段第1行定位恢复；[截图109](screenshots/109-candidate7-feedback-appends-without-send.png)加入已有C7-PREFIX，两段与片段定位均保留、未发送，随后仅清理本轮输入。冷历史未提供本轮范围按钮，不假称旧轮次范围恢复。OpenCode18:26准确返回最初 `FARFOLD-INSTALLED-OPENCODE-20260927-OK`（[截图111](screenshots/111-candidate7-opencode-cold-continuation.png)）；Codex18:27准确返回最初 `FARFOLD-INSTALLED-CODEX-20260927-OK`、Ultra不变（[截图112](screenshots/112-candidate7-codex-cold-continuation.png)）。Pi18:28冷续问经过2/4/8秒三次重试后显示恢复及已完成，但没有目标回答；[截图115](screenshots/115-candidate7-pi-cold-message-no-answer.png)与[状态记录](candidate7-pi-cold-state.json)明确记本候选真实失败，不能继续列未测或成功；不据此归因网络层。

## 最终采集收尾及真实工具并行边界

性能后续[独立收尾核对](candidate7-performance-finalization.md)及[数字证据](candidate7-performance-finalization.json)于18:32:42 CST确认最终exit0、1207完整样本、storageFailure为空；原1201条完整前缀、18条边界及其余冻结输入未变，新增6条均在正式轮次之外。九轮900/270与最大p95 34/93ms重算通过，采集锁释放、原20进程及采集器PID70579均结束，同SHA新进程73632确认。原18:12运行中报告保留历史时点；资源、完整帧、长任务仍未测，不升级为真实AgentJ4或完整J1–J6通过。

候选七真实并行与停止边界：[停止前进程](candidate7-two-real-tools-before-stop.json)于18:29:42确认Codex sleep90与OpenCode sleep60同时存活（[截图113](screenshots/113-candidate7-two-agents-running.png)2进行中）。停止Codex回复后，[18:30:06进程快照](candidate7-after-stop-processes.json)仍见两条sleep；[18:30:15界面](candidate7-after-stop-state.json)及[截图114](screenshots/114-candidate7-tool-tail-unconfirmed.png)显示步骤正在处理、回复已停止、权限禁用与空输入发送禁用。OpenCode18:30准确返回 `FARFOLD-C7-OPENCODE-PARALLEL-OK`（[截图116](screenshots/116-candidate7-opencode-parallel-completed.png)），停止A未打断B。18:30:40才输入TAIL-DRAFT，距90秒开始已约93秒，不能用此时可发送证明尾程期间非空发送绕过保护；当前没有这类实际反例。尾程说明位于历史顶部、截图底部未见该解释，不能记当前位置说明已可见；也不把回复停止当作子命令被提前终止。

只读源码核对：当前[工具活动](../../../src-tauri/src/acp_client/tool_activity.rs)保留待完成步骤及工作保护，直到官方completed/failed或真实进程结束；[停止处理](../../../src/runtime/sessions.ts:956)暂停原队列，停止未确认由[canDrain](../../../src/runtime/queue.ts:19)阻止实际派发。确认回复停止后，已知仍在执行的步骤不阻止显式续问，这是[前端既有回归](../../../src/runtime/sessions.tool_activity.test.ts)与[后端既有回归](../../../src-tauri/src/acp_client/tool_activity_tests.rs:80)明确覆盖的行为；权限变更、归档、关闭等继续受保护。此项只读检查未改源码、未发送请求、未重跑测试，不将既有测试冒充本次安装版非空输入验收。

[尾程解释的位置](../../../src/components/ThreadView.tsx:420)在所有历史消息之前；截图114位于历史底部，仅显示当前步骤仍在处理与回复已停止。因此没有证据说明活动状态丢失，但该说明在当前视窗不见，保留呈现边界。停止后18:30:06的子命令存活与18:30:15的界面是两个不同时间快照，不伪造同一原子观测。

## 小窗口、诊断与本轮整理操作

候选七小窗口局部验收：1800×1240物理像素对应900×620逻辑尺寸。[截图117](screenshots/117-candidate7-minimum-file-panel.png)文件面板可读且关闭可回对话；[截图118](screenshots/118-candidate7-minimum-dark-settings.png)深色通用设置排版与控件可用；[截图119](screenshots/119-candidate7-minimum-api-cancel.png)API添加空表单底部取消与禁用保存可见，随后取消，未输入秘密、未保存。已恢复18:16续接时的纸白选择和1280×820窗口。此时尚未测中文输入法组词；后续18:42已发生确认组词误发送，详见最新失败。文字放大、完整资源/帧/长任务仍未测。

[截图120](screenshots/120-candidate7-diagnostics-exported.png)诊断导出成功，本轮新ZIP已从桌面精确移入本地证据目录；[candidate7-diagnostics.zip](candidate7-diagnostics.zip)已由[独立只读检查](candidate7-diagnostics-check.md)及[结构结果](candidate7-diagnostics-check.json)确认36条目、32份日志共9219条摘要通过字段/类型/枚举允许列表、尺寸和排除规则，原ZIP不变；没有用户自填说明，不推广为任意输入都会脱敏。[截图121](screenshots/121-candidate7-rename-favorite-group.png)仅本轮C7 FIRST OpenCode对话改名“C7整理验收”、收藏、加入既有安装验收组成功；[截图122](screenshots/122-candidate7-own-archive-restore.png)仅选该一条归档，再从已归档恢复，现场计数83条/收藏3/安装验收组内4条。该快照后已仅撤销本轮的分组、收藏和改名，精确恢复C7 FIRST OpenCode原名；现场回到83条/收藏2/验收组内3条。

[工具结束核对](candidate7-bounded-tools-finished.json)确认本轮两条sleep均已结束；这是后续自然完成的核对，不把停止回复解释为立即终止子命令。
