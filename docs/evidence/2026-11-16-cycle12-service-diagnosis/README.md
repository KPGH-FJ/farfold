# 第 12 周期服务故障续验

2026-11-16，macOS。按用户决定将 DimCode 从首发、新接入和整家验收移出。现有 25 家、200 个验收项。其程序、登记、设置与已有证据保留。MiniMax 用户核额度，Gemini CLI 与 Antigravity 暂缓。[范围](../../agent-first-release.md) · [当前验收表](../2026-11-15-cycle12-continuation/acceptance-roster.json)

正式版探索目录显示 25 家，保留 Qoder CLI。新对话选择器搜索 DimCode 返回零结果，旧登记字段与安装快照逐项一致。前端 10,948 项、Rust 发布版 2,800 项通过，Rust 11 项忽略。格式、类型、生产打包、Clippy 与文档检查通过。2,633 项产品输入摘要一致，236,586 项安装保护数据摘要一致，独立元数据副本完整，重复候选已移除。[回执](results.json)

## Factory Droid

正式登记 0.230.0 的同一官方程序执行 `doctor --auth --json --timeout 6000`，四项认证检查通过，现有登录有效，零模型请求。临时目录内仅使用诊断。Farfold 正常设置沿原 GPT-6 Sol / High 发一次短消息，3.643 秒后显示 `401`。同一官方 CLI 以同一账号、模型和推理档在空临时目录发一次对照，13.076 秒以退码 1 及同样的 `401` 结束，零重试，账号和设置元数据保持。

同一 Farfold 会话中的后台标题请求及连接器校验明确返回账号未关联组织。两次 GPT-6 Sol 主请求的 `401` 均没有响应正文，官方日志将其分类为认证错误。先请用户在 Factory 官方页面核对当前账号是否已加入有权使用 Droid 的组织。出现新条件后复验一次。[Factory 组织与权限](https://docs.factory.com/enterprise/identity-and-access)

## Kimchi

两个精确 Farfold 原会话匹配 Kimchi 1.3.0 的请求诊断和本机响应记录。使用已保存的 `kimchi-dev/nemotron-3-ultra-fp4`，HTTP 200 后模型流返回该提供方额度用尽。厂商价目把此模型列为 Cast AI 托管。两条记录均无助手用量，错误与官方文档中用户 API 预算耗尽的 `429` 形态不同。原桌面目录的历史读取超时单独归因，macOS 当时发起桌面访问提示且未收到答复。[Kimchi 模型价目](https://docs.kimchi.dev/docs/model-apis-pricing) · [官方预算响应](https://docs.kimchi.dev/docs/model-apis-rate-limits)

本轮让 Farfold 对精确登记 Kimchi 同一请求的已匹配官方错误显示「当前模型的提供方额度已用尽」。拒绝近似文字、其他来源、未知传输结果及带额外诊断的载荷。模型选择、请求归属与发送保护保持。修正的是提示，托管额度等待厂商恢复或用户另选可用模型。[官方适配器](https://github.com/getkimchi/kimchi/blob/v1.3.0/src/modes/acp/server.ts#L2345-L2353) · [官方 SDK 发布包](https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-0.19.2.tgz)

再次安装后只发送一次同原设置、同模型的正式短测。经 2.284 秒收到终态错误，无助手输出。设置测试及打开后的普通对话均显示已用尽的具体原因。比对保存的 Kimchi 和 Factory 设置一致。[正式回执](results.json)

## Poolside

官方 1.0.16 同安装用 `pool acp logs --session` 只读核正第 12 周期失败的原会话。已保存服务指向 Poolside 托管地址 `inference.poolside.ai`，模型 `poolside/laguna-s-2.1`、Max。Farfold 的一次发送在厂商产生三次内部尝试，终态为 HTTP 400，所用版本已停用。原生轨迹有失败和退出，无助手或工具执行结果。本轮零重发。

Poolside 平台公告说明托管推理于 10 月 31 日停用。官方 CLI 保留可配置的 OpenAI 兼容地址。本次对照的 OpenRouter 和 Vercel 公开 API 目录均未提供该模型入口，Vercel 介绍页仍有同名条目。需要可验证的替代服务及用户选择后才能验这一家。现有回执没有把厂商详情交给 Farfold，没有足够证据添加针对 Poolside 的错误映射。[Poolside 平台](https://platform.poolside.ai/) · [官方兼容端点](https://github.com/poolsideai/pool/blob/main/README.md#openai-compatible-api)

## MiniMax 外部 API

本机 MiniMax Code 0.2.7 同版 README 及实际安装包都提供 `/model` → `Add 3rd-party provider…` → `Custom Provider`。可配服务的 Base URL、模型 ID、Key，选项包括 OpenAI Compatible（Chat Completions）、OpenAI Responses 和 Anthropic Messages。走厂商终端完成并按提示测试，Farfold 用「沿用已有设置」读取。Farfold 当前集中设置暂未交付 MiniMax 的 API 注入。本次未配置外部 Key 或用外部服务发送，第三方实答待验证。[MiniMax 官方说明](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/examples.md#2-choose-your-own-model)
