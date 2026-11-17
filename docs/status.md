# Farfold 当前状态

2026-11-15 首发范围更新：Kimi CLI Legacy（`kimi`）因厂商停止维护，从源码首发目录、安装入口及整家验收范围移出。当批正式候选实装目录为 28 家，按原八项验收。已有登记、程序、配置、历史与旧证据保留。[首发名单](agent-first-release.md) · [本批实装](evidence/2026-11-15-cycle7-acceptance/README.md)

2026-11-15 首发范围续调：按用户授权从源码首发目录移出 Nova。官方现行 1.1.65 的 V1 权限分支仍不兼容；用户保存后结束原设置终端，正式 1.1.49 仍显示需要登录。本机正式入口已核 27 项且 Nova 退出目录；原 28 家验收和已有登记、程序、配置、历史保留。[范围](agent-first-release.md) · [核验](evidence/2026-11-15-cycle12-continuation/README.md)

2026-11-16 首发范围续调：按用户决定保留 Qoder CLI，将 Qwen Code 移出源码首发目录、新接入入口和整家验收。当时首发 26 家，保留 Qwen Code 已有登记、程序、配置、凭据、对话和历史证据。[范围](agent-first-release.md) · [逐家验收](evidence/2026-11-15-cycle12-continuation/acceptance-roster.json)

2026-11-15 存储恢复：精确清理 8,697 个旧单链接编译对象，删除窗口内可用空间增加约 18.00 GiB。源码、Git、正式应用及证据核对保持，复核时约 19.23 GiB 可用。清理后已恢复第7周期开发验证。[维护记录](maintenance/2026-11-15-storage-cleanup.md)

2026-11-15 官方替代核验及后续结果：Amp、fast-agent、Pi 保留首发候选，三家八项仍逐项验收。

- **Amp**：厂商 CLI、SDK 和公开接口有原线程查询、读回及续接路径。第 12 周期已通过厂商 CLI 登录和 MiMo 实测，显式模型续答及未映射的厂商旧线程带入仍待，见下文。所核 SDK 的取消信号只到本地 CLI 进程，原任务实际停止和可传入 Farfold 的审批仍待证。厂商已撤下真分支，按 P11／ARCH-33 保留该官方缺口。[核验原件](evidence/2026-11-15-official-alternatives/amp.md)
- **fast-agent**：同安装 0.10.1 的官方终端委托在受控样本中已证 Farfold 可精确终止自己持有的命令并保留另一会话。用户已批准按产品契约 §11 逐次审批官方工具终端。本机正式版限定已登记的 macOS fast-agent 对话启用。实际审批列出程序、参数、工作目录；一次批准后运行，按钮停止实测 Shell 与子进程退出，同版正式复验两条任务同时运行：A 被停止，B 保持实际执行并自然完成；A 退出冷开同原对象后准确续答。工具实时终态仍未知。 [组合实测](evidence/2026-11-15-cycle12-continuation/README.md) · [审批实测](evidence/2026-11-15-cycle12-fast-approved/README.md)。Agent 自管、持久及外部工作仍需可控制原任务的官方入口。旧正式停止失败保留。[第 12 周期续验](evidence/2026-11-15-cycle12-followup/README.md) · [核验原件](evidence/2026-11-15-official-alternatives/fast-agent.md)
- **Pi**：官方 1.5.2 SDK 受控验证双会话的 MCP 访问、拒绝、撤回后失效、冷开原 ID 和隔离停止；现选 0.87.1 与目录适配器 0.0.34 的缺口仍在。Farfold 可研究原生官方接法，先用原对象核版本身份、权限、回收及许可范围。[核验原件](evidence/2026-11-15-official-alternatives/pi.md)

2026-11-13 批次记录。**当时正式版对应 9f08c7cfd，第 6、7 周期的完整原条件仍未全部通过。** 本批新增按已知标识带入历史，修复常用指令和历史读取的键盘焦点、网页保护输入拒绝说明，均有正式分项；Goose真实旧正文已读取并明确加入。OpenCode小米MiMo待确认通知出现一次、点击回原对话，实际声音被macOS的displayShared抑制。用户暂缓旁白，具体依赖及未覆盖条件分列。原 151 条与当时逐家八项的证据保留。[唯一计划](../plans/agent-access.md) · [本批证据](evidence/2026-11-13-cycle67-closure/README.md)。第5周期两种正式在途取消仍未验，原专项收口依据保持。

**11月13日历史恢复修复已完成正式复验。** 用户批准的同安装官方 fast-agent 只读导出接回普通冷开；原正文、工具、截图及模型选择保持。双浏览器受控、独立复核及七项工程通过（2,589输入稳定；前端10,770项，Rust2,764过/11忽略）。e32此前旁白实听仅确认导航标签，准确结果句仍未确认；Goose此前旧工具名4次无效调用保留，后续新名称的单次许可和通知正例不倒填旧失败。临时提醒与旁白偏好已恢复。[分层证据](evidence/2026-11-13-cycle7/history-supplement-summary.json)。

2026-11-16 首发范围续调：用户决定将 DimCode 移出首发、新接入和整家验收。当批正式版目录与新对话选择器已核为 25 家，保留已有程序、登记、配置与历史。[范围](agent-first-release.md) · [实装](evidence/2026-11-16-cycle12-service-diagnosis/results.json)

2026-11-16 首发范围续调：按用户决定将 Factory Droid 与 Poolside 移出首发目录、新接入入口和整家验收。当时正式版探索目录与新对话选择器已复验，首发剩 23 家。两家的程序、登记、配置、凭据、历史和旧证据保留。[范围](agent-first-release.md) · [当前验收表](evidence/2026-11-15-cycle12-continuation/acceptance-roster.json) · [正式复验](evidence/2026-11-16-cycle12-retire-poolside-factory/README.md)

2026-11-16 首发范围续调：按用户决定将 Kimchi 移出首发目录、新接入入口和第 12 周期整家验收，正式版探索目录显示 22 家，新对话选择器搜索 Kimchi 无匹配。已有程序、登记、配置、凭据、历史和旧证据保留。[范围](agent-first-release.md) · [当前验收表](evidence/2026-11-15-cycle12-continuation/acceptance-roster.json) · [正式复验](evidence/2026-11-16-cycle12-retire-kimchi/README.md)

