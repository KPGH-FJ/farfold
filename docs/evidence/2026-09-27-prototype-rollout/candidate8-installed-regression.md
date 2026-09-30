# 候选八安装版独立回归

## 后续候选九当前状态

**原型主体已进入正式源码和安装版，完整交付未完成。** 当前唯一正式安装为候选九，SHA `242b9e8b21323d2c05d1c3025648931b0ff6ebcd434a03128763a6f211904d94`；245文件冻结匹配。正常退出后，同版本新PID80159于19:25:11启动，原全局草稿保留未发。

[候选九独立回归](candidate9-installed-regression.md)已记录焦点归还、真实IME确认/明确发送/Codex回复、中文换行和同版本冷草稿/权限恢复。九轮[独立性能审计](candidate9-performance-validated.md)及[采集收尾](candidate9-performance-finalization.md)通过：1170正式/1206完整样本，最高p95输入31ms、切换90ms，当前负载完整覆盖；只有一名独立审计者完成该项核对，不代替完整资源预算或J1–J6。[19:31:35最终保全](candidate9-data-preservation.md)及[字段核对](candidate9-data-preservation.json)确认原62会话/10Agent/68忽略记录身份全部保留，当前83/10/81；原全局文字、附件、Agent/位置/服务/模型/思考选择逐字段一致，未处于发送或首次发送未知状态。收藏2、分组总数2，成员分别1/3；此前“组3”指安装验收组内3条对话。历史完整分组成员没有逐项基线，外部正文和秘密未审，不称所有用户数据完整审计。245源码、原型选定161文件及4个安装摘要匹配，新PID80159与唯一正式App身份一致。

候选七、八的其余真实旅程保留各自归属，不转记本候选；[OpenCode两次429服务限流](candidate8-opencode-failure.md)与[Pi零回答连接失败](candidate7-pi-native-outcome.md)分开。完整键盘/文字放大布局/资源指标未完成，新登录、新API秘密、记住授权和真实签名发布源仍需条件。各候选失败及[C5原始起点受损](candidate7-capture-path-incident.md)不删除；不得据两文件增量误认今天主体仅实现两文件。

日期：2026-09-27。候选八仅修复中文输入法确认键误发送；本页不接收候选七的旅程和性能作为本候选通过证据。已取得组词确认/明确发送、队列编辑确认/保存及双审批隔离的局部通过；ceshi请求实际未完成。新发现权限弹窗关闭焦点未归还的实际缺陷，候选九随后已安装、具体焦点路径复验另列，完整交付仍未完成。

## 身份、修复和工程边界

[安装身份](candidate8-installed.json)：18:53:13.543 CST（10:53:13.543 UTC）替换唯一 `/Applications/Farfold.app`，0.1.7 / `ai.farfold.desktop`；主程序SHA256 `930e0e726806ccfc2799c1c99e045bdabffff1f23b867fd26ab66f39b0c56fe4`，PID76682于18:53:19启动。[源码冻结](candidate8-source.json)244文件，与候选七相比仅 `src/components/Composer.tsx` 和新增 `src/components/Composer.ime.test.tsx` 两文件：确认组词键的通用保护提前于菜单、准备与发送快捷处理，没有新增延时吞键或Agent分支。原型、模型、权限、依赖和Rust源码不变。[独立只读审查](candidate8-ime-review.md)无阻断发现，不替代真实输入法验收。

主执行任务已报告前端370项、类型检查、限定格式、打包和签名通过；[打包记录](checks/candidate8-build.log)及[格式收尾](checks/candidate8-format-final.log)保留。Rust沿用候选七对应未变化源码的246通过/3忽略证据，未声称本候选重新运行后端。完整打包文件与正式安装一致，精确重复打包.app已移除。安装前候选七[退出前跟踪](candidate8-before-install-exit.json)及[退出后确认](candidate8-after-install-exit.json)证明19个跟踪进程全部离开。

## 真实输入法确认与明确发送

1. [截图130](screenshots/130-candidate8-original-draft-startup.png)：候选八启动后原全局草稿可见，未发送。
2. [截图131](screenshots/131-candidate8-ime-composing.png)：在本轮测试对话真实逐键输入 c/e/s/h/i，出现“ce shi”中文组词状态。
3. [截图132](screenshots/132-candidate8-ime-confirm-not-sent.png)及[确认后状态](candidate8-ime-confirm-state.json)：一次Return仅完成确认，`ceshi`仍留输入框，没有新增用户消息。
4. [截图133](screenshots/133-candidate8-next-enter-sends.png)及[明确发送状态](candidate8-ime-explicit-send-state.json)：第二次普通Return发起18:54的`ceshi`请求，现场运行中。此处证明明确发送入口仍有效；18:55该请求显示“请求未完成”，不计Agent成功。

