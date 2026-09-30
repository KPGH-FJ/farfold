# Codex 冷恢复模型与推理选择变化（2026-09-30）

本记录仅涉及本片新建的测试对话，未修改模型、外部程序、用户配置、账号或历史。

## 真实安装结果

- 唯一安装候选：`/Applications/Farfold.app`，可执行文件 SHA-256 `cab9804e3bf2028d9b2859a674704aa8842e60f4fe69ecd92c9b3a8fa6d26c94`。
- Agent：Codex；外部对话 ID `01a0f170-373c-7700-8bad-f9b90bc68b66`；工作位置 `/Users/tw/Library/Application Support/ai.farfold.desktop/conversations`。
- 首发实际成功：`gpt-6-astra`、`ultra`，收到固定验收标记。见 [首发截图](09-final-codex-reply.png)。
- 正常退出后重开：历史显示完整，但界面提示 `gpt-6-astra → gpt-6.1-sol`、`ultra → 未提供`，暂停发送。见 [冷恢复失败截图](18-final-codex-restore-drift.png)。这是该对话的真实续接失败，不能以历史回放成功关闭 J5。
- [退出记录](cold-exit.json) 中本轮进程已结束；[重开记录](cold-restored.json) 确认同一候选与原有索引保持。记录不表示所有 Agent 的退出/恢复通过。

## 仅此对话的非秘密字段核对

通过只读 SQLite 查询 `sessions WHERE native_session_id = ?`，只匹配一行：

```json
{
  "_farfoldConfig": 1,
  "model": { "id": "model", "category": "model", "value": "gpt-6-astra" },
  "thoughtLevel": {
    "id": "reasoning_effort",
    "category": "thought_level",
    "value": "ultra"
  },
  "_farfoldService": { "kind": "existing" }
}
```

仅核对该对话自己的外部记录 `/Users/tw/.codex/sessions/2026/09/30/rollout-2026-09-30T16-30-58-01a0f170-373c-7700-8bad-f9b90bc68b66.jsonl`：第 1 行 `session_meta` 的 ID/工作位置匹配，`cli_version = 0.155.1`；第 8 行 `turn_context` 为 `model = gpt-6-astra`、`effort = ultra`。没有复制正文、系统提示或环境。首发选择在 Farfold 索引与该外部记录中均正确，不能把本次失败解释为索引未保存选择。

## 当前恢复与保护链路

- [pump.rs:1046](../../../src-tauri/src/acp_client/pump.rs#L1046) 的 `session/load` 请求只携带原对话 ID、工作位置及 MCP 列表，不写入替代模型或推理选择；[同文件:1088](../../../src-tauri/src/acp_client/pump.rs#L1088) 阻止恢复时修改这些选择。
- [session.rs:209](../../../src-tauri/src/acp_client/session.rs#L209) 从该索引读取保存选择，传给恢复操作。
- [model_guard.rs:83](../../../src-tauri/src/acp_client/model_guard.rs#L83) 读取原快照；[同文件:138](../../../src-tauri/src/acp_client/model_guard.rs#L138) 比较返回选项，变化或缺失时标为阻止；[pump.rs:746](../../../src-tauri/src/acp_client/pump.rs#L746) 在发送前落实保护。[config_check.ts:14](../../../src/runtime/config_check.ts#L14) 只展示检查结果并暂停发送。
- 比较 `af1926f` 与本片工作区：上述恢复请求、模型保护、会话索引和检查展示文件均无修改（`git diff --quiet` 退出 `0`）。本片没有改这些恢复算法；该事实不能替代旧候选的同条件对照实验，也不能排除其他输入变化带来的间接影响。

## 外部实现证据与未确认项

本测试所选安装条目的非秘密启动元数据显示接入组件 `@agentclientprotocol/codex-acp` 为 `1.13.1`。只读查看该安装的 `dist/index.js`：

- 33843–33869 行：加载调用官方 `thread/resume`，随后根据返回的 `model/reasoningEffort` 生成当前模型选择。
- 34069–34081 行：缺少模型/推理信息时存在默认值回退。
- 38123–38145 行：对话加载返回所建立状态的选项；38934–38955、39079–39085 行：模型与推理选项依据该状态及模型支持列表生成。

这些代码说明外部返回、默认回退或模型目录均可能影响恢复后的报告值，但本轮没有保留该测试的原始 `session/load`、后续选项更新或底层 `thread/resume` 非秘密收据。Farfold 现有协议日志仅保存事件类型、方向、字节数和错误类别。因此目前只能确认“保存选择正确，但冷恢复处理到的选择与原值不一致”；不能把变化直接归因于某个外部响应，也不能证明底层模型已经改变、仅报告值改变或断言具体外部根因。

## 交接与修复边界

本片接入/首发结果与该续接失败分别保留。模型保护应继续生效，不能为通过验收自动设置原模型、接受新默认模型、改变推理等级、升级日常 CLI 或改写用户配置。

下一优先项：仅对该测试对话捕获必要的模型/推理非秘密收据，分清 `session/load` 初始返回与后续选项更新，再核实官方恢复入口是否能保持原选择。若真实报告一致但 Farfold 归一化错误，修复归一化并回归；若外部恢复不能保持，保存复现材料并如实提供出口。对外发布或任何超出既有授权的账号/程序变更另按具体授权处理。未完成实际续发前，J5 保持失败。
