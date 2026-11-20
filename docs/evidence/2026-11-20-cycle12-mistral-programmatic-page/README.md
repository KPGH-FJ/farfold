# 第 12 周期 Mistral Vibe 网页工具路径核对

2026-11-20，北京时间。macOS arm64 正式 Farfold 0.1.7，源码 `87ac54ec2`，CDHash `9547fa1f88f9ca651e857a64c14b61748e20e7c4`。测试使用名单内已登记的 Mistral Vibe 2.25.8，原自有会话 `d1cabd9a-5fde-e0a8-35d0-608eb87e2f25`，原工作目录 `output/2026-11-13-cycle7/formal-mistral-page/owned-work`。保留已有服务及 Mistral Medium 3.5 / High，再打开同一张 [W3C 公开页](https://www.w3.org/History/19921103-hypertext/hypertext/WWW/TheProject.html)。发出请求前核到网页加载且「尚未允许读取」。界面保留先前「此前请求结果未确认，未自动重发」。

## 网页工具怎样进入请求

同一原会话厂商状态的 `core_capabilities.tool_groups` 对四个网页工具均标注 `exposure: programmatic`。首轮模型工具列表包含 `search_tool_functions` 和 `run_typescript`。Vibe 2.25.8 的指令先用 `best_match` 查找到函数，再用 `details` 核对当前完整名称，最后由 `run_typescript` 调用该函数。此前没有在首轮模型工具列表直接看到 `read_page_snapshot`，符合这一调用方式。 [Vibe 2.25.8 调用说明](https://github.com/mistralai/mistral-vibe/blob/v2.25.8/harness/core/src/core/features/programmatic_tool_calling/prompt.rs#L13-L20)

上次成功的原请求 `turn-ab8677052aac3caefabc6eba58aff7f0` 在厂商 `chunks/ac1913c75eebf7ab58b7d674ac14721b9853f3ed7bb3527fb76ac28efc781a8d.json` 中保留，SHA-256 `f4727255562d93413048267ed18d69e786b7c8ef6f3b8ef10d38f78aceb5766a`。数组下标 8–17 显示三次查找、一次 `run_typescript`、一次最终答复。对应 `chunks/b5f8a8abdeee9ddcccecd3478223c4d2f87c15127a1de8960a92a1226e1a2eec.json` 的工具记录下标 10，原 `effect-d213c71c-9169-5da1-91fe-b7f35254afa8` 只执行一次 `read_page_snapshot({})`，有用户批准及成功标题。该页当时已允许读取。 [之前的正式成功](../2026-11-19-cycle12-mistral-page-revoke/README.md)

11 月 20 日 07:00 的测试指令添加了「不要调用其他工具」，未给工具查找及调用步骤留出空间。该轮正常结束并返回预设短语，厂商记录零工具动作、零审批。原失败和短语保留。 [07:00 原记录](../2026-11-20-cycle12-mistral-revoke-recheck/README.md)

## 08:58 单次复验与结果

仅发一条新测试消息 `FF_C12_N20_MISTRAL_PROGRAMMATIC_PAGE`。允许一次 `best_match`、需要时一次 `details`，最多一次 `run_typescript`，并只准调用当前网页连接的 `read_page_snapshot({})` 一次。没有给出预设取消答复。未出现工具或两层审批。本轮界面显示「请求未完成」「结果未知」，发送暂停，网页仍未允许读取。没有补发或点停止。

| 原件                                                                                                                | 本轮证据                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Farfold `~/Library/Logs/Farfold/protocol-v1-1795136234098-1.jsonl`                                                  | 44 行，SHA-256 `27adb8241665fff5e253bf139851c0799091099d76961cf3c600388612378871`。第 10、37 行为原对话读取和响应。第 39 行 08:58:13.901 唯一发送，第 42 行 08:58:19.030 返回协议错误。第 39 行后零工具更新、零审批、零取消。之前的工具更新来自历史回放。                                                                                                                                                  |
| Vibe `~/.vibe/logs/session/unified/d1cabd9a-5fde-e0a8-35d0-608eb87e2f25/journal/0000000000000155.jsonl`             | 8 行，SHA-256 `fdcd3d71481e277d2031eb969c3662aa3435778a9cc794e63d4f1117e56c99bb`。第 4 行是唯一的模型调用 `turn-bf755b4cdef4361932f2a41c5a76e62d`。模型工具列表含两个调用入口。第 5 行为 `completion_failed`、`model_stream_failed`，厂商返回 `503 Service Unavailable`。实际路由为 `mistral` / `mistral-vibe-cli-latest`，Farfold 显示及保存的选择仍为 Mistral Medium 3.5 / High。第 8 行是内部命令收据。 |
| 同一厂商会话 `generations/0000000000000154/runtime-state.json` 与 `generations/0000000000000162/runtime-state.json` | 发送前后均存在同一个网页工具组，四个工具均为 `programmatic`。摘要依次为 `ae2092f9ab951ae7c13ddad8c0411bdfa55f39d3b5f3c0f1ce91a2693146146c` 和 `1cb05d4d34de6db5e259714735d9a55e23166f05b7fedaca5ea256bc8a72590f`。                                                                                                                                                                                         |

09:01 从正式入口点「检查能否关闭此对话的连接」，确认只限这条自有对话后关闭。界面显示「连接已结束，可以重新连接后继续」，原测试消息与此前未知提示保留。同一协议日志第 45–49 行仅记录本连接回收，49 行全段 SHA-256 `c839762bdd6b2eb71457e8e449d3a827c9cf03680235802e08d24806196b14ee`。全段仍只发过一条新请求。

已查清网页工具的正确调用方式。最新实测停在厂商第一次模型请求返回 503，未验到网页撤回后重新弹出许可。复验条件是原服务成功处理这一受限请求，取得原网页工具调用，核准 Agent 一次工具申请后，在 Farfold 取消实际网页许可，并确认没有交付页面正文。官方 ACP 目录当前登记 3.1.1，厂商最新公开发行 3.1.3。本批未切换版本。 [ACP 目录](https://raw.githubusercontent.com/agentclientprotocol/registry/4b8c912c7b4220a42cdd141294cf2b003e290347/mistral-vibe/agent.json) · [厂商发行](https://github.com/mistralai/mistral-vibe/releases/tag/v3.1.3)
