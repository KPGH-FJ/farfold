# c39b05d 安装版复验

2026-10-01 00:41–00:51（Asia/Shanghai），在唯一正式应用 `/Applications/Farfold.app` 完成 Kilo 首次登录启动与取消、Amp 设置终端启动与取消、fast-agent 原目录安装、OpenCode 既有测试对话冷恢复与续答。未完成真实账号登录，也未发送 fast-agent 首条消息。

## 候选身份与检查

- 源码提交：`c39b05d501d96c89880dd983ff5190dbaad1c7d0`；[候选清单](candidate-source.json)冻结 398 项源码与构建输入。
- [安装收据](candidate-install.json)：00:41:04 安装，二进制 SHA-256 为 `610ec230d20cdb540f17f636a24dfc383d231dd01d7b4b030287fecf055fc634`，复制差异为空，签名检查通过。[退出核对](after-exit.json)仍为同一二进制，`sourceChanges=[]`。
- [完整前端检查](checks-frontend-final.json)：124 个文件、1,046 项测试通过，类型检查与生产构建通过。[完整 Rust 检查](checks-rust-final.json)：401 项通过、3 项原有忽略，fmt、clippy 通过。另见[全库格式](checks-format-final.json)和[打包收据](checks-bundle-final.json)。这些工程检查与下述真实旅程分别记录。

## 安装旅程

| 路径                              | 实际结果                                                                                                                                                                       | 证据                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kilo 读取模型后首次点击登录       | 直接启动已注册的 `kilo auth login`，PID 36024；未填写凭据，点击取消后该进程身份消失                                                                                            | [读取模型](01-kilo-models-before-first-login.png)、[首次启动](02-kilo-first-login-started.png)、[精确命令](kilo-target-first.json)、[取消界面](03-kilo-cancelled.png)、[取消后进程与数据](kilo-after-cancel.json) |
| Amp 登录设置                      | 启动已注册的 `amp-acp --setup`，PID 36178；未填写凭据，取消后该进程身份消失                                                                                                    | [设置终端](04-amp-setup-started.png)、[精确命令](amp-setup-target.json)、[取消界面](05-amp-cancelled.png)、[取消后进程与数据](amp-after-cancel.json)                                                              |
| fast-agent 启动输入校验           | 公开无效样例 `bad model` 保留在输入框，就地说明未保存，安装按钮禁用；这是界面校验，没有用该值启动 Agent                                                                        | [无效输入](06-fast-agent-invalid-model.png)                                                                                                                                                                       |
| fast-agent 原目录安装与模型读取   | 沿用目录及已有启动设置，未手选模型；0.10.1 安装、连接与模型读取完成，界面如实显示未提供可选模型。账号页展示 `Configure fast-agent` 声明，未点击登录、未发送消息                | [安装和模型页](07-fast-agent-installed-models.png)、[账号声明](08-fast-agent-auth-declaration.png)、[安装后快照](fast-agent-installed.json)、[已注册启动与包清单](fast-agent-package.json)                        |
| OpenCode 既有测试对话冷恢复、续答 | 恢复 `ses_f0e8e5a03ffeHDMo5rR4YFfsaM`，保留原 `OpenCode Zen / Nemotron 3 Ultra Free`；显式发送“只回复 FARFOLD-CWD-RESUME-OK，不要使用工具或读写文件。”，收到对应标记并正常结束 | [原模型与历史恢复](09-opencode-cold-restored-original-model.png)、[真实续答](10-opencode-resume-reply.png)、[恢复进程](opencode-resumed-processes.json)                                                           |
| 返回原稿                          | 返回普通新对话后 Amp 的 Medium 仍被选中，原未发内容相关字段保持                                                                                                                | [返回截图](11-original-amp-medium-preserved.png)、[字段核对](after-exit.json)                                                                                                                                     |

