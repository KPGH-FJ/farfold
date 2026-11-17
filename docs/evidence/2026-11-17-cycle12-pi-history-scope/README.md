# 第 12 周期 Pi 设置回报与历史范围

2026-11-17，macOS arm64。前序正式版 `/Applications/Farfold.app` 0.1.7 对应 `86bb5f853`，CDHash `72bb689a04befbfe5ecc22460e326732a38347d4`。早期查找及配置诊断均为零模型请求，后续真实 Pi 发送在下文单列。

## Goose 和 Qoder 查找范围

从「所有对话 → 带入已有对话」选择 Goose。默认范围可见合成测试样本。明确指定 Qoder 自有测试目录 `/private/tmp/farfold-cycle12-presend.8VI0pG`，Goose 返回没有找到。切回 Goose 原工作目录 `/private/tmp/farfold-c8-owned-worktree-czpsy78y/base`，查到 `FF_C8_B_20261115 shared.txt`，对应原 ID `20261115_4`，显示「已加入」、实际返回位置、对话列表中的原位置和「打开已有对话」。

更换至 Qoder CLI 1.1.89 后查询范围回到 Qoder 自己的默认范围。此时界面显示本次操作未完成，详情为「查找未完成，请检查 Agent 的准备状态后重试」。`protocol-v1-1794905307001-9.jsonl` 协议层收到列表回包。同一登记的官方程序只读复现，默认范围返回 28 条，全部 `cwd` 为空，明确指定原目录返回 5 条，每条位置齐全。正式版中指定 Goose 原工作目录，Qoder 返回没有找到。再选自己的原目录，返回准确的原样本 `ecfce092-d3d4-48e6-906b-bcc43b3e2676`，显示「已加入」、正确原位置和「打开已有对话」。 [列表规范](https://agentclientprotocol.com/protocol/v1/session-list#listing-sessions)

切回 Goose 自动恢复 Goose 原位置、查找结果及原选中项，未混入 Qoder 数据。退出向导前后本机索引均 118 条，两个指定原 ID 各保留一个索引。六份 `protocol-v1` 日志 `1794905200973-6`、`1794905271920-7`、`1794905284996-8`、`1794905307001-9`、`1794905389585-10`、`1794905431541-11` 各一次官方 `session/list`，没有 `session/load`、`session/new`、`session/prompt`。本轮覆盖已加入对象的查找和跨 Agent 范围隔离。分页、首次带入及默认范围失败继续跟踪。 [Goose 前序回执](../2026-11-15-cycle12-pre-send/history-continuations-2026-11-16.json) · [Qoder 前序回执](../2026-11-15-cycle12-pre-send/qoder-history-cline-smoke-2026-11-16.json)

## Pi 新目录复现

Pi 0.87.1 / pi-acp 0.0.34。重启后先从原自有草稿核对设置差异，仍报告旧 `mode` 未提供。随后在从未出现过的独立目录 `/private/tmp/ff-c12-pi-fresh-b-l06es6et` 打开草稿。模型选择器确认原 OpenRouter Nemotron 3 Ultra 免费版已选，只在草稿切到 Nemotron 3 Super 免费版再选回 Ultra 免费版。`protocol-v1-1794905076883-5.jsonl` 一次 `session/new`、三次 `session/set_config_option`、零 `session/prompt`。

诊断正式版 `63d697420`、CDHash `40d8cb55200e71af3955c0d35f22ed5ed74ac0e5`，在第二个新目录 `/private/tmp/ff-c12-pi-fresh-a-mf3iw5qm` 复测。`protocol-v1-1794906081996-0.jsonl` 第 10/12、15/17、20/22 帧的同次更新和设置响应一致。Ultra 回报三档含 Off、Medium、High，Super 回报三档含 Off、Medium、未提供 High。截图可见 Ultra 三档，实际选 Medium 并确认保存，控件回显 `Thinking: medium`。先前据辅助功能树仅有一条选中行而判断菜单只有 Off 的结论撤回。零模型请求。

Pi 新草稿另有真实缺陷。保持上述已确认的 Medium，填入自有未发标记，界面仍显示「发送已暂停」、发送禁用。该位置没有设置暂停规则，Agent 在 `session/new` 后先报告一条纯文本启动说明（同一诊断第 5 帧先于设置和任何发送），程序释放配置暂停时误把说明当作已有工作。启动说明所示 `pi v0.80.5` 来自适配器另外运行 PATH 中的 `pi --version`；同一次实际会话由已登记的 0.87.1 启动程序执行。 [前序正式与受控对照](../2026-11-17-cycle12-copilot-pi-vibe/README.md#pi-新草稿与原配置)

## 修复后的正式版

`a80ebc772` 保留有有效原位置的查找结果和原游标，对缺位置的条目作明确提示，并继续阻止其预览或加入。`0b7195dd3` 允许同一新草稿在首次发送前、已经确认设置时释放自己的配置暂停；纯文本启动说明保留，旧对话、已经尝试的发送、有待发内容及未知结果的相关保护保留。前端 786 文件 10,986 项测试通过，Rust 2,821 项通过及 11 项既有忽略，格式、类型、Clippy 和生产包通过。

两次正式安装均从正常保存退出完成，保留旧自有 H17 样本的未知结果。两次各核三处数据共 263,005 项前后摘要一致，SQLite 副本完整。当前正式版 0.1.7 对应 `0b7195dd3`，CDHash `f5d15afc17616ba38f266b53afdf9d8e1e76f5ee`，二进制 SHA-256 `749bd4d3b40a475ecdf4c13d110f9732a18e73b19e0eecb2994348590ca44e75`。签名复核后只移除各自构建目录中的旧重复应用。

Qoder 默认范围现在提示「Agent 返回的 28 条记录缺少有效的原文件夹。请选择原文件夹重新查找」，没有假空页或加入操作。明确选择原目录后仍找到原已加入样本，位置准确。`protocol-v1-1794907029934-3.jsonl`、`protocol-v1-1794907046659-4.jsonl` 各一次 `session/list`，零发送、加载、新建。默认范围的原位置仍待 Qoder 官方提供。

Cline 3.0.74 从同一正常入口显示「Agent 不提供已有对话列表」。按 ID `1794814385032_IEsyY_cli` 和原目录 `/private/tmp/farfold-c12-cline-delivery.gyKUGW9p` 读取时提示已在列表，避免重复处理。另从正常搜索打开 `FF_C12_CLINE_FILE` 后读回原用户正文和位置。`protocol-v1-1794907066020-5.jsonl` 零列表、读取及发送，另从搜索打开的 `protocol-v1-1794907144223-6.jsonl` 一次加载、零发送及新建。原索引仅一个。当前官方脚本先按 ID 合并，再按目录子串过滤，仍不能代作精确查找。 [Cline 官方脚本](https://github.com/cline/skills/blob/26378461e978f2b4e2e6d67b57121b86b2a79ba5/skills/cline-session-search/scripts/search_sessions.py#L172-L248)

## Pi 本机任务、双前台停止和冷续答

新版打开前序自有草稿，原未发文本与 Medium 恢复，启动说明仍显示，发送按钮可用。两个独立工作目录都沿用已有 OpenRouter 服务和 Nemotron 3 Ultra 免费版、Medium。原程序记录的 `model_change`、`thinking_level_change` 与实际助手回合的提供方和模型对应。A 原 ID `01a1e8ca-f739-7649-bd87-c0b645c4f8fb`，B 原 ID `01a1e8ca-b058-734b-841e-f4748b7569ce`。两条各手动发一条请求。

17:16:29，A Shell 和 sleep 为 11157、11158，B 为 11105、11106。核对各自目录、父子及进程组。17:16:37.871 仅使用 Farfold 停 A，界面显示回复已停止。17:16:47，A 两个原进程均已退出，B 两个原进程身份、组及目录仍相同。B 后续独立写出 `result.txt`，界面显示已完成及 `FF_C12_PI_FRESH_B_DELIVERED`，成品 SHA-256 `56cc774606d5f06adc0675ce64d0e9c50e7f24b9adff8f1dda0574fb67dc246f`。17:20:01 再核 A 仍无成品，两条均无原进程。未从应用外发信号。`protocol-v1-1794906977913-2.jsonl` 一次取消，B 的 `protocol-v1-1794906959741-1.jsonl` 零取消、独立完成。

两处目录实际只涉及自有测试数据。Pi 还调用了各自目录内的 `ls`，B 另读脚本和生成结果，与提示中「只执行一次指定命令」的范围存在差异；目标脚本各只运行一次，两个协议记录均无 Farfold 审批请求。这里证明 Pi 的本机工具交付和已覆盖的停止范围，客户端逐次审批、后台、外部工具和权限撤回仍待验。

正常保存退出后，从原侧栏打开 A，读回同一原 ID 的用户正文、原位置、原 OpenRouter 免费模型、Medium 及未发草稿，无自动发送。核对后替换自有草稿，只手动发一条不含原标记的续问，准确返回 `FF_C12_PI_FRESH_A` 并完成。`protocol-v1-1794907216861-0.jsonl` 含一次加载、一次手动发送、零新建与零审批；原脚本没有重跑。当前宏观验收还需原要求的后台、权限、更多恢复条件。

## Copilot 1.0.112 超窗归属

复核上次同一个 Copilot 进程 `33112` 的原日志。16:19:34 收到续问后进入 `sessionStart` 处理，原会话记录没有新增用户消息、回复或终态。16:25:01 的取消未回复。16:31:13 应用退出时才记录本次处理未进入结束阶段，随后系统确认 Farfold 所持进程组退出。进程组回收与早先按钮停止仍分别记录。旧版成功样本也出现相同启动警告，具体触发原因尚未证实。选中新版声明官方 `session/close`，可做独立的原会话恢复实验。该版本未实测活动请求下的关闭，也未确认独立进程或云端工作停止。 [上次正式复验](../2026-11-17-cycle12-copilot-pi-vibe/README.md#copilot-10112-更新历史和停止回执) · [官方关闭接口](https://agentclientprotocol.com/protocol/v1/session-setup#closing-active-sessions)
