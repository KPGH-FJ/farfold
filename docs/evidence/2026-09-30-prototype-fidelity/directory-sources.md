# 目录展示资料来源

核对日期：2026-09-30。范围：认可原型中的 10 个 Agent，以及当前真实目录中的 Amp。

资料位于 `src-tauri/src/acp_client/directory_presentation.rs`，由正式 registry ID 精确匹配，并通过可选的 `presentation` 字段输出。前端读取通用 `{publisher, description, categories, sourceUrl}`，不按品牌猜测能力。未知、自定义和名称相同但 ID 不同的条目没有分类。

用途标签是依据公开定位整理的**目录分类**，不是该安装已通过能力验收。它们不改变安装、连接、认证、模型选择、权限或真实请求的状态，也不证明 Farfold 已开放官网列举的功能。本轮没有升级或迁移任何外部程序，没有改启动参数、版本、账号、配置或历史。

分类口径：编程 = 官方明确面向代码开发；自动化 = 官方说明脚本、命令任务或工作流程；研究 = 官方明确研究用途，或提供搜索及资料查找功能；轻量 = 官方明确精简核心的产品定位，不代表本机资源、延迟或费用测量。分类是本项目对公开资料的归纳，不是官方颁发的标签，且不是穷尽用途。

## 条目与依据

| 展示条目 / registry ID      | 发布者或维护项目            | 中文简介                                                           | 分类与公开依据                                                                                                                                                                                     | 官方来源                                                                                                                                              |
| --------------------------- | --------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex / `codex-acp`         | OpenAI                      | 在本机处理代码与项目任务，也可用于脚本和工作流程自动化。           | 编程：项目介绍为本机 coding agent。自动化：官方非交互模式文档介绍脚本运行。                                                                                                                        | [项目](https://github.com/openai/codex)、[非交互模式](https://developers.openai.com/codex/noninteractive/)                                            |
| OpenCode / `opencode`       | Anomaly                     | 开源编程 Agent，可连接多种模型服务，完成代码理解、修改与脚本任务。 | 编程：官网 Intro 的产品定位。自动化：CLI `run` 章节明确 scripting、automation。发布者对应官网链接的 `anomalyco/opencode` 项目。                                                                    | [介绍](https://opencode.ai/docs/)、[CLI](https://opencode.ai/docs/cli/)                                                                               |
| Pi / `pi-acp`               | Earendil Inc.               | 以精简核心处理编程任务，通过扩展、技能和模板调整工作方式。         | 编程：官方代码产品与 coding-agent 项目。轻量：官网明确 minimal 核心、少量预置机制及可扩展定位。当前官网署名 Earendil Inc.，不沿用原型发布者。                                                      | [官网](https://pi.dev/)、[项目](https://github.com/earendil-works/pi-mono)                                                                            |
| Cline / `cline`             | Cline Bot Inc.              | 编写与修改代码、运行命令，也可通过脚本组织自动化任务。             | 编程：官方 CLI 定位。自动化：Headless Mode 明确脚本、管道及持续集成用途。公司名称来自当前官方目录作者字段。                                                                                        | [CLI 文档](https://github.com/cline/cline/blob/main/apps/cli/README.md)、[目录](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) |
| Qwen Code / `qwen-code`     | Qwen                        | 开源编程 Agent，支持多种模型服务，可用于代码任务、脚本和批量工作。 | 编程：官方 coding agent 定位。自动化：README 明确 Headless 脚本、持续集成和批量任务。未找到足以保留原型“轻量”的当前依据，因此不贴该标签。                                                          | [官方项目](https://github.com/QwenLM/qwen-code)                                                                                                       |
| Claude Agent / `claude-acp` | Anthropic · Zed · JetBrains | 通过公开接入项目使用 Claude Agent，处理文件修改、工具与命令任务。  | 编程／自动化：公开接入项目列出文件修改、工具调用、交互和后台命令；此处是用途归纳，不表示当前安装已验证这些接口。维护方采用当前目录列出的三方 authors，不把接入项目声称为单一厂商所有。             | [接入项目](https://github.com/agentclientprotocol/claude-agent-acp)、[目录](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)     |
| Gemini CLI / `gemini`       | Google                      | 结合代码理解、命令操作与网页搜索，处理开发、资料查找和自动化任务。 | 编程：Code Understanding & Generation。自动化：Automation & Integration。研究：官方 Google Search grounding 和网页抓取功能，归纳为资料查找用途。                                                   | [官方项目](https://github.com/google-gemini/gemini-cli)                                                                                               |
| goose / `goose`             | Agentic AI Foundation       | 在本机完成编程、研究、写作与数据分析，并通过扩展连接工作工具。     | 编程／自动化／研究：当前官方项目明确 code、research、writing、automation、data analysis。现属于 Linux Foundation 下的 AAIF，不照抄目录缓存中的 Block 署名。                                        | [当前官网](https://goose-docs.ai/)、[当前项目](https://github.com/aaif-goose/goose)                                                                   |
| Kimi CLI / `kimi`           | Moonshot AI                 | 用于编程与命令任务；目录链接的旧项目已归档，官方提供迁移说明。     | 编程／自动化：目录所链项目保留的旧 README 明确软件开发、命令操作与自动规划。当前仓库已声明归档并指向 Kimi Code CLI；展示资料记录这个事实，但不会用新项目能力替旧安装作保证，也不执行迁移。         | [目录所链项目及归档声明](https://github.com/MoonshotAI/kimi-cli)、[文档入口](https://moonshotai.github.io/kimi-cli/)                                  |
| fast-agent / `fast-agent`   | fast-agent / evalstate      | 以可扩展 Agent 组织编程、脚本和多步骤工作，支持多种模型服务。      | 编程：官网 Code 和 coding guides。自动化：scriptable、batch processing 和 workflows。官网链接 `evalstate/fast-agent`；不虚构公司归属。未找到足以照抄原型“研究／轻量”的直接定位，保留有证据的标签。 | [官方文档](https://fast-agent.ai/)、[项目](https://github.com/evalstate/fast-agent)                                                                   |
| Amp / `amp-acp`             | Amp                         | 面向代码与项目工作的 Agent，可在命令行中使用，也可接入脚本流程。   | 编程：官网 coding agent 定位。自动化：文档说明 CLI 可以在 scripts 中运行。当前 About 将团队介绍为独立研究实验室；这里用当前品牌署名 Amp，不从旧资料推断仍归 Sourcegraph。                          | [文档](https://ampcode.com/docs)、[当前团队](https://ampcode.com/about)                                                                               |

## 当前来源差异

- [官方目录](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) 的实际 ID 是 `claude-acp`、`gemini`、`kimi`、`amp-acp`，不能直接拿原型的显示 ID 当真实条目。内置 Codex / Pi 则通过既有 registry ID `codex-acp` / `pi-acp` 匹配，不改已有会话的 Agent ID。
- 旧 goose 地址 `https://block.github.io/goose/` 本次返回跳转页面，目标为 `https://goose-docs.ai`；当前 GitHub README 同时指向该站并说明 AAIF 归属。目录原始安装 URL 保留原值，展示来源使用当前官网。
- `MoonshotAI/kimi-cli` 当前首页明确旧 Python 项目已归档，指向 `MoonshotAI/kimi-code`；不能把新项目的品牌更新当作本机已经迁移。此片只补展示资料，后续是否处理目录旧包需另按真实安装证据判断。
- 原型所有模拟安装、登录方式、模型、权限及版本字段都未迁入这份展示资料。
