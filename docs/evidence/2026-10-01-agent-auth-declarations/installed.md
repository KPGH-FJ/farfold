# 安装版验证：旧认证声明与终端路线

2026-10-01，核对已有正式应用截图与安全收据后整理；本文没有新增应用、Agent、认证或请求操作。候选提交 [`959fc00f6b5a04cef295370126aa27974a806d19`](candidate-source.json)，唯一正式应用为 `/Applications/Farfold.app`，二进制 SHA-256：`6f66b86187a70d21a75f6b76baead0e6a27a0a85dc45807a1d189202b53f6226`。

[安装收据](candidate-install.json)记录 02:41:26 完成替换，四个指定文件与打包结果一致、签名检查退出 0；[启动前核对](before-launch.json)记录 411 个输入无变化。应用进程实际于 02:48:38 启动，见[进程身份清单](all-observed-processes.json)，并非安装时间即开始运行。

## 真实观察结果

| 路线                  | 本次已验证                                                                                                                                              | 证据及范围                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepAgents 旧环境声明 | Anthropic 与 OpenAI 两项分别显示公开变量名及不能直接配置的说明；没有普通登录按钮，不把旧方式伪装为 API 交付                                             | [截图 01](01-deepagents-environment.png)、[Anthropic 界面文本](deepagents-environment.txt)、[OpenAI 界面文本](deepagents-openai.txt)。只查看声明，没有输入密钥或执行普通登录                                                     |
| DeepAgents 明确重查   | 点击重新检查后旧 DeepAgents 进程 `63076` 被替换为 `63211`，原 Amp `62980` 保留；新声明仍是只读出口                                                      | [截图 02](02-deepagents-rechecked.png)、[重查前](deepagents-connected.json)、[重查后](deepagents-rechecked.json)。重查只证明连接与声明更新，不证明账号有效或实际请求恢复                                                         |
| DimCode 标准 Terminal | 启动内嵌终端后，实际注册基础参数 `acp` 与方法参数 `acp --auth-setup` 逐字追加，形成两个 `acp`；node 与 bun 父子登录进程在取消后结束，原正常连接父子仍在 | [截图 03](03-dimcode-terminal-started.png)、[截图 04](04-dimcode-cancelled.png)、[公开登记](dimcode-registration.json)、[实际参数](dimcode-launch-targets.json)、[取消后](dimcode-after-cancel.json)。没有去重参数或宣称完成设置 |
| Amp 旧终端扩展        | 启动注册的 `amp-acp --setup`，登录进程 `63811` 在取消后结束；原 Amp 正常连接 `62980` 保留                                                               | [截图 05](05-amp-terminal-started.png)、[截图 06](06-amp-cancelled.png)、[启动目标](amp-launch-target.json)、[取消后](amp-after-cancel.json)。没有输入或保存 Key，取消说明仍保留账号状态待核对                                   |
| 返回原稿              | 回到原 Amp 新稿，Medium 仍为原选项，输入区为空；没有替换 Agent 或自动发消息                                                                             | [截图 07](07-original-medium.png)、[截图 08](08-original-draft.png)。这不是已有对话续答或真实回复验收                                                                                                                            |

本次 OS cwd 收据显示 DeepAgents、DimCode 正常连接/终端父子和 Amp 正常连接/终端均位于原资料文件夹 `conversations`，应用自身 cwd 为 `/`。见 [DeepAgents](cwd-deepagents-connect.json)、[DimCode](cwd-dimcode-login.json)、[Amp](cwd-amp-login.json)。本轮没有另做跨目录或 API 来源的真实登录操作。

## 数据、进程与候选边界

[原始摘要基线](data-before.json)为 29 条会话索引、20 个 Agent、29 项设置。[退出前](before-exit.json)和 [03:08:08 退出后](after-exit.json)均没有新增会话，没有原会话或 Agent 配置字段变化/缺失；设置只变化 `agentSetup.v1`，没有新增设置键。未发内容的版本、输入、选择、文件意见、队列和活动字段摘要均未变化。此处核对的是基线脚本列出的元数据字段，不扩称外部 Agent 配置或账号状态零写入；握手公开快照及更新时间不在原 Agent 配置摘要内。

[最终协议元数据](protocol-metadata-final.json)有 4 个本次连接文件，出站 `session/prompt` 为 0，`authenticate` 为 0；只保留类别、方向、字节数与固定错误分类，没有正文。协议中有新建/读取动作，不能将这次旅程称作只执行 initialize，也不能由没有请求推断账号已可用。

[观察清单](all-observed-processes.json)汇总 9 个具体进程身份，包含应用、原 Amp、重查前后 DeepAgents、DimCode 正常连接父子、DimCode 登录父子和 Amp 登录进程。[退出后收据](after-exit.json)没有应用后代，按 PID、启动时间与程序核对的旧身份也全部不在；这不扩成其他用户进程已清理。

[03:03:14 的核对](amp-after-cancel.json)仍显示 411 个输入与候选清单一致。之后下一片新增 `category_guard_tests.rs` 及修改 `acp_client/mod.rs`，在退出前/后收据的 `sourceChanges` 中明确列出。正式二进制摘要始终相同；不称源码在整个退出观察期间冻结，也不把下一片工作区测试算入该安装候选。

[重复产物删除收据](duplicate-cleanup.json)只移除本次 `src-tauri/target/release/bundle/macos/Farfold.app`：删除前四个指定文件一致，删除后该副本不存在，正式应用仍存在且摘要相同。Auggie 待批删除项本轮未操作。

## 未完成与证据限制

本次真实安装验证了旧环境说明、两种终端路线的启动/取消、精确重查保留其他连接、返回原稿和退出保护。没有凭据输入、账号成功、Key 保存/选择/交付或真实请求；DeepAgents 此前实际请求失败原因仍未知。未知类型、跨 cwd/API 隔离、畸形声明与秘密 canary 只有[受控后端证据](backend.md)及[前端回归](frontend.md)，没有本轮真实目录旅程证据。

官方实验 `env_var` 已移除；本片只是旧发行的诚实兼容出口，不能称为实现当前标准 EnvVar。其范围见[官方说明](official-auth-scope.md)；源码与受控证据的独立审查见 [review.md](review.md)。目录全覆盖、完整账号路线与首发/续接均未因本次局部成功计作完成。
