# 第 1 阶段原会话复测与同 Agent 隔离

原会话复测使用 macOS arm64 27.0（26A425）的正式版 `dbe23bb6e`，后续分项分别记录实际版本和环境。原未发稿、保留草稿和原工作位置已复核，历史请求零重发。

## Kilo 原目录

前次同一桌面权限请求中，系统日志比较了上一正式版 `68aefdb49` 与当前版 `dbe23bb6e` 的临时签名，记录代码要求不匹配后进入 `AUTHREQ_PROMPTING`。后续只读核查显示，磁盘上的允许记录对应更早的 `e6e1c3796` 临时签名，用该要求校验当前版同样返回 `errSecCSReqFailed`。因此系统设置显示开启与当前版重新被询问可以同时发生。日志中旧签名的来源仍未知。同一请求未见授权决定，附近的系统通知前台事件也无法确认具体弹窗内容。 [签名核对与终态排查](../2026-11-06-phase1-model-repair/diagnostics.md#kilo-桌面授权) · [Apple 文件权限说明](https://developer.apple.com/forums/thread/678819)

本次用户未看到弹窗，磁盘授权记录仍匹配 `e6e1c3796`。正式应用从原目录列出已加入的原会话，打开并读回正文。沿用 Kilo Gateway 的 Nemotron 3 Ultra (free) 后，一次不带答案的续接准确返回首条消息的标识。列表、加载和续接均有独立界面或协议证据。此结果覆盖本次原会话，长期桌面授权和前次提示的授权结果仍待核。

## Goose 原会话

前次原会话续接的用户消息在发送时已存入 Goose。Farfold 的取消日志边界至 Goose 实际处理取消相隔约 276 秒，随后约 3 毫秒收到协议响应。正式应用本次回读显示该次续接已停止，没有新增助手回复。迟到的额外用户类型行是 Goose 自建的隐藏上下文，前次请求只提交过一次。

Goose 1.52.0 的官方源码显示，保存用户消息后还有整理判断、扩展工具和上下文准备，完成后才写入上述内部上下文，再准备进入提供方回复。该上下文的时间和取消日志均在等待末段。现有记录将排查范围缩到回复前的准备及取消交付，具体等待步骤、写入子进程管道的时点和前次提供方是否收到请求仍待证。 [Goose 回复源码](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/agents/agent.rs#L2288-L2587) · [Goose 取消源码](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/server.rs#L2411-L2427)

原会话回到空闲后，沿用已有免费模型，用一个不同的自测问题做了一次对照。新问题没有提供答案，Goose 精确返回了该会话更早的另一个历史标识并回到空闲，协议终态用时 5.540 秒。

## Copilot 原模型与免费额度

同一归档原会话在 13 份历史快照中都没有已保存的模型选项，最早能核实到 10 月 9 日。10 月 6 日首发记录只确认使用 Agent 的默认模型。同一会话的 Copilot 原生事件另外记录了首发时设置 `auto`，以及 10 月 7 日成功续接之前三次恢复仍选 `auto`。退出事件里出现的当时实际模型另记。旧版 `e954` 显示 Auto 的记录属于另一条自测会话。原生启动事件和 Farfold 当时记录的版本字段不同，原对象归属由会话标识和时间核对。原模型选择已有直接证据，Farfold 的旧保存条目仍为空，旧工具状态也尚未确认，发送保护保持。 [GitHub CLI 本地存储](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)

Copilot Free 每月含免费 AI Credits，模型走 Auto。同账号前一批测试前显示包含额度已用 0%，空目录 Auto 真实回复和停止均通过。额度与旧会话的模型基线分别计证。 [GitHub Copilot 套餐](https://docs.github.com/en/copilot/get-started/plans) · [前批账户与实测](../2026-11-06-phase1-followup/README.md#copilot-当前账号与实测)

11 月 7 日在正式版 `6ce829c5` 已完成的自测对话中打开模型菜单，空搜索只显示一项已选中的 Auto。没有选择、确认或发送。全部已保存模型配置、原稿、保留 1 份及四份测试通信摘要均保持。随后将 GitHub 套餐和账单两页与当前 GitHub CLI 的登录账号核合，页面仍显示 Copilot Free、CLI 启用、包含额度已用 0%。账单页只显示当前筛选无明细，未核本次超额规则或请求费用。正式菜单结果仅覆盖此条已打开的自测对话，未重新读取原始选项回执或冷开。[正式菜单与同账号回执](installed-copilot-auto-eligibility.json)

11 月 7 日补只读模型证据，未另发请求。Kilo 正式原对话的助手记录报告所选免费模型；Goose 正式并发样本核合出站免费模型、回复和用量，回复没有报告具体后端模型；Copilot 隔离并发样本的助手记录报告 Auto 实际选到的一个模型。三个范围分别记录，不代表同会话新切换及冷恢复。[逐家模型回执](actual-models-readonly.json)

Goose 正式自测 B 的既有回复，已用原请求编号核对 OpenRouter 账户和默认工作区日志。详细页显示 NVIDIA，工作区同一行费用显示 $0.00。当前同工作区的 Response Healing 和 Pareto Router 开关为关，服务器网页搜索显示可用。服务器工具仍需在请求中显式声明，旧网页搜索插件的实际默认值没有读到。本次只读既有日志和开关，没有更改账号或发新请求。[同请求回执](goose-openrouter-workspace-readonly.json) · [OpenRouter 工具](https://openrouter.ai/docs/guides/features/server-tools/overview) · [OpenRouter 插件](https://openrouter.ai/docs/guides/features/plugins/overview)

再打开默认工作区四个具体插件的配置对话框。网页搜索、PDF、响应修复、Pareto Router 的「禁止覆盖」均为关，逐个取消关闭，零设置变更。官方支持对未禁止覆盖的插件按请求明确关闭。进程与原通信记录另外核到，旧 B 第三次发送对应上述工作区账单，后来切换及切回也沿用该连接。旧记录无法区分实际凭据来自钥匙串还是覆盖设置，新 Goose 连接仍缺该工作区归属证据。[工作区只读回执](goose-openrouter-workspace-readonly.json) · [OpenRouter 插件覆盖规则](https://openrouter.ai/docs/guides/features/plugins/overview)

第二免费候选的公开输入与输出费率为零。Goose 的聊天模式会跳过模型要求执行的工具，但构建请求时仍加入 Skills 的名称和说明。上一次同一测试对话的实际出站请求中，核到 5 个来自用户目录的技能名称。本机正式版没有只对这条会话关闭 Skills 的入口，因此这次没有发送新的合成测试消息。[候选端点](https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-super-vl:free/endpoints) · [提示准备](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/agents/reply_parts.rs#L197-L240) · [Skills 内容](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/skills/client.rs#L248-L269)

用已登记的 Goose `1.52.0` 程序只向本机模拟地址发出一次合成提示。只许访问专用端口的系统限制已用另一端口和用户目录读取做反例；程序使用假密钥、关闭钥匙串、独立空目录。移除自测中自动加载的一个内置扩展后，官方回执确认扩展和工具为空。请求体核到准确 Super VL 免费模型、仅 NVIDIA、无模型或提供方回退、输入和输出费率上限为 0，并显式关闭网页搜索、PDF 解析、响应修复、Pareto Router 和 Auto Router。程序仍附加自身的 `middle-out` 设置。首次实际发送的用户文本严格断言失败，本机拒绝后共观察到四次 HTTP 尝试，未取得预期模拟回复。没有外部推理、真实密钥或生产改动，进程正常退出。[首轮本机回执](goose-loopback-routing-first-attempt.json) · [Goose 请求参数](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/documentation/docs/getting-started/providers.md) · [OpenRouter 公开接口](https://openrouter.ai/openapi.json)

首轮夹具遗漏了 Goose 追加并合入用户消息的回合信息。新空对话保留相同路由参数，按源码逐项比对后通过。一次提示产生一次本机生成请求并读回预期模拟标识，另有一次本机模型目录查询。系统文字在空白归一化后匹配官方固定模板，用户原文后只有按分钟记录的本地时间、时区偏移和独立测试目录，三个会话标识均属于新测试对话。测试进程读取用户目录的样本路径被拒，请求无用户目录内容、扩展文字或工具字段。自测进程正常退出，临时数据已移除。本地样本未使用真实凭据，仍未核当前新连接的 OpenRouter 工作区归属、实际模型回复或费用。[复验回执](goose-loopback-routing-exact-context.json) · [Goose 回合信息](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/agents/moim.rs#L124-L180)

另用同一已登记 Goose 1.52.0 程序直接启动独立测试连接。两条空对话分别移除自测范围内唯一扩展，读回扩展和工具均为空。仅把 A 从 Ultra 改为同服务 Super VL，正常关闭自测进程后，用新进程加载同一两个对话。A 读回 Super VL，B 保持 Ultra，扩展与工具仍为空，两条消息数为零。两次自测进程均正常退出，零提示和登录请求。该分项覆盖官方程序自己的模型保存和冷恢复，实际账号、回复、费用和正式应用仍待验证。[Goose 隔离冷恢复](goose-isolated-model-cold-restore.json)

进一步用隔离的 Farfold 连接管理器启动同版官方程序，只放行一个本机目录服务。两个空自测对话均初始化并创建成功，Goose 临时库两条原生记录均为 OpenRouter 和 Ultra，只有一次本机模型目录查询。首轮版本检查把官方输出前置空格误判，校正后版本命令退出 0。随后首条对话的模型选项和就绪联合检查失败，未下发配置、冷读、登录或模型请求，两组测试进程均收回。已有通信只记录请求类型，需在切换前分别留证当前选项、可选模型及就绪状态。Farfold 冷开配置核对仍未实测。[隔离前置回执](goose-manager-local-catalogue-preflight.json)

临时库确认异步刷新写入了 Ultra 和 Super VL。首条响应与刷新记录时间在同一毫秒，首条响应比第二条多 563 字节。官方内置目录不含 Super VL，新建对话不会等待刷新，因此首条可能仍返回内置目录。现有回执只保留时间和帧大小，首条具体菜单、就绪状态及提交时序仍待分项取证。[内置目录](https://github.com/block/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose-providers/src/openrouter.rs#L24-L38) · [异步刷新](https://github.com/block/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/acp/server.rs#L957-L995)

以 `164532913` 的连接管理器重新创建隔离测试。新会话 A 首次已经就绪，原 Ultra 选项一条，Super VL 为零；独立读库确认目录写入后，新会话 B 已就绪且两个选项各一条。重新加载两条自测对话后均读到两个选项，只由 Farfold 将 A 改为 Super VL。再用独立官方接入把 A 的原生设置改回 Ultra，核对 Farfold 的保存值仍为 Super VL，B 始终为 Ultra。新进程冷加载同一 A 时只发一次加载和一次配置恢复，随后加载 B 时没有新增配置请求。两条原标识、各自原生配置及两条 Farfold 保存记录核合。六个管理器进程组及独立漂移对照全部回收。全程只有一次本机模型目录查询，零认证和模型发送；范围限隔离管理器与官方程序，正式应用、真实账号及候选模型实际回复仍待。[隔离冷开校正回执](goose-native-manager-cold-reconciliation.json)

## 独立验证与缺项

Kilo 7.8.1 的真实隔离连接声明支持关闭、继续和列出。在两个无消息的自测对话中，只对 A 关闭一次，收到同请求回执；B 在同一进程以官方继续入口读回原设置，两条历史都保留。未发送模型、工具或审批。B 原活动路由是否全程连续、A 专属资源是否已释放，以及正式界面和跨版桌面授权仍未验证。[隔离会话关闭回执](kilo-lifecycle-isolated.json)

另为验证 A 关闭后 B 原路由是否仍可直接操作，使用验证过的 7.8.1 发行物、空白隔离资料及仅本机可达的目录服务。初次保护探针查询一个尚未创建的测试库，无法核到可写，未发协议请求；改用已存在的专用空文件独立确认边界后，握手成功且确实声明关闭和列出。首个新建对话未返回可验成功值，立即停止。受控记录无法区分官方错误和返回结构不符；需先为该回执分别记录错误类型、返回值形态及本机目录请求类别。仅一次本机目录查询，零真实账号、认证、模型或关闭请求。进程正常退出且组消失，临时资料已移除。[关闭隔离前置回执](kilo-active-route-close-preflight.json)

复测沿用先前成功生命周期测试的精确握手请求，并区分错误和成功值。此次第一条新建回执编号匹配，官方返回 `-32603`，有错误对象且无成功值，隔离库会话和消息均为零。唯一的请求为本机模拟公开目录，零认证、模型、关闭和远端请求。原进程由输入结束正常退出，隔离资料已移除。错误的内部来源仍待确认；下次只记录固定的目录或会话阶段类别及成功阶段标记，省去原始内容。[官方错误回执](kilo-active-route-close-new-error.json)

同一保护边界与目录数据下，只保留官方阶段类别后再次核到 `-32603`，类别明确为 `directory`。官方初始化标记作为对照存在，目录快照完成、进入会话创建及新建成功三个标记均未出现。隔离库仍无会话或消息，仅一次本机公开目录查询。原进程组正常退出，临时资料已移除。此结果将失败定位在会话创建前的工作目录准备，目录准备内部的失败点及 A/B 关闭仍待验。[阶段归因回执](kilo-new-session-phase-attribution.json)

后续对照核到隔离规则允许模拟目录服务，却拒绝 Kilo 自己启动的本机监听端口。确认监听归属后，只放行这两个指定端口，目录准备和首条新建都成功。夹具随后识别到一条此前未分类的本机请求并停止。最后一次仅把这条匿名 `GET /api/defaults` 归为预期拒绝，仍回复 HTTP 403。[监听归属与拒绝](kilo-owned-listener-denial.json) · [两端口对照](kilo-two-endpoint-new-session-control.json)

最后一次运行中，同一官方进程新建无消息的 A、B，仅关闭 A 一次并收到对应成功回执。A 原连接的同类操作返回精确匹配的 `-32602`，B 沿原连接操作成功、配置保持，未重新接入。官方列表和测试库均保留两条历史，零模型发送、认证或远端请求。原进程组正常退出。范围限隔离规则下的 Kilo 工作目录准备、A 活动路由撤销和 B 的连续性；原桌面问题、活动工具资源释放及正式应用另验。[指定关闭回执](kilo-scoped-live-route-close.json)

另一次同样隔离的 Kilo 零发送查询，官方新对话实际列出 Kilo Gateway 的既有 Ultra 和两个免费候选 Super VL、Dots。该次默认模型与原对话不同，未改模型或服务。免费主模型的菜单声明与后台标题等请求的计费条件分别核验。[实际模型菜单](kilo-model-options-isolated.json) · [Kilo 免费及后台请求说明](https://kilo.ai/docs/getting-started/using-kilo-for-free)

Kilo 7.8.1 官方程序在隔离目录和会话库中建立两个无消息测试会话。先把 A 设到已有正式样本使用的免费 Ultra，再切到同服务免费 Dots3 并恢复 Ultra。切换期间，B 仅重设其当前模式以读回完整设置，模型、模式及可用的推理选项与初值一致。两条测试库记录保持、零提示和审批，进程经标准输入关闭正常退出。此次未使用登录账号，正式版切换、真实回复、计费和冷恢复继续待验。[隔离切换回执](kilo-isolated-model-switch.json)

11 月 7 日另在正式 6ce829c5 打开已加载、空闲的归档自测 Kilo 对话。仍用同一服务，从免费 Ultra 暂选免费 Dots3 时数据库和通信保持；点击「确认并保存」后，界面及只读数据库均读到 Dots3。再按精确模型标识找到原 Kilo Gateway 免费候选，明确保存后恢复原配置。仅该连接有两次设置请求和对应正常回执，其他会话行、草稿、待发及五份通信保持，零新开、发送或取消。正式模型回复及冷开待验。[正式切换与恢复回执](installed-kilo-model-switch-restore.json)

接着使用当前 Farfold 连接管理器和同一官方程序补冷恢复。根据官方初始设置回执，通过实际存储登记两条空自测会话，避免为创建记录而发送。Farfold 仅将 A 的已保存模型从 Ultra 切到同服务 Dots3，B 的记录保持。单独的只读连接加载两条原会话均返回官方默认模型，零设置请求。普通重开使用新进程，每条连接都先加载对应原会话，再重新应用已确认设置。A 恢复 Dots3、B 保持 Ultra，均确认就绪，保存记录不被覆盖，无新增消息。四轮共八个自测进程组全部确认退出，无强制升级。本次覆盖连接管理器和实际官方程序，正式应用、账号、回复及计费仍待。[管理器冷恢复回执](kilo-native-manager-cold-model-restore.json)

首次断言把 Farfold 已处理的返回字段当成官方原始回执，导致验证失败。复验改为独立只读对照，定向测试通过，产品代码未改。

11 月 7 日用当前产品源码 `077b4b988` 的连接管理器和同一官方 Kilo 7.8.1 补实际匿名回复。测试沿用普通用户主目录，隔离配置目录、会话库与空工作目录；未复制登录配置或凭据。发送前核对隔离认证和机器级托管配置为空，标题、自动整理、遥测及外部上下文入口已关闭，28 项工具均禁用，官方公开列表的准确 Dots3 候选输入、输出费率均为 0。冷开恢复同一原会话后，A 使用恢复出的 Dots3，发出一个合成标识请求，2.764 秒返回准确标识并结束。Kilo 原生记录报告提供方 `kilo`、模型 `dots-studio/dots-3-note-preview:free` 和费用 0。原生记录仅 A 增加一组问答，B 无消息，保存设置、会话行及原连接均保持；未观察到工具或审批事件。八个自测进程组均退出，未强制升级，产品文件恢复至原字节。[匿名冷开实测回执](kilo-native-manager-anonymous-cold-reply.json) · [官方匿名访问](https://kilo.ai/docs/gateway/authentication#anonymous-access) · [官方计费说明](https://kilo.ai/docs/gateway/usage-and-billing)

通信只观察到一次 Farfold 发送，操作者未重试。官方程序对服务错误不重试，遇不完整回复可在同一免费模型上最多额外尝试两次；未观测实际 HTTP 请求次数。原生记录的费用字段限这次匿名样本。已有登录账号、正式版切换后的实际模型回复及冷开、桌面跨版本权限仍待验。

两条 Kilo 测试对话共用一个自有空目录，并使用同一免费模型。两条对话的 Agent 原会话标识和协议记录分别核对。两条请求同时运行时，取消只发给 A，A 明确停止，B 独立回复其专属标识并回到空闲。范围限这一次同 Agent、同目录测试。

Goose 另用已登记的 1.52.0 官方程序和隔离本机服务。唯一一次合成请求进入本机流式响应后，服务先发响应头和注释，再扣住正文。发送一次对应取消后，客户端关闭这条连接并报告已停止，未出现回复正文。收到关闭时 Goose 仍运行；随后正常回收自测进程组。证据限该客户端等待与连接释放，原目录长等待和真实服务端执行仍待核对。[本机延迟响应回执](goose-loopback-held-provider-cancel.json)

## 独立登录尝试

Kilo 7.8.1 的真实终端登录由已登记程序执行。对应官方协议方法返回空对象，不能作为已登录证据。以空白资料目录、真实用户目录读取保护和禁止打开浏览器的条件尝试一次设备授权。隔离日志核到启动阶段的 Git 执行受限，终端夹具未可靠确认挑战或取消，清理信号曾返回权限错误。随后只读查到仅剩原正式 Kilo，测试目录无认证文件，已清理专用数据。是否曾在服务侧创建临时挑战仍未知。[Kilo 尝试回执](kilo-isolated-device-start-attempt.json) · [官方授权实现](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/kilo-gateway/src/auth/device-auth-tui.ts)

Copilot 1.0.106 只读使用已缓存的官方程序，另设配置及缓存目录，禁止网络、实际用户目录读取和两个钥匙串服务查询。首次启动的路径解析限制已定位并在隔离对照中修正；再次尝试仍在握手返回前退出。未启动后续账号读取，零登录、退出账号或模型请求。既有账号的正式应用证据保持独立，隔离状态与新登录仍待核。[Copilot 尝试回执](copilot-isolated-startup-guard-attempt.json) · [官方凭据存放规则](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli#how-copilot-cli-stores-credentials)

独立改用同版本官方原生运行程序后，仍在回复一次 SDK 连接请求前退出，账号状态查询没有开始。网络、用户文件内容、隔离外写入及钥匙串两项查询均由系统实测拦截。未执行登录、退出、模型或额度请求。[原生 SDK 尝试回执](copilot-native-isolated-sdk-attempt.json)

又用同版本官方公开独立包，在普通用户目录之外准备唯一可执行件。归档摘要和严格签名通过，先实测隔离环境拒绝网络、用户文件内容、隔离外写入、钥匙串和未许可程序执行，再启动一次并发送一次本地连接请求。进程在返回连接确认前退出 1，错误类别未能归属，账号状态查询没有开始。此次仍受严隔离条件约束，未能确定退出的具体原因。[独立发行版回执](copilot-official-standalone-noauth-preflight.json) · [官方发行](https://github.com/github/copilot-cli/releases/tag/v1.0.106)

改用独立包的官方 ACP 入口，先核版本。首次版本命令正常退出，但夹具漏识别官方版本号后的句点，按门槛停在握手前。核实内嵌版本输出格式后，只修正这一判定并复测。相同签名程序报 1.0.106，另一个空白隔离档案中的单次协议版本 1 初始化，返回 `copilot-login` 终端方法及命令存在标记，并声明历史加载、列表、关闭、图片和嵌入内容。标准输入结束后进程自然退出 0，进程组释放。范围限离线启动及官方声明，真实登录、SDK 账号状态、会话和模型另验。[版本门记录](copilot-standalone-offline-version-gate.json) · [ACP 初始化回执](copilot-standalone-offline-acp-initialize.json)

同一官方独立包的令牌入口另在全禁网空档案和专用终端中启动一次。隔离预检通过，程序在确认输入提示前自然退出 1，原因未知。终端和进程组已释放，未发送结束控制或凭据，未进入浏览器或模型。离线令牌等待及撤回、默认登录、真实账户仍待验证。[令牌入口尝试](copilot-standalone-offline-token-withdrawal.json) · [官方选项](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#copilot-login-options)

随后在同规则下用无业务探针实测，三个继承描述符均为正常终端，能读终端属性并输出标记。重新以读写方式打开终端设备会被拒，原限制保留。按官方 `login --with-token` 形式另启动一次同签名程序，实际出现准确输入提示。核对原进程归属和关闭回显后，只送一次空结束控制，零凭据。进程报通用登录错误，自然退出 1，终端与进程组释放，临时档案清理。确切的「未提供令牌」提示未观察到，前次退出原因仍未知。此次覆盖离线输入等待与退出，默认登录、账户变更和确切空令牌拒绝另验。[终端探针](copilot-standalone-offline-controlling-pty-canary.json) · [官方提示回执](copilot-standalone-offline-canonical-token-prompt.json)

再从同一签名程序中提取内嵌源码并核合摘要。空输入会抛出错误，统一格式化会加上 `Error:`，前次夹具漏了这一前缀。旧输出已丢弃，保留原未知结论。修正匹配并通过五项正反例后，另一个空档案的一次官方启动实际显示提示；单次空结束控制后，准确返回 `Login failed: Error: no token was provided`，自然退出 1。进程组、终端和临时档案释放，零凭据、联网、浏览器及模型。范围限离线凭据输入前撤回，默认登录、OAuth 取消、真实账号和正式界面另验。[准确拒绝回执](copilot-standalone-offline-empty-token-refusal.json)

同版官方程序另由当前 Farfold 的真实终端管理器在空资料下启动。准确令牌提示、程序路径和单独进程组核合后，只关闭该终端一次，65 毫秒收到退出码 1。匹配退出回执、退出等待值、主终端释放、确切登记移除和进程组消失均核合，零输入及 EOF。初末隔离配置和凭据为空，472 次中间观察未见异常，关闭瞬间未原子采样配置。沿用原全禁网规则，仅更换自有临时写入路径，未新增网络流量追踪。七个既有应用及受管进程的前后PID、父进程、进程组和程序名称核合，未核进程出生身份。正式界面、默认授权和真实登录仍待验证。[实际终端关闭回执](copilot-native-pty-token-prompt-close.json)

另在全禁网的独立档案里，用已登记的官方 Goose 1.52.0 导入两条自制 Pi 格式记录。两个不同进程各完成一次初始化和四次历史列表查询。全量 2 条、两个目录各 1 条、空目录 0 条，标识、目录及标题逐一核合，无重复或正文片段。两次均正常退出，临时档案清理。该项覆盖官方列表的目录过滤及冷开，官方固定页长 50，此两条未触发分页，未用真实账号、模型或工具。[Goose 目录回执](goose-official-offline-history-directory-scope.json) · [官方列表实现](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/acp/server/list_sessions.rs)

随后通过官方导入命令在同类全禁网档案里准备 52 条自制记录。两次独立启动中，目录 A 均分两页返回 50＋1 条，目录 B 返回 1 条，空目录返回 0 条。标识、目录、标题和顺序逐项核合。冷启动后可在原目录继续用旧游标，换目录或省略目录时明确拒绝。两次列表进程正常退出，测试资料已清理。运行时样本的时间戳均不同，同时间戳排序仅核源码，真实历史和正式界面仍按各自回执验收。[Goose 分页回执](goose-official-offline-history-pagination.json) · [官方列表实现](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/acp/server/list_sessions.rs)

另用已登记 Kilo 7.8.1、空资料目录和只允许访问指定本机端口的环境完成设备授权对照。官方程序在本机服务返回待授权再批准后取资料和默认模型，将唯一合成凭据写为权限 0600，第二个官方进程读回 Kilo OAuth 类型。另一组由本机服务返回明确拒绝，官方程序显示拒绝并退出，无凭据写入。两次尝试从本机发停止信号时仍继续轮询，超时后清理；即时取消未通过。全部只用合成响应，真实账户、服务端取消和收费仍未验证。[本机批准、拒绝及取消回执](kilo-local-device-approval-and-denial.json)

复核 7.8.1 的授权入口与锁定的 Clack 依赖。Kilo 启动等待动画后单独等待授权回调。Clack 首次收到 INT 或 TERM 会取消动画并撤下两种信号监听；这里没有向授权回调传递取消。这与先前继续轮询、再向同一进程发 TERM 才退出的观测吻合。旧试验没有记录首个信号的处理回执。[Kilo 授权入口](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/opencode/src/cli/cmd/providers.ts#L96-L109) · [等待动画包装](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/opencode/src/cli/effect/prompt.ts#L26-L33) · [Clack 发布版本](https://www.npmjs.com/package/@clack/prompts/v/1.0.0-alpha.1)

用当前 Farfold 的终端管理器另测同一官方程序。收到首次待授权响应后关闭一次确切的测试终端，29 毫秒得到相符的退出回执，进程组消失，终端和登记均释放。再观察 6.26 秒没有轮询，也没有凭据文件。范围为本机合成服务及终端管理器，真实账号、远端设备挑战的撤回和正式界面取消仍待实测。[终端关闭回执](kilo-native-pty-device-cancel.json)

官方 Kilo 7.8.1 的本地退出另用独立测试资料核对。一次本机合成授权后，新进程读到恰好一条 Kilo OAuth。执行一次官方指定服务的退出命令，隔离凭据文件清空，仍为权限 0600，另一个新进程读到零凭据。五次官方程序调用均正常退出，对应进程组回收。范围为合成凭据本地清理，真实换号、远端撤销、其他账号保留和正式应用界面仍待实测。[本地退出回执](kilo-local-synthetic-logout.json)

向同一版本客户端使用的官方 HTTPS 发起入口发送一次无凭据请求，取得 HTTP 200 和 JSON 对象。本次夹具额外限制码长、字符、地址长度和整数有效期，首层合并校验未通过，后续验证地址及轮询未执行。回执只保留合并结果，无法判定具体字段，也无法确认有效挑战。官方客户端成功响应后解析 JSON，其公开类型没有夹具的长度和整数限制。没有保存原响应、浏览器登录或账号操作，未重试。[实网发起回执](kilo-live-device-start-bounded.json) · [官方发起实现](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/kilo-gateway/src/auth/device.ts#L4-L20) · [公开类型](https://github.com/Kilo-Org/kilocode/blob/4089197545a01bbc9fa8041c1305b3fb0b0f8e66/packages/kilo-gateway/src/types.ts#L8-L18)

另核同版完整官方发布包在独立资料下启动。408 个文件按发布包准备，实际程序版本和空凭据列表核合。仅通过本机校验的设备发起请求才会转发。这次 24 秒内零本机发起请求通过校验，实网发起和状态查询各为零。超时后仅回收对应测试进程及目录。计数在本机校验之后，超时回执没有保留是否收到被拦请求或具体启动错误。与先前 HTTP 200 的额外校验失败分别记录。[官方程序发起回执](kilo-official-cli-live-relay-preflight.json)

本机对照把空凭据检查和登录放在两份不同的临时资料中，先于校验统计每条请求。官方 CLI 使用全新资料进入设备流程，收到一条合成挑战、发出一次匹配轮询并按本机模拟过期退出。设备请求和轮询均核到确切进程，无本机校验拒绝，凭据文件未生成。只连接本机。主程序退出时进程组尚未确认释放，随后只读未见临时目录中的程序仍活动，原组完整释放仍缺确证。前次超时的原因保持未知。[本机阶段对照](kilo-official-cli-local-startup-diagnostic.json)

沿用不同的临时资料及前置诊断，隔离的官方 7.8.1 程序本次收到真实设备挑战。由确切测试进程发起的一次无凭据请求得到 HTTP 200，官方三个必需字段的类型和单独的安全校验通过。一次匹配轮询取得真实 HTTP 202，未读取轮询正文。下一次轮询仅由本机返回模拟过期，程序退出 1，原测试进程组两次核到已消失，未留下凭据、设备码、验证地址或原始内容。未打开浏览器或操作账号。真实授权完成、服务端过期或撤回及正式应用界面继续待验，前次失败的具体字段和启动原因仍未知。[真实待授权回执](kilo-official-cli-live-device-pending.json)

组合验收计划在收到官方 HTTP 202 后，由 Farfold 终端管理器关闭确切测试终端并核对释放。此次预检发现原测试程序的缓存已覆盖，两个现有程序均没有对应测试入口。本机原端口规则也放行同端口的 IPv6 和本机非回环地址，精确 IPv4 规则未能加载。未启动 Kilo 或发官方请求。官方真实待授权与合成服务的终端关闭两项证据继续分列，待隔离条件及确切终端夹具可用再做组合。[组合预检回执](kilo-pending-pty-close-preflight.json)

此轮先核发行来源。官方下载 ZIP 与当时 ACP 登记和 GitHub 发布摘要一致，GitHub 签发的软件物料清单证明通过，408 个归档文件逐一与登记目录相同。严格签名核验在正式程序和官方解压件上都失败，源于最后一个不完整页的哈希按补零后长度生成。两份原字节保持，未重新签名或替换。[历史登记](../2026-09-30-agent-access-mechanisms/kilo/static-receipt.json) · [官方发行](https://github.com/Kilo-Org/kilocode/releases/tag/v7.8.1)

首波完整验收仍为 0/3。Kilo 跨版本授权、Goose 前次续接等待点、Copilot 旧工具终态、首波新登录及安装版存储故障仍按各自条件推进。后续已取得的 Copilot 原模型补录和真实审批另见对应批次。[原模型补录](../2026-11-06-phase1-model-repair/README.md) · [三家审批](../2026-11-06-phase1-approval/README.md) · [证据指纹](summary.json) · [当前计划](../../../plans/agent-access.md)
