# 第 12 周期 Copilot 子进程与 Dirac 官方权限续验

2026-11-18，macOS arm64。Copilot 从正式 Farfold 0.1.7（`2b3bf2dd7`）的正常新建和停止入口验收。Dirac 的第一批使用当前登记的官方程序与项目锁定的 Rust SDK。

## Copilot 双前台实停

1. 两个自建工作文件夹分别准备只等待并写结果的脚本。两条新对话均沿用 GitHub Copilot 1.0.112 的已有设置及 Auto。各手动发一次请求，只对对应命令及程序路径点单次批准。
2. 15:40:45.339 独立系统采样同时观察到 A 的原 Shell 16615 和子进程 16620，以及 B 的原 Shell 16257 和子进程 16262。按进程号、父进程、进程组及启动时间核对。
3. 仅在 A 对话点「停止」。Farfold 于 15:40:56.569 发取消，Copilot 记录 `user_abort`。15:40:56.668 首次采到 A 的两个进程均已不存在、B 的两个原进程继续运行。下一次采样再确认，A 在原自然截止前退出且无成品。
4. B 未收到取消，原命令自然结束并写出 36 字节成品。对话显示退出码 0 及准确标记，与官方记录、成品独立核对一致。

A 的工具未送结束报告，正式界面仍提示「回复已停止，仍有步骤未确认结束」。本批确认短前台工作实际停止及双任务隔离。10 月原 Auto 对话的未知结果、旧错误反馈和后台任务仍按原条件核验。

[观察摘要](copilot/summary.json) · [点击前快照](copilot/will-click-stop-a.json) · [原始进程采样](copilot/process-observations.jsonl) · [B 成品](copilot/B/result.txt)

原始定位为 Farfold 日志 `protocol-v1-1794987541250-1.jsonl:24`、`protocol-v1-1794987414304-0.jsonl:54`，Copilot 官方会话 A `ccef6e89-5ecd-4696-94da-284beaf1852a/events.jsonl:16`、B `f811816c-77cf-41d7-be83-46af51c5f621/events.jsonl:15,19`。本页只归档自有脚本、进程观测及自有成品。

## Dirac 官方 SDK

重跑未留下结果的 SDK 探针。官方 SDK 2.2.0 的 `UntypedMessage` 保留两条方法名，Dirac 0.6.0 在隔离环境回报两项能力。以原会话定位所属目录，能读回规则并移除一条合成允许规则，同目录其他规则及另一目录规则仍在。退出 0，零模型调用。 [SDK 回执](dirac-sdk.json)

部署写入仍有官方限制。0.6.0 按工具、模式及操作匹配并删除所有相同条目，目标不存在也返回成功。规则在同一工作文件夹的对话中共用。官方未提供原子版本检查，读改写跟随符号链接，删除规则后的生效取决于其他规则及批准设置。SDK 的受控删除只覆盖合成样本。

## Cline 与 Pi 并行核对

Cline 本机 3.0.74 的 `history --json` 禁用正文加载，工作目录参数仍未传到持久层的列表查询。打开服务及查询过程中都会检查和纠正失联任务状态，缺少只读保证。厂商的独立历史脚本仍先按 ID 合并，不能安全补上精确目录发现。后续需要官方只读列表，按完整原目录过滤，并保留冲突条目供核对。已有精确 ID 载入的证据保持。 [Cline 固定版本参数传递](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/session/session.ts#L103-L115) · [打开持久层](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/sdk/packages/core/src/runtime/host/host.ts#L116-L130) · [官方脚本](https://github.com/cline/skills/blob/26378461e978f2b4e2e6d67b57121b86b2a79ba5/skills/cline-session-search/scripts/search_sessions.py#L172-L248)

Pi 本机选用与官方登记仍为适配器 0.0.34，本轮查到的官方 MCP 转发 PR 仍未合并。该路径目前保持待验。 [官方登记](https://raw.githubusercontent.com/agentclientprotocol/registry/main/pi-acp/agent.json) · [官方变更](https://github.com/svkozak/pi-acp/pull/164)
