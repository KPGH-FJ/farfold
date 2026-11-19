# 第 12 周期四家正式入口补验

2026-11-20，北京时间。macOS arm64，正式 Farfold 0.1.7，源码 `87ac54ec2`，CDHash `9547fa1f88f9ca651e857a64c14b61748e20e7c4`。本轮沿各家已有服务，在自有目录分别测试。旧 fast-agent 样本零发送，原 Grok 样本未打开；Cline 图片、Qoder、Gemini CLI、Antigravity 本轮未测。

## Cursor 拒绝与冷开

沿现有设置 Auto，在 `/private/tmp/ff-c12-n20-ryup8cla/cursor` 发一条请求。原审批列出 `/bin/sh ./once.sh`。只点一次「拒绝 Reject」，卡片显示「已拒绝 · 已告知 Agent」，原请求回复准确标记 `FF_C12_N20_CURSOR_DENIED` 并结束。脚本唯一副作用为写入 `denied-result.txt`，该文件始终不存在，脚本摘要保持。厂商原会话 `390aaa3a-d8e2-4895-91fb-4c5c8f7e44d6` 的目录与 Farfold 索引一致。

正常保存退出后冷开同一条对话，原正文和准确回复可见。展开历史工具仅显示「执行 · 步骤已结束」，显式拒绝标记未随原工具回放。冷开零新建、零发送、零审批。要在冷开复核原拒绝原因及原工具终态，需要官方回放明确保留。

## Devin 断线与两条待发

普通新对话用「检查模型设置」比较保存的 `swe-2-high` 与当前 `SWE-2 Flash Medium`。仅在本次草稿明确沿用已验证的同服务和 `swe-2-flash-medium`，原已有设置仍由 Farfold 保留。对话 `languid-foxglove`，独立 `devin` 目录。先发 A，再分别用「加入待发」保存纯文字 B、C，另在输入框保留独立草稿 D。审批仅批准准确的 `/bin/sh ./disconnect.sh` 一次。

02:53:44 原 Shell 18857 与 sleep 18858 启动。02:54:06 核合自建目标、工作目录和父子关系后，仅向此原 Devin 连接 18399 注入退出。Farfold 确认原连接组回收，界面标为「连接中断，结果未知」。Shell 在不同的 18857 进程组，原连接死亡后由系统收养，仍带着同一 sleep 继续。只点一次「重连」，同一原 ID 读回 B、C 与 D，结果未知保持，继续按钮禁用，零发送。02:56:44 原 Shell 按期写出自然结束标记。启动文件始终只有一对原 PID，随后核对三条原 PID 均退出。原 Agent 工作在连接退出后继续了约 158 秒，等待的官方条件是原任务自行回收，或按原会话与工具提供精确查询和结束入口。 [Farfold 持有的范围](../../../src-tauri/src/acp_client/process.rs#L405) · [产品契约](../../../PRODUCT.md)

Copilot 正常完成且原 Devin 命令实际结束后，Farfold 正常保存退出。正式冷开同一原 ID 后，B、C 保持原顺序，待发对象与退出时摘要一致，D 仍在输入框。界面保留「此前请求结果未确认，未自动重发」。只点一次「继续发送」，B、C 按序各出站一次、各实答精确标记并显示已完成；D 未发，队列清空。零再次新建、无 A 或旧工具重跑。厂商稍后可读记录确认原配置、A/B/C 每条各一次及唯一原工具，工具登记为 `completed`。该后来结果与 A 连接突然退出时没有收到终态可以同时成立，Farfold 保留原 A 未确认提示。本例覆盖本机连接退出、同对话重连及两条纯文字冷续发。

## Copilot 成品与冷开

在 `copilot` 独立目录沿已有服务 Auto 发一条文件任务。Farfold 展示精确写入路径，点一次「批准 Allow once」。同原会话 `129d85c1-6bd6-408f-a6b4-2b776ccc7704` 的厂商事件记现用模型 `copilot / gpt-6-luna`，保留同一写入工具、人工批准和仅创建 `result.txt` 的回执。从「本轮产物」点「查看文件」，在 Farfold 内实际预览两行。正常保存退出后冷开同一原对话，经原回复的 `./result.txt` 链接再次打开，零发送。归档原件 46 字节、成品 45 字节，末尾一个 LF。原件摘要保持。 [原件](fixture/copilot-input.txt) · [成品](fixture/copilot-result.txt)

## Claude 默认范围和原目录

从「所有对话 → 带入已有对话」选 Claude Agent。官方默认范围列表找到自建已加入项「task.sh 执行请求」及其原目录。随后在原文件夹 `/private/tmp/ff-c12-approval-denial.j0gXgKIQ/claude` 重新查找，结果仅这一项，同一原目录、已加入、复选框和加入按钮均禁用。Farfold 原索引为 `8ea5c7dc-adde-49d6-9b5c-c1ec17c2bf93`。两次查询分别只有一次 `session/list`，零新建、历史加载、发送、加入。本分项限已有自建对象，分页和首次带入其他来源保持待验。

逐条日志、原件摘要和观测边界见[结构化回执](results.json)。同批未改变产品代码和验收门槛。
