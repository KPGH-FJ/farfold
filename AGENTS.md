# Farfold AI Coding Entrypoint

2026-10-04 用户进一步批准采用 ChatGPT/Codex 桌面端的通用视觉与交互模式，并确认最新共享网页评审稿接入正式界面。本轮统一灰白工作台、紧凑工具栏、圆角输入区和内嵌浏览器内容栏；仍为 Farfold 自有的一套多 Agent UI，不嵌入第三方产品页面，不硬编码模型或演示回答。网页读取确认继续原工具请求；内容栏收起隐藏真实页面并保留许可，关闭或换页撤回。批准限当前公开页只读范围，真实 Agent、账号、模型和正式安装仍按明确条件另验。此授权更新下文较早的“共享交互待评审”和不借鉴 Agent UI 的表述。

This repository is the only writable checkout for Farfold.

2026-10-06 用户已授权按活动计划持续完成接入补强、日常基础、资料成果、浏览器、搜索维护，再开发 Windows。新增交互由开发方自查自纠，不再等待原 D 用户评审；逐家真实账号/模型测试暂缓。完成可验收部分即提交，关键阶段独立复核；记录简短且可追溯。储存压力下可先核归属再清理可再生成文件。该授权覆盖下文旧 macOS-only 与待用户 UI 评审要求，其他产品、数据和凭据边界保持。

## Read Order

1. `AGENTS.md` (this file)
2. `PRODUCT.md` — 唯一产品契约（产品边界、页面、术语、文案与当前接入标准）
3. `docs/architecture.md` / `docs/status.md` — 源码入口、当前实现、已验证结果与未解决问题
4. `plans/agent-access.md` — 唯一活动计划；`docs/archive/` 为历史，不得据此续接
5. `.design/2026-09-26-agent-access-redesign/workbench/README.md` — 唯一原型说明，已合并当前接入、整体工作台、思考位置、权限与发送管理规则。用户已于 2026-09-27 授权基于当前原型先做技术验证，再完整增量落地；2026-09-28 授权删除旧原型及历史设计报告。原型示例不代表真实接入能力。
6. Task-relevant source — 对实际行为的判断以当前源码及对应验证为准，不以计划完成声明代替

2026-10-04 用户确认继续开发，并授权到可验证关键节点提交推送；当前接入已评审的内嵌公开网页打开、读取、关闭与切页收回。提交只选本轮依赖闭合增量，既有未提交工作保留；用户已确认推送里程碑分支、暂不更新远端main，并知悉该分支包含此前117个本地历史提交。不因此启动真实账号/模型、替换正式应用或恢复已撤销的验收门槛。

2026-10-07 用户要求将当前里程碑分支合并到 main，本次允许更新远端 main，覆盖此前暂不更新 main 的限制。此次同步开发基线，未解决问题与实测边界仍以 docs/status.md 为准。

2026-10-03 16:11 UTC 用户新增授权共享网页阶段0与独立文件交付底座，执行范围见唯一活动计划首节；新交互先评审，保留既有接入A–E边界。原接入开发出口继续按活动计划中的 33 项接入一致性要求执行。首次读取相关入口后，仅重读与当前变更有关的段落；历史计划、历史验收和已完成的模型切换不作为反复阅读或重新执行的要求。用户已撤销整组六条旅程验收门槛，不移到“最终验收”或其他阶段自动恢复；未来只有用户新的明确指令才可增加。当前不要求另一台电脑或另一 Mac 的安装验证。

本轮原型仍为体验参考，不代表真实能力；先补通用设施、再对齐配置并自查交互。逐家真实测试单列待用户，不为补旧证据提前启动或升级。

## Product Boundary

- Farfold is an independent product: one desktop UI for multiple external Agents. It is not an
  editor, not an Agent itself, and must not embed any Agent's own UI. Mature visual and interaction patterns may inform Farfold's own common UI.
- Each Agent owns its Agent loop, auth, provider/model integration, tools, permissions, history,
  compaction, steering, abort, resume, skills, and native config. Never implement a second Agent
  loop in Farfold; never fork or patch an upstream Agent or adapter.
- Farfold connects through official surfaces only: ACP (preferred), official SDK/CLI. It launches
  the process, sends requests, renders events, and persists only Farfold-owned metadata.
- A Session keeps one Agent, one native session, and its service source. Model and reasoning
  choices may change between completed requests when the Agent actually exposes them. Busy or
  uncertain work blocks changes; only confirmed and saved configuration becomes the next
  request and restore baseline. Historical messages are retained.
