# 第 12 周期 Amp 实停及官方替代入口

2026-11-17，macOS arm64。Amp 与 MiniMax 程序管理观察使用正式 `/Applications/Farfold.app` 0.1.7，源码 `0b7195dd3`，CDHash `f5d15afc17616ba38f266b53afdf9d8e1e76f5ee`。

## Amp 双前台任务、真正停止与冷开

正常新建分别选择两个自有目录，沿用已登录 Amp 账号、原 `mimo-v2.6-flash` / Auto。登记组件 0.13.0，实际 CLI `0.0.1794816357-gc47859`。两条各手动发送一次测试请求。A `S-mwkhrt3k-oe0pkh` 与厂商 `T-01a1e8d7-eb43-75cc-b2a9-5bb8b7931db2` 对应，B `S-mwkhqtdr-s9jf4k` 与厂商 `T-01a1e8d7-9460-773e-8656-187d2db61d6d` 对应。各自的厂商用量都显示 `xiaomi/mimo-v2.6-flash` 经已选 Custom URL 连接 `c503683d-3a56-4bdc-b8d2-06ae84d027eb`，其中 A 一次 Agent 推理，B 四次。对应这两条样本的路由，不推断服务方账单。 [既有小米连接核验](../2026-11-16-cycle12-account-retest/README.md#amp-小米单次正式实测)

17:30:46.624，A `/private/tmp/ff-c12-amp-stop-a-w3qwbk8s` 的 Shell 13283、sleep 13284 与 B `/private/tmp/ff-c12-amp-stop-b-4fr7ovx1` 的对应 13247、13248 同时运行，原目录、父子及进程组各自匹配。17:31:42.157 只在 Farfold 停 A。17:31:52.279 A 两个原进程均退出，B 两个原进程仍是原身份并保持执行。17:33:33.837 A 无迟到成品，B 正常退出并写出 `FF_C12_AMP_PAIR_B_DELIVERED`，文件 SHA-256 `4038fcabb3585cebec0c595dcec625cfe9e1e109558716ab5eec5ae708e9d40b`。未从应用外发信号。正式界面 A 仍提示「回复已停止，仍有步骤未确认结束」，B 显示已完成。

A `protocol-v1-1794907819210-3.jsonl` 一次发送及一次取消，B `protocol-v1-1794907772881-2.jsonl` 一次发送及零取消，两条均无 Farfold 审批。范围限本机前台 Shell 与子进程。原工具终态、后台或远端工作、逐次审批仍需分别核。

正常保存退出后按原侧栏索引冷开 A，读回同一原对话的正文、已有服务、MiMo、Auto 与自有未发草稿 `FF_C12_AMP_A_DRAFT_AFTER_STOP`。界面提示「此前请求结果未确认，未自动重发」。`protocol-v1-1794908232986-0.jsonl` 一次 `session/load`，零发送和新建。保留本条的显式模型选择及草稿。前序同组件的显式 MiMo 续答仍有官方参数失败记录，条件未变，本样本未重复发送。 [原续答边界](../2026-11-16-cycle12-eight-check/README.md#等待官方的复验条件)

## MiniMax 新版的实际启动与原登记

Farfold 原登记实际显示 0.2.7，正常「重新下载 / 更新」跟随官方 ACP 目录。目录源码与实际目录仍为 0.2.7。厂商已发布 `@minimax-ai/code` 和单独官方 ACP 启动包 `@minimax-ai/code-acp` 的 0.7.7，后者以 `code-acp acp` 执行。新版本目前可作为独立验证候选，现有选择程序入口不能把它原样挂回 `registry:minimax-code`。原程序、设置和历史保持。 [原目录](https://github.com/agentclientprotocol/registry/blob/main/minimax-code/agent.json) · [官方 ACP 启动包](https://github.com/MiniMax-AI/minimax-code/tree/main/packages/code-acp)

从官方包在私有临时目录验证，启动进程禁网，拒绝读取实际 HOME，写入限临时目录。首次启动缺少 `better-sqlite3` 12.11.1 的原生绑定，同一沙箱使用现有 Node 22.22.3 头文件构建官方依赖后，SQLite 自检通过。实际握手为 ACP 1，报告 `minimax-code` 0.7.7、可读取会话及声明列表、续接、关闭等能力。唯一 `session/list` 在无凭据条件返回 `-32000 Authentication required`，进程正常结束。全程零模型请求、零原账号读写。另核发布包，活跃请求的取消按原会话与轮次清理后台，已无活跃请求时早退。实际原登记后台停止仍未通过。 [厂商停止测试](https://github.com/MiniMax-AI/minimax-code/blob/main/packages/local-runtime-v2/test/integration/session-stop-cascade.integration.test.ts)

## Pi 原有桥的审批边界

独立私有临时目录使用官方 Pi 0.87.1、现行 pi-acp 0.0.34 和 Pi 官方扩展命令接口。沙箱禁网，限制实际配置读取及临时目录外写入。两条独立请求经官方 `ctx.ui.confirm` 转成同一对话的 ACP 审批，严格以各自原请求 ID 回传。允许时仅执行自有标记命令并写出文件，拒绝时命令不运行，均无重复审批。两条原扩展命令的 `session/prompt` 均未获得终态，清理也无终态，退出码 0，模型推理零次。覆盖官方回传及明确的物理效果，正式 Farfold 审批及网页链未测。 [上游终态问题](https://github.com/svkozak/pi-acp/issues/84)

现行桥不向 Pi 转交对话 MCP 工具，厂商相关分支仍未合并。Pi 1.5.2 官方 SDK 可在会话内注册、撤回临时 MCP，已有合成工具验证。正式路线还需保留同一 Agent 的原身份和配置，并核对 Farfold 签名工具助手与实际所持会话进程，尤其是临时助手直接归属。不能只凭工具声明宣称网页已经接通。 [桥的发行限制](https://github.com/svkozak/pi-acp/blob/v0.0.34/README.md#limitations) · [Pi SDK 受控验证](../2026-11-15-official-alternatives/pi.md)

## 编译空间恢复

只处理 `src-tauri/target/debug/deps` 中本地午夜前的 2,759 个单链接常规 Mach-O 编译对象。清单、独立复核、删除日志与磁盘复核一致。分配 6,523,875,328 字节。删除前可用 4,159,483,904 字节，删除后 10,684,219,392 字节，实增 6,524,735,488 字节（约 6.08 GiB），验后可用约 9.95 GiB。复核了 Git、工作区、受保护原件及正式应用的前后摘要，应用数据及日志的元数据一致。原备份、共享 inode 和当天对象不在清单。执行、复核及清单保存在本机 `output/2026-11-17-cycle12-compile-space/`。

## 停止未确认时的官方关闭

`2b3bf2dd7` 在当前握手同时声明可关闭及重开、已发送原取消而未收到终态且原归属可重新确认时，提供检查和单独确认的关闭入口。匹配的官方空回执只结束原对话连接并释放其发送名额，原结果仍可为未知。草稿、原历史及暂停的待发保持。实际终态在关闭期间先到时，先交付终态。已有本机受管终端尚未确认退出或其他待处理条件存在时不放行。过程没有查杀命令。受控双路分别覆盖独立任务继续交付、过期或错误归属、畸形回执保留占用、原终态跨关闭交付和实际进程组退出。 [官方关闭语义](https://agentclientprotocol.com/protocol/v1/session-setup#closing-active-sessions)

独立复核修正了原终态跨关闭与本机子进程退出的竞态。第一次全量 Rust 检查发现新真实终端夹具缺显式工作目录；测试专用提交 `6c05d676e` 修正夹具及适用平台，复测通过。最终前端 786 文件、10,989 项通过，Rust 2,826 项通过、11 项既有忽略。类型、格式、Clippy 与生产包通过。正常保存退出后安装 `2b3bf2dd7`，应用版本 0.1.7，CDHash `0f99b0643e07b28eaf34a4eecb3a6e545a79acc2`，二进制 SHA-256 `f27e201beb1e707ea414672ed64951f725c1a8e856734b41fc6d3a45391b3192`。安装前三处数据共 263,005 项前后摘要一致，SQLite 副本完整，签名核对后移除旧重复构建产物。

正式版 Copilot 1.0.112 仍走原账号。冷开旧测试对话 `f42b41e3-2978-4ce8-ac4d-7b92dce52646`，正文读回，提示此前结果未确认且无法确认已保存选择，零发送。另在自有新目录 `/private/tmp/ff-c12-copilot-close-PGnMBCfB`，正常入口显示已有设置及 Auto。只发一条无工具文字 `FF_C12_COPILOT_OFFICIAL_CLOSE_20261117`，约 16.6 秒收到准确回复并显示完成。官方原记录 `98146842-c579-48b0-bc59-d0beaf085539` 的实际助手模型为 `gpt-6-luna`、提供方为 `copilot`。`protocol-v1-1794910162578-2.jsonl` 一次新建、一次发送，零取消、关闭及工具。本次新对话自然完成，正式 Copilot 的停止未知及关闭分支未触发。旧版失败保留，正式关闭入口的证据限受控实线协议回归。 [原负例](../2026-11-17-cycle12-copilot-pi-vibe/README.md#copilot-10112-更新历史和停止回执)
