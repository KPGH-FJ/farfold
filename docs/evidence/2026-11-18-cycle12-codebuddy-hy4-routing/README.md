# 第 12 周期 CodeBuddy Hy4 实际选模核对

2026-11-18，macOS arm64，正式 Farfold `98d365c08`，当前目录登记 CodeBuddy 2.184.0。调查针对原自建 A、B 确认的 `hy4std` / `enabled` 与实际 `hy4flash-free` 的差异。两条原请求的厂商记录、准确会话归属及此前停止和冷开动作见[原正式实测](../2026-11-18-cycle12-codebuddy-stop-display/README.md#模型显示与实际请求不一致)。

## 显示和推理取值

Farfold 读到 Agent 返回的 `currentValue` 已经等于所保存的模型，便跳过显式设置。原 A、B 发送前均没有此设置请求。CodeBuddy 的 `getModelsInfo` 用初始化目录的 `currentModelId` 作为界面回读。厂商日志显示两条会话都从 `snapshot` 回读 `hy4std`，同时 `requestOptions.model` 和 `options.model` 均为空。实际推理另外按这两个会话字段选模型。原请求的解析日志明确走到运行中 Agent 的默认 `hy4flash-free`，与原请求和返回记录一致。

普通 `--acp` 连接的 `session/set_config_option` 模型项及旧 `session/set_model` 都调用 `applyRuntimeSessionModel`。该函数给当前会话设置模型后还会同步当前 CLI 进程的默认 `model`。新增源码复核确认这是 `CliSettingsProvider` 的内存更新。`/model <id>` 另有写用户设置文件的路径。2.184.0 安装源码与官方已发布的 2.185.0 在该设置分支一致。`thought_level` 可对准确会话单独设置，模型与思考档须分别核对。 [追加的源码核对和正式试验](../2026-11-18-cycle12-codebuddy-hy4-official-launch/README.md#原登记与全局设置)

| 核对原件                                  | 定位                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Farfold 草稿打开与配置恢复                | [`EmptyState.tsx`](../../../src/components/EmptyState.tsx) 与 [`saved_configuration_restore.ts`](../../../src/runtime/saved_configuration_restore.ts)                                                |
| CodeBuddy A 自有日志                      | `~/.codebuddy/logs/2026-11-18/a__3664ff97c936bd12b985bea9efab6760.log`，第 325–326 行为目录快照及空模型字段，第 1406 行为实际 Flash Free，第 2078–2079 行为冷开回读。                                |
| CodeBuddy B 自有日志                      | `~/.codebuddy/logs/2026-11-18/b__29d5839b5a00e8bce0dee7a22fa74a0e.log`，第 325–326 行为目录快照及空模型字段，第 738、910 行为实际 Flash Free。                                                       |
| 本机 2.184.0 `dist/codebuddy-headless.js` | SHA-256 `c6857206c76cdabd9186f9374620b69339a5e912d9a0dd9539c182ddc32c3287`。第 38–41 行为模型目录和设置，第 1331 行是全局同步条件，第 1388、5366 行是实际模型解析。                                  |
| 官方当前分发                              | [ACP 目录登记](https://github.com/agentclientprotocol/registry/blob/main/codebuddy-code/agent.json) · [CodeBuddy 2.185.0 发布包](https://www.npmjs.com/package/@tencent-ai/codebuddy-code/v/2.185.0) |

## 可复验条件

CLI 文档支持当前会话启动参数 `--model`。2.184.0 解析和新建源码显示启动参数可传入会话 `options.model`，仍需用当前账号实测实际模型。当前官方登记只带 `--acp`。启动参数可由用户显式配置在独立入口，正式首发登记仍需安全的会话级选模。官方 HTTP 的 ACP 传输复用当前设置分支。TypeScript SDK 可按查询选择模型及申请权限，但需要另验接入、同原会话恢复和停止。原登记、用户配置和历史保持。本批 CodeBuddy 零发送。 [CLI 模型参数](https://www.codebuddy.ai/docs/cli/cli-reference) · [官方 HTTP](https://www.codebuddy.ai/docs/cli/http-api) · [官方 TypeScript SDK](https://www.codebuddy.ai/docs/cli/sdk-typescript)

本批 S4 实测失败，已有双任务和停止证据限 Flash Free。后续获授权从 Farfold 另建独立测试入口，先通过一条 Hy4 / On 短问，再完成双任务和冷开。原目录的实际选模仍单独验。 [后续实测](../2026-11-18-cycle12-codebuddy-hy4-official-launch/README.md) · [官方 ACP 启动方式](https://www.codebuddy.ai/docs/cli/acp) · [产品约定](../../../PRODUCT.md#8-架构边界开发者约束)