- LifeModel belongs to the user and Farfold, not to any Agent. Content may enter canonical
  LifeModel only through source evidence, an atomic Proposal, and explicit user approval.

## 通用接入纪律（对全部 Agent 生效，违反即打回）

1. Agent = `{id, command, args, env}`。兼容性 = ACP `initialize` 握手。**不得**校验二进制
   SHA、不得 pin 版本（registry 条目自带的下载归档 sha256 除外）、不得 `env_clear`、
   不得为 Agent 创建私有 HOME 或替它写配置文件。
2. 一套 UI：Thread/Composer/审批/Settings 只有一份实现；Agent 差异只能由
   `agentCapabilities`、`configOptions`、`authMethods` 及接入层验证过的官方服务配置能力驱动显隐。**禁止**新建 Agent 专属
   Panel 或按 Agent 写死 UI 分支；`acp_client` 之外不得出现 Agent 专属逻辑。
3. UI 用词以 `PRODUCT.md` §5 术语表为准；**禁用词**（Runtime、Host、ACP、原生、绑定、代次、
   投影、占用、Working Copy、Session、Turn、构建、引用、对账、沉降、上游、sidecar、adapter）
   不得出现在任何用户可见字符串。提交前
   检查 `src/runtime/strings.ts`、组件文案及直接展示的后端错误；内部标识符与注释不是 UI 文案。
   `corepack pnpm test` 包含集中字符串检查，但不能替代安装版错误路径检查。
4. 认证走协议 `authMethods`：`agent` 型调 `authenticate`，`terminal` 型用内嵌 PTY。
   Farfold 托管凭据存 Keychain，永不入库/日志；通过用户选定服务的官方环境或认证/配置接口交付。禁止将秘密放入会被外部启动诊断记录的配置对象。保存 API 不自动分发凭据，选择服务才授权本次使用；不得替 Agent 写用户配置文件。
5. Farfold 存储仅限 meta_store：会话索引（agent_id、cwd、native_session_id、标题、置顶、
   归档）、settings、LifeModel 数据。**禁止**重建 Turn/事件账本、会话绑定一致性表、
   locator/generation 体系。
6. 旧代码（阶段 1–5 的三个 adapter、runtime_registry、codex_installation、managed_provider、
   interaction_registry、三个 Panel 及其 runtime/* 模块）一律**彻底删除**，不留兼容层、
   fail-closed 占位或注释墓碑；删代码时一并删其专属测试。历史删除总账见 docs/archive/plans/2026-10-06-before-product-development.md。
7. 不新增 `env`/`VITE_*` 开关，不新增 QA/shadow 环境变量；测试钩子在测试文件内完成。
8. 单片文件 ≤1.5k 行；超出即拆模块。新增依赖须存在 ≥7 天，禁止 floating `latest`/`>=`。
9. 当前出口 = PRODUCT.md §3 的首批33项八项高标准；不漏、不多、不空、布局与行为一致是共用呈现要求，不是完整接入证明。先核官方配置与共用机制，补强后对齐33项并自行复核UI/UX；真实逐家测试待用户。代表与模拟结果仅证明实际覆盖路径，不冒称认证或全项通过。完成记录简记变更、提交、证据、未解决项和下一步。
10. 计划与契约冲突时以 `PRODUCT.md` 为准；实现发现契约错误时先报告用户，不擅自改契约。

## Development Rules

- 阶段1–5以macOS arm64为开发平台；完成后阶段6适配Windows，共用产品和数据保护规则不变。
- 保留 Agent 原生事件与未知 envelope：协议事件原样进事件总线，UI 只做归一化投影。
- 使用官方 `agent-client-protocol` Rust crate；仅执行 registry 条目或用户显式配置的命令；
  不从项目目录读取 Agent 启动配置。
- Keep one active Markdown plan（`plans/agent-access.md`）。
- 研发阶段本机只保留 `/Applications/Farfold.app`，开发与打包统一标识 `ai.farfold.desktop`；不另建 Dev/Test/QA 应用或应用备份，更新直接替换这一份。安装验证后移除重复 `.app` 产物；源码与验收证据保留。
- 文档对齐不等于功能修复或安装验收；契约与实现冲突写入 `docs/status.md`，不改低产品要求。
- 目录规则见 `docs/README.md`。旧证据归档；清理只操作明确属于本项目的具体路径，禁止按名称前缀扫删。
- `src-tauri/target/` 混有历史数据备份，不能整体清空；不要删除正式应用、Agent 配置或用户历史。
- Never log or commit provider credentials or API keys.

## Checks

```sh
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```
