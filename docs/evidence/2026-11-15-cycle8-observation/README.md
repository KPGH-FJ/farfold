# 第 8 周期实机负载与历史验收

2026-11-15，北京时间。唯一正式应用 `/Applications/Farfold.app` 0.1.7，macOS arm64。本批输入 2,618 个，较上一正式候选只改工作树共享提示及长历史分支索引相关的七个前端文件。前端 785 文件、10,920 项通过；Rust 产品输入未变，沿用全量结果并补现有二进制 17 项回放／压力和 168 项工作树定向。前端类型、生产构建、受影响格式和独立复核通过。本批工程（本机 `output/2026-11-15-cycle8-observation/frontend-tests.log`） · 长历史受控证据（本机 `output/2026-11-15-cycle8-history/README.md`） · [工作树定向](../2026-11-15-cycle8-worktree/README.md)

正式候选 CDHash `44d969fc62bf11cfb31200a2828a409f7145a824`，程序 SHA-256 `8a8261cf39db743bdbc8a52530d3381276c44f7486cf52fe1530c52e9e3033ce`。应用从正常入口保存退出，原自建未知请求留存。安装初次整目录摘要不一致。原安装前整目录逐路径清单未保存，现已独立核实五个正式包文件均与候选匹配。应用主 SQLite 和 WAL 与替换前私有备份逐字节同，临时 SQLite `-shm` 头有 12 字节差异，私有合并库 `quick_check` 通过。安装后两次检查三个数据根，206,480 条摘要完全相同。原整目录断言保留失败，本次正式验证从独立复核后开始。重复应用产物按五个精确文件核对并清理。独立复核（本机 `output/2026-11-15-cycle8-observation/install-recheck.json`） · 重复产物（本机 `output/2026-11-15-cycle8-observation/duplicate-cleanup.json`）

## 长历史与多路实际任务

- 上一正式版，两个自建任务同时使用同一 Git base：OpenCode Xiaomi MiMo v2.6 Flash 仅写 `shared.txt`，Goose 沿当前已选 `nvidia/nemotron-3.5-super-vl:free` 读取。两条各执行 360 行有序合成输出，结束回执及两个不同标记都在原 Agent 记录中。Goose 原生同一工具结果的 `content` 和 `structuredContent.stdout` 各自保存同样的 360 行。正式界面分别读到 OpenCode `DONE_A` 和 Goose 的实际共享文件标记。任务在应用中同时显示进行中，两个实际命令的 shell 在 15:00:25.833 和 15:00:29.902 共存。原记录范围（本机 `output/2026-11-15-cycle8-observation/native-output-scope.json`）
- 该批 4 秒采样、在至少一条自建命令存活时，Farfold 主进程 RSS 64,752–68,720 KiB，打开文件描述符 46–50；可归属的应用进程树 14–17 个，合计 RSS 1,143,680–1,482,000 KiB。包括其他同应用连接，范围排除树外 WebKit XPC 和独立 Agent，不能代表全机或去重内存。两任务结束后实际切换对话、输入和清除自建短稿可用。资源范围（本机 `output/2026-11-15-cycle8-observation/concurrent-observation.json`）
- 用原安装 OpenCode 2.2.7 官方导入命令创建了唯一自有合成历史。新 Git 根、独立 ID，1000 条用户与助手交替消息，输入 JSON 842,437 字节。导入前后原有 `session_v2` 与 `session_message` 行的排序摘要逐项核同，仅新增这条会话及其 1000 条。当前正式 Farfold 从「所有对话 → 带入已有对话 → OpenCode 查找」发现原条目、查看正文并只加入一条。原模型选项未能确认，因此保持只读内容及发送暂停。本路径零模型发送。数据来源与计数（本机 `output/2026-11-15-cycle8-observation/owned-history-native.json`）
- 当前正式版打开原 1,000 条历史。对话内查找 `FF_C8_HISTORY_` 显示 `1 / 1000`，向上一条回绕显示 `1000 / 1000` 且找到原尾段。输入自建短稿，切去另一对话并返回，精确草稿仍在，随后仅清这段测试文字。所选操作的自动化记录含输入驱动与截图读取延迟，搜索输入至首个有计数截图 699 ms，回绕至末个 601 ms，输入 654 ms，切出至可观测状态 509 ms，返回及草稿截图 543 ms。首条标题与搜索入口首个观察 457 ms，正文随后单独确认。单点观察不作性能分位值或商品设备上限。
- 长历史修复把渲染时为每条消息重扫历史校验重复 ID 改为每次渲染构建索引，实际分支仍重核原消息、连接及重复性。WebKit 同夹具 3,000 条合法锚，整表筛选访问 18,012,000→12,000，同步挂载中位 545→478 ms；首尾及全部 3,000 个命中保持。该时间用于受控对照。受控测量（本机 `output/2026-11-15-cycle8-history/README.md`）

