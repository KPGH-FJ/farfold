# Codex 恢复模型与推理选择不一致：官方问题报告草稿

整理与已安装文件核对日期：2026-10-01。**仅为脱敏草稿，尚未对外发送。** 本次只读核对现存官方包、Farfold 实现、已有实验记录和官方文档，没有启动 Agent、发送请求、更新依赖、修改模型、用户配置或凭据。

## 问题与期望

客户端保存了对话首次请求被接纳时的模型与推理选择；在冷恢复同一对话后，官方恢复接口返回了不同模型，或没有返回可核对的标准推理选项。客户端因此保留历史及待发内容并阻止续发。下述两个样本的版本、请求条件与结果不同，不能合并为同一个已定位原因，也不能据此声称所有 Codex 对话均无法恢复。

希望确认：官方接入包能否在 `session/load` / `session/resume` 时保持该条历史已有的模型与推理选择，并返回可核对的实际值；若必须由客户端提供原选择，是否有正式、逐对话的恢复输入与明确的“不支持/不可用”响应，而非默默采用当前默认值。客户端不希望修改程序全局配置、改用其他模型，或在恢复后通过设置接口掩盖差异。

## 样本 A：2026-09-22，显式原选择可保持的底层对照

- 版本：Codex CLI `0.155.1`，`@agentclientprotocol/codex-acp 1.12.0`。
- 测试历史原选择：`gpt-5.5 / low`，首发已成功；原选择在客户端记录与该测试历史的 `turn_context` 中一致。
- 各组使用同一测试历史、同一 CLI、同一正常 HOME 和工作目录，每组新建官方 `app-server` 进程。完成初始化后，只调用 `thread/resume`，不续发消息。
- 各组共同请求字段为 `threadId: <same-test-thread>`、`cwd: <same-original-directory>`、`excludeTurns: true`。下表仅列差异字段；占位符不是实际标识或路径。

| 恢复请求的差异字段                                                                       | 返回 `model / reasoningEffort` |
| ---------------------------------------------------------------------------------------- | ------------------------------ |
| 不提供 `config` 和 `modelProvider`                                                       | `gpt-5.5 / low`                |
| 仅 `config: {}`                                                                          | `gpt-6-astra / high`           |
| 仅 `modelProvider: "openai"`                                                             | `gpt-6-astra / high`           |
| `config` 仅包含 `features.cwd_relative_turn_diffs: false`                                | `gpt-6-astra / high`           |
| `config` 仅包含本测试目录的 `projects[<same-original-directory>].trust_level: "trusted"` | `gpt-6-astra / high`           |
| 接入包等价的 feature、project 配置及 `modelProvider: "openai"`                           | `gpt-6-astra / high`           |
| 上一组再增加 `model: "gpt-5.5"`，并在 `config` 中增加 `model_reasoning_effort: "low"`    | `gpt-5.5 / low`                |
| 最后再次不提供 `config` 和 `modelProvider`                                               | `gpt-5.5 / low`                |

该样本证实特定恢复参数可触发返回值变化，也证实底层明确提供原选择的对照能够返回原值。它没有证明 ACP 客户端已有逐历史传入这些字段的入口，也没有验证显式覆盖后的实际续答。

## 样本 B：2026-09-30，Astra 历史的返回漂移

- 版本：Codex CLI `0.155.1`，`@agentclientprotocol/codex-acp 1.13.1`。
- 测试历史原选择：`gpt-6-astra / ultra`，安装版首发成功；客户端记录与原 `turn_context` 一致。
- 冷恢复后的安装界面显示模型变化，暂停发送。随后在同一原工作目录，以未修改的官方程序分别进行 ACP 和底层恢复；均未发送消息或调用模型/推理设置接口。

| 官方入口与请求字段                                                                       | 实际返回                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ACP `session/load`：`sessionId`、原 `cwd`、`mcpServers: []`                              | 标准 `configOptions` 的模型为 `gpt-6.1-sol`，没有推理选项；旧 `models.currentModelId` 为 `gpt-6.1-sol[ultra]` |
| 底层 `thread/resume`：`threadId`、原 `cwd`、`excludeTurns: true`；无模型、推理或配置覆盖 | `model: "gpt-6.1-sol"`、`reasoningEffort: "ultra"`；返回的目标身份匹配                                        |

因此，这个模型差异不是客户端单独把正确返回值显示错了；标准推理选项缺失也不等于底层已把 `ultra` 改成别的等级。本样本没有重复样本 A 的显式原模型覆盖组，不能宣称同一参数修复已适用。

