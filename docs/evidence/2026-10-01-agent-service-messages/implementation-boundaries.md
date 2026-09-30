# OpenCode Messages：显式服务交付的合并边界

2026-10-01，只读补充 [research.md](research.md)。核对 OpenCode `1.18.31`，官方 commit `014614d35b397775e5d397a490fc72368c894ec2`（该提交 package.json 的 version 为 `1.18.31`），以及其固定 `@ai-sdk/anthropic` `3.0.111`。未修改产品源码、安装或执行 Agent、发起 SDK 请求，也未读取用户配置、账户或凭据。

**已证问题是“同一提供方 ID 的继承配置可以改变显式服务的含义”，不是当前用户已经发生冲突。** 独立摘要 ID 降低碰撞，但生成正确 JSON、ACP 返回相同模型 ID，都不足以证明最终请求地址、实现与认证头一致。此边界同样涉及现有 OpenCode Chat/Responses；不据此默认禁用所有服务，也不要求清除用户配置或插件。

## 1. 当前实际合并路径

[Farfold 编译器](../../../src-tauri/src/acp_client/service_config.rs) 只读取继承的 `OPENCODE_CONFIG_CONTENT`，拒绝其中同 ID 的不同定义，然后增加提供方 `npm`、`options.baseURL/apiKey`、模型 `name` 与顶层模型选择。它没有读取最终合并配置，模型也没有显式 `id`、模型级 `provider.npm/api` 或 headers。

官方固定版本有三层区别：

1. [config.ts](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/config/config.ts#L42) 使用深合并。inline 在 L482–489 合入；active-org、managed 文件和 macOS managed preferences 仍可在 L492–547 后合入。因此 inline 不是所有配置层的最终权威。
2. [provider.ts](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/provider/provider.ts#L1481) 由合并配置生成实际模型：模型级 `provider.npm` 优先，模型 `id` 决定 API 模型名，模型级 `provider.api` 参与 `model.api.url`。SDK 创建时非空 `options.baseURL` 又优先于该 URL；模型 headers 最后覆盖提供方 headers（L1734–1786）。
3. 官方 [plugin config hook](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/plugin/index.ts#L244) 与 [请求 headers hook](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/session/llm/request.ts#L134) 仍属于用户所选 Agent 的运行行为；本次不把任意插件可能修改行为扩大成全局禁用条件，也不声称 Farfold 能隔离任意插件。

## 2. 可以明确覆盖的字段与不能伪造的清空语义

下表“覆盖”只指相对于更早的静态合并层；不是无条件压过后续管理策略或运行 hook。字段合法性以 [ConfigProviderV1 schema](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/core/src/v1/config/provider.ts) 为准。

| 字段                                      | 最小处理与已证边界                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提供方 `npm`                              | 显式 Messages 实现为官方 `@ai-sdk/anthropic`；单独此项不足以覆盖继承的模型级实现。                                                                                                                                  |
| 每个 `models[id].id`                      | 显式写入用户选择的准确 API 模型 ID，可阻止更早同名项的旧 `id` 留存。只写 `name` 是展示，不能保护实际 API 模型。                                                                                                     |
| 每个 `models[id].provider.npm`            | 显式指定本次接口对应的官方实现，可覆盖更早该字段；不能只依赖提供方 `npm`。                                                                                                                                          |
| 每个 `models[id].provider.api`            | 可显式写入同一基础地址，避免继承模型级 URL。`model.api.url` 是运行时派生字段，不能把它直接塞入配置当作正式输入。                                                                                                    |
| `options.baseURL`                         | 非空字符串优先于运行时模型 URL；仍须与中央 Messages 测试共用确定的基础地址规则。不要从同名模型推断路由一致。                                                                                                        |
| `options.apiKey`                          | 继续只放 `{env:…}` 引用，秘密单独交付。该 SDK 的明确非空 Key 不回退全局 Key，但 headers 仍可能覆盖其认证头。                                                                                                        |
| `options.authToken`                       | Anthropic SDK 同时收到两个非空认证参数会报错。空字符串在已核实现中为假值，可表达不用 Bearer；这只能作为需实测的明确覆盖，不能假装消除了继承 headers。最小入口继续拒绝已知非空冲突，不静默沿用另一种认证。           |
| 提供方 `options.headers` 与模型 `headers` | `{}` 深合并不会删除旧键。模型 headers 是字符串映射，`null` 不符合 schema；不能用 JSON `null`/数组或空值碰巧通过的运行行为伪装成官方整体清空接口。设置某些已知头只覆盖那些键，不证明其他大小写或自定义认证头不存在。 |

Anthropic 的 [实际认证头构造](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.111/packages/anthropic/src/anthropic-provider.ts#L115) 在默认 `x-api-key`/版本头之后展开 `options.headers`；[请求实现](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.111/packages/anthropic/src/anthropic-messages-language-model.ts#L807) 再合并本次请求 headers。故认证冲突须沿真实请求路径验证，不能只比最终模型名称。

## 3. 最小实施范围与官方核对面

1. 延续现有编译器与来源修订：加入 Messages 对应实现，补齐上述合法的模型 `id/provider` 标量；保留 inline 同 ID 冲突拒绝、原服务限制、用户原稿及恢复模型保护。不要为通过测试移除 `enabled_providers/disabled_providers`。
2. 已知同 ID 的非空 token、危险或无法归属的认证 headers、不同实现/地址/模型，按明确冲突处理；不能把它们视为本次服务自动授权。对未读取的其他配置保持“未核实”，不宣称已经拒绝所有来源的冲突。
3. 官方 [`opencode debug config`](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/cli/cmd/debug/config.ts) 可以输出已解析配置，是后续调查静态层冲突的现成核对面。它输出完整配置，可能包含已展开的秘密；不得将完整 stdout/stderr 写入证据或日志。本次未执行。即使将来只在内存提取目标字段，它仍不是同一 ACP 连接或最终请求的证明，也不能替代真实请求验收。
4. 实施时优先用任务自有配置和 canary Key 构造受控反例，经固定官方 SDK 请求路径检查实际目标/实现/模型/认证；不需要读取当前用户配置来证明这个机制。没有完成这层检查前，Messages 保持实现/未验证的区分；无依据的配置组合不计已支持，但不预先断言所有 Messages 都不可支持。

必要反例限于本片已证风险：原同 ID 的模型 `id`、模型级 npm/API URL、提供方与模型 headers、非空 authToken；空 headers 对象保留旧键；无冲突正例；后合入策略覆盖时诚实失败。真实请求检查还需验证秘密没有进入 inline、MetaStore、诊断或错误文本。各例不能仅断言编译结果 JSON。

## 4. 现有 Chat / Responses 的同类边界

两条现有 OpenCode 路线经过相同的配置深合并、模型派生和 `resolveSDK`，因此同 ID 的实际模型、模型级 npm/URL、headers 继承问题不是 Messages 独有。Anthropic 的 `authToken` 双参数报错则是本次 Messages SDK 的具体行为，不能直接套给其他 SDK。已有受控服务成功证据继续成立于原配置样本；本次没有推翻那些真实结果，也不能把它们扩展为任意配置下的完整隔离保证。后续补强可共享编译器字段与反例，不另建来源账本、代理、私有 HOME 或环境清空流程。
