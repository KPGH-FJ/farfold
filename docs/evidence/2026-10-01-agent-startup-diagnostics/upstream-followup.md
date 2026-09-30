# 四项启动失败：公开资料与后续调查

记录：2026-10-01 05:55（Asia/Shanghai）。本次只读核对已有证据、官方公开源码和发行元数据，没有启动 Agent、执行 npm 安装脚本、读取凭据/外部私有配置或原协议正文。生产源码与正式数据未修改，没有向外提交 issue/PR。

公开元数据重新读取时间为 `2026-10-01T05:49:55.429989+08:00`。下文把静态发现、历史安装结果和刚落盘的 `5b831c0` 安装复验分开；公开源码中的可能失败路径不能直接认定为本次原因。

| 条目               | 当前能确定的范围                                                                                                                   | 最小下一步                                                                                               | 尚不需要的条件                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Minion Code 0.1.44 | 官方 wheel 仍引用 SDK 0.12.1 已移除的公开符号；本次真实进程退出 1，未收到匹配握手响应并已回收。但本次实际解析的 SDK 版本尚无收据。 | 下一次受控调查先保留候选中公开发行元数据，核对实际 Minion/SDK 版本与固定 wheel；优先等待官方已发布修正。 | 不需要账号/Key；不得 pin SDK、加兼容符号或改外部包。   |
| Junie 3419.24.0    | 固定官方发布与目录入口一致；本次启动后在握手阶段结束，退出 1，未收到匹配握手响应，候选已回收。                                     | 若继续调查，保留实际候选的公开目录结构、执行权限、架构及随包运行环境信息，再和固定归档核对。             | 不先猜 Java、账号、参数拼写、隔离属性或补环境。        |
| Grok 1.0.45        | 历史结果为检查提前结束；固定 npm 包有平台程序、启动包装器和安装脚本，本次实际最终入口未核实。                                      | 新安全摘要加实际入口/平台包版本核对；下一次明确安装前保护官方已知配置路径的存在性与摘要。                | 不从早退猜账号；不能把候选删除等同于外部配置零写入。   |
| Factory 0.230.0    | 历史结果为检查提前结束；固定包的实际入口可能为平台程序或包装器。当前官方文档与历史目录的输出格式参数不同。                         | 先核对实际入口和新退出摘要；再向固定版本公开资料核实两种参数是否支持。                                   | 不直接改目录参数、关闭选定环境或套用 x64/Java 的解释。 |

## Minion：发行接口问题已知，本次实际依赖仍未知

