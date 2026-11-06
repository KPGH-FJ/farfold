# 第 1 阶段真实工具审批

本批使用 macOS arm64 27.0（26A425）正式版 `dbe23bb6e`，复用同一个自有空目录里的三条独立自测对话。六条新请求均为一次性的本地文字输出，测试前后目录为空。六个审批动作均有界面决定和工具结果，内容无关的协议日志另作时序佐证。

| Agent          | 实际决定                        | 可见结果与依据                                                                                                                                                     |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Copilot | 拒绝一次路径请求                | Farfold 显示已拒绝并告知 Agent。Copilot 原生记录在同一请求下记为交互拒绝、工具未成功，无工具输出，随后停止并回到空闲。                                             |
| GitHub Copilot | 仅批准一次指定的 `printf`       | Farfold 显示 `Allow once`。命令输出面板与同一原生工具完成记录均返回专用标识和退出码 0，对话回到空闲。沿用 Free / Auto、Agent 模式、Allow All Off。                 |
| Kilo           | 仅批准一次指定的 `printf`       | Farfold 显示 `Allow once`。工具输出面板读到专用标识，对话回到空闲。沿用 Kilo Gateway 的 Nemotron 3 Ultra (free)。                                                  |
| Goose          | 单次拒绝指定的 `printf`         | 仅把这条自测对话改为 `approve`，界面读回该模式。单次拒绝后工具明确返回用户拒绝运行，随后对话回到空闲。测试对话保留手动审批，OpenRouter、原免费模型和思考设置照旧。 |
| Kilo           | 并发中拒绝指定的 `printf`       | 拒绝只作用于 Kilo。工具明确报本次审批被拒，无专用输出标识，对话回到空闲。                                                                                          |
| Goose          | 并发中仅批准一次指定的 `printf` | Kilo 被拒后，Goose 仍等待自己的审批。另行仅批准一次，工具返回 Goose 的专用输出标识，对话回到空闲。                                                                 |

每轮内容无关的日志均只见一次发送、一次入站审批请求、一次出站回复及一次入站回复。两条并发连接各有独立日志，均先收到审批请求，随后分别记录出站回复。日志无请求编号、决定正文或工具内容，独立复核范围为时序。Kilo 和 Goose 的决定与效果由正式界面核对。Copilot 的原生决定与工具结果另按同一请求和工具核对。Goose 的模式变更与审批分别计证。永久规则、冷恢复和更多并发组合仍待验。 [Goose 官方审批模式](https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/response_builder.rs) · [Kilo CLI 权限](https://github.com/kilo-org/kilocode/blob/main/packages/kilo-docs/pages/code-with-ai/platforms/cli.md#permissions)

## Copilot 原会话和独立缺项

只读核对同一归档 Copilot 原会话。12 个原生工具开始中，11 个有匹配终态。唯一缺终态的 `apply_patch` 有匹配到同一工具和审批请求的原生 `cancelled` 决定。当时正式应用已记录在批准前停止，随后核对目标文件不存在。一次另发的明确任务有结果。当前正式界面仍显示结果未知，内容无关日志不含该工具的回放状态。原会话的发送仍被 Farfold 缺失的已保存模型基线挡住，现有重查路径无法确认并保存原模型，继续保留原历史和发送保护。 [当时的实测记录](../2026-10-06-macos-batch1/agent-current-summary.json) · [上批原模型核对](../2026-11-06-phase1-next/README.md#copilot-原模型与免费额度) · [Copilot 原生会话存储](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)

安装版草稿写入故障需要隔离的 macOS 图形测试账号或实例。若使用同一台 Mac，应先正常退出当前用户的 Farfold，再从隔离账号启动同一正式应用。只对测试库持有 SQLite 空写事务，验证保存失败、旧盘值和新输入保留、退出受阻、释放后重试和冷读；物理满盘及设备 I/O 另验。当前未注入生产库故障。Windows 安装仍待可用执行机。

首波完整验收仍为 0/3。Kilo 持久桌面授权、Goose 前次等待点、Copilot 原会话基线恢复及各家审批和权限余项按原条件推进。原未发送草稿、保留 1 份及原工作位置已复核，旧请求零重发。此批没有更新正式应用或更改产品代码。 [证据指纹](summary.json) · [当前计划](../../../plans/agent-access.md)
