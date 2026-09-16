# Farfold 实施与验证记录

这是按阶段保存的事实记录，不是第二份计划。
当前顺序、待办和退出条件以[唯一活动计划](../../plans/runtime-neutral-lifemodel.md)为准。
下列记录从原长计划移动保留，早期结论可能被后续复审修正；不得只凭某条测试通过宣称阶段完成。
今后按日期追加简洁结果、失败原因和证据引用，不复制整段历史。

## 2026-09-11 暂停时快照（历史）

停下时状态：

- 已收住本轮启动的 QA Shared / OpenCode ACP 进程，`pgrep` 未发现固定 OpenCode ACP sidecar 残留。
- 已完成的代码层事实：OpenCode ACP confirmed cancel 的直接 active turn 保留缺陷已有修正和本地测试通过；
  数值 JSON-RPC permission id、真实 permission options、permission generation 校验已有实现和测试证据。
- 尚未完成的验收：clean installed visible cancel 全流程未通过；生成中取消、等待权限取消、快速重复停止、
  取消后同 working copy 下一轮、取消中退出重开仍不能标完成。
- 仅因后续健康度 review 一度触发的额外改动（非 cancel verify 失败返回 unknown、ACP turn 快照防护、
  running 时禁用重复启动 ACP）已停止继续扩展，保留为待审阅变更，不纳入本草案自动批准范围。
- `reports/2026-09-11-code-health-review.md` 是独立问题清单，不是新增实施授权；其问题只在本计划中归位。

## 2026-09-11 A、B 与 C1 执行记录

#### 阶段 A 当前核查结果（2026-09-11）

工作区状态：存在大量 tracked/untracked 改动，包含文档、Host schema/安装/Provider 基础、OpenCode ACP、
Codex 0.143.0 App Server 接入、Pi/工作台拆分、测试与 QA 材料。恢复实施不等于这些改动全部已验收；
不回滚、不提交、不清理，先按下表归属后推进。当前 `pgrep` 未发现固定 OpenCode ACP sidecar 或 QA Shared
残留进程。

| 范围                            | 当前归属                               | 已有证据                                                                                                                                  | 阶段 A 结论                                                                 |
| ------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 文档与入口说明                  | 已按 0A 批准状态更新                   | `AGENTS.md`、`PRODUCT.md`、本规格和 active plan 已同步当前边界                                                                            | 作为当前权威；旧 S0-S5 与旧报告继续作为历史证据                             |
| OpenCode ACP permission/cancel  | 已授权工作区输入，需继续审阅           | 1.18.30 真实 permission surface、numeric JSON-RPC id、permission generation、confirmed cancel 代码层测试；installed visible cancel 未通过 | 可进入 B/C 收口；不能声明安装应用完整通过                                   |
| OpenCode 首路安装/Provider/恢复 | 已有基础实现输入，需按 C1-C5 拆片验收  | system reference/discovery/launch、Provider projection、managed session/load、QA Shared fixture 证据                                      | C 首路必须用真实 Agent + 真实受支持 Provider + 同一候选安装应用集中出口验收 |
| 健康 review 额外改动            | 待审阅变更                             | 非 cancel verify failure unknown、ACP turn 快照防护、running 禁用重复启动 ACP                                                             | 可在 B 的公共 Host/ACP 合同中逐项决定是否保留；不因存在代码即算已批准完成   |
| Pi ACP 候选                     | 前置设计约束，不阻塞无关 OpenCode 工作 | `pi-acp@0.0.33` 可启动本机 Pi，存在 prompt 排队、input/editor、多扩展 UI、steer/follow_up 缺口                                            | D 前必须决定维护补齐或保留未迁移临时状态；不可把原生旧路算 ACP 完成         |
| Codex ACP 候选                  | 前置设计约束，接入顺序第三             | 已接受 Codex 0.143.0 App Server 边界；`codex-acp` main 指向 adapter 1.11.0 / Codex ^0.153.4 组合，兼容未证                                | A 已标为证据缺口；E 只执行已选固定组合，不从 latest 外推                    |
| 文件/Git/diff/终端基础          | 公共 Host/工作台必备                   | 既有 Host turn_changes 与工作台路径审阅基础；公共职责清单定义文件、终端、diff 边界                                                        | B 定合同，C4 首路覆盖；交互 shell、撤销、提交仍为范围外取舍                 |

阶段 A/B 初始检查：

- 文档一致性：`plans/runtime-neutral-lifemodel.md`、`AGENTS.md`、`PRODUCT.md` 和当前规格已同步 0A
  已批准实施状态；`corepack pnpm format:check` 通过。
- B 相关小检查：`cargo test --manifest-path src-tauri/Cargo.toml --locked acp_transport -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked session_controller -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked turn_coordinator -- --nocapture` 通过；前端
  `opencode-conversation`、`opencode-acp`、`native-interaction-reply`、`native-stop-request`、`host-shadow`
  相关测试通过。以上只证明合同层，不证明 installed visible cancel。
- C1 已发现并修正首个入口断点：本机安装登记此前只回传 installation/connection/label，未把已检查的
  `selectedPath` / `canonicalPath` 回填给 OpenCode ACP 程序路径，导致登记本机安装后 managed ACP 新建仍可能不可用。
  现在 `ManagedRuntimeInstallationDialog` 通过共享选择类型回传路径，`OpenCodeWorkspace` 用 canonical path
  填充 ACP binary path。受影响检查 `corepack pnpm typecheck`、`corepack pnpm vitest run
src/runtime/managed-runtime-installation.test.ts src/runtime/opencode-acp.test.ts src/runtime/host-workspace-connection.test.ts`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked runtime_registry -- --nocapture` 通过。
- C1 第二个入口断点已修正：已登记本机安装此前只能展示，不能重新选入当前工作台；重启或重新打开后仍可能要求另选
  ACP 程序。现在已登记项提供“使用此安装”，复用同一选择类型并给出可见反馈。受影响检查
  `corepack pnpm typecheck` 和 `corepack pnpm vitest run src/runtime/managed-runtime-installation.test.ts` 通过。
- B/C1 独立复审后补正（2026-09-11）：上述路径回填只解决前端入口，不能关闭 C1；旧
  `runtime_registry` 仍按 OpenCode Server 1.15.13 检查安装，而 OpenCode ACP 启动只接受固定 1.18.30。
  当前已把 OpenCode 安装弹窗切到独立 `opencode_acp` 管理键，固定 `opencode-acp-stdio-v1` adapter、
  1.18.30 版本和已固定摘要；保存列表按 adapter / version 过滤，旧 Server 记录不能被 ACP 复用。
  B 的 Host routed event 绑定也已加入 `runtimeGeneration`，OpenCode ACP 事件进入 reducer 前要求当前
  ACP status generation 与事件 generation 同时匹配，避免同 native Session 重连后的旧 ACP 事件污染当前状态。
  当前证据：`corepack pnpm typecheck`、`corepack pnpm test`、`corepack pnpm build`、
  `corepack pnpm format:check`、`git diff --check`、`cargo fmt --check --manifest-path src-tauri/Cargo.toml`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked` 全部通过。此结论仍是源码 / 自动化层；
  installed visible cancel 和同一候选安装应用真实 OpenCode ACP 流程尚未因此关闭。
- C1 主入口断点补正（2026-09-11）：独立复审指出普通工作台“选择本机 ACP 安装 → 选择项目 / 新建”
  仍把 ACP 保存记录传给 `createHostSession(runtimeProductId=opencode)`，而 Host 仍按 OpenCode Server
  1.15.13 校验，必然拒绝新选 ACP 记录；同时 ACP unmanaged start 会重新按路径推导另一套
  `system-opencode-acp` 身份，导致安装记录与实际 Session 绑定缺少可验证关联。当前已让前端普通新建输入保留
  所选 adapter，Host `host_session_create` 按 adapter 分派 `ManagedRuntimeKey::OpencodeAcp`，并通过
  `opencode_acp::create_registered_host_session` 使用 registry 校验出的同一 binding / path 启动 ACP 与注册
  Host Session；Server 仍保留原 1.15.13 校验，不放宽为接受 ACP。前端新建返回后也已按实际
  `adapterId` 分支：ACP Session 读取 `opencode_acp_experiment_status` 并设置当前 ACP binding / session，
  不再无条件调用旧 Server status、Provider snapshot 或 server history。ACP Session 注册时若同一
  registry installation 已有有效 inspection 记录，不再覆盖成 ACP 专用 launch record；只有明确没有保存记录
  时才允许首次写入 legacy launch，已存在但格式、摘要、路径或数据库核验失败时保留原记录并报错。恢复校验识别
  inspection / legacy launch 两种格式，但以传入 binding 为准，不再按路径重新派生 `system-opencode-acp`
  身份；legacy launch 仅服务现有实验路径，后续随实验入口删除，不作为永久并行事实源。B 侧新增 workspace
  实际消费路径的 `opencode-event-gate` 测试，覆盖旧 ACP generation 拒绝、当前 generation 接受；C1
  前端新增 `opencode-session-binding` 测试，覆盖 ACP 新建返回后进入 ACP activation 分支。当前检查：
  `corepack pnpm typecheck`、`corepack pnpm vitest run
src/runtime/opencode-session-binding.test.ts src/runtime/opencode-event-gate.test.ts
src/runtime/host-session-controller.test.ts src/runtime/managed-runtime-installation.test.ts`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked session_controller -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked runtime_registry -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture`、
  `corepack pnpm build`、`corepack pnpm format:check`、`git diff --check`、
  `cargo fmt --check --manifest-path src-tauri/Cargo.toml`、`cargo clippy --manifest-path src-tauri/Cargo.toml
--locked -- -D warnings` 通过。固定程序 `/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode`
  摘要为 `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`；使用该路径显式运行
  `fixed_opencode_acp_program_can_initialize_create_load_and_close_without_model_turn` 通过，覆盖真实程序
  initialize / session/new / session/load / close 的无模型冒烟；`fixed_opencode_acp_registry_record_survives_session_registration_and_restore`
  通过，覆盖真实程序文件和本地数据库的 registry inspection 保留，不等同冷恢复链路；新增
  `fixed_opencode_acp_host_create_open_and_reuse_registry_installation_without_model_turn` 通过，覆盖登记
  → Host create → stop → open same native session → 再列出并复用同一安装新建，未发送 prompt 或调用真实模型。
- C1 本机缺失按需安装补正（2026-09-11）：OpenCode ACP 安装弹窗新增“安装到 Farfold 管理目录”，调用 Host
  `managed_runtime_installation_install(opencode_acp)`；同时新增 Host 安装状态 / 取消命令，同一 Runtime 安装有互斥占用，
  重复启动不会并发写入同一 destination，关闭弹窗不冒充取消，只有显式“取消安装”会标记 cancelling 并终止当前
  `curl` 下载。后端仅支持固定
  `https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-darwin-arm64.zip`，下载使用
  128 MiB 归档上限、超时和有界错误信息，解包目标 `opencode` 使用 256 MiB 可执行文件上限。安装先在
  app data 的临时目录解包和校验，再以同一父目录原子 rename 提交到
  `managed-runtimes/opencode/opencode-acp-stdio-v1/1.18.30-2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62/opencode`，
  并按同一 registry inspection 登记。已有有效 managed 安装直接复用；已有损坏 / 不兼容的 Farfold managed 目标可由安装流程
  修复，登记失败时删除本次新提交文件并尽力恢复旧损坏文件；这不是声明文件系统与数据库是单一原子事务。用户外部程序不覆盖。
  用固定缓存二进制
  `/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode` 临时打包后运行
  `fixed_opencode_acp_archive_install_registers_managed_runtime` 通过，覆盖“缺失 → 解包安装到 Farfold 管理目录 →
  固定 hash 校验 → registry 登记”的有限无模型场景；`fixed_opencode_acp_registration_failure_removes_new_install_file`
  通过，覆盖登记失败后移除本次提交文件；`fixed_opencode_acp_repair_replaces_only_damaged_managed_install` 通过，
  覆盖损坏 Farfold managed 目标修复；`runtime_installation_operations_are_mutexed_and_cancellable` 覆盖 Host
  安装互斥和 cancelling 状态，`cancelled_runtime_installation_download_exits_before_file_creation` 覆盖已取消安装在下载前退出且不创建归档。
  2026-09-11 运行产品下载函数级 `official_opencode_acp_archive_download_matches_fixed_digest` 通过，确认固定 GitHub
  归档经同一下载入口下载和解包后，内部 `opencode` 的 SHA-256 等于固定摘要
  `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`；此前临时重打包缓存测试不再作为真实下载链路证明。
  当前还未通过 installed UI 点击真实下载 / 显式取消、兼容失败修复可见流、真实 Provider 任务和同一候选安装应用出口验收；C1
  仍不得关闭。
- C1 安装失败保护复审修订（2026-09-11）：`accept_inspected_runtime` 已拆成二进制 inspection 与 registry 登记两层；
  已有 Farfold managed 目标先检查真实程序，只有版本 / 摘要 / 可执行性不兼容才进入修复，若程序有效但登记失败则保留原文件并返回准确错误，
  不把登记失败误判为需要重装。修复旧损坏文件时，旧文件备份放在安装目录，不再放入会自动删除的临时目录；staged → destination
  提交失败会恢复旧文件，登记失败会删除本次提交并报告恢复状态，恢复失败会显式报错而不是宣称 rolled back。新增并通过
  `fixed_opencode_acp_valid_existing_install_is_preserved_when_registry_update_fails`、`managed_runtime_commit_failure_restores_existing_destination`
  和 `cancelled_runtime_installation_releases_slot_for_retry`；同时重跑通过
  `fixed_opencode_acp_archive_install_registers_managed_runtime`、`fixed_opencode_acp_registration_failure_removes_new_install_file`、
  `fixed_opencode_acp_repair_replaces_only_damaged_managed_install`。C1 简短入口 / 连接冒烟重跑通过
  `corepack pnpm vitest run src/runtime/managed-runtime-installation.test.ts src/runtime/opencode-session-binding.test.ts
src/runtime/host-session-controller.test.ts src/runtime/opencode-event-gate.test.ts` 和真实固定程序
  `fixed_opencode_acp_host_create_open_and_reuse_registry_installation_without_model_turn`，覆盖普通入口绑定、缺失安装成功、兼容失败检查、
  关闭后恢复同一 native session、取消释放后重试。仍未做 installed UI 真实点击下载 / 取消 / 修复可见流，也未做真实 Provider 任务；
  这些不反向阻塞 C1 中间实现，但 C1 进入 C2 前需协调复审当前证据。
- C1 有限切片已协调接受后进入 C2（2026-09-11）：本轮只处理 OpenCode Provider 与任务绑定的首个缺口，不扩大到 C3
  交互、installed UI 或真实模型出口验收。既有后端已能通过 ACP managed session 的私有启动配置把保存的 Farfold managed
  Provider 写入 OpenCode 受隔离配置，并由 native `configOptions` 确认后记录 `apply_state=applied`、`request_state=not_requested`；
  任务提交时 Host 从活动 ACP Runtime Session 读取 managed Provider 身份并绑定 Host Turn，因此配置修改后的旧会话仍绑定旧版本。
  本次补强 stale receipt 防护：`host_opencode_acp_turn_submit` 若收到前端 Provider 回执，会要求它与当前活动 managed Runtime Session
  完全一致；不一致或当前不是 managed ACP Session 时直接拒绝，避免过期页面状态让用户误以为任务按新 Provider 提交。对应测试把旧的
  “伪造回执被忽略”改为“伪造 / 过期回执被拒绝，随后无前端回执提交仍按活动会话绑定旧版本”。随后补齐前端衔接：
  ACP 任务提交参数只从 `acpStatus.managedProvider` 产生，native unmanaged ACP 配置只记录展示投影、不再向后端发送 Provider
  回执；如果用户在当前 managed ACP 会话打开后保存了同一 Provider 的新版本，composer 仍允许该会话继续按启动时旧版本提交，
  新版本只通过停止后“新建 ACP 会话”生效。设置面板中 ACP 的“保存 / 应用”文案也已改为该边界，不再把当前会话误报为待热应用。
  当前检查：
  `cargo fmt --check --manifest-path src-tauri/Cargo.toml`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked host_store::provider_projection -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked turn_coordinator -- --nocapture`、
  `corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/provider-projection.test.ts src/runtime/opencode-acp.test.ts src/runtime/opencode-session-binding.test.ts`、
  以及固定真实 OpenCode ACP 二进制路径
  `/tmp/farfold-opencode-acp-1.18.30.aOjMgQ/opencode-darwin-arm64/bin/opencode` 下的
  `fixed_shared_saved_connection_drives_pi_bridge_and_opencode_acp_without_reentering_key`
  通过。该结论仍停留在源码 / 自动化层；真实 Provider 请求只在固定 fixture 中证明可用，正式 installed app 真实模型任务与请求验证状态仍未关闭。
- C2 有限配置衔接已协调接受后进入 C3（2026-09-11）：本轮先核对 OpenCode ACP 任务与原生交互的既有实现，确认已有
  prompt、event pump、tool/plan projection、`session/request_permission`、一次性 permission reply、`session/cancel`、
  confirmed cancelled 释放 Turn、断线 unknown 不自动重发等源码 / fixture 层证据。补读固定 1.18.30 官方源码和 ACP
  elicitation 协议后，将“通用结构化原生提问”记录为当前固定组合的能力协商缺口：OpenCode 1.18.30 初始化能力未声明
  elicitation，Farfold 当前也未发送 `clientCapabilities.elicitation`。继续追踪固定源码可见 OpenCode 本体存在
  `Question.Service`、`plan_exit` 调用、HTTP `question.list/reply/reject` 和原生 app question dock；但 ACP agent/service 只桥接
  `requestPermission`，未导出 question/elicitation。因此本条是“固定 ACP 组合未保留 OpenCode 原生 question 能力”的缺口，不是断言 OpenCode
  产品本体没有任何提问能力，也不允许用普通 prompt 冒充原生提问。
  已修正工作台的权限同步断点：Host shadow 更新时不再无条件清空本地 `conversation.permissions`，而是按 Host
  `pendingInteractions` 中当前 Runtime binding、native Session、generation 且仍为 `pending` 或 `responding` 的 OpenCode
  permission 精确保留；旧代次、其他会话或 closed / stale 的权限卡会从当前 UI 消失。该规则防止 Host 快照先进入 responding 后本地卡片被误删、回复失败回到
  pending 时无法重试。新增 `openCodePendingPermissionIds` 合同测试覆盖当前 pending / responding 保留、旧代次 / 其他会话剔除。当前检查：
  `corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/opencode-session-binding.test.ts src/runtime/opencode-conversation.test.ts src/runtime/host-shadow.test.ts src/runtime/native-interaction-reply.test.ts src/runtime/opencode-acp.test.ts`
  通过。后端新增 `host_acp_abort_cancels_pending_permission_and_allows_next_turn`，覆盖运行中存在 pending permission 时用户停止会先按 ACP
  `cancel_pending_permissions` 回复 `cancelled`，再发送原生 `session/cancel`，首轮收到 confirmed `cancelled` 后释放 Turn，随后同一
  native Session 可接受下一轮提交；新增 `acp_permission_reject_uses_the_native_option_id` 覆盖拒绝分支仍回传原生 optionId。补充固定真实
  OpenCode 1.18.30 二进制短流程 `fixed_opencode_acp_real_permission_wait_can_cancel_and_continue` 通过：本地 OpenAI-compatible fixture
  先被 OpenCode 用于标题请求，再对真实用户 prompt 返回 `bash` tool call；真实 OpenCode 上报 `session/request_permission`，原始 option
  为 `once/always/reject`，Host shadow 记录 pending permission；Farfold abort 取消该 pending permission 后，同一 native Session 可接受下一轮
  prompt。该证据覆盖固定程序 + fixture Provider 的 permission wait / cancel / continue，不等同于真实 Provider 或 installed UI 出口验收。复跑固定真实
  OpenCode 二进制用例发现二次 managed session 新建时仅复用 installation、未补登记新 Provider config 对应 runtime connection，导致 Host
  session 外键失败；已在 `register_acp_runtime_and_session` 中补登记当前 binding 的 runtime connection，随后
  `fixed_opencode_acp_managed_session_stops_cold_restores_old_version_and_new_uses_current` 通过。共享 Pi/OpenCode fixed 用例在并行运行、以及紧跟
  managed fixed 用例后运行时均曾出现 Pi fixture 连接失败；单独重跑
  `fixed_shared_saved_connection_drives_pi_bridge_and_opencode_acp_without_reentering_key` 通过。因此该项记录为固定 fixture / sidecar 连续运行失败，原因未知且产品因素未排除；
  不作为连续串跑稳定通过，也不作为产品路径已失败或已修复的结论。该用例与 `opencode_acp`、`turn_coordinator` 后端组通过。补充检查：
  `cargo fmt --check --manifest-path src-tauri/Cargo.toml`、`corepack pnpm format:check`、`git diff --check`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings` 通过。C3 仍需继续核对真实固定程序下权限请求/取消和
  installed app 可见流程；本条不是 C3 完整完成或 C 阶段出口验收。
- C4 不依赖 question 的文件 / Git / 工作台审阅切片启动（2026-09-11）：活动计划已更新为“C3 提问能力待架构取舍；C4
  不依赖提问协议的文件、Git 与工作台审阅切片实施中”，保留 C3 提问、表单、问题恢复/取消与 installed app / 真实 Provider 出口门槛。
  本轮复用既有 `turn_changes` Host 表、Turn admission/terminal capture、侧栏未审阅计数、`TurnChangesSection` 和
  `host_reveal_project_file`，未新增提交/撤销/交互 shell 或 OpenCode 专属文件服务。后端 `TurnChangeReview` 快照新增每条路径的
  `fileState` 与整个 review 的 `currentPathState`：路径状态区分 text、binary、large、deleted、missing、not_regular、
  outside_working_copy、unknown；当前状态用记录路径集合重新对比基线，提示是否已在 Turn 终止后发生路径集合变化。该对比不证明同一路径内容未被外部再次编辑，
  因此 UI 只称路径集合，不把磁盘变化归因给 Agent。前端审阅面板标题明确为“磁盘 / Git 事实”，同时保留 Agent 工具报告在消息流中的原生工具卡片；
  新增文件状态标签和基于 Host 身份校验的 Finder 定位按钮；已删除、缺失、非普通文件、越界和未知状态不提供定位操作。新增
  `review_classifies_non_text_paths_and_late_path_changes` 覆盖二进制、大文件、删除、越界 symlink 和 Turn 后新增路径导致 `changed_after_turn`。当前检查：
  `cargo fmt --check --manifest-path src-tauri/Cargo.toml`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked turn_changes -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked turn_coordinator -- --nocapture`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、`corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/turn-changes.test.ts src/runtime/message-link.test.ts src/components/MessageContent.test.tsx`
  和 `corepack pnpm format:check` 通过。该有限 C4 子项已覆盖 Host 审阅快照与工作台可见性；仍未做真实 Provider、installed app
  或提交/撤销/交互 shell，也不解除 C3 question 阻塞。
- C4 文件内容预览补充（2026-09-11）：在同一 `turn_changes` Host 通道新增 `turn_change_file_preview`，只接受当前
  Farfold Session、已记录 Turn、已记录相对路径；路径仍经 `safe_relative_path`，解析后必须留在该 Working Copy 内。预览来源固定标为
  `current_disk`，并随返回值带 `baselineHeadOid`、`terminalHeadOid`、`currentPathState`、字节数、截断状态和说明；UI 显示“当前磁盘”、
  “基线 → 终止”和路径集合状态，不把当前文件正文称为 Turn 终止快照。文本预览最多读取 64 KiB；分类读取最多 1 MiB + 1 字节，
  修正原先 metadata-before-read 后可能整文件读取的竞态。二进制、大文件、删除、缺失、非普通文件、越界和未知状态不内联展示内容。
  前端把“预览当前磁盘内容”和“在访达中显示”拆成两个按钮，并把“标记已审阅”改为“标记记录已审阅”，避免把 locate 或当前内容查看误称为
  review 完成。新增 `file_preview_reads_current_text_only_for_recorded_turn_paths` 覆盖未跟踪文本预览、长文本截断、越界 symlink 拒绝和
  `../` 路径拒绝；补充 `turn_change_file_preview` invoke 合同测试。当前检查：
  `cargo test --manifest-path src-tauri/Cargo.toml --locked turn_changes -- --nocapture`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、`corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/turn-changes.test.ts src/runtime/message-link.test.ts src/components/MessageContent.test.tsx`、
  `corepack pnpm format:check`、`cargo fmt --check --manifest-path src-tauri/Cargo.toml` 和 `git diff --check` 通过。本条仍不是
  C4 完成：artifact/result 入口、终端输出/资源 ownership 清理、短流程 UI 验证、真实 Provider 与 installed app 验收仍未完成。
- C4 artifact/result 打开入口补充（2026-09-11）：在现有公共 `project_file_reference` 服务上新增 `host_open_project_file`，
  复用 `result_file` 的 Session/native identity、Working Copy membership、普通文件和 `:line` 后缀解析边界；不新增 OpenCode 专属文件服务。
  消息正文中的本地结果链接从单一“在访达中显示”调整为“打开”和“定位”两个动作；两者都经 Host 校验，不生成 webview 本地 `href`。
  `MessageContent` 静态测试已更新为检查两个动作，`message-link` 测试补充 `host_open_project_file` 调用合同；后端既有
  `project_file_reference` 路径解析测试覆盖缺失、越界 symlink、目录和非法路径。当前补充检查：
  `cargo test --manifest-path src-tauri/Cargo.toml --locked project_file_reference -- --nocapture`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、`corepack pnpm typecheck` 和
  `corepack pnpm vitest run src/runtime/message-link.test.ts src/components/MessageContent.test.tsx src/runtime/turn-changes.test.ts`
  通过。仍未完成终端输出/资源 ownership 清理、短流程 UI 验证、真实 Provider 与 installed app 验收。
- C4 终端/工具输出展示上限补充（2026-09-11）：在 Pi/OpenCode 共用的 `PiActivity` 工作台活动组件中新增
  `toolDetailText`，展开的工具/终端输出只显示前 12,000 个字符，并在 UI 文本中说明完整输出仍属于 Runtime 原生记录；不截断
  Runtime 数据、不改 Agent 工具语义，也不新增交互 shell。新增 `bounds expanded terminal and tool output in the shared workbench` 测试。
  当前补充检查：`corepack pnpm vitest run src/components/PiActivity.test.ts src/runtime/message-link.test.ts src/components/MessageContent.test.tsx src/runtime/turn-changes.test.ts`、
  `corepack pnpm typecheck`、`corepack pnpm format:check` 和 `git diff --check` 通过。资源 ownership 的深层清理仍需后续复核；installed app
  与真实 Provider 验收仍未完成。
- C4 基线到当前磁盘 diff 与 UTF-8 截断修正（2026-09-11）：新增 `turn_change_path_diff_preview`，仍限定当前
  Farfold Session、已记录 Turn、已记录相对路径。tracked / deleted 路径用 Git 从记录的 `baselineHeadOid` 比较当前磁盘；untracked
  文本用当前磁盘内容生成只读新增 diff；返回来源固定标为 `current_disk_against_baseline`，并显示记录基线、记录终止 HEAD 与
  `currentPathState`。若路径集合已在 Turn 后变化，UI 明确提示该 diff 可能包含后续编辑；不把当前 diff 冒充终止快照或 Agent
  归因。二进制、大文件、越界、缺失等不内联展示 diff。另修正 `file_preview_for_turn` 和 untracked diff 的 UTF-8
  边界：当有界字节截断落在中文/emoji 等多字节字符中间时，只丢弃尾部不完整字符并保留 `truncated` 提示；内部非法 UTF-8
  仍不当文本展示。新增 `file_preview_keeps_truncated_utf8_text_when_cut_inside_a_character`、
  `diff_preview_compares_baseline_to_current_disk_for_tracked_and_untracked_text` 和
  `diff_preview_keeps_truncated_utf8_untracked_text`。当前检查：
  `cargo test --manifest-path src-tauri/Cargo.toml --locked turn_changes -- --nocapture`、`cargo fmt --check --manifest-path src-tauri/Cargo.toml`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、`corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/turn-changes.test.ts` 和 `corepack pnpm format:check` 通过。仍未完成资源 ownership 深层清理复核、
  短流程 UI 验证、真实 Provider 与 installed app 验收。
- C4/C5 Host workspace channel ownership 补正（2026-09-11）：`HostWorkspaceConnection.start()` 现在在已有
  handle 或 start in-flight 时拒绝重复启动，避免同一工作台因重复 start 创建第二条 Host shadow channel、晚到 handle 覆盖或泄漏。
  既有卸载时晚到连接 stop、QA 重连失败恢复/unavailable、卸载中 replay 不重启等测试保留；新增
  `keeps a single owner when start is called while a channel is opening` 覆盖并发 start 和已有 handle 重入。当前检查：
  `corepack pnpm vitest run src/runtime/host-workspace-connection.test.ts src/components/PiActivity.test.ts src/runtime/message-link.test.ts src/components/MessageContent.test.tsx src/runtime/turn-changes.test.ts`、
  `corepack pnpm typecheck` 和 `corepack pnpm format:check` 通过。本条是资源 ownership 的工作台连接层证据，不等同于 installed app
  冷启动/恢复验收。
- C1/C5 OpenCode ACP 产品 / 连接身份一致性补正（2026-09-11）：固定 1.18.30 真实二进制验收时发现
  `fixed_opencode_acp_host_create_open_and_reuse_registry_installation_without_model_turn` 失败，错误为
  `Runtime product ID is already bound to different metadata`；修正产品登记层只写 `opencode` 的产品展示名
  `OpenCode`，不再把 `OpenCode ACP` 适配器标签写入 `runtime_products`。随后同一路径继续暴露
  `Runtime connection ID is already bound to different metadata`，原因是安装接受路径登记 `OpenCode ACP system local`，
  而会话创建路径登记 `OpenCode ACP stdio experiment`；已统一为前者。ACP 差异仍保留在 adapter、installation、build、connection
  和 launch record 身份中，未把 OpenCode Server 与 OpenCode ACP 折叠成单一 `runtime_id`。复测
  `fixed_opencode_acp_host_create_open_and_reuse_registry_installation_without_model_turn`、
  `fixed_opencode_acp_registry_record_survives_session_registration_and_restore` 和全部 11 个
  `fixed_opencode_acp` 真实二进制用例通过。`fixed_opencode_acp_real_permission_wait_can_cancel_and_continue`
  在一次复跑中曾返回非 `Cancelled`，随后带诊断断言重跑及全套 fixed 套件均通过；该现象记录为真实 OpenCode ACP permission / cancel
  时序不稳定信号，不能说已根因修复。
- C 阶段当前出口状态（2026-09-11）：不依赖 question / elicitation 的 C1、C2、C4 与 C5 主要代码切片已补到源码、
  自动化和固定真实 OpenCode ACP 二进制层，包含安装/修复/恢复、Provider 私有配置、任务绑定、权限取消、文件/差异/结果打开、输出上限和
  工作台连接 ownership。仍未关闭 C 阶段：固定 OpenCode ACP 未暴露 OpenCode 本体 question / elicitation；installed app
  真实点击安装/取消/修复、真实 Provider 任务和同一候选安装应用的完整端到端流程尚未验收。因此当前不能把“C 阶段完成”写成事实。
- C 阶段代码层与候选包检查（2026-09-11）：本轮最终检查通过：
  `corepack pnpm format:check`、`corepack pnpm typecheck`、`corepack pnpm test`（52 files / 249 tests）、
  `corepack pnpm build`、`cargo fmt --check --manifest-path src-tauri/Cargo.toml`、
  `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked`（357 passed / 16 ignored）和 `git diff --check`。固定真实
  OpenCode ACP 二进制 `/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode` 下补跑
  `fixed_opencode_acp` 全套 11 项通过，并单独补跑
  `fixed_shared_saved_connection_drives_pi_bridge_and_opencode_acp_without_reentering_key` 通过。内部候选桌面包
  `src-tauri/target/release/bundle/macos/Farfold.app` 已由 `corepack pnpm tauri:build:internal` 生成，`codesign --verify --deep --strict`
  通过；`Info.plist` 显示 `CFBundleIdentifier=ai.farfold.desktop`、版本 `0.1.7`；可执行摘要为
  `45ae15f8d17a29838991f126c39c255090974ff61448091729a492089715fdc5`。该包未公证，且未安装替换到 `/Applications/Farfold.app`；
  因此仍不是 installed app 真实产品验收。
- C4 diff 预览有界读取补正（2026-09-11）：复审指出 tracked diff 分支此前先用 `git_output().output()` 完整收集 Git
  stdout/stderr，再做 128 KiB 截断；这会让大 diff 在进入产品上限前形成无界内存风险。本轮新增仅用于 diff 预览的有界 Git
  读取：stdout 最多保留预览上限后一字节用于判断截断，stderr 有独立产品上限，stdout 超限导致的断管不把可预览 diff 判为失败；同时
  binary、large、非普通文件和越界路径直接拒绝内联 diff，不启动 tracked patch 收集。新增
  `diff_preview_rejects_large_tracked_paths_without_collecting_git_output` 和
  `diff_preview_bounds_tracked_git_stdout_before_collecting_the_full_patch`。当前检查：
  `cargo fmt --check --manifest-path src-tauri/Cargo.toml`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked host_store::turn_changes -- --nocapture` 和
  `corepack pnpm typecheck` 通过。
- C3 独立 ACP adapter spike 授权记录（2026-09-11）：用户已同意“独立 ACP 适配器最小验证，再决定正式采用”。该授权只解除最小验证阻塞，
  不是正式采用、迁移、替换或把 question 缺口降级为已支持。验证边界：Farfold Host 仍只连接公共 ACP；独立适配器内部可使用
  OpenCode 官方受支持接口转接原生 question；不得让 Host 直连 OpenCode HTTP 作为默认旁路，不 patch/fork OpenCode，不实现第二套 Agent
  循环，不为所有 Agent 建自有协议。验证必须证明同一选定安装、工作目录、连接和 native Session 下任务与 question 身份闭环，且
  question answer/reject/cancel、permission、停止和重连隔离不混淆。
- C3 独立 ACP adapter 最小 spike 结果（2026-09-11）：新增只用于验证的
  `scripts/opencode-question-bridge-spike.mjs`，未接入产品默认路径。命令
  `ACP_SDK_DIR=/tmp/farfold-acp-sdk-run.1Eol1w/node_modules/@agentclientprotocol/sdk OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode node scripts/opencode-question-bridge-spike.mjs`
  返回 `ok=true`，本轮受限 spike 字段 `overallC3SpikeSatisfied=true`。脚本先校验固定 OpenCode 1.18.30 二进制 SHA-256
  `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`，再启动独立 adapter 子进程；driver 与 adapter
  之间通过真实 newline-delimited JSON-RPC stdio 消息完成 `initialize` / `initialized` / `session/new` / `session/prompt`
  和反向 `elicitation/create`、`session/request_permission`。脚本按 ACP v1 form elicitation 的
  `clientCapabilities.elicitation.form`、`agentCapabilities.loadSession=true`、`mode=form`、`requestedSchema`、`accept/decline/cancel` 响应动作，以及 prompt
  `stopReason` 做有限校验；不再使用自定义 `answered/selected/cancelled/answers` 或自定义 `status` 当作 ACP 兼容证据。adapter
  内部启动真实 `opencode serve --pure`，使用隔离
  HOME/config/cache/state、临时 workspace 与本地 OpenAI-compatible fixture Provider；官方 SDK
  `@agentclientprotocol/sdk@1.4.0` 的 zod schema 已校验
  `InitializeRequest`、`InitializeResponse`、`NewSessionRequest`、`NewSessionResponse`、`LoadSessionRequest`、`LoadSessionResponse`、
  `CreateElicitationRequest`、`CreateElicitationResponse`、`RequestPermissionRequest`、`RequestPermissionResponse` 和
  `PromptResponse`，未把 SDK 写入项目依赖。输出 session
  `ses_f6fde399fffe0oQdFDXpL9ZC7r`；同一 native Session 下 question 三种结果均经 stdio 反向请求闭环：
  answer `que_09021cc02001A0AanLDwlqijdc`、reject `que_09021cd08001N0Ey6zd0gYkhzc`、cancel
  `que_09021cdb4001elNDODhJb3DkXu`。permission 使用 `session/request_permission`，原生 id
  `per_09021ce80001VHuAo27yDChJab`，与 question id 分离；`sameNativeSessionCovered=true`，
  `providerSawQuestionAnswer=true`，`providerSawPermissionPrompt=true`。passed：固定二进制摘要、独立 stdio JSON-RPC 进程边界、
  initialize/form elicitation 字段、同一 native Session 的 question accept/decline/cancel 转接、permission 与 question id 分离、late
  elicitation response 无 Provider 副作用（`providerSideEffect=0`），permission cancel 后下一轮 prompt 到达 fixture Provider 并完成
  `end_turn`（`nextAfterPermissionCancel.status=verified`，`providerReached=true`）。恢复回答分支已修正为恢复后若收到
  `accept` 会调用 OpenCode 原生 `/question/{id}/reply`，而不是一律 reject。只重连 adapter 的恢复用例通过：原始 pending
  question `que_09021d213001LnxIAoLYNPFwVW`，`session/load` 后重新暴露同一 `elicitation/create` id / native id，恢复后
  `accept` 产生 1 次真实 Provider 后续请求（`recoveredAcceptProviderSideEffect=1`）；adapter PID `41892 -> 41895`，OpenCode
  serve PID 保持 `41891`，端点保持 `http://127.0.0.1:4096`，workspace 保持同一隔离目录，因此本条证明的是“adapter 重建、同一
  OpenCode 服务进程继续持有 pending question”。
  固定版本官方源码边界也已核对：`v1.18.30` tag `3104c1428ec91f809e5ab86631300de41eb6952e` 的
  `packages/opencode/src/question/index.ts` 中 pending question 存在 `Map<QuestionID, PendingEntry>` 和 Deferred 内，instance
  finalizer 会 fail 所有 pending deferred 并 `pending.clear()`；同 tag `packages/opencode/test/question/question.test.ts` 明确覆盖
  `pending question rejects on instance dispose` 与 `pending question rejects on instance reload`。因此 Agent/instance 重启或 reload
  期间的 pending question 应按原生失效如实呈现，不应由 Farfold 伪造恢复请求补绿。限制：这仍是脚本级 spike，不是产品 stdio adapter、
  不是 installed app、不是真实 Provider；question cancel 在 OpenCode HTTP 层仍映射为 reject。结论：独立 OpenCode ACP adapter 路线有
  足够的最小协议正信号可提交取舍，但正式采用、产品接入、真实 Provider 与 installed UI 仍是 C3/C 出口阻塞。
- C3 独立 ACP adapter recovery-only 闭合复核（2026-09-11）：在同一脚本新增
  `--recovery-only` 入口，复用此前普通 question / permission 正信号，只跑恢复子流程。命令
  `ACP_SDK_DIR=/tmp/farfold-acp-sdk-run.UALZ8P/node_modules/@agentclientprotocol/sdk OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode node scripts/opencode-question-bridge-spike.mjs --recovery-only`
  返回 `overallC3SpikeSatisfied=true`，但该字段仅表示 recovery-only spike 的受限判定满足，不是产品 C3 完成。输出 session
  `ses_f6fd77d70ffe6z1G8Oaj6D2ai7`；原始与恢复后的 JSON-RPC id 均为
  `elicitation-que_090288631001RdARfFnNoFc1YQ`，native question id 均为
  `que_090288631001RdARfFnNoFc1YQ`，`sameRecoveredNativeQuestion=true`。adapter PID
  `42303 -> 42308`，OpenCode serve PID 保持 `42306`，端点保持 `http://127.0.0.1:4096`，workspace
  保持同一隔离目录，因此该用例确认为“只重建 adapter、同一 OpenCode 服务继续持有 pending question”。恢复后
  `accept` 触发真实原生 reply，fixture 新增请求中包含本次 `ACP bridge` 回答（`recoveredProviderSawThisAnswer=true`），原生任务到达
  idle（`recoveredTerminal.idle=true`），Provider 后续请求副作用为 1。旧连接来源验证为
  `destroyed_stdio_write_attempted` 且 `providerSideEffect=0`；其证据边界只是“旧 stdio 已销毁的包没有副作用”，不等同完整 Host
  generation 隔离。结合官方源码边界，当前可采纳范围是：独立 adapter 在自身重启/重连同一 OpenCode 服务时可恢复 pending question；
  OpenCode instance/服务重启时 pending question 按原生语义失效。正式采用仍需用户决定，并需补产品 adapter、真实 Provider、installed app
  与失效 UI。
- C3 独立 OpenCode ACP adapter 采用决定（2026-09-11）：用户明确批准“采用，继续往后推进开发”。该决定替代此前“仅 spike /
  待采用”的限制，进入产品实现；但不等于 C3 已完成、也不等于提前删除旧路径或覆盖日用应用。正式链路保持为前端 → 公共 Host →
  公共 ACP → 独立 adapter → 固定 OpenCode；官方 HTTP 只允许在独立 adapter 内部用于 OpenCode 原生 question 等受支持接口，不增加 Host
  原生旁路、不 patch/fork Runtime、不实现第二套 Agent 循环、不引入常驻后台平台。接入必须保留已有 Provider 私有配置、任务绑定、流式、
  工具、权限、停止和恢复能力；OpenCode 服务/instance 重启期间的 pending question 按原生失效呈现。
- C3 产品 Host/UI question bridge 前置接入（2026-09-11）：本轮把 spike 的 ACP form elicitation 语义先落到公共 Host/ACP 与工作台边界，
  尚未切换默认 OpenCode 启动为独立 adapter。`AcpTransport` 现在同时识别 `session/request_permission` 与 `elicitation/create`
  反向请求；permission 仍校验原生 optionId 并按 `{"outcome":...}` 回复，elicitation 直接按 ACP 结果对象
  `{"action":"accept","content":{"choice":...}}` / `{"action":"decline"}` / `{"action":"cancel"}` 回复。停止时从
  `cancel_pending_permissions` 扩展为按 native Session 取消全部 pending client requests，permission 回 `cancelled`，elicitation 回
  `cancel`。`OpenCodeAcpStatus` 新增 `questionBridge`，官方 `opencode acp` 默认 false；只有后续独立 adapter 在 initialize
  capability 中明确声明 `farfoldOpenCodeQuestionBridge=true` 时，工作台 reducer 才把 `elicitation/create` 投影成“OpenCode 原生提问”卡片。
  前端新增 `opencode_acp_question_respond` 调用、question/permission 分支渲染、enum choice 按钮、拒绝/取消按钮和 generation-scoped
  响应；未声明 bridge 的 elicitation 只计为未适配原始事件，不冒充能力已支持。调试中发现 `AcpTransport::stop()` 在子进程已成功自然退出且无未决
  Host 请求/反向请求时仍误报“异常退出”；已修为幂等成功，仍有未决请求时继续报未知。当前检查：
  `corepack pnpm typecheck`、
  `corepack pnpm vitest run src/runtime/opencode-conversation.test.ts src/runtime/opencode-event-gate.test.ts src/runtime/opencode-acp.test.ts`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked acp_transport -- --nocapture`、
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture` 和
  `cargo test --manifest-path src-tauri/Cargo.toml --locked interaction_registry -- --nocapture` 通过。该条证明产品 Host/UI 可承接独立 adapter
  发出的 form elicitation，并避免官方 ACP 被误标为已桥接；仍不是独立 adapter 进程本体、真实 Provider 或 installed app C 阶段出口验收。
- C3 独立 OpenCode question ACP adapter 产品进程切片（2026-09-11）：新增 Farfold 内部子进程入口
  `--farfold-opencode-question-acp-adapter-v1`，Host 仍只通过公共 stdio ACP 连接；子进程内部启动固定 OpenCode
  `serve --pure --hostname 127.0.0.1 --port 0`，通过 OpenCode 官方 HTTP session / prompt_async / question / permission / abort 接口桥接。
  当前默认启动仍保留官方 `opencode acp`；独立 adapter 只在显式验证开关下启用，可用
  `FARFOLD_OPENCODE_ACP_USE_QUESTION_BRIDGE_ADAPTER=1` 和 `FARFOLD_OPENCODE_ACP_ADAPTER_BINARY=...` 显式验证 adapter 路径。
  adapter initialize 返回 `agentCapabilities.loadSession=true` 和 `farfoldOpenCodeQuestionBridge=true`；managed Provider 隔离配置仍写入
  OpenCode config 目录，adapter 从同一配置投影 `model` configOption，满足 Host 的 Provider/model 绑定确认。实现中修正了两个 adapter 进程边界问题：
  子命令绕过 Tauri 初始化时需显式安装 rustls crypto provider；`prompt_async` 后 OpenCode status 可能短暂仍为 idle，因此 adapter 至少观察 2 秒并优先捕获
  question / permission，避免把未开始处理误报为 `end_turn`。permission 桥接保留 `once/always/reject` 原生语义，Host abort 经
  `cancel_pending_client_requests` 返回 `cancelled` 后，adapter 对 OpenCode permission 执行 reject 并把 prompt 终态映射为
  `stopReason=cancelled`；未决请求仍通过 Host generation 和 request id 隔离。当前真实固定二进制验证：
  `printf ... | src-tauri/target/debug/farfold --farfold-opencode-question-acp-adapter-v1` 返回 initialize capability 和
  `session/new` 原生 id `ses_f6fa91096ffeCsh6qSwDh7qatc`；
  `FARFOLD_OPENCODE_ACP_USE_QUESTION_BRIDGE_ADAPTER=1 FARFOLD_OPENCODE_ACP_ADAPTER_BINARY=/Users/tw/Desktop/farfold/src-tauri/target/debug/farfold OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode cargo test --manifest-path src-tauri/Cargo.toml --locked fixed_opencode_acp_program_can_initialize_create_load_and_close_without_model_turn -- --ignored --nocapture`
  通过；
  `... fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model -- --ignored --nocapture` 通过；
  `... fixed_opencode_acp_real_permission_wait_can_cancel_and_continue -- --ignored --nocapture` 通过。该条证明独立 adapter 产品进程已能启动真实固定
  OpenCode、创建/加载/关闭 session、使用 managed Provider fixture 完成 prompt、保留权限等待/取消/下一轮；仍未完成 installed app
  可见验收，也尚未用该 Rust adapter 跑真实原生 question accept/decline/cancel 全流程。
- C3 Rust adapter 原生 question 主流程验证（2026-09-12）：扩展
  `scripts/opencode-question-bridge-spike.mjs`，允许用 `FARFOLD_RUST_ADAPTER_BINARY` 启动产品 Rust adapter 作为 driver，被测链路仍是
  driver → stdio ACP → Rust adapter → 固定 OpenCode `serve` → 本地 OpenAI-compatible fixture Provider。Rust adapter 增加
  `FARFOLD_OPENCODE_FIXTURE_PROVIDER_ENDPOINT` 测试配置写入能力，仅用于验证隔离配置下的 fixture Provider，不改变产品 managed Provider 路径。
  命令
  `ACP_SDK_DIR=/tmp/farfold-acp-sdk-run.1Eol1w/node_modules/@agentclientprotocol/sdk OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode FARFOLD_RUST_ADAPTER_BINARY=/Users/tw/Desktop/farfold/src-tauri/target/debug/farfold node scripts/opencode-question-bridge-spike.mjs`
  返回 `ok=true`、`adapter=rust`、`overallRustAdapterMainFlowSatisfied=true`。输出 session
  `ses_f6cba7174ffe7SCe7oXdxeu2rw`；question accept 原生 id
  `que_093459935001QPW2XVagecuEhx`、decline 原生 id
  `que_093459a33001Qrb7Frw7VS15Of`、cancel 原生 id
  `que_093459abe001LFHHhycP9NzaNe`，均通过 ACP `elicitation/create` 暴露且在同一 native Session。permission 原生 id
  `per_093459b65001iqijg3cg4gs1lN` 通过 `session/request_permission` 暴露；question accept/decline/cancel 的 prompt
  `stopReason` 均为 `end_turn`，permission cancel 为 `cancelled`，取消后下一轮 prompt 到达 Provider 并返回 `end_turn`。
  late elicitation response 的 Provider 副作用为 0，`providerSawQuestionAnswer=true`、`providerSawPermissionPrompt=true`、
  `providerSawNextTurn=true`。该验证证明 Rust 产品 adapter 已覆盖原生 question 主流程和 permission 共存；但 recovery 字段为
  `skipped`，原因是当前 Rust adapter owner 模式会拥有自己的 OpenCode serve 子进程，adapter 重启后 pending question 的恢复/失效 UI
  尚未产品化验证。C3 因此仍不能关闭，installed app 可见流程也仍未验收。
- C3 Rust adapter 边界收紧复核（2026-09-12）：根据产品接入评审，`opencode_acp` 启动路径保持显式 opt-in，只有
  `FARFOLD_OPENCODE_ACP_USE_QUESTION_BRIDGE_ADAPTER=1` 才会进入独立 adapter；managed Provider 不再自动替换官方 ACP。
  Rust adapter 的 `session/prompt` 不再自行固定 OpenCode `agent=build`，而是把 ACP prompt 的全部 text block 按顺序转为 OpenCode
  `parts`，遇到非文本 ACP prompt block 明确报错，避免静默丢弃输入。adapter 在一次 prompt 内处理 question / permission 后继续观察同一
  OpenCode session，允许同轮多个原生交互依次出现；permission cancel 仍返回 `stopReason=cancelled`。复测：
  `cargo build --manifest-path src-tauri/Cargo.toml --locked` 通过；
  `FARFOLD_OPENCODE_ACP_USE_QUESTION_BRIDGE_ADAPTER=1 FARFOLD_OPENCODE_ACP_ADAPTER_BINARY=/Users/tw/Desktop/farfold/src-tauri/target/debug/farfold OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode cargo test --manifest-path src-tauri/Cargo.toml --locked fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model -- --ignored --nocapture`
  通过；
  `ACP_SDK_DIR=/tmp/farfold-acp-sdk-run.1Eol1w/node_modules/@agentclientprotocol/sdk OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode FARFOLD_RUST_ADAPTER_BINARY=/Users/tw/Desktop/farfold/src-tauri/target/debug/farfold node scripts/opencode-question-bridge-spike.mjs`
  再次返回 `ok=true`、`adapter=rust`、`overallRustAdapterMainFlowSatisfied=true`，本次输出 session
  `ses_f6cb1349affep3M83jqnFtXn2i`，question ids 为
  `que_0934ee21e001C2Lzy6zi1TcuMy` / `que_0934ee336001nh8ndCqNQqrZS5` /
  `que_0934eeb73001rmjIwmQCiK9Nvi`，permission id 为 `per_0934ef3a8001XXPKQpM3nzyFC2`。新增回归：
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_question_acp_adapter -- --nocapture` 和
  `cargo test --manifest-path src-tauri/Cargo.toml --locked question_bridge_adapter_requires_explicit_opt_in_value -- --nocapture`
  通过。该条是 adapter 边界收紧与回归证据，不是 installed app 或 C 阶段出口验收。
- C3 Rust adapter 可见进度与同 prompt 多交互推进（2026-09-12）：产品 Rust adapter 新增 `session/load` 后的 OpenCode
  `/session/{id}/message` 历史回放，并在 prompt 执行期间轮询同一原生消息接口，把 user/assistant text part 投影为 ACP
  `user_message_chunk` / `agent_message_chunk`，把 OpenCode tool part 投影为 ACP `tool_call_update`，用 per session projection
  记录文本前缀和工具快照，避免重复追加。prompt 终态判断不再使用固定 2 秒观察窗口；adapter 先检查 native question/permission，本轮若刚投影出新的文本或工具更新则继续轮询，下一轮再允许 idle 结束，避免工具刚出现时抢先把 turn 关掉。
  新增单测覆盖 text/tool `session/update` 输出、文本增量和去重：
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_question_acp_adapter -- --nocapture` 通过（4 tests）。Rust adapter spike
  扩展为同一 prompt 内先后两次 `elicitation/create`，输出 combo 原生 question ids
  `que_093647aaf001yU6LBJvjtcu8Qg` / `que_093647b24001eG7w6JkAr185y5` 的早期失败后，按唯一问题文本修正为稳定覆盖；最终复测命令
  `ACP_SDK_DIR=/tmp/farfold-acp-sdk-run.1Eol1w/node_modules/@agentclientprotocol/sdk OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode FARFOLD_RUST_ADAPTER_BINARY=/Users/tw/Desktop/farfold/src-tauri/target/debug/farfold node scripts/opencode-question-bridge-spike.mjs`
  返回 `ok=true`、`adapter=rust`、`overallRustAdapterMainFlowSatisfied=true`，session
  `ses_f6c9ba1afffeH73GnH6sZnHvUk`，combo question ids
  `que_093647aaf001yU6LBJvjtcu8Qg` / `que_093647b24001eG7w6JkAr185y5`，standalone permission id
  `per_0936482c10018x1H1G93gd55hg`，`providerSawComboPrompt=true`。同 prompt “question 后 bash permission”曾由 fixture 触发 Provider
  bash tool call，但固定 OpenCode 1.18.30 未在 60 秒内通过 `/permission` 暴露 native permission；该组合记录为
  `questionThenPermissionStatus=blocked`，不作为通过项。受影响复测通过：
  `cargo test --manifest-path src-tauri/Cargo.toml --locked opencode_acp -- --nocapture`、
  `corepack pnpm vitest run src/runtime/opencode-conversation.test.ts src/runtime/opencode-event-gate.test.ts src/runtime/opencode-acp.test.ts src/runtime/native-interaction-reply.test.ts`、
  `corepack pnpm typecheck`、`corepack pnpm format:check`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`git diff --check`，
  以及显式 adapter 路径下的固定 OpenCode
  `fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model` /
  `fixed_opencode_acp_real_permission_wait_can_cancel_and_continue` ignored tests。该条推进了可见工作流和同 prompt 多 question 覆盖；仍不是 installed app
  或 C 阶段出口验收。
- C4 非 Git / 不可归因基础视图复核（2026-09-11）：`TurnChangesSection` 只在 `provenanceState=available` 时显示
  Turn 级路径 diff/preview/reveal 动作；在非 Git、非管理工作区或 Turn 起点非干净时仍显示项目级状态说明，不把变化归因给该 Turn。
  artifact/result 文件入口走独立公共 `project_file_reference` 的 `host_reveal_project_file` / `host_open_project_file`，未被
  `TurnChangesSection` 的 provenance gate 硬拦。该复核未新增代码；它证明基础可见性未被 provenance 误拦，不等于提供非 Git 下逐路径 diff。
- C 当前收口复查（2026-09-11）：此前代码层全量检查保留为已记录证据：`cargo fmt --check --manifest-path src-tauri/Cargo.toml`、
  `corepack pnpm typecheck`、`cargo test --manifest-path src-tauri/Cargo.toml --locked host_store::turn_changes -- --nocapture`、
  `corepack pnpm test`（52 files / 249 tests）、`cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings` 和
  `cargo test --manifest-path src-tauri/Cargo.toml --locked`（359 passed / 16 ignored）均通过。本轮在上述 spike 与记录更新后补跑
  `corepack pnpm prettier --write scripts/opencode-question-bridge-spike.mjs`、
  `ACP_SDK_DIR=/tmp/farfold-acp-sdk-run.1Eol1w/node_modules/@agentclientprotocol/sdk OPENCODE_ACP_TEST_BINARY=/tmp/farfold-opencode-acp-1.18.30.K7Rh2Z/opencode node scripts/opencode-question-bridge-spike.mjs`、
  `corepack pnpm prettier --write plans/runtime-neutral-lifemodel.md reports/2026-09-10-host-architecture/Farfold-实施与验证记录.md`、
  `corepack pnpm format:check` 和 `git diff --check`，均通过。随后 recovery-only 入口补跑通过。该复查证明当前源码和 spike
  处于可继续开发状态；其中 spike 命令通过不代表 C3 生产 adapter、真实 Provider 或 installed app 整体验收。

- C3 连贯增量（2026-09-12，终态、配置与恢复）：删除“任意消息更新 + idle”结束判定，adapter 改用官方同步
  `POST /session/{id}/message` 的返回结果作为本次 prompt 完成依据；并行读取历史与原生待请求仅用于呈现和交互。
  返回 assistant 必须属于当前 Session，其 parentID 指向本次调用前历史中不存在的 user 消息，且具有原生完成时间；
  原生错误与 MessageAbortedError 分别映射失败和取消。依据固定源码的 session/prompt、session/schema 和官方 SDK
  SessionPromptResponse 合同；参考 https://github.com/anomalyco/opencode/tree/v1.18.30/packages/opencode/src/session 。
  删除合成 user 消息，ACP reducer 以原生首块替换临时文本，后续块追加；工具首次发送 tool_call，后续
  tool_call_update，running 映射 in_progress。
- 配置从原生 `/config/providers`、`/agent`、`/config` 与 Session 历史读取；model、mode、effort 经过目录校验后
  保存到 adapter 会话状态，下次原生请求明确传入 model/agent/variant。活动 prompt 拒绝修改，冷载入依据原生历史恢复
  已使用的选择。尚未发送的设置不承诺跨进程持久化，与官方 ACP 内存选择/历史恢复边界一致。
- 恢复继续使用自有 adapter/serve 生命周期；重启后历史中未完成 question 不在原生待答列表时，发出 ACP 自定义
  `_farfold/session_recovery` 通知，工作台保留失效提示并移除旧操作。无后台服务，也不重造原生 question。
  工作台冷载入时先暂存有界事件，确认连接身份与 generation 后再投影；旧代次不回放。公共待交互类型与筛选补入
  open_code_question，避免 Host 重建状态时误删现存问题。
- 定向证据：adapter 9 个测试通过，含“旧历史 + 新 user + 500ms 延迟原生完成”HTTP 用例；相关前端 45 个测试通过；
  typecheck、format:check、clippy -D warnings 通过。首次新增 HTTP 用例因测试缺少 rustls provider 初始化失败，补齐测试环境后通过。
  `--adapter-incremental` 短流程使用固定 SHA 的真实 OpenCode 1.18.30 和 fixture Provider，通过模型切换、延迟第二轮、
  等待问题时重启、恢复同 Session 与下一轮：ses_f6c86b656ffeBMmIwiD0f1EtXj，延迟轮 892ms，Provider 实际收到
  spike-model-two，重启前恰好两条原生 user；失效问题原生 part 为 prt_0937963d90011ucYbDK6OL7K4G。
  固定 OpenCode permission cancel/continue 定向 ignored test 通过。没有重跑完整 spike；question→permission
  组合仍保留原失败及原因未知，不作为通过项。
- 安装应用复测开始：已为 `/Applications/Farfold Dev.app` 与完整 Dev 数据做配对副本，目录
  `src-tauri/target/c-stage-dev-backup-20260912`（Git 忽略），副本 SQLite integrity_check=ok。
  首个开发候选可执行文件 SHA-256 01e0374088c39aae4e27b28524d682527dd661cadd0dcb758e902187e7be7381，
  安装与构建一致、严格签名检查通过。通过 UI 手动选择、验证摘要、登记并使用固定安装，从普通启动入口建立原生
  ses_f6c7ca090ffeaRfeZ99jfArtJJ。实际暴露模型指纹含斜线导致发送被禁用，以及 mode/effort 未展示；
  已修为 SHA-256 结构化指纹并新增原生设置行，正重新构建验证。该首次失败不被源码测试覆盖掉。
  正式 `/Applications/Farfold.app` 未替换；C3 与整个 C 阶段尚未完成。
- 同安装可见增量：候选 acc493a58c503e83c228d1e92e59cf5161845d44437e7497fcb3cfdfbfcece8c
  通过真实 OpenCode Zen / Big Pickle 请求，精确返回 C-REAL-PROVIDER-0912，原生 user 无重复，模式切到 plan。
  首次真实 question 在原生日志确认已发出，界面显示问题，但未及时回答触发 adapter 固定 120 秒等待超时，
  旧选项仍留在界面。这是产品缺陷，不归因于 Provider，也不把简单请求通过外推为交互通过。
- 删除 prompt / 人工回答的固定两分钟截止；本机连接与普通控制读取仍有有限超时，等待人工回答期间每秒核对
  原生待请求，取消/服务消失后退出等待并清理反向请求。新增响应与服务失效清理测试，adapter 10 tests 通过。
  开发候选 929a94d04207c082993974b0ce239c18551bd2c9d92d615f7c41f59e6ef025e6 严格签名与安装摘要核对通过；
  同 ses_f6c7ca090ffeaRfeZ99jfArtJJ 冷恢复显示旧问题失效、保留历史与 plan 模式。2026-09-12 03:10:04 UTC
  发起新 question，03:12:36 后选择 Continue QA，真实返回 C-QUESTION-OK Continue QA，待处理归零。
  随后的新 question 点击工作台“停止”，原生确认取消，旧选项移除，输入区恢复，没有自动重发。
- 固定 OpenCode question-v1 合同还要求有序多题、多选、选项说明和默认允许自定义回答；当前补齐这些表单映射，
  不再仅取第一题。依据固定源码 packages/schema/src/v1/question.ts 与 ACP SDK 1.4.0 form schema。
  恢复后的历史失效工具补“已中断 / 结果未确认”显示，不继续标成正在执行。该新增源代码尚待新候选可见验证。
- 后续 Dev 候选 50a1f442292d0978580b73f40dfa9001fe6edff0e4944d34686a4bb174f3cf1b
  通过实际两题表单：首题自定义 Gamma QA，次题勾选 Files 和 Terminal；同一 prompt 随后出现原生 bash 权限，
  选择 Allow once 后真实响应确认全部答案并显示 C-PERMISSION-OK。这证明真实 Provider 下组合能力可用；
  先前 fixture 组合失败的原因仍未知，不用该成功解释旧失败。权限卡实际暴露原始 JSON 标题，已改为权限名称和原生命令。
- 补充协议失败边界：JSON-RPC error / 缺失 action 不再默认变成 native reject；人工回答校验/传输未确认进入显式
  unknown，不当作用户取消或确定拒绝。公共 ACP 客户端保留 unknown，继续使用停止/重连核对出口，不自动重发。
  自有 ACP 启动使用独立进程组，输出断开或强制关闭时只终止该组，以覆盖 adapter 下的 owned serve；服务启动超时
  也 kill/wait 自有 child。依据 Rust CommandExt::process_group 官方合同，不按名称查杀 OpenCode。
  参考 https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html#tymethod.process_group 。
  ACP 范围测试 50 passed / 13 ignored，含自有监听子进程随 adapter 退出关闭、unknown 非 rejection、客户端错误不取消原生提问；
  本次相关前端 5 files / 40 tests 通过。服务启动超时的小修在该次编译后补入，后续检查继续覆盖。
- 文件可见验证：QA 根目录 result.txt 被真实 Agent 编辑，代码块、打开/定位动作可见；独立 Git diff 确认实际内容，
  同时发现模型未写要求的末尾换行。界面根检出正确显示“仅项目级状态”，没有伪造 Turn 归因。
  QA 目录的 opencode.json 仅设置 bash=ask，独立 fixture 基线 ec5f6c17956a；不是 Farfold 源码提交。
- UI 创建隔离 Worktree 后发现阻断缺陷：冷恢复未恢复已选安装引用，新建 Session 回落旧 server Adapter，随后
  遗留的 ACP 状态 effect 又覆盖新绑定，造成输入目录与旧 Session 混用。没有向该错配状态发送任务。
  已将新建连接继承明确选择/当前 Host Session/恢复 Session，删除第二套 effect 激活权威，并在发送前校验
  Session、connection、build、installation、adapter 和 cwd 全部一致；该修复待新候选复测。
- 04b6cf6d90811fbbe9d8dd58be07a518c0ef954b428703960a494adf5fe329b6 候选复测不再回落旧 Adapter，
  但新建正确报“旧 ACP 已启动”，暴露 Host 缺少闲置连接切换。补 Host 原子关闭请求准入后再关闭闲置连接，
  活动 request、待交互、会话操作与 unknown result 阻止自动切换；未知超时也保留此门控。
- 同候选冷恢复显示历史内容存在但顺序错乱。确认 event_pump 与状态读取同时 drain，批次在路由前可能超车；
  已改为只等待事件通知，连接锁内统一 drain + route。64 条消息与状态读取交错测试通过。
  ACP 范围最新一轮 52 passed / 13 ignored，包含闲置切换保留 busy 与有序历史；停止唤醒事件泵的竞态又补检查。
- C1 普通入口真实下载成功，Dev managed-runtimes 内固定文件摘要为
  2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62，原本机安装仍保留。
  首次下载过程中没有“取消安装”按钮：UI 只在安装完成后读取 Host phase。已补即时按钮及有界间隔的状态刷新，
  下载本身在调查时正常完成；不能把此次成功记成取消测试通过。下一候选继续取消/修复可见复测。
- Dev 候选 c96dd6b09ad214a1fd7b13a68e7978d91ca0907ee6dc15036265d1cf218a5466 实际通过 C1
  损坏修复、下载中点击取消、取消后重试修复：取消确认后下载临时目录已清理，75-byte QA 占位文件保留；
  重试后可执行文件恢复为固定 SHA-256 2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62。
  故障只施加到本轮新建的 Dev managed 安装，原文件保留在配对 QA 副本中，全局 Runtime 和正式应用未修改。
  同候选冷恢复原会话历史顺序正常；普通启动入口从原会话切到已有 QA Worktree 成功，未回落旧 Adapter。
  新 native Session ses_f6c29de2cffekhI59exX1akiyt，Host
  session-984dd65dba125d3b7b9fad135d86c6c7e2ddb0a676b8e0607bdf6428f1535400，连接
  connection-e039d865f53259431d4549fecffd0e8de287cf3dd41f5a6094c05a142e3f7154 为修复后的 managed 安装。
- 真实 Worktree 任务已用 native read/write 修改 result.txt。模型仍遗漏要求的换行，随后申请 bash 纠正；
  实际点击 Reject，原生工具记录为 error，内容明确为用户拒绝，磁盘仍无换行且 denied-marker.txt 未生成。
  原生同步 prompt 最终响应 finish=tool-calls、time.completed 已有、无 assistant error；adapter 却误报 unknown。
  固定上游 session/processor.ts 对 Permission/Question RejectedError 可中止循环，acp/service.ts 的 promptResponse
  对无 error 的同步响应返回 end_turn。已补有完成时间且所有工具 settled 的同步 tool-calls 映射与反例测试，
  仍不依据旧历史或 idle 提前结束；权限回复缺失/非法 outcome 也不再默认当成用户拒绝。
- 同次未知任务点击普通“停止”会等待已不存在的 pending prompt；实验“停止 ACP”仅退出进程而未释放 Host 占用。
  已把显式恢复接入现有 host_managed_runtime_stop 权威，核对持久绑定、Turn token、native Session、cwd、generation，
  确认自有进程退出后才释放占用并推进交互代次；原任务结果仍标未知，不自动重发。恢复目标查询去掉固定旧安装限制。
  该源码修复待新安装候选实际复测，不能把旧实验停止记成成功恢复。
- ACP 终态还遗漏了 Turn Changes 完成捕获，已复用 settle_verified_turn，不只移除活动任务。
  测试首次误把非 managed 目录的保留原因当成新 terminal_reason；按既有 COALESCE 合同修正断言后验证两条路径
  completed_at 均已写入且不覆盖 project-level 原因。最新 ACP 范围 55 passed / 13 ignored；相关前端 12 tests、
  typecheck 通过。C4 公共 fs/terminal 回调源码仍缺失，当前仅有明确不支持响应；真实 native 工具输出不代替该职责。
  C2 仍等待用户对隔离 Dev 凭据复用的答复，未复制、读取或展示 key；C 阶段仍未完成，旧入口未提前删除。
- 后续 Dev 候选 a24d2107ff31c6f386265c44f606cb4fa8136e3095eb697675dbb1f00347a3ee 实际通过
  同 Worktree 的原生 Reject：denied-marker.txt 未创建，原生工具明确记录用户拒绝，界面恢复空闲；下一轮
  精确返回 C-AFTER-REJECT-0912。随后在原生 question 待答时，对精确核实的本轮自有 adapter PID 72088
  注入进程退出故障。旧选项移除、结果未知且草稿保留，但普通恢复仍失败：status 读取丢弃了已退出连接的绑定。
  已改为保留退出连接的生命周期引用，直到现有 Host 恢复权威确认并释放占用；该新修复待安装复测。
- C4 公共 ACP 客户端资源已实现在 acp_client_resources.rs，经 acp_transport 统一处理反向请求：
  fs/read_text_file、fs/write_text_file 及 terminal/create、output、wait_for_exit、kill、release。
  连接/会话撤销隔离、目录描述符与不跟随符号链接、64 KiB 文本/输出上限、读取版本冲突检查、终端数量和反向请求并发
  上限、自有进程组清理均有定向测试。等待终端退出不阻塞 ACP 控制响应；未结束资源禁止静默切换或释放任务。
  这是公共协议 fixture 证据；固定 OpenCode 仍自行执行原生 file/bash 工具，未观察到其调用 Host 的这些回调。
  不把路径约束描述为命令沙箱，也不承诺捕获主动脱离进程组的任意子进程。文件版本检查不等于跨进程原子 CAS。
- 初始化只声明已实现能力，ACP SDK 1.4.0 校验通过，elicitation.form 为对象；独立 adapter 仅在协商 form 后发送提问。
  最新 ACP 范围 62 passed / 13 ignored，相关前端 8 files / 54 tests、typecheck、clippy -D warnings 通过。
- C2 无需读取私人凭据的验证路线：固定 1.18.30 packages/opencode/src/provider/provider.ts 的 OpenCode loader
  在无认证时只保留免费模型并使用公开占位值 public。官方 https://opencode.ai/docs/zen 及当前原生目录确认
  Big Pickle / big-pickle、https://opencode.ai/zen/v1、chat completions；原生目录上下文 200000、输出 32000。
  下一步在隔离 Dev 通过产品界面保存该公开连接并验证实际请求，尚未将其记为 managed 验收通过。未读取或复用 Z.ai key。
- Dev aafd5afcaa874e54718d0b2bda39fdf9db5a4333a9ac4ada7d3b4b9e1b2df4ab 实际重测故障恢复通过：
  原生 Recovery second QA 待答，对精确核验的 adapter PID 75601 注入退出故障；点击核对原生状态，再点击普通
  终止自有进程，Host 释放占用但保留未知结论。继续同 ses_f6c29de2cffekhI59exX1akiyt，无自动重发，
  下一轮真实返回 C-RECOVERY-NEXT-0912。手工 kill 仅故障输入，成功证据是后续产品恢复和同 Session 下一轮。
- 公开 managed Provider 首次应用被 selected_path 唯一约束拒绝，未把保存当应用：托管入口自行推导了另一安装 ID。
  已改为复用同 canonical path 的已核验安装/构建，只派生 Provider 版本 connection。固定真实 binary 的登记/恢复
  测试补 managed 注册且安装数量仍为 1，通过。设置界面补连接名称、保存后刷新列表，ACP 不再调用旧 Server 认证目录；
  前端相关 3 files / 17 tests 通过。
- Dev e3d92a127be7f79dec70abd8dc2aa41772380c858a365b8f59157f2fb12a4bb1 在干净 QA Worktree 成功应用
  保存连接，新 native ses_f6bf7d89bffeeOPdO7ncw0RLuC，Host session-1313f7bf03729bc26bce0e2181ad883a9490cbb4ed527d6fe7df002a633400ef。
  managed Provider managed-provider-1a72ed7d61e41fb0b564dd7ba21a7bc79a28f2ebf1e6060d885e668489b03796，版本
  provider-version-7e95f9357b45f82f08be67311c571324b6eef0f129f71760b9e955af5d981110，连接
  connection-b13cc0d65840f956606b33a6a10d870b1278eb3682ea2aeb09e04edb59996743。安装仍为同一 system-installation-d51ef79449bd3e6f09ef2b6ec28f7d928b6581951e9eb9b64997ea435a0559ba。
  Host 保存/应用为 saved/applied，请求仍 not_requested：发送在公共实时投影处报 Runtime event provenance does not match
  the registered connection。当时不能从 Host not_requested 推断未到模型；后续冷恢复证明请求已经原生执行并完成，
  原生 user msg_09408bb2d001GMLJ1UY8Zc7NvT、assistant msg_09408bb3e001cwGohmpH8OOpY3，
  真实回复 C-MANAGED-REAL-0912。该失败揭示同安装首连接永久锁定及完成后 UI 刷新失败误落入普通发送错误；
  不能改生成另一安装绕开，也不能自动或盲目重发保留草稿。
- 修复采用既有生命周期显式 activate_connection(binding,generation)：旧连接已停且新进程 initialize 后切换当前投影与
  交互代次，普通 route/register 保持严格来源校验，旧事件不能自行激活。交互持久化失败保留不可见/不可答的旧条目以便
  下次激活重试，投影进入 degraded / reconciliation_required，启动失败不冒充 ready；不增加第二张连接状态表。
- Dev 0c607bea324f9bb0395dd5a040ee07b243ff4cc31af9fe717fbc6bb413b40f4f 已实际通过新托管请求
  C-MANAGED-CURRENT-0912，输入清空、会话空闲；通过侧栏 managed → native → managed 的同安装连接切换和历史恢复。
  未重发旧 C-MANAGED-REAL 输入。此时 Provider 任务绑定正确，但请求投影仍 not_requested，补接原生回执而非凭 UI 文本写绿。
  adapter 仅在同步 native response 已通过 Session/new parent/完成时间/终态检查后附带非敏感 Provider/model/message receipt；
  Host 对照本 Turn 绑定、时间、原生身份才记录当前配置版本验证成功，旧版本回执不验证新保存版本。
  完成后的 UI 状态刷新失败单独显示，已确认完成/取消不再误当未发送；Host 终态记录失败保持 unknown 与占用。
- 公共激活修正的全后端复查 388 passed / 16 ignored，前端 54 files / 264 tests、format:check、clippy 通过。
  首轮全量中 ACP timeout/EOF fixture 关闭一次超时，定向复测及再次全量通过；该波动原因尚未解释，不描述为已根治。
  原生 Provider receipt 新增后仍待下一轮定向检查与 installed 验证。
- Dev 2eb5c76f2b62bc8852e29a0d1c73041bd6d6b95469016b8e54edbf380fbb1cf3 实际通过同 managed connection 的
  综合任务：native question 两题，Other=Delta QA，Files+Terminal 多选；native read/write 修改 result.txt，
  bash printf 经 Allow once 输出 C-STAGE-TERMINAL-0912。Host 原生回执校验后 saved/applied/verified_success，
  request_verified_version_id 与同一配置版本相等。终态输入清空且可继续。
  磁盘 git diff 仅 result.txt，从干净基线 ec5f6c17 改为 C-STAGE-MANAGED-RESULT-0912，无末尾换行。
  模型声称文件 27 bytes 不准确，不把模型说明当磁盘事实。Turn turn-db3ac108920758dd26d7a0bd59d91ecb
  的真实差异和“标记记录已审阅”可操作；该审阅是记录确认，不是之后文件内容永久已审阅。
- 同候选 native bash 写 denied-managed-marker.txt 被产品 Reject，原生工具 error 明确为用户拒绝，磁盘目标不存在。
  下一轮 C-STAGE-CANCEL-0912 原生提问正常出现，点击取消后选项消失、输入清空、恢复空闲。
- 截图发现通用详情 section 网格误套到差异预览，已将样式限制到直接子 section，diff 保留代码行并横向滚动；
  刷新和切会话清除旧预览，过期异步预览不能覆盖新目标。待下一安装复核。
- 继续补 C2 明确失败路径：固定上游 processor 在原生失败终态写完成时间；adapter 只对白名单 APIError/
  ProviderAuthError/ContextOverflowError、同新 user parent、全部工具 settled 的同步结果返回脱敏失败回执。
  公共 ACP 仅保留不解释的 JSON-RPC error data；Host 对照当前 Turn 身份后记录 verified_failure 并结束占用，
  未确认或不完整回执仍 unknown。原始错误正文、HTTP headers 不进入回执。定向 ACP 65 passed/13 ignored。
  已通过界面保存独立 Zen Failure QA 公开端点故障连接，账号 c-stage-failure，故意不存在模型；尚未发请求。
- managed 新建改接 host_session_create，并从绑定目标继承固定 Provider 配置版本或显式选择当前保存版本；
  idle 停止接入原有 host_managed_runtime_stop，按 Session/native/generation 校验，不再跳过 Host 任务锁。
  新入口与失败回执待下一 Dev 安装实测，实验命令尚未提前删除。
- Dev 4329c58314ea261508e7b4965ac004607ca426500db3ad6a563eed7b179112dd 实测公开 Zen Failure QA：
  故意不存在模型 c-stage-unavailable-model-0912，同原生 APIError 终态回执通过 Host 核对后为
  saved/applied/verified_failure，request_verified_version_id 与绑定版本相同，输入清空、会话空闲，未重试。
  主 managed 会话的差异布局已恢复正常宽度；外部 QA 编辑 result.txt 后刷新移除旧预览，重新预览显示外部新增行。
  已审阅标记只指不可变 Turn 记录，不是当前磁盘内容永久被审阅。
- 同 4329c583 候选在 C-STAGE-STOP-QUIT-0912 原生提问待答时点击普通停止并立即退出；冷重开继续同原生会话，
  旧问题不可答，草稿保留但没有自动重发，原生 user part 该输入计数仍为 1。手工改成新输入后真实返回
  C-STAGE-AFTER-QUIT-0912。普通 Host 从当前 managed 连接新建曾因注册表仅接受 native base connection 被拒绝，
  未产生空会话；修正为核验同一安装的原生启动引用，再校验已保存 Provider/config 派生连接。
- Dev 9b52efd00501afa1d50f1a75d15416a917125483f796fd72fc6bc0487c03fe94 实测普通侧栏新对话继承同一主 managed
  connection-b13cc0d65840f956606b33a6a10d870b1278eb3682ea2aeb09e04edb59996743，创建原生
  ses_f6bb63cc3ffeLiNpRoUCdXaH0W，真实返回 C-STAGE-HOST-NEW-0912，空闲且输入清空。
  文件打开之前被 runtime_build_not_current 错误阻断；文件操作改为只核验 Project/Session 与路径边界，
  不要求 Runtime 可启动。当前候选在 Finder 定位正确 QA Worktree/result.txt，TextEdit 打开实际内容包含外部 QA 行。
  已归档/目录缺失仍拒绝，原生 Session 目标匹配和路径越界防护保留。固定真实程序的新建/managed 继承测试通过。
- C5 源码收敛：生产只启动当前 Farfold 程序内独立 adapter，移除 opt-in 与 stock ACP 平行启动分支；
  fixture companion override 仅 cfg(test)。移除六个实验 Tauri 写控制、重复新建/载入/关闭面板和旧 Server 新建函数；
  普通 Host create/open/stop 是唯一产品入口，已有 Server open 不删。Provider 应用合为应用到新对话，当前会话保持原配置。
  状态栏用 initialize 真实回包显示版本、历史和提问协商，不把协商当完成验收。持久 opencode-acp-experiment 目录保留，
  不以名称清理用户历史。源码复审未发现本切片阻断；前端 54 files/266 tests、typecheck 通过，后端与安装检查进行中。
  以上分属不同候选，不合并宣称 C5 或 C 总出口已完成；正式应用仍未替换。

### 2026-09-12 C 阶段集中出口核对

C1–C5 工程出口完成，2026-09-12 最终协调复审通过。复审核对必需项对应、此前源码边界和本轮执行证据，
并独立复核最终 Dev 摘要、严格签名及正式应用摘要；既定 OpenCode Dev 范围内未发现剩余必需阻断。
协调接受 d515 → 85e50b 两处前端修正后的受影响复测及未变证据复用，不把两候选写成每项均在 85e50b 重跑。
以下只描述 Dev 工程验收，不是用户再次验收、三路完成或正式发布；本次不派发 D 实现。

- 集中候选 `d515def706e2b5c9a795462d95dad05fd7df24a736ea2efad31ccbb1b7d47443`，后续仅两处前端修正的
  最终候选 `85e50b52472385ef00fee6b71acccbb77ed301030bc46457be82dfd66e2a161f`，均在 `/Applications/Farfold Dev.app`
  直接启动，无实验环境开关；安装与构建摘要相同、严格签名检查通过。后者清除 ACP 切旧 Server 的临时提示残留，
  并区分 Provider 的“当前会话连接”和“新对话连接”文案；后台安装、Provider、ACP、文件服务没有随此修正改变。
  按已批准的无相关变更复用规则，后者复测受影响切换及剩余必需项，不把不同二进制伪写成同一候选。
- 固定 OpenCode 仍为 1.18.30 / SHA-256 `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`；
  主验证始终使用公开 Zen managed connection `connection-b13cc0d65840f956606b33a6a10d870b1278eb3682ea2aeb09e04edb59996743`。
  设置中旧保存标签 OpenAI 只是标签，实际为 `https://opencode.ai/zen/v1` / `big-pickle`；没有据此宣称使用 OpenAI 后端。
- d515 普通本机安装入口可选择两条登记引用；从真实 HEAD `ec5f6c17956a5438928b6fb886e989fd0689f436`
  新建干净 `codex/c-stage-final-0912` Worktree，原 dirty 副本不改、不复制未提交内容。
  普通 Host 新建原生 `ses_f6b9dc142ffep3EvZQxj53BNEF` / Host `session-4dd64ad66da39380ddd8c79719c961b419ec14d6a0ee909479a9ed622051413a`，
  同主 managed 连接；真实两题 Other=Final QA、Files+Terminal 多选、native read/write 修改 result.txt，
  bash Allow once 输出 `C-STAGE-FINAL-TERMINAL-0912`。原生回执与配置版本匹配后 saved/applied/verified_success，输入清空。
  磁盘真实 diff 仅 result.txt；内容 `C-STAGE-FINAL-RESULT-0912`，无末尾换行。Agent 代码块、工具输出、Finder 定位、
  TextEdit 打开、真实基线 diff 和记录审阅均可用。记录审阅后外部追加一行，刷新预览显示新磁盘内容，仍明确非终止时正文。
- d515 Reject 写 `final-denied-marker.txt` 的请求：原生 bash error 明确为用户拒绝，文件不存在；随后原生提问可用、取消结束。
  Plan/Build 经 native config 回包切换。原生任务期间保存、模型、连接及断开按钮均锁定。
  待答问题时停止后立即退出，冷恢复同 Session，旧选项失效，输入计数仍为 1，不自动重发。
  另对已核实 Dev adapter PID 6518 注入退出故障；产品“核对原生状态”与“终止自有进程”确认退出并释放占用，
  原结果保留未知；续接同 Session 后真实返回 `C-STAGE-FINAL-AFTER-RECOVERY-0912`。故障手段本身不算恢复成功。
- d515 正常闲置断开后，只临时移动本次 Dev managed 程序到明确 QA 备份名。继续时报文件缺失，Host Session 数 18 不变。
  普通安装中取消得到“未启用新的安装”，下载临时文件已清理、备份保留；重试安装摘要与原件一致，再次继续原 managed Session。
  核对后仅删除该临时程序副本；没有移动或修改全局 Runtime、正式应用、私人认证。
- d515 合并后的“应用到新对话”用独立故障模型创建 `ses_f6b8b554bffet19NoC8rCQvM4r`，连接为既有 `connection-5f5c864cc587a565fe4f84585bda08d1817683a89b01261d2903ab91daf41298`。
  一次真实 APIError 后 saved/applied/verified_failure，验证版本与绑定版本相同，空闲且不重发；侧栏返回主 managed 连接成功。
- d515 旧 Server 会话能打开，但带入上一 ACP 恢复 notice；定位为 Server 只替换 timeline 未清临时状态。
  85e50b 在确认 Host 成功打开目标之后、加载该 Server 历史之前清空会话级临时状态，通用历史刷新不清状态。
  实际 ACP → `QA P6 OpenCode 并发 0909` → ACP 已复测；原 native `ses_f7cca3707ffeRlxd5tt4yvU4q1`、历史、
  GLM-4.5-Air / zai 模型和 `P6-OC-DRAFT-KEEP-0909` 草稿保留，旧 Server 不再显示 ACP 提示。未发送旧草稿或调用私人 Provider。
- 85e50b 同主 managed 连接的新文件边界会话 `ses_f6b7ff6a8ffed0Zh5YrUVPsXN0`，Host `session-7c018826a343e0ff9b2d790766ba9d115444922f07b33dfd564f046d1bf11606`，
  cwd 为 `codex-c-stage-files-0912-33ddf8190419`。干净基线上的真实任务只等待 native question；外部 QA 加入 binary.bin、
  2 MiB large.log、notes.txt 和指向另一个自有 QA 目录的 escape.txt。任务结束后四路径分别显示二进制、大文件、文本、越界。
  二进制明确不内联，2 MiB 文件明确超过上限，越界链接预览/差异/定位均禁用；这是外部 QA 变化，不是 Agent 文件工具能力证据。
  随后仅在该隔离副本注入 Git unmerged index，旧记录提示路径集合已变化；下一真实任务显示项目级“未跟踪 4 · 冲突 1”，不声称干净 Turn 成果。
- 同 85e50b / 文件边界 Session：一次 Always allow 后，两个独立 native bash 调用均输出 `C-STAGE-ALWAYS-0912`，
  没有第二次人工授权；冷启动后相同命令重新出现原生权限请求，Reject 后明确 native error。
  固定上游 `permission/index.ts` 的 approved 归属 InstanceState，按原生 always patterns 生效；Farfold 不保存扩大后的永久授权。
- 85e50b 对文件边界 Session 实际完成三次 quit → 冷启动 → 继续。三次均为同 native/Host/connection/cwd；
  `C-STAGE-COLD-DRAFT-KEEP-0912: do not send this draft.` 原样保留，原生消息中该草稿计数为 0。
  第一次同时检查原生持续授权重启边界，第二、三次不增加模型调用。d515 的冷恢复不计入这三次。
- 85e50b 普通目录选择/新建在非 Git QA 目录 `qa-projects/c-stage-file-boundary-0912` 成功，原生 `ses_f6b74dd26ffe33O5CAR9fvGEFS`；
  真实返回 `C-STAGE-NON-GIT-0912` 与相对文件引用。详情显示“当前目录不是 Git Working Copy”和“仅项目级状态”，未制造 Turn diff。
  原文件边界会话的未发送草稿未转移到新会话。Cmd+K 搜索焦点、原生文件选择、菜单模式、多选/Other、忙态禁用和可读失败提示均实际操作；
  结果、代码块和差异截图可读，未见本次验收中的遮挡。没有据此声称完成全面辅助技术认证。

| 必需项                 | 证据与退出范围                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 安装/身份/取消/修复 | d515 同候选上述可见流程；固定程序/摘要及登记身份核对。多版本不匹配、原子安装与提交失败清理沿用未变的安装合同测试                                                                                                                                                             |
| C2 保存/应用/真实请求  | d515 同主连接成功及独立失败连接；85e50b 新会话继续复用。活动时修改入口禁用，固定任务版本/旧回执/错误目标由 managed_provider、turn_coordinator 合同测试核对                                                                                                                   |
| C3 原生交互与停止      | d515 多题/Other/多选、once/reject、取消/停止/异常恢复；85e50b always 及原生重启作用域。旧请求/generation/重复答复/未知占用由 ACP 与交互合同测试核对                                                                                                                          |
| C4 用户可见成果与异常  | d515 文件/命令/代码块/打开/定位/真实 diff/外部编辑；85e50b 二进制/大文件/越界/未跟踪/冲突/非 Git 可见状态                                                                                                                                                                    |
| C4 公共 fs/terminal    | acp_client_resources 与 acp_transport 合同覆盖边界、符号链接、外部读写冲突、输出上限、异步等待、kill/release 和退出清理；固定 OpenCode 未实际调用这些 Host 回调，真实工具仍由 OpenCode 自己执行                                                                              |
| C5 恢复与入口          | 85e50b 同候选三次身份/草稿一致、ACP/旧 Server 切换；d515 缺失不新建与取消中退出不重发。实验写命令/重复面板/新 Server 路径已删，旧已绑定 Server open 保留                                                                                                                     |
| 公共并发/事件/资源     | 既有 typed Host/ACP 合同测试覆盖两活动任务与 Working Copy 排他、来源/代次隔离、取消/未知、限流与资源撤销；不以 OpenCode 一路宣布 Pi/Codex 迁移完成                                                                                                                           |
| 可选与未宣告能力       | 本候选仅文本 prompt；不宣告图片/附件输入、OAuth、完整 slash/compact/扩展/MCP 管理。阶段 A 的候选协议路径不是既有产品验收，非文本输入明确拒绝，不假装已支持                                                                                                                   |
| 检查与数据保护         | format:check、typecheck、前端 54 files/266 tests、build、cargo fmt/clippy、后端 390 passed/16 ignored；85e50b 两处前端修正后再跑全部前端与打包。Dev 数据 integrity_check=ok，原配对备份保留，正式 hash 始终 c7750c4406075330d83e9c8ad3f7ee3d844113186de034d9160363d08cdd7820 |

保留限制：公共文件读版本检查不是跨进程原子 CAS，进程组不是完整命令沙箱；不能保证收束主动脱离组的任意外部工具。
Turn diff 比较记录基线与当前磁盘，不存终止时文件正文，已审阅是记录标记。旧 Pi 启动超时与一次 ACP EOF fixture 波动仍是未解释观察；
成功复测不等于根因证明。主包去随包、三路最终配对恢复/正式替换仍属于 F/G，不在本次 Dev C 结论内；D/E/LifeModel 未启动。

### 2026-09-12 D 首片：Pi 候选核验与路线决策

本节晚于上述 C 收口：用户追加授权继续 D、随后 E，协调已转达；D 首片完成候选核验，不是 D 工程完成。
协调确认自有 Pi 适配器属于需单独明确的长期维护责任，不能外推 OpenCode adapter 授权。生产适配器未写，旧 Pi 路径未删，E 未启动。

#### 固定证据与实测

- Pi `0.84.3` 源程序与 Dev 程序摘要均为 `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`；
  固定来源仍是 fetch-pi-sidecar.sh 中官方归档，未安装/升级用户 Pi。
- [npm 最新发布元数据](https://registry.npmjs.org/pi-acp/latest)仍为 `pi-acp@0.0.33`，发布源码 gitHead
  `1bfcb394088ed879db8fd936b570bb626017f878`；integrity 为
  `sha512-vX9kY1tK14E72G4dBAx+RGCk/k7XPjTHls6dLUxA8WSkBav6B6JHuSBv3eusp50LCR/GTRsR2kIKsG0Z5jANzw==`。
  下载后 dist/index.js SHA-256 为 `24ff73fda6e3c76ddce2d359a79f5c4b8f292eb290e4d2ab85aac94676b2c2dc`。
  本次 main HEAD 为 `d1cffc047ab37a096ee70ca39cfc1de463db8d12`，不是实测发布包身份，未据此替换候选。
- 隔离依赖精确 `@agentclientprotocol/sdk@0.26.0`、`zod@3.25.76`，只安装到 gitignored target，禁用安装脚本；
  Node `22.22.3`，仓库已有 Node 程序 SHA-256 `5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c`。
  此固定组合是核验候选，不是已批准的生产组合。
- 新增可复现 `scripts/pi-acp-candidate-probe.mjs` 与 `scripts/fixtures/pi-acp-capability-probe.ts`：
  HOME、Pi agent/session、XDG、cwd 全部隔离，不继承 Provider 环境；只有本机拒绝模型请求的 fixture endpoint，真实请求计数为 0。
  首次 `probe-WEDgH7`、补断言后的 `probe-9YFNlx`、显式仓库 Node 的 `probe-gR7830` 结果一致；
  结果保存在 `src-tauri/target/d-stage-pi-candidate-0912/<probe>/result.json`，不是新的治理系统。
- 相同原生扩展命令：native RPC 返回 selected=Two、confirmed=false、输入正文和多行编辑正文；ACP 保留前两项，
  input/editor 自动 cancelled，结果 null，并出现两条 unsupported 通知。native 九类 UI 均出现，ACP 无四类状态更新。
  脚本对内容、事件种类、两次 permission、两条拒绝提示及零模型调用作断言，而非只检查退出码。
- 发布源码 Session.prompt 的 busy 分支只进入 adapter 队列，没有 steer/follow_up RPC 方法；这是静态证据，未冒充真实模型干预实测。
  native 扩展命令 prompt 已返回成功，ACP 在最终通知后 250ms 观察窗内未返回 prompt；仅记未结算观察，尚未证明永久挂起或取消失败。
- 模型配置显示 `d-local-probe/fixture-only`，思考档位仍为 adapter 固定列表。未验真实 Provider、持久恢复、取消、Host 接入、安装界面；
  两路探针退出时只结束自己新建的进程组。正式/Dev 应用均未替换，原 C 结论不变。

#### 可决策的路线

**建议：在固定 pi-acp 上游源码上维护有限扩展，作为独立 ACP adapter 分发；不是重写 Pi，也不是重写整套 ACP。**
发布包只导出可执行入口，没有供外挂补丁使用的 SessionManager 公共 API；单加一个外层代理不能可靠修复已在内部取消的 UI、原生排队与结算。
因此该路线意味着维护适配器源码分支、保留 MIT 许可与来源，争取回馈上游；目前没有发起上游提交或承诺上游采纳。
若补齐过程中证明必须推翻主要结构，先重新提交方案，不默认转成全新 Rust/TypeScript 适配器。

| 范围                       | 复用或有限新增，尚未实现                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标准 ACP                   | 复用 SDK 的 initialize/new/load/prompt/cancel、session/update、config options；复用上游 Pi RPC 进程、原生历史/工具投影。历史合成内容保留缺失标记，禁止制造另一份原生历史                                                    |
| 原生干预                   | 协商版本化 Pi 能力，新增建议 `_pi/steer`、`_pi/follow_up` 方法，严格映射两个官方 RPC；回包只代表原生接收，queue_update 表示排队，agent_settled 才可结束任务。方法名待接口复审，不伪称 ACP 标准                              |
| select / confirm           | 复用标准 form elicitation，枚举选项和布尔值分别映射；false 与取消严格区分，不再把全部扩展选择当工具授权。真正的权限含义仍归扩展/Runtime                                                                                     |
| input / editor             | 同一 elicitation 通道传字符串，保留 placeholder、prefill、空字符串、多行及取消；Pi 原生方法/请求 ID/timeout 放版本化元数据；复用 ExtensionDialog 的输入/编辑呈现                                                            |
| notify                     | 保留 level/message 的 Pi UI 通知，不冒充 Agent 答案文本；复用现有通知显示                                                                                                                                                   |
| setStatus / setWidget      | 协商 Pi UI 通知扩展，保留原生 key、清除语义、行文本和 placement；复用现有状态/组件呈现                                                                                                                                      |
| setTitle / set_editor_text | 同一 Pi UI 通知扩展保留标题与草稿更新；只落在当前绑定，切换/退出后旧代次不能修改当前界面，不自动发送草稿                                                                                                                    |
| 原生模型/配置              | set_model 与 get_available_models 继续走官方 RPC；思考档位改读 get_available_thinking_levels，不使用固定全列表。共享 Provider 复用版本/投影记录，在对应隔离 profile 写受管字段，原生来源不被覆盖                            |
| Host 与工作台              | 复用 AcpTransport、RuntimeEventRouter、TurnCoordinator、InteractionRegistry、安装登记/下载、文件/终端/TurnChanges。Pi 专属事件在 adapter 边界转 typed 投影；PiWorkspace/ExtensionDialog/Composer 复用，不复制第二个控制中心 |
| 生命周期与隔离             | 一个自有连接绑定 Pi 程序摘要、原生 Session/file、cwd 和配置代次；修正上游 new/load 的隐式 closeAllExcept 与随机身份兜底风险。复用 Host 恢复/未知状态，不用强退当取消成功                                                    |

**具体新增与维护责任：** 一个固定上游 adapter 源码/构建包及其差异测试；一个薄 Pi ACP Host 接入边界（不复制连接/任务 authority）；
既有 Pi UI 数据源改接共享 Host；受管 Pi profile 的 Provider 应用边界。现有 managed_provider 的版本校验/API 映射可复用，
但目前通过 PiCapabilities 写入，不能直接宣称已绑定新的隔离 ACP profile；须定向改造和验证。
Node 可复用现有 `22.22.3` 运行时，当前依赖组合先保持精确锁定；需改变 SDK/Pi/Node 版本时先核对协议、分发摘要、许可/安全与能力差异，
再跑受影响合同与真实对照。上游修复可逐项吸收；私有扩展数量、会话/取消语义及 RPC UI 更新会成为持续维护触发项，不编造工时。
该 adapter 不嵌入 Pi Agent SDK/循环，使用选定官方 Pi RPC 程序；F 去随包目标保持不变。

**替代：等待上游补齐并保留 Pi 未迁移。** 不新增适配器源码维护，但没有可承诺的上游完成时间，D 不能完成；已有原生 Pi 仍可用。
不选“直接接原包并隐藏缺口”，也不使用 Host 原生旁路补齐。是否调整 D/E 顺序需另行决定，本首片不启动 E。

**最小验证与退出：** 批准后先做隔离能力协商与上述九类 UI 的原生对照、steer/follow_up 顺序及取消/旧回复/EOF 合同；
核对纯扩展命令结算、真实模型档位、配置版本/隔离文件和原生 Session 失配拒绝，再接普通 Host/UI。
D 出口用固定真实 Pi、真实受支持 Provider、同候选 Dev 应用验新建/任务/插话/跟进/交互/停止/故障/三次冷启动/成果，
复用 C 未变的公共测试证据但不替代 Pi 实测。只有受影响能力全部达到既有接受边界，才在同一验证切片删除被替代路径。
Pi RPC 官方已明确不支持的任意 TUI custom/footer/header 等维持受限，不扩大本次保留义务。

复现依赖安装：`npm install --prefix src-tauri/target/d-stage-pi-candidate-0912 --ignore-scripts --no-audit --no-fund --save-exact pi-acp@0.0.33 @agentclientprotocol/sdk@0.26.0 zod@3.25.76`。
运行：`src-tauri/capability-bridge/runtime/node scripts/pi-acp-candidate-probe.mjs`。
源码依据为固定发布包及 sourcemap、仓库固定 Pi `docs/rpc.md`/`docs/models.md`、`src/runtime/pi.ts`、`PiWorkspace.tsx`、
`ExtensionDialog.tsx`、`managed_provider.rs` 与公共 ACP/Host 模块。
探针语法、fixture 定向类型检查及全仓 format:check 通过；本片未改生产实现，未重复 C 的全量测试/打包。
2026-09-12 最终协调有限复审通过：候选损失证据与决策材料足以作一次具体选择，无缺失的决策必需项。
这不是生产适配器授权；协调负责向用户说明维护责任并提出选择。本片收口于此，等待路线选择，不再重复探针或启动 E。

### 2026-09-12 D 适配器实施：交互与终态切片

本节晚于上述决策材料：用户已明确选择推荐路线，授权在固定 pi-acp 上游上维护有限扩展及所述长期责任。
等待路线选择的门槛解除；不从零重写，不修改 Pi 本体。以下为实施中证据，尚未接普通 Host/UI，不是 D 出口。

- `src-tauri/pi-acp-adapter` 导入固定 `1bfcb394088ed879db8fd936b570bb626017f878` 源码、MIT 许可与原测试，
  归档 SHA-256 `1fc83aa7247368bbddef410a67cc56317f9cb0fd6df54c343af27a7f36b16dc3`；保留上游格式及来源说明，
  没有导入发布工作流或无关 smoke 脚本。包为私有 `0.0.33-farfold.1`，SDK `0.26.0`、Zod `3.25.76` 精确锁定。
- `PiUiBridge` 以 form 保留 select/confirm/input/editor 的原生值、false/空字符串/多行及取消；五类通知走 `_pi/ui`，
  不转成 Agent 答案、不对 fire-and-forget 发取消回执。删除原 permission 伪映射、input/editor 自动取消和重复辅助方法。
  请求绑定 native Session 与原生 ID；取消/超时/连接关闭后拒绝迟到答案，重复 ID、越界尺寸和不合 schema 回答受检。
- initialize 协商 `farfoldPi.version=1` 与 form；未协商不能新建/恢复/干预。`_pi/steer`、`_pi/follow_up` 原样映射官方 RPC，
  只对本连接已活动的 native Session 生效；普通 prompt 忙时明确拒绝，删除 adapter 自有排队路径，排队语义归 Pi。
- `get_available_thinking_levels` 替代固定全档位列表，设置前后核对原生支持与实际生效。
  纯扩展命令的 prompt ACK 必须结合原生命令来源和明确 idle 状态才能结束；启动 Agent 的扩展仍等待真正终态。
- 协调早期复审发现上游按 settled/取消意图直接判成功或取消的问题。现 `PiTurnOutcome` 保留最新 assistant stopReason：
  原生 error 明确失败，retry 后成功以最后实际结果为准，失败 abort/无完成依据保持 unknown；不泄露 provider 原始错误正文。
  EOF 使本连接任务结果未知，迟到 settled 不可覆写；CLI 持有真实 Agent 对象并在输入关闭时释放自有 Pi，而不读取不存在的 SDK 私有字段。
- 新增交互与终态合同，并更新受影响上游测试的显式协商、原生模型档位和 message_end 证据；没有降低生产判断以迎合旧 fake。
  adapter **116 tests 通过、0 忽略**，typecheck/build 通过；未重跑无关 Farfold 全量打包或替换 Dev/正式应用。
- 复用隔离探针新增 `--farfold`，不重复上游损失探针。最新 `probe-WlE8rR/result.json`：固定 Pi 经新 adapter
  四个 form、五个通知均保留；selected=Two、confirmed=false、input 正文和 editor 多行正文一致，纯扩展 prompt 返回 end_turn。
  非 reasoning fixture 只给 off；idle steer 以原生活动任务条件明确拒绝，0 模型请求，不冒充真实 Provider 任务验收。
  首次新适配器实测发现 SDK 不自动补自定义方法的下划线，已统一 `_pi/*`；后一次探针把 SDK error.data 误当 message，
  修正断言后通过。两项均有具体原因，不用重试掩盖结果。

本片仍在继续：Session/file/cwd/配置隔离、恢复失配拒绝、UI 取消/超时后对端待答请求清理需继续核验；
116 项与无模型正信号不构成整条 Pi 接入完成。已有 Pi 路径、日用数据与正式应用保持不变，E 未启动。

### 2026-09-12 D 适配器实施：身份、回放与撤销

- 新建必须取得真实 Pi `sessionId/sessionFile`，无状态、非绝对文件或重复原生 ID 均失败并释放本次进程，不再生成替代 ID。
  恢复前有界读取原生 JSONL 文件头并核 ID/cwd；缺失、空文件、错误身份拒绝启动。启动后再次核 get_state 的 ID/真实文件路径，
  失配即关闭本次进程、保留原绑定。固定 Pi `_setSessionFile` 对缺失/空文件可初始化新会话，这是前置检查的直接依据。
- 移除上游 closeAllExcept。空闲同会话 load 复用本连接；不同 cwd 不改变绑定，活动任务不能回放。
  独立复审进一步发现 load 先等待历史、prompt 后进入仍可能交错；新增仅覆盖回放期的 Session 占用，finally 释放，
  prompt 从恢复返回后二次核查。同 Session 重复 load 明确拒绝，不新增任务队列。可控 getMessages 和反向竞争测试通过，P2 经有限复审关闭。
- 适配器引用表置于当前 `PI_CODING_AGENT_DIR/farfold-acp`，与原生历史分离且不跨 profile 共用；显式原生
  `PI_CODING_AGENT_SESSION_DIR` 优先于 settings。引用表损坏明确报错、不覆盖证据，写入用私有临时文件后原子替换。
  新建后模型探测失败只清自有引用和进程，不删除 Pi 原生历史或扩展写入。
- `_pi/ui_withdrawn` 携带 version/sessionId/nativeRequestId/reason；取消、超时和连接关闭使旧答案失效。
  本地等待结束不释放远端待答计数，直到原 ACP 响应到达或连接终止，防止连续超时绕过 16 个未结束请求上限。
  Host 的义务是匹配本连接代次及原请求，撤卡并回 ACP cancel；目前仅适配器和探针履行，普通桌面 Host 尚未接入。
- adapter **130 tests 通过、0 忽略**，日志 `adapter-tests-r7.log`；typecheck/build 通过。身份首轮 10 条旧测试失败源于
  测试替身未表达连接存活属性，补齐后对应合同通过；没有用生产兜底绕过校验。
- 真实固定 Pi/Node/SDK 探针 `probe-YC11bg/result.json`，0 模型请求：新建、缺失文件拒绝、原生 ID/路径/cwd 冷恢复、
  第二会话与原会话隔离、四类 form/五类通知、原生 timeout 和迟到 accept 丢弃通过。原生 Session
  `01a094d4-10e8-732a-bbda-c5da51d7511c`。纯扩展没有 assistant，因此 Pi 尚未落盘；探针仅向隔离原路径播入有效 header，
  这是**真实 Pi 加载夹具身份**，不是模型任务历史持久化验收。Pi 原生补写 model_change/thinking_level_change，文件头身份保持不变。
  较早 `probe-K8tyAp` 的整文件字节不变断言因此失败；检查实际追加内容及固定 SDK 初始化源码后改成准确的文件头与身份断言。
  `probe-5NJRo1` 验身份，后续 `probe-YC11bg` 增补真实 timeout/撤销；不把断言修正叫作 Runtime 修复。

下一工作是公共 Host 接入和配置/安装/事件投影复用。适配器身份与终态有限复审通过不等于 D 出口；
真实 Provider、普通工作台待答卡片、安装应用和完整冷历史仍待验收。正式/Dev 应用、本机 CLI、既有 Pi 日用数据未替换。

### 2026-09-12 D 公共 Host 首片：操作保护、交互与撤销

- 从 OpenCode 连接提取 `AcpSessionOperations`：同连接 new/load 占用、操作 token 与最新配置响应筛选共用；
  原 OpenCode 字段和重复控制块删除，connection generation/binding/native Session 检查仍由原 Host 保留。
  Close 只用于现存测试，不宣称产品已有通用关闭入口。`AcpRuntime<C>/AcpLifecycle<C>` 复用连接状态、启动锁与代次容器，
  OpenCode 已改用；不同 Runtime 实例不共享可变连接，不新增任务队列或另一套 Agent 循环。
- Pi ACP form 的版本、原生 UI envelope、schema、原生 Session 一致性由 `pi_acp_interactions` 校验，
  接入既有 InteractionRegistry；可选 piAcp 快照分开保留 ACP requestKey、nativeRequestId、nativeSessionId、原始 event。
  Pi 表单仍是 Pi ExtensionDialog，不冒充工具授权。跨 Session、错误请求 ID、旧代次撤销不能删除当前待答。
- 有限复审指出测试局部 held 映射不应进入生产。现公共 `route_acp` 在登记删除前从现有 Registry 取得完整标识，
  经同连接 AcpTransport 的原 client_requests 表匹配 Session/form 并发送 cancel；已回答/正在回答幂等处理，不重发。
  然后才按原生 withdrawal 标 Stale、撤卡；这不是任务成功/取消完成。OpenCode 事件泵也改用该公共入口，Pi 差异仍在专属解析模块。
  无效表单/协议无法登记时终止自有传输并在确认退出后发 lifecycle terminated，避免遗留无法回答的等待；原坏 envelope 仍保留。
- Rust 固定 Pi 合同显式执行通过，后续版本直接调用生产 `route_acp`，不再靠测试第二份映射或手工撤销响应：
  四类 form、single-flight、原生 timeout、自动结清原 ACP 请求、迟到/重复答复拒绝、跨 Session/旧代次无效撤销均通过；0 模型请求。
  该合同日常默认 ignored，因为依赖固定本机 Pi/Node/构建 adapter；本次已经用 `--ignored` 指定执行，不能把其他 ignored 一并算作通过。
  使用的是公共 Host 组件合同，不是 Tauri 普通 Pi 工作台验收。
- 定向验证：ACP 筛选 **73 通过、14 忽略**（`host-acp-regression-r2.log`），另显式执行其中固定 Pi 合同 **1 通过**；
  既有交互登记 **14 通过**；前端 Host shadow/交互回复 **2 文件 25 通过**；类型、Rust 格式与 clippy `-D warnings` 通过。
  更早 OpenCode 定向 **24 通过、8 忽略**，与后续 ACP 筛选有重叠，不相加当独立覆盖。
  初次新增 Registry 测试缺少局部 RuntimeBinding 导入，修正后编译和测试通过；未改变生产逻辑迎合测试。
- 实时校验已安装执行文件仍为 Dev `85e50b52472385ef00fee6b71acccbb77ed301030bc46457be82dfd66e2a161f`、
  正式 `c7750c4406075330d83e9c8ad3f7ee3d844113186de034d9160363d08cdd7820`；本片没有替换应用或触碰日用配置/历史。

下一片继续普通 Pi ACP 启动与 Session 注册、隔离 profile/受管 Provider、标准事件及原生 UI 工作台接线。
现有 OpenCode Provider 回执验证仍含其原生 `msg_` 身份合同，Pi 不得伪造兼容 ID；应复用 Host 保存/应用/请求分层，
在 Pi 边界提供自身原生证据。未完成整个公共 Host、Pi 迁移、真实 Provider 或 D 出口，旧 Pi 可用路径继续保留。

### 2026-09-12 D 接线基础：终态结清、身份响应与公共启动

- 受控测试复现：原生 agent_settled 已到而 Host 尚未回复已撤销表单时，原 finishTurn 会提前完成。
  PiUiBridge 现等待本地处理和原 ACP form 的实际响应；EOF 中断等待并保持 unknown，迟到答案不回写 Pi。
  finishTurn 等待后重查本任务占用和原生结果；没有固定延时或新 Agent 循环。新增原表单结清、等待中 EOF、纯扩展最后通知三项测试。
  Rust 真实 Pi 合同改成 **prompt 返回即无 unresolved**，不再在响应后循环等待。该修复已获独立有限复审通过。
- session/new 与 session/load 通过 `_meta.farfoldPi.nativeSession` 返回 version、原生 sessionId/sessionFile 和绑定 cwd。
  适配器重新读取 get_state 并与已有引用核对，身份/文件漂移拒绝；新建失败关闭进程并仅删自有引用，回放失败关闭进程但保留原绑定。
  普通 Host 不需要读取 adapter 私有映射取得身份。未落盘的新 Pi Session 仍是原生状态事实，不由 Host 编造文件或持久化成功。
- 固定 Pi 探针 `probe-mWlCzK/result.json`：原生 Session `01a094fc-9a2f-7531-9ef4-286acce1ad3e`，
  新建/冷加载的 ACP 身份响应一致，缺失文件拒绝，四类交互与 timeout/撤销通过，0 模型请求。
  冷加载仍使用夹具播入的有效文件头，只证明真实 Pi 加载和身份协议，不是模型历史持久化验收。
- `acp_runtime::initialize_transport` 复用自有进程启动、Host 文件/终端能力、initialize、协议和固定适配器版本校验，
  错误时显式确认进程清理。OpenCode 生产启动和固定 Pi 合同使用同一入口，删除原重复启动/校验块；
  原生 Runtime 二进制版本/摘要仍由各自安装边界校验，不能用 adapter 自报版本代替。
  缺失/错误版本、协议失配、超时合同检查子进程 PID 已退出；未知扩展能力保留测试通过。
- 最新 adapter **135 通过、0 忽略**，日志 `adapter-tests-r10.log`；typecheck/build 通过。
  ACP 筛选 **75 通过、14 忽略**，日志 `host-acp-regression-r3.log`；固定真实 Pi 合同另已指定执行 **1 通过**。
  公共生命周期/启动 3 项含在筛选结果内，不重复相加；clippy `-D warnings` 通过。
  身份响应与公共 initialize 提取获协调有限源码复审通过；复审没有另跑上述测试或 C 全套。全仓 format:check 通过。
  此次不跑无关三路全量打包和安装 UI，不调用私人 Provider。
- 安装身份复核仍为 Dev `85e50b52472385ef00fee6b71acccbb77ed301030bc46457be82dfd66e2a161f`、
  正式 `c7750c4406075330d83e9c8ad3f7ee3d844113186de034d9160363d08cdd7820`，没有替换应用。

剩余工作不变：普通 Pi ACP profile/受管 Provider、公共 Session 注册/生命周期命令、标准事件与原生 UI 工作台，
以及固定真实 Pi/Provider/同候选安装应用的 D 集中出口。旧 Pi 路径与日用配置/历史保留，E 未启动。

### 2026-09-12 用户暂停与文档一致性校正

用户在 D 接线基础切片后明确要求暂停开发；执行任务已确认无在途命令，协调已将自动续接置为暂停。
随后用户单独授权核对、更正文档，不构成恢复代码实施、测试、构建或安装的授权。

本次只校正文档：README 的三路范围/正式版本/活动计划入口；AGENTS、PRODUCT 与活动计划中的暂停、D 部分进度及历史 schema 边界；
规格/研究索引/能力矩阵中的历史基线与后续已批准路线区分；早期 Pi-only 报告与架构 HTML 加历史时效说明。
不重写历史实验结果，不另建活动计划或重复报告。正式三路支持与三路 ACP 迁移完成是不同结论；普通 Pi ACP 工作台仍未接通。
代码边界通过 lib.rs 注册、PiWorkspace/piRuntimeAdapter、managed_provider、Host schema 常量与本节之前的实现逐项核对。
Dev 和正式执行文件摘要与前节相同；未修改应用实现或安装包，没有重跑 Runtime/模型/桌面测试。
当前读者先看活动计划，再按需读规格和实施证据；历史材料不能覆盖最新用户暂停与数据保护指令。

### 2026-09-12 已授权文档冗余清理

用户授权删除可确认冗余的文档。经内容与引用核对，删除旧《下一阶段开发交接》：五块目标、职责/差距、依赖顺序、数据边界和验收要求已由现有规格与唯一活动计划承接；原生候选依据仍在研究索引、能力矩阵和实施记录中。该旧交接文件没有其他文档引用，不再保留重复执行入口。

同时删除三张未被引用的报告排版预览 PNG 和五个可重建的 fontconfig 缓存文件，共9个文件。保留 fonts.conf 指向的缓存目录及生成脚本；保留正式报告、可编辑图源、原始代码/运行验收证据和历史方案记录。未修改应用代码、安装包、项目、凭据或日用数据；开发及自动续接继续暂停。

### 2026-09-12 恢复 D 与同任务续接核对

用户明确恢复 D 开发；其后短暂提出换任务，又明确无需在没有必要时更换，协调撤回换任务停写安排。未创建新任务。
恢复读取与短暂停止期间只核对文档和相关源码，没有新增实现、测试或构建，也没有在途命令或数据清理。
继续使用 `/Users/tw/Desktop/farfold`，分支 `main`；保留整个未提交工作区，不重建已删的交接文档。
当前入口同步为已恢复，旧暂停/文档校正/清理记录保持历史原意。上一片 135 项 adapter、75 项 ACP 与固定 Pi 合同为已有证据，并非此次重新运行。
下一具体工作：独立 Pi ACP profile 与已有 Provider 连接版本的应用，接入同一 Host 配置/会话/工作台机制。
普通 profile、Provider、Session 注册、工作台与同候选安装应用 D 出口尚未完成；旧 Pi 路径与正式应用继续保护，E 未启动。

### 2026-09-12 D 恢复实施：共享 Provider profile 准备

- 新增 `acp_provider_profile.rs`，从 OpenCode 提取已有 Provider 版本读取、私有目录/配置准备及公开绑定类型，删除原重复实现。
  OpenCode 生产启动调用共享服务，保持原 profile 地址、临时配置布局、原生 JSON 和请求验证门槛；未另建 Provider 保存 authority。
- Pi profile 地址按完整 Runtime 产品/安装/构建/Adapter/连接身份及 Provider 连接/版本派生。
  新建拒绝已过时版本，恢复允许引用原会话版本；不同版本或安装隔离，已有 settings 与原生 history 保留。
  models 配置漂移、缺失、损坏或符号链接明确拒绝，不覆盖原生/用户修改；旧 Pi RPC profile 不进入此服务。
- 固定 Pi 0.84.3 的 `docs/models.md`、官方 `resolve-config-value.js` 支持 `$ENV`。
  Pi models.json 仅保存 `$FARFOLD_PI_MANAGED_KEY` 引用，真实值只放入待传给自有进程的环境集合；准备对象不序列化、不实现 Debug。
  chat-completions/responses 映射及原有模型能力/兼容参数保留，不把配置准备成功写成 applied 或请求验证成功。
- 固定真实 Pi 合同改用 Host 保存的夹具 Provider → 共享 profile → 自有进程 env_clear/envs → 公共 initialize，
  核对 ACP configOptions 中实际模型，再验证原有四类 form、原生 timeout 与响应返回即结清。指定执行 **1 通过，0 模型请求**。
  这证明配置准备与原生模型选项读取，不证明一次模型请求实际使用了凭据，也不是普通安装 UI 验收。
- profile 定向 **2 通过**（`host-profile-pi-r2.log`，包含完整安装身份隔离补测）；OpenCode 筛选 **25 通过、13 忽略**
  （`host-profile-oc-r1.log`，含 Registry 相关筛选，与旧统计不累加）；clippy `-D warnings` 与 Rust 格式检查通过。
  初次编译发现当前 sha2 返回值不支持直接 LowerHex 格式化，改用仓库既有 `derived_host_id` 后通过；未变更 Runtime 或降低验证。
- 协调对 profile、OpenCode 生产调用、固定 Pi 环境与模型合同进行了有限源码复审，无新增阻断；没有重跑 C 全量。
  本轮不替换 Dev/正式应用，不改用户 CLI、凭据或日用历史。后续普通启动必须在同一连接启动锁内准备 profile，
  只向自有进程传 environment，恢复使用已绑定 Provider 版本；不能以当前 Provider 配置悄悄替换旧会话身份。

准确续接点：将该服务接到普通 Pi ACP 连接启动及公共原生 Session 登记，再接 Provider 原生应用/请求证据和现有工作台。
本切片未实现普通 Pi ACP 工作台入口，也未完成 D 集中出口；不能以底层合同代替产品接入。

### 2026-09-12 D 普通 Host 启动与原生 Session 登记

- `pi_acp.rs` 接入现有 `host_session_create/open` 的 Pi Adapter 选项，复用公共生命周期、启动协商、操作保护、Provider profile、Session 注册与导航。没有独立实验启动命令，也没有新增 Agent 产品或 Host RPC 旁路。普通前端启动面板和 PiWorkspace 尚未切换到此路径。
- 公共 `acp_runtime` 提取单一事件泵，OpenCode 与 Pi 使用同一连接锁下的 drain/route；保留原 OpenCode 事件处理，不新增并行事件 authority。固定 Pi 0.84.3、Node 22.22.3 和本应用构建的适配器文件校验后启动；Tauri 资源与构建脚本增加自有 adapter，未执行应用打包。
- 过渡 Pi ACP 安装/构建/连接与旧 Pi RPC 分离，原生 Pi 程序仍用已固定的随包资源，去随包仍属 F。Provider 配置版本进入连接身份；恢复从原绑定完整身份找到历史版本，不随当前保存版本替换。环境清空后只传自有配置、凭据和绝对工具 PATH，补齐 macOS arm64 Homebrew 路径；不导入默认认证或历史。
- 新建及加载核对 adapter 返回的 version/sessionId/sessionFile/cwd、原目录边界和实际文件头；错误身份或模型不登记。空会话使用公共 Session 登记但无原生文件 locator，明确不可冷恢复，不造文件；已连接原会话可以返回。文件落盘后的观测可补 locator，完整真实任务刷新仍待下一片接线。
- configOptions 实际确认 Provider 模型后才记 Applied，Request 仍 NotRequested。固定真实 Pi 的新启动/登记定向 **1 通过，0 模型请求**；空会话无 locator。另一个冷加载测试播入的是协议夹具头，不能作为真实模型历史持久化证据。
- 新模块最终定向 **6 通过、1 默认忽略**；上述固定 Pi 合同另用 `--ignored --exact` 指定执行。公共 `acp_` 筛选 **62 通过、14 忽略**，该筛选不包含 `pi_acp::tests`，与早期不同筛选的 75 不直接比较。Adapter 官方 trust 参数映射 **1 通过**；typecheck/build、Rust clippy `-D warnings` 通过。
- 命令、工具会话号和实际结果摘录保存于 `src-tauri/target/d-stage-pi-candidate-0912/host-startup-registration-summary-r1.log`。它是已完成输出的摘要归档，不冒充完整 stdout，也未为保存日志重跑测试。首轮测试的私有函数/PathBuf 编译错误及修正一并保留。
- 协调只读复审提醒两处边界，均修正并有限增量复审通过：确认退出后，即使事件发布失败也释放生命周期、尝试发布 terminated 并保留错误；死连接的精确停止不再被 running 条件挡住。新增夹具验证再次清理和重新启动可达。PATH 保留工具可用性但不继承其他环境配置。

本包未打包、未替换 Dev/正式应用、未改用户 CLI 或日用数据。工作台、真实 Provider 请求投影、模型切换续接与同候选安装应用 D 出口尚未完成，旧 Pi 可用路径保留。继续下一包的原生事件保留、有限只读工作台快照和现有 PiWorkspace 接线。

### 2026-09-12 D 工作台读取合同与历史限额

- Adapter 新增 `_pi/workspace` 七个只读 section：state/messages/entries/models/thinking_levels/commands/stats；拒绝任意命令、额外参数、非活动 Session 和回放占用。每次读取前后核对原生身份，state 数据自身也核对。返回 Runtime 原始数据及未知字段，不拼造另一套历史。
- `_pi/event` 在已接入 Session 的原生事件回调中保留 version/sessionId/原始 event，含未知事件；标准 ACP 更新继续保留。该实现不证明进程启动早期、尚未订阅时的事件已完整保留；该旧观察仍待原生能力对照。
- Host `pi_acp_workspace` 只接受 typed section 及完整 Farfold/native Session/代次输入，返回时再查连接身份；读取同一原生文件后补公共 locator。夹具验证未落盘时不造文件、后续同文件落盘可补登记，固定真实 Pi 七种读取 **指定执行 1 通过、0 模型请求**。尚未接普通 PiWorkspace，不能把 Tauri 命令存在等同 UI 可用。
- Pi 原有 bulk 读取上限为 16 MiB，公共 ACP 默认为 1 MiB。新增显式 Pi `NativeHistory` reader 限额，保留 OpenCode 默认值、1 MiB 写入/事件队列限制；关联 bulk 响应不进入事件队列。七个 section 分别读取，避免重复历史合并进一个过大的响应。超过读取限额明确失败，不宣称无限或任意尺寸无损支持。
- 独立只读复审发现本包新增 P1：较大 reader 可接入超过 1 MiB 的反向表单/权限，旧处理先登记 pending 再被 queue 丢弃。首轮失败被 cleanup unwrap 遮住；修正测试诊断后实测 **pending=1、可见事件=0、dropped=1**。随后在 receive 的有 id 请求分支、任何 client/resource 登记之前校验大小，以原始 RPC id 明确返回 -32602，不扩大队列、不静默等待。超大通知则单独计 drop，不生成 pending。
- P1 修后指定测试 **1 通过**，含 permission/form 两种请求；随后 transport 定向 **19 通过、0 忽略**，包含 bulk/默认限额/超大通知/超大控制请求和既有资源/EOF合同。Adapter 全套 **138 通过、0 忽略**；Host workspace 模块 **7 通过、1 默认忽略**，固定 Pi 合同另已指定执行。各筛选有重叠，不能相加为独立覆盖。
- 准确命令及结果摘录在 `src-tauri/target/d-stage-pi-candidate-0912/host-workspace-read-summary-r1.log`；记录首次失败和修后证据，没有为归档重跑。较早 clippy 通过属于反向请求修复前，不拿来代替该修复验证。

继续 D：公共 Host 任务提交/停止及恢复、Provider 本轮原生证据、模型配置和现有 PiWorkspace 接线，然后执行同候选真实 Provider/安装应用阶段出口。当前不启动 E，不删除旧 Pi，不替换应用，不把这些合同扩大成 D 完成。

### 2026-09-12 D Host 任务、精确停止与未知恢复

- Pi ACP 普通提交复用公共 Turn admission、两活动任务与 Working Copy 排他、任务 Provider 绑定和终态记录。新增 `AcpPendingResponse` 将有界 prompt 写入与最终响应等待拆开：接纳及写入在公共 controller 锁内，等待在锁外；OpenCode 的原 `request_unbounded` 继续通过同一实现。丢弃已发送响应句柄会保留 Unknown，不泄漏 pending 槽位。
- Pi 停止必须匹配 Farfold/native Session、Runtime generation 和具体 Host turnId；同控制锁内核对后有界发送 cancel，下一轮不能抢在写入之前接纳。cancel 写入不是终态；可信 end_turn/cancelled/明确原生失败后仍检查原生 streaming/compacting/队列及 Host 资源/交互，再释放占用。不从普通任务终态推断 Provider 请求已成功。
- 连接丢失/协议失败保留 Unknown 与占用，不自动重发；恢复需完整绑定、代次和 turnId 匹配。确认自有进程已退出后才走公共终止记录释放占用，异常退出原因保留在返回状态，不宣称原任务成功。旧代次恢复被拒绝。
- 协调发现 P2：transport 已发送表单 cancel 并删除 pending，但 Pi adapter 若先处理该答复、不再发 withdrawal，公共 Registry 仍可残留。指定夹具首次实际失败：本轮 Cancelled、active 已释放，Registry 仍有 id7 的 PiExtensionDialog Pending。不是纯推测，也没有用隐藏卡片规避。
- 修复在同连接锁下先 drain/route、取消 transport 请求、再次 drain/route，再按成功答复的完整 binding/generation/request ID 结清公共 Registry，最后发 session/cancel；防排队表单晚登记。终态新增精确会话的公共 Registry pending/Responding 检查。连续两轮同原生会话/代次夹具验证第二轮表单存在时拒绝第一轮真实 turnId 及旧 RPC id7 答复，两轮取消后 active/Registry 均清空。P2 有限协调复审关闭，不是 D 安装出口通过。
- 最终 Pi 模块 **11 通过、1 默认忽略**；transport **20 通过、0 忽略**；OpenCode ACP 受影响回归 **24 通过、8 忽略**；Registry **14 通过、0 忽略**；TurnCoordinator **30 通过、0 忽略**；修后 clippy `-D warnings` 通过。筛选边界不同且有交叉，不累加。首次新增测试因私有查询/字段访问编译失败，后复用 `ActiveHostTurn::id()` 与 crate 内共享查询；未放宽生产身份核验。
- 命令和实际输出摘要归档至 `src-tauri/target/d-stage-pi-candidate-0912/host-task-cancellation-summary-r1.log`，不冒充完整 stdout、不为归档重跑。未知工具输出未用于成功声明。本包没有 Adapter 改动、模型调用、应用打包/替换、全局 CLI 或日用数据操作。

剩余具体依赖：`verify_task_settled` 的 transport unresolved 包括并发 `_pi/workspace` 请求，可能将可信终态误判 Unknown 并继续占用；当前仅源码发现，尚未运行复现，工作台接线前须定向闭合。随后继续 Provider 本轮原生证据、交互/模型配置和普通 PiWorkspace；D 未完成、E 未开始。

### 2026-09-12 D 并发读取与终态核对

- 上节观察已定向复现：保持 entries 读取 pending，再完成另一普通 prompt，原生已返回 end_turn 和空闲状态，但 Host 返回 Unknown（仍有未结清请求/Host 资源）。首轮指定测试失败，不用最终通过抹去该失败。
- 每个 Pi 连接增加一个只读序列锁，所有普通工作台读取与最终状态核对使用同一锁；终态持有到原生空闲及 transport/Registry 核查结束。取锁时已释放连接锁，等待 RPC 不阻塞事件泵，cancel 不取读取锁。没有更改公共 transport 的 Unknown 或资源保护规则，也没有新增读取 authority 或 Runtime 旁路。
- 首次失败项修后 **1 通过**；增加历史读取 pending 期间停止已成功发送、释放读取后确认 Cancelled 的测试，Pi 模块最终 **13 通过、1 默认忽略**；clippy `-D warnings` 通过。连续两轮表单取消等既有本包测试同次保留通过，没有重跑 C/Adapter 全套、模型或打包。
- 有限协调复审通过，关闭已复现的并发读取误判。剩余行为是终态确认等待正在执行的读取；后续 UI 应避免重复并发轮询积压，不宣称确认瞬时完成。准确命令和工具输出摘要追加至现有 `host-task-cancellation-summary-r1.log`。

继续 Provider 本轮原生请求证据、交互/配置及现有 PiWorkspace。仍不是 D 安装应用出口，旧 Pi 和正式应用保留。

### 2026-09-12 D Provider 本轮原生请求证据

- 固定 Pi RPC 文档 `AssistantMessage` 与真实本机请求提供 provider/model/timestamp/stopReason。Adapter 只在普通原生 prompt 范围临时订阅 `message_end` 并在 finally 解除，提取本轮新鲜 assistant 结果；不复制正文、错误详情或凭据。原生 model ID 与 ACP `provider/model` 选项身份分别保留。纯 builtin 命令、取消、缺失身份/时间/完成结果时不制造验证回执，retry 使用最后一条完整原生结果。
- 回执保留 Host turnId、native Session、Provider/模型、原生时间和完成时间。Host 对成功/失败形状、版本、本轮任务/会话/模型/时间逐项核对；在原生终态与资源检查后，公共 controller 短锁内再核对连接代次及活动任务身份，才写 Provider 投影并结清本轮。长 RPC 等待仍在锁外，旧恢复后的回执不能写回当前任务。缺少回执只保持未验证，不把命令完成当请求成功。
- 固定 Pi 0.84.3 + Node 22.22.3 + 当前 Adapter 的本机模拟 HTTP 合同 **指定 1 通过**：实际只发送一次 `/v1/chat/completions`，模型和隔离假凭据匹配，Host 记录当前配置 VerifiedSuccess；真实 Pi 文件落盘、同原生 Session 冷加载后恢复 `ok` 消息，冷加载没有再次发送请求。是实际 Runtime + 本机模拟模型服务，不是外部 Provider、付费调用或安装 UI 验收。原生成功路径证据发生在后续 Host 短锁/原子 DB 补强前；Adapter/原生 HTTP/冷恢复逻辑未变，相关 Host 合成流程另复测，不为归档重跑。
- Adapter 定向 **16 通过**，全套最终 **140 通过、0 忽略**；typecheck/build 通过（产物 117.32 KiB）。Host receipt 单测 **1 通过**，TurnCoordinator **31 通过**；普通 Pi 合同覆盖无回执、成功/失败回执、同连接更新配置版本后旧任务仍绑定原版本。最初“旧版本”夹具误换 endpoint，实际创建另一连接，预期 NotRequested 与实际 VerifiedSuccess 不符；改为同 endpoint 更换假凭据并断言同 connection/不同 version 后通过。新增 Rust 测试缺失 use 的首次编译错误亦保留。
- 协调再发现 P2：旧 helper 先读 current version、后独立写入，保存可插入两次 DB 调用之间；旧回执虽被拒绝，但 Err 会将可信终态错误转 Unknown。确定性夹具插入该顺序，首次实得 `Provider projection update targets a stale config version`。修复复用同一公共事务核心：原严格入口仍 Reject；request-only 条件入口在同一 IMMEDIATE 事务内核对真实版本及 Runtime 身份，再返回 Recorded 或 StaleConfig。Host 不再外部预读版本。真实旧版本只跳过投影；未知目标、伪版本/归属错误及 DB 写错误仍 Err，没有吞所有错误或第二套 Provider authority。
- P2 修后指定 **1 通过**，Provider projection **9 通过**；最终受影响 Pi **13 通过、2 默认忽略**，OpenCode ACP **24 通过、8 忽略**，clippy `-D warnings` 通过。两个忽略之一是上述已指定执行的固定 Pi 本机 HTTP 合同。不同筛选不累加。协调对原子边界及根因修复有限复审通过；没有 C 全量、应用打包/替换、全局 CLI 或日用数据操作。

命令、首次失败和实际结果摘要见 `src-tauri/target/d-stage-pi-candidate-0912/host-provider-receipt-summary-r1.log`。下一步为普通 Host 交互答复、插话/follow-up、模型配置与现有 PiWorkspace 接线；真实外部 Provider 和同候选安装应用 D 出口尚未执行，E 未开始。

### 2026-09-12 D 普通交互答复与插话

- `pi_acp_respond_dialog` 复用共享 Registry 的 begin/finish，要求完整 Farfold/native Session、连接代次、ACP requestId 与 nativeRequestId 同时匹配。typed Cancel/Confirm/Text 校验原生方法、选项与 64 KiB 限额；false、空文本与取消保持不同语义。重复答复、旧请求答复及原生 timeout 撤销后的晚答复均拒绝，不另建卡片 authority。
- `host_pi_acp_intervene` 只在精确活动 turnId 上发送 `_pi/steer` / `_pi/follow_up`，不用普通 prompt 模拟，不新增 Host turn 或自有消息队列。原生 `success:true` 仅表示已接收排队，不等于已执行。明确 false 为拒绝；缺失/非布尔 success、传输失败或 ACK 超时保留 Unknown，不自动重发。原生错误正文不外泄。
- 复用每连接已有读取锁并命名为 settlement gate，插话持有至 15 秒有界 ACK 等待及校验结束；公共 controller 仅用于校验与有界写入。最终状态核对通过 finalize 回调持有同 gate 至 Provider 写入/任务结算，防原 prompt 先结束时 pending 插话误判、或坏 ACK 晚到覆盖已释放任务。final guard 同时拒绝 outcome_unknown。停止/显式恢复不取该 gate，等待 ACK 时仍可停止。
- 新并发夹具覆盖正常完成、坏会话 ACK、等待 ACK 时停止三分支：原 prompt 在回执验证前不结算；坏 ACK 保留活动任务为未知，正确 ACK 后分别 Accepted/Cancelled；始终仅一次普通 prompt、一次原生插话。错误代次、原生会话、turnId、空消息和任务结束后的插话拒绝。首编译因 scoped thread 捕获局部变量生命周期失败，修正测试所有权后通过；没有据此修改生产身份约束。
- 本包 Pi Host 最终 **15 通过、2 默认忽略**，包括普通 dialog 精确身份/撤销及新并发测试；公共 transport **21 通过**，新增 pending response timeout 后仍可发 cancel；Registry **14 通过**；Pi dialog **3 通过**。Adapter 全套 **142 通过、0 忽略**，typecheck/build 与 Rust clippy `-D warnings` 通过。不同筛选不累加。此轮没有固定真实 Pi / 外部 Provider / 安装 UI 验收或付费模型调用。
- 命令与输出摘要见 `src-tauri/target/d-stage-pi-candidate-0912/host-interactions-summary-r1.log`，不是完整 stdout，也没有为存日志重跑。协调已有限只读核对双请求身份、结算锁、controller 外等待与严格成功/未知映射，无新增阻断；测试数字依据现存日志，未独立重跑，不外推 D 出口。

继续模型配置及现有 PiWorkspace 接线。当前 managed Pi profile 只包含绑定版本的单个模型，不能把仅有 Host 配置命令或旧能力桥当作完整模型切换/OAuth 已迁移。D 集中安装出口未完成；旧 Pi、Dev/正式应用和日用数据不动，E 未开始。

### 2026-09-12 D 原生配置操作与恢复边界

- `pi_acp_set_config_option` 接入公共 ACP 的 model/thought_level，按完整 Session/代次、当前原生 select 枚举及值校验。当前 managed profile 只允许已绑定模型，其他模型明确拒绝；思考等级使用该原生模型提供的选项，不制造高等级选项。该范围不是完整跨模型/账号切换或 OAuth。
- 复用 `AcpSessionOperations` 增加 Configure 占用，在 controller 内校验无活动任务、标记占用并有界发送；15 秒回执等待在 controller 外。回执核对当前连接、代次、配置值与绑定模型后才释放。明确未发送/协议参数拒绝可释放；坏回执、未知结果保留占用，不自动重试。新任务只在原生模型与绑定 Provider 一致时接纳；停止仅核对身份，不被模型漂移挡住。
- 首次配置夹具失败由观察探针干扰：ACP 轮询本身占 pending，配置实际在发送前返回“仍有活动或未确认请求”。第二次诊断取得该实际错误后，改用 Host 操作状态同步夹具；未放宽生产未结请求保护。另一次定向首次失败确认未知 Configure 无活动 turn 却不能走提示的断开恢复。修正为公共 stop 先要求 Runtime 无活动 Host turn，再允许精确目标/代次的 Configure 被明确终止；其他未结操作限制不变，确认自有进程退出后保留配置未知错误。
- 配置夹具最终含 accepted/reject/malformed/disconnect 四分支，覆盖配置中禁止新任务、等待 ACK 时显式断开、未知后断开、错误代次/目标/枚举/跨模型拒绝及模型漂移不挡身份停止；原生活动任务中配置也明确拒绝。Pi 模块最终 **16 通过、2 默认忽略**，公共 Session operations **4 通过**，OpenCode ACP **24 通过、8 忽略**，clippy `-D warnings` 通过。筛选不累加。
- 固定 Pi/Node 隔离合同指定 **1 通过、0 模型请求**：同值模型配置与 thought_level=off 往返及七类读取通过。因为夹具为单个非推理模型，该原生证据只证明所选配置被确认，不是实际跨模型切换或升高思考等级。此原生调用在后续 Host 显式断开补强前完成，未变的原生映射证据复用，受影响 Host 合同另已复测。
- 命令与实际输出摘要见 `src-tauri/target/d-stage-pi-candidate-0912/host-configuration-summary-r1.log`。协调有限只读核对配置/任务/停止边界及四分支测试，无新增阻断；未独立重跑，最终回归现已补齐。本包未改 Adapter、未打应用包或动日用数据；旧 Pi 和正式应用保留。

下一步接已有 PiWorkspace 的类型与工作流。完整模型目录/切换、认证、前端及真实 Provider/同候选安装应用出口仍未完成，不以普通 Host 命令存在宣布 D 完成。

### 2026-09-13 D 既有 ACP 会话工作台接线

- 新增 typed `pi-acp.ts` 及共享 `host-turns.ts` 读取；OpenCode 恢复仍使用同一个 coordinator 快照，不另建任务权威。Pi Session activation/lifecycle 区分旧 RPC 与 ACP 状态，按完整 Runtime/安装/构建/连接/原生 Session/代次核对恢复结果；ACP 创建 helper 要求明确保存的 Provider 版本，但普通新建界面尚未接入。旧 Pi 创建及已绑定恢复保留。
- 现有 PiWorkspace 接入已绑定 ACP 会话：一次一个原生只读请求，整组快照只在会话及事件修订仍匹配时应用；有流式事件到达则丢弃该组，闲时补读。原生 `_pi/event` 按完整连接/代次/Session 过滤，未知内容保持公共 raw envelope；展示复用既有 Pi reducer。公共 Host 事件缺口会暂禁提交，读回后确认该次重建，不用旧 RPC 兜底。初始监听之前的原生事件保留仍没有安装证据，不能据本片宣布完整无损。
- 普通提交只调用一次 Host ACP submit；正在执行时向共享 coordinator 读取精确 turnId，插话/follow-up 用该 turn，不新建 prompt。原生 agent_settled 不自行释放 Host 占用；Unknown 保留任务并提供精确断开恢复，不自动重发。提交接纳后只清除仍属于原会话、内容仍等于提交时快照的草稿；用户随后编辑的草稿不覆盖。原生 confirm=false、空文本与 cancel 从共享 Registry 中的 ACP/native 双请求身份分别答复。
- 模型及 thought_level 配置走当前 ACP 目标，默认模型写入和旧认证表单不暴露给 ACP。当前 Provider 状态读取真实绑定的连接/版本/模型投影，不借旧 capability bridge 的状态或不同版本回执。当前 ACP Provider 面板仅显示绑定信息；完整模型切换和认证不是已迁移。旧启动/生命周期异步回执加切换检查，避免晚返回的旧状态重新选择 RPC。
- 最终定向测试 **7 文件、65 通过**（`pi-acp`、activation、lifecycle、session-controller、OpenCode、native reply、native stop），TypeScript 与 `git diff --check` 通过。首次新增测试失败源于 `beforeEach` 返回 mock 函数，被框架当清理函数无参数调用；钩子改为无返回后通过，生产读取保护未放宽。中途类型检查暴露 presentation Pick 不含 adapterId 及原生 UI union 未收窄为 dialog，分别改为读取完整 binding 和按原生方法收窄。
- 新增 `scripts/fixtures/pi-acp-workspace.html` / `.tsx` 和 `scripts/pi-acp-workspace-smoke.mjs`，直接挂载生产 PiWorkspace；所有 IPC 截获，**0 原生进程、0 模型请求**。最终 13 类浏览器冒烟通过：恢复、草稿竞争、流式、旧连接事件隔离、单 prompt 插话、false、空文本、取消、同 turn follow-up、思考级别配置、停止、Unknown 精确恢复、无 RPC fallback。浏览器最初缺少 Playwright 自带 Chromium，改用已有 Chrome 的隔离 headless 实例，未安装浏览器；扩展测试初次把模型按钮 title 当 aria-label，修正定位后通过。
- 1440×1000 与 900×760 截图已目视检查，现有布局无新增遮挡；截图归 `src-tauri/target/d-stage-pi-candidate-0912/frontend-smoke/`。这是 mock IPC 的前端冒烟，不是 Tauri、真实 Pi、外部 Provider 或已安装应用证据。命令与工具结果摘要见同目录上层 `frontend-workspace-summary-r1.log`；协调复审待提交/回执。没有应用打包/替换、全局 CLI 或日用数据操作。

继续普通 ACP 新建/共享 Provider 选择、完整模型与认证能力保留、工作台及 D 真实 Provider/同候选安装出口。旧 Pi 不删除，正式 0.1.7 不替换，E 未开始。

#### 协调 P2：空闲进程退出后的精确清理

- 协调源码审查指出 running=false 但 Host 仍保留完整连接身份时，前端恢复错误复用 live target 校验而拒绝发 stop。生产 PiWorkspace 的新增 idle-crash mock 首次点击恢复后没有发出 stop，测试超时，保留该失败。现在显式清理使用同一完整身份核验、但不要求进程在线的 cleanup target；任务、读取与配置仍必须 live。初始读取遇到保留身份的死连接，也进入 ACP 恢复态，不转到旧 RPC。
- 后端新增合成进程定向合同进一步复现：自有进程 exit(1)，Host 尚未 stop_locked，正确 idle stop 虽完成清理却返回“进程已确认退出，但结果或终态发布仍需核对”。前端因此仍无法确认恢复。修改仅在公共 controller 已要求无活动 Host turn、原身份/代次及未结操作限制不变的 stop_idle_session 中：先确认生命周期确已停止，再返回 stopped status，并将退出/发布异常与原配置错误保留在 lastError；未确认退出仍 Err。不是把异常退出当正常任务完成，也未放宽其他 pending/Unknown 限制。
- 前端 idle-crash 与 idle-crash-cold 两个定向浏览器分支通过：正确 session cleanup 目标、随后原会话打开、历史/草稿保留、没有 prompt 重发或 RPC fallback。后端指定复现修后 **1 通过**，验证原 Host/native Session 与更高代次；受影响 Pi 模块 **17 通过、2 默认忽略**，前端同七文件 **66 通过**，typecheck/clippy `-D warnings` 通过。此前 13 类普通冒烟证据按未变范围复用，不累加测试筛选。
- `frontend-workspace-summary-r1.log` 已追加命令与首失败/通过摘要；`frontend-smoke/03-idle-crash-reopened.png` 已目视检查。后台合同使用临时合成子进程，不是真实 Pi/Provider；仍无外部模型调用、应用打包替换或日用数据变更。协调已只读复核 cleanup/live 分离、死连接 bootstrap、停止状态与错误保留、两浏览器分支及后端原会话恢复断言，有限复核通过；测试数字依据现存记录，未独立重跑。本既有 ACP 会话工作台片有限工程通过，不外推安装/真实 Provider/D 出口。

### 2026-09-13 D 普通新建与共享 Provider 表单

- 从 Pi ProviderSettings 的 managed 分支提取 `ManagedProviderEditor`，复用现有表单样式；组件只管理表单、读取已保存连接和调用明确的上层动作，不拥有 Runtime 认证/应用/任务逻辑。原 Pi 调用方继续原 save/apply 语义；ACP 调用方只保存共享连接，用户明确选择连接/版本后才新建。Chat Completions/Responses 两种既有共享协议可选择，不扩展 Runtime API。
- PiWorkspace 普通新对话与 Working Copy 创建先打开共享连接选择；取消不停止/创建，不清旧草稿。确认后复用已有 activation、公共 Host 和精确 ACP stop/create，显式传保存版本；新建错误在主工作台保留，不因弹窗随状态切换关闭而丢失。已有 RPC-bound 会话及原生认证代码保留，源码新建入口已切 ACP managed；完整模型/认证未迁移，安装应用未替换，不能据此宣布旧能力保留门槛已过。
- 保存失败保留输入；保存成功才清空密钥。列表刷新失败明确显示“连接已保存”，同时清空可选旧列表，避免旧版本被误用；关闭后重新打开可重新读取。组件局部在途保护避免重复按钮动作；工作/提交/恢复与生命周期切换沿用上层保护。
- 最终定向 **7 文件、59 通过**，包括新共享表单、OpenCode Provider、Pi activation/ACP、managed Provider、Host Session controller/lifecycle；typecheck、定向格式和 `git diff --check` 通过。该筛选不同于前片 66 项，不作总数比较或相加。首轮提取残留一个 `setManagedError` 引用，类型检查发现后删除无用调用，保留失败记录。
- 生产 PiWorkspace 的 mock IPC 冒烟通过：普通新建、取消无写入、保存失败/成功、保存不应用、两协议输入映射、所选版本只创建一次、新旧草稿隔离；保存后刷新失败及新建失败后显式重开原会话两个分支另通过。旧 13 类流程和冷启动死连接恢复再次通过。全部 **0 原生进程、0 模型请求**，并非 Tauri/真实 Pi/外部 Provider 或安装 UI。
- 首次新建草稿断言失败：fixture 将同一可变 navigation 对象返回给 React，区别于真实 IPC 值边界，导致 memo 沿用旧会话列表。核对本地 Tauri mock 源码后，在夹具返回处 structuredClone，修正 draft 返回身份与动态代次；生产草稿逻辑未改，修后旧草稿保留、新草稿为空。API 下拉的精确 label 定位两次超时；探针确认 byLabel=0、byRole=1，label 文本含 option 而无障碍名称正确，改角色/名称定位后通过。不是放宽业务断言或无条件重试到绿。
- `frontend-smoke/04-shared-provider-form.png`、`04b-shared-provider-900.png`、`05-new-managed-session.png` 覆盖 1440×1000/900×760，已目视检查滚动容器、输入与操作栏；首次发现的复选框/凭据样式遗漏已用现有样式补齐。详细命令和工具输出摘要在 `frontend-managed-create-summary-r1.log`，不是完整 stdout。协调有限只读复审已提交，待结论。
- 重新读取已安装摘要：Dev `85e50b52472385ef00fee6b71acccbb77ed301030bc46457be82dfd66e2a161f`，正式 `c7750c4406075330d83e9c8ad3f7ee3d844113186de034d9160363d08cdd7820`，均未替换；未动全局 CLI、认证或日用历史。

下一依赖片为完整原生模型与认证能力保留、工作台及 D 同候选真实 Provider/安装出口。当前新建覆盖仅 managed 连接；E 未开始，正式 0.1.7 保持不变。

#### 协调 P2：Provider 列表旧回执覆盖

- 协调指出 mount 初次列表 A 可晚于保存后的刷新 B 返回，原实现只检查是否挂载，无法防旧版本回填。增加可控延迟首次读取的 fixture，修前两条确定性失败：B 成功后 A 将创建输入从 v2 回退为 v1；B 失败清空后 A 又重新启用应用按钮。此前普通保存测试未覆盖该顺序，不以它们否定缺陷。
- `ManagedProviderEditor` 增加本地列表读取 revision；初次读取、保存成功后刷新及其成功/失败/finally 均核对当前 revision，卸载时失效。保存失败不提前作废初次读取；保存成功后立即失效旧读取并设置 loading，只有当前刷新可以结束 loading、应用新列表或清空失败列表。未新增 Provider authority，也未借禁用保存掩盖回执竞争。
- 两条新分支修后通过，实际创建 v2、旧回执不能复活失败列表，继续验证新旧草稿隔离。定向同七文件 **59 通过**、typecheck 通过；0 原生进程/0 模型请求。新分支跳过先取消重开以保留 A，初版输出通用 checks 曾误列 cancel-no-mutation，已改条件输出；取消证据来自另一个普通新建分支，不属于这两次执行。协调已有限增量源码复核通过，核对全部读取回调与卸载失效、保存失败 loading 保留规则及两个脚本断言；未独立重跑，红绿结果依据本记录。本普通新建/共享表单片有限工程通过，不外推原生能力或 D 出口。

### 2026-09-13 D 模型与认证有限设计核对（未实施）

本节响应协调的五项设计核对，只读源码与固定发布文档后追加于既有记录。未调用 SDK 初始化/登录、未运行 Pi、模型请求、测试或构建，未改变生产实现、模型校验、数据库、profile、凭据或安装应用。以下“推荐”不是已实施能力，也不是新的执行授权。

#### 1. 固定入口与保留范围

本地 `capability-bridge/package.json` 及安装的官方包均为 Pi SDK 0.84.3，Adapter 仍为固定 0.0.33-farfold.1 / ACP SDK 0.26.0。核对来源：官方 [v0.84.3 ModelRuntime](https://github.com/earendil-works/pi/blob/v0.84.3/packages/coding-agent/src/core/model-runtime.ts)、本地同版本 `dist/core/model-runtime.{js,d.ts}`、`dist/modes/rpc/rpc-mode.js`、`dist/core/model-registry.d.ts`、`docs/providers.md`、`docs/rpc.md`，以及本仓库下列入口。不以在线 main 或最新文档替代固定 SDK 类型。

| 旧 Pi 能力 / 保留要求                                                     | 固定原生入口与现有旧接线                                                                                                                                | 当前 ACP 事实与剩余工作                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider/模型目录、已配置状态、未知凭据保留                               | `ModelRuntime.getProviders/getModels/getAvailable/listCredentials/getProviderAuthStatus`；旧 `capability-bridge/bridge.mjs:snapshot` 只输出非秘密元数据 | `_pi/workspace models` 只有 Pi RPC 的当前可用模型；不能代替完整认证目录。SDK helper 不自动拥有仅在 Pi 扩展进程注册的动态 Provider；这部分不能凭目录推断 |
| API key / OAuth、浏览器 URL、device code、文字/选择/密文/手工授权码、取消 | 官方 `AuthInteraction.prompt/notify/signal`；旧 `bridge.mjs:startLogin` 与 `PiWorkspace:startProviderLogin`                                             | 上游 `acp/auth.ts` 只有 terminal-login 描述，`agent.ts:authenticate` 返回空成功而不登录；尚无等价内置 Farfold 认证流程                                  |
| 已有模型同 Session 切换、实际思考等级                                     | RPC `set_model/get_available_models/get_available_thinking_levels/set_thinking_level`；旧 `selectModel` 在目录缺失时按原 Host Session 重开              | Adapter 有原生配置映射，但 Host `pi_acp.rs:set_config_option/verify_prompt_target` 强制当前 managed 单模型；不能删除该检查冒充完整切换                  |
| 保存默认模型/思考等级                                                     | 官方 `SettingsManager`；旧 `bridge.mjs` 默认设置命令                                                                                                    | ACP 当前刻意隐藏。后续只可写明确的当前 profile 设置，不能触碰旧 Pi 默认目录                                                                             |
| 自定义 Provider / 模型、兼容选项、配置冲突                                | 旧 `upsertCustomProvider` 验证并原子写自有 `models.json`，再重开原 Session                                                                              | 当前 managed profile 的 `models.json` 必须与原绑定版本完全相等；自定义修改与 immutable managed 投影不能混写                                             |
| 连接测试及保存/应用/真实任务验证分层                                      | 旧 `testConnection` 调官方 `ModelRuntime.completeSimple`，属于独立单次 Provider 探针，不是 Agent turn                                                   | 若保留探针，仍必须显式用户动作、绑定实际配置且单独标注；不能用 helper 探针为当前 Pi Session 的任务回执背书，不应因迁移而自动增发模型请求                |
| logout、取消失败、保存后刷新失败、恢复                                    | SDK `logout`、AbortSignal、`CredentialSynchronizationError`；旧流程保留原 Session 后重开                                                                | 需覆盖凭据已写成功但目录同步失败、取消与 OAuth 回调竞态，不能把取消或空 ACP 响应当无副作用；未接通前旧路径保留                                          |

以上是已存在旧流程及迁移义务的源码对应，不把每个 Provider 的登录方式写成全部实机通过。旧连接测试、同 Session 模型选择和认证恢复的实际安装范围仍以既有接受记录为准。

#### 2. 推荐：一个 Adapter，认证辅助不承担 Agent 执行

- 保持唯一链路：Farfold UI → 公共 Host/ACP → 固定 Pi Adapter。Adapter 内部复用官方 `ModelRuntime` 做认证与目录辅助；Pi RPC 子进程仍独占 Agent loop、工具与原生 Session。禁止调用 `createAgentSession` 代替现有 Pi 执行，禁止 Host 继续直连旧 capability RPC 作为 ACP fallback。SDK 的 `completeSimple` 只可用于上表明确区分的用户发起探针，不参与任务执行/重试。
- 认证辅助与 Pi 使用同一**明确指定的自有 profile**，不读默认 HOME 的认证或历史。可复用现有 SDK 打包/版本校验与旧认证逻辑，但应提取可复用模块，由 Adapter 管理其调用/退出；不是把整份具有通用命令入口的旧 bridge 暴露给 Host。具体采用同 Adapter 进程内 SDK 模块还是其私有辅助子进程，以同版本可打包性验证决定，不另建产品控制器。
- 不能承诺“写 auth.json 后当前 Pi 自动生效”：固定 RPC `get_available_models/set_model` 读取 `getAvailableSnapshot()`。首选有限验证官方 Pi Extension 的 `ctx.modelRegistry.refresh({allowNetwork:false})` 能否刷新**当前 Pi 的同一个 ModelRuntime**；`ModelRegistry` 为官方公开 Extension facade，源码上可达，但本节没有原生动态证据。若采用该扩展，只承接 allowlist 的刷新动作与关联回执，不含 credential、不提供任意命令执行，不产生用户任务或模型调用。
- 同一 Pi 进程保持是首选，不是未验证承诺。若刷新无法保留固定原生能力，明确返回 NeedsRestart，在用户可见的安全边界经同一公共生命周期重开**原 Host/native Session**，校验文件/cwd/代次，不新建空会话、不重放用户 prompt。此时必须如实记录 Pi PID 改变；不得借 SDK 新建另一个 Agent session 来维持表面身份。旧流程本就存在认证后重开，但新 Adapter 路径仍需自己的恢复证据。

#### 3. 认证协议与秘密边界

ACP [认证](https://agentclientprotocol.com/protocol/v1/authentication) 将 agent-driven 认证与 terminal 方式分开；[elicitation](https://agentclientprotocol.com/protocol/v1/elicitation) 的普通 form 只收非敏感输入，URL 接受也不等于认证完成。本地 SDK 0.26.0 已有 request-scoped elicitation 与 URL 类型，但仍标不稳定；Host 当前 Pi Registry 解析面向 Session 的扩展表单，不能说 pre-session 认证已受支持。

- 认证操作绑定完整 Runtime/安装/连接/代次、Provider、auth-operation/request ID；已有 Session 时再关联 native Session，没有时不得伪造 Session。公共 Registry 增加认证语义分支以复用答复/取消/过期保护，不复制 Pi 私有 pending authority。非敏感选择可用已协商表单；URL 需展示来源域、用户同意后用系统浏览器，完成另凭 SDK 回执判断。
- API key、授权码和 token 不放入普通 `elicitation/create` form、聊天消息或原生任务事件。API key 优先由用户主动的共享凭据服务配置后以受控引用投影；无法表达为共享连接的 Pi 原生 secret/manual_code 步骤，必须设计专用、版本化的认证答复边界，复用 Host 凭据保护，仅给原操作消费。它不是通用表单 `_meta` 加 password 标志即可解决的问题；没有可靠敏感通道时明确不可用，不降级成文字提问。
- 秘密答复只做有界瞬时传输，UI 提交后清除；公共事件只保留状态、身份及脱敏提示，不能把 auth payload 当“必须保留的未知 Agent envelope”落盘。`CredentialSynchronizationError` 对象自带 credential 字段，绝不直接序列化该对象或 cause；只输出安全状态。需要对 URL/device-code/手工授权码的可见范围、缓存与日志各自验证。

#### 4. 配置、模型与任务回执规则

| 情况                 | 推荐规则与失败出口                                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Farfold managed 配置 | Host 保持现有连接/版本/秘密存储权威；profile 仅接收指定版本的投影。新保存不改变活动任务或旧 Session 引用；当前已验证 immutable profile 继续原算法，不覆写                                                                                                                                                                         |
| Pi 原生认证          | SDK 仅写明确自有 profile 的原生认证存储；它仍是 Runtime-native 凭据，不因登录 UI 在 Farfold 就变成跨 Agent 共享凭据，不复制 token 到共享 API-key 槽。外部/未知凭据只读发现、保留                                                                                                                                                  |
| 同名与优先级         | Pi 固定规则包含 auth.json 优先于环境及 models.json。managed Provider 使用独立 namespace；若同 ID 原生认证/配置可能遮蔽 managed 投影，阻止生效并报冲突，不能静默“managed 优先”或删除原生项。logout 后若环境/config 仍提供认证，要重读真实状态，不能宣称 Provider 已断开                                                            |
| 认证/模型变更时点    | controller、AcpSessionOperations、活跃任务及交互共用保护；活动/Unknown/未结操作不改当前连接配置。空闲变更获得 SDK/原生确认后，重读当前 Pi 实际 provider/model/thinking；完成确认前禁下一次任务。明确拒绝释放本操作；未知写入/回执断线保留恢复态，不自动重试登录、撤销或新建                                                       |
| 同 Session 切换模型  | 仅在同 profile/Runtime connection 中原生可用且配置来源明确时考虑支持；模型选择与配置版本形成新的**下一 turn**绑定，旧 turn 绑定不更新。账号/profile 边界变更创建或打开另一 Session，不移植原生状态。当前单 managed 版本的保护在新合同验证前保持原样                                                                               |
| managed 本轮请求     | 沿用现有 `PiProviderRequest` 的 hostTurnId/native Session/实际 provider/model/时间/原生 stop reason，核对本轮捕获版本、连接及代次后才记验证。模型变化后不能继续套用旧 managed binding；晚回执最多归原 turn，不能把当前 UI 新模型涂绿；有身份/模型漂移则未知/阻止提交而不是改名匹配                                                |
| native 本轮请求      | 可显示“Pi 报告的本轮模型/结果”，但不借 managed Provider 版本证明原生凭据或实际 endpoint。现有 `NativeUnmanaged` 禁止 Farfold VerifiedSuccess，应保留；本轮原生观察须与 shared managed 验证分开。SDK `CredentialInfo` 只有 Provider/type，不足以证明账号/端点/凭据修订，不能造 fingerprint；OAuth 自动续期也不能简单当作新账号配置 |
| 撤销与刷新失败       | SDK 成功写凭据后再报同步错误，应显示“认证存储已改变，尚未确认 Pi 生效”，不回滚未知外部状态；取消仅拒绝未决步骤，已完成写入必须重新观察。logout 只删选定 Provider/profile 的 native 凭据，不删共享 secret、其他账号或历史；未能确认恢复就保留原绑定并提示，不能悄悄切默认模型                                                      |

#### 5. 是否新增连接模式，以及需要决定的结构

**不建议新增 `native-unmanaged` RuntimeConnectionKind、第二条 Pi Adapter 或独立 Host 控制面。** 现有 `RuntimeConnectionKind::ManagedLocal` 描述自有本地连接，`ProviderConnectionSource::NativeUnmanaged` 描述 Provider 数据归属，二者不是同一维度；继续复用公共安装、连接、操作、任务、Registry 与 profile 服务。

但“无需新模式”不等于当前实现只加 optional 字段就足够：

1. `pi_acp.rs:managed_binding` 把 connection ID 派生自单个 Provider/config version，`saved_provider` 靠遍历 managed 版本反查恢复，`acp_provider_profile` 同时把该版本纳入 profile/Session 根。这不能表达首次仅 OAuth 登录、无 managed key 的自有 profile；不允许通过假 key 或借另一 managed 连接作临时锚点解决。
2. `PiAcpConnection.managed_provider` 与 task/config 校验目前是强制单值。公共 `turn_provider_bindings` 强制 Provider 版本并引用投影；`ActiveRuntimeSessionBinding` 只接受 FarfoldManaged，NativeUnmanaged 不能记 VerifiedSuccess。把所有 native 任务四个 Provider 字段置空虽被 coordinator 接受，却失去本片要求的模型/来源绑定，不作为完整迁移方案。
3. **推荐结构方向（待决定）：** 在现有公共连接记录下面显式持久化稳定的自有 profile/启动引用，Runtime connection 仍与 profile/安装绑定；每轮实际选择用 typed managed-version 或 native-observation 区分来源。复用现有共享 Provider 表、任务控制器及原生事件证据，不建立第二套历史。原生观察无法复验的账号/端点/秘密修订明确 Unknown，不伪造 shared config version；需要在现有任务绑定/记录中明确表达这种观察与强版本绑定的区别。具体 schema/迁移方案本节不实施，也不承诺零 schema 变更。
4. 对已有 managed ACP 会话，不更改其 connection/profile/native 身份；原算法作为这些已绑定会话的唯一解析路径，不让同一 Session 有两条控制路线。若后续统一迁移格式，必须单独验证原绑定与 native locator，不能为清理而丢失日用或已保护数据。

#### 6. 推荐、替代及有限适配范围

| 方案                                                                                          | 判断                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 推荐：同 ACP Adapter 的官方 SDK 认证辅助 + 原 Pi RPC Agent；同服务显式 profile 与每轮来源绑定 | 保持 Runtime 原生执行、UI 自有、共享 Host 不分叉。认证/目录映射本身属于已批准有限适配方向；**将连接从单 Provider 版本推进为稳定 profile 并增加原生任务来源合同，涉及启动/恢复/Provider 身份的实质结构变化，需要用户决定后实施**。不是重复询问是否允许维护 pi-acp |
| 暂留单模型 managed ACP，认证只走旧 Pi                                                         | 可作为尚未迁移的过渡，不可宣布 D 退出；不满足完整同会话模型选择和 OAuth 首次使用                                                                                                                                                                                 |
| 直接使用上游 terminal-login                                                                   | 固定上游可见路线，但依赖 Runtime 自身交互终端，不等价旧 Farfold 原生认证面；也不解决 profile/任务回执，非推荐主路线                                                                                                                                              |
| Adapter 改用 SDK 创建并执行整个 Agent Session                                                 | 改变当前 Pi 进程/事件/恢复路线，远超认证辅助与既定有限维护，不采用；不能以官方 SDK 名义绕过重新设计和原生能力验收                                                                                                                                                |
| Host 复用旧 capability RPC、删除单模型检查或把 native 伪装 managed                            | 直接违反迁移边界或证据合同，排除                                                                                                                                                                                                                                 |

协调应先有限复核本节的事实、推荐与结构门槛，再向用户集中说明上述 profile/任务来源取舍。结构决定前可继续无关的既定 D 工作，以及不改变生产绑定的固定 SDK/Extension 隔离可行性核验；不先接秘密通道或放开普通 native 新建。

#### 7. 后续有限证据清单（尚未执行）

- 固定 SDK 认证目录/取消/同步失败与安全序列化；合成凭据、临时 profile、无默认目录访问，不自动联网刷新模型。
- 固定 Pi 当前进程刷新后的模型可见性与同 native Session 切换；核对 PID/原生文件/Session/配置真实状态，缺入口则明确 NeedsRestart 和原会话恢复，不虚报同进程。
- 共享 Registry 的 pre-session 认证/已有 Session 认证两种 scope，旧连接/旧请求/重复答复/撤销竞态、秘密不进 raw event 或日志。
- managed 与 native 同名冲突、外部配置变化、活动任务修改拒绝、模型切换前后回执不串版本；原生观察不写 Farfold VerifiedSuccess。
- 完成相关实施后才按原分层节奏做真实 Provider 与同候选安装应用 D 出口；本次不运行这些检查，也不重跑 C。

#### 有限设计复核结论与待决边界

协调已独立只读核对固定 RPC 快照、ModelRegistry.refresh 委托、SDK 同步错误的敏感字段，以及 Host managed 派生/profile/NativeUnmanaged 限制；关键事实成立，支持“一个 ACP Adapter、SDK 认证/目录辅助、原 Pi 执行、稳定 profile 与每轮来源分离”的推荐方向。**这不是具体 schema/迁移方案通过**；启动恢复与 Provider 绑定结构调整需要用户决定，协调负责集中说明，不重复请求已批准的 pi-acp 有限维护许可。

后续具体方案还须补清稳定 profile 中多个 managed 版本的文件投影、秘密归属及冲突规则，模型选择到 turn admission 的原子捕获，以及既有 managed 会话沿唯一原绑定恢复、无双控制路径。需重启时必须明示并验证原 Session，不称无损。可选单次 Provider probe 不是本轮新增必需模型调用。用户结构决定前，仅限上述不改变生产绑定的隔离可行性核验及无关既定 D 工作；不实施新秘密通道、稳定 profile 结构或普通 native 新建。

本次仅追加既有实施记录；定向 Prettier 与 `git diff --check` 通过，未新增计划、报告或运行模型/原生验收。

### 2026-09-13 D 第二种模型/认证结构获准实施

用户明确回复“OK，选择第二种，推进开发吧”，由协调同步至原执行任务。批准的是上节有限复核的方向：同一 Host/ACP/现有 Pi Adapter，官方 SDK 只辅助认证/目录，Pi 本体执行；稳定自有 profile/启动连接与每轮 typed managed-version/native-observation 来源分离。该结构决定不再待批准，上节的等待表述保留为决定前历史；具体 schema、迁移和工程出口尚未通过，不能扩大为已实现或用户验收。

本轮先同步 AGENTS、PRODUCT、唯一活动计划与既有规格，再分片实施稳定引用和共享任务绑定合同。具体设计须处理多 managed 版本投影/秘密冲突、model-to-admission 原子捕获、认证取消/秘密通道及原 managed Session 的唯一恢复路径；增量达到可审查程度即提交协调有限复核，独立工作继续，不逐小改等待审批。不新增 RuntimeConnectionKind、Agent loop、Host 原生旁路，不借假 key 或删除模型检查凑通流程；native 账号/观察不伪装共享 managed 验证。旧 Pi、正式应用及日用数据/凭据保护和 D 同候选真实 Provider/安装出口维持。

### 2026-09-13 D 稳定 profile 启动引用首片

源码增加 schema 11 `runtime_owned_profiles`：独立 profile ID、完整 Runtime binding、显式旧 Provider-bound / stable 布局与命名为 `bootstrap_managed_provider` 的初始选择。连接引用唯一，构建、安装、Provider 历史版本以外键约束；没有任意程序命令或任意绝对 profile 路径。此初始选择仅支撑首片单模型启动，不是未来每轮 Provider 来源权威。源码 release manifest 同步 schema 11；未运行安装版，未升级真实 Dev/正式数据库。

普通 managed Pi ACP 新建使用随机来源的独立 profile/connection 身份，仍按原官方 Pi 进程执行。恢复先读取持久引用：stable 缺失拒绝、已有记录损坏/布局或完整身份不匹配拒绝，均不扫描 Provider 兜底。只有旧算法 full binding 可在记录不存在时精确识别历史版本与原 profile；目录/原生 locator/cwd/header 通过原校验后补录，后续从同一记录恢复。目录缺失不重建，符号链接拒绝；不更换原 Host/native Session，不重发。

注册顺序为验证固定程序/原生目标 → 持久启动引用 → 原生连接与 Session 登记。启动命令前失败或连接已经建立、随后失败且确认停止时，仅本操作新建 stable profile 在无 Session 引用时可定向清理；有 Session 引用则保留。初始化返回失败但调用方没有 transport 句柄时，保守保留 profile/reference，不凭 Runtime Stopped 推断已确认退出；这类未绑定失败资源的后续回收尚未覆盖。旧 profile 不走新建失败清理。

有限验证（隔离临时数据库/profile，未调用外部 Provider）：

- Pi 21 通过、2 个显式原生测试默认忽略（`31395/5cc046`）；包含新 profile 与 Provider 版本分离、保存新版本后的原选择恢复、损坏拒绝、缺失/符号链接拒绝、未引用清理/已登记 Session 保护及旧 native 冷恢复补录。源码原单模型配置与每轮 managed 校验没有放宽。
- Host 存储 9 通过（`6924f7`），包括 schema 10→11 的迁移前 SQLite 备份、旧 Session/草稿与完整性检查；这是数据库迁移证据，不是正式应用/数据配对恢复验收。
- 固定 Pi 0.84.3/Node 22.22.3 的既有无模型启动测试改用稳定 profile 后通过（`6743/5e58a3`，6.62s），验证实际新建、配置 ACK、工作台读取、Host 绑定及已登记 profile 不可按失败回收；拒绝模型服务计数为 0。未运行模型任务、认证、安装 UI 或 C 全量回归。
- 保留首次失败：新增迁移测试未限定 `OpenFlags` 路径导致 E0433（`48178/c4ebb3`，并发已启动存储命令 `66913/e8faf9` 同因失败），限定为 `rusqlite::OpenFlags` 后修正；旧路径测试混用 `/var` 与 `/private/var` 的文本比较失败（`48828/0ae3fa`），改比较 canonical 目录，原 native 身份校验未放宽。更早未加入新增测试的 Pi 17 项通过仅是受影响旧合同检查，不计为本片新增测试证据。

协调已对具体源码及最终清理边界作有限只读复核，未发现新阻断；最后保守收紧后的 owned-profile 4 项复测通过（`12115/2ba2e3`），clippy 通过（`31466/ae0ceb`）。首次 clippy 的新函数嵌套 if 警告（`75800/d52ecd`）已改为 let-else。按协调约定，本首片有限工程通过，不再为日志重复等待审批。DB 引用与目录删除不原子；目录清理失败可能留下无引用目录，不能据此扩大扫描删除。本片不是 D 完成；多 managed 版本投影/秘密冲突、typed 每轮来源与 admission 原子捕获、SDK 认证/目录及安装真实 Provider 出口仍待实施。

### 2026-09-13 D 固定刷新证据与版本秘密投影小片

固定 Pi/SDK 0.84.3 隔离实验 `fixed_pi_profile_refresh_keeps_native_process_session_and_history` 通过（`91027/aa8e35`，6.28s）：独立 SDK 进程在同一临时 profile 刷新后可见新增模型，但运行中的 Pi 目录仍不变；经临时官方 Extension 的 `ctx.modelRegistry.refresh({allowNetwork:false})`，原 Pi PID、native Session、原生文件与 entries 全部保持，随后原生模型切换确认成功，本机拒绝模型服务计数 0。此为固定组合可行性证据，不是生产认证/刷新入口，也不是 OAuth 或整个工作台验收。

随后在仍单模型的 stable profile 上实施版本隔离与秘密字面量合同。原生 Provider alias 由共享 Provider connection + config version 派生，每版本不同；共享 canonical secret 仅投影到 700 目录/600 `models.json`，这是私有派生明文，不声称加密。按固定 Pi 原生 resolver 规则转义所有 `$` 与前导 `!`，不让 key 成为命令或环境模板；旧 Provider-bound profile 的 env 路线不改。新增原生同 alias auth.json 遮蔽、符号链接、非法对象与大小检查，冲突不覆盖任何一方，其他 native 条目不改。不存在需保护的此前 stable 安装会话：首片至今均未运行/替换安装应用，stable 数据仅在自动清理的隔离临时 profile 中，不为临时测试布局新增兼容路径。

新内部完整性对象不实现 Debug/Serialize；在发送前与实际 Provider 验证写入前核对配置摘要、受控目录/文件权限和 native 凭据遮蔽，发现漂移拒绝发送或拒绝托管验证，Stop 仍可按原身份执行。两次文件观察不是整轮监控或外部写入 CAS，不能证明外部进程中间没有改写又还原。当前仍完整比较单模型配置，不宣称 native 编辑、多版本读改写、授权目录或 typed native-observation 已完成。

本片定向证据：

- 固定官方 resolver 验证 10 种合成凭据（普通、`!`、`$`、`${...}`、`$$`、`$!`、混合及 Unicode），先断言不会执行命令/读取环境再核对解析值逐字一致，仅输出版本/数量：`24305/68bf4f`，1 通过，1.84s。
- profile 定向 3 通过、1 原生验证默认忽略（最终 `7b3a09`）；覆盖新旧版本别名、原版本恢复、700/600、公共绑定无秘密、native 冲突/保留与符号链接。Pi 22 通过、3 原生验证默认忽略（`65464/2bc414`），新增漂移阻止 prompt/Provider 验证但不阻止停止。共享 coordinator 31 通过（`e83fe8`），clippy 通过（`20579/afc81e`）。
- **新 alias/literal 格式重新验证**固定 Pi 无模型启动：`50442/d59ed3`，1 通过，5.97s、模型请求 0；不直接复用前一 profile 格式的启动结果。另把既有本机模拟模型单请求/原生落盘与冷恢复测试切到 stable profile，`77570/276793`，1 通过，6.95s，1 次本机模拟请求、0 次外部 Provider 调用，冷恢复不重发。

协调已有限核对本片源码，无新阻断；要求保留上述时点观察和未安装边界。随后进一步收紧 Host admission→send：发送函数显式接收本轮捕获的完整 managed binding，在同一 connection 锁中核对身份、代次、operation、当前模型、私有配置及 Provider/version 一致后立即发送；不在发送时重新选择版本。确定性测试验证“相同模型字符串、配置版本在接纳后改变”返回 NotSent、无未决发送，恢复原 binding 才可发送。最终 Pi 23 通过、3 原生测试默认忽略（`44659/936bd1`），clippy 通过（`90041/a9f5d5`）；协调对锁定范围和原 binding 传递再次只读复核，无新阻断，允许本小片有限工程收束，不因只改 Host 锁重复模型调用。定向 Prettier、Rust fmt 与 diff whitespace 检查通过。原生认证、多模型版本授权/文件更新、typed native-observation 和 D 安装出口未完成，继续作为当前后续，不外推本片。

### 2026-09-13 D 适配器同进程 profile 刷新小片

用户再次明确要求按既定计划继续开发，不重复讨论已批准结构。本片把此前隔离可行性接入现有维护适配器，未启用 Host 多版本应用或认证 UI。`profile-extension.ts` 的有限官方 Extension 源码嵌入已验证 adapter bundle，每个 Pi 进程创建 700 临时目录/600 源码，通过官方 `--extension` 加载；使用随机命令名，在 native `get_commands` 精确核对唯一 extension 命令及 `sourceInfo.path` 后才调用，不在未注册时让命令掉进 Agent。源文件在进程 exit 时定向清理，不下载额外程序、不创建 SDK Agent Session。

协商后的 `_pi/refresh_profile` 只接受绑定 Session ID，要求原生 idle，并通过 `ctx.modelRegistry.refresh({allowNetwork:false})` 刷新同一 Pi。私有原生 notify 在公共事件/UI 转发前消费，严格核对 nonce、原 Pi PID、刷新前后 native Session/file 和最终 idle；15 秒内无可信回执则结果 Unknown，逻辑连接失效并请求终止 Pi。**SIGTERM 请求不等于确认退出**，不能写作成功停止；临时源码在进程确认 exit 后清理。刷新成功也不等于授权目录、Provider Applied/VerifiedSuccess 或 OAuth 成功。扩展捕获原生异常但不传递凭据、异常 cause 或原始消息；用户原生通知和其他命令继续按原接口呈现。

有限证据与首次失败：

- 初始定向 25 通过（`2cf831`）、typecheck `72217f`、bundle build `a6dca9`；原固定差异实验改为真正受限 ACP refresh，独立只读 fixture 核对 PID/native 身份。固定 Pi 0.84.3、Node 22.22.3、SDK 0.84.3 与该 bundle 的测试 1 通过（`5404/c78e36`，7.71s），外部 SDK 新目录不代替 Pi 当前目录，刷新后新增模型可见/可选择，entries 不增加，模型调用 0。
- 带实际原生 user/assistant 对话的原冷恢复测试补入 refresh：固定 Pi 通过本机模拟 HTTP 完成唯一一次任务后，刷新前后 native JSONL 字节完全相同，冷恢复保持 Host/native Session 且不重发。`13325/13448e`，1 通过，9.36s；1 次本机模拟请求，0 次外部 Provider 请求。不是安装 UI/真实账号验收。
- 独立协调指出 P2：原生 UI 答复绕过 RPC request 的写操作保护，native idle 不能代表无未结对话。先添加三项回归，`a0d099` 首次全部失败，分别证实 idle dialog 未结仍允许刷新、刷新期间答复直接交叠、已有 UI write callback 未完成仍允许刷新。随后复用 PiUiBridge 的 pending/remotePending/handling 状态，在 ACP 刷新前后拒绝未结 UI；原生 UI 写入在 await 前计数，刷新拒绝已有写入，刷新期间后来收到的有效答复等待有界刷新结束后按原 ID/值只写一次。Unknown/关闭后不写、不重试，不把有效答复静默消费为成功。
- 三项原失败复测通过（`23e606`）；加上 Unknown 后排队答复不得写入，profile/session/UI 定向 39 项通过（`f0c1b9`），typecheck 通过（`be6411`）。最终适配器全套 **153 通过**（`99319/6a59f2`，9.29s），最新 bundle 重建通过（`16dd99`）。并发修复未改变 Extension/ACK/原生模型逻辑，按定向节奏复用上述固定原生证据，不重复付费或安装验收。
- Rust fmt 初检仅发现新增断言换行（`1cbd20`），已局部修正；不修改无关 Rust 文件。原有 Pi 启动超时与历史 ACP EOF 波动仍未知，本片不声称根治。

本片仍未更新任何安装应用、真实数据库或账号；源码 schema 11 不变。多版本授权及受控文件投影、typed 每轮 native-observation、认证取消/秘密传递、普通无 managed key 首次使用与 D 同候选安装出口仍为后续工作。

协调对刷新 P2 修复已有限复审通过，核对未结 UI 前后检查、写入前计数、刷新 finally 释放及 Unknown 后排队答复不写入，无残留具体阻断。最终 Rust fmt（`6c4b5e`）、diff whitespace（`b5c656`）、定向文档 Prettier（`3bdaf1`）通过。

### 2026-09-13 D typed 模型来源与共享持久化基础

用户持续明确要求按既定计划开发。本增量先引入 `PiModelSource` 的 `managed_version` 与 `native_observation`：精确匹配已有 managed Provider/version/native selector 才返回托管绑定；同 alias 下其他模型、未匹配的 `farfold-managed-` 命名空间或非法 selector 拒绝，不通过降格为 native 绕开约束。原生观察只携带 Runtime Provider/model/native model ID，不产生账号、端点或凭据修订证明。

Host admission 捕获该 typed source，coordinator 从中提取精确托管版本，并将同一 source 传给原持锁发送边界重验。状态中的 `managedProvider` 仅为当前 typed managed 来源的派生展示，不再对 native 观察回填启动 Provider；前端 Provider 验证投影仅接受 typed `managed_version`，即使遗留 Provider 字段与模型文本匹配也不能将 native 观察显示为托管验证成功。现阶段 native 仍在 admit 前明确拒绝，未创建无来源任务。Pi 定向 25 通过/3 原生默认忽略（`54631/f1ceee`）、共享 coordinator 31 通过（`23594/96978e`）、前端关联 44 通过（`9829/ca2c8d`）、typecheck（`646f7c`）、clippy（`46644/625a65`）通过；协调对 typed 来源和发送/展示边界有限复审无新阻断。

随后源码推进 **schema 12**：在同一 `turn_provider_bindings` 内增加来源分支，不建第二套任务历史。旧 managed 行原样迁入，非空 Provider/version 与两个原有外键不变。native 分支必须不含共享 Provider/version，要求完整 Farfold/native Session、连接、安装、Runtime product/build/adapter、正代次、native model 与观察时点；复合外键约束同一 Session 身份。insert-only API 不覆盖既有来源，不创建 Provider 或请求验证投影；用户明确删除 Session 时仅其 native 观察按外键 cascade 清除。来源分类和持久绑定均不证明当前在线代次有效或凭据可用。

coordinator 的持久化分支已按 typed 来源区分写入；**native 分支尚未进入实际派发流程**，当前守卫仍在 admit 前拒绝 native。基础代码暂以 `turn.started_at` 填充观察时点；真正接通时必须改成实际捕获/复核原生来源的时点，并在同一接纳→发送边界核对来源、原会话和代次，不能凭任意正代次或已写存储行放开任务。原生账号认证、无 managed key 首次使用、多版本授权/文件投影、native 任务派发/恢复和 D 安装出口仍未完成。

共享存储与扩大回归：

- 存储定向 11 通过（`56510/b82bd1`）：schema 11→12 保留原 managed bound version、Session、草稿及只读迁移前备份，前后 quick_check/FK 检查通过；native 完整身份/代次/时点/命名空间/模型不匹配拒绝，不覆盖既有 Turn，不产生共享 Provider/VerifiedSuccess，显式 Session 删除清其观察。旧 schema 7/10 升级 fixture 改为直接执行对应历史 SQL，而非从当前结构删表后伪装旧版。
- 共享存储变更触发一次全 Rust 自动回归：**440 通过、21 默认忽略**（`87502/d949b6`，18.89s），包含模型来源与共享 Provider/删除/迁移/恢复合同；默认忽略的固定原生/模型验收不冒充此次执行。clippy 通过（`98905/fe9723`）。最新 schema 12 的 TS 类型检查（`89103/242998`）及关联 44 项（`78939/63d0b3`）通过。
- 保留总前端测试首次失败：根 `vitest run` 错收集维护适配器的 `node:test` 文件，39 个 suite 报 No test suite，前端 291 项断言自身通过，但总命令失败（`91926/8aab61`）。依据运行器归属修正 `vitest.config.ts` 排除 adapter 路径，同时根 `test` 脚本显式继续执行 adapter 自有 Node 测试，不以排除代替验证。修复后根命令整体通过（`1428/266e05`）：前端 **291 通过**，adapter **153 通过**。

协调已有限复审 schema 12 的两个来源分支、旧 managed 外键、完整 native Session 约束、insert-only/cascade、迁移事务与备份证据，无具体阻断；要求保留实际来源捕获与派发共同接通门槛。源码 release manifest/AGENTS 同步 schema 12；本轮未打开或升级真实数据库，未构建/替换安装 app，不外推为 D 完成。

### 2026-09-13 D 实际来源捕获、派发前复核与原生回执分支

用户继续明确要求推进后续开发。本轮先将模型观察接入实际 managed 提交路径：Host 在全局 controller 锁外通过既有 `_pi/workspace state` 读取原 Pi，核对原生 ID/file、完整空闲状态和实际模型与 typed 配置观察一致。私有 `PiPromptModelObservation` 携带完整 Runtime binding、Host/native Session、代次和该原生读取的回执时点；admit 重取目标，持久化与持连接锁发送复核同一观察。native 持久化基础不再用 `turn.started_at` 伪作观察时间，并拒绝观察晚于接纳。此时点是 Host 收到真实读取后的时间，不是 Pi 凭据修订或全程模型不可变证明。

随后在已维护 adapter 增加协商的 `promptModel`：严格解析有限字段的原生 Session/file/provider/model 预期，在原 `prompt` RPC 写入前重新读取 `get_state`；同一适配器写保护排除模型/配置、刷新和重复 prompt，Stop 可发且同步作废准备，晚到 state 不发送。原生 UI 答复先计数并等待有界准备结束，拒绝交叠任务但保留原 ID/值的一次答复；紧邻写入的 Session callback 排除旧 pendingTurn、取消、未结 UI 或连接失败。文本和 images 原样进入官方 RPC，不把 Host 元数据拼进提示词，不增加 Agent 循环。内建 slash 保持原有专属处理，不生成模型调用证明。

只有尚未调用原 prompt request 的失败使用专用 NotSent 错误；ACP 的指定错误码与显式标记同时匹配，Host 才释放该接纳，不自动重发。原 prompt 写入后的传输失败或畸形 ACK 走逻辑连接失败与 Unknown；不能因为没有 native Agent 事件而改称未发送。固定官方 `dist/modes/rpc/rpc-mode.js` 的 prompt 分支表明，`success:false` 对应原生 preflight 尚未成功，沿既有显式失败处理；没有修改 Pi。适配器读→写排他不等于任意 Runtime Extension 内部模型变更的原子 CAS，最终不匹配回执仍不能宣告成功。

共享回执校验现在显式接收本轮 typed source：managed 要求全部四项绑定和版本一致；native 要求不混入 managed 字段，并核对原生 provider/model、Host Turn、native Session 和任务时间。native 的成功或失败回执只作来源校验，不创建共享 Provider 或托管 VerifiedSuccess/VerifiedFailure。**native 入口仍在 admit 前拒绝**，该回执分支目前是合同基础，不是实际原生账号任务验收。

有限验证与首次失败：

- 来源捕获首次 Pi 定向为 24 通过、1 失败、3 默认忽略（`51604/5dae61`）：错误复用历史读取 gate，导致历史请求未返回时无法进入可停止任务。明确复现后改成独立只读快照请求，保持返回身份校验；复测 28 通过、3 忽略（`2320/0dc81b`），原停止回归恢复。新增 12 类模型/身份/空闲漂移均零 prompt、零来源绑定；全身份/未来时点、held read 不占全局锁、旧代次不 admit 均通过。
- typed 回执新增测试第一次编译缺少局部 `serde_json::Value` 导入（`38397/f2fc7f`），补入后共享 coordinator 33 通过（`20077/d9dde0`）。覆盖 native 正/负回执不产生 managed 投影、旧 Turn/Session/model/时间拒绝，以及同模型文本不同 managed 版本和保留命名空间拒绝。
- adapter 发送前/交互/刷新定向 38 通过（`e67cc1`），首轮全套 163 通过（`59436/cb761e`）。另外补入真实 PiRpcProcess→PiAcpSession 的写后传输失败/畸形 ACK 回归，10 项 preflight 定向通过（`74d337`），明确 Unknown、不可续发、无自动重试。Host Pi 定向 29 通过、3 忽略（`10633/995552`），包含指定 NotSent 与错误码不匹配 marker 的占用区别，均不产生请求验证。
- adapter bundle 重建通过（`923c07`）。只新增 Host 捕获时，固定 Pi + 本机模拟 HTTP 单请求/原会话冷恢复通过（`91035/0c3360`，7.62s）；接入最终 adapter preflight 后再次通过（`30574/e59f3c`，8.11s）。最终测试补入真实原生负例：故意发送不匹配模型，返回指定 NotSent，本机模型服务零调用、native entries 完全一致；同一会话随后唯一一次正常请求成功，refresh 保持 JSONL 字节一致，冷恢复不重发（`78282/f65438`，1 通过，6.55s）。全部使用固定 Pi/Node 与隔离合成凭据；累计本轮三次本机模拟请求，外部 Provider 调用 0。不是账号、安装 UI 或 D 阶段出口。

最终 adapter 全套 **164 通过**（`82529/09ab92`，9.74s），类型检查（`78029/b118e0`）、Rust clippy（`15779/42e668`）通过。未运行整应用构建，维护 bundle 的构建与固定原生测试不冒充安装验收。

协调分别对实际捕获、adapter preflight/typed receipt 作有限只读复核，两片均未发现当前范围新增 P1/P2；要求保留读写排他与 Runtime 内部 CAS 的区别，不凭合同基础开放 native 任务。下一步仍需原模型冷恢复一致性和来源/admission 接线：已核对固定 SDK `core/sdk.js` 会在找不到原模型或无对应认证时选择其他默认模型，不能把这个默认选择冒充原模型恢复。多版本授权/受控投影、原生认证、无 managed key 首次使用、工作台与同候选安装出口未完成。源码 schema 12 不变，未打开或迁移真实数据库，未替换安装应用；前端行为未改，本轮不重复未受影响的前端/安装/C 验收。

### 2026-09-13 D 原模型冷恢复与空分支保护

用户再次明确要求连续推进，不在小片结束时暂停。沿现有 Adapter 增加私有 restore Extension 命令，固定 SDK 公共 `buildSessionContext` 提供原生分支模型语义；nonce、命令来源、PID、原生 ID/file、前后 idle/state 与原模型必须一致。明确模型未恢复使用专用 blocked 结果，畸形/丢失确认保持 Unknown；失败仅关闭本次尝试，不注册替代会话、不派发任务。

协调提出并实际复现 P2：固定 `sdk.js` 只在当前分支存在消息时恢复历史模型；空消息分支会先 append 默认 model/thinking，若其他分支已有 assistant 还会写回原文件。因而启动后才读取的 history 与 state 一致也不证明原模型恢复。修正把 authority 提前到 spawn 前：

- Adapter `restore-source.ts` 用 O_NOFOLLOW/nonblock 打开原文件，64 MiB 上限、同次读前后 metadata、schema 3/header/ID/cwd、坏行/重复 ID/父链防环检查；不迁移、修复或重写文件。分支/模型仍调用固定 SDK 公共纯函数，不调用 `SessionManager.open` 或 SDK AgentSession，不把历史解析放进 Host。
- SDK 从已验证 capability-runtime Node 的同资源根显式定位，核对固定 0.84.3 和公共导出；不搜索 cwd、全局依赖或用户 Pi 安装。`ModelRuntime` 仅静态目录/config（refreshOnCreate false、allowModelNetwork false），要求目录精确成员、CLI resolver 无 warning/合成 fallback，才传官方 `--provider/--model`。不登录、不刷新 token、不调用模型；仅说明选择可解析，不证明认证或请求成功。
- spawn 前复核原文件；spawn 后 Extension 用官方 `getBranch` 确认原 leaf 仍在当前分支，仅允许随后原生 model/thinking 设置记录，模型与启动前来源、ACK/current/state 必须一致。原文件 inode/前缀必须保留。不是阻止任意外部写者的 CAS，也不在失败后自动回滚原文件。未知格式、无历史模型和静态目录不支持的模型（含部分动态/extension-only 模型）明确阻塞，不能据此宣布完整原生能力保留。
- 隔离 bundle 检查暴露原 adapter 的源码目录依赖：ACP/Zod 原为外置，版本由最近 package.json 猜测。现将既有协议依赖和 package 身份嵌入 bundle，原查找实现删除；Tauri 资源补两依赖许可证。测试将唯一 bundle 复制到临时目录，用既有 staged `resources/pi-capabilities/runtime/node` 与 SDK 启动，不从 adapter 源码父目录加载依赖。不是安装应用验收。

首次失败与定向修复均保留：

| 情况                                                            | 证据及处理                                                                                                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| generated Extension 动态 import 不适用于固定 Bun virtual module | `7930/53c963` 冷恢复失败；脱敏分类后 `65826/abe163` 确认 parser unavailable。改官方 loader 支持的 static import 后 `38592/3fd153` 通过，未 patch Pi                                                       |
| 仅 post-spawn authority 的空分支 P2                             | 新 fixture 首次字段误用编译失败 `72561/b20b28` 修正后，`39769/db3e40` 真正复现错误接受；启动前保护后 `73784/1812e8` 通过                                                                                  |
| 启动前文件/目录单测                                             | `17860/b03a35` 暴露 macOS 临时路径父目录别名过度拒绝；保留文件 O_NOFOLLOW 与 inode 检查，允许原有父路径别名。`14354/96ce3e` 再暴露 CLI 会合成未知模型；补目录精确成员与 no-warning 后 `41593/dd66fc` 通过 |
| 全 adapter 旧 mock 缺新方法                                     | `97938/262d61` 162 通过、7 失败；定向 `0f6054` 确认缺 verifyRestoredModel，补测试替身合同、不放松生产守卫；`b6d711` 16 通过                                                                               |
| 隔离 bundle 身份缺失                                            | `24292/d1aae3` 未能通过 initialize 版本核验；改构建嵌入身份后 `45226/545e7b` 隔离失败保护及修复恢复通过                                                                                                   |

最终当前源码检查：Adapter **170 通过**（`20320/529c8e`），typecheck **通过**（`30012/8b277c`），bundle **通过**（`83872/16bd3d`）；固定 Pi 隔离 bundle 空消息分支缺失拒绝/修复恢复 **1 通过**（`68002/3e39f0`，7.66s、模型请求零），固定 Pi 已有消息/单次本机模拟模型请求/冷恢复/原模型缺失拒绝及修复 **1 通过**（`9246/62786c`，12.30s、仅一次本机模拟请求、冷恢复不重发）。两者均含最新原 leaf guard。Host Pi 定向 **29 通过、4 默认忽略**（`53868/04f5ec`），clippy `-D warnings` **通过**（`15149/cccfe5`），diff check **通过**（`35fadd`）。既有未受影响 C/前端/安装证据不重跑。协调对 pre/post authority、父链安全与官方末叶语义、静态精确目录、原分支/前缀和资源定位作有限复核通过；未独立重跑。已复现空分支 P2 在本范围标为修复，直接继续既定 D，不再次等待例行批准。

源码 schema 12 不变，native admission 继续关闭，单 managed 模型约束不放松。下一步继续多版本授权与受控投影、来源/admission、原生认证及工作台；应用、真实数据库、日常账号及历史未改。

### 2026-09-13 D 精确版本授权与配置读取

按用户既定授权连续开发，源码推进 schema 13：`runtime_profile_provider_versions` 以 profile/Provider/config version 为精确主键，引用原 Provider 历史版本，不建第二套 Provider 或任务历史。迁移只种子化 stable profile 的原 bootstrap；legacy 不自动转多版本，全局 latest 不自动授权。授权采用 IMMEDIATE 事务，复核完整 Runtime binding、stable Pi 与精确 current managed version，幂等插入不代表文件已写入、已刷新、Applied 或请求验证。启动前对新建 bootstrap 再校验 current version；历史恢复不重新要求旧版本等于 current。原 bootstrap 授权缺失时读取及重复登记拒绝隐式修复。

授权基础验证：owned profile 5 通过（`52572/381548`）；真实 schema 12 fixture 升级 1 通过（`89657/27e437`、`0dfe3f`），保留原 bootstrap、草稿、native ID、迁移前 schema 12 备份，FK/quick_check 通过且已引用版本不能删除；HostStore 定向 12 通过（`8fda8b`）；Host Pi 30 通过/4 默认忽略（`58212/f1eb9d`）；clippy 通过（`82288/5cc72d`）。协调已有限只读复审授权基础通过，明确下一步文件投影与刷新继续，不重复例行审批。

首次失败保留：初次编译缺 RuntimeBuildId 引用、fixture 访问私有数据库连接、方法暴露 crate-private 类型（`17565/aea269`、`12453/0c213f`、`31084/7d362e`）；修正作用域并让测试只读写自己的隔离 SQLite fixture。随后旧损坏 profile 测试被更早的 bootstrap 授权缺失守卫拒绝（`37672/5e5dbd`，4 通过/1 失败），更新预期到更早的拒绝原因，未绕过守卫。

后续增量只接通**配置读取与来源集合**，尚未增加 live 文件写入或 apply 入口：

- 恢复自有 profile 时逐一验证实际存在的 `farfold-managed-` slot 属于授权集合，并用同一历史 secret/config renderer 精确比对内容。未授权 slot、受改动 slot、缺 bootstrap slot 均拒绝，不重建缺失引用。授权但未投影的版本不进入实际来源集合，也不妨碍原 bootstrap 恢复。
- 非 reserved 原生 Provider 及其他顶层配置保留原字节；全部已投影 alias 都检查 native auth shadow。models 读取复用 no-follow/nonblock、private regular file 与 1 MiB 上限，活连接继续以整份配置摘要检查漂移。这里没有文件修改 CAS 或外部写者锁。
- `PreparedAcpProfile.managed_versions` 进入原 Pi 连接；实际模型观察只精确匹配已验证集合，不能把未匹配 reserved alias 降格成 native。`verify_task_target` 仅检查原连接/代次，不再返回启动 Provider 冒作当前来源；任务实际来源仍经过原生 capture 和发送前复核。普通 `set_config_option` 和 `open_native_session` 的 bootstrap 限制没有解除，native admission 仍关闭。

读取测试首次 2 通过/1 失败/1 忽略（`34607/0519ba`）：旧 fixture 从未登记 profile，被新引用守卫正确拒绝。补齐隔离 fixture 登记，并保留缺引用负例后，配置测试 4 通过/1 默认忽略（`35665/03d2bf`）；覆盖授权但未投影、未授权内容不覆盖、原生配置保留、第二 slot auth 冲突、配置漂移、缺 bootstrap 和超限文件。最新 Host Pi 30 通过/4 默认忽略（`78963/b481e7`），包括精确多版本来源分类和原任务版本漂移拒绝；共享 coordinator 33 通过（`63721/53d5f2`），clippy `-D warnings` 通过（`63381/f5295e`），Rust fmt 与定向 Markdown 格式通过（`19744/348471`、`412a9f`）。协调对本片配置读取/来源集合已有限只读复审通过，无具体阻断，未独立重跑或外推多版本切换可用。继续既定受控文件更新/refresh/apply 接线，无需再次例行审批。

本增量仅修改源码及临时合成数据；未打开或迁移真实数据库，未更新安装应用，未读取日常账号、调用外部模型或更改日常历史。完整多版本写入→refresh→选择/接纳、原生认证/首次使用、工作台及安装真实 Provider 出口尚未完成，D 不标完成。

### 2026-09-13 D 同会话多版本应用与未知状态收口

用户要求暂停汇报后又明确恢复，原任务、原检出继续；短暂暂停期间未新增实现或启动检查。恢复后接通已有 stable profile 的多版本应用，仍使用原 Host controller、ACP connection 和 Configure operation，不新增 Agent loop 或 Host RPC fallback：

- `PiManagedProfileIntegrity::project_version` 验证原 profile/path、完整配置摘要、历史 slot 及新 alias 凭据冲突；只增加精确授权版本，保留原生 Provider、顶层内容及旧 managed slot。私有临时文件写入并 fsync，提交前复核原文件 device/inode/原字节及原生 auth shadow，再原子替换；不盲目覆盖漂移、不删除历史版本、不自动回滚外部内容。幂等应用不换文件 inode。该检查仍不是任意外部写者 CAS。
- `apply_provider` 在既有 controller/connection 排他内准入、写配置及派发，等待原生响应不占 controller 锁。真实读取原 Session 完整 idle/model 后提交文件，再沿同一 ACP `_pi/refresh_profile` 确认原 native descriptor，选择版本 alias，读取实际 idle/model 并重新核对配置/current version，最后记录 Applied + NotRequested。每一轮依旧从实际原生模型捕获 typed source，在原 prompt 写入前重验，不把启动 bootstrap 作为当前版本。
- 写后失败一律保留 Configure pending，不发布新来源或 Applied，不自动重发，原配置摘要及旧模型只作最后确认缓存。新建仍要求 bootstrap；冷恢复允许 Adapter 已确认的原历史 managed 版本，普通模型选择仅允许已授权且实际投影的精确集合。native admission 仍关闭，未知格式/静态目录无法确认的模型仍明确拒绝。
- 现有 Provider 表单接入“应用到当前对话”；显式“新对话”仍走原新建流程，旧 Pi 路径不变。没有新增认证入口或私有账号迁移。

协调发现并收口 P2：当 A 保持 VerifiedSuccess、写入不同 Provider B 后结果未知，旧 `current_status`/前端 helper 会把最后确认的 A 继续当作当前已验证。定向测试首次 **明确失败**（`136db7`，unknown 仍返回 applied/verified_success）。修正为公共 `configurationState` confirmed/changing/unknown；后两者当前 `modelSource`/`managedProvider` 为空，`lastConfirmedModelSource` 独立保留。前端非 confirmed 不显示当前成功投影，明确标记“当前模型未确认／上次确认”，关闭发送和当前会话再次应用。原 A 验证记录不删除，B 不产生成功。协调有限只读复核通过，未独立运行验收。

本片证据与首次失败：

- 新 apply 模拟测试首次 1 通过/1 失败（`29356/6d5457`），失败是误断言保存新版本后不存在投影；既有共享服务会把原投影推进到 Pending。修正为应用失败前后投影完全不变，复测 2 通过（`60972/89eeac`）。随后扩展不同 A/B Provider、A 原 Verified 不变、wrong refresh/malformed select/explicit reject、旧 Session/代次不写、held selection 可显式断开，3 项通过（`74857/ea349c`）。没有以不存在模型请求代替正确副作用断言。
- 固定 Pi 0.84.3 / Node 22.22.3：`fixed_pi_managed_version_apply_request_and_cold_restore` **1 通过**（`84985/fb0d84`，8.71s）。同一 native Session/connection/generation 应用第二版本，应用阶段模型调用零；唯一一次本机模拟 HTTP 请求实际使用第二版本合成 key，并验证该版本；停止后按原身份冷恢复该模型，原历史前缀保留、不重发。外部 Provider 调用零，不是安装真实账号验收。未改 Adapter 执行实现，因此复用既有 bundle，未重复冷恢复修复或付费请求。
- 控写测试 **1 通过**（`87965/2cb853`）：原生内容保留、stale/shadow/drift 拒绝且不覆盖、私有模式、幂等 inode 不变。配置模块最终 **5 通过/1 默认忽略**（`23297/45c4fc`）；共享 coordinator **33 通过**（`54905/e3e998`）。
- 新停止交叠测试初次单项通过（`48450/3175e5`），扩大 Pi 定向后 **32 通过/1 失败/5 忽略**（`67164/9c53b7`）：测试自身先发诊断轮询，可能占用未确认请求而阻止 apply 准入。补确定性 held read 负例，确认既有 unresolved-work 守卫在写入前拒绝；正常断开分支先无请求地等到 Configure admission，再轮询原生 held select。单项复测通过（`19845/7098a7`），扩大 Pi 定向最终 **33 通过/5 默认忽略**（`70438/8fa52d`）。不放宽准入守卫，也不以一次重试成功宣称 Runtime 故障根治。
- 前端关联 **47 通过**（`91611/3c3ac2`），类型检查通过（`15587/6ca701`）。新双 Provider mock-IPC 浏览器成功/未知冒烟通过（`6812/9921f6`、`85940/89f085`）：先展示 A 已验证，保存 B 后只向当前 Session apply 一次，不 restart/create/open/prompt，草稿保留，未知只显示最后确认 A、再次应用禁用。原 managed 新建冒烟也通过（`86057/64ed0f`），不把新 apply 改成隐式新建。
- 截图发现 metadata 与 form 在双行 dialog 中挤压重叠，功能断言通过但视觉不合格；修正 Pi 弹窗单一滚动 body，不改其他 Provider 页布局。900/1440 尺寸新增几何检查无重叠/无横向溢出，已查看 900px 未知状态截图。图位于 `src-tauri/target/d-stage-pi-candidate-0912/frontend-smoke/provider-apply*.png`，仅浏览器 fixture，不是安装应用截图。
- clippy 首次报新配置事件条件可合并（`8406/41579e`），按既有 let-chain 写法收口后 `-D warnings` **通过**（`70763/e43b1e`）。未关闭 lint。浏览器环境沿用已安装的 bundled Playwright；仓库未添加浏览器依赖。

当前继续 D 原生认证：已核对固定 SDK 的 `ModelRuntime.login/logout`、`AuthInteraction` 和 `AuthStorage` 提交/取消合同；`CredentialSynchronizationError` 表示凭据可能已经改变但同步失败，后续不能误写为未保存或自动重试。这里只是接口核对，原生认证、无 managed key 首次使用及 native task admission 尚未实现。保持已批准 SDK 辅助、Pi 执行路线，未引入 SDK AgentSession。源码 schema 13 未再次变更，未打开真实数据库或替换日常应用。

### 2026-09-13 D 临时原生登录通道与同进程刷新

用户再次要求按唯一计划继续，未停在上一片出口。认证现沿原 ACP `_pi/auth` 的 start/status/reply/cancel 接线，不使用普通 elicitation/session 事件或旧 capability bridge fallback。SDK 公共 `ModelRuntime` 从固定资源 SDK 加载器取得，指定 owned auth/models/models-store 路径，仅辅助登录/目录；Pi 进程仍是唯一 Agent。未访问 SDK 私有 AuthStorage 字段，未创建 SDK AgentSession。

- Adapter 仅内存保留单认证 flow、单 prompt、最后 notice，严格类型/大小/Provider 保留命名空间和 HTTPS URL 校验；回复只送 SDK，清空当前 prompt，拒绝旧 Session/flow/prompt 与重复答案。SDK error/cause/credential 不透传、不写会话历史。整个 profile 的活动 Pi 进程持认证排他，阻止模型、任务、配置及 UI 写入，原生 abort 保留。认证前检查全空闲；成功后沿原同进程 refresh 确认原身份，写后未知保留排他直到显式断开。父目录及私有文件检查、固定 Buffer 有界读取保留 native config，不宣称任意外部写者 CAS。
- 凭据状态分 not_attempted/committed/unknown。只有成功登录或 SDK CredentialSynchronizationError 明确报告 committed；进入 SDK login 后的失败/取消不能据此声称未保存或回滚。刷新有独立 not_attempted/confirmed/unknown，不将保存凭据等同于当前模型应用或请求验证。全流程10分钟取消、原生连接关闭/Stop取消；SDK已进入后的未决结果不提前释放排他。
- Host 新 `pi_acp_native_auth` 复用原 controller/Configure，短请求等待不占全局锁，完整 Host/native Session/代次与 flow 校验；auth_flow 仅保存非秘密身份/token/原来源。成功还需读回原 Pi 的 idle/model 与 profile 完整性，才解除 Configure。未知继续不显示当前 Provider 成功。认证结果只作专用请求响应，共享 ACP 超时迟到响应被丢弃而不进入普通事件队列；不写认证 DB、模型任务、托管 Provider 投影。
- 原 Provider 弹窗增加托管/原生账号 tab，目录只返回原生 Provider 与登录方法。新增界面复用抽出的 `ProviderAuthPrompt`，旧 ProviderSettings 也用同一输入组件；secret/manual_code 遮蔽，提交即清空，精确 prompt 单次待回。原生页等待、取消、committed-but-unknown、显式断开与原草稿保持有浏览器合同。native 模型任务入口仍明确未接通，不能把该页或 SDK 目录称为真实账号可用。

首次失败及验证：

| 范围               | 证据                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter 定向       | 第一轮22过/1失败（`0c7d55`），合成SDK测试把固定Node文件误写成node/bin/node；核对实际资源后24过（`3e660e`）。未加全局SDK fallback。                                                                                                                                                                                                                                           |
| prepare 取消 P2    | 协调发现 held get_state 无回包会使取消永久停在prepare。真实 PiRpcProcess 请求层新测试对原await实现明确失败（`67670b`）；仅prepare增加15秒上限与独立可取消等待，每次迟到读取后再验signal。未释放响应即 cancelled/not_attempted、lease可重获、晚回零SDK/零refresh；24项定向通过（`d20b1f`）。协调有限只读复核通过，SDK进入后的unknown保护不放宽。                              |
| Host 编译与合同    | 初次错误为enum名称（`c93f60`）及测试tuple访问（`ea4151`），修正后真实ACP传输模拟合同1过（`61de44`）：旧目标/flow拒绝、成功/unknown/坏Session、0prompt、原Provider投影不变、无认证事件。Host Pi扩大34过/5默认忽略（`69005d`）。协调有限审阅通过，未外推OAuth。                                                                                                                |
| Adapter 全套与构建 | Adapter180过（`94568d`），类型检查通过（`1d43d8`及后续`98980c`），bundle构建通过（`d62992`）。共享SDK定位没有改变固定版本或恢复authority。                                                                                                                                                                                                                                   |
| 前端/浏览器        | 关联23过（`081fa9`），类型检查通过（`af3062`）。首次浏览器测试服务器已退出，连接被拒绝（`309a08`），尚未进入功能；确认端口空闲后重启隔离fixture。native-auth成功（`62eba1`）、提交后刷新unknown（`10f6ee`）、取消unknown并显式断开（`32e1ad`）通过；托管当前会话apply回归通过（`3e2680`）。900/1440无横向溢出，已查看900px unknown截图；截图与CLI证据不冒充安装应用。        |
| 固定Pi真实SDK      | 新 `fixed_pi_native_authentication_preserves_session_model_and_provider_evidence` 初编译误用fixture计数字段（`ea33f8`），修正后1过（`a2c9fc`，6.14s）。官方SDK接收合成Anthropic key并存入隔离auth.json，原Pi执行同进程refresh；同一native Session/generation、当前managed模型、native entries与托管Provider投影完全不变，模拟模型服务请求0。不是实际账号认证或原生模型任务。 |
| 静态检查           | clippy首次提示可用range pattern（`c2910a`），修正后-D warnings通过（`cce24d`）；Rust fmt、指定Prettier及diff check通过。未做整应用构建/安装替换。                                                                                                                                                                                                                            |

仍须补真实账号OAuth、退出登录、无managed key首次使用、native模型选择/任务接纳、完整工作台及D安装出口。源码schema13不变，没有迁移真实数据库、读取日常账号或更改日常应用/历史；不因本片API key合同通过删除旧Pi路径。继续后续依赖，不等待例行批准。

### 2026-09-13 D 原生退出、明确模型选择与逐轮来源接通

接续上一片，复用同一临时认证通道增加 `operation: logout`，只调用官方 SDK logout，不模拟登录或再次收集密钥。界面显示保存凭据类型并要求明确确认退出；提交状态和同进程刷新状态分离，SDK 进入后取消/失败保持未知，不自动重试。原生目录只输出有界 Provider/方法/凭据类型元数据，不输出凭据。此前 logout 定向证据：SDK 9 过（`784164`），Host 1 过（`0a03a3`），前端认证 5 过（`14dadf`），固定 Pi 登录再退出 1 过（`c3541c`，7.20s），mock-IPC logout 冒烟通过（`2a7bf3`）；协调有限只读复审通过。以上是隔离合成凭据，不是实际账号 OAuth。

后续原生任务增量：

- Adapter `_pi/workspace configuration` 复用原生 configOptions 构造。Host 认证提交/刷新成功后重新读取原 idle/model 与该目录，两者必须仍匹配认证前来源和完整 profile；不让 SDK 静态目录直接授权发送。
- `set_config_option` 保留原 Host/native Session、代次、空闲任务、Configure 排他及当前目录成员检查；明确 native model ACK 后，再读取实际 idle/model、核对 profile，才记录连接内 `confirmed_native_selection`。只有观察没有明确选择仍拒绝，思考级别修改不能替代首次模型确认。畸形 ACK、模型不匹配、结果未知保持 Configure 未决；管理版本应用清除原生选择标记。
- `nativeAdmissionReady` 仅在当前配置已确认且原生来源精确匹配该标记时为真。前端非 confirmed 不显示当前成功，原生状态不冒用 managed 投影。认证成功后重读工作台模型列表；已有 ModelPicker 选择及 Composer 发送走公共 Host，未新增 UI 或协议旁路。
- `host_pi_acp_turn_submit_blocking` 将 managed 四字段作为可选，仅原生来源分支全为空；接纳后、派发前复用 `persist_pi_model_source`，在原 `turn_provider_bindings` 写 schema12 全身份 native observation。保留实际模型 capture、controller 内再验与 Adapter prompt 前复核。原生回执核对身份但返回无托管验证；不是 Runtime 内模型 CAS 或账号/凭据有效性保证。
- 原生冷恢复保留 Adapter 启动前固定 SDK 原模型/分支解析与启动后原身份保护，Host 要求稳定 profile；仅该已核对原来源恢复可重新接纳，不替换模型/新建会话。动态目录或扩展私有模型未通过的仍明确阻断。

新增验证与首次失败：

- 类型检查首次缺一个旧测试的 `nativeAdmissionReady` 字段（`e1b98d`），补齐后前端/Adapter 类型均通过（`d5963f`、`06f332`）。新数据库断言误用 rusqlite 不支持的 u64（`9ff244`），改为实际 SQLite i64 后运行；未改变产品存储类型。
- 端到端合同先在遗留 managed-only admit 处明确失败（`d712ab`）；接通已存在的原生同表记录分支后，扩大 Pi 定向 34 过/1 失败/6 忽略（`9db18d`），失败是模拟器收到畸形无斜杠模型时自身 split 退出。夹具改用 partition，让畸形回执走被测未知保护而非夹具崩溃；最终 **35 过/6 默认忽略**（`875eac`）。涵盖明确选择、错模型、畸形 ACK、原生拒绝、零误发、完整来源身份和原 managed 投影不变。未以夹具失败宣称真实 Pi 故障。
- `fixed_pi_explicit_native_model_request_and_original_cold_restore` **1 过**（`521c19`，6.55s）：固定 Pi/Node，复制 bundle 到无开发 node_modules 的隔离目录；启动前准备独立临时 native Provider。明确选择后唯一一次本机 HTTP 模拟请求使用该合成 native key，同表记录 native_observation、托管版本为空、原 Provider 投影不变。停止后原 Host/native Session 冷恢复到原 native model、新代次，历史原字节前缀保留、不重发。不是外部模型或安装应用证据。
- 认证固定 Pi 回归 **1 过**（`362edb`，5.78s）：合成登录后原生配置目录新增 Anthropic 模型，logout 移除其保存凭据并再次刷新；原模型、身份、entries 和 managed 投影不变，模型请求 0。此目录成员证据不证明这些模型可成功调用。
- 前端关联 **46 过/4 文件**（`1446ee`）。mock-IPC `native-auth-select` **通过**（`f2e517`）：登录后目录增加 native model、明确选择后提交一次、完整目标/代次、无旧 RPC/新建旁路。浏览器没有原生进程或外部模型请求。900/1440 截图已产出，900px 工作台图已查看无重叠；位于 `src-tauri/target/d-stage-pi-candidate-0912/frontend-smoke/native-selection-*.png`。
- Adapter bundle 构建通过（`a1f199`，744.75KB）。协调对本片代码有限只读复审通过，未独立重跑固定 Pi 测试；结论不外推整个 D。

当前真实剩余：无 managed key 的首次 profile/认证/启动、实际账号 OAuth、完整工作台与原生能力对照、同候选安装真实 Provider 出口。未改变 schema13、日常应用或真实数据库，旧 Pi 仍保留，E 未开始，D 不标完成。

### 2026-09-13 D 无托管启动版本首次使用基础（接线未完成）

本片仍在开发，不是 Host/UI 首次使用闭环或安装出口：

- Adapter 仅在明确 `allowUnauthenticated` 且私有 profile 校验通过时允许无可用模型创建；默认仍 AUTH_REQUIRED。原生登录与目录刷新不能解除首次模型选择守卫，明确选择后须原 idle/model/可用目录一致。内存守卫不代表重启持久化确认。
- 固定 Pi 空 profile/合成 SDK 登录测试发现固定模型返回 `max` 思考级别，而 Adapter 类型仅到 `xhigh`，造成模型应用后配置 ACK 失败（`fc6f26`）。对照固定 SDK 后补齐 `max`，未知级别仍拒绝；相关 22 项通过（`b13a16`），固定空 profile 测试 1 过（`9b0ee8`，3.96s），无 managed key、零 Agent prompt。该测试绕过产品 Host，不能证明首次使用入口已接通。此前 Adapter 全套 182 过（`3587cf`）发生在最后 max 增量前，不冒充最终全套。
- 源码 schema14 仅允许稳定 Pi ACP profile 的两个 bootstrap 外键同时为空；同表迁移保留旧 profile、精确版本授权及其外键，不自动创建 Provider 或授权。准备结果采用可选 bootstrap，OpenCode 的必需 managed 类型不变；恢复读取原文件并核对精确授权，不重建丢失目录、不改认证文件。真实数据库未迁移。
- 当前状态核对重现了可选类型接线未完成的编译失败（`0ed085`）：生产读取/比较 5 处，连同测试共 9 处错误。显式处理 Option 并修正测试访问后，包含测试的编译通过（`dd77dc`）。无 bootstrap 的 Host 新建与打开在派发前明确拒绝，未借原生默认模型绕过未完成的登录/确认/冷恢复合同。
- Pi 现有回归 36 过/8 默认忽略（`a041e8`）；新入口关闭检查 1 过（`d669e1`）；profile 6 过/1 默认忽略（`92c868`），包含零凭据创建、无隐式授权、认证原字节保留、非法 managed 别名拒绝及缺失目录不重建；HostStore 13 过（`c826ab`），涵盖 schema13 到14 的 profile/授权/草稿/配对备份和外键完整性。
- 常规 clippy `-D warnings` 通过（`5f65af`），Rust fmt（`e30be8`）、指定 Markdown 格式化及 diff check 通过。额外 `clippy --tests` 未通过（`12bc1b`），指向 `opencode_acp.rs` 测试辅助函数的 `cmp_owned`；不改本片无关代码，也不将该检查写成通过。

下一依赖：同一 Host 创建、认证、明确模型选择及持久化确认串联。尤其未登录与已登录但未选模型两个状态，冷恢复均不得从默认模型自动取得发送资格；已选择分支保留原会话、原模型与不重发。上述 Host/UI 状态仍未实现，不宣称原生首次使用或 D 已完成。日常应用、账号和历史不变，现有可用 Pi 路径保留。

### 2026-09-15 D 无托管首次使用 Host/ACP 工程闭环

用户明确要求继续原任务并完成 D 最小闭环，不启动 E/Codex/P6 QA。实现继续使用公共 Host/ACP、既有 Pi Adapter 和固定 Pi 执行 Agent；官方 SDK 仍只辅助认证与目录，没有创建 SDK AgentSession、第二 Agent loop 或 Host/native fallback。

- 新建参数要求 `managedProvider` 与 `nativeFirstUse` 精确二选一。只有 schema14 的稳定 Pi ACP owned profile 可无 bootstrap；Host 在创建前、恢复时和每次任务前仍核对 installation、connection、profile、native Session 与 generation。
- Adapter 引入严格的 `authentication_required → model_selection_required → ready(provider, modelId)` 状态。登录成功只前进到待选模，不能发送；logout 回到待登录；失败、畸形回执、未知目录或实际模型漂移均不放行。显式选择须由 Pi 确认 idle/current model，且精确存在于实际目录，随后在原生分支写入私有 `farfold-native-first-use-v1` entry；该 entry 不进入 LLM context，也不出现在用户命令目录。
- 固定 Pi 在第一条 assistant 产生前不会把自定义 entry 刷到 JSONL。为保持“登录后、选模前重启仍是同一 native Session”，Adapter 的私有 session map 现在原子保存 profile-scoped 的 native Session/cwd/first-use 状态；冷恢复用官方 `--session-id` 重建同一 ID，不生成替代 Session。第一条任务产生原生文件后，启动前解析只沿 active branch 读取 marker 与模型，ready 恢复还要精确命中静态目录；其他分支、未知格式、缺文件但无 typed 引用均拒绝。
- Host 状态在待登录/待选模期间不发布当前 `modelSource`、managed Provider 或 `nativeAdmissionReady`。认证交互仍可使用，但 Composer 封闭。ready 后每轮沿既有 schema12 native-observation 绑定记录来源，并在 Adapter 写 prompt 前再次复核实际模型。共享回执仍不创建 managed 验证。
- PiWorkspace 的 Provider 新建弹窗增加“使用 Pi 原生账号”，沿同一个 `host_session_create` 建立首次使用 Session；随后复用现有原生认证、模型选择、发送、Stop 与恢复界面。无 locator 的 Pi ACP 仅能在后端确认 typed pre-file first-use 引用时恢复；旧 Pi 和普通 managed 缺 locator 路径不因此放宽。

新增/扩大验证：

| 层级         | 当前证据                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter      | lint、typecheck 通过；全套 **185/185**。新增覆盖私有 entry 生命周期、active-branch 隔离、pending/ready 恢复、prompt 封闭与 session-map 原子引用。第一次全套有 2 个测试失败：一个旧测试替身缺新增 store 方法，一个 restore 内部错误未保持 ACP `-32603` 包装；同步测试替身并恢复原错误合同后全绿，不掩盖产品失败。                                                                                                             |
| 前端         | `tsc -b` 通过；Vitest **58 文件、298 项通过**；生产构建通过。`native-auth-select` mock-IPC 浏览器冒烟通过，0 原生进程、0 模型请求；900/1440 无横向溢出，已查看 900px 工作台截图。它验证工作台接线，不替代新建时的真实 Host/账号行为。                                                                                                                                                                                        |
| Host/Rust    | `cargo test --locked` **460 通过、26 默认忽略**；fmt 与 clippy `-D warnings` 通过。新增 Host 测试证明待登录/待选模均拒绝任务，登录只改变 first-use 相位，显式选模后才接纳，并可在 native 文件尚不存在时按原 Farfold/native Session 冷恢复。                                                                                                                                                                                  |
| 固定 Pi 集成 | 默认忽略的 `fixed_pi_empty_profile_authentication_does_not_require_managed_bootstrap` 单独执行 **1 通过**（约 9.6s）：完全空 owned profile、合成 Anthropic native key、Stop、待选模冷恢复、选模前 prompt 拒绝；随后隔离写入只指向本机 fixture 的 native model，固定 Pi 真实执行一次 `/v1/chat/completions`，验证 bearer/model 与唯一请求；再 Stop 并按原 native Session/model 冷恢复且请求数不增加。没有外部 Provider 调用。 |
| 静态/构建    | Prettier 全仓通过；Adapter bundle 与 Vite production build 通过。首次 format check 只指出本片两个 TS 文件，机械格式化后复测通过。构建只有既有的大 chunk 警告，没有编译失败。                                                                                                                                                                                                                                                 |

证据边界：以上完成的是 source/测试/本机模拟层的 D 首次使用最小工程闭环，不是实际账号 OAuth、外部 Provider、安装应用或用户验收。没有迁移真实数据库、读取或改变日常凭据、替换 `/Applications/Farfold.app` 或 `/Applications/Farfold Dev.app`、清理用户数据，也没有删除旧 Pi 路径。下一步必须使用授权的实际账号和独立候选安装环境完成真实 OAuth、原生能力对照、Stop/恢复及安装出口，才能判断 D 是否结束；E 仍未启动。

### 2026-09-15 D Provider 语义校正与独立 QA 候选

用户指出 Pi 本身没有统一账号，并要求直接沿用先前提供的智谱 BigModel Provider，随后明确指定 GLM-4.6V。该校正成立：产品中的认证对象是模型 Provider，不是“Pi 账号”；API key 与 OAuth 只是各 Provider 公开的认证方法，已有可用凭据时不应重复要求登录。保留旧段落作为当时事实，本片修正当前 UI、产品合同与后续验收口径。

- 用户可见的“原生账号／登录 Pi”已改为“原生 Provider／配置 Pi Provider 凭据”；内部 `nativeFirstUse` 状态名不改，避免把展示修正误写成协议迁移。前端 typecheck、受影响的 2 文件 42 项测试和全仓 Prettier 通过。
- 智谱官方 GLM-4.6V 页面确认精确 Model ID `glm-4.6v`、OpenAI Chat Completions、视觉输入和原生多模态工具调用；官方参数页记录其默认/最大输出为 16K/32K。官方 Coding Plan 指南区分 Coding 端点与普通开放平台端点，错误端点可能无法使用对应套餐额度。当前已有 Pi 卡片显示 `Z.AI Coding CN / glm-4.6v`，因此候选预填 `zai-coding-cn`、Coding OpenAI-compatible 端点、128K context、32K max tokens、Reasoning 与 Image input；这是依据已有 Provider 身份与官方合同的配置选择，不是请求成功证据。来源：`https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.6v`、`https://docs.bigmodel.cn/cn/guide/start/concept-param`、`https://docs.bigmodel.cn/cn/coding-plan/quick-start`。
- 新增 `src-tauri/tauri.dpiqa.conf.json`，构建独立 `Farfold D QA.app`。候选 bundle id `ai.farfold.desktop.dpiqa`，二进制 SHA-256 `8760d4fcf212b878230c54d9a813062c48ceb68011fbae62043105b843e28270`，adhoc 深度签名验证通过；首次打开前数据域不存在。没有替换 `/Applications/Farfold.app`、`/Applications/Farfold Dev.app` 或 P6 QA。
- 对四个既有 Farfold Host 数据域只查询 Provider 非秘密元数据：正式版无 schema9 表，Dev 只有 OpenAI/测试记录，P6 QA 无智谱 managed 连接。没有打开 credential JSON、全局 Pi `auth.json` 或用户会话历史。候选 UI 能看到既有 Pi native `Z.AI Coding CN`，但新的 ACP owned profile 不自动导入全局凭据。
- 用户在聊天中再次提供了 key；执行过程没有把它复制到源码、补丁、命令、fixture 或工具调用。候选 secure field 当前为空，“保存并应用到 Pi”禁用；因此没有保存/应用凭据、没有 Provider 请求、没有费用。后续只在用户于候选中亲自粘贴并保存后继续。

当前停点不是实现故障，而是秘密输入边界。下一步依次核对：保存后 credential revision（不读 secret）→ 应用到 Pi owned profile → 实际 idle/model 与 typed managed version → 一次最小真实 GLM-4.6V 任务 → Stop/冷恢复/不重发 → 原生能力与工作区结果。任何 endpoint/套餐不匹配保留原失败，不自动改端点重试；D 出口前仍不启动 E。

### 2026-09-15 D 普通智谱真实请求首次失败与冷恢复

用户明确批准保留既有 `zai-coding-cn` Coding Plan 连接，另建普通智谱开放平台连接，并在同一 D QA 候选只发一次真实 `glm-4.6v` 最小请求；失败不得重试、换端点或换模型。凭据只通过 D QA secure field 输入，未进入源码、命令、日志、文档或回复。

- 新普通连接为 `zai`、官方普通开放平台 base URL、OpenAI Chat Completions、`glm-4.6v`、128K context、32K max tokens；原 Coding Plan 连接未覆盖或删除。Host 只读状态显示两个 Provider connection/两个版本，新增版本 endpoint/model fingerprint 与上述身份精确一致。
- 从“Pi 新对话”选择新增连接后，D QA 建立一条 `stable_v1` Pi ACP owned profile、一个 Farfold Session 和原生 Session；bootstrap connection/version 均存在。投影先达到 `saved / applied / not_requested`，Pi 原生 configOptions 确认私有 managed 模型，未借 native observation 伪造托管验证。
- 唯一请求内容要求只返回固定短串、不读取或修改文件、不调用工具。外部 Provider 返回 HTTP 400“角色信息不正确”；Farfold 显示“Pi 已确认本轮失败，原生会话保留”，投影变为 `saved / applied / verified_failure`，绑定的 config version 与 `glm-4.6v` 保持不变。该结果证明请求到达真实 Provider 并取得确定失败，不证明 credential、模型、套餐或协议可用；Farfold 未提供账单/usage 证据，不能断言是否收费。
- 失败已是终态，界面不再暴露活动 Turn 的 Stop 按钮，因此本轮不能声称活动任务 Stop 通过。正常退出 D QA 后，应用与 Pi ACP/Pi 子进程均结束；冷启动选择“继续对话”恢复原 Farfold Session、原 native Session、原模型与原失败历史。恢复后 Session 仍为 1、Turn Provider binding 仍为 1、`request_state` 仍为 `verified_failure`，没有第二条请求绑定；`turn_change_paths=0`，没有文件变化。
- 请求前清理只覆盖 21 个 2026-09-11 遗留、无人占用且可重建的 Pi 版本探针：7 个空目录与 14 个 stdout/stderr 小文件，共 28K，移入 `/Users/tw/.Trash/farfold-pi-version-probes-20260915`。它们可恢复；没有清理 `target`、当前截图/日志证据、D QA bundle/schema14 DB/profile/credential/session、源码、计划、恢复材料、正式/Dev/P6 QA 应用或数据。

当前边界：真实请求成功、活动任务 Stop、完整原生能力逐项对照及 D 同候选安装出口仍未完成。HTTP 400 根因未诊断，本轮不修代码、不修改兼容参数、不重试；后续先核对实际请求角色映射与固定 Pi/智谱公开合同，再由用户授权下一次真实请求。旧 Pi 5 秒启动超时仍是未归因历史观察，本次冷恢复成功不能证明它已修复。E/Codex/P6 QA 未启动，正式 0.1.7 与既有 Dev 未替换。

### 2026-09-16 D 普通智谱角色兼容修正与 D QA 启动阻断

用户授权修正普通智谱 OpenAI-compatible Chat Completions 的 system/developer 角色兼容问题，并在本地与 UI 门槛通过后最多再发一次真实 `glm-4.6v` 请求；不得切换端点、模型或 Pi，也不得提前进入 E/P6 QA。本片按该边界完成协议根因确认、不可变配置迁移和独立候选重建，没有发送外部模型请求。

- 固定 Pi 0.84.3 所带 `@earendil-works/pi-ai` 在 reasoning 模型且 `supportsDeveloperRole=true` 时将 system prompt 映射为 `developer`；设为 false 时映射为 `system`。新增严格本机 HTTP SDK 测试让模拟智谱服务拒绝非官方角色：旧配置只发一次 `[developer,user]` 并确定失败；修正配置只发一次 `[system,user]` 并成功；带 assistant/toolResult 历史时精确为 `[system,user,assistant,tool,user]`。这把 400 与角色映射连接在源码/SDK/协议层，不把真实 Provider 的单次失败外推为账号、套餐或模型结论。
- 前端 `managed-provider` 规范化与 Host `managed_provider` 保存边界只对精确普通智谱 base URL、OpenAI Chat Completions 固定 `supportsDeveloperRole=false`；其他端点和 Coding Plan 不变。既有不安全连接不会被静默覆盖，UI 提供“创建 System role 兼容版本”，Host 在原全局锁内读取既有 secret 并创建新不可变版本。旧版本、旧 secret、旧 Turn 绑定均保留；secret 不进入事件、数据库元数据、日志、命令、补丁或文档。
- 定向前端 Vitest **3 文件、13 项通过**，typecheck 通过；ordinary Zhipu Rust 测试 **2 项通过**，全部 managed Provider Rust 测试 **14 项通过**，fmt 通过；Adapter 全套 **185/185 通过**。默认忽略的固定 Pi 完整 Host → ACP → 本机 SSE → 冷恢复测试单独通过，唯一 outbound 请求角色精确为 `[system,user]`，恢复不重发。所有这些都是源码/隔离测试证据，没有外部调用。
- 重新构建 `Farfold D QA.app` 成功，bundle id `ai.farfold.desktop.dpiqa`、版本 0.1.7，执行文件 SHA-256 `4e1cd9afd8908e59aa92f3a546ff2259a87310400f74469d4d7423a6b7e1749f`，`codesign --verify --deep --strict` 通过。正式、Dev 与 P6 QA 应用未替换。
- 在新 D QA UI 中，对普通 `zai / glm-4.6v` 连接显式创建了 System-role 兼容版本；普通连接版本数由 1 增至 2，总 Provider version 数由 2 增至 3。旧历史 Turn 仍绑定旧版本，新 public pointer 指向新版本且只有 `supportsDeveloperRole` 从 true 变为 false，其余 endpoint/model/reasoning/image 配置保持。第一次点击应用时 Pi 尚未从该 Runtime connection 启动，UI 返回 `Pi started from a different Runtime connection`；没有模型请求，投影仍为 `saved / pending / not_requested`。
- 随后用“继续对话”恢复原 Farfold/native Session，连续三次均在 ACP 与模型进程启动前返回 `Pi Runtime version check timed out`。包内固定 Pi SHA-256 仍为 `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`；手工按相同 env-clear/HOME/PATH 运行同一 `--version` 约 0.224 秒成功并返回 0.84.3。当前只能确认 UI 启动路径的 5 秒版本检查超时，不能把它归因于二进制损坏、角色修正或历史那一次同类观察；不扩大 timeout、不加重试，也不声称旧问题已修复。
- 当前 D QA schema14 数据域仍为 2 个 connection、3 个 version、1 个 profile、1 个 Session、1 个 Turn Provider binding、0 个 turn change path。新兼容版本未应用到运行中的原 Session，`request_state` 未进入成功或失败验证；没有第二次真实 GLM 请求，因此没有新增收费或 usage 证据。

启动阻断随后按独立故障边界做只读/隔离诊断，没有再次点击真实 D QA 续接或调用外部 Provider：

- 失败调用链精确为 `host_session_open` 的 blocking worker → `pi_acp::start_host_session`（已取得 ACP start lock）→ `verify_managed_installation` → `binary_version`。版本检查先完成实际文件与 SHA-256 核对，再用 `--version`、env-clear、独立临时 HOME/cwd、固定 PATH、null stdin、piped stdout、null stderr 启动子进程；每 20ms `try_wait`，5 秒后 kill/reap 并返回当前错误。故障早于 `prepare_owned`、adapter asset 解析、ACP/模型进程与任何 secret 读取。
- 同一 bundle Pi 按相同 child argv/环境连续 **40/40** 成功且均低于 1 秒；24 个并发 `--version` 全部成功，12 个并发 SHA-256 + version 组合也全部成功。简单二进制损坏、固定环境或并发不足以单独解释 GUI 失败。
- 使用同一已签名 D QA `farfold` 父进程自带的 `--farfold-managed-update-smoke-v1`，只对临时数据库运行完整 managed Runtime 校验，**12/12** 成功，每次 0.898–0.932 秒。由相同 hardened/ad-hoc signed Farfold 父进程 spawn 本身不足以复现。
- 新增默认忽略且必须显式提供固定 Pi 路径的诊断测试，在 Tauri async runtime 的 blocking worker 内连续执行完整 digest/version 校验，**12/12** 成功。基础 Tauri/Tokio worker 或 SIGCHLD 环境不足以复现；该测试不接数据库、profile、credential、ACP 或 Provider。
- 既有历史证据中，2026-09-09 一次同类 timeout 出现在 Rust 编译期间，随后原安装冷恢复成功；2026-09-11 两次同类 timeout 后第三次成功，直接版本检查同样仅约 0.23–0.32 秒。当前三次则发生在新 D QA 长驻实例。现有证据只说明错误文本和代码阶段相同，不能证明是同一根因。

隔离 harness 未复现，失败现场又没有保留 child PID、进程 state、spawn/exit 阶段时间或当时 task policy/system-load 记录，因此当前不能在“瞬时调度/系统负载”“长驻 app lifecycle policy”与“未观测的实例内竞争”之间归因。单一可证伪假设收敛为：**只有长驻 GUI 实例的当时父进程状态或竞争条件使已成功 spawn 的 Pi version child 在 5 秒内未退出**；要证伪它，需要在下一次自然复现时记录不含路径内容与 secret 的固定阶段时间、child PID/state、并发检查计数和 kill 前状态。由于 Phase 1 根因未证实，本轮不改产品代码、不放宽 timeout、不加自动 retry，也不把通过的 harness 写成故障修复。

当前停点仍是独立的 Pi 启动/版本检查阻断。只有根因被证实、最小修复有先失败后通过的隔离测试、且同候选 UI 应用门槛重新变绿后，才可使用已授权的一次真实请求。D 不标完成，E/Codex/P6 QA 不启动，正式 0.1.7 与既有 Dev 保持不变。

### 2026-09-16 D 受控版本检查诊断、普通智谱成功请求与原会话冷恢复

后续授权明确要求：补足无秘密的现场诊断后执行一次受控 GUI 续接；若启动及新版本应用通过，可沿用已授权的唯一一次真实 GLM-4.6V 请求。该授权更新了上一节“必须先证实超时根因”的推进停点；超时本身仍须凭现场证据归因。本片实现诊断与有限验收，没有实施超时修复。

**诊断实现与检查**

- `performance_trace.rs` 沿用 `FARFOLD_PERF_TRACE=1` 和现有 stderr 日志，增加 D QA 的显式 opt-in 与 typed 固定阶段。记录相对单调时间、调用线程/main-thread 标志、固定 bundle resource 名和期望 SHA、实际 bundle/digest 一致性、spawn 开始/成功/PID、聚合 `try_wait` 次数、退出码、超时、kill/reap 结果、stdout 长度和 UTF8/长度解析结果。
- Pi ACP 启动边界记录 `resume=true`、尚未分配新 generation、start lock 已取得、来自 Host blocking worker 等语义，不输出 Session ID、工作目录、HOME、环境值、凭据、用户消息或子进程 stdout 内容。超时分支在 kill 前通过 libproc 读取 child PID/parent/process-group/status/flags，并通过 `FIONREAD` 读取管道积压字节数。5 秒期限和一次 spawn 行为保持；没有自动 retry。
- 新增一个定向 fixture 测试覆盖：成功、非零退出、无效 UTF8、超限输出、真实 5 秒 timeout 后 kill/reap、程序不存在；检查诊断内容不含合成秘密和临时路径。受影响 Runtime registry **13 通过、6 默认忽略**；补入积压字节观测后再跑 telemetry 测试通过（5.30 秒），clippy `-D warnings`、Rust fmt 和 diff check 通过。
- 独立 D QA release 构建、前端生产构建与严格深度签名验证通过。bundle id `ai.farfold.desktop.dpiqa`，版本 0.1.7，执行文件 SHA-256 `048004abdd83587a0de15a3418bb5dbec4075c294769421b5d4b7a6f0266c96b`；包内 Pi SHA 仍为固定的 `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`。正式/Dev/P6 QA 应用没有替换。

**同候选 GUI 与真实请求**

1. 使用显式打开 trace 的新 D QA 进程，一次点击“继续对话”成功。日志中原会话检查为 `check=4`、worker `ThreadId(17)`、`main=0`，digest 完成 37.744ms，spawn 成功 39.734ms（PID 71060），退出 370.227ms（15 次 `try_wait`、code 0、7 字节）；整个 `HostSessionOpen` 为 1294.4ms。另两次版本检查来自界面 capability 状态刷新，不是会话续接重试。
2. UI 显示原失败历史及原普通智谱 managed 模型；随后一次“应用到当前对话”将新版本 `provider-version-f46f1ec04db081417db13074b03d0d77781ca2e2f521aa00dc5d1acc298fbfa6` 应用到原 Session。请求前数据库精确核对 `saved / applied / not_requested`，当前版本与 projection 版本一致，模型为 `farfold-managed-d589aa578ac328117e907c81c1320ee3b27cbc0df1e17d23a0e375c3fae0e8fc/glm-4.6v`，Turn binding 仍为 1。新版本使用自己的 managed alias；旧 alias 和历史绑定保留。
3. 只点击一次发送，内容为“只回复 FARFOLD-D-SYSTEM-ROLE-OK，不读取或修改任何文件，不使用任何工具。”；实际 UI 返回该短串。数据库进入 `applied / verified_success`，`request_verified_version_id` 精确等于新版本，Turn binding 从 1 增至 2，`turn_change_paths=0`。原生 Session 只有两条 user 和两条 assistant：旧 assistant 为 error，新 assistant 为 stop；新 assistant 文本去除首尾空白后与短串相同，模型为 `glm-4.6v`，Provider 为新版本 alias，toolCall 总数为 0。这是该候选、该真实 Provider/model/config version 的成功证据，不外推所有模型、OAuth 或套餐计费。
4. 发送后曾看到活动 Stop 按钮；下一次状态核对时任务已完成并返回空闲，因此没有实际触发 Stop。为了守住本片一次真实请求范围，没有增加任务来测试取消。活动 Stop 保持待验收。
5. 正常退出后确认原 D QA 与子进程已结束。同候选以新进程重新打开并冷恢复：`HostSessionOpen` 1558.2ms；version PID 71472 从 spawn 42.185ms 到 exit 388.223ms，code 0、7 字节。UI 保留同一新版本模型、旧 400 和新成功回复；数据库仍为原 Farfold Session `session-03673b762a28108acde5814635bd2140943e180c05029b608aa3679945e4d070`、native Session `01a0a419-2ae7-756a-9a8c-a0f369b32642`、1 个 Session、2 条 Turn binding、0 变更路径、同一版本 `verified_success`。没有重新发送任务。结束时再次正常退出，D QA 子进程已全部终止。

现场日志为 `output/2026-09-16-pi-version-diagnostic/app.log` 和 `cold-restore.log`（共约 8KB，私有目录和文件权限）。本片没有出现 timeout，因此没有失败 child sample；可控首次恢复和成功请求后的冷恢复都完成，不能据此将旧三次 timeout 宣称修复。仍缺旧失败瞬间的 PID/状态/阶段，根因保持未知。受控请求与恢复小片完成，D 阶段尚需活动 Stop 和完整原生能力对照等出口；E/Codex/P6 QA 保持未启动。

### 2026-09-16 D 真实活动 Stop、能力矩阵与 compaction 边界停点

本片授权为 A 一次额外无工具长响应与 Stop、B 既有能力对照（缺口只用固定 Pi/localhost/synthetic）、A/B 达到门槛后才执行 C 同候选独立安装；发现新的材料缺口先回报。没有授权额外外部模型请求、替换正式/Dev/P6 QA 或修改 Pi 本体。

**A：真实活动 Stop 与冷恢复通过（限定候选、模型及请求）**

- 操作对象仍是构建目录中的签名 D QA `048004abdd83587a0de15a3418bb5dbec4075c294769421b5d4b7a6f0266c96b`，bundle id `ai.farfold.desktop.dpiqa`。沿用普通智谱 `glm-4.6v`、已验证版本 `provider-version-f46f1ec04db081417db13074b03d0d77781ca2e2f521aa00dc5d1acc298fbfa6`，没有换端点、模型或凭据。
- 仅发送一次 `FARFOLD-D-STOP-0916` 纯文本长序列任务，要求不调用工具、不读写文件。UI 确认 Pi 正在工作且 Stop 可用后只点击一次；随后显示“Pi 已确认停止本轮任务”和“已停止。”并回到可输入空闲状态。取消发生在 thinking 流阶段，尚无正文序列；不能称已完成长响应输出。
- 原生 JSONL 保留三条 user、三条 assistant，依次为 error、stop、aborted；最后一条只含部分 thinking，toolCall 总数 0。Host Turn Provider binding 从 2 变为 3，`turn_change_paths=0`。当前版本仍为 `saved/applied/verified_success`，是前一轮成功的保留结果，不把 aborted 改成新的成功证明。
- 正常退出后冷启动同候选并一次继续原会话：保留 Farfold Session `session-03673b762a28108acde5814635bd2140943e180c05029b608aa3679945e4d070`、native Session `01a0a419-2ae7-756a-9a8c-a0f369b32642`、新版本 alias `farfold-managed-d589aa578ac328117e907c81c1320ee3b27cbc0df1e17d23a0e375c3fae0e8fc/glm-4.6v` 与三轮历史。UI 冷恢复后仍显示已停止，binding 仍 3、变更路径仍 0、schema14，无重发。末尾正常退出并确认 D QA/子进程已结束。
- 两次 `HostSessionOpen` 分别 1541.5ms、1266.5ms；会话入口 `check=4` 的 version child 分别约 410ms、323ms、code 0。本片没有 timeout；历史三次超时仍未归因，不延长 5 秒期限、不加 retry。私有日志：`stop-attempt.log`、`stop-cold-restore.log`，位于既有 `output/2026-09-16-pi-version-diagnostic/`。

**B：必需能力对照（pass 指所列证据层，不是整阶段通过）**

基线为固定 Pi 0.84.3 随包 `docs/rpc.md`、现有规格第 3/6 节及阶段 D、维护 Adapter 与本记录历次定向证据。历史未修改上游发布包的缺口不等同维护版当前结果；TUI custom/footer、未承诺图片/音频、LifeModel 或第四 Runtime 不扩大进本片。

| 能力                                              | 状态与证据层                                               | 本次核对、复用与剩余范围                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 固定启动、版本、安装身份                          | partial：签名 QA GUI + 固定二进制                          | A 两次启动通过；旧 timeout unknown；尚未从 /Applications D QA 安装路径验证                                                            |
| 稳定 profile、凭据与版本隔离                      | pass：Host/Adapter 合同 + 固定 Pi synthetic + QA 真实配置  | 复用 schema13/14、授权版本/秘密冲突/私有目录/认证不落事件检查；真实 key 未 logout、未重写                                             |
| 模型目录、显式选择、actual idle、thinking         | partial：固定 Pi + typed/前端合同                          | 复用多版本应用、native first-use、配置 unknown、模型复核及 off 配置往返；UI 同一真实模型确认；不能外推所有高思考等级实机选择          |
| Session/原分支与空分支保护                        | pass：固定 Pi + QA GUI                                     | 复用原分支模型保护/空历史拒绝恢复；A 取消历史仍属原双重 Session 身份                                                                  |
| prompt 与流式终态                                 | pass：固定 Pi localhost + 真实 QA                          | 前片真实短回复 stop、本片思考流 aborted；不声称真实文件任务已验收                                                                     |
| 原生工具、文件成果、diff                          | partial：新增固定 Pi RPC/ACP localhost                     | 两路各实际 write 一次；磁盘内容相同、tool_execution_end 成功、ACP diff 存在；尚无本候选真实 Provider 文件任务与安装 UI diff 验收      |
| 活动 steer 与 follow_up                           | partial：新增固定 Pi RPC/ACP localhost + 既有 Host/UI mock | 原生请求顺序 BASE-WORK → STEER-WORK → FOLLOWUP-WORK；只有最初一个普通 prompt，ACP 等最终 agent_settled；安装 UI 活动干预仍未实测      |
| Extension select/confirm/input/editor、通知与撤销 | partial：固定 Pi/shared transport + mock-IPC UI            | 复用四种表单、false/空值/取消区别、原生 timeout 与晚回复拒绝、五类通知；尚无本候选安装 UI 原生表单操作                                |
| auth reply/cancel/logout                          | partial：fixed SDK/Pi synthetic + UI mock                  | 复用临时认证、commit/unknown、logout/same-process refresh；普通真实 API key 已验证，不外推 OAuth 账号                                 |
| Stop/abort、终态与 unknown                        | pass：真实 QA A + 既有并发故障合同                         | 原生 aborted、Host/UI 空闲；既有坏 ACK/断线保留 Unknown，无自动重发                                                                   |
| 配置变更中/未知与任务绑定                         | pass：Host/Adapter + fixed Pi + QA 应用                    | 复用精确 version/model 绑定与配置占用，旧成功不冒充当前配置；A 保持同一来源                                                           |
| 历史、冷恢复、不重发                              | pass：固定 Pi + 真实 QA 原身份                             | 前片成功与本片取消冷恢复已实际完成；本片无额外请求，不外推安装路径/所有冷启动场景                                                     |
| 命令/统计/只读工作台                              | partial：固定 Pi + Adapter 合同                            | 复用七类 workspace、native Extension command、stats/name/队列模式；未声明整个 RPC 命令集合已安装验收                                  |
| 手动 compaction 的模型/任务边界                   | **fail：新的确定性 Adapter 合成回归**                      | `/compact` 在普通 prompt 的 actual-model preflight 之前直接执行 `proc.compact()`；见下述复现。其停止/回执完整性仍须补查，不能推断通过 |

新增 `scripts/pi-acp-native-workflow.test.mjs` 使用固定 Pi SHA、清空继承环境、隔离 HOME/profile/项目和本机 HTTP 服务。服务分别向原生 RPC 与维护 ACP 返回同一序列：write tool call、steer 完成、follow-up 完成；每路严格 3 个 localhost 请求。验证真实磁盘 `LOCAL-TOOL-OK`、原生工具终态、三次用户消息入模顺序、ACP diff 和 agent_settled 后才完成 prompt。首跑断言误以为 OpenAI user content 为字符串，实际是 text parts；只修正夹具归一化后两路通过，格式化后再次通过，无生产源码修改。日志 `native-workflow.log`；夹具目录位于 `src-tauri/target/d-stage-pi-candidate-0912/native-workflow-*`，均为合成数据。

**新的确定失败及停点**

1. 固定随包 `rpc.md` 的 compact 合同明确含 LLM usage，手动压缩不是可无条件跳过模型边界的纯读取操作。
2. `src-tauri/pi-acp-adapter/src/acp/agent.ts` 解析 expectedModel 后，`/compact` 分支直接执行 `session.proc.compact(customInstructions)`；普通 prompt 的活动检查、provider receipt 监听及 `session.prompt(..., expectedModel)` 在其后。`process.ts::compact` 直接发送 RPC，没有 expected-model 参数或 actual-state 复核。
3. 新 `test/unit/compact-model-boundary.test.ts` 设置合成当前模型 actual-provider/actual-model，输入 expected-provider/expected-model 与精确 session/file，期望拒绝且不调用 compact。两次明确失败：`result=accepted, compactions=1, confirmed=false`。这是 Adapter 合成复现，不是外部模型错误调用，也不是观测到日常数据泄露。该测试刻意保持红色，因此当前 Adapter 全量 suite 不应再引用旧 185/185 当作当前全绿。
4. 遵照新材料缺口先回报的本片约束，没有实施生产修正、没有关闭/隐藏 compact 来宣称能力保留，也没有继续安装。下一片需在既有共享 Host/ACP/Adapter 内让 model-using compaction 复用正确的模型与生命周期边界，并用红色回归及固定 Pi localhost 补足模型拒绝、正常压缩、活动 Stop/unknown 和来源证据；不得新增 Agent loop 或 Host RPC fallback。

**C：未执行。** `/Applications/Farfold D QA.app` 仍不存在；候选包、schema14、真实 profile/credential/三轮历史保留。正式 Farfold、Dev、历史 P6 QA 未替换；E 未启动。新故障已经回报协调任务，D mandatory 矩阵不满足出口，不建议 D complete。没有因已知红色回归运行无意义的全量发布检查或重新构建同候选；本片检查为新增 localhost 对照、明确失败回归、文档格式和 diff 核对。

### 2026-09-16 固定 Pi 手动压缩取消限制

用户随后授权在既有 Adapter/共享 Host 内继续修复 compaction 模型复核、活动互斥、Stop、终态及来源边界；不改 Pi 本体、不用旧路径、不发外部模型请求。按系统化调试流程，先沿普通 prompt 的 preflight/settlement 实现及固定 Pi 原生 compact/abort 对照，尚未开始生产修改便发现新的 mandatory 原生接口限制。

**固定源码事实**

- 固定 `@earendil-works/pi-coding-agent@0.84.3` 的 `dist/modes/rpc/rpc-mode.js`：`case "abort"` 仅调用 `session.abort()`；`case "compact"` 等待 `session.compact(customInstructions)` 后返回结果；没有 `abort_compaction` RPC 命令。
- 固定 `dist/core/agent-session.js`：`abort()` 只执行 `abortRetry()`、`agent.abort()` 和 `waitForIdle()`；`isIdle` 只取决于 `_isAgentRunActive`。手动 `compact()` 另建 `_compactionAbortController`，`abortCompaction()` 才取消它；`dispose()` 会调用此方法，但销毁 Runtime 不能当作任务取消成功。
- 原生 compaction 返回 summary/usage，可由 Extension 自定义，不包含普通 assistant `message_end` 的完整 Provider/model/stopReason 回执，不能合成普通 Provider verified_success。模型复核修复和 typed 来源处理仍需保留这个证据差异。

**一次固定二进制 localhost 实测**

新增 `scripts/pi-native-compact-abort-probe.mjs`，校验固定 Pi SHA `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`；用官方固定 SDK 的 SessionManager 创建合成原生 JSONL（SDK 只创建测试历史，不执行 Agent），清空继承环境并隔离 HOME/profile/项目，凭据仅为 synthetic-local-only。唯一模型端点是本机随机端口；本次只有 **1 个 localhost compaction 请求，0 个外部请求**。

1. 原生 RPC `get_state` 确认初始 `isCompacting=false`，发送一次 `compact`。
2. 本机服务保留该模型响应，原生状态已为 `isCompacting=true`。随后发送一次原生 `abort`，收到 `success=true`。
3. 在模型响应仍被保留时再次 `get_state`，`isCompacting` 仍为 true；compact 请求尚无终态响应，也没有 `compaction_end`。因此该 ACK 没有取消压缩。
4. 释放同一个本机响应后，compact RPC 正常 `success=true`，`compaction_end.aborted=false`，回到 `isCompacting=false` 且原 Session 不变。输出明确为 `limitationConfirmed=true`，并非 Stop 能力 pass。
5. 实验后的进程组终止仅用于回收已完成的隔离探针，不计取消证据。合成资产位于 `src-tauri/target/d-stage-pi-candidate-0912/compact-abort-L6G5h7/`；不包含真实凭据/用户历史。没有再次运行 compact 来掩盖结果。

**结论与停点**：模型 preflight 的原 Adapter 缺口仍在，红色回归没有被绕过；新增确认固定 Pi 通过现有 RPC 不能取消活动手动 compaction。按本片“新 mandatory 阻断主动回报”的约束，已向协调任务报告并暂停生产修改/安装。需要先决定如何处理该原生接口限制（维持固定版本时必须如实保留受限状态，或另行决定受支持接口/固定版本方案），不能通过扩写第二循环、Host fallback、修改 Pi、伪造 cancelled 或强杀来宣布通过。当前不宣布 D 完成，C 安装未执行，E 未启动；旧版本检查超时仍独立为根因未知。

### 2026-09-16 D compact 边界修复、原生停止限制投影与独立安装恢复

**后续授权与范围**：用户接受固定 Pi 0.84.3 的手动压缩 Stop 不支持语义，授权在同一 Adapter/Host/ACP 内完成模型/活动/终态边界和相关检查，工程闭合后构建、签名、独立安装 D QA 并保留既有数据。本节覆盖上两节的当时停点，不改写原生限制或首次失败。没有改 Pi 本体、版本、第二 Agent loop 或 Host fallback；本片 **0 个外部模型请求**。系统化调试先固定失败合同，再修实现和回归；没有用重试隐藏限制。

**生产边界**

- `PiRpcProcess` 的 prompt/compact 共用派发前原生 Session/file/model/idle 精确复核，以及认证、配置 changing/unknown 与写入互斥；pending compact 期间也拒绝底层配置 mutation。写入前失败为 NotSent，写入后失联仍 unknown，15 秒 preflight 窗口不变。
- `PiAcpSession.compact` 同步占用原有活动槽，拒绝第二任务、配置修改和插话；以原生 manual `compaction_end`、对应 RPC result、结束后同一身份且 idle 的状态共同结算。缺失/漂移/不一致断开并保持 unknown，不把命令 ACK 当终态。固定原生 compact 可经 Extension 执行，缺普通 assistant Provider 回执，因此不制造 `verified_success`。
- 手动压缩准备至终态期间，界面 Stop 禁用并说明固定版本限制；同一 ACP 适配器的 `_pi/cancel` 对竞态请求精确返回 `unsupported`，不调用 native abort、不挂取消标记。共享 Host 在收到有效 unsupported 后清除本次 abort 请求，保留活动任务自然完成；畸形/超时回执保持 unknown。
- 普通任务取消仍走原有 native abort 和终态路径；accepted 只代表控制接纳。取消表单由原生精确 withdrawal 驱动，Host 不在判断 Stop 能力之前提前销毁表单。普通 Stop、等待表单取消、下一轮与 stale-turn 隔离有回归检查。

**分层验证**

| 层级               | 结果与边界                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter 合同       | 新增真实 Agent/Session/Process + 合成 JSONL transport 回归，覆盖模型/会话/file/streaming/compacting/队列/缺 idle 字段、认证/refreshing/failed、双任务/配置/steer 互斥、unsupported Stop、自然完成、恢复普通 Stop、原生 error/aborted/缺 event unknown；完整 189/189 通过，typecheck 通过                  |
| 前端               | manual/auto compaction 状态区分、结束清除、Stop disabled/解释与普通 Stop 恢复；完整 60 文件 304 项通过，类型及生产构建通过                                                                                                                                                                                |
| Rust Host          | Pi 模块 39 通过/8 ignored；固定 Pi 共享表单 withdrawal 定向 ignored 检查另行运行 1 项通过、零模型；仓库完整 464 通过/27 ignored，clippy `-D warnings`、fmt 通过；既有 Codex 测试仅仓库回归，不是开展 E                                                                                                    |
| 固定 Pi + 维护 ACP | `scripts/pi-native-compact-abort-probe.mjs --acp` 一次 localhost compact：活动时 `_pi/cancel` unsupported，继续 compacting；释放同一个模型响应后 native `aborted=false`、ACP end_turn 且无 Provider receipt；完成后普通取消控制恢复 accepted；关闭并恢复原生 Session/file/model，历史字节一致，请求数仍 1 |
| 独立安装           | 下述最终候选普通恢复及再次冷恢复原 Session/模型/历史通过，未发送任务；安装 GUI 中实际活动 compact 的按钮状态未用外部模型触发，因此该行为证据仍是前端合同 + 固定 Pi/ACP，不冒称完整安装压缩验收                                                                                                            |

固定 ACP 探针资产：`src-tauri/target/d-stage-pi-candidate-0912/compact-abort-x4oLfa/`，原生合成 Session `01a0a637-28ab-7f5f-825e-8112419d303c`；输出 `stopUnsupportedConfirmed=true`、`coldRestoreWithoutResend=true`、`localRequests=1`。探针兼容输出中的 `nativeAbortAck=true` 在 ACP 模式仅指控制响应返回，不是原生取消成功。第一次 ACP 启动使用系统 Node 被 parser identity guard 拒绝且未发模型请求，后改用固定 capability-bridge Node，未放宽生产守卫。最后补入的底层 mutation 排斥已通过完整 Adapter 回归，未重复固定成功 compact 来累积请求。

检查中的非生产失败也保留：新 Composer 测试起初漏填必需 `steeringHint` 导致类型构建失败，补齐 fixture 后通过；独立脚本 `scripts/pi-acp-native-workflow.test.mjs` 被 Vitest 当作零测试套件，因此重命名为 `scripts/pi-acp-native-workflow-probe.mjs`（上节旧路径为当时事实），随后前端全套通过。没有保留已知红色回归。最终构建前修改了 Adapter 的 mutation 守卫，因此较早构建未安装；仅最终候选被安装。

**独立候选与保护**

- 安装位置 `/Applications/Farfold D QA.app`，bundle id `ai.farfold.desktop.dpiqa`，版本 0.1.7；安装前目标不存在，没有覆盖正式/Dev 应用。源包位于 `src-tauri/target/release/bundle/macos/Farfold D QA.app`。
- 最终执行文件 SHA-256：`d8a3425dcea2b4447b33491d449bbc4ab760ebe4820f593580fd248d6d915f3a`；Adapter 源/包摘要一致：`fc5a26542e84f217b56f8d37c2bae693c00538800f4a391f6bba8334f15fb530`；固定 Pi 摘要仍 `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`。源与安装包 strict/deep 签名验证通过；仍是内部签名，不宣称公证/公开分发。
- 安装前只读 SQLite backup：`output/2026-09-16-pi-version-diagnostic/pre-install.sqlite3`，保留既有独立 D QA 数据域。恢复后 `user_version=14`、`quick_check=ok`、Session 1、Turn Provider bindings 3、变更路径 0；没有新增会话或请求绑定。
- 原 Farfold Session `session-03673b762a28108acde5814635bd2140943e180c05029b608aa3679945e4d070`、native Session `01a0a419-2ae7-756a-9a8c-a0f369b32642`、profile `profile-ef1b8953e2ed394740c2fbca7fb8ca9a76bf90d4e6a1779cf057712ad31e97ed` 保留。明确普通智谱 GLM-4.6V 的新版本绑定保持原值；`saved/applied/verified_success` 来自先前获准真实请求，不是本片或 compact 产生的新验证。
- 两次安装恢复均显示原普通智谱模型、旧角色 400、真实成功回复及已停止历史，输入恢复可用；managed secret、agent auth/models/models-store 和原生 JSONL 共 9 文件按路径逐一摘要比较全部不变。第二次比较一度因文件枚举顺序不同得到数组不等，按路径核对确认零内容变化；未打印密钥或文件正文。正常退出后进程已结束，无 D QA 子进程残留，无重发。
- 正式应用 SHA 仍 `c7750c4406075330d83e9c8ad3f7ee3d844113186de034d9160363d08cdd7820`；Dev 仍 `85e50b52472385ef00fee6b71acccbb77ed301030bc46457be82dfd66e2a161f`。未操作历史 P6 QA、正式/Dev 数据或全局 Runtime。

**版本检查观察**：`output/2026-09-16-pi-version-diagnostic/installed-restore.log` 的 check 4 子进程从 spawned 40.099ms 到 exited 367.553ms，HostSessionOpen 1308.5ms；再次冷恢复日志 `installed-cold-restore.log` 为 spawned 42.180ms 到 exited 378.900ms，HostSessionOpen 1316.9ms。均匹配固定 digest/version 并成功。本次没有复现超时；不延长 5 秒阈值、不增加重试，历史失败根因仍未知。

**当前结论**：本片 compact 工程缺口与获准的独立安装/冷恢复完成，原 Stop 门槛按批准的固定版本限制如实收口；这不是完整 D 阶段出口。此前真实普通智谱成功与活动 Stop 属于前候选 `048004ab` 的明确证据，本候选零外部调用。真实 Provider 安装文件任务、完整活动交互/扩展工作台及剩余 mandatory 项仍按原矩阵分层验收；不把本机对照、静态 UI 合同或冷恢复外推为全项产品可用。不删除旧 Pi、不进入 E，不替换正式版。

### 2026-09-16 D 最后安装工作流验收与剩余缺口

**授权与当前候选**：协调传达用户休息期间持续推进授权，仅使用已安装、签名的 `/Applications/Farfold D QA.app`，固定 Pi 0.84.3/维护 Adapter、普通智谱 GLM-4.6V/既有 config version，不换端点、凭据或模型。外部模型上限 4 次，失败不自动重试；不重复真实 compact，不修改当前生产实现、正式/Dev/P6 QA 或其数据，不删旧 Pi、不进入 E。QA 执行文件始终为 `d8a3425dcea2b4447b33491d449bbc4ab760ebe4820f593580fd248d6d915f3a`，最终 strict/deep 签名通过；正式与 Dev 仍为上节摘要。

**先澄清文件归属约束**：原 Session 不可变地绑定 `/Users/tw/Desktop/farfold` 根检出。共享 `turn_changes.rs::begin_capture` 仅对 managed-ready 且干净基线捕获逐 Turn paths；根检出直接为 `project_level_only / working_copy_not_managed`，不能靠在 `src-tauri/target` 新建子 Git 仓库改变原 binding。回报后协调明确批准同一 D QA/Provider 新增隔离 managed-worktree Session；原 Session 只做普通 Stop/恢复，分别记录两类证据。

**隔离资产与准备 Session**

- 本轮创建种子仓库 `/Users/tw/Desktop/farfold/src-tauri/target/d-installed-workflow-0916-djl3RF`，只含限制写入范围的 `AGENTS.md` 与从既有固定 `probe-mWlCzK` 复制的 `.pi/extensions/d-qa-probe.ts`。种子提交 `4d178ddb72040855cd3851d5d0e25f398c795fad`，创建前目录为本轮 mktemp 空目录，提交后 clean；未修改 Farfold 仓库的 Git 身份/分支或历史。
- 安装 UI 的既有流程需先有根 Session，才能从详情创建 managed worktree。因此先建立零模型的种子根 Session，再经“创建隔离 Worktree”预检：源 clean/精确 HEAD、新目标不存在，创建 `codex/d-installed-qa-0916` 分支及目录 `/Users/tw/Library/Application Support/ai.farfold.desktop.dpiqa/managed-worktrees/project-a565cec089c9500aa2fe32122be0b0d939e81b0bbb7aa8ed0fedbcb605acaca9/codex-d-installed-qa-0916-486ea06eb6f1`。这是独立 D QA 自有数据域，不是正式/Dev worktree。
- 首个空 managed Session 以 saved trust 启动，没有载入项目 Extension；切换“载入受保护项目资源”时，原生 JSONL 尚未产生，现有同 Session 重启失败。现场保留并回报；未修绑定或伪造历史。按 UI 的“新建 Session”出口，使用当前明确 approve 策略建立最终文件验收 Session，载入 2 项原生项目命令。新建不是原空会话恢复成功。
- 两个零调用准备 Session 保留为必要失败/创建流程证据，未清理，也未在其中发模型请求。旧凭据未 logout 或覆盖；新 profile 只由现有 Host 复用同一已保存 Provider 版本生成。

| 用途                 | Farfold Session                                                            | Native Session                         | 本片模型调用 / 最终 Host binding / paths |
| -------------------- | -------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| 原历史与 Stop        | `session-03673b762a28108acde5814635bd2140943e180c05029b608aa3679945e4d070` | `01a0a419-2ae7-756a-9a8c-a0f369b32642` | 1 / 4（含历史3）/ 0                      |
| 种子根准备           | `session-2ad2708a81d06dc40586a1a7f85345a90a7f6dcfba0864cefdffb6836a9040f1` | `01a0a64a-3de1-799f-8a4a-b8ad82b98e7f` | 0 / 0 / 0                                |
| 空 managed 失败现场  | `session-4a3730f005cf620f67ebe39e8d60c87bbfb9c266945081cbd2f8208b5840c4fe` | `01a0a64b-663e-732c-9426-5011d539f61d` | 0 / 0 / 0                                |
| 文件与原生 Extension | `session-1dea05af5a5f717922d5b7c910282b3034a53000af058b266f2580951bfd4418` | `01a0a64c-5721-7422-b533-4d47097c48b5` | 3 / 5（含3个零模型命令）/ 1              |

**真实调用预算和终态**

1. 原 Session 发送一次纯文本 `FARFOLD-D-INSTALLED-STOP-0916`，禁止工具/文件。观察到正文编号 0001–0004 已流式显示后只点击一次 Stop；最终保留至部分 0027、UI“Pi 已确认停止本轮任务”、原生 assistant `stopReason=aborted`。无 toolCall，原 Session binding 增至 4、paths 仍 0，恢复输入可用。
2. managed Session 发送唯一文件任务 BASE-WORK，限制恰好一次 native write，只创建 `d-installed-evidence.txt`，不用 read/bash/edit。第一次模型响应含说明与唯一 `write` toolCall，原生工具结果为成功写入 27 字节；第二次模型响应正常 stop，回复 BASE-WORK。
3. 为核对活动 steer，看到 BASE 的活动正文后填写并提交 STEER-WORK；但任务在这段 UI 操作间已完成。发送时共享 Host 重读 active turn 已为空，故该消息成为新普通 prompt，产生第三个 managed 模型响应，正常 stop 并回复 STEER-WORK。原生顺序明确为 BASE user → toolUse(write) → toolResult → assistant stop(BASE) → STEER user → assistant stop(STEER)，没有活动插话回执。**不算 active steer，通过普通下一轮只能证明终态后可继续。**
4. 至此本片合计 **4 次原生模型调用**（原 Stop 1 + 文件循环 2 + 独立 STEER 1），已达上限；没有发送 follow_up，没有重试、换配置、补 newline 或再做 compact。计数来自明确原生 assistant/model 回合及 UI/Host 轨迹，不把 Host binding 数当 HTTP 调用数，也不是 Provider 账单审计。

文件实际内容为 `FARFOLD-D-INSTALLED-FILE-OK`，27 字节；模型未遵从测试提示要求的尾换行。保留这个输出偏差，不追加请求或自行改写证据文件。真实工具执行、唯一文件范围与产品审阅路径通过，不宣称模型逐字任务全满足。

**安装文件工作台与来源**

- 消息流展开 Pi 执行步骤显示 `write` / “修改文件” / “Successfully wrote 27 bytes to d-installed-evidence.txt”。本地 Git 只有 `?? d-installed-evidence.txt`；种子仓库仍 clean，其他 QA fixture/config 没有 Agent 修改。
- 文件 Turn `turn-6bd72389e4089db0c20b83ddb479e6dd`：Host `available / native_prompt_completed`，基线及终止 HEAD 同为 `4d178ddb`，paths 恰好 1，类型 untracked。详情明确为基线与终止快照观察，不夸大为 Agent 因果归属。
- 安装 UI 点击“查看差异”实际显示 `/dev/null → d-installed-evidence.txt` 与唯一新增内容；点击“预览”显示当前磁盘 27 字节和相同文本；点击“在访达中显示”后，Finder 实际选中同一完整 QA 路径文件。不能仅凭按钮 ACK 宣称定位。
- 后续普通 STEER Turn `turn-1fe438f6e566716c379d21fce0aa3ee8` 开始前已有未跟踪文件，因此正确为 `project_level_only / working_copy_not_clean_at_turn_start / paths0`，UI也明确此事实，没有把旧文件重复归入新 Turn。
- 所有本片 Turn 绑定均沿同一 `provider-version-f46f1ec04db081417db13074b03d0d77781ca2e2f521aa00dc5d1acc298fbfa6` 与普通智谱 managed alias。文件 Session 的精确版本投影达到 `saved / applied / verified_success`；两个零调用准备 profile 仍 `not_requested`，不是凭静态配置制造成功。

**零模型 Extension 与只读命令**

- `/farfold-d-probe` 经安装 UI 和现有 Host/ACP/native Extension 实际逐步操作：select=Two、confirm=false、input=`D-INSTALLED-INPUT`、editor=`D-INSTALLED-EDITOR`。通知回流完整且与四项输入相符；`D status`、`D widget`、document title、`D draft` 均可见。未触真实 credential，表单已关闭。
- `/farfold-d-timeout` 原生 100ms 超时返回 `D-TIMEOUT-RESULT:null`，没有遗留表单或 active turn；这是超时撤销/通知证据，不外推所有时间窗口或取消情形。
- `/session` 只读命令已被提交并完成为零模型 Host Turn，但安装 UI 没有出现统计文本。源码定位：Adapter `agent.ts` 的 session 分支读取 stats，只发送标准 `session/update` 的 `agent_message_chunk`；`PiWorkspace` 订阅只解析 `piAcpNativeEvent`，其仅接受 `_pi/event`，其余直接 return；随后原生 history snapshot 也没有该 Adapter-only 命令文本。这是实际显示缺口，不把一次命令成功当完整只读工作台可用。
- 三个零模型命令共形成 3 个 Host bindings / 3 个 clean zero-path reviews，故全数据库最终 9 个 bindings = 原 Session4 + managed5；不是本片9个模型请求。

**冷恢复、保护及版本检查**

正常退出后确认安装 app/子进程消失，再从完全相同安装路径冷启动。先恢复文件 Session：同模型、native `01a0a64c...`、BASE/唯一 write/toolResult/BASE stop/独立 STEER stop 完整恢复，展开工具步骤仍显示 27 字节成功；再从侧栏恢复原 Session：同 native `01a0a419...`、旧角色400/先前成功/两次 aborted 历史完整。两次均没有发送消息；最终正常退出，`pgrep` 无 D QA 残留。

- `schema14`、`quick_check=ok`、Sessions4、bindings9、唯一 `turn_change_paths` 为该证据文件。两个零调用准备 Session 独立保留，没有冒充可冷恢复的已写原生历史。
- 本片前原有 10 个保护文件中，9 个配置/凭据文件完全不变；原 JSONL 仅追加预期 Stop 历史 2358 字节，原前缀 SHA 不变。包括新增 profile 的全部 23 个配置/原生历史文件，在最终双 Session 冷恢复前后按路径 SHA 逐一相同，证明未重发或改写历史。秘密内容未打印或写入报告。
- 启动日志 `output/2026-09-16-pi-version-diagnostic/installed-workflow.log`：原 Session 开始 `HostSessionOpen 1467.0ms ok=1`；空 managed trust 重启失败 `511.5ms ok=0`，不是版本 timeout。
- 冷恢复日志 `installed-workflow-cold.log`：文件 Session `HostSessionOpen 1311.5ms`，版本 check4 spawned43.086ms→exited366.794ms；原 Session `1367.7ms`，check8 spawned40.357ms→exited434.399ms，均 code0/固定摘要匹配。旧 5 秒 timeout 未复现、根因仍未知，没有延长阈值或重试。

**更新后的 14 项矩阵（证据等级不可互换）**

| 必需能力                               | 本片后状态                           | 当前证据和未闭合边界                                                                           |
| -------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 固定启动/版本/安装身份                 | 本候选安装通过                       | 固定签名/摘要、安装路径与两有历史 Session 恢复；旧 timeout unknown 保留                        |
| 稳定 profile/凭据/版本隔离             | 所测范围通过                         | 原配置未变，新 profile 仅沿既有精确版本；两个零调用准备投影不造验证                            |
| 模型目录/明确选择/actual idle/thinking | 分层有限通过                         | 复用固定 Pi/合同与本候选真实同模型；不外推所有 reasoning level/Provider                        |
| Session/原分支/空分支保护              | **新安装失败**                       | 有历史原身份通过；空 managed Session 切 trust 时同身份恢复失败，安全拒绝不等于完整首次使用流程 |
| prompt/流式/终态                       | 本候选真实通过                       | 纯文本 streaming→aborted；文件 toolUse→stop；后续普通文本 stop                                 |
| 原生工具/文件/diff                     | 本候选安装链路通过，模型输出偏差保留 | 唯一write、disk27字节、Host单路径、UI diff/preview/Finder；缺尾换行非精确任务全满足            |
| 活动 steer/follow_up                   | **安装仍 partial**                   | 之前固定 Pi localhost 对照保留；本片拟steer晚到变普通prompt，follow_up未发，预算耗尽           |
| Extension四表单/通知/withdrawal        | 本候选安装所测路径通过               | 四种实际输入、false、状态/widget/title/draft/notify及原生timeout；其他故障复用固定合同         |
| auth reply/cancel/logout               | 保留此前分层范围                     | API key真实请求通过；synthetic SDK/固定Pi/UI合同不外推真实OAuth，本片按授权不logout            |
| Stop/abort/unknown                     | 本候选普通Stop通过                   | 正文streaming后单击、native aborted、原历史冷恢复；故障unknown复用合同                         |
| changing/unknown/任务绑定              | 所测范围通过                         | 精确版本回执、不混Task/无模型命令；空会话打开失败不伪装verified                                |
| 历史/冷恢复/不重发                     | 两有历史 Session 安装通过            | 原与managed原生身份/工具/Stop历史保持；不覆盖空managed恢复失败                                 |
| 命令/统计/只读工作台                   | **安装显示失败**                     | Extension command通过，但`/session` ACP-only输出未被PiWorkspace呈现                            |
| 手动 compact 边界                      | 按已批准限制收口                     | 复用前片 fixed Pi+ACP+UI合同，Stop unsupported；本片不再真实压缩                               |

**定向检查与当前停点**：现有前端 Pi ACP/conversation/Composer 3 文件 30 项、Rust turn_changes 10 项通过；这不修复新增安装缺口。没有生产代码变更，复用上片已安装候选的集中构建/全套结果，不重新打包。UI 自动化第一次中文 typeText 丢字符发生在发送前，核对后改用 paste 再发送；目录 GoTo clipboard timeout 经当前焦点核对后用 ASCII typing 完成，均不是模型重试或产品修复。

D **仍未完成**。阶段出口剩余的是空 managed Session trust/recovery、Adapter-only 命令呈现这两个已定位安装缺口，以及 active steer/follow_up 的安装验收空缺；它们不属于获准的固定 Pi manual compact 受限项。已主动回报协调，没有为了“只剩一个阻断”隐去其他缺口。后续按既有 Host/ACP/profile/工作台边界修复并定向验证，再另行安排需要的新模型调用；本片预算已耗尽，不自行追加。保留必要 QA 文件/准备 Session，不删除旧 Pi、不进入 E，不替换正式/Dev。

### 2026-09-16 D 最小修复片：空受管恢复与控制输出安装通过，活动队列仍 partial

**授权与结论**：后续批准限定在原 Host/ACP/维护 Adapter 内修复两个已定位缺口；零模型安装复测后，只做一次新四请求上限内的受控 HOLD→steer→follow_up 验收，失败/未确认不重试。A/B 工程与安装层均通过；唯一 HOLD 尝试没有形成工具活动窗口，因此活动队列仍未验收。D 不完成，不删除旧 Pi、不启动 E、不改固定 Pi 0.84.3、不使用第二 loop 或 RPC fallback。

**A：空 managed 原身份恢复**

- 先增加 `managed pre-file receipt restores the exact empty identity and bootstrap model without manufacturing history` 红测，初始在缺少 nativeFirstUse 的既有拒绝点失败。修复使用独立 `managedPreFile`，不伪装为 native-first-use，不造 native JSONL。第一次复测暴露 macOS `/var` 临时路径符号链接触发安全守卫，改测试 root 为真实路径，没有放宽生产守卫。
- Host 将 Runtime 产品/安装/build/adapter/connection、profile、cwd、精确 bootstrap Provider/version/model 的非秘密所有权信息摘要传给自有 Adapter。只有新建且实际空闲、零消息、模型与目录精确一致的 managed Session 才记录证明。旧 map 没有证明时不据当前配置补写；异常格式、profile/path/ownership/model/version 漂移拒绝。已有原生文件仍走原文件、原模型/分支恢复。
- 私有原子 SessionStore 在普通模型派发、compact，以及 model/profile/auth 变更前消耗证明；后续 upsert 不会重新赋予。缺失或消费后的 pre-file 会话不能靠默认模型恢复。当前证明不是账号保证或 Runtime 内部 CAS，也不是请求验证。
- 新固定 Pi 零模型测试 `fixed_pi_managed_empty_trust_restart_and_session_control_are_model_free` 通过：ignore→approve 原 native/Farfold 身份恢复、模型一致、文件仍未落盘、统计读取和 Provider `not_requested`、本机 HTTP 捕获为零。

**B：Adapter 控制输出**

- 前端新增测试先因缺少控制投影函数失败，再实现标准 `session/update` 文本中的独立 version/origin/id 标记。只接受完整 Host binding、代次、native Session 匹配的 tagged Adapter text；原生 `_pi/event` 及未标记的 ACP 历史镜像不重复呈现，ID 去重。
- 控制输出存在独立的当前连接内存区，不进入原生 transcript、Provider 回执、文件/diff 或持久历史；原生快照刷新不覆盖该区域，连接变化不带入旧输出。界面明确标注“Pi Adapter 控制输出 · 仅本次连接，非原生历史”。
- `/session` 经既有 `pi_acp_workspace` / `_pi/workspace` 的 typed `session_command` 只读 section 查询并发送同一 Adapter 标准文本，不走 turn submit，不创建 Provider Turn。其他 Adapter built-in text 同样标记；这不等于已改写所有命令的任务分类。

**检查与候选**

- Adapter 类型检查与 192 项通过；前端类型检查、60 文件 305 项通过；Rust 首轮 464 通过/1失败/28忽略，失败为未修改的 OpenCode delayed-prompt socket fixture `WouldBlock`（OS35）。该项单独复测通过，降低并发到4后的完整 Rust 为465通过/28忽略。保留首次失败，不称已查明或修复该偶发原因。
- 新增固定 Pi managed 空会话测试与 Host receipt 正反例共2项通过（零外部请求）。clippy `-D warnings`、格式、生产构建、签名、`git diff --check` 通过。过程中的 Rust digest LowerHex 与测试 Debug 格式编译错误、前端 read API 参数形式错误均在安装前改正；无已知红色检查带入安装。
- 新 `/Applications/Farfold D QA.app` exec SHA-256 `80fc988c3e9197aa0f013e9d454162b1986201c5d272575441380c59487ef08b`；Adapter `22e2626a00bb584ba311cf762a3d09ee7c3910f4b2701e62bb62dfc5905a904c`；Pi 保持 `e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac`。bundle id仍 `ai.farfold.desktop.dpiqa`，内部 adhoc签名，不是公证分发。
- 安装前核对 D QA 停止、schema14/quick_check、原4 Session/9 Provider Turn。完整独立数据与旧 app 配对保存在私有 `output/2026-09-16-pi-version-diagnostic/pre-minimal-slice-NTOgwT/`；新包验证后仅对已确认的 D QA 路径作 atomic exchange。正式 exec `c7750c44`、Dev `85e50b52` 保持不变。

**安装 A/B（零外部请求）**

- UI 新建第5个 managed Session，沿用普通智谱已保存精确版本 `provider-version-f46f1ec04db081417db13074b03d0d77781ca2e2f521aa00dc5d1acc298fbfa6`、`glm-4.6v`，没有新填凭据或更换端点。Farfold `session-e5e105c4b7d2e1061807e809791564b24d69c62837c8e3333aafa5a3ff83be84`，native `01a0a66b-c6d7-78b9-9a75-90ace74ebc5b`，profile `profile-8cefa8b7890539d2fdf826e19a825d2c4cca43be8400d109648aa62ab8a03842`。
- 空会话切“载入受保护项目资源”后成功恢复同一身份与模型，发现2个既有 Extension commands；没有伪造 native-first-use，旧四会话均保留。新原生路径仍不存在。
- UI 输入并发送 `/session`，实际显示上述控制输出标签、相同 native ID、Messages0/Cost0/Tokens0，原生 JSONL仍不存在；Provider Turn仍9。不能把这次命令读取记为付费请求或 native历史。

**唯一 HOLD 尝试（两次真实模型响应，未重试）**

- 仅在原隔离 managed worktree 的现有 QA Extension 中加入 `farfold_d_hold`：固定 Pi 官方 `registerTool`/`typebox`，工具内存等待本机127.0.0.1释放，超时/abort结束，不访问文件、不调用模型；QA AGENTS为本次任务明确禁止任何其他工具/文件变化。没有修改生产 Runtime。该 fixture 与 AGENTS 的修改是验收准备，不是 Agent 文件任务。
- 在新第5 Session UI发送唯一 BASE-HOLD。实际 native JSONL 首次 assistant 包含正文 `farfold_d_hold`，但 toolCall **id=""、name=""、arguments={}**，stopReason为stop；随后 toolResult为 `Tool  not found`，下一 assistant最终回复 BASE-HOLD。UI展开工具步骤同样显示 `Tool not found`。没有 hold监听器出现，没有 STEER/FOLLOWUP 发出，没有新普通消息替代验收，也没有重试。
- 两次 native assistant usage分别 input1842/output88/cacheRead44 和 input1940/output60/cacheRead44，与本次两响应工具循环对应；未见额外重试证据，低于新四请求上限。没有保存/输出授权 key。空工具名在哪一层产生尚未确认；单凭结果不能断言 Extension未注册、GLM不支持工具、或适配器已被证明有某一根因。
- 唯一新增 Host Turn `turn-f6cc0284b4ccdf5466553c86b0edbdcc`；`project_level_only / working_copy_not_clean_at_turn_start / paths0`（QA fixture本来已有准备变更和既有证据文件）。QA AGENTS、Extension和27字节证据文件与请求前配对副本字节相同，原23个配置/历史文件全未改。活动队列验收保留 **partial**；未使用的预算不构成失败重试授权。

**最终冷恢复与保护**

- 正常退出后冷启动安装包，打开前片文件 Session，UI保留 BASE-WORK、唯一write成功27字节、STEER-WORK；再恢复原 Session，保留旧400、成功回复、旧Stop和正文0001→0027的aborted历史。未重发任何消息；控制输出未混入历史。
- 冷恢复前后28个配置/JSONL文件SHA-256全相同；最终 schema14、quick_check=ok、Session5、Provider Turn10、全库变更路径仍1。正常退出后未发现 D QA/其 Pi ACP 进程或 hold监听器。原正式/Dev摘要仍不变。
- `installed-minimal-slice.log`：原文件会话首次打开1678.8ms，空managed trust恢复901.0ms；`installed-minimal-slice-cold.log`：文件1252.1ms、原Session1295.9ms，固定版本检查均成功，无timeout。历史版本超时仍unknown，不增加阈值或重试。

**当前14项矩阵（不跨层升级旧证据）**

| 必需能力                        | 本片后状态             | 证据边界                                                        |
| ------------------------------- | ---------------------- | --------------------------------------------------------------- |
| 固定启动/版本/安装身份          | 新候选安装通过         | 独立包签名/摘要与恢复，历史timeout仍unknown                     |
| 稳定profile/凭据/版本隔离       | 所测范围通过           | 原23文件不变、精确bootstrap证明，不是账号保证                   |
| 模型目录/明确选择/idle/thinking | 分层有限通过           | 固定Pi/合同与本次同一GLM，不外推全部Provider/level              |
| Session/原分支/空分支保护       | 新空managed安装通过    | 新证明trust重启；旧无证明空Session仍拒绝，不追补                |
| prompt/流式/终态                | 分层通过，工具失败保留 | 前候选stream/Stop；本候选两响应结束，空工具名失败非成功工具执行 |
| 原生工具/文件/diff              | 复用前片已测路径       | write/disk/Host/diff/preview/Finder不重跑；新hold未执行         |
| 活动steer/follow_up             | **安装仍partial**      | hold窗口未建立；未发干预、未重试                                |
| Extension四表单/通知/withdrawal | 复用前片安装范围       | 2命令目录重载可见；不把它当hold工具执行证据                     |
| auth reply/cancel/logout        | 保留此前分层范围       | 本片不logout、不外推真实OAuth                                   |
| Stop/abort/unknown              | 保留前片普通Stop与合同 | 本候选恢复原Stop历史，不宣称又一次真实活动Stop                  |
| changing/unknown/任务绑定       | 所测范围通过           | pre-file消费、精确版本、只读/session无Provider Turn             |
| 历史/冷恢复/不重发              | 两历史Session安装通过  | 28保护文件不变；新空身份另有零模型trust证据                     |
| 命令/统计/只读工作台            | `/session`安装修复通过 | 当前连接控制区，零请求/零历史；不代表所有命令验收               |
| 手动compact边界                 | 按批准限制复用         | 固定Pi Stop unsupported与原模型/终态合同，不重复真实压缩        |

**停点**：A/B最小修复交付完毕；D整阶段仍未退出，E仍关闭。下一安全工作是空工具身份的零模型协议/fixture定位；进一步真实调用须按失败停点重新安排。保留必要QA材料与配对恢复，不清理或覆盖正式数据。

### 2026-09-16 D 最终活动队列安装验收与 mandatory 出口

**范围与最终判断**：后续明确授权在同一安装候选 `80fc988c`、同一普通智谱版本/模型、既有 managed file Session 中改用内置 bash建立活动窗口。本片没有生产代码/QA fixture修改、重建、换端点/模型/凭据、替换正式/Dev/P6或删除旧路径。最终 `sleep 120` 片完成真实 active steer/follow_up，原生工具/消息顺序、Host终态及安装冷恢复全部满足；结合获准复用的未受影响证据和明确接受的固定Pi限制，**D mandatory 验收出口完成**。这不是正式升级或全Provider/OAuth覆盖。按要求停在E入口；计划中的出口后旧路径清理仍未执行，保留其验证门槛，不在本片越界执行。

**先前 sleep20 的首次结果保留**

- 第一个授权独立片上限4响应，实际2响应。原 Host Turn `turn-6e62f5000c9dff4067d08936cf32059a` 属于既有 Farfold `session-1dea05af5a5f717922d5b7c910282b3034a53000af058b266f2580951bfd4418` / native `01a0a64c-5721-7422-b533-4d47097c48b5`。
- 原生UTC时间：BASE-BASH user 19:09:04.500；有效 bash `call_1255d40554894efab7e44e7e`、`{"command":"sleep 20"}` toolUse 19:09:10.767；toolResult `(no output)` 19:09:30.792；BASE-BASH最终stop 19:09:32.025，Host completed 19:09:32.057。工具成功运行约20秒。
- UI观察到“正在运行命令”后，执行者又展开详情核对；下一次状态已结束，未赶上干预窗口。**没有提交 steer/follow_up，不补发普通prompt，不宣称活动队列通过。** 这是验收操作时序不足，不是发现了产品故障。随后新的明确授权允许最后一个独立sleep120片，不把它隐藏成同一失败的自动重试。
- 两响应usage input2157/output93/cacheRead44、input2260/output29/cacheRead44。该片仅新增一个Provider Turn，paths0，30/31保护文件不变；原nativeJSONL预期6602→9471字节追加。

**最后独立 sleep120 片：真实同Turn active队列**

- 新授权上限4响应、不再重试；实际3响应。发送前固定两条干预文本，不展开工具详情或等待正文。BASE要求内置bash唯一一次 `sleep 120`（原生参数timeout150），禁止其他工具/文件/网络；STEER保留唯一bash，只把最终回复改成STEER-120；FOLLOWUP只回复FOLLOWUP-120。
- 同一 native Session `01a0a64c-5721-7422-b533-4d47097c48b5`、Host Turn `turn-b7fef78779e680f518dc672f81fefa90`。提交后Host记录completed为空；UI第9秒显示“正在工作”和“正在运行命令”。执行者立即填入/发送STEER，约21秒得到“已接收转向 · 将在当前工具完成后应用”及Pi已接收原生队列通知；切换跟进模式，约32秒得到“已加入跟进 · 将在当前任务完成后执行”及follow-up接纳通知。两个通知同时在同一活动页面，普通Stop按钮可用，未点击Stop中断本次验收。
- Host接纳语义核对：现有 `turn_coordinator.rs` 只有在ACP结果 `accepted=true`、原nativeSession一致、delivery匹配时才返回Accepted；`pi_acp.rs::begin_intervention`核对原binding与generation。Native/Adapter仍调用原生steer/follow_up，不改成普通prompt。活动期间Provider Turn计数仅11→12、最新Turn id持续为上述同一值；native进程5599拥有sleep子进程6193。UI接纳不被当作执行完成，之后再核对原生历史与终态。

| 原生顺序（UTC，2026-09-15） | 实际记录                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------- |
| 19:12:24.716                | BASE-120 user进入原native Session                                                     |
| 19:12:27.228                | assistant toolUse，`bash` / `call_dffdc29a6f7948b1a9a46982` / `sleep 120`、timeout150 |
| 活动约21秒、32秒            | 安装UI分别确认steer和follow_up已接纳入队；Host Turn尚未completed                      |
| 19:14:27.247                | bash toolResult，isError=false、`(no output)`，约120秒正常结束                        |
| 19:14:27.249                | 原生消费STEER-120 user                                                                |
| 19:14:30.445                | assistant stop，正文STEER-120；随后原生消费FOLLOWUP-120 user                          |
| 19:14:32.337                | assistant stop，正文FOLLOWUP-120                                                      |
| 19:14:32.367                | 同一Host Turn completed；UI空闲、队列消失，发送恢复普通模式                           |

- BASE→工具→STEER→FOLLOWUP属于同一个未提前结算的原生任务链，只有一个Host任务/Provider绑定。三响应usage依次input2307/output123/cacheRead44、input2387/output76/cacheRead44、input1744/output42/cacheRead735；未见额外重试证据。没有第二个bash或额外工具。模型价格配置为0不证明外部账单免费。
- 两个独立片都绑定原精确 `provider-version-f46f1ec04db081417db13074b03d0d77781ca2e2f521aa00dc5d1acc298fbfa6` / `farfold-managed-d589aa578ac328117e907c81c1320ee3b27cbc0df1e17d23a0e375c3fae0e8fc/glm-4.6v`；最终投影saved/applied/verified_success、verified version相同。`sleep120`片只新增一次Host Provider Turn，不能把3个模型响应写成3个Host Turn。
- 本片路径0、provenance为project_level_only/working_copy_not_clean_at_turn_start（QA准备更改和既有证据文件仍在）。原生JSONL9471→14096字节为预期追加；从两个bash片开始时原6602字节历史前缀SHA仍一致。其余30个保护文件不变，含QA AGENTS、Extension和27字节证据文件。没有把本来dirty的工作副本标成干净。

**空自定义 tool identity：只读归因边界**

- 系统化调试按“症状→上游输入”核对：旧第5Session的原生JSONL本身已包含空toolCall name/id，随后原生 `Tool  not found`；不是只有Farfold UI丢了名称。当前有效内置bash的原生id/name则完整。没有再次调用自定义hold或改生产代码。
- 固定SDK源码 `pi-agent-core/dist/agent-loop.js:394`按 `toolCall.name` 精确查找，找不到才产生该原生工具错误；`pi-ai/dist/api/openai-completions.js:283`在解析stream时可先以空name/id建块，后续按索引/ID合并并补名字。没有当时原始Provider SSE，**不能确定是外部未提供字段、流式分块/关联还是其他上游原因**。
- 维护Adapter的 `PiRpcProcess` 解析原生JSONL后向eventHandlers传递同一消息；`PiAcpSession`在展示归一化前复制完整事件发 `_pi/event`。这些代码与固定Pi localhost队列/Extension合同没有本片变更，前片集中检查仍可复用。当前证据支持把旧异常保留为Provider/native解码层的一次未归因输出观察，不是已证实的Farfold能力损失；不拿它否定已接受的基础Extension表单/通知/撤销能力，也不宣称原因已修复或自定义hold真实执行通过。

**安装冷恢复与退出**

- 正常退出后从 `/Applications/Farfold D QA.app` 冷启动，打开同一managed Session。UI完整恢复旧文件任务、sleep20历史、BASE-120、bash步骤、STEER-120与FOLLOWUP-120正文；展开最后bash显示 `(no output)`。没有重发消息或新Provider绑定。
- 冷恢复前后31个保护文件（28配置/JSONL及3个QA工作副本文件）全数SHA一致。最终 schema14、quick_check=ok、5 Session、12 Provider Turn、全库变更路径仍1。正常退出后进程检查无sleep、D QA或其ACP残留。
- `installed-bash-queue.log`的首次原会话打开1242.1ms；`installed-bash-queue-cold.log`最终打开1231.8ms、固定版本check4 spawned40.762ms→exited363.068ms，无timeout。旧启动超时仍unknown。安装D QA exec仍`80fc988c`，正式`c7750c44`、Dev`85e50b52`均未变。本片无生产变更，复用上一片完整测试/build/sign结果，未重复构建或再跑付费检查。

**最终14项 mandatory 矩阵**

| 必需能力                        | 出口判断           | 证据范围与保留项                                                                            |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| 固定启动/版本/安装身份          | 满足               | 当前签名安装包、固定Pi摘要、多次冷恢复；旧timeout未归因                                     |
| 稳定profile/凭据/版本隔离       | 满足所测范围       | 原精确版本与受保护文件、非秘密pre-file证明，非账号/CAS保证                                  |
| 模型目录/明确选择/idle/thinking | 满足批准的分层门槛 | 固定Pi/合同及真实同GLM；不宣称所有模型/level组合覆盖                                        |
| Session/原分支/空分支保护       | 满足               | 前片空managed trust安装修复、原历史/分支守卫；旧无证明仍拒绝                                |
| prompt/流式/终态                | 满足               | 复用正文stream/Stop；当前真实工具循环与最终settlement                                       |
| 原生工具/文件/diff              | 满足               | 前片唯一write/disk/Host/diff/preview/Finder；当前有效bash正常退出，27字节缺换行历史偏差保留 |
| active steer/follow_up          | **当前安装通过**   | 同一活动Turn两次accepted，工具后STEER再FOLLOWUP，三响应单Host Turn                          |
| Extension四表单/通知/withdrawal | 满足已接受基础范围 | 复用前片安装四表单/timeout与固定Pi合同；空自定义工具观察unknown不等于基础能力丢失           |
| auth reply/cancel/logout        | 满足批准的分层门槛 | 真实API key请求、合成SDK/固定Pi/UI合同；没有新增真实OAuth/logout覆盖声明                    |
| Stop/abort/unknown              | 满足已接受边界     | 前片真实正文Stop、固定合同；当前活动Stop可用，未为重验再中断                                |
| changing/unknown/任务绑定       | 满足所测范围       | 原版本绑定、同Turn干预身份、pre-file消费和只读命令零Turn                                    |
| 历史/冷恢复/不重发              | **当前安装通过**   | 完整活动链恢复、31文件字节一致、计数不增、无进程残留                                        |
| 命令/统计/只读工作台            | 满足已测路径       | 前片/session当前连接控制区修复，Extension命令和只读合同复用                                 |
| 手动compact边界                 | 按明确批准限制满足 | 固定Pi不支持此操作Stop；不改Pi、不伪造cancelled或普通模型回执                               |

**D出口与停点**：最后mandatory安装缺口闭合，D mandatory验收完成。保留各证据的source/fixture/installed/real Provider层，不把分层通过改写为全功能穷举验证。停在E入口主动回报；本次验收授权禁止生产改动，故D出口后旧入口清理尚未执行，不能写成已删除或正式升级。E未启动，未来动作仍须按唯一计划和相应验证范围执行。

### 2026-09-16 D 新建入口收敛与 E 无登录 ACP 骨架

后续明确授权恢复 D→E。结构复核发现旧 `codex_runtime.rs` 是 Host 直连 App Server，规格 E 则要求公共 ACP。先报告，协调明确继续公共 Host/ACP→独立 Codex Adapter→0.143.0 owned stdio App Server；不把旧 P6 实现外推为 E，不升级 CLI、不登录、不发模型请求、不替换应用。

**D 精确删除与保护**

- 先查 `PiWorkspace` 两个新建调用均已选择 managed ACP 或 native-first-use ACP；既有 `open` 根据持久绑定区分 RPC/ACP。D QA 数据库只读查询为 5 条 ACP Session，未做数据修改。
- `session-start.ts` 不再生成 RPC 新建输入；Host 拒绝 RPC 新建（含动态安装）；删除 `create_pi_session`、`HostPiSessionCreateInput`、RPC `host_new/create_native_session` 和 `NewSession` 派发枚举/响应控制。恢复使用的 `host_session`、`switch_session`、原绑定打开/信任切换/停止、历史读取保留。
- 新增负向检查：RPC 新建在停止/配置变更之前拒绝；原 RPC 打开仍携带原 Session；Host 不接纳旧新建输入，raw RPC 不再反序列化 `new_session`。无旧数据迁移，无文件夹清理。

**固定 Codex 事实与新骨架**

- 本机路径 `/Users/tw/.nvm/versions/node/v22.22.3/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`：Mach-O arm64，`codex-cli 0.143.0`，SHA-256 `9070e47d422129106bc41ca651a9998b06a6c55bd42a7c3362b48f1d2850766f`。只复用现存官方 npm 分发原生程序，未安装或更新全局 CLI。
- `scripts/codex-boundary-probe.mjs` 在新隔离 HOME/CODEX_HOME 生成 stable/experimental JSON schema 与 TS：`src-tauri/target/codex-e-boundary-wBXf4R/`。新进程验证初始化前拒绝、initialize→initialized、重复初始化拒绝、account null/requiresOpenaiAuth true、空 thread/list；login/Turn 调用均为 0。未知 `remoteControl/status/changed` 可见为原生事件方法，未当作账号验证。
- 当前 [OpenAI App Server 文档](https://developers.openai.com/codex/app-server/) 用于核对生成协议和握手方法；采用固定二进制新生成协议为权威。0.143.0 的 `LoginAccountParams/Response` 实际含 `chatgptDeviceCode`，browser 参数为 `codexStreamlinedLogin`，不能抄当前在线文档新增字段。固定 tag 的 `account_processor.rs` 同样有 device-code 分支。旧 Host `AccountAction` 只有 browser/API key/cancel/logout，不能据旧 UI 推断覆盖 device code。
- 新 `src-tauri/codex-acp-adapter/adapter.mjs` 维护版本 0.1.0，SHA `4fee9653dab60b067f5b84e6afc175e29632217f85f2a700fdbb5b88cc755208`。首片是小型 ACP1 JSON-RPC dispatcher，无外部 ACP SDK 依赖，不引用不兼容的 upstream codex-acp latest；固定清单在同目录 `manifest.json`。Node 22.22.3 SHA `5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c`。这是 Farfold 维护的协议骨架，不是完整 ACP Agent 或第二 Agent loop。
- 新 `codex_acp.rs` 使用既有 `initialize_transport/AcpTransport`；仅新建 0700 私有 profile，拒绝已有身份域，环境不继承默认认证/历史/配置。完整 product/install/native-build/adapter-ID+build/connection/profile/generation 随回执及 `_codex/event` 匹配；unknown native envelope 保留，所有 account 事件不进公开 raw。未知结果停止原连接，不重试或 fallback。真实固定链路通过未登录 account/read、空列表、错误代次双边拒绝、禁用 session/new、停止进程及无 auth.json。
- `codex-acp-contract.ts` 明确 browser/API-key/device-code、cancel/logout 原生类型和临时 UI 状态；迟到/取消/外来完整身份 completion 不接纳，匹配 completion 也不等于账号确认。这是合成合同，`loginAvailability` 为 unavailable；未生成 URL/code、未进入 SDK/OAuth、未提交 key。

**检查、首次失败与边界**

- Pi 删除后定向前端 48/48；全前端 60 文件、305/305，Pi Adapter suite 通过；后加 E 合同 2/2、TypeScript 检查通过。最终全前端再跑为 61 文件、307/307。
- Rust Session controller 9/9；Pi 相关 100/100、13 ignored；既有 Codex 28/28、3 ignored。新 E 4/4（显式带固定程序的 ignored 集成测试本次实际执行通过），覆盖真实只读链路及合成 foreign/malformed/crash/timeout-late/unknown 事件。clippy `-D warnings`、cargo fmt、所改文件 Prettier、Node syntax、git diff check 通过。
- 首次前端失败是新增 RPC 恢复测试漏配 `invoke` 返回 navigation；调用栈在 `host-shadow.ts` 读取 undefined，经测试夹具补全后通过，不改恢复产品逻辑。首次 E 编译使用了只在 cfg(test) 提供的 ACP `request`，改为现有生产 `request_timeout` 后通过；不另加传输实现。删除遗留 import 的编译 warning 已消除。记录失败，不把旧 Pi 超时/空工具身份写成根治。
- 最后只读 D QA 检查：schema14、quick_check ok、5 Sessions/12 Provider bindings/1 change path。安装执行文件保持 formal `c7750c44`、Dev `85e50b52`、D QA `80fc988c`、P6 QA `829c5d91`；没有应用替换、真实账号读取或数据内容迁移。本片不宣称重新 hash 所有凭据/历史文件。
- **停点**：D 新建入口收敛已完成；E 是 headless、无登录只读工程骨架，尚未注册普通 Tauri/workbench 操作、共享生命周期管理入口、持久 profile 恢复、认证执行、thread/turn/tools/questions/steer/interrupt/history 映射。因此还不具备旧 Codex 完整控制等价删除条件，旧 source authority 本片未删除；新路径没有调用旧 transport。后续按唯一计划继续同一共享机制，真实登录/模型/安装仍不属于本片。旧 P6 source/tests/installed/real-account 各层证据分别保留，不算 E 安装验收。

### 2026-09-16 E 共享生命周期与合成 Configure 认证闭环

**授权与证据层**：按后续明确授权继续共享 Host lifecycle/Configure，认证仅使用无网络 synthetic App Server。用户休息期间不启动真实 browser/device/API-key 登录或模型请求。固定 Codex 仍为 0.143.0；不升级 CLI、不导入默认认证/历史、不打包/安装、不删除旧 Codex。参考官方 App Server 文档，实际字段和取消状态以先前固定二进制生成的 schema 为准，未把当前文档新字段回填进固定合同。

**实现与边界**

- `codex_acp/configure.rs` 的 Runtime 复用 `AcpRuntime`、`HostSessionController` 和既有 ACP transport；`AcpSessionOperations` 增加 connection-level Configure 占用，不伪造 native Session。启动/停止、原连接、generation、Configure operation/request/login ID 共同限定操作；等待回执不持有连接控制锁，Stop 可结束进程，原连接迟到回执不能写入新代连接。
- 维护 Adapter 升为 0.1.1：入口 `64661cfed8cee809b6f7905232d0cf01db31db2f871313527df1e9fcc4e0da82`；core `4173778c65528e97337c68fd1d8c8dc8eb01ec31729c528317068d35217de5ce`；configure `a6eeb63519e4047d8d0c6ceac2e06ba593d9b49588af095d1ed36afb66d02407`。Host 与入口在执行/import 前验证模块摘要，manifest 一致性回归覆盖全部可执行模块；Node/native 固定摘要未变。
- 生产入口硬编码 `authenticationEnabled: false`，没有环境开关。测试专用入口仅注入同目录无网络 synthetic App Server，并调用同一 core/configure 实现。真实 `_codex/configure` 在 Adapter 本地明确 unsupported，不进入 native login。
- 合成认证支持 browser/device/API key、status/cancel/logout；先返回 starting，再经临时状态取得指令。校验 HTTPS 官方登录域、设备码、完整 scope 与对应操作身份。早到 completion 按 login ID 关联，已撤销 ID 隔离；登录响应到达前 cancel 可继续撤销其后返回的真实 login ID。固定 `cancel notFound` 保持 unknown，不等于回滚完成。
- API-key/logout 取消不能证明写入撤销，因此保持 unknown，迟到 commit/account read 不覆盖；未知占用只经断开解除。终态 status 可继续刷新当前账号，外部 `account/updated` 能使先前已完成操作的当前 account 变为未登录，但不篡改历史完成结果，也不生成 Provider/model 验证。
- key 只经临时 typed stdin 参数；Host Flow 不保留 key/URL/code，命令和快照不实现 Debug。JS 在同步序列化派发后删除 key 引用，不声称内存清零。登录 URL/device code 仅出现在临时 Configure 响应，不进入 Session/raw unknown 事件、DB、日志或原生错误文本；原生错误只返回受控错误。合成服务主动输出秘密标记，测试验证事件侧不泄露。
- `account/*` 通知私有化；本片一旦尝试认证，随后所有其他 unsolicited native payload 也隔离，以覆盖通用错误回显秘密的风险。**这是任务尚未启用时的有限保护，不是完整原生事件保留**。不得直接开启任务；下一 native Session 工程片必须先建立认证私有与任务事件通道，并处理持久 owned profile 精确恢复。当前仍只允许 fresh profile，不复用已有 auth/config/history。
- 前端只增加临时状态类型/文案合同，明确“账号已读取，模型/任务未验证”“需登录/需确认/未知”；没有注册普通 Tauri 或工作台登录入口，没有 UI ready 验收。

**验证与首次失败**

- 七项 shared Host→ACP→synthetic stdio 认证测试覆盖 key/logout、browser/device/早完成、占用/错身份、早 cancel/notFound、key 迟到 commit、重连代次、Stop 中迟到 status、外部账号变更（单项包含多个场景）。另有模块摘要一致性及既有 scoped transport 回归。最终 E 定向 11 passed / 2 ignored。
- 两个 ignored 固定程序集成已显式执行：新鲜空 profile 的 initialize/account/list、完整身份拒绝及停止；共享生命周期重复启动拒绝、真实入口本地拒绝 Browser Configure、旧 profile 不自动恢复、新 profile 代次递增且旧 scope 拒绝。该轮含合成检查共 11/11；真实 native login/model 调用均为 0。之后新增账号变更和模块摘要两项仅合成/静态检查，不追加真实认证。
- 全前端最终 61 文件、308/308；TypeScript 检查通过。全 Rust 首轮 476 passed / 30 ignored；后加两项检查再跑全量，最终 478 passed / 0 failed / 30 ignored（24.21s）。定向 E 11 passed / 2 ignored。clippy 首次报新增代码两处 `collapsible_if`，按系统化调试核对后仅改等价 let-chain，复跑 `-D warnings` 通过；不修改状态或时限来消除失败。
- Node syntax、所改 Adapter/前端文件格式、cargo fmt 与 git diff check 通过。未执行应用构建、签名、安装或真实模型测试；测试编译不算安装交付。
- 收尾只读检查：四安装执行文件仍 formal `c7750c44`、Dev `85e50b52`、D QA `80fc988c`、P6 QA `829c5d91`；D QA schema14、quick_check ok、5 Sessions/12 Provider bindings/1 change path。不读取真实凭据内容，不声称重新 hash 所有私人历史/配置。没有数据清理或迁移。

**停点与下一安全片**：本轮共享生命周期/Configure 的合成认证工程闭环已完成，提交分层复审。E 仍未真实登录、未具备 native Session/Turn/tools/questions/steer/interrupt/history 的完整映射，也没有普通工作台或安装出口。下一有限片可先做 owned profile 精确恢复、认证私有/任务事件边界及 native thread/session 合同；真实登录/模型请求和应用替换需另按对应验收范围推进。旧 Codex 继续保留，新 Adapter 不调用旧控制器或提供 fallback。

### 2026-09-16 E 精确 profile 恢复、私有事件通道与共享 Session 身份

**授权及身份决定**：上一 Configure 片协调独立复跑后通过。随后明确授权共享 profile 精确恢复、私有认证/已验证 thread 通道、thread list/read/start/resume 的有限工程合同；真实登录、模型、Turn/工具/交互、普通 UI、安装及旧 Codex 删除仍禁止。发现固定 Thread 同时含 thread.id 和树级 sessionId，而共享 Session 只有单一主 native_session_id 后先回报。协调明确批准最小扩展现有 shared locator：主字段仍存控制 API 的 thread.id，新 `codex_tree_session_id` 保存 opaque tree sessionId，不新建 Codex Session 表，不把树 ID 当文件路径。

**固定协议事实与真实执行上限**

- 当前 [官方 App Server 文档](https://developers.openai.com/codex/app-server/) 只作背景；固定 0.143.0 新生成的 `Thread{Start,Resume,Read,List}{Params,Response}`、`Thread`、`ThreadStatusChangedNotification` 为本片字段依据。resume 只使用 threadId，明确不传可覆盖身份的 history/path；read 使用 includeTurns=false，resume 使用 excludeTurns=true，start 不指定模型并显式不开 raw events。未增加 turn/start、模型选择或任何工具/审批/问题调用。
- 固定缓存源码 `request_processors/thread_processor.rs` 的 thread_start_task 会加载配置，在满足条件时持久化 project trust，并调用 thread_manager.start_thread_with_options。此调用并非单纯元数据写入；本片没有证明所有后续初始化均无网络副作用。因此 **真实 thread/start/resume 保持硬禁用，仅 synthetic 执行**，未为获取“真实通过”放宽。真实固定集成仅版本检查、空 account/list、精确空 profile 生命周期及 Adapter 本地 unsupported；实际 native login/model/thread mutation 均为 0。

**共享持久权威与恢复**

- schema15 仅在临时测试库推进。新迁移保持旧 schema14 原文件不改：stable Codex ACP 可省略 managed bootstrap；`runtime_owned_profile_launches` 是以原 profile 为外键的附属启动元数据，不是另一套 profile owner。它只保存 HOME/CODEX_HOME、node/adapter/native、cwd/worktree、adapter version/modules、home/runtime-home/lease 的 device+inode，以及持久 last_generation；不存 key/account/native history。
- `codex_acp/profile.rs` 复用共享 RuntimeBinding、runtime-owned profile 和 schema8 `CodexInstallationInspection`/system-installation 格式。每次先核对固定程序及全部模块摘要，恢复比较原登记、实际精确路径/目录身份和权限，不迁入默认 `.codex`，不重建缺失目录，不接受 symlink/外来目录或 changed module/build/worktree。读取真实 profile 前只检查 auth/config/history 是否存在，不读取其内容；本片真实恢复仍拒绝这些状态。
- 私有 0600 launch lock 使用非阻塞进程存活期 lease，拒绝同一 profile 的第二条活动连接；generation 在启动前事务递增，失败消耗代次而不复用。Connection 持有 lease 到结束；旧代回执不能作用于新连接。非持久 fresh-launch helper 已限制为 cfg(test)，生产 headless 入口经 start_owned 复用 AcpRuntime/HostSessionController，不留另一套新 profile 启动权威。
- 共享 `SessionRegistration` 的 native_session_id 继续为 thread.id；新 locator kind 的 value 为单独 tree sessionId 字符串。`SessionOpenTarget` 改为 kind + locator_value；仅 PiSessionFile 分支转换为 Path。Pi path registration 继续规范化、检查根目录和 JSONL；file-based latest resume 显式拒绝 opaque kind。原 Pi locator 唯一性保留为 partial unique index，Codex 同一 tree 可有多个线程，不错误地把 tree ID 设为线程唯一约束。
- Host Session 登记使用现有事务方法扩展的 OwnedSessionGuard，原 profile/build/connection/generation/worktree 在同一登记事务内核对，双身份冲突拒绝。冷打开从 Host 取原 thread/tree/cwd，再 fresh list→read→resume，逐步核对全 scope 与持久 pair，前后重读 Host 目标，迟到或变更不接纳。rollout path 每次观察校验在 owned sessions 根下且无路径别名，但不持久为主控制身份；合成移动路径后仍恢复同 thread/tree。新 E 目标不被旧 direct Codex 打开机制接纳，无 fallback。

**Adapter 与事件隐私**

- 维护 Adapter 0.1.2，最终入口 SHA `7f471e0c57b04d79ff8e5b17a76ca270b43e711780433753120adbe5a5e25788`；core `4be18131dd4735a545980bba9a7eaa1a1d9470a087837b730eeffe5fcdd4eac7`；configure `741efc417116b703686f21da1be10f5fe2f38bb49aa51bd3e3833e119a4cab1f`；threads `55d5baf41a5325c258ea4f0cee0a00331d3f656acf157ada2a391ce55420cb6c`；events `8b3a557046073a057a87f7ce8641ba452a926f2ab2836795322cada433a433ec`。固定 Node/native 版本及摘要不变；Host/入口/manifest 测试核对每个模块。
- `events.mjs` 将通知的原始 JSON 文本保留在连接私有内存，线程回复则保留解析值。account、登录 URL/code、通用 error 与未知方法不进 Session/raw Host 事件，不落 DB/日志，也没有 Agent/Host 工具可读取私有缓冲。上限 128 条/1 MiB，超过即 fail closed，不静默丢弃以冒充连续性；断连后释放，不宣称为持久原生历史。
- `threads.mjs` 对已知 thread reply、thread/started 与 thread/status/changed 做类型和 thread/tree/cwd/profile 范围校验，再向 `_codex/thread/event` 投影有限生命周期元数据；未知字段、文本、future event 和错误身份仅留私有，不驱动状态。这是正向类型/身份校验，不是字符串秘密黑名单。早于 response 的 started 事件先暂存，确认原身份后才投影。合成认证之后正常线程事件仍可到达，替代了上一片的 blanket post-auth discard。
- `AcpSessionOperations` 继续承载 New/Load/connection Configure 的排他操作。等待回复时释放连接锁，Stop 可结束进程；unknown 保留占用且不重试，显式本地 unsupported 则释放占用而不虚构 native mutation。没有账户/模型 verified 或 task-ready 投影；普通 Tauri/工作台入口仍未注册。

**检查、首次失败与证据层**

- 公共 HostStore 相关 87 项通过，包含原 Pi locator、恢复、删除、导出及旧 schema 迁移。新增 14→15 临时迁移回归保持旧 Session/draft、Pi 原 locator 值/种类/时间戳、native-only profile 与一致性备份，不改真实数据库。
- 合成 shared Host→ACP→App Server 覆盖 start/read/list、原 thread/tree 冷恢复、rollout 位置变化、错误 tree/cwd/worktree、认证后事件、Stop 等待中迟到回复/新代隔离、第二次绑定拒绝。共享 Session 登记幂等与冲突、两线程同 tree、新 opaque locator 不进入 Pi file restore、portable export 的 locator 计数/内容和外键删除级联通过；级联测试仅删除临时 Host 元数据，合成 native 文件保留。它不是安装 UI 删除验收。
- 最终集中全 Rust：485 passed / 0 failed / 31 ignored（26.12s）；限制旧 fresh helper 为 test-only 后 E 定向 17 passed / 3 ignored、clippy -D warnings 通过。三个固定只读 ignored 集成另显式执行通过，含持久空 profile 恢复、原代次拒绝、并发 lease 拒绝、本地拒绝 login/start 后仍可读取；其余 ignored 没有冒充本次通过。最终 Adapter 原始通知保留改动再跑完整 E（含三个固定只读集成）为 **20/20 passed（70.51s）**。该总时长包含多轮大型固定程序摘要和版本校验，不是单次启动时延，也未延长已有请求超时。
- 前端 61 文件、308/308；TypeScript 检查通过。Node 私有缓冲合同 1/1；所改 Adapter 文件 Prettier、Rust fmt、git diff check 通过。未做应用构建/签名/安装，无真实账号或模型请求。
- 首轮编译失败：rusqlite 不实现 u64 ToSql/FromSql，数据库边界改为受范围约束的 i64，协议仍用 u64。模块维护中摘要/版本未同步的测试正确拒绝；重新固定全部模块后通过。临时目录 fixture 默认权限不是 0700，明确设置测试目录私有权限后通过，生产不放宽。共享 locator 测试重命名后漏导入 Path，补全测试限定名后通过。
- 首轮全 Rust 唯一失败为 release-manifest 的 source schema 仍 14，对照 CURRENT_SCHEMA_VERSION=15 后同步 source manifest，485 项复跑通过；不代表已安装应用升级。首次全前端发现新 Node `.test.mjs` 被 Vitest 误收集，Node 自身测试虽过但 Vitest 报无 suite；移为 `events.spec-node.mjs` 并分别执行，前端 308 与 Node 1 项均过，不跳过失败文件来伪造成功。
- 收尾只读四安装执行文件摘要保持 formal `c7750c44`、Dev `85e50b52`、D QA `80fc988c`、P6 QA `829c5d91`；D QA 仍 schema14/quick_check ok/5 Sessions/12 Provider bindings/1 change path。没有真实凭据内容读取、数据迁移、清理或默认认证导入；没有重验所有私人历史文件的字节摘要。
- `lifemodel_gateway` 及 LifeModel/Codex 旧测试中的改动仅为共享 locator_value 字段的机械兼容，不新增 LifeModel 能力或改其授权语义；旧 direct Codex 生产控制流程未迁移或删除。

**阶段结论**：本片是精确空 profile 恢复与 synthetic native thread/shared Session 生命周期工程片。可提交复审，再进入受限 synthetic Turn/event mapping；不能直接打开真实任务、真实认证/带 history profile 恢复或宣称完整事件/原生能力保留。线程元数据只支持本片 idle/notLoaded、零 turns、root thread 的有限形状，列表超过当前单页范围仍拒绝；更完整类型/分页/活动事件属于后续合同。旧 Codex 控制器保留，未接真实登录/模型/工具/approval/question/steer/interrupt、普通 UI 或安装 E 出口。

### 2026-09-16 E 合成 Turn、事件与 Stop 有限片

**授权及当前层次**：profile/thread 片经协调独立复跑 17/17（3 ignored）与前端合同 3/3 后通过，明确续做本片；不是重新开始 E 或打开真实任务。继续使用固定 Codex 0.143.0，不修改 Runtime、不新增 Agent loop，不接旧 Codex 控制器旁路。生产入口仍硬禁用 login/thread mutation/task/history task entry/model；只有独立 test entry 注入无网络合成 App Server，真实固定检查仅空隔离 profile 只读与 Adapter 本地拒绝。没有普通 Tauri/UI 注册、安装、现有库迁移或旧 Codex 删除。

**字段和采用依据**

- 按 OpenAI Docs 技能核对当前官方文档，但以本地固定 0.143.0 生成的 `TurnStartParams/Response`、`TurnInterruptParams/Response`、`TurnStartedNotification`、`TurnCompletedNotification`、`Turn`、`TurnStatus`、`TurnItemsView`、`ThreadItem`、item lifecycle 及 assistant/reasoning delta types 为字段依据。固定 `app-server/tests/suite/v2/turn_interrupt.rs` 明确先读取 interrupt response，再等待 turn/completed 并断言 Interrupted；完成轮 interrupt 原生报错。采用该控制接受/实际终态分层，不把 ACK 写成停止。
- turn/start 只传原 threadId 和 typed text input（含原生 `text_elements: []`）；没有额外模型、权限、模式覆盖。native Turn ID 由 start response 提供，早到通知在该回执验证后按同一 ID 路由。native item ID 只取生命周期字段，保留 opaque ID，不由数组下标、正文或时间构造。
- 完整 raw native Turn、item、generic error、auth/unknown 字段留在既有私有有界缓冲，不进入公共事件/数据库/日志/工具；上限仍 128 envelopes / 1 MiB，压力失败关闭，不默默丢弃来维持“正常”。此上限限制可连续处理的内容量，不是完整原生能力支持。

**实现与证据边界**

- 新 `turns.mjs` 在既有 core dispatcher 内接 synthetic start/interrupt/history。已确认 native thread.id/tree sessionId 与 Farfold Session/Host Turn/Working Copy，外层 scope 另含 product/install/runtime build/adapter/build/connection/profile/generation。全文只正向投影 assistant text、reasoning summary/content/index；命令和文件修改仅投影原生 ID/type/status。command、cwd/output、文件 path/diff/error、未知 item payload 私有保留，不归属 Host 文件变更、不创建可执行成果或第二条工具权威。
- Host `codex_acp/turns.rs` 经现有 HostSessionController、shared Session target/owned launch authority 核对原身份；共享 TurnCoordinator 接纳并保留两活动任务与 Working Copy 排他规则，AcpSessionOperations 增加 Turn kind，在 native terminal 前占用原 Session。Configure/冷读/新任务不能越过该占用。事件经原 RuntimeEventRouter/既有 projection、interaction、Turn observers；本片没有构造审批或问题，合成检查确认 interaction 列表仍为空。
- completed/failed/interrupted 只结算同一 native Turn 与 Host reservation。已知 item 生命周期未结束时 native terminal 也失败关闭。interrupt 返回空对象仅为 ACK；负向 ACK/超时/断线保留 unknown，绝不以停止连接、请求结束或异常返回释放任务。停止请求重复派发受本轮标志限制；迟到操作回执先检查原 Context/native ID，不能把下一轮标成 unknown。
- 早到 started/item/terminal 排队等待 start response；旧/外来 thread/Turn ID 不获取当前占用。最终迟到回归将第二轮显式保持活动，旧完成通知在此窗口到达，Host 仍只有第二轮活动，直到该轮自己的 interrupted 终态才释放。
- 完成态冷恢复复用原 fresh list/read/resume 与原 shared locator，随后 `thread/read(includeTurns=true)` 读取完整 terminal history。只接受 full、至多 64 Turns/每 Turn 256 items；未知 item 保留但不投影，部分/活动/不明历史仍阻断。临时数据库重新打开及 generation2 的原 Session/tree/Turn 历史与原文件字节不变，未 resend。**跨连接代次未知 Turn 的自动核对/释放仍未实现**，不把此正常完成态恢复宣称异常恢复闭环。
- 本片 schema 仍为 source15，只使用临时测试库；沿用已通过的 shared profile、双 native identity 与 Pi locator 迁移/恢复测试。没有操作日常 profile、真实账号或用户历史。

**维护固定组合**

- Adapter 0.1.3 entry SHA-256 `9e2190e954d099e3f30d9181a9c2dad20b079311d2f7e680706651c79da8c1f1`。
- turns `e88e2f6257fac2580de23c9df808a5c938246c0b61241571dfc25a522a23b4d4`；core `4ced3a6f8bd27c711c1db38f788c1cc68a1efa8b57485669561753497adac2e3`；threads `3828f122f998b8e98583b84196c9ebc0cc5817999b8a3106564fce18497e2f85`。
- configure `741efc417116b703686f21da1be10f5fe2f38bb49aa51bd3e3833e119a4cab1f`；events `8b3a557046073a057a87f7ce8641ba452a926f2ab2836795322cada433a433ec`。入口、Host 文件校验、manifest 及 persisted launch module metadata 均含 turns 新模块。固定 native `9070e47d…0766f` / Node `5d9d3872…7cd5c` 未变。

**检查和首次失败**

- 集中完整 Rust：494 passed / 0 failed / 31 ignored（19.38s），含共享 Session/profile/Pi locator 回归。前端 61 文件 / 308 passed，Pi Adapter 192 passed，typecheck 通过。E 新增 Host Turn 合成 9 项；Node Turn/私有缓冲 7/7。最终 clippy -D warnings、Rust fmt、所改 Adapter Prettier、git diff check 通过。
- E 显式 synthetic + 3 个固定真实空 profile 集成首轮 29/29（82.75s）；真实 task/history 方法被 Adapter 本地 -32601 拒绝，原空 profile 不生成 sessions。总时长包含多次大二进制 hash/版本/精确恢复，不是单次启动时间；原生 10s 请求超时、Host 15s 等待均未改变，无 retry。最终入口仅格式变更并重新固定后再执行同一显式集合，**29/29 passed（72.40s）**，包含强化的旧终态与下一活动轮重叠回归。收尾所改四份契约/记录 Markdown Prettier 通过，E adapter/synthetic 进程无残留。
- 首次编译：新 fixture 对 `RuntimeEventRouter.snapshot` 误传三个参数，核对既有两参数签名后修正，非共享接口改动。第一次 8 项运行 6 过/2 失败：fixture 错把异常 native exit 后的 transport.stop 期望为成功；另把 sanitized timeout response 与 reader/process failure 误当同步到达。按现有传输合同保留异常 stop 的 unknown；超时测试在有界窗口内允许排空已收到的非终态事件，同时始终断言占用未释放，直至真实断线。复跑 8/8。
- 增加共享 observer/全 scope/tree 负向检查时，临时 SQL fixture 把 `locator_kind` 误写为 `kind`，首次 25 passed/1 failed/3 ignored；按 schema15 列定义更正，目标回归及后续集中检查通过。没有放宽身份验证或改真实库。
- 初次格式检查发现 turns 摘要从占位符替换为 64 字符后入口数组超长；仅格式化该项并重新计算 entry/Host/manifest 摘要，再做固定 gate 检查。不把旧摘要的测试冒充最终入口验证。
- 只读保护核对：formal `c7750c44`、Dev `85e50b52`、D QA `80fc988c`、P6 QA `829c5d91` 四安装执行文件摘要与片前相同；D QA schema14/quick_check ok/5 Sessions/12 Provider bindings/1 change path。真实账号登录、模型调用、app 构建/替换均为 0；未删除用户或 QA 数据。

**阶段判断/后续**：这是可提交协调复审的 synthetic Turn/Stop 工程片，不是 E 安装出口或真实模型可用。已知未完成：真实账号/模型接纳与带历史 profile 准入，完整 native item/后台执行与 actionable 成果，跨代未知 Turn 核对、分页/活动历史，approval/question/steer/review/实验问题，普通工作台和安装。协调复审通过后可安全安排下一有限 **synthetic interactions** 片，仍不能直接启用真实任务、弱化模型验证或删旧 Codex。

### 2026-09-16 E 合成原生交互与 steer 有限片

**授权与证据层**：Turn/Stop 片经协调独立复跑 E 26/26（3 ignored）、Node 7/7 后通过，随后明确授权本片 command/file approval、Plan-only requestUserInput 和原 active Turn steer。仅 test entry 注入无网络 synthetic App Server；生产入口 task/login/model/thread mutation/interaction/steer 均硬禁用，无环境变量绕过。真实固定 0.143.0 只做隔离空 profile 只读与 Adapter 本地拒绝；真实登录、模型调用、native Turn/thread mutation、审批/答案/steer 均为 0。没有普通 Tauri/UI 注册、安装、现有库迁移、旧 Codex 删除或另一条 Agent loop。

**固定原生合同依据**

- 按 OpenAI Docs 技能查询当前官方 App Server 文档作为背景；实际字段、选项与顺序以本地固定 0.143.0 生成的 command/file RequestApproval、ToolRequestUserInput、ServerRequestResolvedNotification、TurnSteerParams/Response、ThreadSettingsUpdatedNotification、CollaborationMode/Settings 及固定上游测试为准。没有以当前网站替换固定版本合同。
- command 保留有序 availableDecisions；缺省时按固定 enum 和原生 policy proposals 构造允许决策。file 保留固定 accept/acceptForSession/decline/cancel。固定 grantRoot 描述明确不稳定，不能保证持续会话授权效果。commandActions 是 best-effort 衍生展示，本片不投影；原始包仍在私有缓冲，不抹去实际 command/cwd/reason/必要 permissions/proposals。
- requestUserInput response 只有 answers 映射，没有独立 cancel response。用户取消走原 Turn interrupt，不生成空答案。固定 request_user_input/turn_interrupt 测试在回答或中断后等待 serverRequest/resolved，之后才等待 Turn 终态；本片据此区分回复写出、请求结束和任务终态。resolved 本身不能证明用户批准，也可能来自原生撤销或自动结束。
- turn/steer 使用原 threadId、expectedTurnId 与 typed text；响应必须返回同一 turnId。ACK 仅说明接纳，不是执行结果。没有新 prompt/follow-up。
- Plan gate 来自本轮、同连接/完整 scope、同 thread 的新鲜 thread/settings/updated 观察；每个新 Turn 重置为未知。固定 question 参数自身不带 mode。该观察不是外部模式原子 CAS，也不是 account/model admission；普通模式设置还未接。固定启动继续设置 features.default_mode_request_user_input=false，Default 模式问题关闭。

**共享实现与逐项能力**

- 新 Adapter interactions.mjs 由原 core/turns 调度：原 native request ID 保留字符串/数值区别；绑定 item/native Turn、thread/tree、Farfold Session/Host Turn、完整 launch scope/generation/worktree。已完成 item、旧/外来/重复 request、错误 Turn 或 malformed payload 不创建可回复交互。原生请求先于 start response 时先有界暂存，身份确认后才投影；问题期限扣除本地暂存时间。
- command/file 只正向校验必要字段；question 保留 id/header/question/isOther/isSecret/options 及原有顺序/答案形状。最多 16 个问题、32 个选项，必要长文本 16 KiB、单请求 64 KiB。匹配同一 active native file item 时，可附带最多 32 个 typed path/kind/diff 预览；没有匹配则为空。这不创建 Host 文件所有权、实际工具执行或文件修改记录。raw auth/error/未知字段保持 128 包/1 MiB 私有有界通道，无字符串黑名单、无公共读取工具；秘密回答不进入公共事件/SQLite/日志。
- Host codex_acp/interactions.rs 仅复用既有 codex_interactions 的纯数据 codec，不调用旧 direct controller。Interaction wrapper 经过严格 typed allowlist，再经原 RuntimeEventRouter 进入共享 interaction_registry；未建立第二 registry/控制权威。共享快照带原 scope/context/native IDs，数据库 attention 只保存 ID/status，不保存答案。现有 Pi/旧 Codex 分支保留。
- 回复前重读共享 Session/owned target、原 active Turn、scope、完整 registry snapshot；begin_response 一次性锁定，发送原 JSON-RPC ID 的 validated response。确认本地 sent 后仍是 Responding，不调用“已完成答案”状态。只有匹配原 request 的 native resolved 才结束；Stop、expiry、离开 Plan 或 terminal 只撤销可回复性。显式未发送可按既有 registry 合同恢复 Pending；模糊错误失败关闭并保留 unknown，不重试或假装原生回答。
- Stop 与 pending command/file/question 共存，既不代答也不释放原 Turn 占用。问题到期和离开 Plan 不发送任何答案；稍后的 resolved 仍核对原 request。断线通过原 scope 的 transport_error 使交互 stale，但原 Turn unknown 占用仍在。
- 同 Turn steer 校验原 Context/native ID、operation ID、非空有界文本、非 stopping/unknown/in-flight；同一操作 ID 不复用，不替换审批答案、不新建 Turn。core 的等待计数允许交互回复和原 Turn interrupt 穿过正在等待的 steer，其余配置/新任务仍排他。迟到 ACK 再验原活动对象/代次，不能标记下一轮 unknown。steer 拒绝或超时保留未知占用；显式停止已知原 Turn 仍可尝试，不自动重试。
- schema 保持 source15，仅临时数据库；原 shared profile/launch/Session/locator 和 TurnCoordinator 权威继续适用。跨代未知 Turn 自动核对仍未实现，旧 generation 回复不能用新连接返回。

**固定维护组合**

- Adapter 0.1.4 entry SHA-256 `d0caff51858dc011e0159cdf36eb1ab92eeb1dadd8e52f3bd4bf7826080ffc03`。
- interactions `6046eaba46f6840eeb634c3cc15e37f9041022f40d821106ff7018b1d0421ed6`；turns `0b57dca205a98595a21347c2c014e7009e0aaa57fbf2f7dc1fa0f92be68d8b4b`；core `161f237944a8d2f3f69a1f5b0977dd45e3c7d015193fe1572b5048042d32dfc2`。
- configure `741efc417116b703686f21da1be10f5fe2f38bb49aa51bd3e3833e119a4cab1f`；threads `3828f122f998b8e98583b84196c9ebc0cc5817999b8a3106564fce18497e2f85`；events `8b3a557046073a057a87f7ce8641ba452a926f2ab2836795322cada433a433ec`。入口、Host、manifest 与 persisted launch metadata 都核对新增模块；native `9070e47d…0766f`、Node `5d9d3872…7cd5c` 不变。生产 manifest 仍 read_only_engineering，loginImplemented/tasksImplemented 为 false。

**检查、首次失败与保护核对**

- 新 Host interactions 首批 8/8，补充超时/旧代后 **10/10（10.53s）**：command/file/Plan choices、typed diff、secret answer 不进事件/库、foreign tree/duplicate reply、Responding 直到 resolved；pending Stop 无代答；expiry/withdrawal/Default/断线；pending question 时 steer；错误 expectedTurn/重复操作；延迟 steer 与 Stop/下一轮竞态；拒绝/超时后原 Turn Stop；native cancel 与未 resolved；Configure 排他与 generation2 拒绝旧回复。
- Node 合同最终 **16/16（87.60ms）**，含离开 Plan 撤销问题状态；前端合同定向 5/5、typecheck 通过。新增交互片各轮测试/编译未出现失败，不以历史 Turn/Stop 片的首次失败作为本片失败或修复。没有改请求超时、放宽身份校验或添加重试。
- 集中全 Rust **504 passed / 0 failed / 31 ignored（21.35s）**，包括 schema/profile/Session/Turn/Pi locator/旧 Runtime 回归；全前端 **61 文件 / 308 passed**，Pi Adapter **192 passed**。E 显式执行所有 synthetic/source 与 3 个固定真实空 profile 检查，最终 **39/39（84.68s）**。总时长包括重复固定大二进制摘要/版本核对和 profile 恢复，不是单次启动时延；其他 28 个全库 ignored 未冒充本次通过。
- clippy --locked -- -D warnings、cargo fmt --check、Adapter Node syntax、所改 Adapter Prettier 和 git diff check 通过。应用未构建、签名或安装；测试构建不算交付安装版。
- 收尾只读四应用执行文件摘要仍 formal `c7750c44`、Dev `85e50b52`、D QA `80fc988c`、P6 QA `829c5d91`；D QA 仍 schema14/quick_check ok/5 Sessions/12 Provider bindings/1 change path。没有读取真实凭据内容、修改/迁移日常库或重新 hash 全部私人历史；没有清理数据。E adapter/synthetic 进程无残留。

**停点与下一安全范围**：本片完成 synthetic 原生交互/steer 工程合同，提交协调复审，不等于 E 真实任务或安装出口。真实账号/模型 admission、带认证/历史 profile 恢复、完整原生权限任务/后台执行、跨代 unknown Turn 核对、更完整事件与活动历史、普通工作台和安装验收仍未完成。下一有限片应先处理 **account/model admission**，再考虑工作台接线；真实认证/模型调用仍须对应授权，不从本片推定。旧 Codex 不删除，也不作为新 Adapter fallback。

### 2026-09-16 E 合成账号、完整模型目录与原会话准入有限片

**授权与固定接口取舍**：交互片协调独立复跑 Host 10/10 与 Node typed boundary 9/9 后通过，授权本片 account/model admission，用户不在场期间禁止真实登录/设备码/API key/模型请求。OpenAI Docs 技能查询并打开当前[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，仅作背景；字段采用本地固定 0.143.0 生成的 Account/GetAccountResponse/AccountUpdatedNotification、Model/ModelListParams/Response、ThreadRead/Start/Resume/ThreadSettings 和固定源码。

- 固定 ThreadReadResponse 只含 Thread，Thread 有 modelProvider 但没有 model/reasoningEffort，ThreadExtra 是空 record，也没有 thread/settings/read。ThreadStart/ResumeResponse 才有 actual model/modelProvider/reasoningEffort。发现后先回报，协调明确批准：fresh read 只确认原 thread/tree/cwd/provider/idle；同连接使用最近已核对的 start/resume snapshot，冷连接对原 thread 无模型/配置覆盖 resume，actual 必须与持久明确选择相同。不得把 read 填上合成专有模型字段冒充固定接口。
- 固定 thread_processor.rs 的 merge_persisted_resume_metadata 在没有模型 overrides 时采用持久 model/provider/effort，但缺失元数据不能因此推定不发生默认回退。本片要求共享 Session 已有明确选择/实际确认记录；没有记录的旧 Session 和任何实际不一致都阻断。resume 不创建替代 thread，且只在 synthetic entry 执行。
- 固定 Model 区分 picker id 与 native model string，ReasoningEffort 在该版本为 string，不自行增补在线文档枚举。目录没有 provider id：typed Select 必须显式给出 expected provider，不能从模型名猜。start 传 model、modelProvider、config.model_reasoning_effort 和 allowProviderModelFallback=false，并严格核对原生实际回执；不默认选模型、effort 或 Provider。

**本片实现与证据边界**

- Adapter 0.1.5 新 admission.mjs 从原 core/threads/turns 进入，仍只有一个 native App Server 和共享 Host 服务。每份 typed snapshot 带完整 scope/profile/build/generation 与 epoch；Select 另带原 observationScope、catalogHash，过期或其他连接的目录不能复用。原 Configure/Session/Turn 排他、未知占用、interaction 和原身份约束继续适用。
- refresh 首先发 account/read(refreshToken=false)，再读取 model/list(includeHidden=true, limit=32) 全部分页，至多 16 页/512 项且必要投影总计 256 KiB；重复 model id、循环/空前进 cursor、超限/不完整目录和无效字段失败关闭，不把单页当完整。保留 id/native model、display/description、hidden/isDefault、全部 supported/default efforts、inputModalities（固定 text/image）。不声称附件/图片任务已实现；本片发送仍为 text。
- account 类型/认证要求正向校验，完整账号身份只在既有私有缓冲及连接内摘要比较，不投影 email/key/未知字段。公开只含账号种类与 requiresOpenaiAuth，不持久化账号或目录。只有本连接 fresh account/read 的非空原生账号观察才可选模，login completion/credential commit 不直接放行；account 通知、配置尝试、目录内容/映射变化或代次变化撤销选择。账号观察不是凭据、额度或实际模型请求保证。
- 明确选择只接受当前完整目录可见条目和其支持的 effort，保持 picker id 与 native string 分离。新建前重新 fresh account/catalog，再发原生 start；actual model/provider/effort、thread/provider/cwd/idle 一致后才提供登记依据。Host 再核对实际三元组和用户选择，不调用旧 Codex 控制器，也不建 managed Provider。
- 已批准在未安装的 source schema15 内最小扩展现有 shared sessions：新增 nullable native_model_selection_json（8 KiB、有 JSON check、不可变 trigger），无 Codex 私有 Sessions/模型表。typed metadata 记录 Farfold Session、RuntimeBinding、profile、Working Copy/cwd、thread/tree、catalog id/native model/provider/effort。原始明确选择与首次实际确认一致后写入；相同记录可幂等，不得覆盖。元数据写入若失败，Session 仍不可进入任务准入；不宣称两个 store 调用是新的原子事务。RuntimeBinding 仅新增 strict serde 编解码以复用原身份结构，没有复制新的 owner。
- 冷恢复先核对原 shared profile/launch/双 native 身份和 fresh read provider/idle，再从该 Session metadata 恢复明确选择、fresh account/catalog，并对原 thread 无 model/modelProvider/config override 地 resume。actual 与持久 tuple/当前目录均匹配才可继续。冷恢复测试保持原 native 历史字节且不重发；缺失 metadata、default fallback、实际模型或 effort 改变均阻断，生产含认证/历史 profile 恢复仍关闭。
- 每轮 Host 先 fresh account/catalog/read identity/provider/idle，确认原 Session metadata 与原 start/resume config snapshot，之后才向共享 TurnCoordinator 接纳。Adapter 在 turn/start 的 native write 前用完整 scoped ticket 再 fresh account/catalog/read 并比较，不允许配置/交互/Turn unknown 穿过。typed 结构相等不依赖 JSON 对象键序；原 options 数组顺序仍保留。已知 model/provider/effort settings 漂移会同时撤销 actual snapshot；重新选旧值不能恢复旧 snapshot，需要原线程重新确认/恢复。这仍不是 Runtime 内部 CAS 或外部凭据保证。
- per-Turn actual provider/native model 和 catalog id 复用既有通用 turn_provider_bindings 的 native_observation 分支，managed references 为 NULL；原生观察不写 managed verification。该表/输入原本通用，因此没有新增 Turn 模型表，也没有为接 Codex 弱化 Pi 的专属 managed-source 校验。固定 effort 位于该 Session 不可变 metadata，不伪称原 Turn 表新增 effort 列。
- Host 观察后、Adapter preflight 内账号变化的合成竞态证明原生 Turn 不发送；Host 已有 reservation 时对模糊 ACP 错误保留 unknown、不重试。断线、已知交互、Stop、迟到原生回执的旧回归保持，下一轮不会从旧 ACK/账号标签获得准入。

**固定组合**

- Adapter 0.1.5 entry `178045e19e7798c069a775254eaa32a22b3068e3a3d8db8b673bba8c6f8adb5b`。
- admission `8b26fe2184078fd26fe91cfc9b9798733b974ba80c9824325bd3e631b71bc825`；core `f61726d21ae992c7fe9409cacda81794638fdf6e5ac60477b67102e3cc6d31a8`；threads `ccb9a64d786448b519fb36702fa3e77f1514aee39cb6786e3542638b03d52359`；turns `5660670d07ef1574f9b522ac91fbcdcc54dc17bb7a4629eefafb713c4f71e8ff`。
- configure `741efc417116b703686f21da1be10f5fe2f38bb49aa51bd3e3833e119a4cab1f`；events `8b3a557046073a057a87f7ce8641ba452a926f2ab2836795322cada433a433ec`；interactions `6046eaba46f6840eeb634c3cc15e37f9041022f40d821106ff7018b1d0421ed6`。入口/Host/manifest/persisted launch modules 都固定 admission；native 0.143.0 `9070e47d…0766f`、Node22.22.3 `5d9d3872…7cd5c` 不变。

**检查及首次失败，不覆盖失败历史**

- 新 Host admission 最终 **8/8（0.89s）**：完整目录/显式可见选择、无认证/重复/循环目录、actual model/effort mismatch 不登记、不可变 metadata/每轮 native 记录、generation2 exact recovery/原历史无重发、旧无 metadata/default fallback 阻断、catalog/account/read provider/idle 漂移、Host 观察后 Adapter 再拒绝和 scope/profile/tree/worktree 交叉拒绝。
- Node admission **7/7**，与既有 contracts 合计 **23/23**。包括原字段/选项保留、生产零请求、scope/ticket、分页/重复/超限字段、account/login 通知不能授权、同类型账号变化、JSON 键序往返、settings drift 后旧选择不能复活 actual。收尾另加完整 scope 的跨代 ticket 拒绝与 synthetic native turn/start 计数审计，Host 8/8（0.86s）、Node 23/23（87.38ms）、E default 44 passed/3 ignored（12.06s）及 clippy 再通过，production Adapter 未改，因此前述三个固定真实检查证据仍对应同一入口；无审计计数文件明确证明晚漂移分支没有收到 native turn/start，不只依赖空历史推断。
- 最终 E 显式 synthetic/source 加三个真实固定空 profile 集成 **47/47（77.69s）**；固定真实只 account/read、空 thread/list、profile 生命周期及 admission refresh/select/preflight/restore 本地 -32601 拒绝，无 model/list、真实登录、native thread/start/resume/Turn/模型调用。耗时含多次固定大二进制 hash/版本检查，未修改请求超时或加 retry。
- 全 Rust 首轮 **502 passed / 10 failed / 31 ignored**，失败均来自旧 turn_changes 共用 fixture 的 `INSERT INTO sessions VALUES` 仍为 16 值，而新表为 17 列。改为显式原列名时第一次误写 title_version，定向再次失败；核对 foundation schema 后更正为实际 pinned 列，相关 **10/10** 与全 Rust **512 passed / 0 failed / 31 ignored（19.78s）** 通过。仅改 fixture，不改文件审阅生产逻辑。其余 ignored 没有冒充通过。
- 早期编译首次失败：共享 RuntimeBinding 无 Serialize/Deserialize，复用原结构新增 strict derive；测试误用 HostStore.path()（该方法属于别的类型），改用 fixture 已知路径。新冷恢复 fixture 首轮 4/6，原因为 `/var` 与 `/private/var` 目录别名；使用与原登记相同 canonical root 后 6/6。扩展晚漂移测试又揭示 setup 的同类 alias 导致前置拒绝，修正 fixture 并强化拒绝层断言，未放宽生产路径或身份检查。
- 第一次包含旧 Turn 的 E 集合 **20 passed / 16 failed / 3 ignored**：ticket 用 JSON 字符串顺序比较，Rust 对象键序重排导致误拒绝。新增最小 Node 排序回归先失败，再改为完整结构相等；Node 和原 Turn/交互回归通过。后续对 settings drift 做负向检查发现仅撤销选择却保留 actual，旧选择可复活该快照；先记录红色 Node 回归，再在实际配置漂移时同时失效 actual，复跑通过。按 systematic-debugging 技能在已确认边界修复，不重试到绿或降低模型核对。
- 全前端 **61 文件/308**、Pi Adapter **192**、typecheck 通过；clippy -D warnings、cargo fmt、所改 Adapter Prettier、Node contracts 和 git diff check 通过。没有应用 build/签名/安装；测试编译不算产品交付。
- 只读保护核对：formal `c7750c44`、Dev `85e50b52`、D QA `80fc988c`、P6 QA `829c5d91` 不变；D QA 仍 schema14/quick_check ok/5 Sessions/12 Provider bindings/1 change path。未读取/使用此前智谱 Key（只属于 Pi D）、未读取真实账号内容、未迁移已有库或清理用户/QA 数据。

**交接判断**：本片可提交协调复审；通过后可进入有明确开关/未知态的受限普通工作台接线片，先保留合成层验证，不等于可以开放真实任务。生产 admission/login/model/thread mutation/Turn/interaction/steer 仍全部硬禁用，无 env bypass。真实带认证 profile 恢复、真实 Provider/account/model/权限任务、完整能力与 installed E 出口仍须独立验收；旧 Codex 控制器保留且不作为新 Adapter fallback。本片没有普通 Tauri/UI 注册、真实认证/模型调用或安装，下一片不自动开始。

恢复状态补充：metadata-only read 仍允许固定 `idle` 或 `notLoaded`，后者只表示未加载，不能称 idle-ready；冷 resume 的实际回执及每轮 preflight 均必须确认 `idle` 才可发送。E adapter/synthetic 进程收尾无残留。没有重验所有私人历史字节或把 source schema15 当作已安装迁移。

### 2026-09-16 E 普通工作台最小关闭态 facade/state 层（提交复审）

**范围与停点**：admission 经协调独立 Host 8/8、Node 7/7 复审后，本片获准普通工作台关闭态/合成接线，同时明确：若现有 CodexWorkspace 耦合需要实质重写，先止于最小 facade/state 层。本片采用该有限停点，未将完整工作台合同记为完成。既有 CodexWorkspace 的 adopt 依赖旧 NativeSession、正文 reducer 消费旧 codex_rpc envelope、CodexInteractionPanel 内部直接调用旧 reply 命令且以旧 native turns 获取文件详情；将 ACP 假装成旧 DTO 或复制整个工作台均不在本片实施。下一步须复审后分离可复用呈现与 Adapter 操作，而不是另起实验面板。

**已接通与仍关闭**

- 新 `codex_acp/workspace.rs` 和 `host_codex_acp_workspace` Tauri 注册：复用共享 configure::Runtime/AcpRuntime/HostSessionController，读取 HostStore 原 Session/locator 和当前自有连接安全缓存，无 native 请求。目标保留原 runtime binding、Working Copy/cwd、thread/tree；匹配时再用原 launch/profile/generation/原绑定校验。无目标不借用另一条会话状态，错 adapter/缺 locator/错原目标拒绝，未知连接隐藏旧 admission。返回能力全部硬关闭，没有参数、环境变量或 test-enable 开口。
- 同一个 CodexWorkspace 内使用 `codexWorkspaceRoute`：唯一选择依据是保存的 adapter ID，codex-app-server 仍旧 Direct；codex-acp-stdio-v1 只读取新 facade，unknown adapter 不回退。普通新对话默认是关闭的 ACP 起始区，不再借旧连接的 model/catalog/account 开始新 ACP。旧 direct 创建 helper/命令/控制器保留，本片不删除；旧 Session 的原生打开、正文、模型、草稿和操作代码仍原路径。后端 shared host_session_open 提前识别 ACP，调用新 Runtime 的原目标关闭检查，不进入旧 open。
- 复用 Sidebar、WorkspaceHeader、SessionStartPanel、Composer、共享草稿/元数据等既有控件和样式，只有一套 app-shell。关闭原因在现有起始区显示；新建、恢复、设置、发送不可用，ACP 不显示登录 URL/device code/key 表单。已有 ACP 草稿仍可保留，不冒充发出。页面和命令面板的程序/账号入口不会从 ACP 打开旧登录面板。此为 UX 技能驱动的最小复用，非新设计系统或第二工作台。
- 前端 reader 使用 read revision/unmount cancellation，检查原 Session、Runtime binding、scope/profile/build/generation、thread/tree、Working Copy/cwd；同 scoped admission 与 active Host/native Turn 必须属于原目标。切换后的迟到成功/失败丢弃，不尝试旧命令。IPC 错误只呈现固定安全文字，不原样回显。当前 capability projection 再保持全关闭，合成错误宣称 ready 也不变成真实发送入口。
- 安全状态：disconnected/unknown、Configure phase（无临时指令或秘密）、账号未确认、目录未知/失效、已读账号未显式选择、已选择未确认 actual、上次 actual 已确认但生产仍关闭、活动 Host/native Turn 与 stopRequested。缓存不称 fresh admission，登录完成不称账号确认，Stop requested 不称原生终态。状态读取只做选中时的一次安全缓存读取，不宣称实时活动流或自动恢复。无目标 first-use 登录等待、browser/device 具体指令、catalog/model 编辑、ACP transcript、审批/Plan 问题及 reply/Stop/steer 操作 **尚未接入工作台**；所谓 synthetic sendable/steer accepted UI 全流程亦未验收。
- Adapter 0.1.5 及全部 native/module pin 未改，entry 仍 `178045e1…adb5b`。生产 login/model/thread mutation/Turn/history/interaction/steer 硬拒绝保留；本片没有注册这些写命令，没有新的原生启动入口。已授权 headless synthetic 合同仍在既有测试中，但不把它们算成本片 UI 完整验收。

**接口依据**：复查固定 0.143.0 的现有 DTO/source 边界，并查阅 [OpenAI App Server 文档](https://developers.openai.com/codex/app-server/) 的账号通知/登录说明作背景；未引入在线文档新增字段或升级固定 Runtime。`account/login/completed` 与独立账号读取仍分开。没有任何真实网页登录、设备码、Key 或 model/list/模型任务调用。

**检查、首次失败与分层结果**

- 新 Rust workspace **4/4（0.30s）**：无目标不借连接、原 scope/双 native 身份、actual 合成确认仍关闭、只读 open gate、停止后保留原 target 而清除活动态、unknown/错目标拒绝、活动 Host/native Turn 身份和原终态后无 active。
- 新前端 facade **7/7**：原 adapter 路由、全关闭能力、Session/thread/tree/worktree/scope 交叉拒绝、切换/卸载迟到回执、安全错误、账号/目录/选择/actual 分层、Stop 不等于终态。既有认证 contract 3/3 一并定向通过；新工作台 SSR 1/1 验证单 shell/关闭按钮/没有密钥输入或模型目录入口。
- 集中全 Rust **516 passed / 0 failed / 31 ignored（22.70s）**；前端集中当时 **62 files /315 passed**，Pi Adapter **192/192**，Codex Node **23/23**。之后新增 SSR 定向 1/1，最终前端计数见收尾补充。clippy `-D warnings` 通过（7.56s）。未跑 app build、打包、安装或显式真实 Codex ignored 集成；production Adapter 未改，不需把上一片同 pin 的固定空 profile 证据伪装为本轮重跑。
- 本地浏览器 fixture `scripts/fixtures/codex-acp-workspace.html` 使用真实 CodexWorkspace，所有 IPC 均拦截，无 native I/O。新建 ACP 三入口/发送关闭；旧 Direct 从原 shared Session 打开并显示 DIRECT FIXTURE MODEL/原草稿；切到 ACP 只显示原 ACP 草稿与关闭态，不借旧 ready/model。延迟 ACP read→切到旧 Direct→释放迟到 read，仍旧模型/旧草稿；回到新对话仍关闭。合成 IPC 审计显示 ACP 只调用新 read 和共享 draft，旧 host_session_open 仅为 fixture-direct，未调用 authentication/create/model/Turn。浏览器 error/warn 均空；有一张 1280×720 截图目检关闭态，未做安装截图或全视觉验收。
- 首次检查失败：先声明 Rust workspace/tests 模块但测试文件尚未落盘，cargo fmt 因文件缺失退出；补文件后通过。前端错误读取不存在的 HostSessionOpenResult.adapterId，被 tsc 拒绝；已改核对打开回执携带的 shared navigation Session index，不新增假字段。Rust 私密字段测试首轮 3/4：全字符串搜索误把安全 account kind 值 apiKey 命中为密钥字段；核对 synthetic-server 的 `{type: apiKey}` 后改为精确 JSON 字段检查，4/4 通过。SSR 测试运行通过但其三字段 Proxy 与完整 LifeModelWorkspace 的类型断言被 tsc 拒绝，改为完整 typed inert fixture，不改变生产 LifeModel。另有一次 fixture 补丁上下文不匹配（无落盘）和一次浏览器 heading locator 歧义，均按实际文件/DOM重新定位，不记为产品行为失败；调试技能要求的首次失败保留在此。

**保护边界与下一门槛**：未启动/替换四个安装应用，未读写真实认证，未清理历史。只读复查四执行文件 hash 仍 formal `c7750c44` / Dev `85e50b52` / D QA `80fc988c` / P6 `829c5d91`；D QA 库 user_version14、quick_check=ok、5 Sessions/12 turn bindings/1 changed path。Source schema15 只在测试临时库使用。下一步先协调复审本最小层及旧 DTO/交互控制提取边界；之后补完整 mock-IPC 工作台操作，再由用户返回时明确安排真实登录/账号模型选择与权限任务验收、真实 profile 冷恢复和独立安装出口。不能因本片 UI 显示或 headless 合同通过就开放真实功能、删除旧 Codex 或宣布 E 完成。

**收尾新增失败，覆盖本节全量前端最新结论**：新增 SSR 后 tsc 已通过，SSR 1/1、facade 7/7 定向通过；但最后一次完整 vitest 为 **63 files：62 passed/1 failed，316 tests：315 passed/1 failed（8.71s）**。失败是既有 `scripts/provider-probe.test.mjs` managed saved connection 探针，`:76` 对 stdout 当前末段 JSON.parse 得到 `Unterminated string at position 458752`。该测试 helper 对 `output.split("\n").filter(Boolean)` 的所有段立即解析，包括尚未有换行的尾段；bridge:46 则写完整 JSON 加换行，字节流分块不等于消息帧。源码支持测试分帧竞态的判断，但未追加原进程分包采样证明本次全部链路，也未修改 fixture/生产代码。随后仅一次定向复跑 **4/4（3.04s）**，不得写成根因已修复或全量最终绿。已回报协调建议单独批准极小测试分帧修复。当前 Rust 516/31 ignored、Pi Adapter192、Codex Node23、clippy、tsc、选中文件 Prettier/cargo fmt/git diff check 通过结论不变；本片最小层交回复审时保留这一未根治的回归风险。

**随后明确批准的测试基础设施修复与最终收尾**（覆盖上段当时停点，不改写首次失败）：协调确认只修 `scripts/provider-probe.test.mjs` 的 stdout 行读取器，禁止改生产协议、超时或重试。先提取旧解析算法并新增 12000 条合成目录（总长度大于 458752）、每块65536字符、最后才补换行的确定性测试；旧算法第一块即稳定失败：`Unterminated string at position 65536`，1 failed/4 skipped。这证明完整消息尚未到达就解析末段的测试缺陷，不再只依据一次复跑成功。

- 单变量修复：测试专用 BridgeEventLines 保留 remainder，只有遇到换行才解析完整行；完整对象按次序缓存，未完成末行不交给 JSON.parse。stdout 启用 UTF-8 流解码以保留跨字节 chunk 的字符。JSON 坏帧的首个错误保留并在 events()/finish() 抛出，不在异步 EventEmitter 回调中成为未捕获异常，也不跳过坏帧。进程 close 后必调用 finish()；任何非空尾段（即使其本身是有效但未以换行成帧的 JSON）明确失败，没有丢弃或吞错。
- 新增4项确定性分帧检查：大目录无换行不解析、完整前帧与后帧余段共存、非空EOF残片失败、完整坏帧在读取及进程结束均失败。既有4项真实固定SDK/localhost合成Provider探针不改输入、超时或断言。定向最终 **8/8（3.18s）**，红测通过对应的单变量修复转绿；无第二个猜测、无生产 Pi 改动。
- 按协调要求重跑：最终全前端 **63 files /320 passed（12.24s）**，Pi Adapter **192/192（7.75s）**，本片相关 Rust E **48 passed/3 ignored（13.14s）**，tsc、cargo fmt check、受影响 Prettier、git diff check 通过。生产 Rust 未在该测试修复中改变，因此同本片此前全 Rust **516 passed/31 ignored** 与 clippy 通过证据继续适用；Codex Node **23/23**及0.1.5摘要不变。
- 浏览器合成页已关闭，已验证 PID/cwd/命令后仅停止本片1432端口的 Vite；未停止用户其他 Runtime。工作台仍止于最小关闭态 facade/state，不追加登录/目录编辑/正文和审批/Plan/Stop/steer 接线。本节交回复审；真实账号模型与安装门槛全部保留。

### 2026-09-16 E 同一工作台 typed backend/view facade（提交复审）

**范围与结论**：协调通过上一关闭态层后，本片只在现有 CodexWorkspace 内提取小型 typed backend/view facade。`codex-workspace-backend.ts` 机械包装旧 Direct open/create/catalog/submit/steer/interrupt/reply/disconnect 命令；`codex-workspace-view.ts` 统一连接、Session、模型标签、transcript、active Turn、interaction 与 capability 的呈现。唯一 backend 由持久 adapter binding 决定，unsupported/ACP 不回落旧 Direct。没有复制第二页面、reducer 或 InteractionPanel。ACP 仍只有只读 snapshot 与安全事件摘要，全部 mutation capability 为 false；未新增 Tauri 命令或测试开关。

**身份、生命周期与 UI 边界**：每个 Direct 操作先核对当前 Farfold/native Session、generation、active Turn 或原 connection；视图 key 切换、Runtime/Session 变化和卸载使旧异步回执成为 `RetiredCodexView`，不会落到新目标。ACP hook 退出当前读取生命周期时同时取消 pending read 并清除同 key 成功缓存，返回同一绑定必须等待新 read，不先展示旧 snapshot。ACP event 只在完整 runtime/build/connection/generation/scope、Farfold Session、Working Copy、thread/tree、Host/native Turn 全匹配时保留 sequence/kind 摘要，最多 64 条；不把摘要称为完整历史或终态。复用现有 Sidebar、Header、SessionStartPanel、Composer、Transcript 和 InteractionPanel；关闭态按钮具备原 aria-label/disabled 语义，不增加账号密钥、目录编辑或发送入口。该复用取舍按 ux-engineer 技能保留现有设计系统；官方 [Codex App Server 文档](https://developers.openai.com/codex/app-server/) 只作事件/审批背景，实际字段仍以固定 0.143.0 source/schema 为准。

**安全投影首次失败与单变量修复**：新增红测首先证明 ACP pending interaction 被直接映射到共享面板，完整 `nativeRequest` 中的 command/cwd/reason 会进入 React props；第一次仅替换 `request` 后测试仍失败，因为 `pending.codexAcp` 保留同一原对象引用。由此确认根因是 mapper 边界的双引用，而非 Rust 校验或按钮 enabled。最终只在 ACP 关闭态 mapper 创建安全副本：保留 request/thread/Turn/item/method/原始 choice/question identity，`nativeRequest.params` 仅保留 threadId/turnId/itemId，清除 raw command/cwd/reason 与 file path/diff；Direct pending/request 引用与原内容保持不变。失败、第二路径和最终转绿均保留，未通过隐藏测试或修改原协议规避。

**返回同一绑定的旧快照首次失败与修复**：隔离浏览器先打开 ACP、切到旧 Direct，再把下一次 ACP read 故意挂起并返回原 ACP；修复前旧 thread/tree 定义列表立即重现，证明 hook 虽取消 pending read，却保留上一次成功 result。单变量改为 effect cleanup 同时清除该 key 缓存；同序列复跑时只显示“Codex ACP 状态尚未核对”，无原身份/历史摘要，释放新 read 后才显示当前 thread/tree。没有新增 retry、额外 native 请求或 fallback；测试页所有 IPC 仍被拦截，复跑后关闭页面和自有 Vite 1432。

**检查及检查失败**：

- 新 backend/view 专用 **6/6**：ACP 原始 command/cwd/reason/path/diff 不进入关闭 view，共享审批面板只读且按钮禁用；Direct 原 payload/正文引用不变；exact scope/context/native Turn event；binding 切换淘汰迟到 Direct result；ACP 操作零 IPC；错 Session/generation/active Turn 派发前拒绝。与既有 closed facade/contract/SSR 合计定向 **17/17**。另以真实组件 mock-IPC 浏览器完成 ACP→Direct→延迟 ACP read→ACP 的确定性缓存生命周期回归。
- 最终全前端 **65 files / 326 passed（9.96s）**；Pi Adapter **192/192**；Codex Adapter Node **23/23**；E Rust **48 passed / 3 explicit ignored**。本片没有 Rust 生产修改，因此上一片同源码全 Rust 516/31 ignored 与 clippy 证据未被本片冒充为重跑。`pnpm typecheck`、受影响 Prettier、`git diff --check` 通过。
- 新测试首次 typecheck 因 fixture 的 adapterId 字面量被拓宽为 string 失败，改为显式 `CodexAcpScope`，没有放宽生产类型。两份新测试首次 Prettier check 失败，机械格式化后通过。Codex Node 首次使用错误的 `npm --prefix`，因该固定 Adapter 本来没有 package.json 而 ENOENT；核对其 README 后按仓库入口 `node --test test/*.spec-node.mjs` 运行，23/23 通过。这些均为检查/fixture/命令问题，不记录成产品运行失败。

**保护与下一门槛**：无真实登录、Key、device code、model/list、thread/Turn 或外部模型请求；未构建、签名、安装、迁移现有 schema14 数据、清理用户历史或删除旧 Codex。只读复核四执行文件仍 formal `c7750c44` / Dev `85e50b52` / D QA `80fc988c` / P6 QA `829c5d91`；D QA 仍 user_version14、quick_check=ok、5 Sessions/12 Provider bindings/1 change path。Adapter 0.1.5 和固定 0.143.0 pins 未改。判断不是“只待用户登录”：生产 Host 的 authentication、完整 catalog/model mutation、native Session/Turn/history 以及 reply/Stop/steer 工作台接线仍缺，须复审后另开有限片；在此之前不能开放真实账号流程、安装 E 或删除旧 controller。

### 2026-09-16 E typed facade 补完后的独立复核

按协调限定范围复核现有修改，没有重做或覆盖协调补完，也没有新增生产修复。采用 code-review-excellence 的行为/身份/竞态核对：`codex-workspace-backend.ts` 在 Direct Session 操作前核对原 Session/generation，steer/interrupt/reply 保留原 Turn/request；guard 在 await 成功和失败后均核对视图有效期。`CodexWorkspace.tsx` 由持久绑定选路，Direct 继续原 reducer/命令，隐藏 Runtime 的既有 Direct 后台事件仍按原绑定处理，不将其误删为过期 UI 读取。ACP hook 清理读取和同 key 缓存；view 对原 scope/context/thread/tree/Turn 过滤，关闭态交互副本不携带原 command/cwd/reason/path/diff。当前关闭态范围未发现需阻断的新问题；这不是证明未来开放操作已具备完整边界。

- 本轮新跑：7 个前端文件 **25/25**，随后正确定位 `codex-workspace-view.test.ts` 补跑 **3/3**，共 **28/28**；Rust `codex_acp::workspace` **4/4**；`tsc --noEmit` 与 `git diff --check` 通过。首个前端命令误写 view 为 `.test.tsx`，并未执行该文件，因此明确补跑而不把 25 项冒充包含它。两次只读搜索路径不准确，改用 `rg --files` 定位实际 Adapter 与单文件 Rust 路径；没有据此修改产品。
- 覆盖限制：本轮没有重跑完整前端/Pi/Node/Rust 集合、浏览器竞态或已安装验收，沿用上一节对应历史证据而不冒充本轮新跑。没有真实原生请求、真实账号/凭据读取、应用构建安装、现有数据库访问/迁移或旧路径删除；没有重新核验安装文件摘要。
- 对机械包装的限定：Direct create helper 仅做 route/lifetime 检查，仍交原 Host 验证输入；当前 UI `binding=null` 必为 ACP，旧 Direct 新建分支不可达。connection 操作仍传原 installation/generation，Rust `codex_connection_stop` 验证当前连接及代次。不能把这些机械包装说成所有未来输入都已由新 facade 独立验证；若另行恢复新建入口，须先补对应输入与回执合同。

**实际 Host 缺口与待审下一片**：`lib.rs` 的新 ACP 注册仍只有 `host_codex_acp_workspace`；`workspace.rs::require_workspace_open` 解析原目标后明确拒绝，不调用 Direct。`configure::Runtime` 已有内部 start_owned/stop/read/configure 服务，但未形成普通工作台的操作入口；生产 Adapter 的 authentication/threadMutation/tasks/interactions/admission 五个开关仍为 false。因而认证临时指令、完整 catalog/显式模型选择、thread start/resume、Turn/history/event pump、reply/Stop/steer 都不是可操作的普通工作台。

建议下一有限片先做共享 owned connection/profile 生命周期及 Configure 的 typed Host 分发与合成 IPC 合同，复用原 Runtime/HostSessionController，不另建状态机；先确认完整 scope/lease、取消/迟到回执/秘密通道，再接后续目录与任务。需要协调明确授权的新边界是 **Rust 生产 Host 操作 facade/命令注册**，不是允许真实认证或启用 Adapter：普通生产命令仍先硬拒绝，测试仅使用注入的无网络 synthetic 实现，不提供环境变量或前端开关绕过。若该片必须改 Adapter pin/schema、开放原生启动或读取真实 profile，则先报告，不能用本建议推定批准。当前没有实施此建议，交协调决定；后续真实账号与安装出口仍独立保留。

### 2026-09-16 E typed Host operation / Configure 有限片（提交复核）

协调明确批准本片后先同步 AGENTS/PRODUCT/唯一计划。新增 `codex_acp/operations.rs` 及唯一 Tauri 注册 `host_codex_acp_operation`，未改工作台动作。复用原 Runtime、HostSessionController、AcpRuntime 和 Configure occupancy，不增加连接/认证状态机或第二 Provider 表。

**实现与分层**

- 输入为严格 typed restore / stop / configure envelope；外层先接 JSON Value，在无条件生产 gate 后才反序列化，避免未知枚举值或原错误回显秘密。生产 gate 在 app.state、DB/profile lookup、spawn 和任何 native 请求之前返回固定 `unavailable`，包括故意携带 enabled/test 字段及不合法 envelope。唯一允许分发的 Entry::Synthetic 编译于 cfg(test)，不是环境变量、Tauri 参数或 UI 开关。
- restore 只接受完整旧 Scope 和 WorkingCopyId，从既有 shared owned launch metadata 找回原路径，客户端不能提供程序/目录/native args。校验原绑定、profile、代次、Working Copy、home/runtime_home 和 Adapter 版本，进入原 Runtime.start_connection 排他操作后调用已有 profile.prepare / Connection.start_inner 路径。新增 prepare_restore 在原 lease 取得后、generation reserve 前再次核对原保存 metadata 与 expected generation，防止等锁期间旧目标过期；lease 仍由原 Connection 持有，不另建锁或注册表。原 start_owned 的既有 prepare 行为保留。
- 本片只接**已登记 owned profile 的恢复**，没有增加 first-use profile 创建、注册安装选择或默认用户 profile 导入。scope 返回的新 generation 必须比请求代次大，其他完整身份必须一致。实际启动分支未执行；同原 lease 的原生 restore 不是本轮验证结论。
- stop 调用原 scoped Runtime.stop，configure 原样传递现有 browser/device/key/logout/status/cancel 命令与 operation/login IDs；不发明回执、回滚或终态。连接 stop 不是 Turn interrupt。Configure 回执只走私有命令响应，临时指令不进入事件/DB/日志；下层错误在新 IPC 边界映射为固定 `unconfirmed`，不等于 not-sent 或可重试。Account/credential Unknown 快照保持原未知语义，迟到旧 Configure 回执不能应用到重连后的代次。
- 依 openai-docs 要求查阅 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 的背景合同，并核对本地固定 0.143.0 对应的既有 Configure 实现。没有新增原生字段或改 Adapter 0.1.5；生产 authentication/threadMutation/tasks/interactions/admission gates 与全部固定摘要不变。

**新检查、首次失败与修正**

- 新 operation 合同 **8 项**覆盖：生产门禁不解析/不获取服务（执行闭包若触发即 panic）；严格 JSON/错误脱敏；共享原 profile/代次/Working Copy 解析及跨身份拒绝；合成 restore 回执身份；browser/device 私有指令、占用/错 operation/错代次拒绝和取消；Key 取消晚提交仍 Unknown；实际 synthetic native 错误保持 Unknown 且不泄漏；Stop/重连期间迟到 Configure 回执失效。Configure/stop 通过既有无网络 synthetic Adapter/App Server 的真实 stdio IPC 分发；restore 是元数据/分发合同与既有独立 lease 合同，未执行固定真实启动。Tauri 注册经编译，未做已安装 UI/Tauri 端到端调用。
- 第一轮 **5 passed/1 failed**：新 key-cancel fixture 用任意 SECRET-FIXTURE，而既有模拟服务只接受 SYNTHETIC-ONLY；核对 `synthetic-server.mjs` 精确分支后只修 fixture 标记，6/6。该失败不是生产认证问题。同期非测试编译有两个 unused variable 警告：直接 match 唯一 Production 变体 return 后，余段被判不可达；将同一无条件门禁提取为 Entry::admit()?，去掉 unreachable_code 抑制，后续无警告。
- 扩展 native-error 测试后的 E 首轮 **55 passed/1 failed/3 ignored**：测试错误地等待 Rust Err，实际固定 Adapter catch 会返回 typed Unknown snapshot，因此等到测试期限。源码追踪确认该合同后，改为断言 phase/credential Unknown、account Unconfirmed、无 secret 与后续 mutation 拒绝；不改 Adapter、不放宽 Unknown、不增加重试或延长超时。一处修正补丁因格式化后的上下文不符未落盘，读取实际区段后重作。按 systematic-debugging 保留这些首次失败，不把复跑到绿当根因证明。
- 最终 E Rust **56 passed/0 failed/3 ignored（13.42s）**；3 个固定真实 Runtime 检查未运行。前端本片未改，仍定向核对原工作台 backend/view/closed read/contracts/SSR **5 文件17/17（2.84s）**。`pnpm typecheck`、`cargo clippy --locked -- -D warnings`（10.22s）、cargo fmt check、git diff check 通过；profile 原测试新增 stale-generation / metadata-change 复核断言并包含于上述56项。没有跑完整 Rust/前端/Pi/Node 全集或应用 build。

**保护与下一停点**：未使用此前 Pi 的智谱凭据，未读取真实 profile/认证，未执行真实 native launch/login/catalog/model 请求，未构建签名安装、访问迁移既有数据库或删除旧 controller。只使用临时测试库；未重验安装文件摘要，不把旧核验当本轮结果。收尾查无本片 synthetic Adapter/Server 进程残留。

本片已交协调复核，尚未开放下一片。剩余包括首次 owned profile 创建/安装解析、生产门禁开放前的异步调度与真实 profile 恢复审查、临时认证 UI/生命周期、完整 catalog/明确模型选择、native thread/Turn/history/event pump、reply/Turn Stop/steer 普通工作台接线。真实用户登录、权限任务、冷恢复及独立安装出口仍是后续门槛；不能因命令注册或56项合成/source测试宣布 E 可用。

### 2026-09-16 E Configure 私有 UI/client 合同（提交复核）

Host operation 经协调独立8/8复核后获准本片，先同步三处范围；本片未改 Rust、Adapter/schema/pin 或生产 gate。新增 `codex-acp-configure.ts` typed client/私有视图寿命 owner；原 `codex-workspace-backend.ts` 增加 Configure 原 scope/原绑定/迟到回执包装。现有 CodexWorkspace 内仍按唯一持久 Adapter binding 选路，通过原 CodexConnectionPanel 的 ACP 分支使用 `CodexConfigureSection`，复用 ProviderAuthPrompt 密码输入和原认证样式；旧 Direct 分支只机械提取为内部组件，原状态/命令不变。按 ux-engineer 保持单一工作台与组件体系，不复制页面或正文 reducer。

**已经接通的合同**

- Browser/device/API-key/logout/status/cancel 使用唯一 typed Host Configure envelope；status/cancel 只取私有回执里的原 operationId/loginId，不接受 UI 拼接新的控制目标。全 scope、正整数操作 ID、原登录 ID、phase/account/credential 值及 browser/device 指令类型校验；URL 仅接受指定官方 HTTPS host、无账户密码/非默认端口，验证码有界。投影仅保留已验证字段，不把原始 payload 放入 shared view、事件、草稿或数据库。
- 私有 owner 仅保存回执和请求寿命，不拥有 native state machine 或新登录ID分配。Key 在既有 password/autoComplete=off 控件中暂存，提交立即清空并撤掉输入，owner 不把 Key 放进状态；指令仅为文本 code，不创建跳转链接或调用 opener。错误只显示固定未知提示，不回显原始错误。未实现自动轮询或重试，状态核对是显式操作。
- 发出 cancel 前立即撤掉 URL/code，不冒充原生 canceled；未知结果清空指令并阻止新认证尝试。原确认/取消/失败终态、Unknown 与 canceling 不能被同一 operation 的旧 waiting 回执复活；旧已完成操作也不能豁免新操作的账号/凭据确认校验。过去 confirmed 标签明确说明模型/任务未验证。
- 视图离开、同一绑定重新进入、scope/连接代次改变，会卸载私有 owner 和输入控件，失效 pending revision 并清空成功缓存；旧成功/失败回执不能回到新视图。撤销仅是本地清理，不发送自动取消、更不宣称原生认证已取消或凭据回滚。离开后原 pending Configure 的重新附着/操作发现仍未接：后续需要原 Host 新鲜状态与 occupancy 核对，不能仅由空白新面板推定可新建认证。

**生产关闭与 mock 边界**：普通 Workspace 的 ACP configure capability 仍为 false，原账户面板只呈现关闭说明，没有任何登录/Key/URL/code 控件。typed client 的存在不是生产 enable；Rust 唯一命令仍在任何副作用前硬拒绝。`scripts/fixtures/codex-configure.html/.tsx` 单独静态提供 mock port，并用 mockIPC 拦截所有调用，才可演练真实组件；该测试文件不被应用导入，无环境变量、查询参数或生产开关。fixture 审计只记 action/合成generation/operationId，不记 key、指令、原 args 或错误。

**确定性失败与检查**

- 首轮新增 client 测试 **7 passed/2 failed**：确认“new operation 借 previous terminal 免检”与“取消/Unknown/终态之后同 operation waiting 指令复活”。按 systematic-debugging 核对固定 Adapter Configure 行为后，在 receipt validator 限定同 operation 才可沿用过去终态，阻止撤销后的旧 phase；9/9 转绿，无 Adapter/协议/Host状态机修改。
- 新 client 9项、原 backend 新增2项、账户组件 SSR新增2项，合计新增13项。覆盖完整scope字段、op/login交叉、首次loginId暴露、恶意URL/错误指令类型、cancel立即撤回、Unknown不自动重发、离开/回来后的迟到成功失败、生产端口零IPC、原注册命令精确输入和密码不留私有snapshot。当前相关六文件定向最初21/21，后补backend2项随最终全量一起通过。
- 真实组件 browser mock：网页等待、挂起cancel时地址即时消失、释放后显示“已取消；凭据仍需核对”；设备验证码等待→状态失败清空验证码/地址且不显示原错误；挂起开始回执→切换代次→释放旧回执没有旧指令；同代次离开→回来→释放旧回执仍为空；占位Key提交即清空且只显示未验证能力，退出账号不推定任务ready；未提交占位Key离开再返回后 input 为空、type=password、autoComplete=off。全程原生产面板能力全false且没有认证控件，未导航到任何外部认证页。
- 截图初检发现新按钮裸文字落入既有 auth-methods 的34px图标列，窄列折行；核对既有样式/组件结构后补相同图标+span双列结构，并为临时长URL允许折行。复截确认按钮正常，未改全局CSS。此为 scoped组件结构修正，不是完整视觉/安装验收。
- 原普通工作台 fixture 亦复查：新ACP仍关闭，旧Direct继续显示 DIRECT FIXTURE MODEL/原草稿，切回ACP只显示原ACP草稿/未确认模型/关闭态，不继承Direct readiness。两测试页 console error/warn 均空。测试页已关闭，确认本片 Vite1432 PID/cwd/命令后仅停止自有服务，不动其他应用。
- 最终全前端 **67文件339/339（12.50s）**、`pnpm typecheck`、受影响 Prettier、git diff check通过；Host operation **8/8（0.40s）**复跑，确认生产gate未变。本轮未跑全Rust/Pi/Node或app build，未把上片56项/3忽略证据当作本轮重跑。无真实认证/native/profile/模型/目录请求、秘密读取、安装、现有库迁移或旧controller删除。

**准确剩余工作**：本片把展示/私有响应/操作身份合同接进既有组件，尚未提供可用认证产品流程。首次profile/安装解析、真实restore、异步生产调度、视图返回后pending Configure重新附着及指令的用户在场流程、catalog/显式选模、thread/Turn/history/events、reply/Turn Stop/steer仍需后续片。尤其生产开启并非删除一行 gate 就完成；先复核上述完整入口和身份/未知边界，再安排真实用户与安装验收。本片到此提交协调复核。

### 2026-09-16 E 同进程 Configure 发现与重新附着（提交复核）

上片经协调独立15/15复核后，明确批准本有限片。先同步三入口范围并按 systematic-debugging 添加返回/竞态红测，再扩展已有私有操作 facade；ux-engineer 要求沿原账号面板与样式，只补核对中/在途显式重查，不另建认证页或状态权威。

**实现与边界**

- Rust `configure::Runtime::discover_configure` 在既有 HostSessionController 与连接锁下读取 `control.flow`，由既有 expected_account/device 精确映射 browser/device/api_key/logout，返回 scope、原 operation/login ID、phase、inFlight。没有新 Flow、状态表或认证历史；不返回账号、URL、验证码、凭据或原始错误。无 Flow 但共享占用仍在、未知元数据组合、缺失或非法身份均拒绝。发现不发 native 请求，不改变占用；原 configure 继续决定开始竞争。
- `operations::Input::DiscoverConfigure` 复用唯一已注册命令与既有固定错误边界；Production 在反序列化/服务/存储/启动之前硬拒绝，合成派发仍仅 cfg(test)。Adapter/协议/schema/pin 不变。
- 前端端口与 backend 复用原全 scope/绑定和 view lifetime 检查；私有 owner 初始 checked=false。进入视图先发现：Host 明确无操作才可接受新用户动作；发现已有操作则按原 op/login 发 status，fresh 回执校验后才显示指令/终态。不保留旧URL/code，不从旧终态或空前端推导当前认证成功。操作类型来自验证后的 Host 元数据，不默认 browser。
- 在途发现不并发发 status，不开放新开始；用户可显式重新发现。Unknown、错误或无法确认身份保持关闭，不自动重试。离开/代次变化清空私有状态并撤销请求寿命；迟到发现和 status 回执不能复活。发现到开始非原子，最终仍由既有 Host Configure occupancy 排他拒绝。
- 生产 capability 全false，组件没有认证控件；只在独立静态 mock fixture 演练控制。没有进程重启/首次profile/真实cold restore，没有秘密、指令、发现元数据的事件/草稿/DB持久化。

**测试、首次失败与限制**

- 首先新增前端10项红测：一项直接证明旧空视图仍发 browser（应为0次，实为1次），其余确认 discovery 方法缺失；Rust新facade发现测试返回 InvalidRequest。实现后相关4文件26/26通过。随后补全scope、在途显式重查与首次原生login ID：两个负向红测分别发现 discovery confirmed-null、fresh confirmed-null 未拒绝，按既有Host Snapshot的browser/device身份约束补齐；未改Adapter接口。
- 最终新增前端13项（总68文件 **352/352，19.71s**）；backend同步覆盖发现scope错配、唯一命令与迟到发现退休，既有Configure路径仍有私有owner和原scope检查。typecheck、受影响Prettier、Rustfmt、git diff check通过；`cargo clippy --lib -- -D warnings`通过（10.93s）。
- Rust新增3项：共享私有发现/无操作后竞争/原设备status、后台完成与终态原身份/跨代拒绝、cfg(test)原Flow在途/Unknown/类型及占用缺失拒绝。Host操作最终 **10/10（0.49s）**；Configure **8通过/1显式忽略（0.61s）**，末次新增身份断言后发现用例再单独 **1/1（0.13s）**。使用原合成stdio Adapter/Server与临时数据，3个固定真实Runtime ignored未执行。
- 扩大 E Rust 首跑为 **58 passed / 1 failed / 3 ignored（14.08s）**。唯一失败是未修改的 `profile::tests::owned_directory_and_lease_reject_alias_permissions_and_concurrent_launch`，在 `drop(first)` 后 `lock_profile(root,false).unwrap()` 报 `Owned profile already active or launch lock unsafe`（tests.rs:140）。只读核对该测试和既有 lock_profile 的权限/flock 合并错误后，精确单测诊断复跑1/1通过；尚无errno/持锁者证据，根因未知，不推断已修复，不改锁语义，不循环全套直到绿。本片不能写为E整套无失败。
- 真实组件 mock 验证：设备认证离开后清空指令；挂起返回发现期间全部新认证按钮关闭且无旧码；释放后审计只有 discover→原status、operationId保持1，无第二次device。离开后模拟后台完成，返回只核对原终态/撤下code，标签仍明确模型任务未验证。挂起新browser回执期间离开/返回只显示在途，释放旧回执后仍需显式重查；随后查询原operationId2。挂起旧发现→代次2→释放旧发现不出旧指令。返回发现失败显示固定Unknown，控件关闭，不回显synthetic错误。
- 截图确认沿用的面板/按钮/Unknown布局无新折行问题。改源码期间旧fixture发生两条HMR重复createRoot日志；整页重载后再用新标签页跑原设备返回流程，warn/error为空。这是开发fixture热更新观察，不是已安装应用证据。所有外部认证URL仅作为文本，未打开/导航。

**保护与后续**：没有使用Pi的智谱Key，未读取真实profile/账号/凭据、发真实native/model/catalog请求、构建/安装应用、迁移现有库或删旧controller。本片完成后提交协调复核；首次profile/安装解析、真实restore与异步调度、目录/显式选模、thread/Turn/history/event pump、reply/Turn Stop/steer仍需后续有限片，用户在场真实认证与安装出口独立保留。既有lease失败记录保留给协调评估，不隐去或宣称根治。

### 2026-09-16 E lease 单测并发继承诊断与夹具隔离（提交复核）

协调只批准有限诊断：保留原58/1/3，先取得分支/errno/持锁者证据，不循环刷绿、不显式unlock、改timeout/retry或削弱锁断言。确定性夹具缺陷可最小修复；生产安全语义变更须先回报。协调期间另独立复核前片frontend27/27与源码，无新阻断，不推定Rust集中已绿。

**事实和假设分离**

1. 原失败位于 `drop(first)` 后立刻重获原锁；`lock_profile` 原错误合并了 regular/nlink/uid/mode/flock，现场无errno或child PID。之前孤立单测通过不证明根因。按 systematic-debugging 先保留所有元数据检查的原短路顺序与同一次非阻塞flock，将结果分出变量；只有cfg(test)记录无路径的inode/dev/uid/euid/mode/nlink/FD/FD_CLOEXEC/flock结果，并在任何后续系统调用之前取errno。生产错误字符串、锁次数、非阻塞、权限/身份检查与返回语义未改，没有显式unlock。
2. 查本机Rust1.96.0源HTML（std/sys/process/unix/unix.rs）确认spawn先尝试posix_spawn；存在pre_exec或PATH修改且裸程序名时回退fork。E合成attach默认裸node、env_clear并设置PATH，公共AcpTransport设置process_group与stdio；另有ACP terminal的pre_exec路径，但未把它冒充原E现场调用。[Rust官方CommandExt](https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html)和[Apple flock手册](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)支持fork描述符共用锁引用的语义；官方背景不是原失败PID证据。

**一次受控窗口探针**

新增显式ignored测试 `lease_probe_pre_exec_inheritance_has_exact_errno_and_owned_fd`，只创建临时锁并启动自有 `/bin/cat`；pre_exec只调用async-signal-safe的fcntl/write/poll/read，以socket握手固定fork到exec窗口，并设3秒诊断清理上限（不是增加产品timeout）。父进程记录后释放窗口，关闭自有cat stdin并wait；不kill用户进程。

- 本次parent85501、child85502，原锁inode60660279。FD3的FD_CLOEXEC=1；parent drop后原production lock_profile重获返回flock=-1、errno35（EWOULDBLOCK）；元数据regular=true、nlink1、uid/euid501、mode33152（regular0600）、device16777229，均合法。
- 仅按已知childPID和已知临时锁文件筛选lsof，确认child85502的FD3仍指向同inode。没有全盘profile、用户进程FD或凭据扫描。
- 放行exec后，cat仍活着等待stdin，而相同inode可获（flock0、errno空）；随后正常退出。本探针1/1（0.04s）。这确定性证明CLOEXEC在exec前不会消除子进程继承引用；并未捕获原58/1/3现场的具体child。

**一次固定普通spawn样本**

`lease_probe_bounded_ordinary_spawn_overlap` 固定128样本、四个预先固定的调度偏移0/10/50/100微秒；每样本只有一次parent drop后重获，不重试到成功。并发线程用与公共transport同形的process_group0/stdin与stdout管道/stderr null，执行绝对路径 `/bin/cat`，没有pre_exec、没有真实Runtime。每次关闭stdin/wait退出后再进下一固定样本。

本次204ms，15/128重获返回errno35，所有元数据仍合法、FD_CLOEXEC=1、同临时inode60660347。失败样本17/29/30/46/49/51/54/62/90/94/98/110/114/118/126；不把15/128解释为稳定失败率。本探针断言已观察失败必须为EWOULDBLOCK，但不要求调度概率；它是诊断，不是概率性功能验收。两探针保留显式ignored，均本轮各执行一次，不加入常规并行全集。

**最小夹具修复与回归**

- 已证明缺陷是原单测共享进程的“drop即最后引用消失”前提不成立。只让原 `owned_directory_and_lease_reject_alias_permissions_and_concurrent_launch` 用current_exe启动exact同名单测、test-threads=1，锁在fresh exec后才创建。重入标记仅cfg(test)代码读取；不开放产品测试门禁。父进程核对成功且stdout确实为1 passed/0 failed，避免未来名称改动导致0项静默成功。
- 原测试的第二次并发获锁必须失败、drop后必须成功、目录0755拒绝、alias拒绝、missing拒绝全部保留，未加入等待/重试/显式unlock。隔离的目的只是避免同测试进程内其他fixture的并发spawn继承它的FD。受控探针保留原未隔离窗口证据，不把生产短暂拒绝改成成功。
- exact修复测试1/1（0.01s）；一次扩大E回归 **59 passed / 0 failed / 5 ignored（14.15s）**。5忽略=原3个固定真实Runtime检查+2个明确opt-in诊断，不是把原失败改为ignored。之后补父进程确实执行1项的核对，再精确检查原测试；未循环扩大E套件。
- `cargo clippy --lib --tests -- -D warnings` 发现既有 `codex_acp/threads/tests.rs:454` 的 cloned_ref_to_slice_refs警告（`assert_eq!(listed.data,[started.clone()])`），本片未改该文件、不加allow、不声称test lint全绿。生产lib Clippy和最终exact检查另见收尾；Rustfmt/diff检查通过。未重跑未变化的前端352项或Pi/Node全集，不冒充本次证据。

**结论与限制**：继承引用导致测试前提失效的机制和普通并发spawn复现已证实，夹具已隔离并回归；原历史现场具体持锁PID/确切spawn调用未捕获，不能据此根治所有历史启动/锁观察。生产lease仍同样fail-closed，本片没有“瞬时重获必成功”的新产品承诺。若后续要改变产品释放或重获语义，应作为生产安全决定另行评审。没有真实profile/凭据/现有数据库读取、native/model调用、安装、用户进程终止或新功能；自有探针cat均关闭stdin并wait，查原PID和synthetic进程无残留。

收尾：父进程加入“实际执行1项”核对后的exact单测 **1/1（0.02s）**；`cargo clippy --lib -- -D warnings` **通过（0.33s）**，最终Rustfmt/diff检查通过。测试专属Clippy的既有警告仍保留，未修改无关threads测试。上述59/5回归是夹具修复后唯一一次扩大E执行，不以收尾exact检查重写原58/1/3历史。本有限诊断到此回报协调。

### 2026-09-16 E admission Refresh/Select 私有接线（提交复核）

lease夹具经协调精确1/1复核后，获准本有限片：只将既有 admission 的 Refresh/Select 接入同一 typed Host operation facade 与现有工作台模型字段，合成/mock贯穿；生产门禁不变。先同步三入口范围，按 ux-engineer 复用原控件体系，不复制工作台或建立另一套 Provider/状态权威。

**Host、视图与身份边界**

- `admission::ViewCommand` 严格反序列化，仅 Refresh 和 Select；原内部 Restore/Preflight 仍不对外开放。Select 必须携带原 observation scope、epoch、catalog hash 和完整 catalog ID/native model/effort/expected provider。复用既有 Runtime admission、HostSessionController 和 Configure occupancy，在同一连接锁下核对、撤销旧可用性并取得原操作占用；没有新的 Provider 表或持久状态。
- 原 scope 错配不能触碰另一个连接。正确 scope 的视图操作先清当前 admission；Configure pending、in-flight 或 Unknown、未知/活动 thread/Turn、原目录缺失或身份不匹配均拒绝。新增检查覆盖已释放旧 occupancy 但 Configure 仍 Unknown 的情况。Select 禁止修改已绑定 native Session；原 immutable Session selection 保持不变。
- Select 前核对认证观察、可见且支持文本的 catalog 项、native ID 和支持的 effort；回执必须仍匹配原 scope/epoch/hash/完整 catalog/account 与明确预期的整个 selection。预期 provider 是用户显式输入，不冒充目录已证明或 native actual 已确认。返回投影只有 scope/epoch/account/catalog/hash/selection，**无 actual、thread 或任务就绪证据**；Refresh 强制 selection=null，不能恢复旧选择。
- 前端 `CodexAdmissionPrivateView` 只管理当前视图请求寿命和已验证投影，不拥有 native 状态。完整 scope、账号类别、目录上限/唯一ID/字段、hash、effort/native/provider 均校验；拒绝任何 actual 字段，拒绝 epoch 回退和同 epoch 目录/hash/account 变化。提交先清可用快照，失败显示固定提示且无自动重试；晚回执在离开/代次改变后丢弃。
- 原 model/effort JSX 机械提取为 `CodexModelFields`，Direct 原默认 effort 行为不变；ACP 不自动选择 effort，需明确选择模型、effort 并填写 expected provider。`CodexAcpModelPanel` 在生产仅呈关闭说明，mock 才有控件；已绑定 Session 只能 Refresh，不可改选。Configure 操作撤销旧模型私有视图，避免认证变化后恢复旧选择。仍由原 backend 完整 scope/持久 binding 检查守卫，没有 Direct fallback。

**确定性检查与首次失败**

- 首个 Rust public admission 红测返回 InvalidRequest，证明 facade 当时未注册新合同。首个前端运行因新模块尚不存在而无法导入，执行0项断言，不能称行为红测；实现后相关检查通过。
- 后补 epoch 回退/同epoch hash变化红测出现 **11通过/1失败**，确认视图缺少单调新鲜度检查；补足后本文件 **12/12**。加共享字段/生产关闭 SSR **2项**，本片前端净增14项；backend 原用例扩展原scope与唯一IPC输入检查。最终全前端 **70文件366/366（16.12s）**。
- Rust新增 public operation **3项**：原完整目录明确选择及身份负例、已绑定 Session 不变及 Configure 占用、目录过期/失败清缓存。既有 Configure 测试补 Unknown 即使旧占用结束仍拒绝 admission。扩大 E 首次 **61 passed/0 failed/5 ignored（15.07s）**，发生在第三项操作用例加入之前；5忽略为原3项真实Runtime检查与2项opt-in lease诊断，本片均未执行。第三项加入后 operations **13/13（0.50s）**。
- 严格生产lib Clippy 首次指出两处新增枚举大变体：ViewCommand Select 对 Refresh，operation Admission 对 Configure。分别装箱 Scope 和 ViewCommand，不改 JSON 合同、不抑制 lint。最终 `cargo clippy --lib -- -D warnings` **通过（10.90s）**；装箱后 operations **13/13（0.51s，编译13.40s）**。未将之前扩大E结果当作装箱后全套重跑。前片 test-Clippy 的无关 threads/tests.rs:454 警告未改，本片未重跑 test-Clippy。
- `tsc --noEmit`、受影响 Prettier、Rustfmt 和 git diff check 通过。未跑全Rust/Pi/Node或构建安装，不把历史结果当本轮验证。

**真实组件的静态 mock 检查**

- 现有 `codex-configure` fixture 拦截唯一 typed IPC，无真实 native/网络调用；新 mock 目录2项只呈现1项可见模型，隐藏项不进入选择。先 Refresh，选模型后 effort 仍为空；显式 effort/provider 后确认，文案明确实际模型与任务能力未验证。生产对照面板始终无可操作模型/认证控件。
- 模拟目录过期后 Select 拒绝：目录和成功标签立即清空、字段关闭、固定错误且不自动刷新。挂起 Select→换代→释放不出现旧目录/选择/provider；已绑定 Session Refresh 后展示只读说明，选择字段关闭。启动 pending Configure 清旧模型视图，其间 Refresh 拒绝且不恢复旧目录。
- 原普通 workspace fixture：ACP 显示关闭模型面板、发送禁用；旧 Direct 仍为 DIRECT FIXTURE MODEL/medium、原 DIRECT DRAFT 和既有 ready；返回 ACP 仅原 ACP DRAFT、模型未确认/关闭态，未借 Direct ready。两页新鲜检查 console warn/error 均空；截图核对字段、说明及按钮无重叠。本片无截图交付或已安装UI验收声明。
- 首次自动化 label locator 未匹配控件，读取实际 DOM 后按 combobox 角色定位完成；这是定位调用失败，不是产品行为失败。没有导航外部认证页，没有读取或使用此前 Pi 智谱凭据。fixture 审计只记 action/generation/operationId，不写 provider、秘密、原始参数或错误。

**保护与停点**：未改 Adapter/schema/pin，生产 Host gate 仍在反序列化/状态访问前无条件拒绝，Adapter gates/UI capabilities 仍关闭。只使用现有 synthetic adapter/server 和临时测试库；没有真实profile/认证/目录/模型/任务调用，未访问迁移现有数据库、构建替换应用或删除旧controller。私有目录选择不是 native actual、Thread/Turn preflight 或 installed E 出口。首次profile/安装解析、真实restore/异步调度、native thread/Turn/history/event pump及reply/Stop/steer工作台接线仍待后续有限片与用户在场验收；本片完成提交协调复核，不自行推进下一片。

收尾：本轮自建两张测试页已关闭；核对 PID86767 的 Vite1432 命令及本仓库 cwd 后只停止该自有服务，复查进程消失，未动其他应用。未发现 synthetic Adapter/Server 残留；三入口和本记录同步后 git diff check 通过。

### 2026-09-16 E Session facade 预查：原子登记失败门槛（停止接线并报告）

协调独立复核前片 frontend19/19、operations13/13后，批准仅synthetic新Session/原绑定open的窄facade贯通，明确：必须携带本次显式选择，不借Adapter残留selection；路径/身份由Host共享元数据取得；若既有接口不能保证原子登记/失败恢复，先确定性测试并报告，不扩成新状态机。先同步三入口，再读现有threads/register_thread/open_registered_thread与共享store。

**已确认根因**：`threads::register_thread` 先调用 `register_owned_session_with_native_locator`；其共享 `register_session_internal` 在自己的Immediate事务里提交Project/WorkingCopy/Session/locator。返回后另调用 `record_session_model_selection`，重新核对target，再用另一次数据库访问执行UPDATE。两次持久操作不在同一事务；第二步的Err直接返回，未设置threads.unknown或保留登记占用。此前成功native Start已经complete操作并留下bound/actual。因此“函数返回Err”不能表示未登记，也不能表示登记结果已由现有unknown占用保护。原native身份并未丢失，但部分登记的失败恢复边界未实现。

**确定性回归**：新增 `threads::tests::session_registration_model_write_failure_must_not_commit_partial_identity`。只在tempfile目录初始化临时Host库、原synthetic adapter/server和已登记owned连接；以原Refresh/Select与Start建立合成thread，不跑真实Runtime。SQLite测试触发器仅阻止 `native_model_selection_json` UPDATE，不修改生产schema或添加生产注入。然后仅调用一次register_thread，取得固定错误 `Cannot record original Session model`。

测试读回确认Session target/native thread/tree locator仍在，selection缺失，原bound身份相同；unknown=false、operation pending=false。在安全断言前正常Stop自有合成连接，避免红测遗留子进程。要求不得提交部分身份的断言确定性失败：**0 passed/1 failed/0 ignored（0.18s，编译10.92s）**。保留红测，未改为ignored/描述性绿测，未循环重跑到绿、未重试start/register或删除已生成身份以伪装成功。

按systematic-debugging先取因果证据，遇授权指定门槛后暂停实现。未注册新Session命令、未接backend/UI、未修改任何生产逻辑、Adapter/schema/pin或旧controller。本片仅测试与四份文档变更；此前Refresh/Select实现保持原样。旧正常共享登记/冷开/locator导出删除用例另精确 **1/1（0.55s）**；原operations **13/13（0.47s）**，不抵消新红测。Rustfmt/diff检查通过，合成进程无残留；未运行全Rust/前端/Pi/Node、Clippy或应用build，不将历史验证冒充本轮。

**待协调决策**：建议下一最小修复评审仅围绕既有共享登记事务纳入不可变model selection，以及native已start但Host登记失败时保留原bound身份并关闭后续操作的边界；不得在失败后创建新thread、自动重试、靠删除数据补偿或引入另一个Session状态机。是否允许修改共享store及既有unknown处理须先明确，再让同一红测及失败隔离/原身份恢复合同验证。当前没有声称facade已完成、生产可用或安装出口。首次profile/真实restore/异步调度等原后续缺口仍保留，未触及真实账号/凭据/目录/模型/数据库/应用。

### 2026-09-16 E 共享原子登记与失败隔离修复（提交复核）

协调独立复现上述精确红测0/1并核对两个提交点，批准最小修复而不是Session facade扩张。先同步三入口新授权，按systematic-debugging沿原失败因果边界修复；历史红测、unknown=false/pending=false与部分落库记录不抹去。

**实现**

- `HostDatabase::register_session_internal` 只增加可选immutable selection参数；旧无selection登记API均传None并保留String错误与原返回语义。Codex经窄 `register_owned_session_with_native_model` 进入同一Immediate事务：既有owned profile/原scope/generation及launch WorkingCopy检查、Project/WorkingCopy、Session/locator写入、model验证和写入，全在commit之前。没有新表/schema、第二事务管理或登记状态机，也没有失败删除补偿。
- 将既有Session target SQL读取机械提取为 `read_target_from_connection`；普通open仍在Deferred读事务后按原逻辑补Direct安装binding。事务内model helper读取刚写入的共享target，复用完整SessionModelSelection.verify（全runtime binding/profile/WorkingCopy/cwd/native thread/tree/非归档），再检查原profile对应的完整runtime维度与不可变JSON。expected profile来自本次owned guard，不信输入自认profile。原独立model API仅剩既有测试调用，保留兼容并复用同helper，在单个Immediate事务内读验证/更新。
- 登记错误按Preparation/Unconfirmed区分：title/timestamp/path/locator等前置无副作用校验仍在事务前，错误不设置unknown；事务开始/owned guard/写入/commit或store不可用失败属于Unconfirmed。原Runtime scope/native身份检查仍先执行。Codex在原controller/连接锁下捕获Unconfirmed，保留bound thread/tree与actual/选择，设置现有threads.unknown；不伪造native失败或回滚，不新建pending操作，不自动再登记/再start。
- 原threads/admission/Turn/再登记拒绝路径复用unknown。补测证明admission view此前在检查unknown之前take了缓存，虽然没有派发，却会清掉actual诊断；将threads.unknown检查提前到take之前，只保留私有诊断而不恢复可用性，仍返回同一关闭错误。Configure pending/turn状态等原清当前可用性语义未改。Stop继续沿原安全断开路径可用；断开后的跨进程未登记native thread恢复仍未实现，未增加孤儿表。

**测试与首次失败**

1. 原红测在共享事务修复后先精确 **1/1（0.23s，编译40.34s）** 转绿，没有移除原“不留下部分Session/locator”断言。随后强化为检查本次新建projects/working_copies/sessions/session_native_locators均0、unknown=true、原native身份保留、后续入口拒绝及安全Stop。
2. 新增 `threads/tests/registration.rs` 六项：完整成功/精确幂等；四种模型选择冲突时标题更新及四表全部旧行不变；十种完整selection身份错配及owned profile/代次拒绝、无行残留；错误scope/参数不污染连接且之后正确登记成功；已有Session的model写失败时四表不变并关闭所有工作；持久owned代次漂移时登记拒绝但原native仍保留。后两项与原红测共用检查，验证start/resume/list/admission/view-admission/Turn/再登记均拒绝、Host Turn数0、native文件字节不变、bound及actual仍在。
3. 六项首轮 **4通过/2失败（0.60s，编译15.88s）**，只在“拒绝后actual诊断应保留”断言看到None，定位为前述admission.take顺序。修正后整个threads集合 **11/11（1.16s，编译7.00s）**；不加重试/timeout，不改Adapter。
4. 最终一次组合执行 `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib -- codex_acp:: host_store:: pi_acp:: opencode_acp:: codex_sessions::`：**221 passed / 0 failed / 22 ignored（22.18s，编译9.03s）**。涵盖E及共享store/Session open/旧Codex Session/Pi ACP/OpenCode ACP无网络合成合同；22忽略=E原3真实检查+2lease诊断、OpenCode8固定Runtime、Pi9固定Runtime，本轮均未开启。测试里的Git/worktree/迁移/恢复均为既有临时fixture，不是现有用户数据操作。
5. `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --lib -- -D warnings` **通过（32.90s）**；受影响Rustfmt、git diff check通过。本片没有前端变更，未重跑前端/Pi Node Adapter/完整Rust或test-Clippy，不把过去测试数作为本轮结果。

**保护与剩余**：仅共享records/native_model_selection/session_open、Codex threads/admission及相关Rust测试和文档有本片改动。所有生产Host/Adapter/UI门禁继续关闭，无新Session facade/backend/UI动作，无Turn/send/history/event pump/reply/steer注册；Adapter/schema/pin、真实profile/凭据/账号目录模型、现有数据库、应用构建安装及旧controller均未触及。此修复使共享登记事务原子且当前连接失败隔离，并不将原生Start纳入SQLite事务、不保证跨进程孤儿恢复、不宣告E可用。完成后只交协调复核，原新Session facade接线待修复通过后恢复。

### 2026-09-16 E 已登记连接上的 Session start/open facade（提交复核）

协调逐读原子登记修复并独立threads11/11、shared records7/7通过后，恢复此前有限片。先同步三入口；只使用测试已登记owned连接和临时Host库，不做首次profile/安装发现或生产异步调度。

**唯一入口与共享权威**

- `operations::Input::Session` 严格解码 `start {workingCopyId, choice}` 或 `open {farfoldSessionId}`；没有前端cwd/thread/tree/title、模型覆盖、Turn/history请求字段。生产仍在解析和任何服务访问前无条件拒绝。新 `codex_acp/sessions.rs` 只编排既有threads、open_registered_thread及原子register_thread，没有独立Session状态、重试或第二Agent循环。
- 新建从共享 `registered_session_workspace` 读取已存在Project/WorkingCopy元数据与canonical目录，managed必须ready、已有removal记录拒绝；与原owned launch/profile/generation及当前连接workspace相符才进入原threads Start。WorkingCopy未知不能按前端路径新建。原共同Host Session ID派生从session_binding_index机械抽成helper，旧调用保持算法不变。
- `ExplicitSelection` 在原native dispatch同一controller/连接锁内检查原scope/epoch/hash/完整catalog model/native model/provider/effort和当前Host选择，并拒绝Configure占用。原Start响应仍由threads验证native身份/actual选择一致；注册前再核对工作副本观察和明确选择，注册事务内再读同一个共享workspace投影核对原对象，防止删除/迁移后重建旧对象。此有限校验不声称文件系统inode CAS或全局持久epoch CAS。
- 对此新增已有workspace guard使用原register事务的可选model登记参数携带观察，没有第二事务。旧内部无guard调用仍走原方法，Pi/OpenCode/旧Direct无selection语义不变。已Start之后登记/回执核对失败，保留原bound/actual并置当前原代threads.unknown；新代不会被晚回执污染，原Stop可用。不自动start重试、不用新thread替代，也不宣称原生Start回滚或跨进程孤儿恢复。
- 目录Refresh此前仅对外selection=null，Host内部可能继续持有Adapter回来的旧selection。新增反例证明可凭旧选择新建；修复为view Refresh同时清Host内部selection/actual，保留目录观察，必须重新明确Select才能start。Adapter自己的残留选择不改、不作为新授权。Unknown连接诊断保留的前置拒绝仍不清actual。
- 打开只按FarFold Session ID重读原target/locator/immutable selection和owned launch，通过既有fresh list/read及无覆盖resume；回执再次核对原Host/native身份和实际选择。未知/已变target不新建、不发Turn，原始native文件在测试中保持字节相同。

**客户端与普通UI边界**

- 新typed `codex-acp-session.ts` 只调用唯一Host operation，校验scope、ID、native UUID与start明确选择/working copy或open原Host ID，拒绝多余路径字段，输出白名单投影；原始错误换为固定未知提示，无自动重试或状态缓存。回执只有scope/Host Session/WorkingCopy/native thread/tree/selection，不含cwd/path/history/任务ready。
- 既有workspace backend增加 `sessionAcp`，沿原route、全scope、持久binding和view lifetime；新建必须是无binding视图且显式传入选定WorkingCopy ID，打开必须匹配原FarFold/native/WorkingCopy绑定。晚回执不能写回退休视图。没有Direct fallback，原Direct commands未改。
- 未改普通CodexWorkspace/账户面板/模型组件/新建选择器，所有ACP UI capabilities仍false；当前普通新建界面尚未把已登记连接scope、已选WorkingCopy与已确认选择共同交给该方法，也未消费Session receipt去接共享激活/navigation/session-opening。原模型面板私有owner没有新跨页面选择缓存。这些是精确剩余接线，不把typed方法存在当可用UI；本片无新页面、无浏览器演练或安装验收声明。

**测试、失败与收尾**

- 初始新增Host测试错误地直接访问ViewSnapshot私有epoch/hash，编译失败（0项断言）；改为沿序列化投影读取。并行发出的下一编译也见到相同旧测试源码，记录为同一测试编写错误，不算两个业务缺陷；修正后基础start1/1（0.17s）。
- Refresh残留选择反例首轮 **1通过/1失败（0.22s）**，上述Host清选择修复后通过。最终新增 **8项Host facade测试**：明确选择并无Turn；Refresh旧选择不能复活；全scope/epoch/hash/模型四元组/WorkingCopy错配和自由native字段拒绝；实际模型/effort错误及登记注入失败不成功不重试；原Session精确打开不覆盖/重发；native Start期间workspace变更保留unknown；事务中已退休workspace不重建；停止/换代后晚Start不能注册或污染新代。定向 **8/8（1.17s，编译12.57s）**。
- 新增前端client5项及backend原绑定open1项，覆盖唯一输入/关闭能力、未选workspace零IPC、scope/choice/回执错配、固定错误与不重试、退休视图、原Host/native绑定。最初两文件10/10（0.377s）；全前端371通过后再补原binding测试，最终 **71文件372/372（12.08s）**，`tsc --noEmit`通过。
- 一次共享store+Pi ACP+OpenCode ACP+旧Codex Session+E组合 **229 passed/0 failed/22 ignored（27.07s）**，所有既有opt-in真实Runtime/lease诊断保持忽略。生产lib Clippy首轮报告原模型登记wrapper暂时只被测试使用和可合并if；保留原无workspaceguard调用走原wrapper、有guard调用同一事务方法，并按lint合并if，无allow或语义放宽。最终Clippy **通过（12.63s）**；这两处收尾修改后 operations+threads+shared records定向 **39/39（2.41s，编译20.22s）**，不将前面的229项称作收尾后整套复跑。
- 受影响Prettier/Rustfmt与git diff check通过；收尾无Codex synthetic Adapter/Server进程残留。未跑完整Rust/Pi Node/Node Adapter全集或应用build；所有workspace/数据库变动仅临时测试fixture。未使用智谱Key或读取真实认证、未启动真实Runtime/账号目录模型请求、未迁移现有库、改Adapter/schema/pin、安装替换或删除旧controller。

本片只交协调复核。后续仍需明确的已有/首次连接与生产调度入口、普通UI会话激活/导航与模型选择寿命接线，再按批准次序处理Turn/history/events/reply/Stop/steer；真实用户在场和独立安装验收是后续门槛，不能从本片合成Session合同推出。

### 2026-09-16 E workspace 接纳复核：外部 worktree 与已有 managed 记录一致性

协调独立通过 frontend session/backend11/11、operations21/21 后提出共享 workspace helper 的接纳边界。先读实际 schema：WorkingCopyKind 为 root/worktree，没有 managed kind；外部用户自建 linked worktree 也属于 worktree。managed 生命周期为 creating/ready/orphaned；failed 属于 removal。复合外键约束项目与来源归属，但不约束 kind、分支相等或来源非自身。协调澄清保留合法无 managed 行的外部 worktree，仅修正已有管理记录的一致性；不新增持久标记、不推断丢失历史、不扩 Git 可用性政策。

**确定性证据与最小修正**

- 初始3项测试为 **2通过/1失败（1.45s，编译11.77s）**：原查询放行 root-conflict、branch-conflict、self-source。creating、orphaned 和 removing/removed/failed 本来已拒绝，未把这些状态描述成新增修复。
- 共享 `read_registered_session_workspace` 仅对已有 managed 行增加 worktree/ready、项目与分支一致、同项目来源且来源非自身、目标路径不同于项目根等记录约束；无 managed 行的原 root/外部 worktree 路径保持。原 canonical 目录检查不变，无新增生产 Git 探测或 worktree 平台重写。
- 六项首轮 **6/6（2.06s，编译12.57s）** 后，追加“本次已观察 managed 行在登记前消失”的事务反例，精确 **0通过/1失败（0.74s，编译7.33s）**。原投影未含来源元数据，因此删除管理行会错误退化为合法外部 worktree。
- 仅在既有内存 `RegisteredSessionWorkspace` 增加私有可选来源 tuple（来源 WorkingCopy ID、记录的 source HEAD、来源路径）。原 start 前/后及 Immediate 登记事务内同 helper 的完整相等比较自动覆盖它。初次读到无 managed 行仍合法；本次已经读到的行消失或来源变更必须拒绝。不是持久管理标记、第二状态机，也不声称能推断更早历史、Git HEAD CAS 或文件系统 inode CAS。

**最终覆盖与验证**

- 新测试文件 `codex_acp/operations/tests/session_facade/workspace_admission.rs` 共6项：root/ready managed 正对照；非ready/删除/记录冲突零 native Start 与零 Session；schema 拼写和复合外键；真实临时 Git root 与 detached linked worktree 无 managed 行的成功对照；native Start 在途状态漂移；登记事务内非ready/kind/branch/记录消失/source HEAD/删除状态漂移。真实 Git 只用于临时工作副本，Runtime 仍为合成 stdio，不是真实 Codex Session 验收。
- start 前非法状态检查同时要求 helper 与 facade 拒绝、无合成 thread 文件、无 Session；Start 后变更保持原 bound 身份及 threads.unknown，不重发。原子登记反例要求 Session 行0并保留原 native 双身份，沿既有错误边界处理。
- 最终定向命令覆盖 operations、threads、working_copy_manager、managed_worktree_removal、records：**61 passed / 0 failed / 0 ignored（5.86s，编译0.30s）**。此前一次相同收尾输出因上下文截断无法完整取得，未计为独立成功证据；本次只重跑该有界集合以取得可核结果，没有隐藏已知失败。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --lib -- -D warnings` **通过（1.38s）**。收尾曾误用 `rustfmt --edition 2021 --check`，只报告格式差异且未改文件；核对 Cargo edition=2024 后相同受影响文件检查通过。git diff check 通过，未发现自有 synthetic Adapter/Server 残留。

**保护与停点**：本次生产修正仅共享 workspace 读取 helper/其临时投影；其余为既有 fixture 的临时目录构造提取、新Rust测试与文档。无前端变更，未重跑前端或以历史372项冒充本轮；未执行完整Rust/Node/真实Runtime/安装验证。Adapter/schema/pin、旧controller、真实profile/认证/账号目录模型、既有数据库与安装应用均未改动。生产Host/Adapter/UI仍关闭。本片交协调复核，不自动进入首次profile、UI激活、Turn/history/events/reply/Stop/steer等后续范围。

### 2026-09-16 E 闭态 Session 入口与共享导航接线（提交复核）

协调独立 workspace_admission6/6 通过，连同前次 Session frontend11/11、operations21/21 允许下一有限片。先同步三入口；遵循 ux-engineer 的既有组件/布局复用约束，不新建工作台页面、导航系统、样式系统或图片。生产 Host/Adapter gate 与全部 ACP capabilities 继续关闭，操作仅静态 browser mock IPC 夹具可用。

**只读上下文及已有共享权威**

- `sessions::ContextInput` 的 start 只接受已登记 installation/build/WorkingCopy ID，open 只接受原 Host Session ID。新增 `host_codex_acp_session_context` 是 typed 只读投影：在原 Host controller/连接锁下核对存储 workspace、原 owned profile launch、当前完整 scope/profile home/generation、同一 cwd/WC，以及无未知/在途 Configure/Turn。start 不借用已有 bound thread；open 从原 target/immutable selection 核对其原连接。停止、错配或未知均拒绝，不发现任意可用连接，不创建/恢复 profile，不发 account/catalog/thread/模型请求。只读 Tauri spawn_blocking 不代表后续 native 启动的异步生产调度已实现。
- 复用 `codex_installation_list` 的 `store.system_installations()` 与既有 `working_copy_snapshot`，不调用安装探测/accept/recheck 或 WorkingCopy 注册/创建。文件夹路径必须唯一匹配已有 ready WorkingCopy；用户明确选安装后才读其精确关系。不存在/冲突就不可用，不另建 Project/WC 权威。ordinary closed panel 不触发这些列表操作，mock allowed panel 才验证该接线。

**组件、选择寿命与导航**

- 在现有 `CodexWorkspace` 内提取 `CodexAcpSessionStart`，仍使用 `SessionStartPanel` 和原 Configure/安全只读状态/transcript children；不复制页面/reducer。新组件复用原模型字段/`CodexAdmissionPrivateView`；面板只在成功的当次 Select 输出临时 choice，Refresh/编辑同步撤销。窄 backend admission 增加已核对 unbound WC/scope 分支，生产能力不变；没有凭 Adapter 残留选择授权。
- 一次操作先 fresh context，再调用已验证 typed Session facade。已有会话只传原 Host Session ID；新会话带 WC ID+当次 choice。回执后重新读取 exact context、`host_navigation_snapshot` 和原 workspace target，匹配 shared binding 的 runtime/install/build/adapter/connection/Host/native/WC/project/path、tree 与 actual selection，之后才走既有 focus/navigation。focus 返回后再核对原 scope/代次/工作副本，才允许替换导航及组件激活。没有第二次 native open/start，没有构造 Direct `HostSessionOpenResult`。
- 共享 `focusHostSession` 仅增加可选异步回执 validator；旧调用不传参数，原 Direct 行为保持。组件用原 `describeSessionOpening/sessionOpeningError` 呈现目标和固定失败文字；原 `useHostSessionDraft` 仍按 Host Session ID 读取，未搬运或复制草稿。Session/项目/WC/安装/已观察scope/Configure变化通过 key/原 view lifetime 退休；选模编辑同步递增本视图 revision。一次已提交后不在本视图重试；未知保留原身份说明，不 fallback。
- **精确限制**：scope re-read 和前端 lifetime 不是 Runtime 内部 CAS，也不是原生状态与 SQLite 聚焦元数据的原子事务。共享 `host_session_focus` 可能已提交 mark_session_opened 后，前端发现迟到/代次漂移而不应用回执；本片不回滚那次 metadata 写入。不得将“未进行可见激活”写成“任何持久 focus 都没发生”。仍无跨进程孤儿恢复、首次 profile/真实 restore 或 native mutation 调度；这一限定随本片交协调复核，未扩建导航状态机。

**测试及静态组件证据**

- 新增 Rust 上下文2项：精确 installation/build/WC、不可借任意连接/已 bound thread、无 private choice/capabilities 投影、原 Host open 只读 native 文件字节不变、unknown/停止/launch路径漂移拒绝且不恢复。初次 **2/2（0.20s，编译17.84s）**；最终 operations+workspace+threads **44/44（3.26s，编译12.01s）**。生产lib Clippy **通过（19.05s）**；仍为临时数据库+合成 stdio，没有真实 Runtime 请求。
- 新增前端 entry7项+unbound backend1项：strict context、固定错误、缺失/重复/归档/外来shared binding、tree/model/scope漂移、迟到read/focus、focus期间代次变更、唯一operation和capabilities仍关。全前端先 **378/378（72文件，8.66s）**；补最后两项后 **380/380（72文件，14.86s）**。最后复用共享 opening 文案后定向 **22/22（4文件，2.42s）**，不把先前380项冒充最后文案更改后的全套重跑。
- 类型检查曾发现新测试 scope 被推断为 string 而非固定 `"codex"`（TS2322）；systematic-debugging 核对错误源与已有 typed 测试后，只给测试常量补 `CodexAcpScope`，生产类型不放宽。根 tsconfig 只有 references，因此根 `tsc --noEmit` 不计有效检查；最终显式 app/node tsconfig 检查通过。Prettier、Rust2024 rustfmt、git diff check 通过。Node 为22.22.3。未跑完整Rust、Pi/Node Adapter全集或 build/install。
- 新静态 `scripts/fixtures/codex-session.html/.tsx` 拦截每个IPC，真实组件演练：明确安装→只读上下文→Refresh→明确model/effort/provider→一次start→fresh shared binding/tree/model→focus→激活；原 Host Session 一次open恢复 SAVED DRAFT。没有native二次open。延迟open后切另一Session显示 OTHER DRAFT、延迟后换代/项目变更、延迟start后改effort均不继续导航；失败/绑定冲突不激活，按钮保持不可重试。追加focus后fresh上下文后再验原open一次，草稿保持。测试全部值为显式 synthetic，无真实Provider资料。
- 现有完整 CodexWorkspace 静态夹具再次核对：普通ACP控件全部disabled，旧Direct仍显示 DIRECT FIXTURE MODEL/medium、原DIRECT DRAFT及ready；返回ACP仅原ACP DRAFT、不借旧ready、发送关闭。复用面板 children 后截图核对单一布局，无新增页面/样式。初始独立夹具缺 sidebar 导致main落在窄网格列，只修夹具占满网格；热更新曾出现createRoot重复警告，补fixture dispose清理，历史警告未抹去。最终reload后的open流程无新增警告；完整工作台夹具检查warn/error空。这些是浏览器mock，不是installed证据。

**保护和停点**：未读取/使用用户的智谱key，未启动真实Runtime/profile/认证/账号目录模型任务，未访问迁移现有应用数据库、构建/替换应用、改Adapter/schema/pin或旧controller。新只读投影不授予任何能力；Host mutation入口仍在解析/状态访问前拒绝，普通面板allowed只来自全关backend，没有env/URL生产enable。完成仅提交协调复核；首次profile、真实launch/restore调度及Turn/history/event pump/reply/Stop/steer仍为后续未完成范围。

收尾：两张自建静态测试页已关闭；Vite1434的PID4691核对本仓库cwd及完整命令后仅停止该自有服务。复查无该服务或synthetic Adapter/Server残留，git diff check通过，结果及focus元数据限制已发协调任务，未开始下一片。

### 2026-09-16 E 持久 Session focus 的最小提交保护（提交复核）

协调独立 entry+metadata9/9 后不批准上片为完整activation合同：既有 `mark_opened` 先commit app_state/last_opened，再执行JS validator，晚A可覆盖已提交B的重启恢复目标。批准同片有限修正，不扩导航状态机；先同步三入口，按systematic-debugging复现存储层因果。上片“仅可见导航不误激活”的限制不删除，本节是后续提交保护证据。

**红测和根因**

- 新共享store临时库反例 `late_focus_must_not_overwrite_a_newer_persisted_navigation`：登记A/B，A取得旧状态，B普通focus已提交，再执行旧无guard A focus；要求保持B。首次 **0通过/1失败（0.05s，编译13.22s）**，实际last_session回到A、updated_at再增1，证明不是仅前端显示问题。
- `read_app_restore_state_from` 对归档Session会返回last_session=null；不能作raw CAS令牌。新窄 `NavigationExpectation` 区分 absent 和 present{last_project_id,last_session_id,updated_at}，直接读原app_state，无join/归一化、无新表或计数器。通过已有只读Session context输出，不新设原生请求或生产enable。

**同一原事务与当前连接权威**

- 原 `mark_session_opened` 保留无guard包装，进入同一 `mark_opened_with_guard` Immediate事务；Pi/OpenCode/Direct原调用不传guard、语义不变。可选typed `SessionFocusGuard` 要求原导航期望与target；ACP必须具备owned model/generation/home守卫。事务写入前比较raw导航、重读同shared target；原immutable model按完整Session/profile/runtime/WC/path/native双身份验证且与原观察相等；持久owned profile/generation/launch的home/cwd/WC再次精确确认。任何拒绝发生在last_opened/app_state写入前，两处写入与原共享navigation投影仍一次commit。
- `native_model_selection::read_from_connection` 与 `runtime_owned_profile::current_launch_from` 只机械抽出已有读取，让原方法和focus同事务复用，不复制Provider/Session表或引入第二持久权威。没有删除immutable触发器，没有以删除focus持久化、重试或补偿写伪装成功。
- ACP `operations::Input::Focus` 接受原typed Session receipt与expectedNavigation，生产仍在解析/服务访问前硬拒绝。`focus_registered_session` 在原controller exclusive与当前原connection mutex下核对完整scope、无unknown/在途Configure/Turn、bound thread/tree、actual和immutable选择；同锁持有至共享guard事务完成，stop/start亦经原controller，因此不会将旧handle嫁接新连接。focus不执行native命令，也不构建Direct DTO。成功回执只有原scope/Host ID与原shared navigation。

**前端期望值与顺序边界**

- 启动面板在native start/open **之前**的fresh context取得raw期望；沿该次请求传给激活helper。即使回执后重读context看到新导航，也不替换原token。ACP不再调用无guard `host_session_focus`，改走原硬关闭operation的focus；删除上片仅用于ACP的可选JS focus validator扩展，旧公共focus wrapper恢复原样。
- visible activation仍重查原binding/tree/actual与视图寿命；受保护focus返回必须是原scope/Host ID、匹配的已提交restore target及有效递增revision。提交后再读scope只负责淘汰迟到UI回执，不作为持久提交保护。错误/冲突不刷新令牌再试、不重发native、不改写草稿。
- 保证只覆盖Host已观察到的scope/native/持久导航冲突。未送达Host的用户意图不是本事务的CAS对象；合法guard commit完成后新意图才到达，按顺序事实保留，不回滚或补偿覆盖新操作。没有声称跨进程全局用户意图CAS或跨进程native孤儿恢复。

**验证与首败保留**

- 同一覆盖红测改走guard后 **1/1（0.04s，编译27.89s）**。另一shared store测试覆盖缺app_state行、含None的present行、原token重复拒绝、归档raw值保留而普通restore归一化、旧无guard路径继续成功。
- 新ACP focus3项：精确成功/同token二次拒绝无native文件变化及draft不变；错误scope/native双身份/WC/selection不写；在事务前target/tree/archive/owned generation/navigation变化或错误模型观察不写；当前unknown、bound thread/tree漂移、actual丢失及stop→新handle代次后旧focus不写。读取metadata、草稿与native文件都来自临时fixture。
- 首次focus测试编译缺两项import（FarfoldSessionId/OptionalExtension），未运行断言，补测试import后继续。其后定向 **6通过/1失败（1.05s，编译22.38s）** 是测试尝试改写已有model JSON被原immutable触发器拒绝，未到focus断言；核对schema15原触发器后保留它，明确assert拒绝改写，再用错误调用方model观察验证focus事务拒绝，不改生产schema。最终该组 **8/8（1.71s，编译13.81s）**。
- 最终一次共享store+Pi ACP+OpenCode ACP+旧Codex Session+E组合 **242 passed / 0 failed / 22 ignored（25.37s，编译18.21s）**；22忽略仍为E原3真实+2lease诊断、OpenCode8固定Runtime、Pi9固定Runtime，未开启。生产lib Clippy **通过（44.32s）**。全前端 **72文件382/382（15.07s）**；app类型、受影响Prettier/Rust2024格式、git diff check通过。未跑完整Rust/Node Adapter全集或应用build。
- 前端entry+metadata从独立9项扩至11项，明确旧token不被晚context中present新值替换、Host冲突不再试、不走unguarded focus、错误commit projection不激活；正常与迟到view guard保持。静态真实组件mock补“延迟原open→提交另一导航→释放旧回执”，focus操作拒绝、已激活仍none、SAVED DRAFT不变，审计没有host_session_focus或二次native open。独立正常场景用新明确操作取得其期望，原open一次+受保护focus一次后激活saved，草稿保持；最终浏览器warn/error空。mock不作为持久CAS证据，持久证据以临时SQLite事务测试为准。

**保护与停点**：无真实用户数据、profile/Runtime/认证/账号目录模型任务或安装变更，无Adapter/schema/pin、旧controller或导航状态机扩张。仅提交本片持久focus修正复核，不据此开放生产Session/任务能力或进入下一片。先前首次profile、真实启动/恢复与异步生产调度、Turn/history/event/reply/Stop/steer仍未完成。

收尾：本片自建验证页已关闭；核对Vite1434 PID6175的命令与本仓库cwd后仅停止该自有服务，复查无该服务或synthetic残留。三入口和记录同步，git diff check通过，交协调复核。

### 2026-09-16 E 最后可见激活的导航顺序窄修正（提交复核）

协调认可持久guard方向并独立entry+metadata11/11后，要求补A合法focus提交、B随后提交、A的finalContext已观察B却仍应用A快照的两个精确反例。本节只修最后UI应用边界，不修改上一节的共享事务、Rust或生产gate。

- 按systematic-debugging先写current始终为true的反例：final raw改为另一Session/updatedAt=7，或仍为同Session但updatedAt=7；本次focus提交tuple为原Session/6。首次entry测试 **9通过/2失败（249ms，断言21ms）**，两例都错误resolve binding，证明原scope/工作副本检查不能区分后续导航。
- 在原最后检查中加入raw present及项目、Session、updatedAt与本次focus committed restoreState的精确相等比较，通过后才调用原replaceHostNavigation。两例明确断言不替换导航、总计5次原IPC、唯一focus携带最初token；不回滚任何合法提交、不重新获取token或重发focus/native。正常对照断言仅替换一次，返回原binding。
- 默认成功mock在focus后返回该次已提交raw tuple；静态组件夹具同样维护当前导航Session，成功focus更新为目标，“提交另一导航”更新为other，避免夹具继续固定返回other。没有改变普通产品能力或增加导航系统。
- 最终entry+metadata **2文件13/13（468ms，断言36ms）**，显式app TypeScript检查通过。受影响三份前端文件Prettier及git diff检查通过。本次未重新执行前轮242项Rust或382项全前端，不将历史结果当作本补丁后的重跑；未新开浏览器/服务或开展安装验收。

保证仅限最后读已观察到的后续导航，不声称防止尚未送达的用户意图或最后读之后的跨进程变化。生产Host/Adapter/UI能力全关；无真实Runtime/profile/账号目录模型/用户key、既有数据库、安装、Adapter/schema/pin或旧controller变动。三入口同步，交协调复核，不自行扩大下一片。

### 2026-09-16 E 闭态 Turn facade 与 Host 唯一事件消费（提交复核）

上一导航片协调独立13/13和Rust focus6/6通过后，授权本有限片：发送、活动Stop和不依赖页面读取的终态结算；先Rust facade和必要typed backend，不开放正文UI/生产请求。先同步三入口。源码确认已有 `acp_runtime::start_event_pump` / `AcpEventConnection` 可复用，因此没有新Agent loop、事件调度平台或第二Turn状态机。

**接线和共享权威**

- 原硬关闭 `operations::Input::Turn` 接typed send/interrupt。send只有原scope、Host Session ID、有界UTF-8 text；Stop附原Host/native Turn引用，不接受前端native thread/tree/cwd/model/provider。原Host Store/owned launch/bound thread、immutable选择、fresh account/catalog/idle observation、TurnCoordinator双Turn上限/WC排他、Session operation和native-observation binding保持；未改成managed verification。回执仅原scope/Session/Host Turn/native Turn及started或interrupt_accepted，不含原生路径/正文/配置。
- 原 `start_turn` 的执行体机械提取为内部 `start_turn_receipt`，在原连接锁内截取已核验Context/native ID，旧返回Host ID的入口保留；避免事件泵已结算后再向active索取回执。原 `interrupt_turn` 仍核对完整context/native ID并只承认ACK，不结算。原operations生产gate仍先于解析、状态访问、spawn与请求；所有ACP capabilities继续false。
- 原 `poll_turn_events` 的校验、RuntimeEventRouter路由及terminal settlement体移至Connection共用helper。首次闭态发送在精确已有连接上登记唯一共享泵；原router与停止标记属于该连接，后续发送复用，不能替换router或重启已失败消费者。原 `poll_turn_events`、`thread_events`、`Connection::events` 在已归Host泵时拒绝，不允许UI再drain底层队列；workspace只读cached状态，订阅/snapshot仍读原router的非破坏性ring。
- 公共泵trait仅增加默认true的 `can_consume_events`。Codex待receipt时没有足够native身份，因此暂不drain；共用泵在连接锁外20ms等待，避免对非空早到队列空转。receipt之后在同连接锁下沿原路径消费；transport failure即使pending也处理。Pi/OpenCode默认行为不变。连接Stop置原停止标记，错误消费保持原unknown/占用，不把页面生命周期当Runtime停止或native结算。
- 交互事件继续通过既有校验和共享InteractionRegistry路由；本片没有reply/steer入口，也无自动审批/回答。原terminal才释放共享Turn与operation；延迟ACK在原Turn已终结后返回退休错误，不影响后来Turn，未完成wire请求期间也不重新准入。断开、超时、错scope及跨代遗留工作保留unknown，不删占用后重发。

**必要前端合同**

- 新 `codex-acp-turn.ts` 只调用原closed operation：严格字段、scope/Session与Stop原Host/native引用、UTF-8文本上限、固定无秘密错误；await前复制原请求，晚回执不能被调用方改写目标。无自动重试、无event drain、无optimistic settlement。
- 原typed workspace backend增加 `turnAcp`，复用原绑定/scope/view-lifetime校验；空新建视图、Direct、外来Session/代次拒绝。普通send/stop/reply/steer仍false，旧Direct方法未改。正文UI、transcript/history恢复显示未接，也未新增页面或静态可启用生产开关。

**验证和首败保留**

- 原Turn stream/history单测先通过 **1/1（0.45s，编译22.39s）**；新facade初批6项 **6/6（21.16s，编译13.14s）**。扩到9项时 **8通过/1失败（21.29s，编译11.73s）**：Fixture使用admission模式，而底层attach按既有设计不自动选模，测试在thread start unwrap就失败，未到发送预检。
- 诊断期间曾改用直接编辑合成model配置文件的反例，定向 **0/1（0.17s，编译5.67s）**，它要求未通知的model文件变化被运行中preflight察觉；这不是固定0.143.0的观测合同。核对 `admission.mjs::prepare` 与原测试：thread/read只有identity/provider/idle，model/effort来自原checked start/resume，settings事件负责失效。保留该限制，不新造字段、不改生产Runtime/Adapter。最终使测试Fixture在admission模式明确select，再用原catalog/account/provider/idle变化反例，**1/1（0.77s，编译12.50s）**。两次错误测试假设均未作为产品修复或真实模型证据。
- 前端首次客户端+backend **11通过/1失败（362ms）**，模拟SECRET拒绝在测试结束时被再次执行。按systematic-debugging单独复现后核对Vitest runner `getBeforeHookCleanupCallback`：返回函数会作为cleanup；箭头beforeEach直接返回mockReset的mock函数。仅把本片新测试hook改为无返回block，生产catch不变，单项 **1/1（164ms）**；扩后的客户端+backend **14/14（326ms）**。没有真实秘密泄漏事件。
- 最终全前端 **73文件392/392（13.21s）**。E+acp_runtime+RuntimeEventRouter+TurnCoordinator组合 **145 passed / 0 failed / 5 existing ignored（28.50s，编译17.83s）**；5忽略是原3固定真实与2lease诊断，未开启。Pi/OpenCode共享泵回归 **64 passed / 0 failed / 17 existing ignored（6.95s，编译11.56s）**，固定Runtime忽略未开启。生产lib Clippy **通过（12.46s）**；显式app/node TypeScript、受影响Prettier/Rust2024格式、git diff检查通过。
- 新facade最终11项覆盖：无页面终态一次/原router重复read不消费、单次native派发、活动Stop ACK保持占用、下一Turn同一消费者、字段/scope/text拒绝、断开/不可确认item/start与Stop超时不重发、迟到native terminal、冷历史不重发、无UI的交互保留、terminal早于ACK、双Turn/WC排他、原模型preflight/router不替换、错误event scope保持unknown、停旧泵并恢复原会话后新代仍被旧unknown WC占用阻断。最后补native_observation/无managed connection和跨代WC断言后 **11/11（21.48s，编译8.62s）**；前述145项不是最后纯测试增强后的重跑。
- Node原四份spec **23/23（104.64ms）**，包括生产Turn/model/interaction hard gate和settings失效。只为确定性终态早于ACK，在未pin的 `test/synthetic-server.mjs` 加 `turn_late_stop_ack` 模式；生产模块及manifest哈希保持。最初Node命令误用不存在的package/文件通配名，未执行断言；按实际spec-node文件重跑，未升级或安装依赖。

**准确剩余范围**：仍是无网络合成Host合同，绝非真实native任务或安装验收。同步native方法只在cfg(test)合成入口可达，生产async command仍硬拒绝；没有用blocking await宣称生产异步调度完成。首次profile/真实launch与restore、完整history/transcript/UI接线、reply/steer及跨代unknown原生工作对账仍未完成。model/effort实时读取不可用的固定协议限制不变。未读取/使用用户智谱key、真实profile/账号/目录/模型，未访问迁移既有数据库、构建安装、修改生产Adapter/schema/pin或旧controller。三入口同步，交协调复核，不自行进入下一片。

### 2026-09-16 E 只读历史与安全实时正文有限片（提交复核）

上一片协调独立前端14/14、Rust facade11/11通过后，本片只把已有history与typed事件接入原正文。协调首次Rust filter匹配0项不计覆盖。本片遵循ux-engineer复用现有单Transcript和样式，不新建产品页面、旧reducer或第二任务权威；systematic-debugging用于下述三项红测的最小修正。

**共享Host读取与游标**

- 新 `codex_acp/turns/history.rs` 包装原 `read_turn_history`，原硬关闭operations增加History action。输入仅scope/Host Session，目标由原Host记录决定。先在原controller/connection锁下核对target和事件所有者并取共享router读取前cursor；原history操作仍仅idle/settled且占用Configure；回执前再核对同handle、scope、原target/native thread/tree、无transport failure/unknown。返回有限安全history加原身份和before cursor，超过500items/2MiB拒绝。
- 读取前cursor使history释放后新Turn事件仍可接续；历史终态native Turn覆盖重叠live内容。无需消费router、不发第二prompt、不从native history臆造Host Turn ID、不加DB映射。生产gate仍在解析/状态访问前拒绝，原native历史与终态结算逻辑未重写。

**类型化展示和生命周期**

- `codex-acp-content.ts` 严格验收safe item/history/event字段与原scope/Host Session/thread/tree/WC/Host-native Turn；native item ID沿Host256长度合同，正文UTF-8有界，拒绝raw command/output/diff和未知payload。历史最多64turn/500item/2MiB，事件最多512项/2MiB，展示另有4MiB裁剪与显式不完整提示。只保存安全展示数据，不保留私有native envelope。
- `codex-acp-transcript.ts` 是原历史baseline加安全事件的纯展示投影及有界view cache。sequence重复不重复显示、冲突/缺先导item/身份错配标记不完整；stream改变或无法核验batch停止拼接，gap与断线不等于取消。断线后的同目标已观察内容标注为旧观察，重新连接也不凭连通清除partial。native terminal仅是正文状态，Host结算仍由上一片唯一泵负责。
- 原hook串行400ms只读刷新cached workspace与shared snapshot；空闲首次/新终态可各读一次history，失败不无限重读。活动期间重新进入可能只显示live片段，缺历史明确提示；不会为补正文发prompt。读取ticket、scope/target key和retire阻断旧await再写缓存或关闭后继续请求router；新目标先清旧内容再处理unknown。
- 原backend/view增加typed history和独立ACP展示对象，`CodexTranscript`仍只有一个组件/列表；复用MessageContent、reasoning disclosure与条目状态。Direct的user/command/output/raw JSON原样保留。ACP历史标注Host Turn ID未恢复、命令/文件条目仅身份状态；没有把ACP变成Direct DTO。Composer发送/Stop/reply/steer全部关闭。

**首败与最终验证**

- 新前端初始9项 **6通过/3失败（168ms，断言12ms）**：新unknown Session残留旧内容；迟到旧history未退休且继续router读；合法256 native item ID误用200上限被拒绝。分别最小修正key清理顺序、revision/retire异步守卫及独立native item校验，无生产gate放宽。原9项随后 **9/9（205ms，断言7ms）**。
- 补disconnect/reconnect保持partial、stream替换停止读取、关闭retire与返回active不取消，共reader/content12项；单Transcript SSR2项覆盖ACP安全展示及Direct原字段。相关5文件 **26/26（1.86s，断言68ms）**。最终全前端 **75文件406/406（7.69s）**。
- 新Rust `history_facade_is_original_bounded_read_with_before_cursor_and_no_replay` **1/1（0.27s，编译10.76s）**：原身份、读取前cursor、活动拒绝、Stop/Host终态后读取、重复读取不改native文件/start仅1次、自由字段/旧scope/unknown拒绝。最终operations/turns/workspace/router定向 **67/67（23.74s，编译11.78s）**；不是全Rust验收。生产lib Clippy **通过（7.33s）**；app/node TypeScript、受影响Prettier、Rust2024格式及git diff检查通过。生产Adapter未改，未重复跑上片Node23或真实固定Runtime测试。

**真实组件静态mock（非安装证据）**

- 新 `scripts/fixtures/codex-transcript.html/.tsx` 使用真实hook、同CodexTranscript和全mock IPC；共用typed合成数据不被应用import。UI控制仅改变合成观察，审计只读history/workspace/router；普通动作均disabled。初次截图发现fixture被现有workspace grid拉伸，只有fixture main改display:block，显式reload后复看1280×720正常；无产品CSS修复主张。
- 可见核验：原会话有限历史；活动agent正文/安全reasoning；command缺正文说明；关闭显示“未发送停止请求”，返回可再显示活动片段；制造sequence gap出现不完整警告；合成终态后再进入恢复原旧历史和最终正文，无重复或prompt重发。延迟原Session history后切到另一Session，释放旧回执仍仅显示OTHER SESSION CONTENT，无旧正文覆盖。最终warn/error为空。
- 另用现有完整CodexWorkspace静态夹具：旧Direct原绑定显示DIRECT FIXTURE MODEL、medium、DIRECT DRAFT及原发送入口；切回ACP原绑定恢复ACP DRAFT、模型未确认和发送disabled，没有借用Direct模型/能力。该页warn/error为空。两个自建tab均已关闭，核对Vite1434 PID15292命令及本仓库cwd后只停止该自有服务。

**范围与停点**：本片证明合成闭态只读内容合同，不是完整native history或已安装E工作台。固定安全Item缺userMessage，缺command/output/diff与历史HostTurn身份均不补造；活动返回可能只有有限live片段，gap后的已知片段只在不完整警告下展示，不宣称连续正文。普通Composer能力、首次profile/真实launch/restore、生产异步调度、reply/steer与跨代unknown原生对账及安装验收仍未完成。未使用智谱key、真实Runtime/profile/账号/目录/模型，未访问迁移既有DB、构建安装、修改生产Adapter/schema/pin或旧controller。三入口同步，提交协调复核，不自动开始下一片。

### 2026-09-16 协调复核通过后，用户因额度要求就近暂停

- 协调独立检查history/reader/hook/单Transcript/backend/view，前端 **25/25**、Rust Turn facade **12/12**；认可有限只读/合成证据，不外推生产或安装。随后批准下一Composer发送/活动Stop静态mock有限片，约束已同步三入口。
- 下一片尚未实施。已读现有Workspace/Composer、共享draft、NativeStopRequest和typed Turn/Host snapshot边界；发现原shared draft内部已有editRevision，但旧Workspace晚成功只比较body，后续需保护提交后编辑及改回相同正文的情况。这里只是源码待测风险，不声称已复现草稿丢失或已修复。
- 唯一新增代码是 `src/components/CodexWorkspace-scroll.test.ts` 的确定性TS AST源码依赖回归：现有跟随effect只依赖 `[conversation]`，ACP正文更新不触发该effect。首次 **0通过/1失败（341ms，断言24ms）**；尚未实施修复或进行本片浏览器行为验证。用户随后明确额度将尽、要求就近暂停。
- 为留下可执行的已知未修缺口而不把它冒充已修，将该回归显式标为 `it.fails` 并注释续接时移除。单项核对结果 **1 expected fail（328ms，断言25ms）**，不是滚动修复通过。仅该测试Prettier和git diff检查完成；未跑全量、不改生产代码/Host/Adapter/schema/pin，不读取真实profile/凭据、调用模型、访问迁移现有DB或构建安装。上一片自建页和Vite已经清理，本片未启动新服务。
- 精确续接：用户恢复后，先移除expected-failure并最小补ACP transcript依赖，保留following/current及用户上滚语义，用真实组件mock补行为证据；随后在已授权同Workspace/Composer内接typed发送与活动Stop，覆盖同步防重复、原scope/Session/Turn、晚回执退休、草稿编辑revision、unknown不重发、ACK不结算、关页返回不Stop/重发。本片仍不开reply/steer或任何生产能力。共享Host状态/唯一泵保持任务权威，若出现结构或协议决策则回报，不建立第二任务系统。
- 当前是用户暂停，不是技术阻塞；等待明确恢复指令，不因协调此前持续推进授权而继续执行。已同步协调任务停止推进。
