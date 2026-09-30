# 标签与恢复选择说明：独立设计审查

审查时间：2026-10-01T04:09:25.889762+08:00。只读核对两份诊断、当前源码、产品契约和已保存现场文本；没有启动应用/Agent、读数据库/凭据、改生产源码或运行测试。**设计范围可实施；本记录不是实现终审或新候选安装通过。**待作者冻结后再核最终差异。

## 已核对的事实

- [同名账号诊断](../2026-10-01-agent-access-directory-batch4/auth-label-diagnosis.md)的 SHA-256 为 `c57e75cff4da3b7768d06cb9861ed785c1b0e39ce51a879340697f9969b4fa0d`。[GLM 菜单](../2026-10-01-agent-access-directory-batch4/glm-auth-options.txt)实际有两条 `Z.AI API key`；[公开登记](../2026-10-01-agent-access-directory-batch4/glm-registration.json)中 ID、缺省 Agent / 旧环境变量分类不同，未执行任一方法。
- [只读漂移诊断](../2026-10-01-agent-config-categories/readonly-drift-diagnosis.md)的 SHA-256 为 `401b52cb0032374188debcb467e4575c90fce8519bdbac24ea93a0a6d935bef7`。[恢复文本](../2026-10-01-agent-config-categories/codex-restored.txt)保留 `gpt-6-astra → gpt-6.1-sol`、`ultra → 未提供` 并暂停发送；[弹层文本](../2026-10-01-agent-config-categories/codex-readonly.txt)却把 `6.1 Sol` 与无条件“保留创建时”宣言并列。这是显示冲突，不是自动修改了原选择的证据。
- [PRODUCT.md §4、§6](../../../PRODUCT.md)要求首次接纳后固定模型/推理、恢复只读；已有设置、登录、模型读取、实际回复分别呈现。两个修正都可沿现有数据完成，不需要新增存储、认证能力或发送门槛。

## 账号标签边界

[AgentAuthSection](../../../src/components/AgentAuthSection.tsx)仍用精确 `method.id` 作为 option value、选择查找和动作入口；第 479–482 行仅以 `name` 显示。第 186–236 行保留当前目标、来源、工作与 `unavailableReason` 守卫。[auth_method.ts](../../../src/runtime/auth_method.ts)明确把 environment/unsupported 作为只读说明，不能退回 authenticate。

诊断所提“原名称 + 已核实 kind/purpose 的短说明；仍同名同类时加公开 ID”可放入一个纯标签函数。仅改变显示字符串，保留原 ID、原方法对象和已冻结操作描述；不同名称不必改。空白折叠只用于判断肉眼同名，不改实际名称或载荷。不能从 `API key` 名字、description、变量值、命令或品牌推断路由，也不能把旧 env_var 描述为当前标准配置能力。

菜单区分应帮助理解当前操作：environment 明确目前只可查看说明；terminal 的 setup 与 login 沿现有 purpose；其余不可执行原因继续显示和守卫。只为标签加类型不应自动选择第一项、不应执行登录，也不应让缓存/API 来源/其他工作下的按钮变为可用。更多手动说明、重查与返回继续可达。

最小行为回归可复用 [AgentAuthSection.declarations.test.tsx](../../../src/components/AgentAuthSection.declarations.test.tsx)：同名 agent/environment 实际 option 标签不同且 ID 不变；明确选环境项后无普通登录/API 按钮；选 agent 后仅明确点击才调精确原 ID；同名同类调序后选择不漂移；不同名/单方法保持原样；公开字段外的 canary 不进入标签。

## 原选择与当前返回值的边界

[ThreadView](../../../src/components/ThreadView.tsx)第 381–384 行从当前 configOptions 取主模型；第 830–851 行普通“模型”行后无条件显示固定宣言。[config_check.ts](../../../src/runtime/config_check.ts)保存检查状态及每个 issue 的原值/当前值；[protected_config.ts](../../../src/runtime/protected_config.ts)锁住当前和已记录的完整 ID 集合。这些事实支持仅做显示修正。

弹层应保留当前返回模型，并明确它的来源；可靠原值只从检查的 `issues[].expected` 读取。不能从 `recordedModel` 未赋值字段、主模型标签或相邻同类项制造原值，也不能为了使显示一致发 setter。ready 的已有/恢复对话、等待明确确认、保存失败、无完整检查的旧漂移、新稿必须分别措辞；来源仍取当前对话保存的服务来源，模型漂移不表示服务也漂移。

实施时需要补齐两个具体反例，已通知作者：