## 工作树与本波接入输入

- 同目录 `base/shared.txt` 从提交原字节变成自建更新；另一个 Git worktree 的同名文件仍为原字节。正式版通过工作树的「选择已有文件夹」选择了实体 `linked`。当前正式候选的空白对话工作位置明确显示「同一文件夹里的对话共享文件。权限另行确认。」独立夹具（本机 `output/2026-11-15-cycle8-worktree/owned-fixture.json`） · [工作树原条件与定向](../2026-11-15-cycle8-worktree/README.md)
- 当前正式工作树弹窗也显示同目录共享，并提示 Git 设置、账号和部分依赖可能共享；旧操作结果未知时「选择仓库文件夹」被禁用，界面保留原位置和保留位置，要求先核查再动。沿用既有正式创建、归档恢复和脏文件保留原件，当前批次以原未知保护和未变 Rust 行为定向核对；本次未另做新的实际归档或永久删除。[既有正式原件与本次定向](../2026-11-15-cycle8-worktree/README.md)
- 本波为 Poolside、Qoder、Qwen Code、Claude Agent、Amp。版本、此前实测、现机输入、各家下一项分别留证。四家原自建目录已不存在，Claude Agent 待明确归属的原对话，Amp 另缺厂商程序和原线程。[本波五家](../2026-11-15-cycle8-intake/README.md)
- 在现正式版「带入已有对话 → 更换 Agent」逐项出现这五家的「已添加」登记。登记及入口只记录可选；本轮按五家的样本依赖留待验证原对话和实际续答。

## 休眠与网络变化

- 15:15:34.628 从原 OpenCode 自建对话发起一条真实终端请求，实际 shell `51613` 及 sleep `51614` 均归属该对话。15:16:44 熄屏，15:16:49 显示器恢复。系统记录睡眠客户端确认超时，该次只认显示关开。随后在同一请求在途时，Wi-Fi 电源关闭观察 12 次，en1 无 IPv4 观察 17 次，最后在原轮结束前恢复。默认路由对象沿途存在，本次只证明该 Wi-Fi 链路及地址中断。原终端结束标记和 `RECOVERY_C8_OK` 从同一会话回到界面，15:18:17.249 完成。协议只发一次该轮请求。网络观察（本机 `output/2026-11-15-cycle8-observation/active-recovery-network.jsonl`） · 原轮回执（本机 `output/2026-11-15-cycle8-observation/recovery-exact-receipt.json`）
- 15:22:50–15:24:36 实际整机休眠 106 秒，用户现场唤醒。上一次限时终端任务在 15:22:38.259 已结束，休眠开始时该轮已完成。主应用 `50769` 和 OpenCode 子进程 `51450` 休眠前后是原 PID，描述符数分别为 49 和 18、均保持。RSS 主应用 129,632→126,720 KiB，OpenCode 子进程 330,512→238,064 KiB。睡醒后从原会话实际发起新请求，原连接收到请求并返回颜色选择卡。该轮单独补验卡片在途跨实际整机睡眠。系统电源记录（本机 `output/2026-11-15-cycle8-observation/power-window.txt`） · 应用进程时间线（本机 `output/2026-11-15-cycle8-observation/app-new-timeline.jsonl`） · 限时终端轮（本机 `output/2026-11-15-cycle8-observation/deepsleep-exact-receipt.json`）
- 实际在途验收：15:26:12.602 原对话收到一条 OpenCode 请求，原生提问卡出现后保持未回答。15:28:41–15:29:04 整机休眠 23 秒。用户现场确认唤醒后卡仍在，界面保持同一对话与未回答选择。仅提交一次蓝色，15:29:50.625 原轮回答「蓝色」并成功结束。唯一原生用户请求对应一个 `session/prompt`，未重发、未另建会话。应用 `50769` 和 OpenCode `51449`、`51450` 前后相同，描述符分别保持 49、14、17；应用 RSS 132,592→133,264 KiB，OpenCode 子进程 313,648 KiB 保持。原请求、回答及终态（本机 `output/2026-11-15-cycle8-observation/pending-sleep-native-receipt.json`） · 前后进程和描述符（本机 `output/2026-11-15-cycle8-observation/pending-sleep-process-proof.json`）
