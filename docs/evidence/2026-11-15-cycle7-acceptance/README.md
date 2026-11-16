# 第 7 周期正式候选与实际使用复验

2026-11-15，唯一应用 `/Applications/Farfold.app` 0.1.7 arm64，`ai.farfold.desktop`。以 `975f1c7ec` 和当前候选构建，核了 2,616 个产品输入。CDHash `7217aad3465e55912f95e78927bb7d1bfcf56a74`，文件 SHA-256 `1d8c64482d19962eb5ef425b827259d431ad5a3b133d0b5f0a72b4dcbb9dfdb5`。UI 实际列出 28 家。候选输入及回执（本机 `output/2026-11-15-cycle7-acceptance/candidate.json`）

原应用经正常入口保存退出，退出提示所涉的既有工作位置结果未知持久化字节与前次正式基线一致。原 Farfold 及其 OpenCode 连接均退出。安装前后三个数据根共 206,477 条按路径、类型、模式与文件内容摘要比对一致，私有元数据副本完整性核验通过。重复打包产物按已核五文件移除。正式安装（本机 `output/2026-11-15-cycle7-acceptance/install.json`） · 产物清理（本机 `output/2026-11-15-cycle7-acceptance/duplicate-cleanup.json`）

前端 784 文件 10,911 项通过，Rust 库 2,772 项通过、10 项忽略，另有 10 项集成通过、1 项忽略。类型、生产构建、Rust 格式和 Clippy 通过。本轮改动路径 Prettier 通过，仓库全量仍指出较早正式证据 `2026-11-13-cycle7-final/summary.json` 格式差异，原件保留。独立只读候选复核覆盖关闭、删除保护、冷态归档及首发范围。Windows 历史证据变更独立保留。前端（本机 `output/2026-11-15-cycle7-acceptance/frontend-tests.log`） · Rust（本机 `output/2026-11-15-cycle7-acceptance/rust-tests.log`）

## 原对话、归档和导出

- 从「搜索对话」按原标题找到自有 OpenCode 对话，回车打开同一原 ID，原正文和已保存的 Xiaomi MiMo v2.6 Flash / Build 可见。真实请求完成允许的自有终端工作，返回正确标记并引用原图片答复。搜索限 Farfold 已有对象。
- 手动归档后未归档数 14→13，从搜索找到标为已归档的同一对话，恢复后回 14，原正文保持。当前自然满 30 天的候选为 0。前一正式版自然满 1 天的自动归档证据见[原回执](../2026-11-13-cycle7-final/README.md)。
- Markdown 导出经原生选择器实际写入自有测试目录。独立读取为 2,531 字节，SHA-256 `96e101b32c05c2aba59b97ddb60b424a09a730c30da50e9242d044afc3e2794c`，含原测试标记和助手正文。Shift+Tab 从关闭到保存，Tab 返回关闭，Escape 后焦点回原对话操作。
- 在自有对话录入短草稿后正常退出。重开，从「所有对话」直接展开该行，归档、删除均禁用并说明有未发送内容。打开同一对话确认原草稿后，仅清本批自建文字。当前无仅持久化结束未知而无待发内容样本，该反例的最新证据为[受控复验](../2026-11-15-official-alternatives/README.md)。
- 用户在动作时明确授权删除唯一自有 OpenCode 测试对话 `FF_C7_MEDIA_20261113_`。从正式应用实际执行，14→13，正常标题搜索无匹配。按原 ID 独立只读核对 Farfold 索引及 OpenCode 的 `session`、`session_v2`、`message`、`session_message`、`session_part` 均为 0。和安装前副本比较只移除该索引，其他 13 条仍在。

## 两家并行与实际停止

- 两组用同一正式应用。从各家自有对话正常发起。Goose 沿原 OpenRouter Nemotron 3 Ultra (free)、off、auto。OpenCode 沿原 Xiaomi MiMo v2.6 Flash、Build。两家目录不同，每组各发一次无文件读写的命令请求。
- 第一组两家同时在途。Goose 点停显示「已停止」，冷开后当轮 shell 步骤存在。子进程实际终止未独立确认，OpenCode 在点停前已完成，给出正确标记及原上下文。
- 第二组交换停止对象。04:08:30 UTC 已观察到 OpenCode 的 shell 62152、sleep 62153 与 Goose 的 shell 62168、sleep 62169 共存。04:08:36.766 UTC，从目标 OpenCode 对话点「停止」，界面显示「已停止」。04:08:37.041 UTC 只剩 Goose，独立 `ps -p 62152,62153` 退出 1 且无行。Goose 继续约 48 秒、正常结束并返回末尾标记。冷开后两条均无运行状态，Goose 三个原未发意见仍在。同家双对话保持原取证条件。进程时间线（本机 `output/2026-11-15-cycle7-acceptance/pair-process-timeline.jsonl`）
- Goose 本家单独补验。04:17:36.626 UTC 捕获 `shell` 63438 和 `sleep` 63439。04:17:43.824 UTC 点停止后，Farfold 显示「回复已停止，仍有步骤未确认结束」。04:17:50.303 UTC 独立 `ps` 仍看到 `63439 1 sleep`。该有界自有进程随后自然退出。此样本的实际工具停止失败。Goose 进程时间线（本机 `output/2026-11-15-cycle7-acceptance/goose-stop-process-timeline.jsonl`）

本轮所选 Goose 安装为 1.52.0。核定厂商 1.59.1 源码对每条自有 shell 任务创建专属进程组，取消时由 Goose 自身终止该组。后续先核官方候选和原服务选择，再从同一 Farfold 按钮实测子进程终态及对话隔离。当前证据为厂商源码及旧版实测反例。[Goose 官方实现](https://github.com/aaif-goose/goose/blob/v1.59.1/crates/goose/src/agents/platform_extensions/developer/shell_process.rs#L10-L78)

## 提醒、显示与余项

- 首次静音测试提醒已交系统。后经用户授权临时开启声音，04:15:03.472 UTC 发送一次无模型测试提醒。用户现场明确「看到了，也听到了声音」，测试后确认偏好恢复关闭。意外中断仍缺可安全归属的在途样本。
- 应用 150% 时导出、焦点、原对话操作和提醒设置实际可用。系统缩放至 1920×994，拖动未取得 900×620。正常冷开回 1280×820。按原要求补精确窗口等其余条件。旁白依用户决定暂缓。
- 第 7 周期五家已有接入增量或具体依赖。CodeBuddy、Devin 原读取失败，Dirac 原目录缺失，Factory 未知受保护，Cline 缺有原 ID 及原目录的自有样本。纯媒体未读、意外中断及其他适用历史来源分别待证。[当前状态](../../status.md)