两次官方恢复分别在目标历史追加了 `thread_settings_applied` 事件；原 `turn_context` 的模型/推理字段保持，没有新增请求。恢复不是无副作用的文件读取。底层为何返回另一模型、如果继续发送会实际使用哪个模型，均仍未知。

## 2026-10-01 已安装源码与接口核对

本次查看现存包清单确认接入包仍为 `1.13.1`，所用 CLI 包为 `0.155.1`；没有执行 `--version` 或重新运行恢复。

- 接入包 `dist/index.js:33808` 的 `resumeSession` 与 `33843` 的 `loadSession` 均调用 `threadResume`，传入 `excludeTurns`、`config`、`cwd`、`modelProvider` 和 `threadId`；没有读取 ACP 请求中的逐历史模型/推理保持值。返回模型状态来自底层 `model / reasoningEffort`。
- `dist/index.js:33969` 的 `createSessionConfig` 合并程序配置及工作目录/MCP 配置。`40564` 读取的 `CODEX_CONFIG` 是进程级配置，不能视为逐历史恢复接口；向共享进程注入一个历史的模型值可能影响其他对话，本报告不建议此方式。
- `dist/index.js:39043` 的 `getOrCreateSessionWithHistory` 使用返回模型列表建立状态；标准推理选项依赖该模型的支持列表。本轮没有重新查询模型列表，不能进一步确定样本 B 为什么缺少标准推理选项。
- 本地 `agent-client-protocol-schema 1.9.1` 的 `LoadSessionRequest`、`ResumeSessionRequest` 没有模型/推理保持字段；`_meta` 不赋予未声明键任何约定语义。未发现已安装接入包消费相应扩展的代码。
- 当前 Farfold 继续按标准 `session/load` 恢复，并比较保存的完整选择；恢复路径不自动重设模型/推理。保护生效不等于恢复问题已解决。

[官方 OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)说明 `thread/resume` 支持配置覆盖，并说明恢复为不同模型时会发出警告及在下一请求应用模型切换说明。它没有承诺已安装 ACP 接入包提供同样的逐历史输入，也不能代替上述固定版本的实际结果。

## 希望官方明确的恢复契约与验证条件

1. 没有模型/推理覆盖时，能否保证恢复该历史原选择；工作目录、MCP 或 provider 的非模型配置变化是否应触发模型默认值重选。
2. 若需要显式原选择，提供 ACP 可调用、对该历史生效的正式参数或能力声明；不能只能改变整个进程的 `CODEX_CONFIG`。
3. 标准返回应区分实际值、未提供、不支持或不可用；旧复合模型 ID 包含的推理值与标准选项缺失时，应有可核对的解释。
4. 后续验证使用自有测试历史，先确认同一历史、来源、模型及推理均保持，再明确续发；不可通过接受新默认值、关闭差异保护、升级日常 CLI 或改写用户配置来判定修复成功。

本次未发现可以在现有 ACP 路线直接实施的安全修复入口。两个样本的失败继续保留；没有对外提交 issue，没有新的安装版恢复或续答通过结论。

## 仓库内证据索引

以下仅供仓库内复核，原始材料可能含本地测试身份与路径，**不作为本脱敏草稿的公开附件**。

- 样本 A：[调查说明](../2026-09-22-capability-followup/README.md)、[底层单变量收据](../2026-09-22-capability-followup/resume-matrix.json)、[原选择及对照](../2026-09-22-capability-followup/model-results.json)。
- 样本 B：[首发及安装冷恢复](../2026-09-30-agent-access-first-slice/codex-restore-drift.md)、[官方接口调查](../2026-09-30-agent-access-mechanisms/codex/README.md)、[ACP 返回字段](../2026-09-30-agent-access-mechanisms/codex/acp-restore-fields.json)、[底层返回字段](../2026-09-30-agent-access-mechanisms/codex/app-server-restore-fields.json)、[恢复追加事件类型](../2026-09-30-agent-access-mechanisms/codex/native-append-check.json)。
- 后续显示复验：[2026-10-01 安装记录](../2026-10-01-agent-selection-labels/installed.md)，确认差异展示与发送保护继续存在，没有关闭恢复失败。
- 当前产品源码：[恢复请求与配置保护](../../../src-tauri/src/acp_client/pump.rs)、[完整选择保护](../../../src-tauri/src/acp_client/model_guard.rs)。
