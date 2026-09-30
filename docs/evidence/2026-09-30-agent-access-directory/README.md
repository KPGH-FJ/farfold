# 目录扩展补验：Kilo 7.8.1

日期：2026-09-30，观察范围 22:38–22:48 CST。本轮复用已安装的 `a1bb4c5`，唯一正式应用 `/Applications/Farfold.app` 的主程序 SHA256 为 `ef89d81b06c44b18ade7da21d1bea07b07d5961380432529c7ff6c85b30acc8c`。这是同一安装候选的新增目录样本，不是重新打包或安装工作区中的启动模型参数改动；身份见 [本轮收据](candidate-install.json)，对应 [原源码冻结记录](../2026-09-30-agent-access-preparation-return/candidate-source.json) 与 [原安装记录](../2026-09-30-agent-access-preparation-return/candidate-install.json)。

## 实际结果

Kilo `7.8.1` 的 macOS arm64 ZIP 安装、连接和模型读取已测成功；认证、模型实际请求和续接未测。首次从管理入口进入时实际仍走接入流程，安装后自动切换模型页并执行 `session/new`，不能称 initialize-only 或无外部记录副作用。

| 观察               | 结果与边界                                                                                                                                             | 证据                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 安装前             | 显示尚未安装、0 份安装及安装按钮                                                                                                                       | [截图 01](01-kilo-before-install.png)、[界面文本](01-kilo-before-install.ax.txt)、[安装前快照](kilo-before.json)        |
| ZIP 安装与模型读取 | 已连接；界面自动显示 `Kilo Gateway/Google: Nano Banana Pro (Gemini 3 Pro Image)`，并显示已读取当前模型选项。没有手动选择模型、短测或点击“使用此 Agent” | [截图 02](02-kilo-install-state.png)、[完整模型名称](02-kilo-install-state.ax.txt)、[连接后快照](kilo-connected.json)   |
| 账号页             | 显示 `Login with Kilo`、`Run kilo auth login in the terminal` 说明及“在终端登录”按钮；没有点击该按钮或完成登录                                         | [截图 03](03-kilo-auth-entry.png)、[界面文本](03-kilo-auth-entry.ax.txt)、[真实声明投影](kilo-declaration.json)         |
| 程序清单           | 显示一份 Farfold 管理的 7.8.1 程序，受管目录为 `agents/registry:kilo/install-GOo2nt`，实际启动为该目录下的 `kilo` 加 `acp`                             | [截图 04](04-kilo-installation.png)、[界面文本](04-kilo-installation.ax.txt)、[已注册启动与声明](kilo-declaration.json) |
| 返回原稿           | 原 Amp 仍为已有设置 / Medium；没有把 Kilo 默认显示值确认到原稿                                                                                         | [截图 05](05-original-amp-choice.png)、[界面文本](05-original-amp-choice.ax.txt)、[退出核对](after-quit.json)           |

[协议元数据](protocol-metadata-final.json)覆盖本轮 3 个日志文件，计有 3 次 `initialize`、2 次 `session/new`、0 次 `session/prompt`、0 次 `authenticate`。其中包括原 Amp 连接与 Kilo 安装检查/连接；文件数不是 Agent 覆盖数。元数据不保存请求正文或原始错误内容。没有新增 Farfold 会话索引不代表未创建外部准备记录，后者本轮未审计。

## 已确认但尚未修复的登录目标问题

真实握手的 `kilo-login` 未显式指定 `type`，旧 `_meta.terminal-auth.command` 为 `opencode`。安装版实际显示了终端登录入口，说明该错误声明已进入公共认证界面；本轮没有运行它。

只读核对 `a1bb4c5` 的 `auth.rs` 与 `acp_client/manager.rs` 已确认：旧终端元数据存在时，解析器将方法分类为终端，执行分支会搜索该裸命令并把完整参数交给 PTY；保护范围仍是 Kilo。若点击现有按钮，会尝试执行 `opencode auth login`，而不是已注册 Kilo。manager 又因旧终端元数据存在而拒绝协议认证路线。因此这是安装版入口加源码确认的问题，不能写成“已实际运行错误程序”或“登录实测失败”。

官方 `v7.8.1` 的 [认证源码](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/service.ts#L88-L139)同时包含该不一致声明，且 `authenticate` 只核对方法 ID 后返回空结果；空结果不能作为账号或请求成功证明。此前的 [静态核对](../2026-09-30-agent-access-mechanisms/kilo/README.md)保留原静态层级，本轮不重写其未运行事实。

后续修复需统一核验旧终端目标及协议方法语义，保留标准 Terminal 优先规则和已核实伴随程序；不能从 description 解析命令或对所有 Agent 作名称替换。具体实现与回归待启动参数候选冻结后再安排，本轮未改认证源码。

## 数据与退出

[起点](data-before.json)含 26 条 Farfold 会话、7 个原 Agent 配置及 16 项设置；[原未发送字段](unsent-before.json)只记录保护所需摘要。[22:48:32 退出核对](after-quit.json)确认：

- 原 26 条会话、原 7 个 Agent 配置无改变或缺失，未新增 Farfold 会话索引；Kilo 新安装不被概括成“Agent 总数仍为 7”。
- `installations.v1` 与 `agentSetup.v1` 有变化，新增 `installPrevious.registry:kilo`；不能宣称全部设置不变。
- 原未发版本、输入稿、选择、反馈、队列和活动字段无变化。
- 本轮跟踪的正式应用、Amp、Kilo 共 3 个进程身份均已结束，未见这些身份残留；退出时正式二进制摘要仍一致。此核对不扩大为所有外部用户数据或全部进程的审计。

本轮没有新打包或新增重复 `.app`，没有以工作区源码检查替代正式候选身份。Kilo npm 分发、安装取消/失败重试、多安装回选、真实登录、免费模型选择与首发、停止/审批及冷恢复仍未测；ZIP 安装与模型读取成功不关闭整条接入路线、全目录或 J1–J6。