本次重新读取 [Minion 的官方 PyPI 元数据](https://pypi.org/pypi/minion-code/json)，最新发行仍为 `0.1.44`，公开依赖仍为 `agent-client-protocol>=0.7.0`。其 wheel 上传于 `2026-03-15T04:26:48.495138Z`，摘要仍为 `501d2c176dc06e837dfc4d9c5608b8b760edc315a76d0ec184113d1ca0ef50df`。这与此前已下载并完整核验的 [固定 wheel 静态收据](../2026-10-01-agent-startup-errors/minion-wheel-static.json) 相同。

固定 wheel 的 `minion_code/acp_server/agent.py` 顶层导入 `ModelInfo`、`SessionModelState` 和 `SetSessionModelResponse`。此前独立检查的 SDK 0.12.1 没有这三个公开符号，见 [官方发行与符号核对](../2026-10-01-agent-startup-errors/official-release-check.json) 和 [旧独立检查边界](../2026-09-30-agent-access-uvx/minion/README.md)。本次重新读取的 [SDK 官方 PyPI 元数据](https://pypi.org/pypi/agent-client-protocol/json) 最新仍为 `0.12.1`，wheel 摘要为 `aaf3cc301ed87d9e2c4ccb91adfe1cd58784355f6ce7e513f50e7ca2391862ef`。

[当前官方 main 源码](https://github.com/femto/minion-code/blob/main/minion_code/acp_server/agent.py) 已不再导入这三个符号，但 main 的变化和源码中的版本字符串都不能证明 PyPI 已发布修复。未发现可据此替换目录 0.1.44 的新发布证据。

`5b831c0` 的 [本次安全摘要](protocol-after-minion.json) 中，最后一份连接摘要为 `failurePhase=initialize`、`startupOutcome=ended`、`initializeResponse=not_observed`、`initializeAccepted=false`；真实 Child 已回收，退出码为 `1`，没有退出信号，且退出已在我方 TERM 请求前观察到。进程组结束、连接移除、候选删除均已确认。[登记核对](minion-registration.json) 为未登记、候选目录为空。

这些事实支持“在握手完成前结束且回收完成”。本次候选已删除，没有实际解析依赖版本收据，也没有读取异常正文，因此不能将此次失败直接写成已经证实的 SDK ImportError。账号、模型与首条消息尚未进入验证阶段。

后续可执行范围：在下一次已授权调查中，只保留候选内公开 `.dist-info` 的 Name/Version、包摘要和固定公开入口信息，核对实际组合；不导入 Minion 来冒充纯读取，因为其模块初始化有本地目录副作用。不自动降级 SDK、不加 stub、不补写 Agent 配置。若固定发行仍没有修复，保留明确不可用和重试出口，等待官方发布或目录更新。

## Junie：入口相符，退出原因仍未知

本次重新读取 [官方固定 tag 3419.24](https://github.com/JetBrains/junie-acp-release/releases/tag/3419.24) 的发行元数据。macOS arm64 归档大小为 `334525087` 字节，官方摘要为 `267ba7373ac8df6c7e0b9553a55282a4e0b943790147b5bf89a72744449f5f85`，发布时间为 `2026-09-30T17:29:59Z`。该摘要用于公开来源核对，不新增 Agent 二进制版本准入或 SHA 门槛。

固定 tag 的 [staging 目录文件](https://github.com/JetBrains/junie-acp-release/blob/3419.24/registry-ga-staging.json) 同样声明 `./Applications/junie.app/Contents/MacOS/junie` 与 `--acp=true`；但其中归档 URL 是 staging 发布，不能替换本次 GA 归档。当前 [官方 ACP 文档](https://junie.jetbrains.com/docs/junie-cli-acp.html) 使用空格分隔的 `--acp true`，这不足以证明固定目录的等号形式无效。旧对照与未测项见 [Junie 历史只读诊断](../2026-10-01-agent-access-directory-batch5/junie-startup-diagnosis.md)。

`5b831c0` 的 [本次安全摘要](protocol-after-junie.json) 中，Junie 检查对应最后一份连接摘要为 `failurePhase=initialize`、`startupOutcome=ended`、未观察到匹配握手响应、未接受握手；真实 Child 启动并回收，退出码为 `1`，退出信号为空。我方请求过 TERM，没有请求 KILL，`exitObservedBeforeTerm=false`。进程组结束、连接移除与候选删除均已确认。[登记核对](junie-registration.json) 为未登记、候选目录为空。

`exitObservedBeforeTerm=false` 只说明观测顺序，不能说明 TERM 导致退出；两个发出的协议错误响应也不能说明 Agent 正在登录或缺模型，因为没有读取对应请求正文。原采样窗口没有捕获瞬时 Junie 子进程，真实退出事实来自唯一 Child 所有者的摘要。

[当前官方安装脚本](https://github.com/JetBrains/junie/blob/main/install.sh) 的 macOS 路线使用 `ditto`，并为官方 shim 设置若干变量、处理执行权限和隔离属性。Farfold 的 ZIP 路线已经使用 `ditto`；这些一般安装行为不是固定 3419.24 ACP 直接启动的额外要求证据，也不能据此自动补变量、清隔离属性、安装 Java 或执行修改用户路径的安装脚本。

后续先保留实际候选的非秘密文件结构、选定入口权限/架构、公开 bundle 运行环境信息以及签名/隔离属性存在性，再核对固定官方归档。缺少实际包内信息时，继续保留原因未知；不要改变目录 argv 来替代调查。

## Grok：先核对实际程序与安装副作用

历史 `959fc00` 的 [目录声明](../2026-10-01-agent-access-directory-batch4/catalog-targets.json) 为 `@xai-official/grok@1.0.45`、`agent stdio`，检查提前结束且没有登记，见 [登记核对](../2026-10-01-agent-access-directory-batch4/grok-registration.json) 与 [批次记录](../2026-10-01-agent-access-directory-batch4/README.md)。这不是本次 `5b831c0` 的复验结果。

只读核对 [固定官方 npm 元数据](https://registry.npmjs.org/@xai-official%2Fgrok/1.0.45) 与 [固定公开包装归档](https://registry.npmjs.org/@xai-official/grok/-/grok-1.0.45.tgz)：包要求 Node `>=20`，声明 `bin/grok`、`node bin/postinstall.js`，macOS arm64 平台包版本为 `1.0.45`。启动包装器会优先查官方已有程序路径，安装脚本也可能把入口替换为平台程序链接。因此包装包版本本身不能证明最终执行的程序身份与版本。

同一固定安装脚本包含读取/重写官方 `config.toml` 的安装来源字段，启动包装器也包含创建版本程序与更新官方链接的路径。当前 Farfold npm 安装命令没有显式禁用安装脚本，并继承现有官方 npm 设置；这只说明代码可能执行该安装路径，不证明本机发生过某次写入。候选目录已回收不能推出官方外部路径零写入。

最小后续是实际最终入口与平台包版本核对、新安全退出摘要，以及下一次明确安装前后的官方已知路径存在性/摘要保护；不读取配置内容、不另建 HOME、不执行脚本作为静态研究。[当前官方概述](https://docs.x.ai/build/overview) 提供 ACP 和账号使用说明，但没有固定 1.0.45 的真实认证声明收据，仍须以实际握手声明为准。

## Factory：当前文档差异需要固定版本验证

历史 `423aed4` 的 [目录声明](../2026-10-01-agent-access-directory-batch3/catalog-additional-targets.json) 为 `droid@0.230.0` 与 `exec --output-format acp-daemon`，并包含两个官方自动更新关闭变量；检查提前结束且未登记，见 [登记核对](../2026-10-01-agent-access-directory-batch3/factory-failed-registration.json) 与 [批次记录](../2026-10-01-agent-access-directory-batch3/README.md)。

[固定官方 npm 元数据](https://registry.npmjs.org/droid/0.230.0) 与 [固定公开包装归档](https://registry.npmjs.org/droid/-/droid-0.230.0.tgz) 要求 Node `>=20`，声明 `bin/droid`、`node install.js` 与 macOS arm64 平台包 `@factory/cli-darwin-arm64=0.230.0`。包装器完整转发 argv，并可能把子程序的空 status 处理为 0；但安装脚本通常会改成平台程序硬链接，不能把包装器可能掩盖信号当成实际旧失败原因。

[当前官方 IDE 文档](https://docs.factory.com/ide-integrations) 的手动 ACP 命令使用 `exec --output-format acp`，与旧目录的 `acp-daemon` 不同；[当前 CLI 参考](https://docs.factory.com/droid-cli/cli-reference) 没有给出这个旧参数的固定版本解释。这些当前文档不是 0.230.0 固定源码，只能作为需要核实的声明差异。

后续先核对实际平台程序/包装入口与新退出摘要，再寻找固定 0.230.0 对两种输出格式的支持证据。未经核实不改 registry argv，不套用 x64 AVX2 或 Java 的解释，也不把账号条件提前归为启动失败原因。

## 后续边界

安全摘要能区分启动事实、匹配响应类别、握手是否被接受、退出与回收；它不包含 stderr、正文、命令参数或环境值。`matched_error` 不能自动解释为账号/参数问题，`matched_result` 与解码接受是两步，候选删除只证明该受管候选目录清理完成。

下一片优先补 Minion 的实际公开依赖组合或 Junie 的实际归档结构证据。若没有官方可核实修复，保持失败、重试和未完成状态，不通过修外部包、降级依赖、猜模型或添加环境来制造连接成功。账号/付费条件只有在连接通过、真实认证声明需要时才单独列为用户条件。
