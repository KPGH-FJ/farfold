# 接入机制本批独立只读审查（2026-09-30）

结论：在下列最终源码与测试范围内，未发现有证据的新增阻断问题。可继续本批安装版验证；这份源码审查不证明真实登录、归档安装、首发或续接已经通过，也不关闭已有 Codex 冷恢复失败。

## 审查范围

读取时 HEAD 为 `a0a55af2d1520be6bb334d674d432d9f959fcac9`，包含本批工作区修改。审查没有修改共享源码/计划、启动真实 Agent、操作正式应用或改变任何用户配置，仅写本记录。

- `src-tauri/src/acp_client/auth_connection.rs`、命令注册及新增 `lifecycle_tests.rs` 三项认证重查回归；同时核对原生命周期、连接管理、认证配置互斥的调用链。
- `src/runtime/auth_actions.ts`、`auth_blockers.ts`、`src/components/AgentAuthSection.tsx` 及相关重查/错误保留测试。
- `src-tauri/src/agent_install/archive.rs`、安装候选调用、`agent_catalog.rs` 的归档过滤及安装入口测试；同时核对既有 `Job::run/check/commit` 的取消与回收职责。
- 接到最终写入完成通知后，复读 `src/components/AgentSetup.tsx`、`AgentSetup.selection.test.tsx` 和 `src/runtime/sessions.auth-recovery.test.ts`；核对原认证状态清除链路。

## 关键边界核对

| 边界               | 核对结果                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原子空闲准入与关闭 | [auth_connection.rs:46](../../../src-tauri/src/acp_client/auth_connection.rs#L46) 复用既有 `account_change` 操作 lease，在同一生命周期锁下拒绝当前工作及未结束操作；随后才关闭，并等待精确进程关闭确认。配置 guard 保持到新握手完成。其他目录、API 与候选连接不进入该替换范围。                                   |
| 检查失败与错误保留 | [AgentAuthSection.tsx:184](../../../src/components/AgentAuthSection.tsx#L184) 保留手动重查异常并返回，避免立即触发方法表重载清除错误；认证 job 的检查错误继续由活动状态保留。后端重查失败不调用 `onChanged`，也不会把 busy 连接伪报已关闭。                                                                       |
| 账号变更与重查范围 | 登录/退出仍保护同一 Agent 的已有设置连接；仅完成后的连接重查按原目录缩小范围。API 检查保留既有服务重连入口，后端新命令拒绝带 API 来源的请求；没有为重查放开账号变更或秘密交付。                                                                                                                                   |
| 归档实际入口       | [agent_catalog.rs:217](../../../src-tauri/src/agent_catalog.rs#L217) 接受 `.tar.bz2`，并在 URL 查询/片段前判断后缀；目录卡片与 `installation_entry` 回归证明支持声明可到达原安装器。该 fixture 不替代真实下载。                                                                                                   |
| 解压与取消作用范围 | [archive.rs:32](../../../src-tauri/src/agent_install/archive.rs#L32) 在候选目录的独占临时目录内调用 bzip2 解码，再走既有 tar 路径边界。bzip2/ditto 复用 `Job::run`，取消/超时由其自有进程组回收；tar 读取前检查取消，解压完成后再检查，最终候选提交还需 `Job::commit` 原子准入。失败/取消不选择候选或改写旧目标。 |
| 登录后模型重读     | [AgentSetup.tsx:500](../../../src/components/AgentSetup.tsx#L500) 仅对显式重读取消 `needsAuth` 前置阻断，保留其他准入和处理器检查；自动读取与返回选择仍受登录要求约束。既有 `threads.open` 成功结果按原来源范围清除要求；新增回归覆盖仍失败、成功、其他目录/API 要求保持，且无 `session_prompt`。                 |

## 验证与限制

本审查读取相关测试及工程检查收据，不另行重复启动全量检查。根任务的 `checks-final-frontend.json` 显示类型检查、前端测试、构建退出 `0`；`checks-final-rust.json` 显示 fmt/clippy/test 退出 `0`。读取时 `checks-final-format-pass.json` 的 format:check 退出 `1`，已通知根任务，须以根任务修正后的最终格式收据为准，不写成全 Checks 已通过。

新增认证作用范围回归使用受控连接夹具；归档回归使用受控归档；模型读取回归使用实际前端状态模块及受控接口返回。上述结果不能代替正式安装版与真实 Agent 的对应旅程。最终源码或相关输入变化后，应按变化重新核对审查与受影响验证。

## 请求层认证修复补充审查

根任务发现 Amp 在首条请求报告认证失败后，仍可成功创建新对话并提供模型选项。本补充复读最终 `authentication.ts`、`sessions.ts`、`AgentSetup.tsx`、`sessions.auth-recovery.test.ts` 和 `AgentSetup.selection.test.tsx`，并核对原 `AgentPreparation.start`、本轮结算与 channel 所属检查；未修改源码，也未再次运行 Agent。

未发现有证据的新增阻断问题：

- `authentication.ts` 复用原 Map 记录 `session/request` 强度；任何会话层成功或认证失败均不降低已有请求层要求。范围继续由原 Agent、目录及服务身份确定。
- `sessions.ts` 仅在本目标收到无错误/失败的 `end_turn` 且本轮确有回复或工具结果时清除请求要求；空结束、认证失败、取消及其他错误不会清除。旧连接的 channel 被当前 channel 相等检查丢弃，本轮结果依据 `roundItemBase`，不借旧历史回复清除要求。
- `AgentSetup` 保留自动读取与“使用此选择”的认证门控，允许用户显式重新读取模型和发起短测；读取处理器还有当前准入检查，`AgentPreparation.start` 保留 draft、未测、空闲、模型保护和可用工作准入。请求失败后可重新准备再显式短测，没有通过自动发消息解除保护。

已读 `auth-request-layer-red.log`：两项回归分别重现模型读取误清要求，以及短测按钮被认证要求永久阻断；`auth-request-layer-green.log` 的对应两文件共 11 项通过。真实前端状态链回归进一步覆盖重复请求失败、成功仅清原目录/服务，以及读取不会自动发请求。根任务新候选的 `../2026-09-30-agent-access-uvx/checks-final-frontend.json` 显示类型、全前端测试和构建退出 `0`；此收据与本补充审查都不替代安装版 Amp 的对应旅程验证。