上述现场关闭候选七同一“组合态Return确认误发”的具体反例，结论仅限本次确认/再次发送路径。候选七[截图126](screenshots/126-candidate7-ime-composing.png)、[截图127](screenshots/127-candidate7-ime-confirm-unexpected-send.png)和请求未完成继续保留失败历史；Space组词和Shift+Return换行在候选七截图128属历史；候选八独立结果见截图136。

## 队列编辑与中文输入

[截图134](screenshots/134-candidate8-queue-ime-confirm-not-saved.png)及[状态](candidate8-queue-ime-state.json)：真实ceshi组词Return仅确认，仍在编辑器、不保存；[截图135](screenshots/135-candidate8-queue-save-paused.png)第二次Return才保存ceshi，队列仍暂停，没有自动发送。随后仅移除本轮自建队列项。[截图136](screenshots/136-candidate8-chinese-space-shift-newline.png)Space选中文词、Shift+Return只换行不发送，之后仅清本轮测试输入。

## 两个待回应目标与单次批准/拒绝

两个Codex对话冷恢复后分别明确重新选择Ask for approval并收到真实回执，Ultra保留。本次均为受控无害单命令，未使用记住授权。

- [137](screenshots/137-candidate8-two-approvals-input-focus.png)：两条真实审批同时存在。B输入框组词Return再Backspace后输入为cesh，两项仍待处理，没有误批。
- [138](screenshots/138-candidate8-deny-b-other-pending.png)：仅拒绝B，界面“已拒绝·已告知Agent/已停止”，没有 `FARFOLD-C8-DENIED-B` 助手正文，不伪造该回复标记。[139](screenshots/139-candidate8-a-still-pending-after-b-denied.png)A仍待批准。
- [140](screenshots/140-candidate8-a-approved-result.png)：A单次批准后18:58准确回复 `FARFOLD-C8-ALLOW-A`。
- [批准前](candidate8-approval-targets-before.json)18:56:27两目标不存在；[拒绝B后](candidate8-approval-after-b-denied.json)18:58:32仍均不存在；[效果](candidate8-approval-effects.json)确认A18:58:41.467736创建0字节文件、B仍不存在，`rememberOptionUsed=false`。

这些结果只证明本次两请求隔离、拒绝不影响另一待审批和单次批准对应效果，不推广记住授权或全部审批异常。

## 权限弹窗焦点归还缺陷

[焦点快照](candidate8-permission-keyboard-focus.json)与[后续快照](candidate8-permission-keyboard-followup.json)：弹窗初始焦点为取消按钮，Tab循环出现body/dialog但没有背景按钮；Esc关闭后未回权限触发按钮，再Tab到收起导航。独立源码核查确认选项先同步卸载，弹窗effect后记录的activeElement已为body。此为关闭焦点归还缺陷，不描述为背景焦点泄漏，不据此新加焦点圈定机制。

候选九仅窄修WorkspacePopover的显式children close：先同步focus现存触发按钮再关闭，并增加直接调用路径测试；外部点击/resize/unmount不加归还。候选九两文件已冻结：WorkspacePopover.tsx和新增WorkspacePopover.focus.test.tsx；一条反例先失败后通过，五项定向、全前端61文件375项、类型及两文件格式通过。以上是安装前工程证据；后续候选九独立现场复验见页首，不倒算为候选八通过。本轮只读caller挑战未发现覆盖既定焦点目标的反例；源码判断不替代候选九现场复验。

## 当前未达边界

队列与双审批已有上述局部结果；候选八两次OpenCode真实请求均失败：18:54明确发送ceshi后18:55未完成；19:01短标记后19:02未完成（[截图141](screenshots/141-candidate8-opencode-bounded-reply.png)、[状态](candidate8-opencode-reply-state.json)）。独立只读官方SQLite核对得到两次均OpenCode1.18.31、opencode/big-pickle、assistant error429、isRetryable=true、rate limit、parts=0，属于服务限流，不笼统记网络未知、不与Pi的Connection error混同。[限定官方记录核对](candidate8-opencode-failure.md)及[数据](candidate8-opencode-failure.json)另证parts/tokens/cost均0、无Retry-After或明确等待数字；该次协议返回未逐包捕获。不改模型或反复请求绕过限流。候选七全部性能、草稿/队列冷恢复、并行、诊断、历史与产物结果仍归候选七，本候选未计性能轮或完整J1–J6通过。

文字放大属于活动计划的布局检查维度；PRODUCT和当前原型没有明确要求新增字号设置。当前安装没有已支持的页面缩放入口，保持此项未测，不因验收列表自动新增产品设置。候选七[截图129](screenshots/129-candidate7-palette-escape-focus.png)仅证明搜索Esc返回输入焦点，不能替代候选八完整键盘或放大验收。Pi实际失败、扩大审批授权、新登录/API秘密交付与真实签名发布源的条件继续分别保留。

候选七Pi另有[自身失败结果核对](candidate7-pi-native-outcome.md)及[限定数据](candidate7-pi-native-outcome.json)：四次Connection error、零内容/用量；原始协议包未捕获，具体网络层未知，不转记候选八。
