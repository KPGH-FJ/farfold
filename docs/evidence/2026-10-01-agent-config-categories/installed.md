# 同类别多个配置选项：安装版复验

2026-10-01，Asia/Shanghai。正式候选 `0a725e03a07b39f0268075e71907efd627e35b9e` 已在同一 `/Applications/Farfold.app` 验证：原 Dirac 的模型与两项推理选项读取、明确重读成功；原 OpenCode 对话冷恢复后明确续发成功，准入时将其旧配置格式保存为 v2，第二次冷恢复仍可见最新回复与原模型；Codex 的已知模型/推理漂移继续明确阻止发送。**本片没有关闭 Codex 恢复失败，也不代表全目录或完整账号旅程通过。**

## 候选与环境

[安装收据](candidate-install.json)记录 03:50:02 替换正式应用，四个关键文件与打包产物一致，签名检查退出 0。二进制 SHA-256：`f70ed0a4b01090a0e41220b23b105c712bb4ef43394d1d86c6384fe28b0f34f5`。源码范围以 [420 项输入](candidate-source.json)为准；[打包前](before-bundle.json)、[首次启动后](after-launch.json)、[第一次退出](after-first-exit.json)及[最终退出](after-exit.json)的 `sourceChanges` 均为空，不能把旧候选的目录观察混入本片实现证明。

首次应用进程于 03:50:08 启动，第二次于 04:03:42 启动。相关实际进程的 cwd 见 [Dirac](cwd-dirac.json)、[Codex 恢复](cwd-codex-restored.json)、[OpenCode 恢复](cwd-opencode-restored.json)和[第二次重启](cwd-second-restart.json)：应用本身为 `/`，Agent 使用原普通对话目录。未为测试更换 Agent 程序、模型、推理或服务来源。

## 实际旅程与结论

| 样本                                          | 本片已观察结果                                                                                                                                                                                                          | 证据与限制                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dirac 0.5.17，原登记程序                      | 原 `~anthropic/claude-fable-latest`、Reasoning Effort `Medium`、Thinking Budget `Off` 同时可见，状态为“已读取当前模型选项”；明确点击重读后仍成功且值相同。                                                              | [首次读取](01-dirac-models-readable.png)、[明确重读](02-dirac-explicit-reread.png)、对应[读取文本](dirac-models-readable.txt)/[重读文本](dirac-reread.txt)。原 [registry:dirac 登记](dirac-registration.json)仍是原 0.5.17、原 `install-vRKF11` 和原启动参数；[读取完成摘要](dirac-read-complete.json)没有新增对话索引或修改原启动配置。没有登录、凭据交付或 prompt，不证明该模型已有成功回复。 |
| Codex 原首发测试对话，冷恢复                  | 历史仍可见；检查明确报告 `gpt-6-astra → gpt-6.1-sol`、`ultra → 未提供`，发送被阻止。没有为通过而改模型或推理。                                                                                                          | [漂移阻止](03-codex-drift-blocked.png)、[恢复文本](codex-restored.txt)。只读模型弹层显示 `6.1 Sol`，同时仍宣称保留创建时模型，存在显示语义问题；[弹层截图](04-codex-readonly-current-choice.png)与[下一片诊断](readonly-drift-diagnosis.md)保留此缺口。本片不将当前值只读解释为原模型已恢复一致。                                                                                               |
| OpenCode 原 Nemotron 对话，第一次冷恢复与续发 | 同一 `opencode` / `ses_f0e8e5a03ffeHDMo5rR4YFfsaM` 的旧历史恢复，模型仍为 `opencode/nemotron-3-ultra-free`、来源仍为沿用已有设置。通过界面明确发送一次固定短消息，得到完整 `FARFOLD-CONFIG-ID-RESUME-OK` 并显示已完成。 | [原模型与来源](05-opencode-original-choice.png)、[冷恢复文本](opencode-cold-restored.txt)、[本次回复](06-opencode-resume-reply.png)/[回复文本](opencode-resume-reply.txt)。固定输入为“只回复 FARFOLD-CONFIG-ID-RESUME-OK。不要使用工具，不要读取或修改文件。”这是已有对话续发，不是新账号或新对话首发证明。                                                                                     |
| 同一 OpenCode 对话，第二次重启                | 最新固定回复再次作为历史显示，原 Nemotron 模型和来源仍可见；未发第二条 prompt。                                                                                                                                         | [v2 冷恢复](08-opencode-v2-cold-restored.png)、[原模型](09-opencode-v2-original-model.png)、对应[恢复文本](opencode-v2-cold-restored.txt)/[模型文本](opencode-v2-choice.txt)。证明该单模型旧格式迁移后的真实冷恢复，不替代多模型、多推理的全部安装矩阵。                                                                                                                                        |
| 原 Amp 空稿返回                               | 首次返回仍显示已有设置中的 `Medium`；第二次重启后再次回到原 Amp 空稿。                                                                                                                                                  | [原 Medium](07-original-amp-medium.png)、[最终原稿](10-final-original-draft.png)及[最终文本](final-original-draft.txt)。原未发字段摘要见下文，不借界面返回声称 Amp 本片请求成功。                                                                                                                                                                                                               |

