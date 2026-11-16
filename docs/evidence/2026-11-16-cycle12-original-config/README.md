# 第 12 周期旧对话原设置恢复

## 执行范围

从 Farfold 对话库打开已读到原文的同一条旧对话，使用「恢复原对话设置」。可以查看 Agent 当前报告的模型与思考选项，或从选定的 Farfold 备份读取此对话的原设置。用户核对已有账号、服务及显示的选项后才保存。当前报告只说明连接读到了什么。原设置的证据来自同一条备份记录或用户对原设置的确认。保存仅补空记录，准备阶段零模型设置请求、零消息发送，已有待发内容保持暂停。[读取协议](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session)

备份读取使用私有快照，按 Agent、原工作目录、原标识匹配唯一记录并核对全套选项。恢复只写当前 Farfold 的对应记录。独立 SQLite 对照复现了 macOS 临时目录 `/var` 符号链接导致的 CANTOPEN，修复只规范化 Farfold 自己创建的私有快照目录。

## Pi 从正常入口实际续答

macOS 对更新后的签名再次要求桌面文件夹访问，首次等待超时。用户授权后，旧读取收到迟到回执，从 Farfold 正常保存退出后冷开同一个原对话。选择旧 Farfold 备份，核对 OpenRouter 的 Nemotron 3 Ultra 免费版及 Medium，确认保存后读到唯一原索引记录，零发送、零模型修改。备份摘要前后相同。

从原对话发送一次缺少答案的续问，请 Pi 复述第一条用户消息里的验收记号。原会话新增的官方助手记录显示 OpenRouter 原模型正常结束，答案准确。正式界面显示「已完成」，本轮没有工具更新或新对话。清空运行连接后再次冷开，同一原文与新回复可读，来源、模型及 Medium 保持，冷开零发送。[回执](results.json)

## MiniMax 原账号核对

原对话的模型为 MiniMax-M2.7。十月七日的原请求在厂商记录中以 `50110` 结束，安装程序将它定义为余额不足，原记录无账号或计费来源。可读记录中没有可用于核对当时账号的用量。用户现在表示可能没有登录过 MiniMax，先前同一账号的口头确认不再作为现行依据。新版从正常对话库冷开，预览显示 M2.7，并标明选项来自 Agent 当前报告。确认框保留未勾选，保存禁用，原配置仍空，零发送。[回执](results.json)

## Claude 环境核对

官方适配器 0.107.0 把自带 API 的认证头放入 SDK 设置，SDK 0.3.323 会将设置序列化至 Claude 子进程参数。Farfold 在建立托管 Claude 连接前暂时拦下这条路径，保留保存的 API 配置及 Claude 的「沿用已有设置」入口。已核对厂商代码路径，未读取真实进程参数或确认实际密钥被其他程序读取。独立 API 测试之前的成功仅证明服务可响应。[适配器配置](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.0/src/providers.ts#L146-L186) · [适配器设置交付](https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.107.0/src/v1/acp-agent.ts#L9925-L9948) · [SDK 发布包](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.323.tgz)

正式版设置中，原 Xiaomi Messages 服务仍显示已保存，适用列表现在只有 OpenCode。验证未编辑或测试服务。[回执](results.json)

## 工程与安装

前端格式、类型、生产构建和 10,947 个测试通过。Rust 格式和发布 Clippy 通过，发布测试 2,799 过、11 忽略。候选 2,633 个输入摘要一致，唯一正式版 0.1.7 更新后对三处数据目录的 236,586 项摘要一致，独立元数据副本完整，重复候选已移除。[回执](results.json)
