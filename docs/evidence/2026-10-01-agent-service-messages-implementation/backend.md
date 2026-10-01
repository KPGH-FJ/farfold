# Messages 后端最小片

本片实现共享地址规则与 OpenCode 配置翻译，**依据根任务的实际 OpenCode canary，仅为 OpenCode 开放 Messages**。后端作者未运行正式应用、真实 Agent、实际 SDK 请求、安装或全量 Rust 测试；根任务实际请求证据与后续安装验收分别保留。

## 源码范围

- [api_endpoint.rs](../../../src-tauri/src/api_endpoint.rs)：用现有 `reqwest::Url` 解析 Messages 基础地址。只有官方 HTTPS 默认端口根地址补 `/v1`，自定义 host、路径和非默认端口保持选定地址；仅移除末尾斜杠。解析失败及含账号、查询或片段的输入只返回固定错误。
- [api_test.rs](../../../src-tauri/src/api_test.rs) 与 [测试](../../../src-tauri/src/api_test/tests.rs)：中央模型列表与简短请求共用该地址规则。原 HTTP 错误、重定向禁跟随、正文上限、取消与 Keychain 等待所有权不变。
- [service_config.rs](../../../src-tauri/src/acp_client/service_config.rs)：OpenCode 模型 map 明确 `id`、模型级 `provider.npm` 与合法配置字段 `provider.api`，并使用同一基础地址。Messages 翻译为 `@ai-sdk/anthropic`；未添加推测的模型 limit、headers 清空或 authToken。秘密仍只在独立环境值中，inline 使用 `{env:…}`。
- [lib.rs](../../../src-tauri/src/lib.rs)：仅注册共享 helper。精确摘要及行数见 [source-final.json](source-final.json)。

`compile` 保留 capability 准入。OpenCode 的 `api_types` / `validated_api_types` 增加 Messages，Codex 仍仅 Responses，Pi、其他 Agent 和同名自定义接入仍不开放。临时 `compile_selected` 已移除；Messages 的正例、冲突和身份测试都走同一公开 `compile`。

基础地址补全不修改 `ServiceSnapshot.endpoint`、来源 identity、连接 revision 或凭据存储。公开保存仍经原 `credentials::validate_endpoint` 的 HTTPS 校验；helper 的 HTTP 合成输入测试不是新增公开 HTTP 入口。

## 红与绿

首版仍关闭 Messages，摘要和说明完整保留在 [source-before-messages-enabled.json](source-before-messages-enabled.json) 与 [backend-before-messages-enabled.md](backend-before-messages-enabled.md)。以下首轮结果不倒填为已开放后的验证。

[backend-red.json](backend-red.json) 保留修改前两项行为失败，各命令 exit 101：

1. [api-root-red.log](api-root-red.log)：官方裸根模型列表实际生成 `/models`，预期 `/v1/models`。
2. [opencode-route-red.log](opencode-route-red.log)：现有 Chat 模型缺实际 API `id`，断言 `null` 与所选模型不同。

[backend-focused-first.json](backend-focused-first.json) 中三个定向命令均 exit 0：

- [endpoint-green.log](endpoint-green.log)：2 项，官方根补全、自定义 host/前缀/非默认端口不猜补、固定安全错误。
- [api-green.log](api-green.log)：7 项，包括三种格式、官方 Messages `/models` 与 `/messages`、秘密回显过滤、真实任务自有本机 HTTP 的跳转与大小上限、取消等待所有权。
- [service-green.log](service-green.log)：10 项，包括原 Codex/OpenCode 翻译、两个现有 OpenCode 格式的模型级字段、内部 Messages 翻译/公开门控、来源身份不迁移、秘密独立环境值、同 ID 地址/实现/模型/token/认证头冲突拒绝、限制名单保持、实际模型准入。

[backend-related.json](backend-related.json) / [service-source-green.log](service-source-green.log)：既有来源恢复 2 项 exit 0，仍拒绝为恢复会话替换或猜测原服务。

[backend-static-first.json](backend-static-first.json)：[格式](backend-format.log) 与 [clippy](backend-clippy.log) 均 exit 0。本片未运行全量测试或任何真实 Agent。

根任务完成实际请求后，[准入红例](messages-admission-red.json) / [日志](messages-admission-red.log) 先验证新的 OpenCode-only 准入要求，原能力表不含 Messages，1 项实际失败 exit 101。随后仅开放 OpenCode 并移除临时编译入口，[最终定向与静态检查](backend-final-checks.json) 全部 exit 0：

- [公开配置编译](messages-admission-green.log) 10 项：OpenCode 已登记/已发现接入可编译 Messages；Codex、Pi、Claude、未知与同名自定义接入均拒绝，原身份/密钥独立交付/inline 冲突/限制名单/模型保护继续通过。
- [共享地址](endpoint-final-green.log) 2 项、[中央 API](api-final-green.log) 7 项、[原来源恢复](service-source-final-green.log) 2 项均通过。
- [最终格式](backend-format-final.log) 与 [最终 clippy](backend-clippy-final.log) 通过。没有扩大到完整 Rust 套件、真实云服务或安装版操作。

最终五文件摘要仍为 [source-final.json](source-final.json)；相对关闭版，仅 `service_config.rs` 改变，其余四文件逐字相同。

## 开放依据与范围

[实际 OpenCode 请求结果](../2026-10-01-agent-service-messages/actual-opencode-messages-result-first.json) / [退出收据](../2026-10-01-agent-service-messages/actual-opencode-messages-run-first.json) 为固定 OpenCode `1.18.31`、等价人工 inline 配置的实际官方进程验证，exit 0。两个独立来源在新建与冷载后各明确发送一次，实际地址/Key/API 模型与自己的历史匹配；没有自动请求或任意 model limit。正例和预期 inline 覆盖反例共 10 次实际本机 HTTP，9 个自有进程均确认回收，监听和任务目录关闭/清理。

`positivePassed`、`expectedInlineOutcomesMatched`、`passed` 均为 true；反例预期成立包含实际模型/认证头被覆盖、错误实现发错路径、非空 token 在请求前拒绝，不能把这些风险反例写成安全交付成功。该探针未经过生产 Rust IPC、真实 Keychain 或正式安装整链，未进行真实云服务请求，也未证明任意磁盘/管理策略/插件配置隔离。后续安装验收由根任务执行。

## 实际边界

同 ID 的 inline 提供方必须逐项完全相同；不同 `id/provider.npm/provider.api`、地址、token 或认证头都拒绝，原输入不变。`enabled_providers`、`disabled_providers`、其他提供方、权限和其他设置原样保留；保留限制不是所选模型实际可用的证明。

依据固定官方 [OpenCode 1.18.31](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/provider/provider.ts) 与 [Anthropic SDK 3.0.111](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.111/packages/anthropic/src/anthropic-provider.ts)，对更早合并层的合法标量显式覆盖有实际含义，但磁盘/组织策略的后合入、headers 深合并与插件钩子仍不能靠生成 JSON 或同名模型证明隔离。未读取这些用户配置，未宣称拒绝所有来源的冲突。继续遵守 [实施边界](../2026-10-01-agent-service-messages/implementation-boundaries.md) 和 [SDK 实际结果](../2026-10-01-agent-service-messages/sdk-canary-results.md)。

实际 canary 已支持本片 OpenCode Messages 开放决定。未知模型、后合入配置、真实云服务与未完成安装旅程继续保留未测边界，不能由这一固定样本扩大为任意配置完整支持。