此前 Dirac 在 `423aed4` 的读取失败事实保留在[原诊断](diagnosis.md)；本片相同程序样本现已成功。多个同类别的第二模型、迟到变化和异常旧格式等完整边界仍以[后端受控证据](backend.md)、[前端受控证据](frontend.md)与[独立审查](review.md)判定，没有在真实 Agent 上全部重复。

## v1 保存为 v2 与原数据保护

[安装前基线](data-before.json)为 30 条会话索引、24 个启动配置、33 项设置。最终仍为 30 条索引，无新增索引；24 个原启动配置摘要全部保持。29 条其他原索引整行摘要保持，唯一变化为本次明确续发的 OpenCode 测试索引。

[续发前配置](opencode-config-before.json)仍为 `_farfoldConfig:1`；[续发后配置](opencode-config-after.json)为 `_farfoldConfig:2` 的单一 Choice 集合。准确模型 ID/值、服务摘要、Agent/native session 身份保持。此次保存发生于本轮明确短测的消息准入，不是打开旧历史后静默写回所有旧记录。

首次 [整行比较](opencode-index-comparison.json)在固定排序重建 JSON 后返回 `false`，该收据不覆盖或删去。随后[序列化核对](opencode-index-serialization-comparison.json)仅用原已观察公开 Choice 与未变服务，在内存中检查根键顺序及紧凑/空格序列化，找到了原整行摘要匹配的表示。它确认其他索引字段均与原值一致；未向数据库写入还原数据，也不是重新运行消息。

[第一次退出](after-first-exit.json)和[最终退出](after-exit.json)均只列出 `unsentWork.v1`、`agentSetup.v1` 两项原设置变化，没有新增设置键。原未发数据的 version、composers、choice、feedback、queues 摘要均保持；activity 只有明确续发的 OpenCode 测试键变化。不能把该允许变化概括为所有设置逐字未变，或借元数据摘要声称外部 Agent 历史文件零写入。

## 协议、退出与重复产物

[最终安全协议元数据](protocol-metadata-final.json)覆盖 6 个文件：6 次 initialize、4 次 session/new、3 次 session/load、1 次 session/prompt，未见 authenticate。还记录 7 次 session/set_config_option；因此不将“未发送模型消息”扩大为“没有任何设置请求”。收据只有事件类型、时间、字节数与固定错误分类，不含请求/响应正文或秘密值。

[13 个观察身份](all-observed-processes.json)以 PID 与启动时间区分。第一次退出收据 04:03:33 及最终退出收据 04:05:30 均显示应用/子进程集合为空，上一阶段观察进程无残留；范围限这些已观察身份，不声称观测到了每个瞬时进程。

[重复产物删除证明](duplicate-removal.json)记录四个关键文件精确一致后，仅删除本次 `src-tauri/target/release/bundle/macos/Farfold.app`，正式 `/Applications/Farfold.app` 保留且 SHA 一致。未清理整个 target 或其他用户文件。

`invalid-registration-target.json` 是将 `registry:` 前缀重复传入观察工具后得到的无效目标 `registry:registry:dirac`，**不计为 Dirac 未登记或读取失败**。实际登记以修正后的 [dirac-registration.json](dirac-registration.json)为准，原错误收据保留。

## 尚未完成

Codex 真实冷恢复漂移仍失败；只读弹层文案冲突留待下一片修正，不通过显示修改或强改模型关闭该问题。Dirac 本片没有真实首发/续接、登录成功或 Key 交付；真实确认提示、第二模型选择、多模型 API 路线及更多旧格式安装矩阵未由本片补测。完整目录接入、账号生命周期和 J1–J6 全部出口仍按对应覆盖表继续推进。
