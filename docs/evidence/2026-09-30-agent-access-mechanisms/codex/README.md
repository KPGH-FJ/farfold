# Codex 冷恢复返回字段调查（2026-09-30）

本记录仅涉及测试对话 `01a0f170-373c-7700-8bad-f9b90bc68b66`。结论范围是恢复接口报告的模型/推理字段；没有继续发送消息，不能据此判断恢复后一次实际请求使用的模型。

## 已确认的结果

| 证据来源                                      | 模型                 | 推理等级               | 范围                       |
| --------------------------------------------- | -------------------- | ---------------------- | -------------------------- |
| 首发安装验收、Farfold 索引及原 `turn_context` | `gpt-6-astra`        | `ultra`                | 原选择与首发成功已记录     |
| ACP `session/load` 标准 `configOptions`       | `gpt-6.1-sol`        | 未提供该选项           | 当前接入组件直接返回的字段 |
| 同一次 ACP 返回的旧 `models.currentModelId`   | `gpt-6.1-sol[ultra]` | 复合 ID 中包含 `ultra` | 不是标准推理选项           |
| 官方底层 `thread/resume`                      | `gpt-6.1-sol`        | `ultra`                | 直接底层返回、目标 ID 匹配 |

直接底层恢复也报告了模型变化，故不能将 `gpt-6-astra → gpt-6.1-sol` 解释为 Farfold 展示代码单独造成。标准推理选项缺失与底层返回 `ultra` 同时成立，不能将界面的“未提供”写成已证实底层推理等级改变。

首发与冷恢复安装证据见[前片记录](../../2026-09-30-agent-access-first-slice/codex-restore-drift.md)。该记录对应唯一安装候选 `/Applications/Farfold.app`，可执行文件 SHA-256 `cab9804e3bf2028d9b2859a674704aa8842e60f4fe69ecd92c9b3a8fa6d26c94`。本调查运行独立官方接口探针，没有操作正式应用或宣称新的安装验收通过。

## 执行与数据白名单

[restore_probe.py](restore_probe.py) 从只读 SQLite 精确读取已注册 `codex` 的启动命令及环境元数据。仅接受该条目当前已有的 `CODEX_PATH`；继承正常环境，没有启用原始接口日志、额外环境开关或私有 HOME。两个探针均使用原工作位置 `/Users/tw/Library/Application Support/ai.farfold.desktop/conversations`，只恢复指定测试 ID。

- ACP：准确注册命令 `/Users/tw/.nvm/versions/node/v22.22.3/bin/node` 加当前安装的 `@agentclientprotocol/codex-acp/dist/index.js`；请求 `initialize`、`session/load`。加载参数仅为指定 `sessionId`、原 `cwd`、空 `mcpServers`。
- 底层：当前注册 `CODEX_PATH` 的 `/Users/tw/.nvm/versions/node/v22.22.3/bin/codex app-server`，与接入组件启动底层的命令相同；请求 `initialize`、`initialized` 通知、`thread/resume`。恢复参数仅为指定 `threadId`、原 `cwd`、`excludeTurns: true`。
- 未发送 `prompt`、认证、设置模型/推理或配置写入接口。恢复请求没有补入模型或推理覆盖值。对外公开 issue 未执行。
- 返回白名单：模型/推理选项的 `id/category/currentValue`、`models.currentModelId`、底层 `model/reasoningEffort`、返回目标 ID 是否匹配。另保留命令、时间、通知数量、stderr 字节数、请求方法、进程退出与清理记录、目标文件长度/哈希及 `turn_context` 的 `model/effort`。
- 只对目标 `session/update` 中的 `configOptions` 收取同样白名单；本次没有该类收据。通知计数不等于保存通知内容。原始 stdout、stderr、重放正文、系统提示和环境秘密没有保存到证据或打印。

执行命令均退出 `0`：

```sh
python3 docs/evidence/2026-09-30-agent-access-mechanisms/codex/restore_probe.py acp
python3 docs/evidence/2026-09-30-agent-access-mechanisms/codex/restore_probe.py app-server
```

