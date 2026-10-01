# Messages 后端最小片

本片实现共享地址规则与 OpenCode 配置翻译，**公开 Messages 能力仍关闭**。未运行正式应用、真实 Agent、实际 SDK 请求、安装或全量 Rust 测试；实际 OpenCode canary 与安装验收由根任务另留证据。

## 源码范围

- [api_endpoint.rs](../../../src-tauri/src/api_endpoint.rs)：用现有 `reqwest::Url` 解析 Messages 基础地址。只有官方 HTTPS 默认端口根地址补 `/v1`，自定义 host、路径和非默认端口保持选定地址；仅移除末尾斜杠。解析失败及含账号、查询或片段的输入只返回固定错误。
- [api_test.rs](../../../src-tauri/src/api_test.rs) 与 [测试](../../../src-tauri/src/api_test/tests.rs)：中央模型列表与简短请求共用该地址规则。原 HTTP 错误、重定向禁跟随、正文上限、取消与 Keychain 等待所有权不变。
- [service_config.rs](../../../src-tauri/src/acp_client/service_config.rs)：OpenCode 模型 map 明确 `id`、模型级 `provider.npm` 与合法配置字段 `provider.api`，并使用同一基础地址。Messages 翻译为 `@ai-sdk/anthropic`；未添加推测的模型 limit、headers 清空或 authToken。秘密仍只在独立环境值中，inline 使用 `{env:…}`。
- [lib.rs](../../../src-tauri/src/lib.rs)：仅注册共享 helper。精确摘要及行数见 [source-final.json](source-final.json)。

`compile` 保留原 capability 准入。内部 `compile_selected` 供既有已开放路线和本片受控翻译测试使用，Messages 尚不能经公开 `compile` 进入实际连接。`api_types` / `validated_api_types` 均未增加 Messages。

基础地址补全不修改 `ServiceSnapshot.endpoint`、来源 identity、连接 revision 或凭据存储。公开保存仍经原 `credentials::validate_endpoint` 的 HTTPS 校验；helper 的 HTTP 合成输入测试不是新增公开 HTTP 入口。

## 红与绿

[backend-red.json](backend-red.json) 保留修改前两项行为失败，各命令 exit 101：

1. [api-root-red.log](api-root-red.log)：官方裸根模型列表实际生成 `/models`，预期 `/v1/models`。
2. [opencode-route-red.log](opencode-route-red.log)：现有 Chat 模型缺实际 API `id`，断言 `null` 与所选模型不同。

[backend-focused-first.json](backend-focused-first.json) 中三个定向命令均 exit 0：

- [endpoint-green.log](endpoint-green.log)：2 项，官方根补全、自定义 host/前缀/非默认端口不猜补、固定安全错误。
- [api-green.log](api-green.log)：7 项，包括三种格式、官方 Messages `/models` 与 `/messages`、秘密回显过滤、真实任务自有本机 HTTP 的跳转与大小上限、取消等待所有权。
- [service-green.log](service-green.log)：10 项，包括原 Codex/OpenCode 翻译、两个现有 OpenCode 格式的模型级字段、内部 Messages 翻译/公开门控、来源身份不迁移、秘密独立环境值、同 ID 地址/实现/模型/token/认证头冲突拒绝、限制名单保持、实际模型准入。

[backend-related.json](backend-related.json) / [service-source-green.log](service-source-green.log)：既有来源恢复 2 项 exit 0，仍拒绝为恢复会话替换或猜测原服务。

[backend-static-first.json](backend-static-first.json)：[格式](backend-format.log) 与 [clippy](backend-clippy.log) 均 exit 0。本片未运行全量测试或任何真实 Agent。

## 实际边界

同 ID 的 inline 提供方必须逐项完全相同；不同 `id/provider.npm/provider.api`、地址、token 或认证头都拒绝，原输入不变。`enabled_providers`、`disabled_providers`、其他提供方、权限和其他设置原样保留；保留限制不是所选模型实际可用的证明。

依据固定官方 [OpenCode 1.18.31](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/provider/provider.ts) 与 [Anthropic SDK 3.0.111](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.111/packages/anthropic/src/anthropic-provider.ts)，对更早合并层的合法标量显式覆盖有实际含义，但磁盘/组织策略的后合入、headers 深合并与插件钩子仍不能靠生成 JSON 或同名模型证明隔离。未读取这些用户配置，未宣称拒绝所有来源的冲突。继续遵守 [实施边界](../2026-10-01-agent-service-messages/implementation-boundaries.md) 和 [SDK 实际结果](../2026-10-01-agent-service-messages/sdk-canary-results.md)。

后续只有完成根任务的实际 OpenCode 请求核对，才决定是否开放 Messages 及其确切范围；有模型或 limit 条件要求时须明确保留未覆盖边界，不能补任意数字令测试通过。
