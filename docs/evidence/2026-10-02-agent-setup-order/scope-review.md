# 准备流程范围复核

只读核对本轮标题/步骤修改以及目录、空稿入口；未运行测试、正式应用或 Agent，未操作仍活跃的 Amp 登录。五个作者文件与 [source-final.json](source-final.json) 一致。根任务的 `AgentAuthSection` 两行修改只将可见标题与区域名称统一为 `P.accountHeading`，不改变账号动作的 owner、方法选择或调用。

## 初次与恢复入口

- [AgentSetup](../../../src/components/AgentSetup.tsx:88) 对已连接、无既有来源且无选项的新准备返回账号页。未连接显示程序页；连接完成只推进原 `step=0` 至账号页。已有非空选择可以从模型页继续，已保存的 `step=1/2` 不由连接 effect 重写。
- [AgentHub](../../../src/components/AgentHub.tsx:278) 优先保留原进度，仅补其缺失的选择。真正未完成的新入口使用上述初始化；完成且有可信选择的目录快捷使用仍有明确认证和活跃账号动作的检查。历史 `completed=true` 但没有可信选择有独立的模型确认出口（300–303 行），[已有回归](../../../src/components/AgentHub.continuity.test.tsx:517)明确覆盖；它不是新的首次连接，本片未迁移或清除这一旧标记。
- [EmptyState](../../../src/components/EmptyState.tsx:540) 换至未完成或无已确认选择的 Agent 会打开准备，保留当前稿；其预读受 `preparationComplete` 约束。[App.useAgent](../../../src/App.tsx:707)仅处理选择、原稿替换确认和导航，没有自动发送。旧来源、模型及思考的恢复由原选择对象传递，本轮只改步骤。

## 认证与返回边界

账号页继续动作和其 handler 在已知认证要求或活跃账号操作时拒绝推进；API 服务未选定只阻止账号到模型，不阻止从程序页到账号页修正。模型 tab 保持可查看，已有显式模型重读/短测入口也保留：自动读取受 `needsAuth` 阻止，使用页尾受 `returnBlocked` 阻止，查看 tab 不表示认证成功。[认证观察](../../../src/runtime/authentication.ts:23)仍不以 `session/new` 成功清除请求层的认证失败。

管理页的只读返回或关闭可以离开准备，不代表保存了新的可用选择。已有对话的模型、来源保持，普通管理保存仍需原确认回调。没有发现本轮变更导致正常 tab/页尾跳过认证后自动使用或发送。

准确范围：已有 `completed` 空稿的发送准入仍依据实际草稿错误、连接与来源状态，而非把所有历史 `AUTH_REQUIRED` 都当全局永久禁发；[EmptyState.ready](../../../src/components/EmptyState.tsx:497)和 [Composer](../../../src/components/Composer.tsx:260)可能允许用户明确再发真实请求验证外部登录。本片没有修改该既有重试语义，不能把本片按钮保护表述成全产品认证条件已穷尽验证。

本轮 [131 例相关检查](focused-stable.json)已由作者执行，本次复核未重复运行。新增/调整回归包含首次账号页、无/有可选登录声明、认证要求/活跃操作禁继续、原账号进度重连、原模型步骤及思考值恢复和键盘顺序。安装版的实际观感与入口仍由根任务验证。