原始白名单结果分别为 [acp-restore-fields.json](acp-restore-fields.json) 和 [app-server-restore-fields.json](app-server-restore-fields.json)。两个结果均为 `outcome: completed`、`readerErrorType: null`、`processExitCode: 0`、`remainingOwnedPids: []`。探针只终止自己启动并跟踪的进程及后代。

## 官方恢复的实际历史副作用

不能称这些操作“零写入”或“全只读”。两次官方恢复均在目标外部记录追加了一个 `event_msg`，子类型为 `thread_settings_applied`。仅核对追加记录的类型，不复制其正文。长度和 SHA-256 前后值保存在上述 JSON；对两个已记录字节区间的[追加类型核对](native-append-check.json) 单独保留：

| 探针     | 执行前字节数 | 执行后字节数 | 原 `turn_context` 前后核对 |
| -------- | ------------ | ------------ | -------------------------- |
| ACP 加载 | 127579       | 128341       | 均为 `gpt-6-astra / ultra` |
| 底层恢复 | 128341       | 129103       | 均为 `gpt-6-astra / ultra` |

核对对象仅为 `/Users/tw/.codex/sessions/2026/09/30/rollout-2026-09-30T16-30-58-01a0f170-373c-7700-8bad-f9b90bc68b66.jsonl`。官方恢复追加了设置事件；没有新增 `turn_context`，原首发字段仍正确。原字段未被覆写不表示恢复完全没有影响，也不证明未来续发仍使用原模型。

## 当前官方入口边界与源码定位

当前锁定 `agent-client-protocol-schema 1.9.1` 的 `src/v1/agent.rs`：`LoadSessionRequest`（964 行）、`ResumeSessionRequest`（1297 行）均没有模型或推理等级保持参数；`_meta` 的文档禁止假定任意键的含义。

当前安装 `@agentclientprotocol/codex-acp 1.13.1` 的 `dist/index.js`：

- 33808 行 `resumeSession`、33843 行 `loadSession` 将 ID、工作位置、根目录/MCP 配置、模型服务交给底层 `threadResume`，没有读取 ACP 请求中的原模型/推理保持值。两条路径均依据底层返回的 `model/reasoningEffort` 生成 `currentModelId`。
- 33969 行 `createSessionConfig` 合并程序已有配置、工作目录和 MCP 设置；没有针对该历史对话读取原模型快照。README 的 `CODEX_CONFIG` 是进程配置合并入口，不是 ACP 恢复时保持既有选择的参数；本调查没有设置该环境变量。
- 39043 行 `getOrCreateSessionWithHistory` 从返回模型列表建立当前状态，39085 行左右从当前模型支持列表取得推理选项。38934 行 `createSessionConfigOptions` 仅在支持列表非空时发出推理选项。这解释了标准选项可能缺失的机制，但本探针未保存模型列表，不能把本次缺失进一步归因于某个具体列表内容。

当前 Farfold [session.rs:209](../../../../src-tauri/src/acp_client/session.rs#L209) 读取原索引选择；[pump.rs:1046](../../../../src-tauri/src/acp_client/pump.rs#L1046) 按官方加载协议发送恢复请求；[model_guard.rs:138](../../../../src-tauri/src/acp_client/model_guard.rs#L138) 比较原选择与恢复返回；[pump.rs:746](../../../../src-tauri/src/acp_client/pump.rs#L746) 在发送前执行保护。它没有在该加载请求中替换模型，本片这些恢复/保护源文件也无修改。没有为了通过而删除保护或注入配置覆盖值。

## 结论与交接

已确认外部恢复返回的模型与原选择不一致，并且 ACP 标准推理选项报告缺失。当前已安装 ACP 加载/恢复路径没有核实到保持原模型和推理选择的官方输入。本调查未找到需要修复 Farfold 归一化才能消除该模型差异的证据，因此不改仓库恢复算法；模型保护继续生效，这个测试对话的真实 J5 续接仍失败。

具体底层为何选择该返回模型、实际续发会使用何种模型仍未验证。不得据此声称所有 Codex 版本或所有对话均失败，也不能自动重设模型、接受新默认值、升级日常 CLI、修改外部程序或用户配置来关闭验收。保留脱敏复现材料，继续其他接入机制；后续只有官方可保持原选择的入口获得核实，或返回原选择后，再在同条件安装版完成真实续发验证。
