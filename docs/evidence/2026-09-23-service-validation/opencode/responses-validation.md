# OpenCode Responses 受控验证

时间：2026-09-24 00:19–00:23（Asia/Shanghai）。正式登记的 `/Users/tw/.opencode/bin/opencode acp`，真实 initialize 返回 OpenCode **1.18.31**。

复用本目录 `probe.py` 与既有 ACP Probe，增加 `--responses` 模式及 Responses SSE 返回分支；没有建立第二套模拟平台。只使用本机受控 HTTP 服务、内存随机 Key 和新建专用会话，未读取 Keychain、调用外部模型、改写用户配置、默认模型、已有会话或生产源码。Agent 自己保存这些新会话历史。

## 结果

首轮 [20260924-001906-responses-result.json](./20260924-001906-responses-result.json) 证明 Responses 的新建、工具、双来源及冷恢复路线。[第二轮](./20260924-002054-responses-result.json) 补充启动模型条件，A 会话不经过 `session/set_config_option`。最终再移除既有探测中的可选模型 `limit`，与生产转换器仅填模型 `name` 的形状一致；完整结果为 [20260924-002301-responses-result.json](./20260924-002301-responses-result.json)。三轮均通过；后两轮是配置交付边界的补验，不是失败重试。

| 场景           | 完整轮次结果                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 与实际接口 | 两个独立 provider 均使用 `@ai-sdk/openai`，真实请求分别到 `/a/v1/responses`、`/b/v1/responses`，没有走 Chat Completions                                                         |
| 启动模型       | 配置 `model=farfold-controlled-a/shared-model-id` 后，两个新会话直接返回此当前模型；A 不发送设置模型命令即请求成功，B 经显式选择后使用 B                                        |
| 来源隔离       | 相同模型 ID、不同基础地址和 Key；两 HTTP 请求先同时到达再放行，最大并发 2。每条请求只含本来源提示，每个会话只收到本来源 receipt                                                 |
| 工具往返       | 两来源分别返回一个 `bash` function call；仅批准各自一条确切的 `printf` 命令，真实执行完成。后续各自 HTTP `function_call_output` 包含对应输出，无交叉；工具阶段共 4 个 HTTP 请求 |
| 冷恢复         | 第一个进程退出回收后，新进程加载原两个 native session ID，保持原 provider/model；续发实际请求携带本来源前轮 receipt 和工具输出，没有其他来源内容                                |
| 完成与回收     | 6 次 ACP prompt 均 `end_turn`；本轮未观察到结构化协议失败。共 8 个本地 HTTP 请求；两个进程已回收，所属进程组残留均为空                                                          |

对应逐过程证据：[新建与工具](./20260924-002301-responses-new.json)、[冷恢复](./20260924-002301-responses-load.json)。报告只保存路由、选项、匹配布尔值、受控工具与结果统计，不保存认证头、随机 Key 或完整请求正文。

## 确切配置

[responses-configuration.json](./responses-configuration.json) 保存本次使用的两个 provider 定义及顶层启动模型。它从完整结果中的配置直接导出，不包含密钥；其中临时本地端口已关闭，不是可继续使用的服务地址。

单条 provider 的配置形状如下；B 同形但有独立 ID、地址及变量名：

```json
{
  "model": "farfold-controlled-a/shared-model-id",
  "provider": {
    "farfold-controlled-a": {
      "npm": "@ai-sdk/openai",
      "name": "Farfold controlled A",
      "options": {
        "baseURL": "http://127.0.0.1:PORT/a/v1",
        "apiKey": "{env:FARFOLD_CONTROLLED_KEY_A}"
      },
      "models": {
        "shared-model-id": {
          "name": "Controlled model A"
        }
      }
    }
  }
}
```

上述对象经 `OPENCODE_CONFIG_CONTENT` 传递，随机 Key 仅放在对应进程环境变量。探测额外关闭标题生成、自动压缩及除受控 bash 审批外的工具权限，避免额外模型请求与无关操作；这些探测约束不是生产配置要求。

官方 v1.18.31 源码将 `@ai-sdk/openai` 列为内置 SDK：[provider.ts](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/provider/provider.ts)。实际 `/responses` 路由、工具返回及恢复行为以本次 HTTP/ACP 观测为依据。

## 边界

- 这证明当前官方 OpenCode 组合存在可用的 Responses 配置路线，可以与 Codex 的 Responses 路线形成相同接口格式的交集；未直接验证 Farfold 安装版中同一条服务记录跨两 Agent 使用。
- 没有验证真实模型推理、外部服务收费/限流、任意 Responses 实现、复杂工具流或所有模型。模型 ID 相同也不等于能力相同。
- 本次未测试服务改址、换 Key、删除与已有连接交互，也未变更生产能力矩阵。这些由本轮配置身份保护和安装验证分别负责。
- 没有给配置添加“OpenAI 公司服务”含义：`@ai-sdk/openai` 是所用接口 SDK，服务来源由用户地址决定。
