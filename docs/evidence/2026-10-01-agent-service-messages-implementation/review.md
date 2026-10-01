# Messages 后端独立审查

结论：**最终五文件未发现必须修复的问题，可进入根任务的安装验收。** 本审查只读生产差异、对应回归和真实探针收据；未运行测试套件、SDK、Agent 或正式应用，未读取用户配置或凭据。

## 最终身份

已逐文件计算实际 SHA-256，与 [source-final.json](source-final.json) 的 2026-10-01T02:14:56Z 五文件冻结一致，`sourceChanges=[]`。相对 [关闭 Messages 的前版](source-before-messages-enabled.json)，仅 `service_config.rs` 改变，最终 SHA 为 `0fecdf63b5d00f8e54d16cdf89f96cc06a06938158accebd5d634bcda31436cf`（575 行）。

- [service_config.rs](../../../src-tauri/src/acp_client/service_config.rs)：`api_types` 与 `validated_api_types` 只为目录/已发现的 OpenCode 增加 Messages；同名自定义接入、Codex、Pi、其他 Agent 不增加能力。临时 `compile_selected` 已移除，Messages 正例和拒绝例都经过实际公开 `compile`。
- [api_endpoint.rs](../../../src-tauri/src/api_endpoint.rs)：只有官方 HTTPS 默认端口根补 `/v1`；自定义地址、前缀和非默认端口不猜补。非 Messages 保留原尾斜杠处理。输入解析错误只返回固定文案。
- [api_test.rs](../../../src-tauri/src/api_test.rs)及[测试](../../../src-tauri/src/api_test/tests.rs)：中央模型列表/短测与 OpenCode 编译共用地址 helper；认证头、正文、超时、取消、重定向拒绝与大小限制保持原逻辑。
- [lib.rs](../../../src-tauri/src/lib.rs)：只注册共享 helper。

## 行为与回归核对

编译器对 Chat、Responses、Messages 都明确写出每个模型的实际 `id` 和模型级 `provider.npm/api`，不只写展示名称。Messages 对应 `@ai-sdk/anthropic`；没有凭空加入模型限额、Bearer token 或伪造 headers 清空语义。服务密钥继续只在独立环境值中，inline 使用引用；[调用链](../../../src-tauri/src/acp_client/service_connection.rs)仍由本次明确选择的 `ServiceSnapshot` 编译，不启用旧全局授权。

地址补全只改变请求配置，不改保存的 endpoint、来源 fingerprint、connection revision 或恢复选择。[凭据校验](../../../src-tauri/src/credentials.rs)继续要求公开保存为无用户名、查询和片段的 HTTPS 基础地址；helper 中的任务自有 HTTP 测试不构成新公开入口。

继承 inline 中同一 Farfold 提供方 ID 必须与本次完整定义一致，否则固定错误拒绝且原输入不变。测试包含地址、模型 ID、模型级实现/地址、提供方和模型 headers、authToken 冲突。其他提供方、权限及 enabled/disabled 限制原样保留；模型是否实际选中仍经过既有 `validate_model`，限制名单存在不被当作请求成功。

[最终定向收据](backend-final-checks.json)及其日志已核：公开编译 10、共享地址 2、中央 API 7、来源恢复 2 项通过，fmt/clippy 退出 0；OpenCode-only 准入[先红](messages-admission-red.json)保留。根任务另有[完整 Rust 检查](checks-rust-final.json)，本审查未重复执行。

## 真实探针对应范围

[实际运行](../2026-10-01-agent-service-messages/actual-opencode-messages-run-first.json)与[结果](../2026-10-01-agent-service-messages/actual-opencode-messages-result-first.json)退出 0：官方 OpenCode 1.18.31 对 A/B 两独立来源，在新建与冷加载后各明确请求一次，四次正例 HTTP 的路径、Key、实际 API 模型、正文及各自历史 receipt 均匹配。原选项保持，自动 HTTP 为零。

七项 inline 风险反例均完成并符合各自预期；其中六次 HTTP 包含故意错误实现路径的拒绝，非空 token 一例在 prompt 阶段拒绝且无 HTTP。总计 10 次 HTTP、9 个受跟踪进程，等待回收、所属进程组为空、监听关闭、任务目录清理均确认。**风险反例匹配不代表这些冲突配置可安全使用。**

这支持当前官方配置结构和 Messages 路线的开放，不等于生产 Rust IPC、Keychain 与正式安装界面的完整使用链已经验证。探针使用等价人工 inline，未做真实云服务请求，也未写磁盘配置模拟深合并。未读取的磁盘/组织后合配置及插件仍按[已有实施边界](../2026-10-01-agent-service-messages/implementation-boundaries.md)保留未核实状态；不能把 inline 冲突拒绝扩大成所有来源配置均已隔离。既有 Chat/Responses 的单元与历史真实证据继续各自成立，本次没有重新实际请求这两个格式。
