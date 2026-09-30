# Junie 3419.24.0：安装检查早退的只读诊断

2026-10-01。只读本批目录、公开登记、界面结果、无正文协议元数据、Farfold 安装/启动源码及官方发行资料。未运行 Junie、其他 Agent 或应用，未读取凭据或用户配置，未下载 319 MB 发行归档，未改源码或安装数据。

**结论：本次未取得 initialize 完成结果，未登记且候选已回收；尚无证据将失败归因于归档执行权限、目录布局或 Java 缺失。**目录给出的 ZIP、包内入口及参数与官方固定发行声明一致，Farfold 的 ZIP 解包方式也符合官方当前安装脚本的建议。实际失败归档未保留，不能由这些静态一致性证明其内部文件和系统依赖有效。

## 本次事实与错误边界

- [实际目录](catalog-targets.json)于 04:08:14 观察，缓存取得于 04:07:45：`junie@3419.24.0`，macOS arm64 ZIP 为 `junie-release-3419.24-macos-aarch64.zip`，命令 `./Applications/junie.app/Contents/MacOS/junie`，参数仅 `--acp=true`，公开目录环境为空、未声明归档 SHA-256。
- [实际结果](junie-result.txt)与[截图](04-junie-startup-failed.png)显示“连接在检查完成前结束，请检查程序后重试”，安装按钮恢复。[04:15:53 登记核对](junie-registration.json)为 `registered:false`、`directories:[]`；只读该 Agent 的受管父目录也未找到剩余候选或归档。
- [无正文协议元数据](protocol-metadata-final.json)中时间相符的 `protocol-v1-1790799294652-5.jsonl` 有一次 outgoing initialize 和两条 outgoing protocol-error response，没有 incoming initialize response 或 session/new。这里只记录方向、字节数及错误类别，不能确定那两条响应对应的请求或实际终止原因；未读取其正文。
- [04:13:11–04:13:31 采样](cwd-junie-install.json)和[安装中观察](junie-installing.json)未采到 Junie 进程，不能据此证明没有瞬时子进程、确定其实际 cwd 或退出码。候选检查的源码路径使用应用资料目录；它不是已登记对话的工作目录。

此固定中文来自 [ui_error.ts 第 12–15 行](../../../src/runtime/ui_error.ts#L12) 的 `AGENT_CONNECTION_ENDED`，与实际 OS spawn 失败的 `AGENT_START_FAILED` 分开。[初始化分类](../../../src-tauri/src/acp_client/initialization.rs#L24)允许连接关闭或收据发送端结束得到前者；它不能诊断具体的系统依赖或远端拒绝。没有原始错误收据时，不把早退写成“缺 Java”或“权限错误”。

## 归档和官方发行的静态对照

[固定 GA 发行 3419.24](https://github.com/JetBrains/junie-acp-release/releases/tag/3419.24)提供同名 macOS arm64 ZIP。[官方资产列表](https://github.com/JetBrains/junie-acp-release/releases/expanded_assets/3419.24)列出 319 MB 文件及公开 SHA-256 `267ba7373ac8df6c7e0b9553a55282a4e0b943790147b5bf89a72744449f5f85`。这只核对发行来源；本次实际下载字节未保留，未声称与该摘要相同，也不以二进制摘要作为 Agent 接入准入。

[固定 tag 的 staging 目录](https://raw.githubusercontent.com/JetBrains/junie-acp-release/3419.24/registry-ga-staging.json)也声明 `Applications/junie.app/Contents/MacOS/junie` 和 `--acp=true`。该文件的下载链接属于 staging，不能替换本批实际 GA URL。当前[官方 ACP 使用说明](https://junie.jetbrains.com/docs/junie-cli-acp.html)提供 `junie --acp true`；不能因示例采用空格就推断固定声明中的等号写法无效。

Farfold 的 [ZIP 分支](../../../src-tauri/src/agent_install/archive.rs#L18)用 `/usr/bin/ditto -x -k` 解包完整目录，不扁平化或只复制启动文件。[二进制安装](../../../src-tauri/src/agent_install.rs#L94)按声明解析入口并核实 canonical 路径留在候选目录，随后对所选入口设 `0755`；该 chmod 结果目前被忽略，这是一般源码边界，尚不是本次已复现原因。实际 [进程启动](../../../src-tauri/src/acp_client/process.rs#L93)原样传 argv、增量环境和该连接 cwd，未创建私有 HOME 或清空继承环境。

当前[官方通用 CLI 安装脚本](https://raw.githubusercontent.com/JetBrains/junie/main/install.sh)第 52–61、916–943 行强调 macOS 使用 ditto 保留权限/符号链接/扩展属性，同样识别上述 app 入口并 chmod；另有 best-effort quarantine 移除。其管理用 shim 还提供 `EJ_RUNNER_PWD`、`JUNIE_DATA`、`JUNIE_SHIM_PATH`。这是当前通用安装路径的差异，**未证实为固定 3419.24 直接 ACP 入口的必要条件**，不能据此增加环境、删除隔离属性或替 Agent 写配置。该脚本没有系统 Java 安装/检测步骤，但这同样不能证明 ZIP 一定自带完整运行环境。

核对上述五个 Farfold 后端文件与[本批正式候选源码摘要](candidate-source.json)，全部相同；本批二进制属于 `0a725e0`。工作区另有并行前端标签修改，不将其算作本次安装行为或新修复。

## 仍未知与最小下一步

| 问题                                                            | 本次边界                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| ZIP 内完整目录、符号链接、其他文件执行位及内嵌运行环境          | 候选和归档已回收，未取得实际文件清单，未知               |
| 应用签名、quarantine、加载器/动态库或系统 Java 是否导致退出     | 没有对应固定错误或只读文件证据，未知                     |
| 实际退出码、具体关闭点及两条 outgoing error response 的请求归属 | 元数据无正文，未知                                       |
| 是否需要官方 shim、不同启动位置或官方账号配置                   | 固定目录直接声明包内入口；本次未测其他路线，不猜测或替换 |

后续如授权再次诊断，先在同一官方候选回收前保留非秘密的归档清单、模式/符号链接、公开 bundle/runtime 清单及签名/扩展属性名称，核对实际入口；不扩大扫描到其他安装。需要启动时再明确一次 initialize-only 的精确 argv、cwd、继承环境边界、退出码与安全固定错误分类，不发 session/new、authenticate 或 prompt，不保存完整 stderr。现有证据不足以提出权限、Java 或目录补丁，本次未执行这些后续动作。
