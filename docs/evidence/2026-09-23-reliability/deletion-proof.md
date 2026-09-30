# 可靠性改造：旧路径删除证明

基线为 [baseline-identity.json](baseline-identity.json)，采集时间 `2026-09-23T14:18:05.290151+08:00`。核验日期为 2026-09-23，工作区为 `/Users/tw/Desktop/farfold`，当前及基线 HEAD 均为 `eefa4dfaaaf47b2f802d040b96cba82e6d3b807f`。本轮尚未提交，不能把 `git diff HEAD` 的全部内容算作本轮成果。

本文件仅证明当前源码中的文件、符号与调用路径替换，不证明安装版旅程、真实 Agent 行为或性能达标。检查范围是以下命令指定的源码和测试；历史文档与本证明中的旧名称不参与零匹配检查。

## 文件级删除

`src/runtime/permissions.ts` 在基线中存在，SHA-256 为 `2938c8adb8bf371aec6c6c92d19bc78942d0a61958622667dc1cbaf51295795f`。该哈希与基线提交中的同路径内容一致；当前文件不存在。逐一检查基线 `sourceFiles` 清单，当前缺失项仅此文件。没有把先前已删除的阶段 1–5 代码重复计入本轮删除。

```sh
git show eefa4dfaaaf47b2f802d040b96cba82e6d3b807f:src/runtime/permissions.ts | shasum -a 256
test ! -e src/runtime/permissions.ts
```

第一条得到上述哈希；第二条返回 0。

## 精确负向检查

以下命令以仓库根目录为工作目录执行，本次均返回 1，stdout、stderr 均为空。`rg` 的退出码 1 表示零匹配。

审批与表单：旧单例、旧请求类型、仅权限取消事件、旧动作类、错误词条、模块导入与字段专属测试组均无残留。

```sh
rg -n 'pendingElicitation\b|permissionsCancelled|PermissionActions|ElicitationView|approvalFailed' src src-tauri/src
rg -n 'from ["\x27][^"\x27]*permissions["\x27]' src
rg -n 'permission decision timing' src/runtime/sessions.test.ts
```

连接生命周期：分散计数、排队关闭和启动前后进程列表猜测入口无残留。

```sh
rg -n 'open_requests|last_activity|ManagerCommand::Shutdown|spawn_attribution_guard|children_before' src-tauri/src/acp_client src-tauri/src/supervisor.rs
```

配置与目录：通用覆盖写入口、猜测目录版本入口无残留。

```sh
rg -n 'upsert_agent' src-tauri/src
rg -n 'fallback_entry' src-tauri/src/agent_catalog.rs
```

更新检查：旧布尔检查状态与对应 UI 读取无残留。

```sh
rg -n 'checking:\s*(boolean|bool|AtomicBool)|snapshot\??\.checking|checking\.load' src/runtime/managed-update.ts src/components/UpdateDialog.tsx src-tauri/src/managed_update.rs
```

版本探测：Node 的旧阻塞调用及本地发现的后台读线程无残留。这里不声称删除其他用途的 `Command.output()`。

```sh
rg -nU 'Command::new\(node\)[\s\S]{0,200}\.output\(' src-tauri/src/node_runtime.rs
rg -n 'std::thread::spawn|recv_timeout|read_to_end' src-tauri/src/agent_discovery.rs
```

## 替换后的入口

下列路径相对仓库根目录；行号在本次核验时有效。

