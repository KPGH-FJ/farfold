# macOS 第 12 周期续验

正式 Farfold 0.1.7，CDHash `77fb03ec0c2e336c4d9024e7b18ffe93f624daff`。逐家八项仍在同一验收清单。前一轮原件保留。 [逐家验收](../2026-11-15-cycle12-macos/acceptance-matrix.md) · [本批脱敏回执](live-results.json)

## Cursor 2026.11.13 前台命令停止通过

1. 在 Farfold 的「设置 → Agent 与账号 → Cursor → 管理程序与版本」走官方程序更新，核实选中 `2026.11.13`。仍使用现有 Cursor 账号和 Auto，旧 `2026.09.28` 安装保留。
2. 在新的自建目录发送一次请求。Cursor 申请运行 `/bin/sh ./wait-owned.sh`，从界面批准一次。该脚本启动 `sleep 55` 并等待，只有自然结束才写完成标记。独立观察记录两者同属进程组 9160，原 PID 为 9172、9174。
3. 确认两者正在运行后点击 Farfold「停止」。日志显示原请求取消发送后 12 毫秒收到无错误回应。独立观察在点击后 380 毫秒看到两个原进程均未再出现。原定 55 秒后没有完成标记，观察器未发送结束信号。应用显示回复已停，步骤结果未知。 进程原件（本机 `output/2026-11-15-cycle12-followup/cursor-process-evidence.jsonl`） · 官方目录与下载包（本机 `output/2026-11-15-cycle12-followup/cursor-official-candidate.json`）

正常退出 Farfold 后，冷开同一对话看到「此前请求结果未确认，未自动重发」。原 Cursor 服务和 Auto 保持。用一次明确的不调用工具的新消息，读回首条原标记 `FF_C12_CURSOR_NOV13_STOP_V1` 并完成。记录为一次 `session/load` 加一次手动 `session/prompt`，零 `session/new`。冷续答通过，旧步骤仍保留未确认。

旧版一次命令和子进程自然结束的失败仍保留。新版分项只覆盖测过的前台命令。双任务同时在途时的隔离和步骤实时终态仍待验。Cursor 对被监视的后台 Shell 明确说明，取消请求只结束当次等待，Shell 继续运行。当前文档没有提供 ACP 可精确结束该任务的接口。官方 TypeScript SDK 提供接入方持有 Shell 的选项，需分开核对账号、审批、会话和历史。 [Cursor CLI 更新记录](https://cursor.com/docs/cli/changelog) · [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)

## Copilot 与 Pi 历史预览

两家都用「所有对话 → 带入已有对话」和原工作文件夹找到了自建旧对话，并打开原始问题和回复。Copilot 返回当前 Auto，原选择仍无法确认。Pi 的原模型和推理等级也无法确认。两份均明确只读，未加入、无模型消息出站。继续旧对话仍待原使用身份和配置的证据。 [读取回执](live-results.json)

## 停止反馈与 fast-agent 候选

- 已在源码收窄回复取消文案，显示「回复已停止」。正文、对话库、导出以及工具终态分别保留各自证据。正式应用仍为该批之前的版本。
- 官方 ACP 终端候选覆盖局部终端创建审批、命令和参数展示、拒绝、原轮取消及自有进程组退出。受控样本实际终止 A 的进程组，B 仍完成，拒绝未启动命令，迟到创建遇到关闭后的准入限制。当前产品契约 §11 明定客户端终端代跑的边界，候选仅供受控测试，正式应用未声明这项能力。退出未知的清理和共享连接通知、超出自有进程组的工作、参数隐私仍须明确处理。 [当前产品契约](../../../PRODUCT.md) · [fast-agent 官方路径](../2026-11-15-official-alternatives/fast-agent.md)
- 本批前端构建和 10,937 项测试通过。Rust Clippy 通过，单元测试 2,780 项通过、10 项忽略，集成测试 10 项通过、1 项忽略。受控终端试验包含在 Rust 结果中。 前端测试（本机 `output/2026-11-15-cycle12-followup/frontend-tests.log`） · Rust 测试（本机 `output/2026-11-15-cycle12-followup/backend-full-tests.log`）

## 当批续接条件

- Gemini CLI、Antigravity、Autohand、Grok Build、Nova 需要在官方入口完成登录。Claude 需要原授权账号和服务。Nova 的协议权限差异仍须独立处理。
- Amp、Devin、MiniMax Code、Qoder CLI、siGit Code 需要经授权可复验的原对话标识和原工作目录。Amp 还需要厂商原版 CLI。正式入口能列出已有条目或显示当前模型时，仍要核原对象、原配置和续答。
- 该批 fast-agent 的客户端终端候选当时待明确产品契约；启用前处理进程终态未知、连接退出通知和参数隐私。Cursor 当前官方 ACP 未提供对已监视后台 Shell 的精确停止入口。

后续用户已批准 fast-agent 官方终端逐次审批，并开放现有原对话作为验收样本。账号、API 与补充历史结果见[续查](accounts-and-api.md)。

## 2026-11-16 双前台任务并发与停止

两条 Cursor 2026.11.13 对话使用原来源和 Auto，工作目录独立，各只批准一次 `/bin/sh ./wait-owned.sh`。独立观察确认两条 Shell 和各自的 `sleep` 同时在运行。只点 A 的停止，只有 A 发出 `session/cancel`。点击后约 168 毫秒，A 的两个进程已退出，B 的两个进程仍活着。随后 B 的成品标记落盘、工具退出码为 0、助手准确回复并显示完成。A 界面仍显示步骤结果未知。受监视的后台 Shell 停止和其他交错未覆盖。

首次尝试时，Cline 短测收到内部错误，连接保留结果未知。此时 A 等待批准，B 排队超时，协议日志中没有 B 的发送。当前准入设两个名额，内部错误没有协议停止原因，只有明确终态或归属进程组退出才释放名额。正式退出检查明确指向 Cline。正常保存退出后，该归属进程组结束。重开后 B 原草稿保留，明确点击后发出，完成上述双任务复验。当时尚缺单独回收。后来已在[新版正式实测](../2026-11-16-cycle12-failed-connection/README.md)。

Cursor SDK 的取消适用于它自己发起的任务。公开 SDK 路径使用独立认证和会话标识，默认无交互审批。正式 Farfold 仍走原 ACP 连接，受监视后台工具的精确停止尚缺可用的原会话官方入口。[双任务回执](cursor-foreground-pair-2026-11-16.json) · [Cursor 官方发布说明](https://prod.cursor.com/docs/release-notes) · [Cursor SDK](https://cursor.com/docs/sdk/typescript#limitations)