Kilo 这次是在模型读取后首次点击即启动登录，关闭准备稿后才运行认证的安装版反例已复验通过；提前取消竞态仍只由受控测试覆盖。Amp 的普通启动与取消也通过。两者均不能写成账号认证成功。

## 实际进程目录

[安装期间目录采样](cwd-install-watch.json)记录 fast-agent 候选检查阶段的 `/bin/sh` PID 36500 位于 Farfold 数据目录 `/Users/tw/Library/Application Support/ai.farfold.desktop`；正式连接的 Python PID 36575 位于该目录下的 `conversations`。前者对应候选 `initialize`，后者还执行了 `session/new` 读取模型；本轮 fast-agent 旅程不能缩写为仅握手。

[认证目录采样](cwd-auth.json)记录 Amp ACP 进程及 `--setup` 终端均位于 `conversations`，Kilo ACP 进程也在此目录。[冷恢复目录采样](cwd-restored.json)记录 OpenCode PID 36872 同样在 `conversations`；正式应用自身目录为 `/`。Kilo 登录终端 PID 36024 已在采样前取消，未取得其实际目录；短暂 Python 子进程 PID 36472 的目录查询失败，保留未知。安装观测没有读取进程完整环境，不把源码及受控测试的 HOME 保持结论写成这一轮重新实测。

## 请求、数据与退出

[脱敏协议元数据](protocol-metadata-final.json)共 5 个日志文件，只有 1 次发出的 `session/prompt`，属于上述 OpenCode 显式续答。fast-agent 有候选握手和正式连接后的模型读取，没有认证或消息请求。元数据不含正文或完整事件内容，不能单凭这份记录断言外部程序没有文件副作用。

相对[起点数据](data-before.json)及[未发内容摘要](unsent-before.json)，[退出核对](after-exit.json)确认：

- 原 26 条会话索引的核对字段没有变化或缺失，没有新增会话索引；原 9 个 Agent 记录没有变化或缺失。新增 fast-agent 的启动记录由[包核对](fast-agent-package.json)确认。
- `installations.v1`、`agentSetup.v1`、`unsentWork.v1` 变化，新增 `installPrevious.registry:fast-agent`。未发内容的 `composers`、`choice`、`feedback`、`queues` 及版本字段不变；`activity` 仅上述 OpenCode 测试对话变化。
- [累计进程清单](all-observed-processes.json)中的 10 个进程身份（含正式应用）在 00:51:17 均已结束。该结论覆盖已观察和跟踪的进程，不等同于穷尽任何瞬时或脱离的子进程。
- [重复应用删除收据](duplicate-cleanup.json)仅删除本轮 `src-tauri/target/release/bundle/macos/Farfold.app`；正式应用仍存在，二进制身份保持。

本片未记录全部外部 Agent 配置摘要，因此不以 Farfold 元数据未变证明外部配置全量未变。

## 保留的失败历史与未完成项

前一候选 Kilo 首点登录因准备稿远程关闭与认证争用而失败；预览已关闭后再次点击才启动正确目标，见[前片记录](../2026-09-30-agent-access-auth-target/README.md)及[第二次启动收据](../2026-09-30-agent-access-auth-target/kilo-target-second.json)。本次首次点击通过不改写前次失败事实。

fast-agent 此前的[安装失败](../2026-09-30-agent-access-startup-options/installed.md)也保留。本次生成的入口实际指向存在的 `fast_agent.cli.commands.acp:main`；`fast-agent-acp` 和 `fast-agent-mcp` 两个官方 0.10.1 包仍声明同名但不同目标的命令，包装包的 `fast_agent_acp.cli` 模块缺失，详见[包核对](fast-agent-package.json)。一次安装成功不能消除入口归属竞争风险，也不能将此前全部失败唯一归因于工作目录。

仍未验证：Kilo/Amp 实际账号登录、fast-agent 实际账号与首条回复、其他 Agent 的同类全流程、安装版提前取消竞态。OpenCode 的成功只覆盖本次既有测试对话及原模型，不能推广为全部 Agent 的恢复验收。