2026-11-17 首发范围续调：当前已选的本地 Onde 模型找不到，且未发现可用且已选的兼容服务。依用户授权将 siGit Code 移出首发目录、新接入入口和第 12 周期整家验收，正式版已复验 21 家。探索和新对话入口搜索均无匹配，已有程序、登记、配置、凭据、历史和旧证据保留。[范围与依据](evidence/2026-11-17-cycle12-retire-sigit/README.md) · [正式复验](evidence/2026-11-17-cycle12-models-and-sigit/README.md#正式安装与-21-家目录)

## 正式应用与最近功能基线

| 范围           | 当前核对结果                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 12 周期基线 | 当前安装 `a036904e1`，21 家八项续验，整家通过 0/21。Mistral 审批卡直接显示命令有证，Kilo 与 Dirac 替代路径精确交付，MiniMax 前台早停和冷续答通过。各家旧失败按路径保留。                                                                                                                                                                                                                    |
| 唯一正式应用   | `/Applications/Farfold.app`，`ai.farfold.desktop`，0.1.7，macOS arm64。CDHash `3a0a31f4d81fd0b19866dff0d610c610a1b22e56`，可执行文件 SHA-256 `6f73b4e054a3298a8ef974794813294e6c4240f872309647efd38938e9aa2fe5`。首发目录 21 家。                                                                                                                                                           |
| Mac 工程与安装 | 2026-11-17 审批命令与换行续验，前端 10,978 项、Rust 2,814 项（11 项既有忽略）、格式、类型、Clippy、生产构建、内部打包及独立复核通过。两次正常保存退出、安装前三处数据 247,491 项前后摘要一致，SQLite 副本通过。[最新正式回执](evidence/2026-11-17-cycle12-approval-and-lf/README.md)                                                                                                        |
| 当前开发环境   | macOS 27.0（26A425），Node 22.22.3、锁定 pnpm 9.15.0、Rust/Cargo 1.96.0、Xcode Command Line Tools 可识别。[环境恢复证据](evidence/2026-11-04-development-environment-restoration/README.md)。                                                                                                                                                                                               |
| Windows        | 最后完整 CI 成功为固定源码 `2e23056cc` 的 [41931045918](https://github.com/KPGH-FJ/farfold/actions/runs/41931045918)，含未签名 NSIS 构建。后续固定 `5598138f2` 定向原生 30 项、前端 20 项通过。安装修复版 `5b9f1449a` 的 [41984263036](https://github.com/KPGH-FJ/farfold/actions/runs/41984263036) 因付款或支出额度未获运行机器；安装、卸载及桌面流程未执行，当前源码未重跑 Windows 全量。 |

**11月11日空间清理。** 精确删除34,160条可重建编译文件路径，22条硬链接未闭合路径保留；删除窗口内可用空间增加约30.92GiB。未选中工程文件、源码、Git、正式应用、证据和备份强校验前后相同，应用数据/日志元数据相同。[清理记录](maintenance/2026-11-11-storage-recovery/README.md)。619份安装清单另经全量字节与必要属性核合，607份透明压缩减少25.80GiB分配空间，其余12份保留；原路径与引用不变。19:27复核时约60.40GiB可用。后续编译会重新占用部分空间，不把当时可用量当持续保证。

**第5周期补验与出口。** 原2,531个工程输入中，仅文件复制模块增加`cfg(test)`测试入口，其余输入逐项SHA相同；正式程序SHA未变。真实后台IO一次通过，取消后完整恢复；受影响模块24项通过/1手动用例常态忽略，Rust格式通过。真实WebKit/React/Worker单次18项通过；双路独审通过。已有完整工程与正式证据按未变输入复用，本次零模型请求、零正式启动，无需重新打包安装。[收口记录](evidence/2026-11-12-cycle5-closure/summary.json)。

**第6周期现按原阶段范围收口，第7周期可执行交付已补齐一批，完整条目仍保留具体余项。** Goose共用网页许可、同请求PNG、撤回和取消的既有正式分项保持。OpenCode此前沿已有Big Pickle/build选择只发一次公开页请求，184秒内未出现回复、工具或审批，正常停止后无可展示结果；精确原生记录已有用户消息，不能归为发送前丢失。后续从同一精确SID原日志查得build/title均报告免费额度已用尽，早于取消；没有HTTP状态证据，当前额度未重探；本次原ACP错误包缺失，无法判断传递，不重试或换模型。fast-agent/Mistral新macOS连接已完成无秘密多连接及正常ACP入口接线，独审和完整工程通过并安装。两家零发送正式阶段各自就绪及正常退出；fast-agent随后单次真实网页截图经两层单次许可完成，未留下持续页面授权。Mistral随后经用户明确追加的一次请求也完成网页调用，冷开可恢复正文及工具步骤；初次PNG未作为图片展示，后续16ee已修并正式零发送复验图片及原字节ZIP。两家正例不证明其他停止/恢复组合或整家通过。Pi缺官方路由、Codex受NEW-24限制；该时点 Mistral 的原单次及追加单次均已用，第 12 周期已获后续实测授权。搜索/整理/导出正式结果及本轮五家只读调查见[本批记录](evidence/2026-11-13-cycle7/README.md)，原完整要求保持。

**11月13日编译空间恢复。** 精确清理5,862个超过一小时的单链接Mach-O编译对象，仅位于`src-tauri/target/debug/deps`；实测可用空间约2.37→14.38GiB。源码、应用、数据与备份不在删除清单；四个明确保护文件摘要前后相同，未声称全量数据重验。[本批清理记录](evidence/2026-11-13-cycle7/storage-summary.json)。

## 第6、7周期出口与具体余项（2026-11-15复核）

用户于11月13日明确暂缓旁白部分，继续其他第6、7周期开发；旁白实听与准确结果播报保留未验证，不作为本轮推进阻塞。键盘、焦点、主题和窗口布局继续。

**第 7 周期按既定阶段范围收口。** 第 7 周期五家按各自证据或具体依赖留档，完整条目中的其余组合、自然满 30 天样本和逐家首发验收继续按原条件跟踪。

**第 8 周期按既定阶段范围收口。** 在正式版核实 1,000 条历史的正常打开和完整搜索、双 Agent 实际并发任务及工作目录边界。从同一对话分别核实在途 Wi-Fi 关闭恢复、等待提问时真实整机休眠唤醒及原轮完成。安全回收沿用既有明确原件和本批保护复验。五家按具体样本或官方依赖留档。[第 8 周期回执](evidence/2026-11-15-cycle8-observation/README.md) · [五家待验条件](evidence/2026-11-15-cycle8-intake/README.md)

**第 9 周期暂停。** 用户要求第 10–12 周期的 macOS 能力完成后再续 Windows。第 9 周期已核历史 Windows 原件及本机定向回归，无当前 Windows 实机结果。新的 [Windows CI 43690997618](https://github.com/KPGH-FJ/farfold/actions/runs/43690997618) 因付款或支出额度未获运行机器，零步骤。第 9 周期工作区的 Windows 目标交叉 Clippy 出现平台条件和测试代码警告，退码 101，未修。Windows 安装、升级、卸载、路径与凭据、终端进程、网页与通知仍待实机验证。[H18](#h18) · [P49 桌面证据](evidence/2026-11-15-cycle9-desktop/README.md) · [唯一计划](../plans/agent-access.md)

**第 10 周期按既定阶段范围收口。** DimCode、Autohand、Antigravity、MiniMax、siGit 均从正常入口查历史和已有设置。MiniMax 找到原自测标题，其余本次范围返回空。Antigravity 和 Autohand 需要登录，DimCode 会话打开返回内部错误，MiniMax 原模型不一致而保留，siGit 仅确认模型选项能读取。按标识读取的认证交接已修并更新正式版，明确认证返回的同动作只在受控回归验证。本批五家的实际续答、工具审批及整家八项仍未通过。[逐家结果](evidence/2026-11-15-cycle10-macos/README.md)

**第 11 周期按既定阶段范围收口。** Cursor、Gemini、Grok Build、Kimchi、Nova 均走正式版历史与账号入口，当时 28 家均已纳入分批验收。Cursor 新自测成功，冷开同一原对话读取原正文并准确续答，原标识和配置一致。Gemini、Grok、Nova 需认证，Gemini 当前未提供列表且旧版历史读取有上游修复，Nova 权限待官方兼容。Kimchi 新测试返回内部错误，一次停止未获确认。其原目录连接超时的同动作已在新版复验准确提示，历史文件保持。本批整家八项和真实审批仍未通过。[逐家结果](evidence/2026-11-15-cycle11-macos/README.md)

**macOS 第 12 周期保持开放。** 原 28 家的 224 格已逐家对照并列缺口，当前首发 21 家的 168 格继续，整家 0/21。前序正常入口 28 家逐个点验，12 个无索引退役条目退出选择，Nova、Qwen Code、DimCode、Factory Droid、Poolside、Kimchi 和 siGit Code 后续移出首发，原登记保留。Cursor 文件交付与单次批准有正例。旧 2026.09.28 实测停止失败；升级 2026.11.13 后，已从正常入口停掉前台 Shell 及其子进程，工具终态仍未知。正常退出并冷开同一原对话后，沿用 Auto 明确续答通过，无自动重发。受监视的后台 Shell 仍缺官方精确停止入口。双前台隔离最新复验见下。Copilot 与 Pi 找到并预览原正文，原配置未确认而保留只读。Dirac 冷开同原正文与配置；Qwen Code 移出前的单次无正文后停止已确认，Poolside 新请求曾报告内部错误，Devin 旧样本曾读取失败，Cline 旧版曾初始化早退。依赖涉及账号、原历史、官方能力与实测负结果。Windows 与公开交付仍按既有顺序。[续验](evidence/2026-11-15-cycle12-followup/README.md) · [本轮细节](evidence/2026-11-15-cycle12-macos/README.md) · [28 家八项](evidence/2026-11-15-cycle12-macos/acceptance-matrix.md)

**11 月 17 日历史和停止续验。** Dirac 原免费模型准确续答，Kilo 免费 Ultra 普通新建实答并冷开原正文。Grok 两条前台命令并行时只停 A，A Shell 及子进程退出，B 原任务完成，冷开 A 后手动续答通过。MiniMax 已移交后台的命令仍继续运行，S7 保留失败。CodeBuddy 原模型与当前选项不同，保留原选择且零发送。已修正常搜索优先级和发现、预览、带入时的目录冲突。[本批证据](evidence/2026-11-17-cycle12-history-and-stop/README.md)

**11 月 17 日文件交付与首发复验。** Grok 以原服务及 Grok 4.7 / Low 实际读写，一次批准后成品从本轮产物打开。MiniMax 小米 MiMo 新草稿原先因保留的配置通知卡在发送前。新版保存退出冷开保留同一草稿，实际切换和读回已选 MiMo 后只手动发送一次，成品从本轮产物打开。两份磁盘成品逐字节核合且原件未改。MiniMax 本次未触发审批，两家的其他权限、双任务及停止继续按原条件验证。模型无替代选项时的只读显示已改并通过受控回归。[实测记录](evidence/2026-11-17-cycle12-file-validation/README.md)

**第 12 周期精确交付续验。** Kilo 复制副本再编辑、Dirac 逐次批准确定性命令，原件保持，成品逐字节准确且都能从 Farfold 打开。Kilo 成品有对话链接，Dirac 手动打开。两家的原完整写入参数均已在各自工具调用中缺 LF，未把正例倒填到原失败。 [本轮正式回执](evidence/2026-11-17-cycle12-approval-and-lf/README.md#kilo-与-dirac-的换行)

**第 12 周期前一批文件交付复验。** CodeBuddy 成品 78 字节准确并从「本轮产物」打开。Kilo 已写出并打开，但原写入参数与成品均缺末尾 LF。Dirac 两次待批准内容也缺末尾 LF，拒绝后原件保持且无成品。Mistral 共用审批输入补显示通过受控工程，正式卡仍缺命令详情。[本批证据](evidence/2026-11-17-cycle12-stop-delivery-approval/README.md)

**第 12 周期八项续查。** 22 家 176 格的既有证据已逐项复核。正式版修复 Qoder 新对话设置校验后的入口，核实并采用用户已配置的 MiMo / Default，原未发草稿保持，实际成品可从本轮产物打开。Cline 从原免费模型单次审批读写，成品可手动打开，缺官方结构化文件回执。Autohand 双任务点停只结束 A 的 Shell，子进程当时仍活跃，B 实际完成，停止项保留失败。Amp 原厂商 CLI 此前未保存账号，独立密钥终端曾失败。Amp 和 MiniMax 随后均有小米服务实答，见下文。Claude 可从选定的官方账号来源准备。Gemini CLI 与 Antigravity 暂缓。[正式证据](evidence/2026-11-16-cycle12-eight-check/README.md)

**Amp 官方账号登录。** 正式版账号选择新增独立厂商程序入口，两种方式同时可见。用户第一次启动被旧密钥文件检查误拦截。修复正式安装并复验，实际启动原厂商登录终端，原旧文件保留。当时厂商账号、原线程和实答须等待登录。随后 Amp 登录及 MiniMax 小米新对话已有正式实测，见下文。[正式记录](evidence/2026-11-16-cycle12-amp-native/README.md)

**Amp 初次账号复验与 MiniMax 小米实测。** 当批同登记 Amp 官方 CLI 已登录，普通及含归档旧线程列表为空；既有 Farfold 请求实际返回 `auth_required`，当批未确认账号与原线程的关联。MiniMax Code 0.2.7 独立新对话实际采用已配置的小米 MiMo，原回复及来源冷开同一对象保持，零自动重发。原 M2.7 对话已能找回正文，原账号和服务额度仍待核。首条消息暂不可发送时的误提示已改，定向回归通过。[正式证据](evidence/2026-11-16-cycle12-account-retest/README.md)

**Amp 小米新对话实测。** 正式 Farfold 选用目录组件 0.13.0 和用户安装的官方 CLI。按用户许可备份旧组件密钥后，已登录 Amp 账号能读取 MiMo。重新确认模型设置后，Farfold 在独立新对话显式选择 `mimo-v2.6-flash`，发送一条并完成。官方同线程用量明细确认 `xiaomi/mimo-v2.6-flash` 的 1 次助手推理和 Amp 自行触发的 2 次标题推理均走用户的小米 Custom URL。该次覆盖新对话的模型和实际路由。原自建线程的后续冷开和续答见下文，未映射的厂商旧线程带入及整家验收仍待。[正式实测](evidence/2026-11-16-cycle12-account-retest/README.md#amp-小米单次正式实测)

**Amp 小米原对话冷开并续答通过，显式 MiMo 等待官方。** 正式 Farfold 搜索重开同一原线程并恢复正文。按用户许可临时选 `Default`，沿用 Amp 保存在原线程的 MiMo，发送一次依赖上文的续问并准确复述标记。同一原线程官方记录核到新增一次助手推理走原小米连接，之后恢复显式 MiMo 和 `Auto`。显式续答等新版组件正确沿用已核原模型，或等可调用的旧线程模型设置接口。[正式复验与原失败](evidence/2026-11-16-cycle12-account-retest/README.md#amp-原对话冷开和续答) · [等待与复验条件](evidence/2026-11-16-cycle12-eight-check/README.md#等待官方的复验条件)

**接入账号与 API 续查。** OpenCode 选新保存的小米 `Chat Completions` 与 `mimo-v2.6-flash` 实答，并冷开同一原对话读回回复与来源，模型名称显示缺陷已在正式版修正。Autohand 0.9.11 与 Grok Build 1.0.46 分别沿原 `fantail` 与 `grok-4.7 / low` 冷开、读到原正文并准确续答。Claude 使用另存的小米 `Messages` 独立 API 测试成功，普通对话在 0.81.2 无正文，升级 0.107.0 后返回 `auth_required`。两版的合成控制均发现官方适配程序发出占位 Bearer，需确认原生 Claude 的已有设置路径或官方适配程序修复。Gemini CLI 和 Antigravity 按用户要求暂缓。[正式复验与官方限制](evidence/2026-11-15-cycle12-pre-send/README.md)

**Cursor 双前台隔离通过。** 两条 Cursor 2026.11.13 对话沿用 Auto，同时在各自目录执行命令。点停止后 A 的 Shell 和子进程退出，B 继续并正常完成。A 的工具步骤仍显示结果未知，受监视的后台 Shell 仍缺官方精确停止。首次尝试中，Cline 内部错误保留了一个名额，第二条 Cursor 排队超时，未发出且草稿保留。正式退出结束 Cline 的归属进程组后，双前台复测成功。当时需退出整个应用才能回收。[双任务回执](evidence/2026-11-15-cycle12-followup/cursor-foreground-pair-2026-11-16.json)

**出错连接可单独回收。** 当次请求收到匹配的协议错误且连接只有该请求时，用户可检查并确认关闭。正式版用本机夹具实测，A 的进程组退出，B 保持同一进程继续，C 解除排队并完成。A 的原消息和草稿保留，旧请求结果未知、没有重发。[正式回执](evidence/2026-11-16-cycle12-failed-connection/installed-recovery.json)

**Cline 重新认证与旧对话原设置。** Cline 3.0.74 已恢复官方登录入口，用原账号重登后沿原服务临时选 Sonnet 5.5，实际收到预期回复，默认模型保持。[Cline 实测](evidence/2026-11-16-cycle12-cline-auth/results.json) 正式版新增「恢复原对话设置」。Pi 用旧 Farfold 备份核对并保存原 OpenRouter 模型和 Medium，在同一原对话准确续答一轮，重启后原配置和新回复保持。MiniMax 已冷开原文并预览 M2.7，原请求报余额不足，用户无法确认当时是否登录，原账号待核，零保存、零发送。[原设置实测](evidence/2026-11-16-cycle12-original-config/README.md)

**Claude 托管 API 暂停。** 官方适配器 0.107.0 把服务认证头放进 SDK 设置，SDK 0.3.323 将设置带进子进程参数。Farfold 在建立托管连接前拒绝该路径，保存的服务及「沿用已有设置」入口保留。官方私密交付仍待验证。[核对依据](evidence/2026-11-16-cycle12-original-config/README.md#claude-环境核对)

**移出 DimCode 前的 26 家账号和 API 盘点。** 正式版「探索 Agent」与新对话选择器核对 Qoder 保留、Qwen Code 移出，两家已有登记和对话索引保持。当批 MiniMax 的独立 M2.7 请求因余额或额度不足终止，旧 M2.7 的原账号和服务仍需核对。Claude 当前可用官方订阅或 Console 登录入口，托管 API 暂停。Gemini CLI 和 Antigravity 的登录继续暂缓。其余逐家按现有实答、待排障或待官方条件核对。[实装与盘点](evidence/2026-11-16-cycle12-qwen-exit/README.md)

**Factory、Kimchi 与 Poolside 移出前的服务复验。** Factory 现有登录通过官方诊断，后台与连接校验报告当前账号未关联组织，Farfold 和同版 CLI 的 GPT-6 Sol / High 各一次均 401。Poolside 的原托管模型版本停用，厂商已关闭原推理服务。Kimchi 原托管模型提供方额度耗尽，正式版设置测试和普通对话显示了具体原因。已核实官方第三方 API 和本地模型入口。三家均已依用户决定移出首发。[官方接法核对](evidence/2026-11-16-cycle12-retire-poolside-factory/README.md#kimchi) MiniMax 0.2.7 的第三方提供方入口在该批查明，后续小米新对话实答见上文。[第 12 周期实测](evidence/2026-11-16-cycle12-service-diagnosis/README.md)

**Autohand 文件交付实测。** 正常新对话沿用 `fantail`，按一次审批整理合成纪要并另存。可从 Farfold 的本轮产物打开新文件，原稿散列一致，负责人和日期保留。[文件交付回执](evidence/2026-11-15-cycle12-continuation/autohand-file-delivery-2026-11-16.json)

**发送前超时续查。** Qoder CLI 0.2.14 的旧正式失败卡在 `initialize`，同期 macOS 对归属于 Farfold 的 Git 子进程发起桌面文件夹访问提示，未记录答复。Devin 3000.11.3 的两次正式失败均在 `session/new` 等 120 秒，两个启动曾相隔约 2 秒，具体触发条件仍未知。固定非桌面目录后两家旧版均可从正式入口握手并创建对话，后续经官方更新至 Qoder 1.1.89、Devin 3000.12.57。新版已读可选配置，Qoder 当前仅报默认 Auto，Devin 当前仅报 SWE-2 Flash Medium，原模型保护保留。当时尚待用可用模型实答。[协议、厂商日志及实际界面](evidence/2026-11-15-cycle12-pre-send/README.md)

**2026-11-16 两家设置短测。** 经用户批准各发送一次。Devin 3000.12.57 用 `SWE-2 Flash Medium` 准确实答并结束。Qoder 1.1.89 的 `auto` 请求成功送到官方程序，随后返回 `main model "auto" is unavailable`。该错误由官方程序解析禁用模型时本地抛出，当前未确认它把 Auto 标为禁用的原因。两家 Farfold 的原保存选择一致。该批 Devin 尚未冷开续答，Qoder 尚未找到可用模型，后续实测见下文。[单次测试回执](evidence/2026-11-15-cycle12-pre-send/approved-setup-smokes-2026-11-16.json)

**2026-11-16 原对话与官方模型目录。** Devin 同一测试对话重启后可开，原模型、正文均读回，依赖原上下文的一次续问准确完成，按原目录的官方列表命中该原对象。Goose 的 `FF_C8_B_20261115` 同样完成列表查找、原对话冷开和一次准确续答。Qoder 同一登录的官方 `--list-models` 报无可用模型。厂商返回的模型目录有 16 条，Qoder 按厂商 `enable` 字段判定可用性，失败时 Auto 已被标为禁用。厂商禁用的上游条件仍未知，官方 Custom 路径待用户账号与密钥条件。[原对话](evidence/2026-11-15-cycle12-pre-send/history-continuations-2026-11-16.json) · [Qoder 诊断](evidence/2026-11-15-cycle12-pre-send/qoder-model-availability-2026-11-16.json)

**Qoder 历史和 Cline 短测。** Qoder CLI 1.1.89 沿用官方 Custom 配置的小米 `mimo-v2.6-flash`，按原目录从 Farfold 对话库命中同一原对话，打开原文并准确续答。Auto 旧失败保留。Cline 3.0.74 修复了旧版签名导致的启动失败。此次沿用已有设置，以 `Claude Sonnet 5.5` 只发了一条，程序约 3 秒返回 `internal_error`，没有文本，当时未取得具体原因。原账号登录及后续实答见上文。Farfold 保存的原选择未变。当前 Cline 声明按已知标识读取，未声明历史列表。[正式复验](evidence/2026-11-15-cycle12-pre-send/qoder-history-cline-smoke-2026-11-16.json) · [Cline 启动证据](evidence/2026-11-15-cycle12-pre-send/cline-startup-diagnosis-2026-11-16.json)

**Qoder 双前台隔离及停止后冷续答通过。** 用户批准后单独关闭占用全局发送名额的 OpenCode 报错连接。正式版中两条 Qoder 1.1.89 对话沿用同一 MiMo，各自在独立目录运行。只点 A 的停止，A 的 Shell 和子进程实际退出，B 的同一进程继续并自然完成。正常保存退出后从侧栏冷开同一 A，只发一条依赖旧上下文的续问，沿用已有小米 MiMo 和 Default 准确回答。原标识保留且唯一，零新建、零自动重发、零工具重跑。A 的已停止工具步骤仍显示结果未知。[隔离实测](evidence/2026-11-16-cycle12-eight-check/README.md#qoder-停止及发送名额) · [续答实测](evidence/2026-11-16-cycle12-eight-check/README.md#qoder-停止后冷开续答)

**Copilot 原 Auto 续答复验通过，失败反馈等待官方。** 用户确认原 GitHub 账号。正式版从原目录找到、读回并加入同一原 ID，恢复已有服务和 Auto。首次续问约 20.7 秒出现官方选模网络错误，错误作为正文返回，协议未将该轮报告为失败，Farfold 显示「已完成」。后续从正常入口在同一原对话只发一次，约 18.1 秒正确回传原标记，原配置与唯一索引保持。首次网络失败的具体地址、状态或底层异常未知。等待官方回传可对应于同一请求的失败信号。[最新复验](evidence/2026-11-16-cycle12-eight-check/README.md#copilot-auto-同条件复验) · [等待与复验条件](evidence/2026-11-16-cycle12-eight-check/README.md#等待官方的复验条件)

**Devin 普通新建的旧设置恢复已修并正式实测。** 从新对话「检查模型设置」同时核对原 `swe-2-high`、`high` 与当前 `SWE-2 Flash Medium`、未提供推理选项，明确采用后保留原目录和草稿。使用原已有服务准确实答一次，全局默认设置原样保留。此前沿原测试对话确认的设置完成文件交付，原稿散列不变，成品可从「本轮产物」打开。实际工具审批及其他工作路径继续按原条件核。[正式新建](evidence/2026-11-16-cycle12-eight-check/README.md#devin-普通新建的旧设置恢复) · [正式文件回执](evidence/2026-11-15-cycle12-pre-send/README.md#2026-11-16-devin-文件交付)

**CodeBuddy 2.184.0 原对话预览无正文。** 从正式版选用目录新版，程序检查通过，旧 2.160.0 安装仍在。从正常「带入已有对话」沿用第 7 周期同一原目录及标识，只读一次。协议 `session/load` 在 78.743 秒返回，未见助手正文回放。界面显示「Agent 没有返回可展示的正文，本次未加入」，零模型请求。新版从超时变为收到回包，原正文仍待验证。[第 7 周期原样本](evidence/2026-11-13-cycle67-closure/summary.json)

**Cline 只读历史列表等待可准确识别原目录和冲突的官方入口。** 隔离实测确认，官方脚本的模糊目录匹配可以再做精确比较，但同一 ID 的冲突在返回前已被合并。正常 ACP 只声明按已知 ID 加载，CLI/SDK 常规列表可能改写失联状态，完整列表暂不接入。此前用两份真实自有清单的只读正例保留。[目录与冲突复现](evidence/2026-11-16-cycle12-eight-check/README.md#cline-原目录与重复-id)

**Cline 双前台实际停止及原对话冷续答通过。** 正式 Farfold 沿用已保存的免费 Nemotron，两条任务在各自目录同时运行。从 A 按停止，A 的 Shell 和子进程实际退出，B 保持原进程并正常完成。首轮 B 因夹具超过默认 30 秒而超时，用较短夹具复验通过。正常退出后从侧栏重开同一 A，沿原设置一条上下文续问准确回答，零新建和工具重跑。[正式隔离与续答复验](evidence/2026-11-16-cycle12-eight-check/README.md#cline-双前台实际停止)

**Pi 与 siGit 的官方路径续查。** Pi 目录最新仍为 `pi-acp 0.0.34`，将网页工具转给 Pi 的实现尚在上游 PR。siGit 当前 1.5.11 裸 stdio 登记无自动加载，原选中的 1.93 GB GGUF 在默认和共享缓存均缺，当前无可确认的已配置兼容服务。[Pi 上游 PR](https://github.com/svkozak/pi-acp/pull/164) · [siGit 启动方式](https://github.com/getsigit/sigit/blob/v1.5.11/src/main.rs#L4282-L4298)

第 6 周期按原阶段范围收口，网页许可、撤回、标签切换及同请求截图已有正式分项，新增五家逐家记录了接入正例或具体阻碍。第 7 周期已交付搜索、整理、导出、按标识带入及本批发现的焦点与栏宽缺陷修复。真实审批、提问和中断各有单次有声与正确点击证据，纯图片触发未读也有单独正式证据。五家历史样本条件和其他原条目按下表继续保留。

| 范围             | 当前事实与具体剩余条件                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第6接入依赖      | fast-agent 冷开工具和图片已修。其委托给 Farfold 的前台命令已有正式停止正例，旧自管命令失败保留，工具终态和自管工作仍待验。Pi 缺官方网页工具路由，Codex 受 NEW-24 限制。                                                |
| 第7本波五家      | 当批新共用入口已实装。CodeBuddy 和 Devin 各有原对象读取失败，Dirac 缺原目录，Factory 旧请求结果未知，Cline 当批缺可读自有样本。第 12 周期 Devin 已有新样本冷续答，Cline 已知 ID 及列表限制见上文，Factory 已移出首发。 |
| 第7通知          | 新正式版 OpenCode 网页审批、颜色提问、在途骤断各实际显示一次并播放声音。用户现场确认三类均听到，点击均返回对应审批、提问卡或自建中断对话。三项提醒恢复原关闭；原共享静音证据保留。                                     |
| 第7键盘与显示    | 900×620、150% 的内容栏和搜索焦点已有正式正例。新正式版在 1920×994、150% 修复并实测栏宽切换对话和冷开恢复。受控保存失败有回退和提示。其余主题和支持尺寸按原条件；旁白暂缓。                                             |
| 其他完整条目条件 | 实删获准自有 OpenCode 对话及复查、仅有未知结果的冷态保护已有正式正例。新正式版确认目标图片独立触发未读、冷开保持、打开只清目标。自然满 30 天的候选仍为 0，该时点 Mistral 仍缺继续实测的额度与相应样本。                |

[搜索与历史原件](evidence/2026-11-13-cycle67-closure/README.md) · [正式图片及栏宽](evidence/2026-11-15-cycle7-final-validation/README.md) · [真实提醒实听](evidence/2026-11-15-cycle7-p47-hearing/README.md)

## 按任务维护的最新结论

<!-- task-current: H08 -->

### H08

2026-11-15 同日上一正式版实际 OpenCode 和 Goose 并行，同工作目录各执行 360 行有序输出，两个真实 shell 同时取样，正式界面核对各自结果，原 Agent 记录的行序和结束标记核合。至少一个命令运行时，主进程 RSS 64,752–68,720 KiB、描述符 46–50；应用进程树 14–17 个。切换和草稿输入有同批正式结果。精确实时输出逐条呈现顺序及全系统资源仍按覆盖范围记录。[正式证据](evidence/2026-11-15-cycle8-observation/README.md)

<!-- /task-current -->

<!-- task-current: H09 -->

### H09

2026-11-15 修复历史渲染对每条分支锚重扫整段历史，正式实装。WebKit 受控 3,000 条中首尾和全部检索定位成立，扫描访问 18,012,000→12,000。正式 OpenCode 2.2.7 单独导入 1,000 条合成历史，原库已有会话及消息排序摘要核同。Farfold 从正常入口查找、预览、加入原 ID，搜索计数 1,000/1,000、首尾回绕、跨页草稿保持。原模型选项未能确认，历史按只读打开。正式记录含驱动及截图等待，额外富媒体、实际模式和运行范围按各自证据。[本批实装、样本和计时](evidence/2026-11-15-cycle8-observation/README.md)

<!-- /task-current -->

<!-- task-current: H10 -->

### H10

2026-11-15 正式 OpenCode 先在同一自建终端请求中实测在途 Wi-Fi 关闭、失去 en1 IPv4 到恢复，原轮正常完成。再用原对话真实提问卡跨整机休眠 23 秒，用户确认唤醒后卡仍在，提交一次原请求成功返回「蓝色」。两轮各只有一个出站原请求，后一次三个已归属进程保持原 PID 和描述符数。另一次 106 秒整机休眠发生在限时任务结束后。多 Agent 各类在途工作、持续网络中断和其他可用网络路径仍按各自证据。[第 8 周期实机原件](evidence/2026-11-15-cycle8-observation/README.md#休眠与网络变化)

<!-- /task-current -->

<!-- task-current: H12 -->

### H12

2026-11-15 所选正式 OpenCode 和 Goose 用同一 Git base，看到了相同 `shared.txt` 的实际更新。独立 linked 工作树同名文件原位字节保持，可从工作树「选择已有文件夹」选定其实体路径。工作位置及工作树说明已补共享文件说明并在当前正式版复验。[实机原件](evidence/2026-11-15-cycle8-observation/README.md) · [既有正式创建与范围](evidence/2026-11-15-cycle8-worktree/README.md)

<!-- /task-current -->

**11月15日 Goose 新版补验。** 正常程序入口已更新到官方 1.59.1。旧装 1.52 和原会话、消息 ID 保留。点 Farfold 停止后，真实 shell 与 sleep 子进程约 0.25 秒内退出。旧版子进程继续的正式反例保留。新版未收到该工具的实时终态，界面仍明确未确认。新增只含未知结果的冷态归档及删除拦截正式样本。OpenCode 后台 PNG 在第一条持久化可读助手文字前已出现未读，冷开保持、打开原图清除，实时首帧文字顺序仍待独立证据。[本轮原件](evidence/2026-11-15-cycle7-goose-retest/README.md)

**11月15日第7周期正式复验。** OpenCode 从正常搜索打开原对话、确认原模型并实际续答。归档恢复、Markdown 写盘、冷开未发草稿保护通过。经用户现场授权，唯一自有对象已永久删除，Farfold 与 OpenCode 同 ID 后查为零。用户确认测试提醒实际显示和响铃。并行实测 OpenCode 命令实际停止，Goose 另一命令继续并完成。Goose 1.52 自身点停的子进程反例留档，新版补验见上。正式版随后验证在途骤断横幅单次显示、点击回原对话及精确 900×620 的内容栏与搜索焦点。提醒偏好已恢复。[搜索、停止及整理](evidence/2026-11-15-cycle7-acceptance/README.md) · [骤断及最小窗](evidence/2026-11-15-cycle7-p47-p46/README.md)

以下条目只在这里维护结论；要求参考保留链接，`docs:task`直接读取对应内容。未归并条目仍明确标为参考进度，逐批核原件后迁入。原条件不变，完整历史见原始证据及[迁移前进度](maintenance/2026-11-11-task-current-source/previous-progress.json)。

<!-- task-current: ARCH-01 -->

### ARCH-01

2026-11-17 正式版在「探索 Agent」显示官方目录已更新及获取时间，手动点「重新发现」后实际出现刷新失败和使用上次目录的提示，22 家仍可见，显示原获取时间。无已保存目录时的提示和本机发现保留已有 Rust 与前端受控回归，未从正式数据清空缓存复验。完整项保持开放。[正式摘要](evidence/2026-11-17-baseline-alignment/summary.json) · [目录实现](../src-tauri/src/agent_catalog.rs) · [界面回归](../src/components/AgentHub.test.tsx)

移出 Kimchi 后，已有正式版探索目录 22 家、新对话搜索 Kimchi 无匹配，原登记与三条对话索引保留。[原正式复验](evidence/2026-11-16-cycle12-retire-kimchi/README.md)

2026-11-17 按用户授权从源码目录及新接入入口移出 siGit Code，当前范围 21 家。定向用例覆盖范围过滤、旧登记和缓存保护。正式探索与新对话选择器均不再提供 siGit，旧登记已读回复核。[正式观察](evidence/2026-11-17-cycle12-models-and-sigit/README.md#正式安装与-21-家目录)

<!-- /task-current -->

<!-- task-current: ARCH-08 -->

### ARCH-08

2026-11-16。macOS 正式版中，Cline 3.0.74 走官方入口恢复原账号，沿原服务用 Sonnet 5.5 实答。Autohand 0.9.11 和 Grok Build 1.0.46 沿原配置完成冷续答。Amp 新增独立官方登录终端，已用用户授权的账号和所选 MiMo 从 Farfold 实答，官方使用记录核同一小米连接。旧适配器密钥与厂商登录仍是两条方式，先前 `auth_required` 按原请求留证。[Cline 原账号](evidence/2026-11-16-cycle12-cline-auth/results.json) · [Autohand 与 Grok](evidence/2026-11-15-cycle12-pre-send/README.md) · [Amp 登录入口](evidence/2026-11-16-cycle12-amp-native/README.md) · [Amp 实答与用量](evidence/2026-11-16-cycle12-account-retest/README.md#amp-小米单次正式实测)

Gemini CLI 与 Antigravity 按用户要求暂缓。Nova 已移出首发，当时的认证要求仍保留。各已核官方方式的失败、拒绝、取消、换号及方法级密钥边界仍按逐家证据验收。[第 10 周期](evidence/2026-11-15-cycle10-macos/README.md) · [第 11 周期](evidence/2026-11-15-cycle11-macos/README.md) · [当前验收表](evidence/2026-11-15-cycle12-continuation/acceptance-roster.json)

<!-- /task-current -->

<!-- task-current: ARCH-44 -->

### ARCH-44

2026-11-17 Mistral 正式诊断确认审批请求无输入，紧邻同一标识工具报告 `in_progress` 与有输入无输出。新版卡片显示「该步骤报告的输入」和完整命令，单次批准后运行完成。MiniMax 用 MiMo 实际早停前台，官方报告 `managed_foreground` / `canceled`，真实 Shell 和子进程退出且无完成标记；重开原 ID 续答。该 Agent 的后台停止仍失败。[正式回执](evidence/2026-11-17-cycle12-approval-and-lf/README.md)

2026-11-17 在两个 Agent 各自的双前台任务中，仅点停 A。OpenCode 与 Goose 的 A 原 Shell 和子进程退出，B 保持并交付。两家冷开读回原配置和未发草稿及附件，手动续答成功。Goose 未确认实时工具终态。Mistral 当批共用补显示通过受控检查，正式试验卡当时仍缺命令。后续修复见本项开头。[本批正式回执](evidence/2026-11-17-cycle12-stop-delivery-approval/README.md)

fast-agent 0.10.1 的官方终端委托已经在 macOS 正式版限定启用。用户从 Farfold 逐次批准实际程序、参数和工作目录。两条不同目录的前台命令同时运行时，点击停止使 A 的 Shell 和子进程退出，B 继续并自然完成。A 冷开同一原对话后的手动续答通过，工具实时终态仍未知。Agent 自管及外部工作继续按各自官方入口核验。[受控原件](evidence/2026-11-15-official-alternatives/fast-agent.md) · [正式审批](evidence/2026-11-15-cycle12-fast-approved/README.md) · [正式隔离与续答](evidence/2026-11-15-cycle12-continuation/README.md#fast-agent-双任务与停止后续答)

Cursor 2026.11.13 的工具由其官方程序自行管理。新版正式版中前台 Shell 及子进程确实停止，两条同时执行时另一条独立完成。A 的工具终态仍未知，被监视的后台 Shell 仍缺可验证的官方精确停止入口。旧版实际停止失败保留。[旧失败](evidence/2026-11-15-cycle12-macos/README.md) · [新版单任务](evidence/2026-11-15-cycle12-followup/README.md#cursor-20261113-前台命令停止通过) · [双任务](evidence/2026-11-15-cycle12-followup/cursor-foreground-pair-2026-11-16.json)

原 29 家调查中的回调能力与失败样本继续留档。当前首发中 Antigravity、Devin 的具体回调路由及 Grok 发行与源码映射仍缺证。CodeBuddy 官方能力门控以及 Kilo、OpenCode 所选源码的受控反例保留，Mistral 内建工具和 Qoder 所选默认终端路径已有源码依据。Nova 的 V1 权限差异及 DimCode、Factory Droid、Poolside 的缺口属于已移出对象的历史证据。真实协商、权限及失败取消须逐家核验，独立沙箱事项仍开放。[Nova 前序结果](evidence/2026-11-15-cycle11-macos/README.md) · [首发现行范围](agent-first-release.md)

<!-- /task-current -->

<!-- task-current: ARCH-32 -->

### ARCH-32

2026-11-15 补正式样本。Goose 1.59.1 自有任务只保存未知结果，待发、草稿和文件意见均为 0。冷启动不打开正文，归档和删除入口均明确阻挡，原会话及索引保留。[本轮原件](evidence/2026-11-15-cycle7-goose-retest/README.md)

2026-11-15 前一批正式版冷开后，未打开的有草稿对象阻挡归档、删除。清除自有测试草稿后经用户现场授权实际删除同一测试对话，按原 ID 独立后查 Farfold 和 OpenCode 所检记录均无残留，其他 13 条本地索引保留。[受控原件](evidence/2026-11-15-official-alternatives/README.md) · [正式原件](evidence/2026-11-15-cycle7-acceptance/README.md)

975f 已安装关闭后继续核查官方删除的流程。本机仅验证一条自有对象到确认屏，实际官方删除、独立残留重查及最终闭态数据保护仍待验。原成功、不支持、未确认结果口径保持。[正式分项](evidence/2026-11-13-cycle7-final/README.md)
<!-- /task-current -->

<!-- task-current: P34 -->

### P34

2026-11-15 补正式冷态反例。无草稿、待发和文件意见的独立仅未知对象，在「所有对话」的删除入口禁用并明确告知结果未确认。原 ID 仍在。[本轮原件](evidence/2026-11-15-cycle7-goose-retest/README.md)

2026-11-15 受控复验：仅持久化未知、已有审批、提问及关闭期间新活动有保护。正式候选冷开时，有草稿的未打开对话阻挡删除。用户明确授权后删除唯一自有 OpenCode 测试对话，14→13，正常搜索无匹配，独立按原 ID 核 Farfold 与 OpenCode 已查记录为零。其他 Agent、批量及仅未知等分支仍按原条件验。[受控原件](evidence/2026-11-15-official-alternatives/README.md) · [正式原件](evidence/2026-11-15-cycle7-acceptance/README.md)

975f 正式操作仅到一条对象的官方删除确认屏，未执行删除。待适用对象获准后，按原条件核实际回执、独立官方重查和数据保护。保留旧受控原件。[正式分项](evidence/2026-11-13-cycle7-final/README.md) · [前版进度](evidence/2026-11-13-cycle7-final/previous-progress.json)
<!-- /task-current -->

<!-- task-current: P37 -->

### P37

2026-11-15 补正式冷态反例。仅保存未知的 Goose 原对象在打开前阻挡归档，确认无草稿、队列和文件意见，原归档状态不变。30 天当前候选为 0，既有 1 天正式正例及受控时间、活动边界继续有效。[本轮原件](evidence/2026-11-15-cycle7-goose-retest/README.md)

2026-11-15 前一批受控复验：冷态自动和手动归档覆盖仅结果未知的对话。正式版自有已结束对象手动归档、搜索定位并恢复，14→13→14。冷开有未发草稿的未打开对象受保护。[受控原件](evidence/2026-11-15-official-alternatives/README.md) · [正式原件](evidence/2026-11-15-cycle7-acceptance/README.md)

975f 正式验到两条自然满 1 天的对话实际自动归档，13→11+2，正常退出冷恢复保持，恢复二者回 13 并复位 30 天。0 天被拒绝，未改时间或历史。原终态、置顶、活动、未发及未知保护按原条件核验。[正式分项](evidence/2026-11-13-cycle7-final/README.md)
<!-- /task-current -->

<!-- task-current: P42 -->

### P42

选定暖对话的键盘入场、返回原行和草稿保持已有正式分项。975f 新增一条后台文字加 PNG 的正式未读结果。其他任务/状态筛选、全局键盘定位与让用户返回实际原请求的组合按原条件核验。[旧操作](evidence/2026-11-03-conversation-controls/control-formal-summary.json) · [正式增量](evidence/2026-11-13-cycle7-final/README.md)
<!-- /task-current -->

<!-- task-current: P09 -->

### P09

2026-11-13：原模板实测及11月3日Goose /status仅填入、原文附件保持的分项保留，命令实际发送仍未验。本批修复新建/编辑/放弃/删除取消/失败回执焦点；5cc正式纯键盘新建及编辑到名称、放弃回对应入口、删除确认默认取消、取消回删除、Escape回输入菜单通过，未保存或删除既有模板。保存失败和旧回执另有受控双浏览器红绿，不替代正式失败。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)；[迁移前进度与原证据](evidence/2026-11-13-cycle67-closure/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: P33 -->

### P33

2026-11-17 Kilo 文件样本冷开同一原 ID，正文及免费 Ultra / None 保持，手动一次续问准确回答。MiniMax 实际早停的原 MiMo 对话冷开后保持原目录、配置及原状态，未自动重发，手动续答准确。两次无新建。[最新正式回执](evidence/2026-11-17-cycle12-approval-and-lf/README.md)

2026-11-17 OpenCode 与 Goose 重开各自已停止的同一原 ID，目录、原正文、配置及未发草稿和附件保持。两家各一次手动续问，均准确返回原上下文标记，记录无新建和无自动重发。[本批原件](evidence/2026-11-17-cycle12-stop-delivery-approval/README.md#opencode-与-goose-同家双任务)

2026-11-17 正式版更新后，MiniMax 继续同一小米 MiMo 测试对话，Mistral 停止后继续同一 Medium 3.5 / High 测试对话。两次均从侧栏冷开、核原正文和设置，各手动一次上下文续问并准确返回原标记，零新建。旧 M2.7 用户确认无额度。[原 ID 和回执](evidence/2026-11-17-cycle12-models-and-sigit/README.md)

2026-11-17 修复同页及跨页的同标识不同目录。收到冲突时不会把原勾选带到另一文件夹，预览与加入前还会核对原目录。目录相同仅更新标题仍可正常选择，已知原 ID 仍可指定原目录读取。Rust 和前端受控回归已验，冲突条件未在真实外部名单注入。Dirac 与 Grok 原对象续答及 Kilo 原正文冷开正式分项通过。Cline 仍需官方在去重前提供原目录与冲突。[本批证据](evidence/2026-11-17-cycle12-history-and-stop/README.md)

2026-11-16：Pi 从正常入口带入并重开原对话，当前 OpenRouter 凭据可访问原生成记录。从旧 Farfold 备份恢复 Nemotron 3 Ultra 免费版和 Medium 后，单次续答准确命中原上下文，重启后原设置和新回复保持，冷开零发送。MiniMax 已按原目录和标识带入并重开，读回原文，并预览当前报告的 M2.7。原失败为余额不足，旧记录没有账号或计费来源，用户也不确定曾否登录，原账号待核，零保存、零发送。[本轮正式实测](evidence/2026-11-16-cycle12-original-config/results.json)

2026-11-16：Devin 与 Goose 各一条自建原对话均命中原目录官方列表，正常入口冷开同一原标识，读回原文与所选设置，并准确续答原上下文。未产生重复对话，范围限本次样本，分页与其他历史待验。Qoder 同一小米样本按原测试目录从官方列表查到，打开已有对话并用原上下文准确续答。分页和首次带入其他外部历史待验。[Devin、Goose](evidence/2026-11-15-cycle12-pre-send/history-continuations-2026-11-16.json) · [Qoder](evidence/2026-11-15-cycle12-pre-send/qoder-history-cline-smoke-2026-11-16.json)

2026-11-15 继续验收：Autohand、Grok Build 从正式侧栏打开同一原对话并准确续答，按原目录查询均定位同一原对象，分页仍待。OpenCode 的新小米来源同一原对话冷开读回原正文，未补发。Qoder 与 Devin 已从正式入口取得新会话，原模型当前未提供，旧历史仍须分别核。fast-agent 原对话正式冷开及续答保持。Nova 已退出当前首发目录，旧历史保留。[先前正式结果](evidence/2026-11-15-cycle12-continuation/README.md) · [本轮正式回执](evidence/2026-11-15-cycle12-pre-send/README.md)

2026-11-15 第12周期：新版正常带入入口逐个点选 28 家，无索引的退役登记退出列表，已有索引历史和自定义、本机发现保持。临时预览释放失败不会重复自动尝试。Devin 自有原对象仍读取失败，Cline 连接检查提前结束；Dirac 新自测已冷开正文。续验 Copilot 与 Pi 原目录均找到并读取自建对话正文，原配置未确认，未续发。用户扩大原会话样本授权后，MiniMax 已找到现存目录原正文，原配置未核而保留只读；Qoder 与 siGit 的默认列表均为空。[第 12 周期续验](evidence/2026-11-15-cycle12-followup/README.md) · [第 12 周期](evidence/2026-11-15-cycle12-macos/README.md)

2026-11-15 第11周期：新版明确呈现 Kimchi 原目录连接超时，未发列表或正文请求。Cursor 自建旧对话已从正常入口冷开并同原对象续答；首次默认列表条目归属仍未确认。逐家权限、分页和其他历史样本仍待。[第 11 周期](evidence/2026-11-15-cycle11-macos/README.md)

2026-11-15：按标识读取遇到当前请求的明确认证要求时可进入原 Agent、原目录的准备流程。未知和迟到结果不触发；正反受控回归通过，已装正式版并核表单。MiniMax 正式列表找到旧自测标题，原目录缺失；五家正文及原对话续答仍待各自条件。[第 10 周期](evidence/2026-11-15-cycle10-macos/README.md)

2026-11-13：新增共用按已知标识读取：仅当前官方连接声明可读取时显示，明确原目录+标识，完整真实预览后才允许加入。9f正式Goose一次读取旧正文/工具，明确加入后12→13、正常打开保持；旧模型及思考设置未知时只读暂停发送，零新增用户发送、未改模型配置。CodeBuddy约120秒、Devin快速读取失败，未加入空记录、未重试，不能把握手或空列表当正文成功。逐家分页、其他预览及实际继续仍开放。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)；[迁移前进度与原证据](evidence/2026-11-13-cycle67-closure/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: ARCH-31 -->

### ARCH-31

2026-11-16：Devin 与 Goose 分别按自建样本的准确原目录完成正常带入入口查找，显示同一原对象已加入，未再次加入。正常冷开与依赖原上下文的续答均有正式记录。分页和其他样本仍待验。[原目录和原标识回执](evidence/2026-11-15-cycle12-pre-send/history-continuations-2026-11-16.json)

2026-11-15 第12周期：带入入口范围按目录统一，已存退役历史仍可用，正常新建资格保持。Devin 同原对象的当前厂商存储明确返回找不到，新版能开新对话。Cline 未到列表。Dirac 同原ID从正常入口冷开正文及选项通过，原对象续答仍未验。Autohand 与 Grok Build 原会话冷开及续答已有正式正例，原目录官方列表定位同一原对象，分页仍待。[第 12 周期](evidence/2026-11-15-cycle12-macos/README.md) · [本轮正式回执](evidence/2026-11-15-cycle12-pre-send/README.md)

2026-11-15 第11周期：四家列表有实际返回，Gemini 现安装未提供列表。真实连接超时在新版按同动作复验；远端列表普通错误不能套用本机连接或认证结果。Cursor 自建对话同原标识冷开并续答，范围限该版本、原配置和样本。[第 11 周期](evidence/2026-11-15-cycle11-macos/README.md)

2026-11-15：五家正式查找均收到列表结果。MiniMax 显示原自测标题，其余范围为空；新版 MiniMax 列表和按标识表单通过烟测。同批按标识读取的认证交接已修，真实认证拒绝接回准备的复验仍待原样本。分页、正文、实际续答各按原条件保留。[第 10 周期](evidence/2026-11-15-cycle10-macos/README.md)

2026-11-15：OpenCode 正常搜索命中已有原对话，核原 ID 和保存配置，实际续答正确引用该对话原内容。来源限 Farfold 已有对象。[正式原件](evidence/2026-11-15-cycle7-acceptance/README.md)

2026-11-13：本批官方发现返回可读取能力，与是否有列表独立；共用已知标识入口复用原完整回放、身份/配置保护及明确加入，不伪造发现条目或另建历史账本。9f正式Goose原目录+标识读取、预览、加入及再次打开有正例；原配置未知保持只读。CodeBuddy/Devin具体失败保留。生命周期旧回执、释放与卸载迟到读取独审已修，受控与正式分列；原分页、全范围及继续发送未扩大通过。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)；[迁移前进度与原证据](evidence/2026-11-13-cycle67-closure/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: P38 -->

### P38

2026-11-15 新正式版 OpenCode / Xiaomi MiMo v2.6 Flash 单张后台 PNG 正式分项通过。唯一请求到首条助手文字的协议序号连续。工具图片 13:53:28.994 到达，13:53:28.998 首次观察到目标未读，首条助手文字在约 11.57 秒后。全局未读 1→2，正常退出冷开保持 2，打开并载入原对话后只清目标，界面实际打开原图。范围为此 PNG 路径，其他媒体和 Agent 仍按各自证据。[新版正式原件](evidence/2026-11-15-cycle7-final-validation/README.md)

2026-11-15 正式 OpenCode 的后台合成 PNG 在首次观察到该对话未读时已有原生媒体记录，当时持久化的可读助手文字为 0。后续有独立文字。全局 1→2，正常退出冷开仍 2，打开目标并载入后回 1，可展开该次图片。复核原协议日志只记录更新方法，原 Agent 的可查记录也没有该轮实时事件类型。下一次独立取证需在同一时间轴区分媒体与文字更新，再核对未读出现时点。纯媒体严格触发仍待证。[本轮原件](evidence/2026-11-15-cycle7-goose-retest/README.md)

2026-11-15 核现有正式样本。975f 的后台文字＋PNG、冷开保持及打开清除已有组合正例。独立由纯媒体触发未读取证仍待。[混合媒体正式原件](evidence/2026-11-13-cycle7-final/README.md)

2026-11-13：既有正式Goose文本后台只标正确对话、打开清除及冷开保持分项继续有效。本次生产事件与历史路径8项、异步切页媒体2例，以及真实WebKit/Chrome各16项通过，覆盖PNG/WAV正确归属、可读打开清除、历史静默、重复终态仅提交一次完成提醒；未复现新产品缺陷。图片实际解码，音频只核控件和不自动播放。仍缺真实Agent后台媒体样本与相应正式冷恢复；受控通知提交不代表系统送达、点击或响铃。[本批分层记录](evidence/2026-11-13-cycle7/interaction-followup.json)；[迁移前进度及原证据链接](evidence/2026-11-13-cycle7/interaction-previous-progress.json)。

<!-- /task-current -->

<!-- task-current: P43 -->

### P43

2026-11-17 正式版 MiniMax 未发文件任务在确认切换 MiMo 后因保留配置通知而无法发送。源码只在同一个从未发送的草稿严格确认配置后，允许识别为配置通知的原始条目不阻塞首条。未知工作、旧历史、待发内容及其他归属权限保护保留。正式新版本冷开保留草稿与同一目录，再从 M2.7 切回 MiMo，有两条原始配置通知且发送可用。一次明确手动发送，成功另存及打开成品。[正式复验](evidence/2026-11-17-cycle12-file-validation/README.md)

以前的准备归属、首发并发、旧回调与正式首发前开关本地网页分项保留。Goose 正式新对话手选原服务模型、确认和明确首发通过。其余布局、焦点及首发组合待验。[Goose 首发实测](evidence/2026-11-07-stage1-formal-acceptance/fresh-model-first-send.json)

<!-- /task-current -->

<!-- task-current: P44 -->

### P44

2026-11-15 正式版在150%实测导出弹窗 Shift+Tab 到保存、Tab 回关闭、Escape 回原对话操作。后续同一正式版精确 900×620 的内容栏与搜索焦点见 P46。未覆盖控件仍按原条件。[导出原件](evidence/2026-11-15-cycle7-acceptance/README.md)

2026-11-13：正式ee4c发现“数据与隐私”中键盘展开清除范围、取消后均丢焦点到文档；未执行清除。现已补明确动作后的焦点交接：展开到未勾选范围确认、取消回入口，若新增工作禁用入口则回同弹窗关闭。真实WebKit红例两项转绿，WebKit/Chrome各9项、独立WebKit9项、永久回归及关联26项通过；修复已随29ed实装，同一键盘动作正式复验：展开后聚焦未勾选范围、取消回原入口、Escape回外层“查看说明”。没有勾选或执行清除。原导出双向回绕、工作树/全局查找回焦点保持，本次正式快捷键弹窗双向回绕与Escape回入口另通过。其他嵌套/忙态及窄屏路径保持未齐。[本批分层记录](evidence/2026-11-13-cycle7/interaction-followup.json)；[原进度](evidence/2026-11-13-cycle7/interaction-previous-progress.json)。

2026-11-13本批：5cc正式新增常用指令新建/编辑/放弃/删除取消焦点正例；历史读取 busy 原生禁用按钮导致焦点丢失已在正式CodeBuddy重现，9f修复后正式Devin失败、Goose成功均保持读取按钮。双浏览器各10项覆盖忙态重复触发仅一次、主动移开和关闭迟到不抢焦点；正式长等待修复后的组合未重演。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)。

<!-- /task-current -->

<!-- task-current: P46 -->

### P46

2026-11-15 原正式版拖宽 510→570 后切换对话，重新打开退回 510。已补共用栏宽保存，指针松开或键盘调整后保存，取消不写入，保存失败恢复上次确认并提示。新正式版在 1920×994、150% 拖到 570，切换对话和正常退出冷开后分别核为 570。受控保存失败和重试通过，正式未注入存储拒写，快速连续调整后立即退出单列未测。最小窗口焦点和主题见下方各原件。[本批正式与受控原件](evidence/2026-11-15-cycle7-final-validation/README.md)

2026-11-15 同日上一正式版实测精确 900×620，应用缩放 150%。内容栏用 Escape 或点击收起均回原入口，Cmd+K 搜索后按 Escape 回打开前的按钮。旧正式同尺寸的长草稿和两附件证据保持。新正式版在宽窗切到深色、跟随当前系统浅色并恢复纸白。生产主题钩子另经 WebKit 和 Chromium 的系统外观模拟验证动态跟随；Mac 全局外观未调整，未覆盖尺寸组合仍按原条件。[最小窗](evidence/2026-11-15-cycle7-p47-p46/README.md) · [新版主题](evidence/2026-11-15-cycle7-final-validation/README.md) · [动态跟随受控回执](evidence/2026-11-15-cycle7-p47-hearing/README.md#系统主题变化补验)

2026-11-13：正式ee4c在1280×820切深色并实际显示，正常保存退出、进程结束后重开仍选深色；跟随系统当时呈浅色，随后恢复原纸白。原900×620长草稿与两附件所选路径保持。新增角部拖动未改变尺寸，不能算最小尺寸复验；系统主题切换、系统显示缩放、其余支持尺寸与正式主题保存失败仍开放。主题保存失败焦点修复的受控结果与已实装边界见P45。[本批分层记录](evidence/2026-11-13-cycle7/interaction-followup.json)；[原进度](evidence/2026-11-13-cycle7/interaction-previous-progress.json)。

2026-11-13后续：本批所选系统缩放的正式结果见P45；纸白和提醒偏好保持，未新增系统主题切换或主题保存失败实测。 [本批证据](evidence/2026-11-13-cycle67-closure/summary.json)。

<!-- /task-current -->

<!-- task-current: P12 -->

### P12

2026-11-13：24e92正式Goose冷读原自有历史，所选中文短语1/1准确定位；WorldWideWeb两处可用Enter切换并展开对应工具内容，Escape恢复临时展开及入口焦点。零新发送；前序真实流式、70处回绕及中文emoji分项保留。仅本样本已加载正文，完整语料、更多对象和压力仍开放。 [本轮证据](evidence/2026-11-13-cycle7/README.md)；[此前进度与原链接](evidence/2026-11-13-cycle7/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: P31 -->

### P31

2026-11-17 精确标题按优先级排在较新模糊结果之前，同级仍按更新时间比较。新安装版搜索「连接测试 · Dirac」默认选中并按 Enter 打开原对话。查询字段、模糊匹配和原选择保护有回归，完整组合筛选原条件继续。[本批证据](evidence/2026-11-17-cycle12-history-and-stop/README.md)

2026-11-13：正式24e92收藏0→1→0、收藏页未发内容筛选与清除、返回原对话通过并还原。前序正式标题/Agent/未分组组合、改名、移动、归档及恢复已验，不再笼统标成整理写入待验。其他组合及失败路径仍开放；未发内容保护保持。前序直接依据：[第九批](evidence/2026-11-10-stage2-ninth-batch/README.md)、[第十一批](evidence/2026-11-10-stage2-eleventh-batch/README.md)。 [本轮证据](evidence/2026-11-13-cycle7/README.md)；[此前进度与原链接](evidence/2026-11-13-cycle7/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: P32 -->

### P32

2026-11-13：正式24e92已加载正文明确2已加载/8未加载/0未确认；所选中文短语1结果，Enter回到同一原消息并可见高亮。此前所选未加载官方历史、附件文字及多来源定位分项保留；本轮没有读取这8条未加载历史。Goose本条工具PNG冷读可保留，不能据此改判此前其他文本回放丢附件样本。完整历史、全部来源及正式压力仍开放。 [本轮证据](evidence/2026-11-13-cycle7/README.md)；[此前进度与原链接](evidence/2026-11-13-cycle7/previous-progress.json)。

e32正式零发送读取同一Mistral自有历史：2段文字、1段命中、0处未检索；命中片段与标记可见，正常关闭读取并退出。页面明确来源未确认，不据正文声称服务已恢复。只读媒体接线和带入工具显示已修；搜索仍只查用户/助手文字，已加入样本不用于冒认正式带入图片预览。[实现与正式边界](evidence/2026-11-13-cycle7/preview-media-summary.json)。

<!-- /task-current -->

<!-- task-current: P35 -->

### P35

2026-11-15 正式 OpenCode 原对话导出经选择器实际保存 Markdown，独立核 2,531 字节及原测试标记和正文。所选 ZIP、格式及其余分支沿各自原证据。[本批原件](evidence/2026-11-15-cycle7-acceptance/README.md)

2026-11-13：24e92修复窗口关闭或切快照后迟到选择器/附件核查继续派发保存；真实React/WebKit红绿、独审及完整工程通过。正式Goose原生选择器取消后明确另存4,687字节Markdown；ZIP96,736字节，仅含明确选择的90,330字节PNG，与原调用截图逐字一致且CRC/清单核合。另两项分别未选择及来源不支持，默认排除工具详情/思考/未发内容。选中项跨详情开关保持；不冒充可恢复Agent会话。旧1GiB在途取消、写满失败、变更拒绝分项保留，其他历史字节、格式、平台及完整原条件仍开放。 [本轮证据](evidence/2026-11-13-cycle7/README.md)；[此前进度与原链接](evidence/2026-11-13-cycle7/previous-progress.json)。

16ee正式零发送冷开Mistral历史后，默认不包含工具详情，明确选中唯一图片导出ZIP106,080字节；103,113字节图片与同一次原工具截图逐字一致，CRC及清单核合，1打包/0省略。图片以通用二进制成员保存，清单保留声明image/png；不冒称完整可恢复会话或归档格式认证。[导出及保留证据](evidence/2026-11-13-cycle7/mistral-media-summary.json)。

<!-- /task-current -->

<!-- task-current: P47 -->

### P47

2026-11-15 新正式 0.1.7 / OpenCode MiMo v2.6 Flash。网页审批、颜色提问、在途骤断三类各实际显示一次并播放声音，用户逐项确认听到了，点开均回对应位置。提问和中断有本次同 ID 系统点击回执；审批用本次用户定位及此前对应正式回执。中断新自建对话显示「连接中断，结果未知」。临时开启的提醒和声音已复原，独立持久化核三项全关。[本次正式实听原件](evidence/2026-11-15-cycle7-p47-hearing/README.md)

2026-11-15 同日上一正式版，选定的自建 OpenCode MiMo v2.6 Flash 请求在运行中骤断，连接未返回结束结果，横幅只显示一次且正确点击定位，声音关闭。较早的正常结束试验在断开前已收到「已停止」回执，用户未看到横幅。先前的无模型测试提醒另有实听正例。[两种结束结果](evidence/2026-11-15-cycle7-p47-p46/README.md) · [测试提醒实听](evidence/2026-11-15-cycle7-acceptance/README.md#提醒显示与余项)

2026-11-13正式ee4c：同一Goose/OpenRouter/Nemotron 3 Ultra免费模型/off/auto，用当前工具报告确认的新网页工具名只发一次请求，出现真实网页读取许可；应用在后台时，用户明确确认“看到了 Farfold 的待确认通知”。这证明一次需要回应通知实际显示；未验证声音、点击定位、去重及其他提问/中断类型。原件核实只有1次新工具名调用，同一调用返回等待确认超时错误；原39条消息编号、角色及正文核同，不把迟到的取消操作算成功。临时偏好已恢复全关，3条待发文件意见保留，公开页关闭后正常退出。[本次分层结果](evidence/2026-11-13-cycle7/history-supplement-summary.json)。

原e32一次请求因历史旧工具名被Goose连续拒绝4次，未进入网页许可；本次21项报告有4个新网页工具名，但不能倒填旧失败时的名单。此前系统菜单栏自动化长时间挂起也保留为工具阻断，均不直接归为Farfold通知失败。[前序记录](evidence/2026-11-13-cycle7/README.md)。

2026-11-13本批：29ed正式OpenCode / Xiaomi MiMo V2.6 Flash一次公开页请求的待确认通知，用户确认“没有声音，点击后回到了opencode对话，通知出现了一次”；获准后原请求正常结束。系统同一通知一次提交/显示/点击且hasSound=true，因displayShared静音。临时偏好全关恢复，页面关闭撤权；5cc零发送冷开保留此次标记/答复。此条显示、点击和单次出现通过，实际响铃及其他提问/中断类型仍未齐。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)。

2026-11-13后续：9f后续同一MiMo/Build单次question产生真实颜色表单，用户确认通知一次且点击回颜色卡；选择蓝色并提交一次，回答“你选择的颜色是：蓝色。”后正常结束。系统同通知一次显示/点击核合，声音主动关闭，偏好全关恢复。提问正例现已补齐；中断需真实活动请求意外失败条件，当前无安全确定生产者，不拿主动停止/旧失败冒认。 [本批证据](evidence/2026-11-13-cycle67-closure/summary.json)。

<!-- /task-current -->

<!-- task-current: P23 -->

### P23

2026-11-13：原公开页加载、地址/文字快照、标签切换与关闭分项保持。正式ab540的Goose经单次许可取得W3C页的标题、地址、可见文字、位置及截图，原调用与返回已核合；取消读取不返回页面内容。仅本样本，其他来源、失败及保护原条件仍开放。 [本批正式摘要](evidence/2026-11-12-cycle6/formal-summary.json)；[此前进度与原链接](evidence/2026-11-12-cycle6/previous-browser-progress.json)。

<!-- /task-current -->

<!-- task-current: P25 -->

### P25

2026-11-13：正式ab540沿已有Goose选择验证：连接工具不授予读取；一次截图许可结束后回到未允许读取；主动撤回后新文字读取必须重新确认，取消返回原调用错误且无页面内容。标签切换/关闭不恢复旧许可，正常退出移除临时工具、待处理0。此前超时保留；受控传输17项与正式结果分列，其他场景及Agent仍开放。 [本批正式摘要](evidence/2026-11-12-cycle6/formal-summary.json)；[此前进度与原链接](evidence/2026-11-12-cycle6/previous-browser-progress.json)。 a5a5正式OpenCode另验连接不自动授权、明确许可后状态改变及退出后新空对话不继承；零模型/网页工具调用，不是同一历史恢复。[OpenCode分层摘要](evidence/2026-11-12-cycle6/opencode-summary.json)。

本轮cce3的fast-agent及Mistral各一次真实网页请求均经两层单次批准，结束后页面回到未授权。16ee正式零发送重开Mistral同一历史、重新打开同一公开页后，读取许可入口就绪且仍未授权。未新增其他撤回/取消组合。[新增正式范围](evidence/2026-11-13-cycle7/mistral-media-summary.json) · [fast样本](evidence/2026-11-13-cycle7/fast-page-summary.json)。

<!-- /task-current -->

<!-- task-current: P27 -->

### P27

OpenCode 2.2.7 / 小米MiMo已取得一次正式截图及Farfold重开显示正例；新原生记录/PNG字节哈希未核，图像理解及其他原组合不扩认。最新选择、动作和证据统一见[P28](#p28)。

2026-11-13：同请求截图回传已有正式正例。ab540所选Goose的一次observe_page(screenshot=true)经明确许可，原callId收到文字与image/png；原件90,330字节、509×518，已打开核对W3C当前可见页、来源和元信息一致。首次确认超时未交付，独立第二次成功；未自动重试。此结果不证明模型图像理解，保护输入、其他来源/Agent/平台及未覆盖原组合仍开放。 [本批正式摘要](evidence/2026-11-12-cycle6/formal-summary.json)；[此前进度与原链接](evidence/2026-11-12-cycle6/previous-browser-progress.json)。

本轮cce3另取得fast-agent同调用90,330字节PNG与Mistral103,113字节PNG的正式返回。Mistral初始显示失败已由16ee修复，正式零发送冷开显式展开可见原W3C图片，ZIP图片逐字一致；fast当时冷开工具/图片仍缺失，最新修复见下段。模型理解、保护输入及未覆盖场景保持未验。[Mistral修复复验](evidence/2026-11-13-cycle7/mistral-media-summary.json) · [fast分层结果](evidence/2026-11-13-cycle7/fast-page-summary.json)。

ee4c已将官方导出接回fast冷开工具/图片。原同一历史正式零发送恢复正文→1工具步骤→回答；显式展开可见原W3C截图，原90,330字节PNG及工具/正文/配置核同，旧冷开缺失已解决。其他原条件与旧bash停止失败保持。[正式范围](evidence/2026-11-13-cycle7/history-supplement-summary.json)。

<!-- /task-current -->

<!-- task-current: P28 -->

### P28

2026-11-17 隔离 Pi 验证确认 SDK 1.5.2 可用内存会话保留原字节，直接 `open` 会写回特定旧格式或空副本。官方 MCP stdio 可以使用直接子进程，只在网页助手上关闭继承环境，合成调用和进程清退通过。已发布 pi-acp 仍待转发，正式会话 SDK 接线、签名助手和页面授权回包待实现与实测。[本轮核验](evidence/2026-11-17-cycle12-history-and-stop/README.md#pi-sdk-零请求核验)

2026-11-17 续核：当前本机目录仍为 `pi-acp 0.0.34`，已选 Pi `0.87.1`。SDK 1.5.2 接法未进入正式版。只读预览需要以有界方式读取选定历史后调用官方解析及内存接口，`SessionManager.open` 对特定旧格式会写回。网页接线须复用原会话进程身份、直接子进程及撤回检查。[本轮路径与限制](evidence/2026-11-17-cycle12-file-validation/README.md#pi-sdk-路径续查)

2026-11-15 接入复核：目录的 `pi-acp` 0.0.34 读取但不向 Pi 传递会话 MCP 设置。厂商 SDK 1.5.2 受控验到独立会话内的 stdio 工具、拒绝、撤回断开及旧版合成历史同 ID 恢复。全运行启动可能补写默认思考档，只读预览应走官方 SessionManager。Farfold 新版接线、实际页面权限和图片回包待实装复验。该批调查的首发范围为当时的 28 家，当前按 21 家逐项续验。[Pi 核验原件](evidence/2026-11-15-official-alternatives/pi.md)

2026-11-13后续：用户手动更新OpenCode并添加小米服务后，本次实际握手为2.2.7。原对话已确认保存xiaomi/MiMo-V2.6-Flash，单次observe_page(screenshot=true)经一次许可返回正确W3C标题/网址及可见PNG，随后恢复未授权；正常退出Farfold后零发送重开，工具、答复和显式展开图片仍可见。原索引/草稿与新模型保存已独立核合；新版本实际原生存储未定位，MiMo原始记录/PNG字节哈希仍未核，不把旧数据库缺marker判为失败。未验证图像理解及其他原组合。[本次分层证据](evidence/2026-11-13-cycle7/history-supplement-summary.json)。

此前2026-11-13：Goose共用网页接入已有正式单次截图、撤回后重新确认、取消与退出恢复原7工具。OpenCode接入及无模型准备/恢复分项保持；后续沿已有Big Pickle/build的一次真实公开页请求，184秒内无回复/工具/审批，正常停止后原生用户消息存在、助手无正文和工具。后续同SID原日志已查到build/title的免费额度已用尽错误，早于取消；当前额度未重探；本次原ACP错误包缺失，无法判断传递，不擅自换模型。

cce3已正式安装fast-agent/Mistral无秘密多连接接入，避免将可用授权放入官方日志或持久化配置，并支持发现后重建连接。独审、受影响检查及完整工程通过；两家正式空对话均就绪、页面未自动授权并正常退出。fast-agent保留原codexplan选择，随后一次真实observe_page(screenshot=true)经Agent单次批准及Farfold截图许可，返回文字/PNG及正确标题、网址，结束后页面恢复未授权。一次零发送冷开只读回用户正文和最终答复，工具步骤/PNG未呈现；原历史及PNG字节保持，当时官方回放遗漏独立工具结果；后续ee4c通过用户批准的只读出口补齐并正式零发送复验，见下段。Mistral后来获用户明确追加一次公开页请求，已按原medium-3.5/High完成：两次官方工具发现、一次网页观察、正确网址/标题及103,113字节PNG；正常退出后正文、三工具步骤冷读回，同页重开未授权且连接就绪。初次PNG只按JSON/文字呈现；16ee补入通用附件，正式零发送冷开在工具技术详情内展开图片可见W3C页，并导出106,080字节ZIP，其103,113字节图片与原件逐字相同。原8条上下文消息、9条呈现历史及模型/High均保持；16ee当时尚未覆盖带入/搜索预览。追加预算现已用完，不再发送。该批旧 Bash 停止失败保留。第 12 周期已确认 fast-agent 委托前台终端可停止，旧自管工作和工具终态仍按各自证据判断，见 [ARCH-44](#arch-44)。

同包官方fast-agent只读导出已单次成功，精确原对话/工具ID及90,330字节PNG核合，三个原历史文件字节和元数据不变；当时确认存在可用补充出口；ee4c现已接回普通冷开，并正式验证原工具及截图，原正文/工具/PNG/配置保持。该格式转换工具文字且带系统字段，不作为无损原始历史或完整恢复证明。[实际出口验证](evidence/2026-11-13-cycle7/fast-export-summary.json)。

Pi官方未桥接MCP；Codex受NEW-24暂停；OpenCode两次免费服务失败保留，当前小米MiMo网页与重开显示正例见本项开头；fast工具/图片冷回放已正式修复，Mistral正式未加入历史的图片预览及其余恢复/停止仍待验证；e32只读媒体接线和带入工具显示已实装，分层验证见[本批摘要](evidence/2026-11-13-cycle7/preview-media-summary.json)。最新fast正式补充恢复、OpenCode错误核查见[本批记录](evidence/2026-11-13-cycle7/history-supplement-summary.json)。五家调查仅覆盖当批范围。当前 21 家和各适用原条件继续按第 12 周期验收。[本轮分层证据](evidence/2026-11-13-cycle7/README.md)；[共用正式摘要](evidence/2026-11-12-cycle6/formal-summary.json)；[OpenCode此前分层](evidence/2026-11-12-cycle6/opencode-summary.json)；[此前进度](evidence/2026-11-12-cycle6/previous-browser-progress.json)。

<!-- /task-current -->

<!-- task-current: P30 -->

### P30

2026-11-13：983b修复标签A→B→A后迟到HTML选择替换原页面，相关213项、受控WebKit红绿及独审通过，已随ab540安装。正式同网址新标签不继承许可，返回原标签不恢复许可；关闭获准标签后剩余标签仍未共享。迟到原生文件选择器的正式精确时序未重演；既有恢复分项及未覆盖组合保持。 [本批正式摘要](evidence/2026-11-12-cycle6/formal-summary.json)；[此前进度与原链接](evidence/2026-11-12-cycle6/previous-browser-progress.json)。

2026-11-13本批：5cc正式自有网页普通手动文字读取→加入虚构密码字段后明确拒绝→移除后再次手动读取成功。原通用错误已改为准确说明本次未读取，不泄露字段值、不自动重试。未扩大Agent许可；其他来源/迟到选择等未验组合保留。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)。

<!-- /task-current -->

<!-- task-current: H07 -->

### H07

2026-11-13：网页连接命令限主窗口，直接Unix请求核真实Agent进程和连接生命周期，复用页面/版本与逐次许可。受控身份/部分输出/停止检查与正式Goose许可、撤回、同请求截图分开取证；不将其扩为系统级外部工具隔离。跨来源、导航、重开以及其他平台完整原条件仍开放。 [本批正式摘要](evidence/2026-11-12-cycle6/formal-summary.json)；[此前进度与原链接](evidence/2026-11-12-cycle6/previous-browser-progress.json)。

2026-11-13补：未改生产WK页面实现的原生受控验证完成初始、同源导航、跨回环来源、关闭重开四阶段，12次子页面桥尝试均未到达，合成父只读桥2次对照正常，旧页面标识拒绝。只证明该受控隔离路径；未覆盖正式Tauri调用、公开HTTPS策略及新的迟到竞态，不记H07整项通过。[分层记录](evidence/2026-11-13-cycle7/interaction-followup.json)。

2026-11-13本批：29ed及5cc正式自有本地HTML与本机网页内，脚本检查主调用/IPC/桥入口均undefined；同时正常主应用文字读取、受保护字段拒绝和移除恢复有正例。该正式样本补入边界，不替代公开HTTPS来源、完整导航及迟到调用原条件。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)。

<!-- /task-current -->

<!-- task-current: P39 -->

### P39

2026-11-11核。共用清单分项已实装。Codex所选官方技能清单可区分项目与额外目录，范围变化使旧报告过期；Goose正式全部工具17项、developer范围5项，切换范围不自动读取，旧报告保留原范围。扩展配置报告返回7项，官方未给的来源与连接状态保持未知。第十一批回执后焦点丢失已由f92d19505修复并正式复验，保持「重新读取」、Tab双向回绕及Escape归还；e1762610b正式复验仍保持并提供动态结果提示。仍缺其他Agent、清单完整性及其余正式长等待/失败/取消组合；具体结果句读屏见P45，配置采用与连接调用见P41。 [Codex技能范围](evidence/2026-11-03-conversation-controls/control-formal-summary.json) · [清单与范围](evidence/2026-11-10-stage2-tenth-batch/README.md) · [焦点修复](evidence/2026-11-10-stage2-twelfth-batch/README.md) · [当前提示与读屏边界](evidence/2026-11-11-stage2-fifteenth-batch/README.md)。

2026-11-12补正式分项。c68所选Codex自有项目技能在审阅后位置失效，确认被明确拒绝且未发配置修改；恢复原字节后重新查询仍启用，重新审阅后关闭，再查仍启用。699b所选Goose外部变化报告可完整审阅本样本8项保存设置，接纳后明确重开读取18项活动工具，撤回自有项后刷新为17项。只证明各自样本，未把配置报告等同实际工具采用；长等待/在途取消、其他来源与清单完整性仍开放。[技能分项](evidence/2026-11-12-cycle4/skill-recovery-summary.json) · [本轮正式分项](evidence/2026-11-12-cycle4/formal-summary.json)。
<!-- /task-current -->

<!-- task-current: P41 -->

### P41

2026-11-12核。**Goose当前对话无凭据HTTP工具的添加、保存后正常发送、一次真实调用、撤回及冷开已通过正式窄例；初始化失败、迟到结果及带待核记录冷启动的恢复也已分项验证。P41整体仍开放。** Codex正式停用项添加/核查/移除、确认前取消与原配置恢复的既有证据保留。[Codex配置与取消](evidence/2026-11-10-stage2-fourteenth-batch/README.md) · [Goose实际调用与失败恢复](evidence/2026-11-12-current-session-mcp/saved-editor-summary.json) · [迟到结果与冷启动恢复](evidence/2026-11-12-current-session-mcp/recovery-summary.json)。

共用当前对话管理已实装：准确清单和短期管理编号支持审阅添加、精确撤回；写入前保存本条待核摘要。未知结果阻止本条发送/加载/分支及相关配置、账号来源变更，关闭面板或超时不视为取消。原进程结束后，在加载历史前显式读取保存配置；二次核对与明确确认后才清除本条保护，再由用户重开，不自动发消息或重放修改。空对话首次保存后仍停准备页的缺陷已由8f80修复，原输入转入同一对话且可发送。恢复指引已由f537修正并安装。完整工程、受控界面与独审的版本范围见[实现及原始失败](evidence/2026-11-12-current-session-mcp/README.md)。

正式8f80自有20261112_1在原Ultra免费模型/off下只发送一次只读指令，端点收到一次准确工具/空参数调用并返回界面可见校验正文。撤回后保存及活动报告均缺席；冷重开同一历史，仍运行的端点没有新增连接。初始化失败后显式核查原设置未变、确认并重连，历史与未发送草稿保持。正式f537又验证初始化延迟超过界面等待期限后，显式检查收到同一操作成功；另一次在待核时正常退出，冷开保留准确待核标识并阻止加载/发送，没有联系端点；明确核查确认后原历史和草稿恢复。两次延迟试验零模型请求、零工具调用；原消息行及非自有对话行、服务配置和模型选择保持，最终待核为零。[本轮原件摘要](evidence/2026-11-12-current-session-mcp/recovery-summary.json)。

空对话补验：仅保存过工具、从未发送消息的自有20261111_7在f537误报读取失败；跨对话待核清除前后均复现。c68通过官方精确零消息核验并识别用量元数据，完整读取边界、旧内容及配置保护保持；新增读取队列只处理当时有限前缀。正式两次冷开均正常，输入后发送可用但未发送，原文件意见及新自有草稿保留；原20261112_1消息和失败草稿亦读回。上下文显示0/1,000,000 tokens，累计值及费用仍明确未知。本轮零新增请求，原消息、其他对话行及配置选择保持，最终待核零。关联ARCH-35仅新增此上下文呈现分项。[修复及正式证据](evidence/2026-11-12-current-session-mcp/empty-history-summary.json)。

2026-11-12最终699b补验：原修改结果未知并正常退出后，独立官方接口只为精确自有对话添加一项以形成外部变化；该步骤是夹具准备，不记作产品恢复。正式界面保留待核，完整展示本样本8项保存设置，明确接纳后仍要求重开、不自动发送；重开后活动清单18项，精确撤回该项并刷新为17项。后续同一父对话正式历史点分支成功，父子冷读回、原消息及六条未发文件意见保留；最终闭库核对待核为零，父子分支和冷开期间仍存活的撤回端点没有新增连接。接纳当前设置不等于原未知修改成功。本轮零模型请求、零工具执行；一次夹具拒绝的POST未保存方法，不能断言零工具调用尝试。清单过长遮住操作按钮的真实失败也已修复，最终正式入口可完成操作。[本轮正式原件](evidence/2026-11-12-cycle4/formal-summary.json) · [修复与边界](evidence/2026-11-12-cycle4/README.md)。

**剩余开发：** Goose当前对话添加入口仅支持无凭据HTTP；程序型、凭据HTTP及更广设置的安全审阅接纳、其他Agent管理接线仍待实现或核实，不归为仅缺账号。**剩余验证：** 官方修改回执丢失、其他失败/在途取消、更多Agent和平台未覆盖。已接纳只限完整可展示的内置/平台项与无凭据HTTP公开固定路径；私密地址、未知字段等仍保留待核。旧官方进程[生命周期分项](evidence/2026-11-11-mcp-lifecycle/README.md#官方mcp生命周期判别)保留，与本轮正式界面证据分列。

空mcpServers仍不是撤回；官方增删先改活动状态再保存，单独成功回执或清单不足以确认，list/load也无原子保证。只处理实际受影响对话，不新增全部历史门槛。[原源码边界](evidence/2026-11-11-reviewed-reliability/mcp-restoration.md)。

<!-- /task-current -->

<!-- task-current: P45 -->

### P45

2026-11-15 同日上一正式版在 900×620、应用缩放 150% 下补验内容栏和全局搜索键盘操作及焦点返回，结果见 P46。旁白依用户决定暂缓，其余关键路径仍按原条件取证。[最小窗正式原件](evidence/2026-11-15-cycle7-p47-p46/README.md)

2026-11-13用户最新指令：旁白部分先不做。实际读屏和准确结果播报暂缓，不记作通过、不阻塞本轮其他开发；下列原证据与缺项保留，键盘、焦点、主题和支持尺寸继续。

2026-11-11核。所选搜索、导出、工作树、准备页和预览路径已有正式键盘分项。工具报告回执后焦点丢失已修，正式验证保持「重新读取」、Tab双向回绕和Escape回原入口。网页关闭后焦点接续剩余或新空白标签已修并正式验证；1280×820内容栏键盘调宽及恢复已验。e1762610b正式版的报告动态状态已实装并暴露给辅助功能树。用户撤回首次听到确认；后续正常旁白复测有语音活动且用户听到内容，具体结果句仍未确认。仍缺动态结果播报、真实长等待核查、其他关键路径读屏、系统缩放及完整支持尺寸验收，本项开放。 [搜索键盘](evidence/2026-11-10-stage2-tenth-batch/README.md) · [导出与工作树](evidence/2026-11-03-conversation-controls/control-formal-summary.json) · [准备页回焦](evidence/2026-11-05-reliability-stage/formal-summary.md) · [报告焦点](evidence/2026-11-10-stage2-twelfth-batch/README.md) · [网页焦点及调宽](evidence/2026-11-10-stage2-fourteenth-batch/README.md) · [动态状态与旁白更正](evidence/2026-11-11-stage2-fifteenth-batch/README.md)。

2026-11-12新增当前对话工具恢复入口的受控键盘分项：WebKit实测确认等待超时后焦点跳离；修复后用同一Option+Tab/Enter步骤，焦点留在「检查确认结果」。非当前对话仍禁用；双浏览器合成回归通过。尚未替代正式安装、真实等待或实际读屏验收。[本批证据](evidence/2026-11-12-current-session-mcp/README.md)。
2026-11-13补：24e92正式查找Enter切换/Escape恢复焦点、CmdK与Enter跳回匹配、Markdown对话框Tab/Shift+Tab回绕和Enter调用保存选择器已有窄例。cce3随后系统窗口“缩放”实际变为1920×994，首页输入与导航可见；角部缩小及再次缩放未在当次观察恢复原尺寸。此为窗口放大，不是系统显示缩放；最小尺寸、其他关键界面及实际读屏仍未验。[本轮证据](evidence/2026-11-13-cycle7/README.md)。

16ee随后正常启动的实际窗口为1280×820，图片展开及导出可操作；这是新一次窗口观察，不补认前次缩放按钮已恢复，也不替代最小尺寸/系统缩放和读屏。[正式观察](evidence/2026-11-13-cycle7/mistral-media-summary.json)。

e32正式所选历史读取可Tab聚焦执行并Enter启动；匹配文字弹窗Tab回绕，另用键盘从命中按钮Enter打开、Escape关闭后焦点回到原命中按钮。首次AX指针打开后的document焦点不算此键盘正例。实际1280×820，拖角未改变尺寸；精确读屏与支持尺寸仍未齐。[本轮观察](evidence/2026-11-13-cycle7/preview-media-summary.json)。

2026-11-13续补：主题保存失败导致键盘焦点丢失已修并实装ee4c；同一WebKit红例转绿，Chrome亦通过，两者各15项，正式未注入保存失败，不扩大此验证范围。正式e32工具报告17项/7项可见，键盘读取后焦点及Escape回入口保持；第二次旁白实听反馈为窗口、范围和按钮标签，准确结果句仍未通过，原因待查。旁白和欢迎偏好已恢复。[本批分层记录](evidence/2026-11-13-cycle7/history-supplement-summary.json)。

2026-11-13续补29ed：隐私确认展开/取消焦点修复已正式复验，外层Escape回原入口；此前ee4c快捷键弹窗双向Tab回绕与Escape回入口亦通过。旁白继续按用户指令暂缓，系统缩放、最小尺寸和其余原路径不扩认。[本批证据](evidence/2026-11-13-cycle7/interaction-followup.json)。

2026-11-13本批：5cc常用指令纯键盘流程及9f历史读取成功/失败的焦点保持已正式通过，详见P44。双浏览器完整样式900×620浅/深主题为受控观察；实际本次1280×820。系统显示缩放和完整支持尺寸仍未实际覆盖；旁白继续暂缓。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)。

2026-11-13后续：9f进一步通过系统显示设置从1920×1080改1280×720并恢复，正式截图1280×634下首页、历史带入弹窗与提醒设置关键动作可见可达。系统缩放已获此窄正例；不是任意DPI、大字号及精确900×620全部路径通过。原生菜单无半屏入口，侧边拖动无变化后停止；旁白未启用。 [本批证据](evidence/2026-11-13-cycle67-closure/summary.json)。

<!-- /task-current -->

<!-- task-current: P48 -->

### P48

2026-11-15：用户授权临时开声音，实际点击测试提醒，用户看到且听到。原偏好恢复关闭。证据范围为本机本次正式无模型测试提醒，真实意外中断及各类型原条件仍待证。[正式原件](evidence/2026-11-15-cycle7-acceptance/README.md)

2026-11-11核。完成提醒的后台系统接收、偏好关闭不提交、实际显示和真实点击定位已有正式分项；第十一批还验证应用完全退出后点击系统提醒，冷启动回到发出提醒的精确对话，未自动发送。应用请求了默认声音，但系统将该次提醒静音，实际响铃正例仍未验。其他提醒类型、系统拒绝和过时撤回等原条件继续开放。[显示及点击](evidence/2026-11-10-notification-and-selected-search/README.md) · [冷启动点击与静音证据](evidence/2026-11-10-stage2-eleventh-batch/README.md)。
2026-11-13核：既有完成提醒显示/点击及冷开证据原件哈希仍核合；本次只新增P47待确认通知显示，未新增完成提醒或实际响铃证据，临时偏好已恢复。实际响铃和其他原条件不变。[本轮证据](evidence/2026-11-13-cycle7/README.md)。

2026-11-13本批：本批P47新增待确认通知的显示/点击/一次出现及系统displayShared静音证据；不把它改记成成功完成通知或响铃正例。原完成提醒分项继续有效，实际声音仍缺条件。 [本批实现、正式结果及限制](evidence/2026-11-13-cycle67-closure/README.md)。

<!-- /task-current -->

<!-- task-current: P01 -->

### P01

2026-11-11修复已随92e052a67安装。普通草稿保存、导航、冷开及保存失败的既有正式分项保留；审查另复现合法音频/文档草稿被备份恢复预览拒绝，非普通重启丢稿。本批恢复与正常读取共用格式解析，严格未知字段及发送前重新核对保持；生产序列化和prompt builder回归、关联25文件466项通过；真实WebKit/Chrome受控恢复预览与取消各83项检查包含此路径，未写生产库。正式备份恢复、真实外部附件重核及其他原条件仍待验证。[本批范围](evidence/2026-11-11-reviewed-reliability/README.md)；[原进度与历史证据](maintenance/2026-11-11-task-current-source/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: H02 -->

### H02

2026-11-11修复已随92e052a67安装。合法音频/文档备份中的未发送内容不再被过期字段清单拒绝；未知未来字段仍阻止整组恢复，不从元数据获得新的文件读取许可。生产格式及真实WebKit/Chrome受控预览/选择/取消回归通过；正式恢复入口、完整IPC、整库损坏/中断及系统故障原条件仍开放。此前版本99拒绝覆盖等原分项保留。[本批范围](evidence/2026-11-11-reviewed-reliability/README.md)；[原进度](maintenance/2026-11-11-task-current-source/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: H18 -->

### H18

2026-11-11补Windows消息本地路径解析与点击链的受控修复，支持明确驱动路径和file URI，UNC/设备/网络目标不激活。另补普通/安全env及所选服务的Windows同名键覆盖算法检查；关联检查在Mac通过，不算Windows桌面实测。最后完整Windows CI仍为固定2e23056cc的41931045918；5598138f2原生30项/前端20项仍限原输入；安装修复5b9f1449a的41984263036因付款或额度未分配runner，安装卸载及当前完整平台验收未执行。[本批范围](evidence/2026-11-11-reviewed-reliability/README.md) · [既有平台原件](evidence/2026-11-05-management-install/README.md)；[原进度](maintenance/2026-11-11-task-current-source/previous-progress.json)。

2026-11-15 用户将 Windows 实机后置。第 9 周期复核固定 Windows 原件，并在 Mac 上完成安装脚本受控检查和路径、凭据、终端相关定向检查。新的定向 CI 未获运行机器；Mac 上以 `x86_64-pc-windows-gnullvm` 对当前工作区的严格 Clippy 退出 101。日志记录 Windows 正式代码中未使用的 Mac 网页共享入口及关联写法，还有测试声明位置和枚举命名警告。续接先核当前源码与候选，仅复测仍受影响的项。[CI 原件](https://github.com/KPGH-FJ/farfold/actions/runs/43690997618) · [交叉检查与安装脚本回执](evidence/2026-11-15-cycle9-desktop/installer-and-cross-clippy.md)。

<!-- /task-current -->

<!-- task-current: ARCH-03 -->

### ARCH-03

2026-11-11明确普通/安全env输入已随92e052a67安装。普通值仍按原值保存，不宣称系统凭据保护，不按名称自动迁移；安全值只进系统凭据，登记/pending只保留引用与非秘密归属。跨区重复、保留标记和非法值拒绝；失败发布/清理可恢复，缺失安全引用阻止启动而非沿用继承账号。定向与完整工程检查通过；Mac自有合成值的真实系统凭据登记、读取、移除另以1项显式测试通过，临时SQLite只存标记。正式1280×820界面已验遮蔽、跨区重复/保留值错误、三项滚动、Tab/Shift+Tab、暂存重开及放弃清空；程序留空，未登记真实Agent。正式成功添加/后端失败、原编辑/初始化完整条件仍待验。[本批范围](evidence/2026-11-11-reviewed-reliability/README.md)。

<!-- /task-current -->

<!-- task-current: H04 -->

### H04

2026-11-11补新安全env的删除与重置归属：先清准确凭据再删登记；失败保留引用/待清理记录供重试；普通env不触发孤儿凭据清理。卸载保留被普通/安全目录或PATH片段使用的程序，读不到安全值时保持程序；单独卸载与清数据互斥。临时目录/SQLite及假凭据的正反例通过，Mac真实系统凭据的自有单项移除已另验；正式完整重置、中断恢复及整项仍开放，未执行生产清库。[本批范围](evidence/2026-11-11-reviewed-reliability/README.md)。

<!-- /task-current -->

<!-- task-current: P18 -->

### P18

2026-11-15 第12周期：Cursor 自有 TXT 样本实际整理并另存，152 字节逐字节准确、原件保持，能从本轮产物打开。仅覆盖本样本的结果交付，余下多文件、差异及失败条件依原项。[第 12 周期](evidence/2026-11-15-cycle12-macos/README.md)

2026-11-11核。**一次编辑多个片段已有正式正例，完整P18仍开放。** macOS正式97479b185的Mistral Vibe沿用已有服务、Mistral Medium 3.5及High，一条请求、一次编辑返回第3和18行两片段，正式面板逐片打开；494字节改后文件完整核合，除两处标记外其余字节保持。前序OpenCode实时输出与零输出入口、Goose容量呈现及失败/成功编辑、当前文件核验仍限各自样本。[多片段原件](evidence/2026-11-10-stage2-live-mistral/summary.json) · [前序编辑分项](evidence/2026-11-02-p18-edit-diff-formal/failed-edit-diff-and-source-summary.json) · [完整历史及原链接](maintenance/2026-11-11-task-current-source/previous-progress.json)。

2026-11-12交叉补证。699b正式DOCX返工的一次用户/ACP发送留下6组实际shell请求与成功回执，均有退出码0和空stderr；修改前后XML输出及工具计算的文件SHA与磁盘核合。首条命令列出自有工作目录，其余显式文件操作针对所选DOCX。本次未打开细粒度差异面板，不新增工具差异UI覆盖；7条带官方用量的回复不称一次模型调用。Office主链见[P22](#p22)及[本轮原件](evidence/2026-11-12-cycle5/formal-summary.json)。

仍缺合格的现有未知工具回放对象、拒绝与进行中差异窗口，以及其他来源、状态、Agent和系统的未覆盖组合；旧N/O样本的原工具终态和归属未齐，旧输出样本未证的原始字节、退出码/LF等不由新Mistral或DOCX正例补齐。原Mistral/Poolside恢复及Kilo原目录缺失等具体限制沿原证据，不重发旧请求或造替代对象，不提升整项或整家验收。[原对象及剩余条件](evidence/2026-11-02-p18-edit-diff-formal/conditions-and-preservation-summary.json) · [旧输出范围](evidence/2026-11-02-p18-capacity-formal/p18-capacity-summary.json)。

2026-11-12补范围核对。新自有返工停止发生在思考阶段，没有新增持久编辑工具记录，不追加进行中差异或拒绝覆盖。官方同会话直接恢复已返回四种模式，后端加载/更新/序列化受控回归也保留四项。原8c13菜单只露出auto而键盘可到approve；95a5将共用子菜单移出父层滚动区域后，正式四选项可见，键盘/两层Escape/外部关闭通过，选择仍须确认。一次实际approve请求显示精确path/before/after，拒绝一次后工具报告未成功、Agent回复未修改，65字节原稿SHA保持；已恢复原auto/free/off。该样本提供完整输入，不冒称返回丰富差异或进入写入期。 再次冷开仍显示工具未成功和未修改，三条未发送意见及版本保留，270条消息与其他62条会话记录保持，零自动重发。[本批原件](evidence/2026-11-12-cycle5-completion/summary.json)。

<!-- /task-current -->

<!-- task-current: P16 -->

### P16

2026-11-12核。**所选Office/PDF/图片的应用内预览和失败保留已有正式分项，P16完整条件仍开放。** 699b正式打开自有最小DOCX并提出段落意见；Agent改写后明确重读显示新日期。1244字节成品独立核合：只改变指定日期，标题加粗、斜体、表格、负责人及页设置结构保持，另外两个ZIP成员逐字节相同；不把最小文档扩大为完整Office排版保真。[本轮正式证据](evidence/2026-11-12-cycle5/formal-summary.json)。

原正式坏首工作表→第二表42、坏的原选中表保留旧表→明确另选77，以及密码PDF、截断DOCX、坏PNG/PPTX重读失败保留旧画面、有效新版本才采用的分项保持。PPTX仍为部分预览，更多格式、复杂排版、超限和实际在途取消/超时组合未齐。[工作表首次失败](evidence/2026-11-08-live-status-workbook/README.md) · [工作表换版](evidence/2026-11-10-workbook-and-unread/README.md) · [PDF](evidence/2026-11-10-pdf-and-exit/README.md) · [DOCX](evidence/2026-11-10-document-tabs-delivery/README.md) · [坏图复验](evidence/2026-11-10-verified-delivery/README.md) · [PPTX反馈](evidence/2026-11-10-stage2-tenth-batch/README.md)。

本轮另复现文件选择器卸载后，原生选择或读取的迟到结果仍能继续读取/打开；4ef6改为卸载时同步失效，受控真实WebKit正反例、独审和完整工程检查通过并已安装。正式4ef6冷开后，原生文件选择取消保留同一对话及意见，再次选择同一DOCX显示新日期。受控卸载竞态与正式取消/重选分列，不冒称已在正式应用制造该精确时序。[修复范围](evidence/2026-11-12-cycle5/README.md)。

2026-11-12新增8c13正式分项。PPTX普通组合及平移/非均匀缩放的文字、形状和图片可预览；DOCX主题色采用正确HSL明度及底纹前景/背景，正式样本与作者依据核对。未支持格式和字体差异提示保留，不扩大为完整Office保真。两份合法工作表均在首次可操作观察前完成，本轮没有实际派发读取取消，仍未验。[本批原件](evidence/2026-11-12-cycle5-completion/summary.json)。

2026-11-12补取消执行层：在真实WebKit和生产React/Worker中，既有合法工作表解析已收到目录后经可见按钮取消，Worker退役且无完成结果；意见保持，明确重选小表恢复内容，再选同一大表完成80,008单元格。文件捕获与持久化回执受控，不追加正式应用或OS读取取消成功。[分层证据](evidence/2026-11-12-cycle5-closure/summary.json)。
<!-- /task-current -->

<!-- task-current: P20 -->

### P20

2026-11-12核。699b正式自有DOCX被Agent改写后，仍打开的旧预览自动提示「文件已变化。当前内容和意见保持不变」，尚未手动读取时已留证；明确重读后才显示新日期。此前工作簿同路径42→43的自动提示、保留原选中表和分开旧意见仍有效。这里的自动发现不等于静默采用新版。[本轮DOCX](evidence/2026-11-12-cycle5/formal-summary.json) · [原工作簿](evidence/2026-11-09-usage-workbook-refresh/README.md)。

失败保留的正式分项包括坏选中工作表、需密码PDF、截断DOCX和坏PNG；有效版本才更新，旧意见保持原摘要。其他格式自动发现、阅读位置、删除/重命名、实际在途取消和更多失败组合仍待；完整P20开放，不以一次明确重读替代自动发现证明。[工作表换版](evidence/2026-11-10-workbook-and-unread/README.md) · [PDF](evidence/2026-11-10-pdf-and-exit/README.md) · [DOCX](evidence/2026-11-10-document-tabs-delivery/README.md) · [坏图复验](evidence/2026-11-10-verified-delivery/README.md)。

2026-11-12本批两份工作表的选择读取自然完成，未取得在途取消结果。其正常内容与意见保留已有正式观察，不替代取消或所有格式刷新证明。[本批原件](evidence/2026-11-12-cycle5-completion/summary.json)。

2026-11-12补重新读取退出路径：真实生产prepare Worker运行后，夹具父层active=false驱动清理；重新展开保留同版本和意见并完成。返回/收起出口已存在，没有为取证修改生产行为；父壳和捕获回执是夹具，正式在途取消组合保持未验。[范围](evidence/2026-11-12-cycle5-closure/summary.json)。
<!-- /task-current -->

<!-- task-current: P21 -->

### P21

2026-11-12核。文字、Office和所选视觉区域的版本意见已有正式分项。本轮699b自有DOCX以原1239字节版本提出段落意见，只有明确发送才交给Goose；实际改后1244字节内容重读后另留一条新版本意见，未加入或发送。原发送意见与新未发送意见分属各自SHA，不把文件变化改写成旧意见对应新版。4ef6正式冷读回核到原用户消息仍带原SHA、未发一条意见仍带改后SHA与原正文；未新增发送。[本轮正式证据](evidence/2026-11-12-cycle5/formal-summary.json)。

此前跨导航、所选工作簿意见冷读回、原首发前意见找回、PDF/DOCX/PNG失败保留，以及同名另存失败后原稿/意见保留的正式分项继续有效；不同格式的范围、恢复和迟到结果不能相互替代。完整P21仍开放；更多格式/区域、读取/写入及返工其他阶段取消、其他Agent及恢复组合未齐。[意见找回](evidence/2026-11-09-presend-visibility/README.md) · [PDF版本意见](evidence/2026-11-10-pdf-and-exit/README.md) · [DOCX保留](evidence/2026-11-10-document-tabs-delivery/README.md) · [同名失败及另存](evidence/2026-11-12-current-session-mcp/formal-followup-summary.json) · [完整旧进度](maintenance/2026-11-11-task-current-source/previous-progress.json)。

2026-11-12正式8c13冷读回核到原两条未发送意见及对应SHA，新增富文本工作表意见保持版本。真实返工停止后的关闭态核对确认原65字节文件保持，已发送意见留在用户消息，另三条未发送意见已保存；随后再次正常冷开，原用户消息及三条意见均真实读回，输入框空闲、零新增发送；正常退出后全部265条原生消息保持。取消发生于思考阶段，文件写入期取消仍未验。[本批原件](evidence/2026-11-12-cycle5-completion/summary.json)。

2026-11-12补真实组件/Worker取消与重新选择，8个观察点的意见路径、版本身份和正文逐字相同；取消页保留意见，表内容需明确重选后恢复。该段持久化受控，不增加正式冷恢复覆盖；既有正式版本意见证据保持。[范围](evidence/2026-11-12-cycle5-closure/summary.json)。
<!-- /task-current -->

<!-- task-current: P22 -->

### P22

2026-11-11核。**正常文字返工与实际另存已有正式窄例，完整P22仍开放。** macOS正式c876的Mistral样本完成版本意见、一次返工和43字节源文件/另存副本逐字节核验；三个观察窗口与227.613秒全程分开，不作180秒内完成或性能承诺。Goose正式91dadecc的既有OpenRouter/Nemotron 3 Ultra免费模型、off样本完成60→59字节返工，发送意见与原消息保留原SHA，新稿可读；随后b40256367正式另存59字节副本并核合，这是跨批串联，未新增正文请求。本次只读核合原记录及当前改后源文件；Goose原另存记录未列副本路径，本次未重读副本，原已观察成功保留。[Mistral完整正常样本](evidence/2026-10-24-agent-acceptance/p22-formal-c876-versioned-rework-summary.json) · [Goose返工](evidence/2026-11-09-presend-visibility/real-reply-and-restore.json) · [Goose另存](evidence/2026-11-10-document-tabs-delivery/summary.json)。

选址前取消保留原稿和意见、选址中源变化拒绝且无残留、重读后78字节另存已有独立正式分项；同目标不同来源/版本忙态仅受控。读取/写入及返工其他阶段取消、其余失败、正式并发、其他格式及其他未覆盖组合仍待，不能把这些分项拼成全部旅程通过；旧失败、时间与来源限制保留，不提升整项或整家验收。[选址前取消](evidence/2026-10-24-agent-acceptance/p21-formal-c876-version-retention-cancel-summary.json) · [源变化拒绝与恢复](evidence/2026-11-09-delivery-feedback-browser/README.md) · [并发边界](evidence/2026-11-10-workbook-and-unread/README.md) · [完整历史](maintenance/2026-11-11-task-current-source/previous-progress.json)。

2026-11-12正式f44的原失败保留：沿既有Goose返工产物的自有副本另存，同名失败后源与既有目标字节不变，未发送意见仍可读；重读后新59字节副本与源SHA核合。当时成功界面仅给长路径，缺少直接打开副本入口；元数据变化还会影响版本判断，受控扩展属性反例已复现，具体是谁改变正式样本元数据仍未知。稳定内容版本及副本打开/定位随后实现，正式复验见下；不把这次文件操作当作新的Agent返工。[原失败与修复](evidence/2026-11-12-current-session-mcp/README.md)。

2026-11-12正式728d4补验：同名目标明确报告已存在，原59字节源、31字节目标和未发送意见保持。仅为自有源增加扩展属性，确认ctime改变而内容、文件身份及mtime不变；界面不重读即另存59字节副本成功。打开副本后文本编辑显示准确目标和正文，显示位置后访达选中准确副本。仅此文件交付技术样本通过，不宣称真人用时或完整P22；界面工具长时间等待不计作应用性能。[实测分项](evidence/2026-11-12-current-session-mcp/formal-followup-summary.json)。

2026-11-12正式699b新增Office实际返工链：新自有DOCX在应用内预览并提出原版本段落意见，沿既有Goose/OpenRouter/Nemotron 3 Ultra免费模型、off仅发送一次。6组实际shell工具回执成功，7条带官方用量的回复累计输入49,034、输出1,400；这是一次用户/ACP发送，不是一次模型调用。首条shell列出自有工作目录，其余显式文件操作针对该DOCX。Agent结束后旧预览自动提示变化；明确重读显示新日期，独立核合仅指定文本改变、其他结构及ZIP成员保持。实际另存副本与源逐字节相同，文本编辑打开准确目标并显示新日期。[本轮成品与工具证据](evidence/2026-11-12-cycle5/formal-summary.json)。

只替换自有已保存副本后，「打开副本」明确拒绝继续；源文件、新版本未发送意见保留。重新另存新目标后1244字节及SHA与源相同，访达实际选中准确最终副本。替换同时改变字节和文件身份，不冒称单独同身份内容变化；随后「显示位置」仅延续原警告，不计第二个独立拒绝证明。4ef6正式冷读回确认原历史、完成回复、未发一条新版本意见及off选择保留；再次选择文件仍见新日期，零新增发送。正常退出后所有原消息行、对话编号及保存选择与本轮退出基线相等，待核为零，源/最终副本SHA不变，负例副本仍保留。本轮新增这个DOCX交付样本，原稿保留指失败/取消不损坏原稿，不否认获准成功返工已改变源文件；其他Office格式、读取/写入及返工其他阶段取消、并发和完整P22仍开放。[正式分项与限制](evidence/2026-11-12-cycle5/README.md)。

2026-11-12补实际写入失败：256MiB源向独立64MiB测试卷写至65,470,464字节后失败，目标/临时文件均无残留，源与未发送意见保持；改用正常目标后268,435,456字节副本与源SHA一致。新正式8c13中另一次HFS目标以及旧版本一次本地保存都在取消生效前完成，不能计取消成功。一次新自有65字节版本意见返工在思考期间停止，界面已停止，原文件SHA不变；没有新增持久编辑调用，不能冒称写入已开始。原用户消息和三条未发送意见保持。前序正式批未取得正式界面写入期间取消成功；完整P22仍未整体验收。[本批原件](evidence/2026-11-12-cycle5-completion/summary.json)。

2026-11-12补真实后台文件写入取消：生产FileCopyJobs启动真实线程，公开状态见256MiB中的65,536字节已写，单次取消后真实终态Cancelled，目标/临时文件无残留，源SHA及版本保持；新操作完整写入成功，迟取消保持Completed。此为后台管理层/真实OS分层验证，不是正式UI/IPC时序成功。结合已有真实Agent返工、磁盘交付、失败/拒绝与恢复，按原专项及共同风险条件收口第5周期；不把两种正式未验组合增加为全周期硬门槛，也不宣布完整P22或全部Agent通过。[出口依据与原件](evidence/2026-11-12-cycle5-closure/README.md)。
<!-- /task-current -->

<!-- task-current: P11 -->

### P11

2026-11-12核。**699b正式版已取得所选Goose指定历史节点完整上下文分支的窄正例，P11整体仍开放。** 从自有20261109_3选择明确消息节点，官方分支得到20261112_2，保留切点前完整3条原记录（含1条用户不可见、Agent可见上下文），界面显示2条可见消息；原对话21条记录及六条未发文件意见保持。正常退出后，正式冷开分支仍只显示该前缀，原对话后续历史和意见亦读回。所选服务、Ultra免费模型/off未更换，父子保存选择核合，本样本13个工作文件哈希保持；分支不回滚工作文件。[正式分项](evidence/2026-11-12-cycle4/formal-summary.json)。

本批真实失败驱动修正：官方message_count统计用户可见条目，不能当完整记录数；官方加载可能只重排已启用扩展集合，现仅该完整集合按含重复数的无序集合比较，内层顺序、其他配置与完整历史仍严格核合。原/子前缀在加载前后复核，已创建但核验失败的真实子记录保留，不重发分支。9a旧失败及审查漏项、后续修复和正式成功分列。[修正原件](evidence/2026-11-12-cycle4/README.md)。

其他Agent历史点能力识别/选择/请求接线、未覆盖失败取消及并发组合仍开放。Goose同秒不可分辨切点、末节点或整理后缺失Agent可见上下文的前缀继续拒绝，不自行补摘要或改历史。原当前复制和Codex/Claude/Mistral接口研究不算这些路径的实际通过；当时 Mistral 的单次实测已结束。现可按第 12 周期授权续验，历史点待补条件保持。[原进度与证据](maintenance/2026-11-11-task-current-source/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: P40 -->

### P40

2026-11-12核。所选Codex官方技能停用、启用、清除偏好与只读核查的既有正式分项保留。c68本轮新增自有项目技能的审阅后位置失效：一次明确确认在配置写入前被拒，原配置字节保持；恢复技能原字节后查询仍启用，再次审阅后直接关闭，后查仍启用。零模型请求，不把确认前关闭称为在途取消或实际采用。[本轮失败/取消分项](evidence/2026-11-12-cycle4/skill-recovery-summary.json) · [既有启停/清除](evidence/2026-11-07-cycle4-management/skill-preference-clear-installed.json)。

完整发现、安装和其他来源的统一管理仍有开发缺口；Mistral管理入口及真实会话归属未落实，Goose来源枚举可能刷新到期Git插件，不能直接接成无副作用只读查询。旧Mistral一次声明/采用窄正例保持，不扩为当前Codex采用或完整管理；当前实际采用、长等待/在途取消和其他Agent仍待。NEW-24受影响发送继续暂停，Mistral 已获第 12 周期继续实测授权，其他缺账号路径逐项保留。[完整原进度与旧正反例](maintenance/2026-11-11-task-current-source/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: ARCH-35 -->

### ARCH-35

2026-11-12核。官方上下文容量、单条消息用量和累计输入/输出已接共用呈现，原详情保留；累计输入/输出分别采用官方报告，不相加冒充总值，不按字符估算、不改预算或猜费用币种。新完整报告替代旧累计提示，标准上下文更新不误擦；零与缺失分开。c68空对话0/1,000,000的正式分项保留；本轮所选Goose原对话正式显示累计输入49,537、输出1,369，累计总值明确「尚未提供」，正常退出冷开后仍如此。费用0 USD只来自官方明确单位报告，不从无单位累计字段推断。[正式分项](evidence/2026-11-12-cycle4/formal-summary.json)。

本批受影响测试、完整工程与独审通过；其他Agent、更多字段变化/缺失组合和费用完整追溯仍未全验，不宣称节省token或模型能力改善。[实现与检查](evidence/2026-11-12-cycle4/README.md) · [原进度](maintenance/2026-11-11-task-current-source/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: ARCH-36 -->

### ARCH-36

2026-11-12核。共用官方整理活动呈现、准入保护及已声明命令入口保持；本轮按四条相关官方路径复核，没有查实新的共用代码缺陷。Goose旧正式091的compact及同对话代号续接窄正例保留，当前所核手动路径返回普通文字，缺少可辨识的专用开始/终态生产者，不能以文案、用量下降或普通请求结束补造整理终态。[官方接口与实际边界](evidence/2026-11-12-cycle4/compaction-boundary.json)。

Mistral官方通过带身份的工具活动回报整理，现有共用跟踪可承接；旧实际证据仅覆盖当时所测路径，Mistral 已获第 12 周期继续实测授权。Codex/Claude所核官方版本有专用活动，Codex受NEW-24暂停发送，Claude当前可用账号/模型尚未确认。完整开始/成功/失败/取消、结果及上下文变化仍开放，条件未变不重跑Goose文字样本；不自建摘要或改写Agent历史。[原进度与旧实测](maintenance/2026-11-11-task-current-source/previous-progress.json)。

<!-- /task-current -->

<!-- task-current: NEW-29 -->

### NEW-29

2026-11-12核。共用整理/工具活动按实际连接与标识保护发送、配置、共享维护和生命周期；历史回放、终结重放及未知活动的受控保护保持，本批稳定输入完整工程通过。本轮官方接口复核未发现应新增的共用保护缺陷，也未新增真实整理请求；不能将MCP待核恢复或历史分支正例当成整理活动全项通过。[本轮边界](evidence/2026-11-12-cycle4/compaction-boundary.json)。

旧Mistral两项窄正例、另一次未完整观测的忙态配置及后续附证分别保留；旧Goosecompact/续接只有命令与结果证据，未捕获专用活动正文。完整实际活动、失败取消、断线/迟到、请求结束后仍活动及后台共享保护仍待；Goose所核路径缺专用身份/终态，Mistral 已获第 12 周期继续实测授权，Codex 受影响的发送暂停，Claude 普通对话仍待可用认证来源。继续保留原输入和暂停队列，不自动重发，不为收口降低原条件。[完整原进度](maintenance/2026-11-11-task-current-source/previous-progress.json)。

<!-- /task-current -->

## 当前分项与阶段收口证据

**第5周期已按原条件收口。** 8c13/95a5的正式功能及返工/交付证据，加上本次真实后台部分写入取消和真实Worker取消，已按原风险条件分层核对；正式在途取消两组合继续未验。第6周期仍未完整通过，当前分项及接续见本页顶部。前序699b/4ef6 DOCX返工与选择器证据保留。[当前证据](evidence/2026-11-12-cycle5-completion/README.md) · [前批原件](evidence/2026-11-12-cycle5/README.md)。

**第2阶段证据已接入正常查询。** `acceptance:index`读取Mistral两处修改、Goose返工与另存两条既有资料，以及本批Goose无模型MCP生命周期，可按Agent、S5及P18/P22/P41筛选。公开证据摘要随查询核合，原成功事实与局限保留，不制造标准回执或增加整家通过数。P18/P22另已归并为状态页的唯一当前结论。定向检查、实际查询和独立复核通过；该资料归并批仅改变研发工具与文档；后续正式应用版本见页首。[本批分项](evidence/2026-11-11-mcp-lifecycle/README.md)。

**审查后可靠性批已安装。** 源码92e052a67及本批独立复核、完整工程、真实合成系统凭据、受控浏览器与正式界面范围见[本批记录](evidence/2026-11-11-reviewed-reliability/README.md)。本轮未发真实Agent请求；正式整库/备份恢复、Windows桌面及29家八项继续开放。安装清单从生成时直接gzip，重复.app候选已精确移除。

**第十五批已安装。** 受控Mac WKWebView复现旧安全策略拦截兼容音频，新策略用同一段WAV播放到结束，已核对正式程序包含该策略。Goose正式返回7项扩展配置，辅助功能树提供单独的结果提示，焦点保持「重新读取」，Escape返回原对话入口，零新模型请求。另核Mistral Vibe官方历史点分支，仅得静态证据。同一正式版重读复验中，用户撤回先前确认并更正为未听到。旁白主进程在重读前已正常退出，重读时运行的是旁白快速入门，旁白开关已恢复关闭。随后复测「全部工具」，正常旁白在读取前后运行，辅助功能树出现17项，用户听到旁白内容，具体结果播报仍待确认。该批未验真实Agent音频；最新Goose工具WAV播放及冷恢复见[第5周期分项](evidence/2026-11-12-cycle5-completion/README.md)。[第十五批证据](evidence/2026-11-11-stage2-fifteenth-batch/README.md)。

**第十四批已安装。** 本地A/B两标签正式实测，Home、End移动焦点，回车切页。关闭B后焦点直接落到A，关闭最后一页落到新空白标签，Tab都可继续。另补1280×820内容栏键盘调宽、还原和退出回焦，及Codex停用HTTP配置审阅前取消。取消后确认入口失效，原配置逐字节一致。系统缩放、动态读屏及在途配置写入取消仍待验。[第十四批证据](evidence/2026-11-10-stage2-fourteenth-batch/README.md)。

**第十三批已安装。** Mistral原历史只读预览显示当前模型Mistral Medium 3.5与High，原选择未确认时继续阻止发送。缺原推理项时零配置写入受控通过。正式Codex停用本机HTTP项完成添加、显式核查及移除，原配置逐字节恢复。没有新模型请求或连接测试项。当批未发测试消息。后续Mistral多片段正例见下，MCP连接、调用及采用仍待条件。[第十三批证据](evidence/2026-11-10-stage2-thirteenth-batch/README.md)。

**第十二批已安装。** 第十一批发现的报告回执后焦点丢失已修。正式版用键盘选范围和读取7项Goose扩展配置，回执后保留「重新读取」焦点，Tab双向回绕及Escape还原入口通过。真实长等待核查、旁白动态朗读和系统缩放仍开放。[第十二批证据](evidence/2026-11-10-stage2-twelfth-batch/README.md)。

**P18 Mistral正式多片段样本通过。** 第十三批正式版以新自有对话和现有服务发送一条Mistral Medium 3.5、High合成请求。一次官方编辑返回第3和18行两块差异，同一工具记录的两个片段均在正式界面打开。磁盘文件完整核对符合预期，仅两处标记改变。旧历史仍按原只读结论，其他P18缺项保持。[正式实测](evidence/2026-11-10-stage2-live-mistral/README.md)。

**第十一批已安装。** 正式Goose回报7项扩展配置，来源与连接状态未知。当批配置报告回执后键盘焦点丢失，Escape恢复原入口，后续修复见第十二批。另补实际公开网页读取及公开/本地标签隔离、跨对话搜索两处定位、归档与恢复，以及应用完全退出后实际点击通知定位原对话。macOS日志确认本次通知被静音，实际响铃仍待证。第7周期五家新增正式读回为0，保留各自具体原因。[第十一批证据](evidence/2026-11-10-stage2-eleventh-batch/README.md)。

**第十批已安装。** 正式Goose全部工具17项，developer范围5项，原报告归属可见。原坏PPTX现提示结构无法读取，旧画面和意见保留。正式键盘搜索通过，用户见到旁白的列表朗读，原偏好恢复。第6周期五家已查，四家正式读回原自有正文，OpenCode原目录查找失败，零发送和导入。完整项仍开放。[第十批证据](evidence/2026-11-10-stage2-tenth-batch/README.md)。

**第九批已安装。** 正式Goose返回17项工具，关闭后原对话保留。音频错误焦点和关闭标签被旧回执复活均有受控反例及修复。前版正式补PPTX保旧与合法换版、对话整理和所选当前附件ZIP。新版正式冷开时Goose只回放附件纯文本，正文可查，附件候选为空。零重发。[第九批证据](evidence/2026-11-10-stage2-ninth-batch/README.md)。

**第八批正式验收。** 39fcd882a实测Goose后台完成提醒在macOS通知中心出现，真实点击回到原对话，诊断核对系统接受及点击回调，原偏好恢复。所选未加载历史检索官方返回8段，2段匹配，打开原回复；获准的合成文本附件1/1命中1处并跳回原附件。Claude原保存选择仍不一致，多片段正式样本未取得。Mistral旧PDF原目录列表为空，Goose现有附件落盘仅保留文本，正式冷恢复未测。[第八批证据](evidence/2026-11-10-notification-and-selected-search/README.md)。

**第七批搜索、文件差异与通知跳转已收口。** 正式Goose已有对话中，已加载正文查得13处匹配并跳回原回复。自有 `p21-revision.txt` 来源定位到原步骤及同路径拟写入差异，零新正文请求。旧搜索片段和回执退役、多差异片段独立选择及替换后失效、旧通知读取或跳转失败仍消费随后点击均经受控验证。当批实际送达和点击未测，后续第八批见上。[第七批证据](evidence/2026-11-10-search-diff-notification-navigation/README.md)。

**第六批已完成并停在审阅点。** 正式Codex旧MCP清单自然到期后拦住添加，手动重核读取方式并查到同范围新报告后，旧过期提示消失，添加入口恢复，配置文件逐字节不变。迟到更新不重建已移除对话、保留旧写入结果/未知及原生通知队列保留最后一次点击均为受控验证。未执行真实删除、系统通知送达与点击。[第六批证据](evidence/2026-11-10-inventory-and-notifications/README.md)。

**同一坏图与大文本交付已正式复验。** `c3a0a0a15` 拒绝前批曾画黑的同一坏PNG，保留红图和意见，合法蓝图才采用。已有真实Goose成果卡选1,048,577字节文字，实际进入分段、翻到第二段，并完整另存逐字节核合；零新增正文。删除本地原子回滚、活动隔离和不同Agent回执只经受控检查。截图失败诊断为本机离线，正式仅已审Codex且受影响新发送仍暂停。[证据](evidence/2026-11-10-verified-delivery/README.md)。

**图片换版实测发现坏流例外；过期清单已复验。** `fc5a0cfca` 等新图实际加载和解码才换版，正式红图到合法蓝图可见且旧意见保持；特定坏PNG被本机WebKit当作成功显示黑块，该批负例未通过，后来版本的同字节复验见上。Codex旧MCP清单自然到期后，停用添加审阅明确结束；手动重核读取方式并查询后新清单及添加入口恢复，旧拒绝提示仍可见，配置文件未变。归档取消与选择标签的精确竞态仅受控。当前Mistral包有对话入口、无已确认的管理入口和会话。[证据](evidence/2026-11-10-image-and-inventory/README.md)。

**DOCX、标签关闭及Goose另存已正式分项。** `b40256367` 实际换入截断文档后重读，保留原文和意见；换成有效第二版才采用，历史意见仍带原摘要。两个自有本地标签只关闭选中的第二个，余页自动选中；附属读失败、挂起的精确竞态是受控。此前Goose实际返工的59字节文件本批另存并逐字节核合，零新增正文请求。音频兼容焦点仅受控，正式消息播放、完整P13/P16/P20/P22/P30仍开放。[证据](evidence/2026-11-10-document-tabs-delivery/README.md)。

**Goose只读技能清单有官方副作用。** 1.52.0 该查询可能触发已装Git插件自动更新，排除其他登记项目也不关闭此行为；未接成只读入口，未对正式配置运行。[官方源码边界](evidence/2026-11-10-document-tabs-delivery/README.md#技能清单接口边界)。

**PDF 换版和退出原因已正式分项。** `da2b73fec` 在自有两页PDF的第2页实测：换成需密码的文件重读，旧画面和原页意见保持；换成有效单页文件后才切到第1页，旧意见仍按原摘要和2/2页独立保留。旧工作位置恢复结果未确认时，正式界面显示具体退出原因；选择留在应用，原未知记录未改。另有同标签较晚旧回执的受控回归。完整P16/P20/P30及其他退出场景保持开放。[证据](evidence/2026-11-10-pdf-and-exit/README.md)。

**Goose HTTP MCP 已证官方隔离连接与调用。** 官方1.52.0在隔离数据下以固定回执核清初始化、工具清单和精确关闭；模拟模型另触发一次经明确临时授权的只读调用。未接入正式对话、未使用真实模型服务，未改正式配置。官方程序保存会话MCP信息，历史预览、重开及分支可能重新激活；安全接线未完成。[边界](evidence/2026-11-10-pdf-and-exit/README.md#第4周期-goose-http-mcp-技术证据)。

**工作簿保留与未读冷恢复已正式实测。** 697089225重读损坏的新选中表时保留旧表42和意见，明确选新版本另一表后才显示77，旧意见原摘要保持。Goose后台A真实回复首次冷开仍未读，打开正文后第二次冷开保持已读，B和其他对话无新增未读。Goose工具报告冷读显示7项扩展加载成功，清单另读。另存同目标冲突已明确忙碌，正式在途写入另验。[分项原件](evidence/2026-11-10-workbook-and-unread/README.md)。

**退出检查来源已缩小。** 新版实际确认来自原生检查；正式库和两份备份中的同一工作位置恢复记录已结束、结果未知且未核对。该记录会在全局活动检查之前要求确认。保留原未知，按原保护正常保存退出；进一步区分的正式提示与原记录对照已在上方记录。

**首发前意见找回已正式分项。** 91dadecc 在新对话保留区提供原对话失联时的原意见查看和复制。索引确认后才判断失联。旧版自有空稿实际留下意见并离开准备状态，新版冷开找回同一路径、原摘要和正文，切换返回仍可见。该次正文发送为零。同版再测仍在的准备对话，跨导航后明确将一条文件意见加入原输入框一次，原稿、原路径和SHA保持；旧意见仍独立，重选同目录会新建对话。另补一条Goose实际文字文件返工，明确发送保留旧SHA，落盘新内容逐字节核合，重读展示新版本。[本批证据](evidence/2026-11-09-presend-visibility/README.md)。

**元数据筛选与未读归属已补。** 旧正式版完成标题、Goose 和未分组组合、空结果、清除和返回。91dadecc 修后台保留页首次可读时误清当前页登记，旧事件及清理按原归属核对，受控28项通过。同版两条真实Goose文本请求重叠9.465秒；B可见时只标后台A，打开A读到原回复后清除，保存记录核合，原本地网页标签仍在。该批未测冷恢复，后续正式分项见上。精确可读片段先后、媒体及完整P31/P38仍开放。该批普通退出出现通用未确认提示，已取消。[范围与证据](evidence/2026-11-09-presend-visibility/README.md)。

**macOS27截图入口已取得合成像素。** 生产原生桥返回600×420 PNG，按声明sRGB逐通道匹配。初次取色夹具误差和修正回执均保留。早期公开样本触发页面结构保护，已定位拒绝分类。第十一批另获W3C公开页生产桥像素和正式标签实测；原Agent请求回传与受影响Codex权限条件仍待补。[范围与证据](evidence/2026-11-09-presend-visibility/README.md)。

**文件意见与另存失败恢复已推进。** f4593d607 修报告片段32位摘要冲突，以来源、范围和准确正文核版本，旧稿不迁移；另存明确未派写的忙态给失败终态并只释放本次退出许可。完整七项通过，前端742文件10,070项、Rust2,478项及7项既有忽略；独审后更新唯一应用，206,275项数据保持。正式自有文件在选址中A→B，旧另存0/61字节且无残留；重读B另存78字节逐字节相同，旧A意见及原SHA仍在。上批工作簿旧意见也在冷开后读回，零正文发送。该批未验真实Agent返工、正式并发忙和写入中取消；同时定位了首发前准备对话的孤立意见缺口。[本批证据](evidence/2026-11-09-delivery-feedback-browser/README.md)。

**网页撤回与本机前置已补。** 原页隐式失效时，一次性截图按原请求进入停止并等待确认；受控原响应离开发送队列但交付未确认的反例已修，定向209项通过。当前macOS27.0的真实WebKit离屏样本能检查封闭内容并拒绝其中的敏感控件；该批未取像素；后续隔离窗口生产桥取得公开页像素，正式标签与文字读取已验，沿原Agent请求的截图交付仍待。[范围与证据](evidence/2026-11-09-delivery-feedback-browser/README.md)。

**消息用量与保留工作表刷新已补正式分项。** 5785c5c2d 将官方单条用量接入共用面板，空值、零、费用来源与未知币种分开，不累计或解锁整理；新捕获先核原选表再解析，完整成功才换旧预览。工程七项完成，前端742文件10,066项、Rust2,475项及7项既有忽略，定向19项通过；两个旧读取模拟补承接参数后原断言及全量通过。一次更新206,275项数据保持。正式Goose历史报告实际显示输入5,501/输出71及缓存、耗时；自有工作簿坏首表保持，同路径第二表42→43时自动提示变更，明确读取保留第二表，旧意见仍带原SHA且未加入发送。仅初始化及原对话读取，零新增正文。完整ARCH-35、P20/P21及整理/历史分支保持开放；不计跨重启面板恢复。[本批结果](evidence/2026-11-09-usage-workbook-refresh/README.md)。

**开发空间恢复完成。** 只移除新清单内17,243个可重建编译对象/增量文件和26个空目录；两次删除窗口实测可用空间净增约35.98GiB，独审时可用约39.87GiB。源码、未提交工作、Git、正式应用、数据/配置、工具、证据及备份保留，强保护前后及日志独审通过。首次因无法写记录在删除前停止，应急8项与后续新清单分别留证，完成日志不可重跑。[清理记录](maintenance/2026-11-07-storage-recovery/README.md)。

**第4周期正式采用与恢复仍缺。** Goose既有会话的扩展清单可回退全局默认，官方增删会把活动集合写回。早期隔离预检曾遇SQLite14及未分类请求，后续已取得官方隔离初始化、工具清单、授权只读调用与精确关闭证据；该调用使用模拟模型。正式对话启用/采用、真实服务调用及历史预览/重开/分支的安全恢复仍待补。Codex技能实际采用仍受相应发送权限限制。[后续结果与原失败](evidence/2026-11-10-pdf-and-exit/README.md#第4周期-goose-http-mcp-技术证据)。

**第4周期实际配置闭环已补一项。** 正式091内Codex官方来源真实添加停用本地MCP、显式核查并移除；独立四时点对照确认其他配置未变、完整原文件恢复。类型检查、关联3文件32项及Rust离线依赖读取通过；无产品源码变更，未重跑完整七项或重装。启用、连接、调用、当前对话采用及完整P39/P41仍开放；继续核技能管理与官方整理，不重启已知会另建连接集而缺退出屏障的旧探针。[正式分项](evidence/2026-11-07-cycle4-management/README.md)。

**官方整理命令与原对话续接已补真实样本。** 正式091内Goose使用已选Ultra免费/off，新合成短对话经官方声明的compact实际完成，原对话准确答回代号；三次正文请求、0取消及0工具，保存模型核合。当前Agent保存结构保留用户原文并替换Agent可见上下文，与官方实现一致；未采整理前物理快照或typed活动正文，ARCH-36/NEW-29全条件仍开放。当时指定历史节点分支尚未接线；后续所选Goose正式分项见[P11最新结论](#p11)。官方时间截断仍有精度限制，不能用当前复制替代不可辨认节点。[分支缺口](evidence/2026-11-07-cycle4-management/p11-current-gap.json)。[实测](evidence/2026-11-07-cycle4-management/goose-compact-installed.json)。

**技能偏好清除已实装并正式验证。** 92e178423补准确路径偏好的清除与核查，重复/未知规则拒写；无偏好明确无需清除。完整七项通过（前端730文件9,891项，Rust2,442项及7项既有忽略），独审后正常退出更新唯一应用，206,275项数据记录相同，原Goose对话冷读保持。正式Codex自有技能完成无偏好不派发、停用、启用、清除和只读核查；独立四时点核合，除明确保留的空技能设置表外，其他配置值及顺序保持，技能文件不删。该批未验实际采用/调用、其他Agent或安装版失败取消组合；后续失效拒写/确认前取消见[P40最新结论](#p40)，完整项仍开放。[正式分项](evidence/2026-11-07-cycle4-management/skill-preference-clear-installed.json)。

**当前对话工具报告已实装。** a9d18cf7a新增显式读取、原请求状态检查和同连接重开保留，报告完整性/调用权限未知如实展示。完整七项通过：前端734文件9,927项、Rust2,456项及7项既有忽略。正式Goose原对话返回17项，关闭重开无新请求，三摘要原10条消息及模型/配置一致；未把清单计为完整MCP连接、采用或调用。正式发现长列表底部按钮不可见，6de9仅修窗口布局，新格式/生产包通过、其余2,336输入复用；正式1280×820展开长说明后按钮可见且关闭成功。两次安装各206,275项数据保持，重复应用精确移除。[正式分项](evidence/2026-11-07-cycle4-management/session-tools-report-installed.json)。

**11月7–8日第4周期接口核查（当时边界）。** Goose手动整理不转出带身份的完整活动，自动通知需自定义接线，且不是可用终态；共用临时提示和单条消息用量呈现已接线，不以文案或用量下降解锁。Codex历史点扩展保留整轮，但普通分支声明/成功回包不能确认切点采用，现有选择及请求接线仍缺，未启用或实测历史分支。P39/P40/P41、ARCH-36/NEW-29及P11完整条件保持开放，缺口分别归因，不再对不变条件反复探测。[接口与实现边界](evidence/2026-11-07-cycle4-management/README.md#整理活动与历史分支查明的接口边界)。

**临时提示接线与首次坏表恢复已交付。** bb098补已核官方状态的共用临时显示，原通知保留，回放/旧归属不落历史，不改变工作与权限保护；完整七项通过，前端736文件9,975项、Rust2,467项及7项既有忽略。880b补首次单表失败或取消后的同捕获目录重选；旧UI两项和解析一项真红已转绿，新前端四项及739文件10,007项通过，844项未变后端输入复用。一次更新唯一应用，206,275项安装记录保持；正式自有XLSX首表准确失败而选择器保留，改选第二表实际读出42和标记，原文件不变，零新增正文请求。原对话/免费模型/off可见。真实状态提示显示仍未取样，当批观察到message_usage仍以未知消息保留，11月9日已补专门呈现；完整生命周期及P16保持开放。[本批正式结果](evidence/2026-11-08-live-status-workbook/README.md)。

**本机故障测试条件已具备。** 用户明确当前 Farfold 内容均为开发数据，并确认清理 Farfold 对话、草稿、附件引用及待发内容，保留 Agent 程序、登录凭据、模型服务配置、源码与证据。安装版保存失败及保存期间停止改用当前 Mac 账号验证，不再等待独立账号。清理不调用会同时删程序及密钥的完整重置，也不删除外部 Agent 自己的历史；执行结果另记，授权本身不算测试通过。

**本机清理及正式存储故障分项已完成。** 关闭态事务清空168条Farfold对话索引、原草稿/附件引用/待发，40条Agent及50项其他设置逐字保持，3个分组定义保留；冷开显示0条对话。随后安装版真实SQLite写锁使保存明确失败：界面保最新稿、库保原稿；显式重试后新稿落盘，正常退出冷开仍可见。另在Copilot真实待审批期间阻住第二次保存，685毫秒内点击停止，旧请求实际取消；原草稿和旧工具未知保留、待发0项，协议仍仅1次正文请求。重新打开同一对话仍显示未确认及原稿，无自动重发。范围限SQLite忙错误，不冒称物理满盘或所有故障通过。[清理](evidence/2026-11-07-stage1-formal-acceptance/current-account-cleanup.json) · [保存失败与重试](evidence/2026-11-07-stage1-formal-acceptance/storage-failure-installed.json) · [保存期间停止](evidence/2026-11-07-stage1-formal-acceptance/stop-during-save-installed.json)

**两稿与待发完整闭环已验。** 两稿找回遇真实拒写时均保留，解锁后明确重试同一份，不增加重复副本；更新后冷开原文和设置核合。待发编辑遇拒写保留编辑文及原两项，明确保存只更新第一项；冷开仍是两条暂停，一次“继续”后按原顺序各发一次并得到准确回复，原工具结果保持，无新增工具，队列归空。[两稿](evidence/2026-11-07-stage1-formal-acceptance/retained-drafts-failure-installed.json) · [待发](evidence/2026-11-07-stage1-formal-acceptance/queue-edit-failure-installed.json)

**本批两项实际修复已正式通过。** 809bb88d5修新对话严格确认后残留空配置暂停，完成完整七项及正式首发；091fac1c7修确认回执先到、旧状态尚未消费的合法竞争，等同一现有通道交付后再执行原严格核对。受影响268项、前端724文件9,864项及格式/类型/生产包通过，Rust三项复用809未变化输入回执，独审通过。正式新A手选Ultra确认及首发成功；B11保留旧11条历史切到Ultra，真实限定命令完成，随后冷开仍是16条及Ultra/off。旧失败具体交付时序未直接记录，不把这条修复说成所有历史长等待的原因。[首发](evidence/2026-11-07-stage1-formal-acceptance/fresh-model-first-send.json) · [交付修复](evidence/2026-11-07-stage1-formal-acceptance/configuration-delivery-engineering.json) · [实际模型](evidence/2026-11-07-stage1-formal-acceptance/goose-second-model-installed.json)

**Goose指定关闭与冷恢复已补齐。** A仅一项未批准的工具请求，停止确认后只关闭A；原70字节草稿及旧结果未知保持，B在关闭后6.514秒沿原进程和连接准确完成，零取消。两端会话关闭及本机路由/工具许可释放由实际界面、协议成功时序与已审代码支持；私有聚合计数未直接量测，不宣称全部资源即时退出。后台程序按30分钟空闲策略保留，不将82秒仍在误判泄漏；后续正常退出时两旧进程组、管道及真实清理回执均收口。冷开两条共0正文、0取消、0设置请求，A原稿与未知、B全部16条历史及模型均保持。[指定关闭](evidence/2026-11-07-stage1-formal-acceptance/goose-close-installed.json)

**收口边界。** 首波整家八项仍0/3，29家全量与其他认证、永久审批等剩余组合不因本阶段收口变成通过。Kilo跨版本桌面授权、Windows runner付款/额度、旧长等待未查明的系统原因及原N/O、P18、NEW-24限制继续逐项记录；仅在相应条件可用、出现新原件或相关输入变化时重评。不再等待独立Mac账号，不新增30分钟缓存退出或每个读取时点的正式实测门槛。

**本轮开发数据已清理。** 初次清168条旧索引后，本轮新5条验收对话及其草稿、附件引用、待发也按同一明确授权清空，正式冷开0条、空输入。40条Agent及50项其他设置逐字保持，3个分组定义保留；外部Agent历史、程序、登录、服务配置、源码及证据不删。验收中的原稿和未知已先留原件及完整性通过的独立回滚库，最后的主动清理与保稿验收分开。[最终清理](evidence/2026-11-07-stage1-formal-acceptance/final-test-cleanup.json) · [最新正式复验](evidence/2026-11-07-stage1-formal-acceptance/configuration-delivery-installed.json)

较早ed50985a1只补确认失败分类，不放宽原门槛；前端724文件9,828项、Rust2,428项及7项既有忽略、其余工程检查通过。正常退出后更新唯一正式应用，206,275项关闭态数据保持。随后仅一次Goose同设置新建准备成功：原免费模型/off可见，输入合成稿后发送按钮可用，原生新对话20261107_3仍0条消息。本次没有复现前两次确认失败，不宣称已查明或修复其原因。[本批正式结果](evidence/2026-11-07-stage1-formal-acceptance/confirmation-boundary-installed.json)

较早d352批次：旧版三条自有测试连接逐条正常结束，真实结束回执、三个未知落盘及原草稿/待发保护通过，旧版随后正常保存退出。该候选经独审更新正式应用，关闭态206,275项前后相同、备份完整性通过；冷开原P02草稿、保留1份及原位置可见。当时刚进入集中正式验收，阶段尚未收口；后续结果以上文091为准。[退出原件](evidence/2026-11-07-stage1-formal-acceptance/old-exit.json) · [当时安装](evidence/2026-11-07-stage1-formal-acceptance/install.json)

首波整家八项0/3与本阶段进度分列；后续阶段的技能/MCP、资料交付及全名单验收保持原顺序。

Goose实验SQLite打开失败、Kilo实验临时子进程判定属于夹具调查，无法解释原正式长等待。

**第1阶段正式分项。** 三个旧未知在新版冷读均显示未确认且未自动重发。Copilot 1.0.107正式只关闭A，旧工具仍未知、A原稿保存且再次冷恢复；B限定命令在关闭前后持续运行，原连接正常完成且零取消。会话关闭和后台程序仍在分别记录，未直接读取进程内资源计数。超限PNG即使文件名为.txt仍保图片类型，发送被挡、正常退出冷开后核对仍拒绝，原附件标识和位置保持；已移除专用测试附件。[指定关闭](evidence/2026-11-07-stage1-formal-acceptance/copilot-close-installed.json) · [图片正式复验](evidence/2026-11-07-stage1-formal-acceptance/oversize-image-installed.json)

**第1阶段收口时的失败及缺项。** Goose用相同设置新开对话，官方新建及模型设置已成功，但Farfold最终确认失败，零新正文请求；2ce原因分类已正式复现一次，展开为“确认请求未成功完成”，排除本次前端忙碌/归属/回读比较等分支，调用参数/后端确切拒绝条件继续调查；此分类不能独自证明实际后端已拒绝。Kilo官方默认列表成功，打开已加入的旧自测记录时，原临时目录在系统中已不存在（errno 2），应用拒绝并保留原记录；未新建替代目录，不将此归为桌面授权失败。Kilo真实待授权终端的实际管理器组合已过，正式图形、账号授权及远端撤回另验。[目录分项](evidence/2026-11-07-stage1-formal-acceptance/kilo-original-directory-absent.json) · [终端组合](evidence/2026-11-07-stage1-formal-acceptance/kilo-pending-close-native.json)

## 能力与验证范围

逐项要求、原成功/失败/未测及配置见[151项参考](agent-access-requirements.md)。第1阶段按共用实现及当时可执行范围收口。第4周期已有交付分项，第5周期按原专项与风险覆盖收口，第6周期关键接入补强已实装，fast-agent/Mistral各有一次正式网页结果；fast-agent 的历史工具和图片已修并正式复验，已委托命令的实际停止正例与自管工作、工具终态余项见 [ARCH-44](#arch-44)，第7周期搜索/整理/导出已补正式分项；各P项/Agent及未覆盖组合仍保持原结论。第3阶段已有Windows定向和长期运行的前置分项，第4阶段的全名单验收仍开放，第5阶段公开交付待用户认可能力。

| 范围                            | 已实现或已验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 仍未完成或未验证                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 首发接入与历史 S3               | [29家证据及缺项台账](evidence/2026-11-06-cycle-01/agent-conditions.json)有6家所选历史组合的窄证，配置、历史、审批、停止及未知保护另有分项。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 原 29 家台账属于历史证据。当前第 12 周期整家 0/22，未覆盖配置与其他标准按[当前验收表](evidence/2026-11-15-cycle12-continuation/acceptance-roster.json)续验。 |
| NEW-24 / P08权限                | 已补作用时点说明、已识别命令的发送保护及受控/正式窄分项。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 同一官方连接的完整文件/网络权限读回及恢复仍未知；受影响的新真实发送继续暂停，不声称源码全面禁发。                                                            |
| P01草稿与P12查找                | 五类未知字段覆盖已修。11/7本机正式版真实SQLite写锁下保稿、显式重试及冷开已验，保存期间停止保原稿。P12既有70处、01/64及回绕所选分项保留。[存储实测](evidence/2026-11-07-stage1-formal-acceptance/README.md)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 物理满盘、设备I/O、实际待处理附件转移及重核余项未齐；P12全语料、其他对象及压力路径仍开放。                                                                   |
| P11 / ARCH-33上下文复制         | 完整当前复制保留；699b正式从所选Goose历史节点得到完整3条原记录/2条可见消息的新分支，父子冷读回及原意见保留见[唯一当前结论](#p11)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 其他Agent历史点接线、回退/检查点恢复、不可辨认切点及未覆盖失败/取消组合仍开放；不把当前复制算指定节点完成。                                                  |
| P13 / ARCH-49媒体与资源         | 共用显式展开、字节/实例预算、隐藏退役、传输/消费及选定图片/音频格式保护已实装；短AAC/FLAC显式兼容播放已实装。第十五批修复兼容音频的媒体策略拦截，受控WKWebView播放结束。 本批已补真实Goose工具WAV播放至结束及冷恢复，见[原件](evidence/2026-11-12-cycle5-completion/summary.json)。16ee另修Mistral结构化PNG，正式零发送冷开可展开图片并导出相同字节；fast实时PNG及ee4c普通冷开工具/图片均已有正式正例，见[当前P27](#p27)。[最新图片证据](evidence/2026-11-13-cycle7/mistral-media-summary.json)。e32另补只读媒体及带入工具显示，受控双浏览器验证通过，正式只读文字搜索通过，未加入图片预览仍待正式样本。[本批边界](evidence/2026-11-13-cycle7/preview-media-summary.json)。 | 其他Agent真实返回消息、未覆盖动画/播放、未覆盖格式/轨道/布局、实际解码/传输内存、多Agent长期负载仍开放；旧极短音频播放失败保留。                             |
| P16 / P20 / P21 / P22资料与返工 | Office/PDF有限预览、版本意见、工作簿失败重选及文字返工已有分项；699b新增最小DOCX实际返工、自动变化提示、重读、另存打开及外改副本拒绝/新副本恢复定位。各项见[P16](#p16)、[P20](#p20)、[P21](#p21)、[P22](#p22)。                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PPTX仍为部分预览；更多Office保真、其他格式/区域、实际在途取消和并发组合未齐，音频真实来源另见P13；不提升整项。                                               |
| P18工具/差异与任务来源          | [唯一当前结论](#p18)。实际差异、工具失败、审批拒绝与冷恢复分别按原件范围记录。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 原未知对象、失败与未覆盖组合见P18；完整项开放。                                                                                                              |
| P27 / P30网页                   | 多标签及逐页记住公开网址已有正式分项，撤回有受控回归。macOS生产桥已在隔离窗口取得W3C公开页600×420像素；正式应用已验公开页文字读取、公开/本地标签切换及精确关闭。[第十一批分项](evidence/2026-11-10-stage2-eleventh-batch/README.md)。                                                                                                                                                                                                                                                                                                                                                                                                                                       | Goose同请求截图及撤回已有本批窄例，最新范围见P25/P27/P30；敏感场景及其他Agent仍待，Codex新发送沿NEW-24暂停。                                                 |
| P31 / P38整理与未读             | 元数据组合筛选及单一「新回复」筛选有正式分项。Goose并发文本中仅后台A有未读，打开正文后清除并落盘。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Goose文本两次冷开已有正式窄例；后台完成通知实际送达和点击已补，其他提醒、媒体及整理组合仍待。                                                                |
| P32搜索                         | 已加载正文、所选未加载官方历史及附件文字分层搜索已实现，d503所选官方历史/PDF分项保留。ef788与343所选已加载查询64均为1匹配/1来源，尾64完整可见；R2所选实际独立复核通过。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 旧36底缘裁切记录保留；正式压力、完整来源范围/冷恢复仍未齐；不证明历史字节、全部正文或Agent消费，不是持久全文索引，完整P32开放。                              |
| P35导出                         | 前序分项保留；a96实际1 GiB在途取消、双版本逐字节和文件变更拒绝，485独立测试卷写满终态失败无残留。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 其他历史字节、附件完整归档、快速选择提示正式复现及Windows待验；旧失败保留，完整P35开放。                                                                     |
| P39 清单与报告                  | 所选Codex技能、Goose工具/扩展报告、范围与焦点有正式分项；本轮失效拒写后重新查询及额外工具变化报告见[唯一当前结论](#p39)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 其他Agent、完整性、长等待与在途取消组合仍未齐；准确结果句读屏见P45。                                                                                         |
| P40 技能管理                    | 所选Codex正式启停/清除偏好保留；本轮准确对象失效拒写、恢复后查询及确认前取消通过，见[唯一当前结论](#p40)。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 发现/安装和其他来源管理仍有开发缺口；当前实际采用、在途取消及其他Agent验证仍开放。                                                                           |
| P41 MCP管理                     | 正式真实调用、迟到/冷启动恢复与699b外部变化审阅接纳、重开和撤回按[唯一当前结论](#p41)分项记录。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 程序型/凭据HTTP及更广配置接纳等开发、回执丢失/在途取消等实测仍待；其他Agent不随代表样本通过。                                                                |
| P45 键盘与读屏                  | 所选搜索、导出、工作树、准备页和预览路径有正式键盘分项。报告回执后焦点及网页关闭后焦点已修并正式验证，1280×820内容栏调宽和恢复已验。e1762610b动态提示已进入辅助功能树。[搜索键盘](evidence/2026-11-10-stage2-tenth-batch/README.md) · [导出与工作树](evidence/2026-11-03-conversation-controls/control-formal-summary.json) · [准备页](evidence/2026-11-05-reliability-stage/formal-summary.md) · [报告焦点](evidence/2026-11-10-stage2-twelfth-batch/README.md) · [网页焦点与调宽](evidence/2026-11-10-stage2-fourteenth-batch/README.md) · [旁白更正与复测](evidence/2026-11-11-stage2-fifteenth-batch/README.md)。                                                       | 用户撤回首次听到确认；后续正常旁白有语音活动且用户听到内容，具体结果句仍未确认。动态播报、真实长等待、其他关键路径读屏、系统缩放及完整支持尺寸仍缺。         |
| NEW-29 / P48及日常维护          | 共用整理活动保护与官方接口边界见[NEW-29](#new-29)；后台/冷启动完成提醒已实际点击，归档及恢复分项保留。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 完整整理生命周期与保护实测、实际响铃及其他提醒组合仍未齐；具体接口/账号/授权限制单列。                                                                       |
| H13–H17并行工作位置             | 创建、接入、归档、删除、独立恢复与原缺陷复验已有正式分项。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 共享文件/配置/依赖/端口影响、完整恢复及未知收尾仍须保护；不承诺文件系统沙箱或自动合并。                                                                      |
| L / N长期使用及Windows          | 共用代码、平台适配、Windows固定版本CI和原生定向样本已有证据。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 长历史、多任务、休眠/断网和Windows完整用户环境仍待；当前安装任务受付款或额度限制。                                                                           |

## 未解决问题与执行边界

- **第2阶段剩余开发与验证。** 所选Goose历史点已有正式窄例；其他Agent节点接线、程序型/凭据MCP及更广设置接纳、技能发现/安装/来源管理仍有产品开发工作，不能统称只差实测。回执丢失、在途取消和完整整理活动仍待按对应接口验证。一次编辑多片段已有正式Mistral正例，其他P18原条件保持。已有真实Goose工具WAV播放/冷恢复分项，其他媒体及Agent仍按P13保留缺项。Goose及fast-agent已取得同一工具调用的正式PNG回传；Mistral真实调用取得PNG，显示缺陷已修并正式冷开/导出核合；fast-agent冷开工具/图片已通过官方只读补充修复并正式复验。其他Agent接通及更广许可条件仍待。Goose工具报告重读保留辅助功能树和焦点结果，动态读屏按用户指令暂缓；所选系统缩放已有本批正式窄例，完整范围仍待。前序屏幕共享静音属于旧失败。随后网页审批、提问和连接中断各有一次正式响铃及点击定位，其他通知组合继续按 P47 核验。第 6–7 周期已按阶段范围收口，各条目余项依原条件跟踪。[现场听音](evidence/2026-11-15-cycle7-p47-hearing/README.md)

- **第5周期出口及未覆盖组合。** 已按原专项和共同风险条件收口，保留既有真实音频/Office/返工/交付证据及本次后台IO、真实Worker取消分层结果。正式工作表读取中取消、正式完整文件写入中取消成功仍未取得；不把受控或后台证明改称正式通过，也不自动把这两种时序新增为后续硬门槛。相关风险、代码或真实条件变化时再补证，其他Agent/格式/平台原缺项保持。[收口依据](evidence/2026-11-12-cycle5-closure/README.md)。

- **本轮具体外部条件。** NEW-24受影响的Codex等新发送继续暂停；Mistral 已获后续真实验收授权，前台停止和冷续答分项有证。Claude 独立测试已获小米 Messages 实答，普通对话报认证错误，当前证据指向凭据交接。最新官方版本相关源码未变。所核Goose手动整理路径缺专用活动身份/终态；不通过重复文字样本或自建摘要补足。Windows额度、Kilo跨版本授权及未知系统原因按原项保留，只阻塞对应路径。[本批证据](evidence/2026-11-17-cycle12-models-and-sigit/README.md)

- **本机开发环境**：11/4在macOS27.0、Apple M6、16GiB机器上按锁文件恢复依赖及编译缓存，环境恢复当次完整七项均自然0：前端704文件9450项、Rust2335通过/6既有忽略。8ac6dcb09批次七项为721文件9,639前端项、Rust2,403通过/7忽略，当前工程见页首。额外arm64开发程序构建及Vite页面/入口HTTP200通过并关闭。2260份所列源码与锁文件、Windows冻结候选、六份原始清理回执和正式程序摘要保持；该环境恢复步骤未替换正式应用、启动真实Agent或执行Windows；后续安装与Windows实测另记在本页开头。[恢复与检查证据](evidence/2026-11-04-development-environment-restoration/README.md)。这不改写安装版或Windows的原验证范围；11/3首次依赖缺失原因仍未知，11/4迁移清理另有明确记录。
- **认证与服务续验。** Autohand 和 Grok Build 沿原服务已有实答及冷续答。Amp 官方账号与 MiMo 已实测，显式模型续答及未映射旧线程带入依赖官方。MiniMax 小米服务已实答，旧 M2.7 仍待原账号和原服务额度。Gemini CLI 与 Antigravity 按用户要求暂缓，Nova 和 DimCode 已移出首发。旧认证负例按原对象保留。[认证最新结论](#arch-08) · [旧配置读取](evidence/2026-10-24-agent-acceptance/existing-config-results-summary.json) · [Amp 旧未知请求](evidence/2026-10-24-agent-acceptance/amp-formal-c876-ack-summary.json)
- **旧失败与未知**：siGit、Droid、MiniMax、Kimchi/Amp等未知，以及Kimi/Goose回答、Kilo文件缺LF、Qoder冷开失败等原记录保持；新安装、进程存活或正常退出都不补终态。已核错误只按证据归因，额度文字、握手超时、默认OpenCode初始化及历史自动重开请求者仍有未知。
- **官方契约与版本。** 当前首发中 Antigravity 和 Devin 的具体回调路由仍缺证，Grok 1.0.46 发行与公开源码映射未齐。Nova、DimCode、Factory Droid 和 Poolside 的原调查随历史保留。已实测的 fast-agent 委托终端与 Cursor 前台停止分别见 [ARCH-44](#arch-44)。
- **Windows验证边界**：最新固定2e完整CI41931045918已取得2391/0/75、前端9506/3跳过、NSIS构建与聚合成功；原17失败名同轮17/17通过。固定b714新增MCP/队列范围另有18后端与15前端定向通过，均非Windows实际安装或用户流程。原69完整2389/2/75及更早72/26/17失败材料保留为历史，不能反称其当时成功，也不继续作当前待修数量；随后559定向41980895597原生30/前端20通过；5b9安装解析修复运行41984263036未获runner，用户选择先推进独立工作。844及后续批次按各自范围完成本机验证；本批未重派Windows安装任务。固定候选及原生复验的版本、失败与后续通过见[归档中的Windows记录](archive/2026-11-09-progress-alignment/status-history.md#windows-创建eof-与恢复包定向核验)。
- **数据与更新**：保留历史、草稿、附件、未知请求、证据与备份；每次更新重新核活动工作、正常退出和新基线。206的P35/P40分项、ef788首次失败/正例与343 R2安装/实际观察分开。关闭态清单不延伸到启动后，正常退出不补停止。原冻结回执中的要求文件属于检查当时输入，后续进度文档另核，不称最终文档重跑七项；不以新快照覆盖旧数据。
- **现行范围。** [首发目录 21 家](agent-first-release.md#当前保留的-21-项)按八项验收，151 条原始条件保留。原 29 家和 28 家记录供追溯。既有六旅程和另一台 Mac 验收门槛维持撤销。签名、公证、公开分发/更新渠道仍后置；LifeModel 真实采集/注入及编辑器等边界见产品契约。

## 第 12 周期待配合

2026-11-17 用户允许 CodeBuddy 单独采用 Hy4 / On、MiniMax 用小米 MiMo 首答及原配置续答，并授权继续 Mistral Vibe 实测。这些路径已有实答。旧 MiniMax M2.7 无额度，保留该旧会话的原配置，恢复额度后再验。siGit 已按用户决定移出首发。

- **Claude Code**。Farfold 独立小米 Messages 测试已有实答，官方适配器的私密凭据交接仍待支持。若要测独立官方账号来源，可在用户方便时从 Farfold 官方账号入口使用所选 Claude 订阅或 Anthropic Console 登录。
- **Gemini CLI 与 Antigravity**。保持暂缓，后续恢复该验收时由用户本人完成官方登录。

[C12 逐家验收表](evidence/2026-11-15-cycle12-continuation/acceptance-roster.json) · [最新正式回执](evidence/2026-11-17-cycle12-approval-and-lf/README.md)

## 历史、原件与维护

本次移出的历史进展与旧基线表已逐字保存在[2026-11-09对齐归档](archive/2026-11-09-progress-alignment/INDEX.md)。上次整理前155510字节状态原件及5082字节计划原件逐字保存在[2026-10-30对齐归档](archive/2026-10-30-progress-alignment/INDEX.md)，摘要与保护核对见[当次回执](evidence/2026-10-30-progress-alignment/verification.json)。累计日志、各次安装、原失败和超窗完整保留，快照无调度权；旧相对链接按原位置解析。

更早入口见[2026-10-20快照](archive/2026-10-20-before-next-resource-stage/INDEX.md)、[2026-10-17归档](archive/2026-10-17-documentation-alignment/INDEX.md)及[证据目录](evidence/README.md)。当前任务要求按ID读取，执行安排只在[活动计划](../plans/agent-access.md)；参考和交接不另设队列。