1. **缺失当前模型不能显示“默认模型”。** 当前 `modelOption` 缺失直接回退 `STRINGS.switcher.defaultModel`。当原模型存在但恢复未返回该项时，改成“Agent 当前返回的模型”后若仍显示“默认模型”，会制造未收到的默认值；这类未通过检查状态应显示“未提供”，同时保留 issue 中的原值。正常新稿的既有默认展示无需因此全局改变。
2. **同名配置项的差异说明也需可辨。** `configCheckMessage` 按 ID 找项，但最终优先输出 option.name；两个独立受保护 ID 同名时仍可能得到无法对应的两段文字。复用同名时加公开 ID 的最小区分，按每个 issue 自己的 expected/current 显示；不能用 first() 或一个推理值解释全部同类别项。

最小测试应落在真实 ThreadView 模型弹层子树，而不只测试字符串函数：changed + missing 的恢复反例；完全没有当前 modelOption；同名多保护 ID；confirmation_required/record_failed/旧无 check 漂移；正常 ready 恢复与可编辑新稿。打开和渲染弹层不调用设置/确认/发送 IPC，原来源、配置、待发内容不改变。确认仍走现有 [ConfigCheckReview](../../../src/components/ConfigCheckReview.tsx) 与不透明 current 快照原样透传，不把仅显示过的片段当完整确认。

安装复验仍需新候选的真实 GLM 菜单与同一 Codex 恢复对话。标签和说明改正不等于 GLM 登录/Key 交付成功，也不等于 Codex 冷恢复保持了原模型。

## 最终源码独立审查（2026-10-01 04:32 +08:00）

**未发现本片冻结差异的阻断问题，可进入提交和安装复验。**此次逐项读取 6 个生产文件、2 个测试文件及相关调用上下文；没有改源码、运行测试、启动应用/Agent 或读写正式数据。此前设计审查的两个具体反例均已在最终实现中关闭。

最终身份以 [frontend-checks.json](frontend-checks.json) 为准，该清单 SHA-256 为 `76f2a58b4a8034fe539c502458a5b33b2c75b31b27a13b7065df6e13fc62cc11`。独立重算全部 8 个文件的完整 SHA-256 和行数，与清单逐项一致。生产最大文件为 `ThreadView.tsx` 901 行，认证组件 630 行；范围未包含 Rust、会话存储、认证执行或配置守卫。

- [auth_method.ts](../../../src/runtime/auth_method.ts)仅用公开名称、类型、purpose、ID 构成标签。仅在同名时增加说明；同名同类附 ID，排序不参与身份。`AgentAuthSection` 的唯一行为差异是 option 显示函数；value、选择查找、当前目标/来源守卫和动作对象不变。环境变量与未知方式仍只读，未退回普通登录或自动配置 API。
- [ThreadView.tsx](../../../src/components/ThreadView.tsx)沿现有 `identity`、`resumed`、`modelDrift`、`configCheck.status` 判断显示。未检查状态的缺模型选项及 null 当前值均显示“未提供”；不引用未验证的 `recordedModel`。当前模型仍来自返回选项，原值差异只来自检查结果；正常 ready 历史、新稿、失败/待确认/保存失败及旧无检查状态使用不同说明。没有新增 setter、确认、发送或数据迁移。
- [config_check.ts](../../../src/runtime/config_check.ts)按每个 issue 的 ID 查名，同名时附该 ID，并保留各自 expected/current；没有按类别首项合并或猜测原值。完整 current 快照及既有确认流程未改。
- [认证组件回归](../../../src/components/AgentAuthSection.declarations.test.tsx)实际选择同名环境项与 Agent 项，证明前者无自动动作，后者仅明确点击后使用原 ID；同类调序保留选择。既有目录/来源切换、迟到响应与不可执行声明回归仍在。测试使用受控账号动作，不证明真实认证成功。
- [对话组件回归](../../../src/components/ThreadView.selection-labels.test.tsx)检查真实 `ThreadView` 传给弹层的子树，包括模型 `dd` 行；覆盖缺项/缺值、同名多项、ready/blocked/confirmation_required/record_failed/旧无检查状态与新稿，并核实渲染不设置、确认、发送，原来源和选择对象保持。它不替代实际弹层打开后的视觉检查。

已核对作者 [最终定向日志](frontend-final-green.log)为 10 文件、56 例通过；[缺值模型行红测](frontend-missing-row-red.log)保留 1 失败/7 通过，不把较早断言过宽的全绿记录当红测。根任务的[全量收据](checks-frontend-full.json)和[测试日志](frontend-full-1.log)记录 133 文件、1,132 例通过，typecheck/build 均退出 0；本审查没有重跑这些命令。[后端复用收据](backend-checks-reused.json)记录 114 个输入不变，沿上一候选 439 通过/3 忽略结果，本片没有宣称新跑 Rust 全量。

剩余验证是新安装候选上 GLM 菜单的实际可辨性、选环境说明仍不可执行、原 Codex 漂移弹层的当前值/原值说明及发送保护。长标签布局、真实登录、真实模型恢复结果不由本次源码/组件审查保证；原漂移失败结论保持。
