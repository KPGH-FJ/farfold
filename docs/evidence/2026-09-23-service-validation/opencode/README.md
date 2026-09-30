# OpenCode 完整服务配置最小验证

核查时间：2026-09-23。范围仅为受控技术验证，未进入生产实现。

## 结果与层级

正式注册启动目标 `/Users/tw/.opencode/bin/opencode acp` 经 ACP 握手确认为 **1.18.31**。复用既有 `2026-09-21-acceptance-fixes/probe.py` 的 ACP 发送、接收与结果处理；新增脚本仅增加受控 HTTP 服务及分会话观察。

当前完整证据：[20260923-234114-result.json](./20260923-234114-result.json)。两阶段均通过，进程均回收，所属进程组无残留。

| 场景               | 实际证据                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 配置进入真实 Agent | `OPENCODE_CONFIG_CONTENT` 定义两个独立 provider，各含地址、环境 Key 引用、相同模型 ID；真实 ACP `configOptions` 包含两者                  |
| 用户选择模型       | 两个新会话各经 `session/set_config_option` 选择对应 provider/model，未修改用户默认模型                                                    |
| 请求到正确地址     | 同一 ACP 进程内并行请求分别命中 `/a/v1/chat/completions`、`/b/v1/chat/completions`，真实 HTTP 请求的 Key 各自匹配                         |
| 请求和响应隔离     | 服务端同时等待两个请求到达后才响应；每个请求不含另一个服务的标记，每个 ACP 会话仅收到对应服务的本轮 receipt                               |
| 冷恢复             | 退出并回收第一个进程，第二个进程恢复相同的两个 native session ID；模型选项保持原 provider/model；新 HTTP 请求带各自前轮 receipt，仍无交叉 |

初次证据 `20260923-233948-*` 保留。随后增加分会话响应归属和进程组残留检查，重跑一次得到上述完整证据；并非失败重试。

## 明确没有证明的能力

- 本次是**真实 OpenCode + 受控本地 Chat Completions HTTP 服务**，不是实际模型推理成功，也不是安装版 Farfold UI 验收。
- 未测试 Responses、Anthropic Messages、真实外部服务计费/配额/工具调用与复杂流式行为。
- 两条现有 Farfold 服务记录有地址，但 API 格式为空，且没有模型字段。无法不猜测地形成真实服务请求，因此没有读取 Keychain、调用真实服务或用标题推断模型。
- 冷恢复重新提供相同配置。服务改址、换 Key、删除、配置修订与已有会话之间的安全行为尚未测试；相同模型 ID 不保证背后的服务地址保持不变。
- 未测试连接运行中增加或热更 provider。启动配置不能因为 Farfold 元数据保存就被认为已自动应用。

## 对接口实现的建议

1. Farfold 服务记录必须至少包含稳定身份、API 格式、基础地址和模型 ID；实际兼容条件由接入层判断。
2. OpenCode 接入层可编译官方内联配置，使用独立 provider ID 与进程环境 Key 引用；不写用户配置、不改 HOME、不覆盖内建 provider。
3. 保存、直接 API 测试、Agent 配置交付、实际会话请求分别记录状态。
4. 保留旧会话对应的服务来源语义；编辑/删除配置不得让既有 provider ID 静默指向不同服务。

## 官方依据

- [v1.18.31 内联配置入口](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/config/config.ts#L482)
- [v1.18.31 provider 实现](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/provider/provider.ts)
- [v1.18.31 ACP 模型配置入口](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/acp/service.ts#L409)

脚本仅写本目录中的脱敏证据，并新建用于验证的 Agent 会话。未改已有会话、用户配置、正式数据库、凭据、生产源码或用户默认模型。两个随机 fixture Key 只在内存，未输出或保存。配置中的标题生成仅对此探测进程关闭，防止额外模型请求。

## 2026-09-24 Responses 补验

已在同一官方 OpenCode 1.18.31 上，使用 `@ai-sdk/openai` 和受控 Responses 服务完成启动模型、新会话、精确工具往返、两来源隔离和冷恢复验证。详见 [Responses 受控验证](./responses-validation.md)。本节补充前述尚未验证的接口范围；原证据与当时结论保留，不代表生产实现或安装版已经验收。
