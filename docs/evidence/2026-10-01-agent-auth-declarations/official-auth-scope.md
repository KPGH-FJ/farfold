# 官方认证范围补充核对

2026-10-01 02:31，联网读取官方协议仓库当前文档。以下是官方文档事实与本片实现判断，不是新的登录或请求实测。

[Terminal Authentication RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/auth-methods.mdx)的变更记录说明：2026-07-27 移除了实验性的 `env_var`，Rust SDK 对旧声明归入 Agent 是有意的兼容策略；2026-08-20 将 Terminal 认证完成并稳定。因此不能把 schema 1.9.1 没有 EnvVar 解释成遗漏升级，也不能把恢复该旧类型当成当前标准协议功能。

[v1 认证文档](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/draft/authentication.mdx)规定 Terminal 在相同程序与基础启动参数后追加方法参数，并合并环境，再重新连接；方法不能指定另一个程序。DimCode 两个 `acp` 的实测参数符合追加规则，是否完成账号配置仍未验证。

本片处理的是 Farfold 遇到旧声明的可操作性：已装 DeepAgents 0.1.7 仍返回 `env_var`，其空 authenticate 又不能完成名为 Key 设置的动作。保留受限公开身份/变量名并给出不可直接配置的说明，可以避免误导入口；不把空方法返回判为已获得凭据，也不自动注入现有 Key。

后续完整账号路线须依据当前官方 Agent/Terminal/结构化交互或已核实服务配置实现，继续遵守用户选定来源才交付凭据。是否为具体官方旧发行提供受限服务配置兼容，需要单独来源和真实验证；没有自动新增全局 env 授权、修改外部包或替用户写配置的授权。DeepAgents 此前实际请求的失败原因仍未知。