| 旧路径                                                             | 当前入口与职责                                                                                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permissions.ts` / `PermissionActions`，提前清除表单的独立回复路径 | `src/runtime/interaction_actions.ts:21` 的 `InteractionActions` 共用审批与表单回复，处理 `submitted / retryable / expired / uncertain`，按请求对象判断迟到结果。                                           |
| `pendingElicitation` 单例、`artifacts.ts` 中的表单模型             | `src/runtime/session_types.ts:190` 的 `pendingElicitations: PendingElicitation[]`；`session_projection.ts:563` 的 `applyElicitation` 按请求 ID 归入集合。填写内容随请求保存，`artifacts.ts` 不再负责表单。 |
| `permissionsCancelled` 只清权限                                    | `session_projection.ts:591` 的 `clearPendingRequests` 同时清理审批与表单；`:605` 的 `expirePendingRequest` 只清目标请求；`sessions.ts` 处理 `interactionsCancelled / interactionExpired`。                 |
| 隐藏页面仍可处理审批按键、允许项任意回退                           | `src/App.tsx:246` 传递页面与命令面板共同决定的 `active`；`src/runtime/permission_shortcuts.ts:4` 严格映射选项并排除控件、输入法与重复按键。隐藏 ThreadView 仍可保留视图状态；没有宣称删除该组件。          |
| `open_requests / last_activity` 分散计数与排队 `Shutdown`          | `src-tauri/src/acp_client/lifecycle.rs:22` 的 `ConnectionLife`、`:141` 的 `OperationLease`，以及 `operations.rs:112` 的 `QueuedCommand` 管理操作占用和关闭入口。                                           |
| 启动前后进程列表差异猜测归属                                       | `src-tauri/src/acp_client/process.rs:17` 的 `ProcessControl` 与 `:70` 的 `ProcessTransport` 持有真实进程和清理责任。                                                                                       |
| `MetaStore::upsert_agent` 同时承担新增、替换与凭据修改             | `src-tauri/src/meta_store.rs:142` 的 `insert_agent`、`:148` 的 `insert_custom_agent`、`:163` 的 `replace_agent_launch`、`:189` 的 `set_agent_env` 分开表达意图。替换清除声明，凭据修改不覆盖启动字段。     |
| `fallback_entry` 猜测可安装版本                                    | `src-tauri/src/agent_catalog.rs:246` 的 `retained_registry` 保留成功取得的目录；`entry_for` 只返回发布目录或保留缓存中的条目。                                                                             |
| 更新检查布尔值与“没有候选即最新”                                   | `src-tauri/src/managed_update.rs:41` 的 `ManagedUpdateCheckStatus` 与 `src/runtime/managed-update.ts:24` 的 `checkStatus` 区分未检查、检查中、可更新、最新和失败。                                         |
| Node 两次无界版本读取、发现阶段独立后台读线程                      | `src-tauri/src/agent_discovery.rs:135` 的 `version_output` 统一限时、限量、非阻塞读取；`:119` 的 `VersionChild` 退出时清理自身进程组；`node_runtime.rs` 复用一次版本输出，并在等待共享解析锁时检查取消。   |

零匹配不替代行为验证。审批计时原有有价值行为（普通选择立即提交、记住选择可撤销并延迟提交）保留在 `sessions.regression.test.ts`；删除的是旧字段专属断言组和单例断言，不是行为要求。现有测试文件没有整体删除。

## 先前脏改的归属边界

以下分类根据 `baseline-identity.json.status` 与 `sourceFiles` 的 SHA-256 对比生成。`??` 只表示 Git 未跟踪，不能据此断言为本轮新增。基线没有保存所有脏文件正文，因此重叠文件不能仅靠 `git diff HEAD` 做逐行归属。

### 基线已脏，当前内容仍与基线哈希相同

这些内容不归本轮实现，包括前一轮 Agent 管理、凭据页面与认证观测改动。

- `PRODUCT.md`
- `src-tauri/src/lib.rs`
- `src/components/AgentAccessSettings.tsx`
- `src/components/AgentAuthSection.tsx`
- `src/components/AgentCard.test.tsx`
- `src/components/AgentCard.tsx`
- `src/components/CredentialSettings.tsx`
- `src/components/EmptyState.tsx`
- `src/components/ManualAuthSection.tsx`
- `src/runtime/completion.ts`
- `src/runtime/credentials.ts`
- `src/runtime/ui_error.ts`
- `src/styles-settings.css`
- `src/components/ProgramManager.tsx`
- `src/runtime/authentication.test.ts`
- `src/runtime/authentication.ts`

### 基线已脏，本轮继续修改

只能将本轮的明确替换入口与回归修复计入成果，不能把以下文件的全部 Git 差异归本轮。尤其 `installations.rs` 在基线已经存在且未跟踪，不是本轮创建。

- `src-tauri/src/acp_client/config_guard_tests.rs`
- `src-tauri/src/acp_client/manager.rs`
- `src-tauri/src/acp_client/pump.rs`
- `src-tauri/src/acp_client/regression_tests.rs`
- `src-tauri/src/agent_discovery.rs`
- `src-tauri/src/agent_install.rs`
- `src-tauri/src/credentials.rs`
- `src/App.tsx`
- `src/components/SettingsPage.tsx`
- `src/runtime/agents.ts`
- `src/runtime/sessions.ts`
- `src/runtime/strings.ts`
- `src-tauri/src/installations.rs`

### 基线已脏，但未记录逐文件哈希的文档和证据

这些已有内容的起始脏改不归本轮；本证明不推定其后是否被其他任务更新。

- `.design/README.md`
- `INTERNAL-USE.md`
- `README.md`
- `docs/architecture.md`
- `docs/evidence/2026-09-22-acceptance/fixture-events.jsonl`
- `docs/evidence/2026-09-22-acceptance/fixture-state.json`
- `docs/evidence/2026-09-22-recovery-polish/mcp-lifecycle.jsonl`
- `docs/status.md`
- `plans/runtime-neutral-lifemodel.md`

### 基线已存在的未跟踪目录

以下目录不是本轮新建证据或设计成果；本轮删除证明没有清理它们。

- `.design/2026-09-22-agent-management-v2/`
- `.design/2026-09-22-agent-management/`
- `docs/evidence/2026-09-22-acceptance/project/`
- `docs/evidence/2026-09-22-agent-access-v2/`
- `docs/evidence/2026-09-22-capability-followup/`
- `docs/evidence/2026-09-22-three-way-alignment/`

本次文件证据任务仅创建本文件，未改源码或其他已有文档。
