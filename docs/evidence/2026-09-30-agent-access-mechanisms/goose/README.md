# Goose 1.52.0 模型读取失败调查（2026-09-30）

结论：安装与握手已由根任务在正式应用验证；模型读取失败有现有官方日志支持，属于缺少模型服务配置，记录为内部错误 `-32603`，不能把它当作协议 `AUTH_REQUIRED`。尚未完成官方配置、读取模型或首条消息的成功验证。

## 已有安装观察与最小诊断

- 根任务在安装版通过 `.tar.bz2` 安装 Goose 1.52.0 并连接；模型读取显示通用重试提示，截图见本目录上级的 `01-goose-install-entry.png`、`02-goose-installed-model-read-failed.png`、`03-goose-installation.png`。安装目标为 `registry:goose`，注册命令是受管目录 `install-CZRnMj/goose`，参数为 `acp`，无条目专属环境。
- 已存的握手方法为 `goose-provider` / `Configure Provider`，说明要求使用官方 `goose configure` 设置模型服务和凭据。方法声明本身不证明当前已登录或必须登录。
- 仅核对配置位置是否存在，没有读取凭据内容：默认 `~/.config/goose/config.yaml` 不存在，该目录为空。官方还支持环境和路径覆盖，因此此事实单独不能证明正式应用的全部有效配置缺失。
- 一次获准的最小探针只发送 `initialize` 与 `session/new`，没有 `authenticate`、`prompt` 或配置操作。探针在最后的本机元数据读取阶段因 SQLite 路径打开失败退出 `1`，未保存原始协议收据；不能写成探针整体成功。
- 从这次探针对应的现有官方日志 `/Users/tw/.local/state/goose/logs/cli/2026-09-30/20260930_173029.log` 恢复一条白名单诊断：`2026-09-30T09:30:29.898746Z`，`outgoing_actor` WARN，请求 `Number(2)` / `session/new`，日志错误码 `-32603`，同时含公开的 `Failed to resolve provider` 与 `GOOSE_PROVIDER` 缺项标记。未复制完整错误、环境、会话正文或其他日志。此收据证明官方进程记录了该失败，不能替代丢失的完整协议响应。

## 官方行为与副作用边界

Goose 固定标签 `v1.52.0` 的默认服务解析先读取当前 provider，再读取 model；缺少 provider 时直接产生带说明的内部错误。新建对话先创建 Goose 自己的会话记录，再配置服务，配置失败时尝试删除新记录。探针因此可能写日志、数据库和清理记录，不称为零写入；最终元数据读取失败也使本次完整前后清理核对缺失。没有再次启动探针或修改外部数据。[默认服务解析](https://raw.githubusercontent.com/block/goose/v1.52.0/crates/goose/src/acp/server.rs)、[新建与失败清理](https://raw.githubusercontent.com/block/goose/v1.52.0/crates/goose/src/acp/server/new_session.rs)、[配置读取](https://raw.githubusercontent.com/block/goose/v1.52.0/crates/goose/src/config/base.rs)、[路径覆盖](https://raw.githubusercontent.com/block/goose/v1.52.0/crates/goose/src/config/paths.rs)。

握手明确给出官方配置命令，并声明为 Agent 方法；不能因为说明中写了命令，就改解释成标准 Terminal 方法。官方 CLI 的 `configure` 入口可用于交互设置模型服务、模型和凭据，但本次没有运行，也未验证通过 `authenticate` 自动完成该配置。[握手声明](https://raw.githubusercontent.com/block/goose/v1.52.0/crates/goose/src/acp/server.rs)、[官方 CLI 入口](https://raw.githubusercontent.com/block/goose/v1.52.0/crates/goose-cli/src/cli.rs)。

## Farfold 应提供的恢复出口

目前 [pump.rs](../../../../src-tauri/src/acp_client/pump.rs#L239) 仅将标准认证错误码归为 `AUTH_REQUIRED`；其他错误保留诊断。[ui_error.ts](../../../../src/runtime/ui_error.ts#L3) 对这类英文诊断使用中文通用失败文案，所以只重连/重读不会补上缺失的模型服务配置。

应通过有官方出处且经过接入层核验的配方，提供用户显式发起的“配置模型服务”入口，在共用内嵌终端运行注册程序的官方 `configure` 命令，完成后按原目标重查并让用户重新读取模型。该交互会修改 Goose 自己的配置或凭据，必须由用户选择开始；Farfold 不代写配置、不自动交付已保存 Key，不从说明文字自动执行命令。若走环境交付路线，仍须先核实该服务的官方字段与兼容能力，并由用户选择服务授权本次交付。

缺少 provider 的当前失败适合展示配置恢复操作，不能伪报“登录要求已解决”。配置后模型读取、真实首发及续接仍需分别验证；本记录不把静态官方入口算作可用结果。
