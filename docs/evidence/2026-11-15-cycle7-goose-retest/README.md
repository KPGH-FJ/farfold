# 第 7 周期 Goose 新版停止与补充验收

2026-11-15（北京时间）。测试通过已安装的 Farfold 0.1.7，CDHash `7217aad3465e55912f95e78927bb7d1bfcf56a74`。

## Goose 官方更新与真实停止

- 从 Goose 的程序设置选「重新下载 / 更新」。首次报下载失败，复核注册目录和官方归档的有效 HTTPS 回包后重试。正式界面显示选中 1.59.1，另列可保留的 1.52.0 安装。官方历史库原 67 个会话 ID 和 312 个消息 ID 仍全部存在。[官方发行](https://github.com/aaif-goose/goose/releases/tag/v1.59.1) · 只读复查（本机 `output/2026-11-15-cycle7-goose-retest/durable-recheck.json`）
- 新对话沿选定的 OpenRouter Nemotron 3 Ultra (free)，思考 off。只发一条有界的自有 shell 任务，命令不读写文件。停前 shell 66700 和 sleep 66701 都在运行，进程组同为 66700。北京时间 12:33:03.186 从正式 Farfold 点「停止」，12:33:03.433 两个进程均不再存在。独立 `ps` 查两个 PID 无行，Goose 主进程的路径核到 1.59.1 安装。停止时间线（本机 `output/2026-11-15-cycle7-goose-retest/stop-process-timeline.jsonl`） · 独立 PID 复查（本机 `output/2026-11-15-cycle7-goose-retest/stop-independent.json`）
- **本次 shell 及其子进程实际停止通过。** 界面仍提示「回复已停止，仍有步骤未确认结束」。Goose 原历史为同一请求保存「执行完成前中断」，该记录本身不含进程终态。官方流在取消后略过后到事件，Farfold 当前未收到这条工具的实时结束回执。继续保留工具未知状态，旧 1.52.0 实测子进程继续的反例保持。[Goose 进程收口](https://github.com/aaif-goose/goose/blob/v1.59.1/crates/goose/src/agents/platform_extensions/developer/shell_process.rs#L10-L78) · [Goose 事件转发](https://github.com/aaif-goose/goose/blob/v1.59.1/crates/goose/src/acp/server.rs#L1944-L1987) · [旧版反例](../2026-11-15-cycle7-acceptance/README.md)

## 只含未知结果的冷态保护

新版原对话 `20261115_1` 自然保存 `outcomeUnknown=true`，待发、草稿及文件意见均为 0。正常退出重开，未打开对话正文前，从「所有对话」展开该行操作。归档、删除都禁用，提示「有操作结果尚未确认」。读后仍保持未归档和原 ID，未发起删除。另有旧 Goose 的 3 条未发意见保持原样。只读复查（本机 `output/2026-11-15-cycle7-goose-retest/durable-recheck.json`）

随后打开同一测试对话。正式界面从官方历史回放显示「有步骤未成功」，技术详情为 `Tool call was interrupted before completing`，并准确提示「此前请求结果未确认，未自动重发」。原未知保护继续，未点「已知悉」。

## 后台 PNG 与冷开未读

OpenCode 沿已选 Xiaomi MiMo v2.6 Flash。在同一自有对话中，公开 W3C 截图尝试的许可窗口超时，未取得图像，随后关闭页面并收回本次权限。改用同工作目录中新建的 99 字节 32×32 合成 PNG，只执行一次原生 `read`。任务在途时切离对话到设置页。

12:40:44.912 首次观察到未读 1→2，同一轮原生记录出现图像，已存的可读助手文字仍为 0。后续持久化记录出现助手文字。正式应用正常退出后冷开未读仍为 2，打开原对话并完成载入后回 1，可展开该次工具的图片。证据覆盖这条后台 PNG 的媒体先到持久化、原图展示、冷开及单条清除。没有独立采集最早一帧实时文字流，仍需区分严格无文字的触发。媒体时间线（本机 `output/2026-11-15-cycle7-goose-retest/media-local-timeline.jsonl`）

## 其他原条件

旧正式应用 900×620 的长草稿和窄屏关闭分项仍有证据。本轮从 1280×820 拖动未取得最新候选的精确 900×620。五家登记无输入变化，分别保留原样本、目录、确认状态及已实测失败。自然满 30 天的目标仍为 0。此前现场已听到测试提醒，真实在途中断须单独验。[旧尺寸原件](../2026-11-03-preview-and-windows/macos-draft-and-focus-formal.json) · [本批状态](../../status.md)
