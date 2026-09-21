# Farfold AI Coding Entrypoint

This repository is the only writable checkout for Farfold.

## Read Order

1. `AGENTS.md` (this file)
2. `PRODUCT.md` — 唯一产品契约（旅程、页面、术语、文案、出口标准）
3. `docs/architecture.md` / `docs/status.md` — 源码入口、当前实现、已验证结果与未解决问题
4. `plans/runtime-neutral-lifemodel.md` **第 00 章** — 唯一活动计划；`docs/archive/` 为历史，不得据此续接
5. `.design/2026-09-16-redesign/F-prototype.html` — UI 规格；示例数据不代表已实现能力
6. Task-relevant source — 对实际行为的判断以当前源码及对应验证为准，不以计划完成声明代替

## Product Boundary

- Farfold is an independent product: one desktop UI for multiple external Agents. It is not an
  editor, not an Agent itself, and must not embed or imitate any Agent's own UI.
- Each Agent owns its Agent loop, auth, provider/model integration, tools, permissions, history,
  compaction, steering, abort, resume, skills, and native config. Never implement a second Agent
  loop in Farfold; never fork or patch an upstream Agent or adapter.
- Farfold connects through official surfaces only: ACP (preferred), official SDK/CLI. It launches
  the process, sends requests, renders events, and persists only Farfold-owned metadata.
- A Session binds to one Agent and one native session at creation. Model selection is allowed
  in a draft before its first admitted message; established and restored sessions keep their model.
- LifeModel belongs to the user and Farfold, not to any Agent. Content may enter canonical
  LifeModel only through source evidence, an atomic Proposal, and explicit user approval.

## 阶段 6 纪律（对全部 Agent 生效，违反即打回）

1. Agent = `{id, command, args, env}`。兼容性 = ACP `initialize` 握手。**不得**校验二进制
   SHA、不得 pin 版本（registry 条目自带的下载归档 sha256 除外）、不得 `env_clear`、
   不得为 Agent 创建私有 HOME 或替它写配置文件。
2. 一套 UI：Thread/Composer/审批/Settings 只有一份实现；Agent 差异只能由
   `agentCapabilities`、`configOptions`、`authMethods` 驱动显隐。**禁止**新建 Agent 专属
   Panel 或按 Agent 写死 UI 分支；`acp_client` 之外不得出现 Agent 专属逻辑。
3. UI 用词以 `PRODUCT.md` §5 术语表为准；**禁用词**（Runtime、Host、ACP、原生、绑定、代次、
   投影、占用、Working Copy、Session、Turn、构建、引用、对账、沉降、上游、sidecar、adapter）
   不得出现在任何用户可见字符串。提交前
   检查 `src/runtime/strings.ts`、组件文案及直接展示的后端错误；内部标识符与注释不是 UI 文案。
   `corepack pnpm test` 包含集中字符串检查，但不能替代安装版错误路径检查。
4. 认证走协议 `authMethods`：`agent` 型调 `authenticate`，`terminal` 型用内嵌 PTY。
   Farfold 托管凭据只允许作为可选 env 注入，存 keychain，永不入库/日志。
5. Farfold 存储仅限 meta_store：会话索引（agent_id、cwd、native_session_id、标题、置顶、
   归档）、settings、LifeModel 数据。**禁止**重建 Turn/事件账本、会话绑定一致性表、
   locator/generation 体系。
6. 旧代码（阶段 1–5 的三个 adapter、runtime_registry、codex_installation、managed_provider、
   interaction_registry、三个 Panel 及其 runtime/* 模块）一律**彻底删除**，不留兼容层、
   fail-closed 占位或注释墓碑；删代码时一并删其专属测试。删除总账见计划 00.6。
7. 不新增 `env`/`VITE_*` 开关，不新增 QA/shadow 环境变量；测试钩子在测试文件内完成。
8. 单片文件 ≤1.5k 行；超出即拆模块。新增依赖须存在 ≥7 天，禁止 floating `latest`/`>=`。
9. 每片出口 = **安装版 `/Applications/Farfold.app` 上真人走通 `PRODUCT.md` §3 旅程并留截图**；
   单测/mock/合成 fixture 不是出口。完成记录只写提交号、截图路径、删除证明，不写流水账。
10. 计划与契约冲突时以 `PRODUCT.md` 为准；实现发现契约错误时先报告用户，不擅自改契约。

## Development Rules

- macOS arm64 only（本阶段）。
- 保留 Agent 原生事件与未知 envelope：协议事件原样进事件总线，UI 只做归一化投影。
- 使用官方 `agent-client-protocol` Rust crate；仅执行 registry 条目或用户显式配置的命令；
  不从项目目录读取 Agent 启动配置。
- Keep one active Markdown plan（`plans/runtime-neutral-lifemodel.md` 第 00 章）。
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
