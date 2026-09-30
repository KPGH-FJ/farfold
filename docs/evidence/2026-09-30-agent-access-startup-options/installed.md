# 启动模型审阅安装验证

2026-09-30 22:54–23:01，源码 `0b6d74c`，正式应用 `/Applications/Farfold.app`。主程序 SHA256 `3525b983c77d3c9293dc82bde36c9338f6aa0f740b5a6e51d5759871dac7ade0`；[388 项冻结输入](candidate-source.json)、[安装复制与签名](candidate-install.json)及[退出核对](after-quit.json)一致。前端 123 文件 / 1,024 项、Rust 359 项通过（3 项既有忽略），类型、构建、fmt、clippy、格式与打包通过。检查收据分别为 `checks-frontend-catalog-final.json`、`checks-rust-final.json`、`checks-format-final-2.json` 与 `checks-bundle-final.json`；第一次格式检查指出四份前片 JSON，仅修格式后通过，原失败日志保留。

## 已测成功的操作

- fast-agent 程序页展示可选启动模型、官方说明、参数预览和目录公开默认 `codexplan`，初始输入为空。目录值没有被填成用户选择，见[初始界面](01-model-options.ax.txt)。
- 输入无秘密的无效样本 `bad model` 后就地提示格式错误、禁用安装，见[截图 02](02-invalid-model.png)。随后仅作为界面样本输入 `$system.default`，暂离再进入时逐字保留，预览为 `["-x","--model","$system.default"]`，见[截图 03b](03b-model-return-visible.png)。**没有用这个样本执行安装或模型请求**。
- 明确清空后，预览恢复 `["-x"]`，说明沿用目录与已有设置；随后执行一次真实安装。检查失败后仍显示尚未安装、0 份安装，允许后续重试；[候选目录](fast-candidate-cleanup.json)为空，原 Agent 行和程序收据未变，没有注册失败候选。
- Goose 已有程序的连接没有被安装字段阻塞。官方配置程序启动后直接取消，未向终端输入、保存账号或密钥；到模型页显示明确重新读取要求，主动读取仍失败，该要求保持，见[截图 05](05-model-recheck-required.png)、[截图 06](06-model-recheck-failed.png)。这证明提示和失败保护，不证明配置成功。
- 返回原 Amp 空白草稿，Medium 仍选中，没有确认另一个模型，见[截图 07](07-original-amp-selection.png)。

## 已测失败与未测

fast-agent 0.10.1 按官方目录包 `fast-agent-acp==0.10.1`、`-x`、公开环境默认 `FAST_AGENT_MODEL=codexplan` 及本机既有设置安装时，**连接检查失败**，见[真实结果](04-fast-install-result.ax.txt)与[错误截图](04b-fast-error-visible.png)。本轮没有用户模型覆盖。旧探针省略该环境的 Model Configuration Error 不足以解释这次失败；继续从启动环境、入口及精确初始化条件定位，不宣称新字段修复了原失败。

真实用户覆盖模型的安装、已注册 fast-agent 的更新及历史回选、成功认证、首发与续接未测。声明变化、严格后端校验、收据逐字保存、取消与迟到提交等反例具有源码/受控测试证据，没有制造正式数据库记录冒充安装旅程。

本轮发现新增模型输入框在浅色界面仍使用系统黑底，已列入下一窄片样式修正。Kilo 登录错误目标仍属于前片已确认问题，下一候选处理，不把本候选称为已修复。

## 数据与退出

起点为 22:50 的[数据基线](data-before.json)，包括 26 条会话、8 个 Agent 配置、17 项设置；此前 22:11 基线单独保留。[退出核对](after-quit.json)确认原会话、原 Agent 行与原未发各字段摘要无变化，无新增 Farfold 会话索引；仅 `agentSetup.v1` 变化，对应本轮准备进度，不声称所有设置都没变。

[协议元数据](protocol-metadata-final.json)共 3 个文件、0 次 `session/prompt`。Goose 模型读取使用真实准备 `session/new`，不能称没有外部准备记录；该类外部记录与秘密未作完整审计。正常退出后，本轮观察到的正式应用、Amp、Goose 连接及配置终端共 4 个进程身份均已结束，不将采样扩大为所有短暂子进程的穷举。

仅删除本片生成的重复 `src-tauri/target/release/bundle/macos/Farfold.app`，正式应用保留且签名和摘要通过，见[删除证明](candidate-cleanup.json)。完整目录、阶段一出口及 J1–J6 仍未完成。
