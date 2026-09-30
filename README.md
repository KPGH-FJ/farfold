# Farfold

Farfold 是面向 macOS Apple Silicon 的多 Agent 桌面工作台，用同一套对话、任务状态、审批和内容界面进行编程、写作、阅读与普通交流。Agent 自己负责推理、工具执行、认证、模型和历史；Farfold 不实现第二套 Agent loop。

当前版本号为 0.1.7。本轮按已认可的完整工作台原型在现有 Farfold 上增量开发，新工作台、全局 Agent 准备和已有对话带入已接生产能力，并完成本机可执行的安装复验；完整六旅程和外部能力缺项继续保留。实际安装身份、真实服务与恢复的失败及未测分支统一见[当前状态](docs/status.md)；版本号相同不代表二进制相同。

- 默认进入新对话，普通交流使用应用自己的稳定工作目录；需要处理已有文件时再选择资料文件夹。
- 分组、收藏和所有对话用于整理记录，分组不改变工作目录。
- 从“探索 Agent”发现和准备 Agent，不必先选项目；准备后回到草稿，在输入区选择模型来源及实际可用模型。
- 已有对话通过 Agent 提供的接口查找、预览后加入。官方目录收录不代表每个条目都已完成安装、登录、模型请求或恢复验证。

## 从这里开始

- [产品契约](PRODUCT.md)：要提供什么体验、边界及六条验收旅程。
- [当前状态](docs/status.md)：实际实现、验证层级、未解决问题。
- [源码架构](docs/architecture.md)：从入口追到接入、会话、存储和生命周期。
- [内部使用说明](INTERNAL-USE.md)：当前接入方式、使用限制和数据位置。
- [唯一活动计划](plans/agent-access.md)：下一步工作与出口，不以历史完成声明代替验收。
- [目录说明](docs/README.md)：当前文档、设计规格、证据与历史的分工。

## 开发

需要 macOS arm64、Rust 工具链、Xcode Command Line Tools，以及可运行 Corepack/pnpm 的 Node 环境。项目锁定 pnpm 9.15.0，依赖按 lockfile 安装。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

开发和安装统一使用 Farfold（`ai.farfold.desktop`）及同一份 Application Support 目录，不再维护 Dev/Test/QA 应用。运行开发模式前先退出已安装的 Farfold。Agent 的 HOME、登录与配置仍由 Agent 自己管理。

本机只维护 `/Applications/Farfold.app`，更新直接替换这一份，安装验证后移除重复应用产物。当前安装身份和整理结果以[当前状态](docs/status.md)为准；不要将历史副本作为当前候选，也不要整体清空混有历史数据备份的 `src-tauri/target/`。

接入使用本机已有程序或官方目录提供的安装方式，延续 OpenCode、Codex、Pi 的已有路径并扩展官方目录条目。npm 安装所需 Node 优先复用本机，否则由应用下载到自身数据目录。安装可用性、连接、认证与实际请求分别判断，具体链路见[源码架构](docs/architecture.md)。

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
