# 第 1 阶段原会话复测与同 Agent 隔离

本批沿用 macOS arm64 27.0（26A425）的正式版 `dbe23bb6e`。原未发稿、保留草稿和原工作位置已复核，历史请求零重发。

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

11 月 7 日补只读模型证据，未另发请求。Kilo 正式原对话的助手记录报告所选免费模型；Goose 正式并发样本核合出站免费模型、回复和用量，回复没有报告具体后端模型；Copilot 隔离并发样本的助手记录报告 Auto 实际选到的一个模型。三个范围分别记录，不代表同会话新切换及冷恢复。[逐家模型回执](actual-models-readonly.json)

## 独立验证与缺项

Kilo 7.8.1 的真实隔离连接声明支持关闭、继续和列出。在两个无消息的自测对话中，只对 A 关闭一次，收到同请求回执；B 在同一进程以官方继续入口读回原设置，两条历史都保留。未发送模型、工具或审批。B 原活动路由是否全程连续、A 专属资源是否已释放，以及正式界面和跨版桌面授权仍未验证。[隔离会话关闭回执](kilo-lifecycle-isolated.json)

另一次同样隔离的 Kilo 零发送查询，官方新对话实际列出 Kilo Gateway 的既有 Ultra 和两个免费候选 Super VL、Dots。新对话的默认值与原对话不同，不能代替原基线。未改模型或服务；免费主模型仍不证明后台标题等请求不会产生费用，真实切换等待这项条件。Copilot 的 Free 账号仅 Auto，Goose 尚缺原服务实际提供第二选项的回执。[实际模型菜单](kilo-model-options-isolated.json) · [Kilo 免费及后台请求说明](https://kilo.ai/docs/getting-started/using-kilo-for-free) · [Copilot 模型访问说明](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-access-to-ai-models)

两条 Kilo 测试对话共用一个自有空目录，并使用同一免费模型。两条对话的 Agent 原会话标识和协议记录分别核对。两条请求同时运行时，取消只发给 A，A 明确停止，B 独立回复其专属标识并回到空闲。范围限这一次同 Agent、同目录测试。

首波完整验收仍为 0/3。Kilo 长期授权、Goose 前次续接等待点、Copilot 的 Farfold 模型基线恢复与旧工具状态、真实审批、安装版存储故障及 Windows 安装仍按各自条件推进。 [证据指纹](summary.json) · [当前计划](../../../plans/agent-access.md)
