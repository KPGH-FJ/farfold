# Agent 品牌与中文简介核对

日期：2026-10-03（Asia/Shanghai）。范围仅为当前保留的 33 个精确目录 ID；不改变接入能力、认证、模型或程序行为。

## 交付与来源

- 33 项均有一句中文简介（最长 34 字，品牌专名保留），来源为下表产品官网、官方文档或官方项目介绍。文案只概括产品定位，不代表 Farfold 已验证相应能力。
- Logo 作为本地 SVG 随应用提供，不依赖打开页面时下载。除 Nova 来自产品官方代码库，其余采用 [ACP 官方目录](https://github.com/agentclientprotocol/registry)为对应精确 ID 发布的原始图标；不使用图标聚合服务，不生成或猜造标记。
- 部分目录图标本身采用字母或符号（如 Kimchi、MiniMax、Qoder、Dirac）；保留目录发布的图形，不冒称已取得其他品牌版本。Dirac 的 SVG 使用字体绘制 δ，因此具体字形随系统字体。
- Nova 保留官方彩色 SVG；其他目录 SVG 是官方发布的单色版本，深色主题复用既有反色样式。每个文件来源及 Git blob 在 asset-sources.json，落盘摘要见 asset-integrity.json。
- 身份解析仅接受精确目录 ID、registry: 前缀及已有 Codex/Pi 内部 ID，显式自定义条目继续使用通用身份；不从名称、命令推断品牌或能力。

## 33 项中文介绍与官方依据

| 精确目录 ID          | 中文简介                                                   | 介绍依据                                                                                     | 图标依据                                                                                          |
| -------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `amp-acp`            | 支持多种模型的编程助手，可处理开发任务与自动化工作。       | [官方资料](https://ampcode.com/docs)                                                         | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/amp-acp/icon.svg)            |
| `antigravity-acp`    | Google 的编程助手，可理解代码、修改项目并执行开发任务。    | [官方资料](https://antigravity.google/)                                                      | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/icon.svg)    |
| `auggie`             | 结合项目上下文分析代码、实现功能和修复问题。               | [官方资料](https://docs.augmentcode.com/cli/overview)                                        | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/auggie/icon.svg)             |
| `autohand`           | 协助规划、修改和测试代码，支持多种模型服务。               | [官方资料](https://github.com/autohandai/code-cli)                                           | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/autohand/icon.svg)           |
| `claude-acp`         | Anthropic 的编程助手，可修改文件、运行命令并处理开发任务。 | [官方资料](https://github.com/agentclientprotocol/claude-agent-acp)                          | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/claude-acp/icon.svg)         |
| `cline`              | 开源编程助手，可修改文件、运行命令并自动化开发任务。       | [官方资料](https://cline.bot/cli)                                                            | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/cline/icon.svg)              |
| `codebuddy-code`     | 腾讯的编程助手，可通过自然语言编写、测试和修改代码。       | [官方资料](https://www.codebuddy.ai/docs/cli/overview)                                       | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/codebuddy-code/icon.svg)     |
| `codex-acp`          | OpenAI 的编程助手，可阅读、修改和运行本地代码。            | [官方资料](https://github.com/openai/codex)                                                  | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/codex-acp/icon.svg)          |
| `corust-agent`       | 专注 Rust 开发，协助编写代码、重构项目和探索依赖。         | [官方资料](https://corust.ai/)                                                               | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/corust-agent/icon.svg)       |
| `cursor`             | 协助编写、审查和修改代码，也可用于开发自动化。             | [官方资料](https://cursor.com/docs/cli/overview)                                             | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/cursor/icon.svg)             |
| `devin`              | 协助实现功能、修复问题和审查代码，支持本地与云端工作。     | [官方资料](https://docs.devin.ai/cli)                                                        | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/devin/icon.svg)              |
| `dimcode`            | 通过对话理解本地项目，协助处理代码任务与工作流程。         | [官方资料](https://github.com/arcships/dimcode)                                              | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/dimcode/icon.svg)            |
| `dirac`              | 面向复杂项目的开源编程助手，支持代码修改与并行任务。       | [官方资料](https://dirac.run/)                                                               | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/dirac/icon.svg)              |
| `factory-droid`      | Factory 的编程助手，可处理功能开发、代码重构与问题调查。   | [官方资料](https://factory.com/product/cli)                                                  | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/factory-droid/icon.svg)      |
| `fast-agent`         | 支持多种云端及本地模型，用于编程和自动化工作。             | [官方资料](https://fast-agent.ai/)                                                           | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/fast-agent/icon.svg)         |
| `gemini`             | Google 的开源编程助手，可处理代码、执行命令与搜索网页。    | [官方资料](https://github.com/google-gemini/gemini-cli)                                      | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/gemini/icon.svg)             |
| `github-copilot-cli` | GitHub 的编程助手，可编写、调试代码并处理仓库协作任务。    | [官方资料](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli) | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/github-copilot-cli/icon.svg) |
| `goose`              | 在本机处理编程、研究、写作与数据分析的开源助手。           | [官方资料](https://goose-docs.ai/)                                                           | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/goose/icon.svg)              |
| `grok-build`         | xAI 的编程助手，可规划并执行开发任务。                     | [官方资料](https://x.ai/build)                                                               | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/grok-build/icon.svg)         |
| `junie`              | JetBrains 的编程助手，支持规划、代码修改与测试。           | [官方资料](https://junie.jetbrains.com/)                                                     | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/junie/icon.svg)              |
| `kilo`               | 支持多种模型的开源编程助手，可规划、编写和调试代码。       | [官方资料](https://kilo.ai/)                                                                 | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/kilo/icon.svg)               |
| `kimchi`             | 通过多个模型分工，完成代码规划、实现与审查。               | [官方资料](https://kimchi.dev/)                                                              | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/kimchi/icon.svg)             |
| `kimi`               | 月之暗面的编程助手，可阅读和修改代码、执行命令。           | [官方资料](https://github.com/MoonshotAI/kimi-cli)                                           | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/kimi/icon.svg)               |
| `minimax-code`       | MiniMax 的编程助手，协助规划和完成开发任务。               | [官方资料](https://www.minimax.io/)                                                          | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/minimax-code/icon.svg)       |
| `mistral-vibe`       | Mistral 的开源编程助手，可处理代码修改与开发任务。         | [官方资料](https://github.com/mistralai/mistral-vibe)                                        | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/mistral-vibe/icon.svg)       |
| `nova`               | 结合项目上下文提供代码建议，协助逐步完成开发任务。         | [官方资料](https://www.compassap.ai/nova/)                                                   | [原始 SVG](https://github.com/Compass-Agentic-Platform/nova/blob/main/assets/nova.svg)            |
| `opencode`           | 支持多种模型的开源编程助手，可理解项目、修改和调试代码。   | [官方资料](https://opencode.ai/)                                                             | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/opencode/icon.svg)           |
| `pi-acp`             | 轻量、可扩展的编程助手，可按自己的工作方式添加功能。       | [官方资料](https://pi.dev/press-kit)                                                         | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/pi-acp/icon.svg)             |
| `poolside`           | Poolside 的编程助手，可在本地项目中处理开发任务。          | [官方资料](https://github.com/poolsideai/pool)                                               | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/poolside/icon.svg)           |
| `qoder`              | 通过自然语言理解项目、编写代码并执行开发任务。             | [官方资料](https://docs.qoder.com/cli/overview)                                              | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/qoder/icon.svg)              |
| `qwen-code`          | 通义千问的开源编程助手，支持多种模型与开发工具。           | [官方资料](https://github.com/QwenLM/qwen-code)                                              | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/qwen-code/icon.svg)          |
| `sigit`              | 优先在本机运行的编程助手，可选择本地或云端模型。           | [官方资料](https://github.com/getsigit/sigit)                                                | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/sigit/icon.svg)              |
| `stakpak`            | 开源运维助手，协助部署应用、管理基础设施与排查故障。       | [官方资料](https://stakpak.dev/)                                                             | [原始 SVG](https://github.com/agentclientprotocol/registry/blob/main/stakpak/icon.svg)            |

## 补充核对

- Autohand 的 4×2 圆环与圆点标记与[官方文档图标](https://docs.autohand.ai/favicon.svg)一致；没有采用旧组件项目的单圆环图。
- Corust 官方项目已重定向至 rustingai/corust-agent-release，[品牌图](https://github.com/rustingai/corust-agent-release/blob/main/icon/corust-agent.svg)是定制 R 与括号；当前目录图形不是 Farfold 字母回退。
- Amp、Google Antigravity、Cursor、Pi 均有官方品牌页：[Amp](https://ampcode.com/press-kit)、[Antigravity](https://antigravity.google/press)、[Cursor](https://cursor.com/brand)、[Pi](https://pi.dev/press-kit)。本片使用目录提供的紧凑图标，不承诺已下载上述页面的所有素材。
- CodeBuddy、Corust 简介核对包括官方页面的搜索快照；本轮直接网页抓取失败。Kimi 官方 kimi-cli 项目已归档并指向后继项目；这里只记录当前保留身份的产品简介，不改名、升级或迁移其接入。
- 检查未启动任何 Agent、应用、终端或认证；Devin 仅读取公开品牌介绍与目录 SVG，未访问暂停的本机接入路径。

## 检查

- 范围验证：33 项均有中文简介及有效本地 SVG；32 份与来源 Git blob 字节完全相同。Nova 原文件使用 Latin-1，转换为有效 UTF-8（仅注释中三个角度符号的字节编码变化，图形与颜色不变），转换前字节摘要与来源一致。
- 品牌、目录、卡片、列表及集中字符串的 6 文件 56 项受控测试通过；不代表真实 Agent 接入验收。
- 范围格式及 diff 检查通过。全项类型检查由父任务在并行源码合并后执行。
- 未运行真实 Agent、未安装应用、未提交或推送。
