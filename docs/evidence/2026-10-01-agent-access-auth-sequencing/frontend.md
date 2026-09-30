# 准备稿收尾与账号动作的前端顺序

本片修复安装观察中首点登录与空模型准备稿关闭相撞的路径。前序正式候选第一次 Kilo 登录被后台工作保护拒绝；准备稿已关闭后的第二次点击实际启动注册程序的登录入口并正常取消，见[第二次目标记录](../2026-09-30-agent-access-auth-target/kilo-target-second.json)。本页是源码及受控回归证据，本片正式安装复验由根任务另行记录。

## 实现边界

- [AgentAuthSection](../../../src/components/AgentAuthSection.tsx) 不再在建立操作所有者前发出未等待的准备失效；[auth_actions](../../../src/runtime/auth_actions.ts) 先建立原目录操作，再统一等待 `AgentPreparation.prepareForAccount`。协议登录、终端登录、手动终端、退出登录、官方服务配置和显式重查使用同一收尾入口。
- [agent_preparation](../../../src/runtime/agent_preparation.ts) 只严格关闭同 Agent、同目录、已有设置来源的空准备稿。正在读取的准备稿保留原所有者，等待真实读取返回后再关闭；关闭失败保留原线程和目标以便显式重试。其他目录、API 来源以及已有对话不被此动作删除；真实未完成或结果未知的工作继续阻止操作。后台保护没有放宽。
- [session_draft_cleanup](../../../src/runtime/session_draft_cleanup.ts) 将严格收尾与原普通清理区分。严格收尾收到 `session_close` 成功前不删内存线程，错误统一为安全提示。严格请求携带后端窄参数 `allowAlreadyClosed: true`，只有后端确认关闭后才可幂等重试，不按错误文本判断。`session_dismiss` 仍为历史隐藏的尽力写入，其失败不否定已确认关闭，也不声称隐藏已持久化成功。[sessions](../../../src/runtime/sessions.ts) 复用该模块并保留原普通清理语义。
- [AuthActivity](../../../src/runtime/auth_activity.ts) 在现有操作内记录显式取消意图；取消通知失败导致界面变为未知，也不能重新获得尚未开始操作的启动资格。已发出的请求若后来实际成功，原有按真实结果处理的语义保留。
- 配置动作仍设置同一显式模型读取标记；较早的模型读取不能清掉新标记。[AgentSetup](../../../src/components/AgentSetup.tsx) 在账号动作期间不把迟到的模型选项写回原选择。未改变程序、模型、推理、服务来源或原稿，不自动发送测试或普通消息。

## 定向验证

新增 [auth_actions.sequencing.test.ts](../../../src/runtime/auth_actions.sequencing.test.ts) 使用真实 `threads`、`AgentPreparation`、`AuthActivity`，仅替换 IPC。受控延迟的关闭确认覆盖：所有账号动作关闭确认前不启动、关闭失败后显式重试、早取消、取消 IPC 失败后的协议登录与退出登录、未确认请求、读取进行中、手动设置失效、配置显式读取标记、其他目录/API 保留、新工作出现时保留线程、历史隐藏失败不误卡。`AgentSetup.selection.test.tsx` 补账号动作期间迟到选项不回写。

- [最初红测](logs/frontend-red.log)：9 项失败，复现未等待关闭、吞错后启动及准备所有权丢失。
- [边界红测](logs/frontend-boundaries-red.log)：6 失败、7 通过；其中手动设置使进行中读取失去严格关闭所有者，另 5 项锁定严格关闭参数。
- [取消红测](logs/frontend-cancel-red.log)：2 失败、15 通过；取消通知失败后实际仍派发登录/退出登录。
- [最终关联回归](logs/frontend-final.log)：14 文件、154 项通过。
- [原清理、审批及终端保留回归](logs/frontend-preservation.log)：4 文件、66 项通过。
- [类型检查](logs/typecheck-final.log)：退出 0。定向格式与 `git diff --check` 通过；根任务尚未在本页记录完整检查及安装复验。
- 根任务独立复读当前前端差异，未发现新增确定缺陷；其提出的取消失败反例已纳入上述真实红绿回归。前端源码冻结，后续改动须重新通知并做相称验证。

本次共改 8 个前端生产文件及 2 个测试文件：`AgentAuthSection.tsx` 553 行、`AgentSetup.tsx` 1473 行、`agent_preparation.ts` 628 行、`auth_actions.ts` 153 行、`auth_activity.ts` 227 行、`auth_strings.ts` 29 行、`sessions.ts` 1477 行、新增 `session_draft_cleanup.ts` 59 行；测试分别 463、371 行。没有运行真实 Agent、登录、正式应用或修改外部配置。后端取消、关闭确认及允许已关闭重试的真实实现由后端同片证据和最终安装验证说明。
