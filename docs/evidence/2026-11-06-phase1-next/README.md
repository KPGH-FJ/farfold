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

第二免费候选的公开输入与输出费率为零。Goose 的聊天模式会跳过模型要求执行的工具，但构建请求时仍加入 Skills 的名称和说明。上一次同一测试对话的实际出站请求中，核到 5 个来自用户目录的技能名称。本机正式版没有只对这条会话关闭 Skills 的入口，因此这次没有发送新的合成测试消息。[候选端点](https://openrouter.ai/api/v1/models/nvidia/nemotron-3.5-super-vl:free/endpoints) · [提示准备](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/agents/reply_parts.rs#L197-L240) · [Skills 内容](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/skills/client.rs#L248-L269)

另用同一已登记 Goose 1.52.0 程序直接启动独立测试连接。两条空对话分别移除自测范围内唯一扩展，读回扩展和工具均为空。仅把 A 从 Ultra 改为同服务 Super VL，正常关闭自测进程后，用新进程加载同一两个对话。A 读回 Super VL，B 保持 Ultra，扩展与工具仍为空，两条消息数为零。两次自测进程均正常退出，零提示和登录请求。该分项覆盖官方程序自己的模型保存和冷恢复，实际账号、回复、费用和正式应用仍待验证。[Goose 隔离冷恢复](goose-isolated-model-cold-restore.json)

## 独立验证与缺项

Kilo 7.8.1 的真实隔离连接声明支持关闭、继续和列出。在两个无消息的自测对话中，只对 A 关闭一次，收到同请求回执；B 在同一进程以官方继续入口读回原设置，两条历史都保留。未发送模型、工具或审批。B 原活动路由是否全程连续、A 专属资源是否已释放，以及正式界面和跨版桌面授权仍未验证。[隔离会话关闭回执](kilo-lifecycle-isolated.json)

另一次同样隔离的 Kilo 零发送查询，官方新对话实际列出 Kilo Gateway 的既有 Ultra 和两个免费候选 Super VL、Dots。该次默认模型与原对话不同，未改模型或服务。免费主模型的菜单声明与后台标题等请求的计费条件分别核验。[实际模型菜单](kilo-model-options-isolated.json) · [Kilo 免费及后台请求说明](https://kilo.ai/docs/getting-started/using-kilo-for-free)

Kilo 7.8.1 官方程序在隔离目录和会话库中建立两个无消息测试会话。先把 A 设到已有正式样本使用的免费 Ultra，再切到同服务免费 Dots3 并恢复 Ultra。切换期间，B 仅重设其当前模式以读回完整设置，模型、模式及可用的推理选项与初值一致。两条测试库记录保持、零提示和审批，进程经标准输入关闭正常退出。此次未使用登录账号，正式版切换、真实回复、计费和冷恢复继续待验。[隔离切换回执](kilo-isolated-model-switch.json)

接着使用当前 Farfold 连接管理器和同一官方程序补冷恢复。根据官方初始设置回执，通过实际存储登记两条空自测会话，避免为创建记录而发送。Farfold 仅将 A 的已保存模型从 Ultra 切到同服务 Dots3，B 的记录保持。单独的只读连接加载两条原会话均返回官方默认模型，零设置请求。普通重开使用新进程，每条连接都先加载对应原会话，再重新应用已确认设置。A 恢复 Dots3、B 保持 Ultra，均确认就绪，保存记录不被覆盖，无新增消息。四轮共八个自测进程组全部确认退出，无强制升级。本次覆盖连接管理器和实际官方程序，正式应用、账号、回复及计费仍待。[管理器冷恢复回执](kilo-native-manager-cold-model-restore.json)

首次断言把 Farfold 已处理的返回字段当成官方原始回执，导致验证失败。复验改为独立只读对照，定向测试通过，产品代码未改。

11 月 7 日用当前产品源码 `077b4b988` 的连接管理器和同一官方 Kilo 7.8.1 补实际匿名回复。测试沿用普通用户主目录，隔离配置目录、会话库与空工作目录；未复制登录配置或凭据。发送前核对隔离认证和机器级托管配置为空，标题、自动整理、遥测及外部上下文入口已关闭，28 项工具均禁用，官方公开列表的准确 Dots3 候选输入、输出费率均为 0。冷开恢复同一原会话后，A 使用恢复出的 Dots3，发出一个合成标识请求，2.764 秒返回准确标识并结束。Kilo 原生记录报告提供方 `kilo`、模型 `dots-studio/dots-3-note-preview:free` 和费用 0。原生记录仅 A 增加一组问答，B 无消息，保存设置、会话行及原连接均保持；未观察到工具或审批事件。八个自测进程组均退出，未强制升级，产品文件恢复至原字节。[匿名冷开实测回执](kilo-native-manager-anonymous-cold-reply.json) · [官方匿名访问](https://kilo.ai/docs/gateway/authentication#anonymous-access) · [官方计费说明](https://kilo.ai/docs/gateway/usage-and-billing)

通信只观察到一次 Farfold 发送，操作者未重试。官方程序对服务错误不重试，遇不完整回复可在同一免费模型上最多额外尝试两次；未观测实际 HTTP 请求次数。原生记录的费用字段限这次匿名样本。已有登录账号、正式版模型切换及冷开、桌面跨版本权限仍待验。

两条 Kilo 测试对话共用一个自有空目录，并使用同一免费模型。两条对话的 Agent 原会话标识和协议记录分别核对。两条请求同时运行时，取消只发给 A，A 明确停止，B 独立回复其专属标识并回到空闲。范围限这一次同 Agent、同目录测试。

首波完整验收仍为 0/3。Kilo 跨版本授权、Goose 前次续接等待点、Copilot 旧工具终态、首波新登录及安装版存储故障仍按各自条件推进。后续已取得的 Copilot 原模型补录和真实审批另见对应批次。[原模型补录](../2026-11-06-phase1-model-repair/README.md) · [三家审批](../2026-11-06-phase1-approval/README.md) · [证据指纹](summary.json) · [当前计划](../../../plans/agent-access.md)
