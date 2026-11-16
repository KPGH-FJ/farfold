# 第 12 周期首发范围调整与 Kimchi 服务核对

2026-11-16，macOS arm64。按用户决定将 Poolside 与 Factory Droid 移出首发、新接入和第 12 周期整家验收。当前 23 家各按八项验收，共 184 格，其余 23 家原有证据保留，Kimchi 模型项补录已知的服务失败原因。仍未有一家八项全通过。两家先前的服务故障与验收记录可追溯。[当前范围](../../agent-first-release.md) · [逐家验收表](../2026-11-15-cycle12-continuation/acceptance-roster.json) · [原服务实测](../2026-11-16-cycle12-service-diagnosis/README.md)

## 正式版复验

从 `/Applications/Farfold.app` 正常打开「探索 Agent」，实际显示 23 家，Kimchi、Qoder CLI 仍在目录中。切到新对话的「选择 Agent」搜索 Poolside 与 Factory Droid，两次均显示「没有符合条件的 Agent」。两家各一条登记及一条历史索引与安装保护快照逐字段核同。安装前后 236,586 项保护文件清单摘要相同，重复应用候选已移除。[回执](results.json)

生产构建固定 2,633 项输入。正式版复验后，定向检查定位到一条「当前目录成员仅有其他平台安装包」旧测试仍以 Poolside 为样本。改用在册的 Qoder 模拟记录，保留同一失败区分的断言。独立逐项核对构建输入，唯一差异位于这两处测试字符串。[回执](results.json)

## Kimchi

官方免费 Community 版支持自带推理服务。官方公开价目未列长期免费的托管模型，当前所选 `kimchi-dev/nemotron-3-ultra-fp4` 按量计费。官方支持用 Ollama 在本机运行模型，无云 API 用量。[计划与定价](https://kimchi.dev/pricing) · [托管模型价目](https://docs.kimchi.dev/docs/model-apis-pricing) · [本地模型说明](https://docs.kimchi.dev/docs/coding-ollama)

Kimchi 控制台的 **Models → External Providers** 接收 OpenAI、Anthropic、Google Gemini、Groq 等官方列出的提供方。给需要的模型勾选 **Include in CLI**。同本机登记版本 1.3.0 的源代码及测试也覆盖保留自定义 OpenAI 兼容地址和模型，以及从可用模型表生成 ACP 选项。项目当前未提供 Kimchi 的 Farfold API 配置直连。小米 MiMo 通过 Kimchi 自定义配置的发送、以及相同配置从 Farfold 新对话实答，均待实测。本批未写入模型配置或发出模型请求。[第三方提供方](https://docs.kimchi.dev/docs/supported-providers) · [1.3.0 自定义提供方测试](https://github.com/getkimchi/kimchi/blob/v1.3.0/src/models.test.ts#L382-L402) · [1.3.0 ACP 模型列表](https://github.com/getkimchi/kimchi/blob/v1.3.0/src/modes/acp/server.ts#L2257-L2267) · [Farfold API 配置入口](../../../src-tauri/src/acp_client/service_config.rs)
