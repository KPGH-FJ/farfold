# 第 12 周期 CodeBuddy 实时中止与冷开显示

2026-11-18，macOS arm64，正式 Farfold `98d365c08`（0.1.7，CDHash `a373426cac1c3553e6b772ffaf423f1bed7303c6`），目录登记 CodeBuddy 2.184.0。从「新对话」在 `/private/tmp/ff-c12-codebuddy-stop-n18.5di9kede/{a,b}` 两个独立目录分别开工。Farfold 两条均采用显示的 Hy4 / On，保存值 `hy4std` / `enabled`。下文原请求核对发现实际模型不同。

## 原工具中止与另一条继续

各发送一次，分别核对并单次批准 `/bin/sh ./task.sh`。脚本各启动一个 sleep 子进程，记录父子 PID，自然结束后才写各自 `result.txt`。A、B 等待时长分别为 85 秒、62 秒。下列时间为 UTC+8。

| 样本 | 原会话、请求和 Bash ID                                                                                            | 实测结果                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A    | `01a1ee93-4c2d-776c-94f0-44a9d74558db`，请求 `01a1ee9447497652b49de210bdb60ed3`，`chatcmpl-tool-8ce46ea8b776ad68` | Shell 19440、sleep 19441，进程组 19439。20:15:37.955 Farfold 只发一次取消。20:15:38.249 已找不到两个原 PID，最后无成品         |
| B    | `01a1ee94-7350-7766-b28e-62823ef19780`，请求 `01a1ee94be9272dcbc7914db71681b49`，`chatcmpl-tool-87b1eb4ed84aaa1c` | Shell 19447、sleep 19448，进程组 19446。A 停止后仍为原 PID，20:16:23 自然结束，B 33 字节成品和精确标记保存，Farfold 显示已完成 |

点停前用进程快照及工作目录核对真实重叠、独立进程组和准确父子关系。停止只通过 Farfold 操作。A 原工具结果保存 `incomplete` 和 `Interrupted by user`，与原会话、请求、工具和父记录对应。Farfold 实时显示「回复已停止」，原工具步骤为「有步骤未成功」，该步骤的「技术详情」显示 `cancelled`。B 原记录为同一 Bash 的成功终态，工具结果、磁盘成品及助手回复均有正确标记。

## 冷开原 A

20:17:14 确认 Farfold 正常退出。重启同一正式版，按原测试标记搜索并打开原 A。原工具步骤保持「有步骤未成功」，其技术详情仍包含原命令和 `Interrupted by user`。原登记 ID、工作目录、创建时间保持。A 原记录仍只有一次 Bash 调用及同一工具结果。A 的 `task.sh` 与 `started.txt` 前后摘要及修改时间一致，没有 `result.txt`，复验未重跑原任务。

| 正式诊断                                 | 本次相关动作                                                       |
| ---------------------------------------- | ------------------------------------------------------------------ |
| A `protocol-v1-1795003992336-2.jsonl`    | 一次手动发送、一次权限请求、一次取消。准备会话在观察窗开始前已创建 |
| B `protocol-v1-1795004067925-4.jsonl`    | 一次新建、一次手动发送、一次权限请求、零取消                       |
| 冷开 `protocol-v1-1795004250294-0.jsonl` | 一次加载、零新建、零发送、零权限请求                               |

安装版 CodeBuddy `dist/codebuddy-headless.js`（SHA-256 `c6857206c76cdabd9186f9374620b69339a5e912d9a0dd9539c182ddc32c3287`）在实时取消发同工具的 `failed` 与取消原因，在原回放中把 `incomplete` 映射为未成功并保留原输出。实时和历史使用各自原回执，用户可在原步骤详情定位中止。 [Farfold 工具呈现](../../../src/components/ThreadView.tsx) · [前次 CodeBuddy 原件](../2026-11-18-cycle12-codebuddy-stop-receipt/README.md)

## 模型显示与实际请求不一致

A、B 主要请求的原推理和 Bash 记录均为 `requestModelId: hy4flash-free`、`requestModelName: Hy4 flash`、返回 `model: hy4-flash-free`。B 最终回复及用量记录同样指向该模型。两个活跃连接在发送前均没有出站 `session/set_config_option`。这组证据证明实际 Flash Free 下的隔离与停止反馈，指定 Hy4 的实测尚未通过。

Farfold 在已存值等于 Agent 报告的当前值时复用该值。CodeBuddy 可从模型目录快照报告当前值，发送时另外解析会话实际模型。这与本次观察一致，厂商内部取值的具体原因未确认。其显式模型设置在部分启动模式会同步 CLI 的全局模型，安全的会话级设置及实际 Hy4 回执仍待核验。现有保存配置与中止的三组工程检查 174 项通过，覆盖所报配置的变化和工具归属，实际模型以原请求为准。 [恢复逻辑](../../../src/runtime/saved_configuration_restore.ts) · [CodeBuddy 官方设置](https://www.codebuddy.ai/docs/cli/settings)

只读复核已知旧样本。11 月 17 日短问 `01a1e738-a4f4-77a3-aa61-7306aa583f3e`、文件任务 `01a1e7a3-3252-7dcd-9bcf-72ca4b835e8f`、前台 A/B 及 A 冷开续问也均实际请求 `hy4flash-free`。之前的 Hy4 / On 是界面与保存选择。这些旧样本的响应、成品、进程及同会话恢复证据保持在各自实际配置范围。 [旧短问](../2026-11-17-cycle12-models-and-sigit/README.md) · [旧文件成品](../2026-11-17-cycle12-stop-delivery-approval/README.md) · [旧 A/B 与续答](../2026-11-17-cycle12-four-agent-control/README.md)
