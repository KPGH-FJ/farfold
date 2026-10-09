# Farfold

Farfold 是独立的多 Agent 桌面工作台，用同一套对话、任务状态、审批和内容界面进行编程、写作、阅读与普通交流。Agent 自己负责推理、工具执行、认证、模型和历史；Farfold 通过官方接口启动进程、发送请求、呈现事件，不实现第二套 Agent loop。

当前内部版本为 **0.1.7**，本机使用 macOS Apple Silicon；Windows 源码适配已有实现，实机运行另验。**原型 07 已于 2026-10-09 接入正式代码并安装复查**，包括工作台、Agent 管理、消息与对话操作、设置和历史界面。当前安装身份与验证范围见[当前状态](docs/status.md)，同一版本号不代表相同二进制，也不代表全部能力通过。

首批目录保留 **29 项 Agent**，完整接入按[产品契约的八项标准](PRODUCT.md#3-当前接入完成标准)判断。目录数量、接口声明、原型、工程检查、安装界面和真实 Agent 工作分别记证；逐家真实账号与模型测试待用户配合。原整组六条旅程门槛已撤销，不作为交付要求自动恢复。公开分发、正式签名及更新渠道按用户决定延后，不是当前开发门槛。

- 默认进入新对话，可以先写无工作文件夹草稿；发送或需要文件操作时再选择工作位置，不回退到应用默认目录。
- 分组、收藏和所有对话用于整理记录，分组不改变工作位置。搜索覆盖已登记元数据，当前对话查找覆盖已呈现内容，不宣称跨历史全文搜索。
- 从“探索 Agent”准备或管理 Agent，不必先选项目；认证按实际需要进行，模型短消息测试可选，准备完成返回草稿而不自动发送。
- 首次接纳消息后保留同一 Agent、服务来源与历史；模型和推理可在安全空闲时按真实能力切换，确认且保存后生效。
- 已有对话经 Agent 官方接口查找和恢复；正文、继续使用、停止和恢复能力分别验证，未知结果不当作成功。

## 从这里开始

- [产品契约](PRODUCT.md)：产品边界、页面规则与当前八项接入标准。
- [当前状态](docs/status.md)：实际实现、验证层级与未解决问题。
- [源码架构](docs/architecture.md)：入口、接入、会话、存储与生命周期。
- [内部使用说明](INTERNAL-USE.md)：操作流程、使用限制与数据位置。
- [唯一活动计划](plans/agent-access.md)：当前执行清单与延期范围。
- [目录说明](docs/README.md)：当前文档、唯一设计原型、证据与历史的分工。

## 开发

本机 macOS 开发需要 Rust 工具链、Xcode Command Line Tools，以及可运行 Corepack/pnpm 的 Node 环境。项目锁定 pnpm 9.15.0，依赖按 lockfile 安装。Windows 适配及验证范围见[源码架构](docs/architecture.md#windows-平台适配2026-10-06)。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

开发和安装统一使用 Farfold（`ai.farfold.desktop`）及同一份应用数据，不维护 Dev/Test/QA 应用。运行开发模式前先保存工作并正常退出已安装的 Farfold。Agent 的 HOME、登录与配置仍由 Agent 自己管理。

本机只维护 `/Applications/Farfold.app`；替换前准备候选与证据，并按既有约定确认用户已保存工作、应用正常退出。安装验证后移除重复应用产物。不要整体清空混有历史数据备份的 `src-tauri/target/`。

接入使用本机已有程序或官方目录的安装方式，保留 OpenCode、Codex、Pi 的已有发现入口，并按当前29项范围提供目录条目。npm 所需 Node 优先复用本机，否则下载到应用数据目录。安装、连接、认证和实际请求分别判断。

## 检查与内部打包

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

产物位于 `src-tauri/target/release/bundle/macos/Farfold.app`，不会自动替换正式应用。交付记录源码提交、工作区差异、应用身份、数据保留和本次实际验证范围；本地 ad-hoc 签名、工程检查不替代产品验收，也不等于已具备公开分发条件。

## 开发边界

改动前阅读 [AGENTS.md](AGENTS.md)。Farfold 不代写 Agent 配置、不创建私有 HOME、不实现客户端文件或终端工具替 Agent 干活。文件查看、交付与登录终端沿各自明确范围工作。

LifeModel 仅有静态设置、默认关闭的设置键和空注入钩子，不提供真实采集或注入。编辑器、多窗口、Linux、移动端和远程项目等范围见产品契约。旧架构、旧交付声明与设计探索见 [docs/archive](docs/archive/README.md)，不得据历史记录续接当前任务。
