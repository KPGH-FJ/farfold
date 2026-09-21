# Farfold

Farfold 是面向 macOS Apple Silicon 的多 Agent 桌面工作台，为外部编程 Agent 提供统一的会话、任务状态、审批和产物界面。Agent 自己负责推理、工具执行、认证、模型和历史；Farfold 不实现第二套 Agent loop。

当前版本号为 0.1.7。源码已经接入 OpenCode、Codex、Pi 的 ACP 路径，具备内部试用的主体功能；仍有明确的可靠性与数据保护缺陷，尚未完成全部安装版旅程验收。版本号相同不代表二进制相同。

## 从这里开始

- [产品契约](PRODUCT.md)：要提供什么体验、边界及六条验收旅程。
- [当前状态](docs/status.md)：实际实现、验证层级、未解决问题。
- [源码架构](docs/architecture.md)：从入口追到接入、会话、存储和生命周期。
- [内部使用说明](INTERNAL-USE.md)：当前接入方式、使用限制和数据位置。
- [唯一活动计划](plans/runtime-neutral-lifemodel.md)：下一步工作与出口，不以历史完成声明代替验收。
- [目录说明](docs/README.md)：当前文档、设计规格、证据与历史的分工。

## 开发

需要 macOS arm64、Rust 工具链、Xcode Command Line Tools，以及可运行 Corepack/pnpm 的 Node 环境。项目锁定 pnpm 9.15.0，依赖按 lockfile 安装。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

默认启动 Farfold Dev（`ai.farfold.desktop.dev`），使用独立于正式版的 Application Support 目录。开发构建拒绝使用正式版标识。Agent 的用户 HOME、登录与配置仍由 Agent 自己管理，不因 Dev 隔离而变成一份独立认证。

接入 Agent 不再依赖 `prepare:runtimes` 或捆绑 Pi。OpenCode 可直接使用本机 `opencode acp`；Codex 和 Pi 经目录安装对应 ACP 包。npm 安装所需 Node 优先复用本机，否则由应用下载到自身数据目录。具体链路见[源码架构](docs/architecture.md)。

## 检查与打包

```sh
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

`pnpm build` 只生成前端。内部 macOS 应用使用：

```sh
corepack pnpm tauri:build:internal
```

产物位于 `src-tauri/target/release/bundle/macos/Farfold.app`。打包不会自动替换 `/Applications/Farfold.app`；本地签名与工程检查也不是产品验收。交付需记录源码提交、工作区差异、应用身份及六条真实旅程的证据。

## 开发边界

改动前阅读 [AGENTS.md](AGENTS.md)。LifeModel 当前仅有静态设置页、默认关闭的设置键和空注入钩子，不提供真实采集或注入。旧架构、旧交付声明与设计探索集中于 [docs/archive](docs/archive/README.md)，不能作为当前操作指令。
