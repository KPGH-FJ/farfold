# Codex 服务配置最小验证

时间：2026-09-23 23:39–23:43（Asia/Shanghai）。

范围：已登记的 `@agentclientprotocol/codex-acp 1.12.0`，其登记的 `CODEX_PATH` 返回 `codex-cli 0.155.1`。复用 `2026-09-21-acceptance-fixes/probe.py`，未修改正式代码、Agent 包、用户配置、默认模型或既有会话。测试仅创建专用新会话；它们由 Agent 自己保留历史。未复制私有 HOME。

## 已取得的受控证据

这一节使用真实 Codex ACP/CLI 和本机受控 Responses 服务，**不是外部真实模型质量或服务兼容性验证**。HTTP fixture 只记录方法、路径、模型、推理、假 Key 是否匹配和受控工具结果是否到达；不保存请求正文或认证头。

| 场景                         | 实际结果                                                                                                                                                                                          | 证据                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 同一个专用项目、两个服务并行 | 两进程分别访问自己的 `/v1/responses`；自定义模型 A/B、各自假 Key 正确，各一次请求并返回 `end_turn` 与受控标记                                                                                     | `result.json`、`env-a-new.json`、`env-b-new.json`        |
| 退出进程后冷恢复             | 用原 native session ID，A/B 分别恢复原模型和地址；实际 HTTP reasoning.effort 都保持 `high`；各一次请求并返回标记                                                                                  | `result.json`、`env-a-load.json`、`env-b-load.json`      |
| 真实工具往返                 | 服务返回一次 `exec_command`，Agent 执行 `printf FARFOLD-CODEX-TOOL-OK`；第二次 HTTP 请求包含对应 function_call_output 标记，然后完成                                                              | `tool-result.json`、`tool-a-new.json`、`tool-b-new.json` |
| A 失败时 B 继续              | A 服务返回受控 401，B 正常完成；地址、模型、Key 未串用                                                                                                                                            | `fault-result.json`、`fault-typed-result.json`           |
| 失败可观测性                 | 不声明 sessionFailure 时，A 仍以 `end_turn` 结束且无成功标记；声明现有 JetBrains AIR sessionFailure 能力后，返回 `category=service,severity=error`，仍同时 `end_turn`。不能仅看 stopReason 判成功 | `fault-typed-result.json`                                |
| 未列出的第二个自定义模型     | 当前配置模型确实出现在 options 中；对另一个未列出的自定义模型调用 `session/set_config_option`，返回 `-32602`                                                                                      | `menu-result.json`                                       |
| 回收                         | 所有上述探测记录 `cleanup_survivors=[]`                                                                                                                                                           | 各阶段 JSON                                              |

不需要 `providers/set` 就能通过官方环境入口传递这次完整服务配置。`providers/list` 已运行，返回正确 baseUrl。进程作用域 `providers/set` 的变更行为本轮没有动态执行，仍以先前本机包源码分析为依据。

## 已验证的最小配置形状

```json
{
  "model": "chosen-custom-model",
  "model_reasoning_effort": "high",
  "model_provider": "farfold_service_id",
  "model_providers": {
    "farfold_service_id": {
      "name": "User service label",
      "base_url": "https://service.example/v1",
      "wire_api": "responses",
      "env_key": "FARFOLD_SERVICE_VALIDATION_KEY",
      "requires_openai_auth": false,
      "request_max_retries": 0,
      "stream_max_retries": 0
    }
  }
}
```

通过 `CODEX_CONFIG` 传该对象，`MODEL_PROVIDER=farfold_service_id`；真实 Key 只放引用的进程环境变量。配置对象不能含明文 Key，因为接入包的启动诊断会记录 CODEX_CONFIG。

正式用途仍要映射被用户选择的服务和模型；以上不证明任意 OpenAI-compatible API 或模型都满足 Codex 的 Responses/工具要求。

## 对实现方案的约束

- 连接复用条件必须包括**有效的启动配置**。不同服务要隔离；同一服务的任意自定义模型也不能假设可在已有草稿连接里切换。当前最小路线是先选服务与模型再准备对应草稿连接；官方 model_catalog 路线本轮未验证。
- 冷恢复的 `models.currentModelId` 为 `farfold-fixture-a[high]` / `farfold-fixture-b[high]`，实际 HTTP reasoning 也保持 high；但 configOptions 没有独立推理等级项。Farfold 当前只检查 configOptions 的 ModelGuard 不足以独立核实这份推理信息，不能把本次原始协议观测等同于正式 UI 已正确保护。
- 受控 401 即使配置 request/stream 重试数为 0，Agent 仍访问 A 服务 3 次。探测脚本没有重发 ACP prompt。这是 Agent 自身行为，不能承诺一次用户测试/任务严格只有一次 HTTP。
- 原有账号环境被保留；本轮不是干净环境/完全未登录条件验证。
- 所有假 Key 随探测进程消失，未入证据或配置对象。没有扫描外部 Agent 私有日志，不能宣称已完成全面日志审计。

## 外部 Atria 验证入口

`validate_atria.py` 由 root 启动并注入用户授权凭据。读 Key 使用 getpass / stdin；不把 Key 写源码、argv、配置对象或证据。最多 3 次正常 prompt：短文本、一次指定 printf、退出后冷恢复。失败/模型推理漂移时停止后续步骤，不由脚本重试。

root 随后已运行真实请求，结果见 `atria-result.json`：

- 新会话 `Atria-Dawn-Preview[high]`：文字回复成功；指定 printf 工具调用完成，工具输出与最终回复含预期标记。
- 结束进程后加载同一个专用会话，模型/推理仍为 `Atria-Dawn-Preview[high]`；续发回复含预期标记且 stopReason 为 end_turn，但同时返回 `sessionFailure={category:service,severity:error}`。**这一项按失败保留，不能因回复出现而称恢复验收通过。**
- 只读定位此次专用会话 `01a0cef1-c801-77e2-89a5-26ddec8fa42d` 的 Agent-owned rollout：三次 task_started/task_complete、一组 function_call/output；没有 error/warning 事件。现存探测未保存错误 message/code，无法由这些事实进一步定位根因，不能直接归责 Atria 或 Codex。
- 未重试真实请求、未改变模型或推理等级。后续复验需先在探测中保留脱敏后的错误 code/message，现有仅分类的证据不够。
