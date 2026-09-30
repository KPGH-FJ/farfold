# 协议错误分类与终端记录：独立审查

2026-10-01。本次只读源码、受控测试和检查收据；没有修改生产/测试，没有运行测试、Cargo、正式应用或外部 Agent，也没有读取凭据、私有配置、协议正文或 stderr。

## 已完成：终端记录入口

冻结前端仅改 [AgentAuthSection.tsx](../../../src/components/AgentAuthSection.tsx)、[auth_strings.ts](../../../src/runtime/auth_strings.ts)及对应 [组件测试](../../../src/components/AgentAuthSection.configuration.test.tsx)，范围与[前端说明](../2026-10-01-agent-terminal-records/frontend.md)、[冻结摘要](../2026-10-01-agent-terminal-records/source-final.json)一致。结论：**未发现前端阻断。**

收起且有 terminalOutcome 时显示“查看终端记录”；无结果仍沿用进行中登录/配置入口。按钮仍只切换 setHidden，展开同一 BufferedLoginTerminal；InlineTerminal 挂载订阅已有输出，不调用 start。没有修改账号路线、取消、重查、凭据或终端所有者。

以 terminalOutcome 而非 authActive 判断合理：进程已经结束而连接仍在 checking 时，展示的是旧记录；关闭尚未确认、没有终端结果时不称已结束。新增 12 例使用真实 AuthActivity/Buffered 所有者和受控回调，覆盖退出 0/1/130、普通取消、启动取消/失败、关闭未知与两个用途；核对同一对象/输出/结果、start 一次及无新增认证/配置/重查。组件渲染用例未启动系统子进程，也不替代正式安装版显示验收。

已读[前端定向收据](../2026-10-01-agent-terminal-records/focused-green.json)及[类型检查](../2026-10-01-agent-terminal-records/typecheck.json)：4 文件 41 例通过、类型检查退出 0。未重复执行这些检查。根任务的[完整前端收据](checks-frontend-full.json)另外记录全量结果，不把交叉覆盖的计数相加。

## 已完成：协议错误分类

Rust 作者已在 `2026-10-01 06:42:16+08:00` 冻结[7 个文件](source-final.json)，声明与已审定向绿输入一致，3 个生产文件及 4 个测试文件均少于 1,500 行。独立审查已读最终差异、受控反例与退出收据，结论：**未发现后端阻断。**没有重复运行命令或将 WIP 计为最终通过。

[process.rs](../../../src-tauri/src/acp_client/process.rs)仅在现有出站观察闭包中，向旧 v1 普通记录附加固定分类；协议转发继续返回 Ok。没有增加请求/响应处理、能力声明、进程、等待、磁盘操作或身份存储。

[startup_diagnostics.rs](../../../src-tauri/src/acp_client/startup_diagnostics.rs)从 typed Response::Error 读取 ErrorCode 和 RequestId::Null，码值只映射到六个固定文字，其余归 other；不读取或保存 message/data/方法/ID 值。只用 try_lock 读取同一连接已有接受标志，争用或锁损坏时整组三字段省略。beforeInitializeAccepted 只表示观察时尚未接受握手，不指认请求接收阶段、处理器或根因，也不改既有超时/取消结论。

[tap.rs](../../../src-tauri/src/acp_client/tap.rs)仅对 out/response/protocol 且三个新字段齐全、枚举/布尔严格有效时重新构造它们。部分、未知、类型错误或错误方向的组全部丢弃，合格旧六字段仍可读；任意对象字段不能原样通过。旧 v1 与 v2 启动摘要保持，新组仍走原普通队列/文件预算，不得到摘要保留优先级；没有记录不能排除发生过错误。

## 后端反例与验证边界

已读[首轮红](backend-red.json)及[纠正预览期望后的独立红](backend-preview-red-corrected.json)。四项真实 SDK 子进程分别在 malformed 非 JSON、无效请求、未知方法/null ID、未知方法/非 null ID 时得到真实协议错误，但旧记录缺少分类。预览最初另有旧字段顺序的期望问题，纠正后再次退出 101 证明新字段确被剥掉；未把顺序误断言当行为缺陷。

[最终定向收据](backend-green-focused.json)和[日志](backend-green-focused.log)为 12 例通过：四个实际受控 SDK/manager 子进程、有限分类与自定义码剥除、非错误消息无新组、观察时点与 Timeout/Cleanup 保持、锁争用/损坏不等待或制造布尔、validator 正反例、真实预览/ZIP 白名单贯通。秘密 canary、任意方法名、字符串 ID、错误正文和自定义数字码均不出记录。fixture 使用本任务自有对端，原登记和候选回收保持；不等于真实 Junie 根因确认。

合法未知方法带 null ID 仍得到 method_not_found，明确证明 null 不能推断 malformed。Timeout 后晚 accepted 只改变观察布尔，不改 Timeout 结果。新的预览测试同时保留旧 v1、新组和 v2；预览之后追加摘要不进入既有 ZIP，导出逐字使用已审阅文本，没有另读新日志。

[相关检查收据](backend-related-green.json)记录 31 例均退出 0，覆盖既有观察/启动、tap 和有界导出；其中与 12 例有交叉，不把 43 次执行称为 43 个独立用例。普通队列和文件满时可能丢记录的既有边界没有扩大成无损承诺。

当前源码与受控检查审查均无阻断。完整工程检查与安装版 Copilot 取消记录、Junie 固定错误类别仍由根任务分列验证；新分类不能从旧记录补推，也不能把某个错误类别直接解释成账号、模型、Java 或具体处理分支。
