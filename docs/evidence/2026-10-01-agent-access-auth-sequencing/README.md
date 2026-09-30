# 登录收尾、提前取消与实际进程目录

本片针对前一安装候选 Kilo 读模型后首点登录失败，统一等待准备稿关闭后才登录，并修正提前取消与关闭回执的顺序。同候选纳入 Agent 子进程真实工作目录修复。源码 `c39b05d` 已于 2026-10-01 00:41 安装到唯一正式应用 `/Applications/Farfold.app`，00:51 正常退出；398 项冻结输入未变。具体身份、截图、数据与未完成项见[安装总结](installed.md)。

## 源码与工程检查

- [前端](frontend.md)：原目标准备稿严格收尾，所有账号动作共用；关闭失败保留重试，取消通知失败也不重新启动。模型、来源和原稿保持。
- [后端](backend.md)：环境读取前后核对同一取消意图，PTY 沿同一 owner 回收；真实关闭成功在释放锁后返回。仅严格准备稿清理允许已确认关闭的幂等重试，不吞查找错误或放行未知结果。
- [进程目录](../2026-10-01-agent-process-cwd/backend.md)及[独立审查](../2026-10-01-agent-process-cwd/review.md)：普通连接和候选检查分别采用既定目录，不回退父目录；冷恢复继续保护原模型与推理。
- [完整前端检查](checks-frontend-final.json)：124 文件、1,046 项通过，类型与生产构建通过。
- [完整 Rust 检查](checks-rust-final.json)：401 项通过、3 项原有忽略；fmt 和 clippy 通过。
- [候选输入](candidate-source.json)、[格式](checks-format-final.json)及[打包](checks-bundle-final.json)：398 项源码与构建输入冻结；[安装收据](candidate-install.json)与[退出核对](after-exit.json)确认同一二进制及输入集合。

## 安装结果与边界

- Kilo 已读取模型后，首次点击即启动精确的已注册 `kilo auth login`；Amp 的 `--setup` 也正常启动。两者普通取消后对应进程均退出，未填写凭据，未完成账号登录。
- fast-agent 0.10.1 沿原目录及已有启动设置安装、连接并读取模型；没有手选模型、登录或发送消息。界面诚实显示没有可选模型。官方包同名入口竞争仍存在，见[包核对](fast-agent-package.json)。
- fast-agent 候选检查进程位于数据目录，正式连接进程位于普通对话目录；Amp 设置终端、OpenCode 恢复进程目录符合当前目标。Kilo 登录终端目录未采到，不补作推断。
- OpenCode 既有测试对话以原 Nemotron 模型冷恢复，显式发送一次中文无工具标记请求并收到对应回复；之后回到原 Amp Medium。共 5 份[协议元数据文件](protocol-metadata-final.json)，只有这 1 次消息请求。
- 原 26 条会话、9 个 Agent 记录以及原未发内容的草稿、选择、反馈、队列均保持；新增 fast-agent。设置变化与测试对话活动单列在[退出核对](after-exit.json)。累计跟踪的 10 个进程身份均结束，[本轮重复应用](duplicate-cleanup.json)已精确移除。

提前取消竞态只有受控测试，不能用普通界面取消替代；本片没有全量外部配置摘要，不声称外部配置全部未变。Kilo/Amp 真实账号登录、fast-agent 首条回复及全目录旅程仍未验收。前片 Kilo 首点失败、fast-agent 安装失败与本次成功分别保留，见[安装总结的历史与边界](installed.md#保留的失败历史与未完成项)。
