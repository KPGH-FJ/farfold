# 33 项品牌原色与特色简介收据

日期：2026-10-03。仅展示资料更新；目录 ID、程序、账号、服务和实际能力均未改变。没有启动 Farfold 或 Agent，没有读取用户配置、凭据或终端。Devin 仅研究公开产品介绍。

## 当前结果

33 个精确目录 ID 均有简短中文简介与本地官方素材。简介每条 21–35 字，侧重各自特点；它们说明官方产品定位，不表示这些功能已在 Farfold 中逐项验收。共 20 个官方彩色标、1 个官方奶白底深色标（Cursor）、12 个官方黑白标。彩色标与 Cursor 不套用深色模式反色；其余沿用共用黑白标处理。

[asset-sources.json](asset-sources.json) 逐项记录简介的一手来源、图片原始地址、确认来源的页面、文件字节数与 SHA-256。SVG 均解析成功，PNG/JPEG 均完整解码成功；所有本次复制的素材与下载文件逐字节一致。没有重绘、染色、裁切或缩放素材。

此前 [第一轮品牌收据](../2026-10-03-agent-branding/README.md) 是替换前快照；当前素材与简介以本目录为准。

## Claude Agent 名称与标志

保留 **Claude Agent**。当前 `claude-acp` 来自 [claude-agent-acp 官方仓库](https://github.com/agentclientprotocol/claude-agent-acp)，接入 Claude Agent SDK；不等同于另一个 Claude Code CLI 接入。Anthropic 的 [SDK 命名规范](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) 明确建议在下拉项使用 “Claude Agent”，允许在 Agent 菜单使用 “Claude”，并禁止把 SDK 集成称为 “Claude Code” 或 “Claude Code Agent”。

采用 [Claude 官网](https://claude.com/) 发布的通用橙色 Claude 标志，不使用 Claude Code 扩展专属图标。核实可取得的原始官网图片为 **32×32 PNG**，本次保留原图；这项分辨率限制仍在，未伪称已找到高清矢量图。

## 素材选择说明

- GitHub 已弃用旧独立 Copilot 机器人标。[现行 Copilot 规范](https://brand.github.com/brand-identity/copilot) 与 [GitHub 标志规范](https://brand.github.com/foundations/logo) 支持在品牌名称清晰的集成条目中使用官方 GitHub 独立章。本次使用官方 ZIP 中的 Invertocat，旁边仍完整显示 GitHub Copilot；没有裁切横向产品字标。
- Dim Code 的当前官方站点显示 DimAgent，并链接原 `arcships/dimcode` 仓库。本次采用该站的绿色图标，保留目录 ID 和已有程序名称，不推断已安装版本改名。
- Kimchi 改用官网橙色辣椒标；Qoder 改用官方组织仓库的产品图形；Pi 使用官方 press kit 的三色图形。
- Mistral 使用产品页内完整官方彩色 SVG；MiniMax 使用其官方 GitHub 组织实际发布的渐变品牌图，实际格式为 JPEG，扩展名与格式保持一致。
- Auggie、Autohand、Codex、Factory Droid、Goose、OpenCode 保留此前已核实的官方目录矢量图。其品牌本来采用黑白。Nova 保留官方紫色图形，前轮仅规范化注释编码的记录仍有效。

## 全部 33 项简介与来源

| 目录 ID              | 中文简介                                                       | 颜色           | 官方介绍                                                                                 |
| -------------------- | -------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `amp-acp`            | 按任务搭配模型，并在本地与云端之间接续工作。                   | 官方彩色       | [来源](https://ampcode.com/docs)                                                         |
| `antigravity-acp`    | Google 的智能开发平台，结合代码编辑、终端操作和浏览器验证。    | 官方彩色       | [来源](https://antigravity.google/)                                                      |
| `auggie`             | 借助代码库上下文，理解跨文件关系并贴合现有工程修改。           | 官方黑白       | [来源](https://docs.augmentcode.com/cli/overview)                                        |
| `autohand`           | 通过记忆与技能积累项目经验，并按需要选择模型服务。             | 官方黑白       | [来源](https://github.com/autohandai/code-cli)                                           |
| `claude-acp`         | 让 Claude 规划多步骤任务，调用工具并分派子任务。               | 官方彩色       | [来源](https://platform.claude.com/docs/en/agent-sdk/overview)                           |
| `cline`              | 先规划再执行，可逐步审批文件修改与命令操作。                   | 官方黑白       | [来源](https://github.com/cline/cline)                                                   |
| `codebuddy-code`     | 腾讯的编程工具，以自然语言串联需求、编码、测试与部署。         | 官方彩色       | [来源](https://www.codebuddy.ai/docs/cli/overview)                                       |
| `codex-acp`          | OpenAI 的本地编程工具，支持交互协作与脚本化执行。              | 官方黑白       | [来源](https://github.com/openai/codex)                                                  |
| `corust-agent`       | 专注 Rust 开发，理解所有权、生命周期和 Cargo 生态。            | 官方黑白       | [来源](https://corust.ai/)                                                               |
| `cursor`             | 将 Cursor 的代码审查与编辑能力带到终端和自动化脚本。           | 官方奶白／深色 | [来源](https://cursor.com/docs/cli/overview)                                             |
| `devin`              | 衔接本地开发与云端任务，可从终端发起并跟进云端工作。           | 官方黑白       | [来源](https://docs.devin.ai/cli)                                                        |
| `dimcode`            | 通过对话理解本地项目，并按项目组织代码任务与多条对话。         | 官方彩色       | [来源](https://dimagent.com/en/docs/)                                                    |
| `dirac`              | 精确定位并并行修改代码，适合复杂项目与长时间开发任务。         | 官方彩色       | [来源](https://dirac.run/)                                                               |
| `factory-droid`      | 把完整工单、重构和问题排查交给 Droid，并在多种工具间接续工作。 | 官方黑白       | [来源](https://factory.com/product/cli)                                                  |
| `fast-agent`         | 用 Python 扩展工具与工作流程，组合云端或本地模型完成任务。     | 官方彩色       | [来源](https://fast-agent.ai/)                                                           |
| `gemini`             | 结合 Google 搜索与文件、命令工具，处理代码和资料查找任务。     | 官方彩色       | [来源](https://github.com/google-gemini/gemini-cli)                                      |
| `github-copilot-cli` | 在终端修改代码、处理 GitHub 议题与拉取请求，连接日常仓库协作。 | 官方黑白       | [来源](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli) |
| `goose`              | 通过扩展连接工作工具，在本机处理编程、研究、写作与数据分析。   | 官方黑白       | [来源](https://goose-docs.ai/)                                                           |
| `grok-build`         | 先规划再执行复杂代码任务，并让多个助手并行研究、实现和审查。   | 官方黑白       | [来源](https://x.ai/build)                                                               |
| `junie`              | 结合 JetBrains 代码理解能力，规划改动、完成实现并补充测试。    | 官方彩色       | [来源](https://junie.jetbrains.com/)                                                     |
| `kilo`               | 在规划、编码和调试模式间切换，并按任务选用不同模型。           | 官方彩色       | [来源](https://kilo.ai/)                                                                 |
| `kimchi`             | 让不同模型分担规划、实现与审查，并控制团队的模型使用预算。     | 官方彩色       | [来源](https://kimchi.dev/)                                                              |
| `kimi`               | 在对话与命令行之间切换，边理解代码边完成任务。                 | 官方彩色       | [来源](https://github.com/MoonshotAI/kimi-cli)                                           |
| `minimax-code`       | 围绕 MiniMax 模型组织开发任务，支持多助手协作。                | 官方彩色       | [来源](https://www.minimax.io/)                                                          |
| `mistral-vibe`       | 自动结合项目结构、分支和提交记录，理解代码并推进修改。         | 官方彩色       | [来源](https://github.com/mistralai/mistral-vibe)                                        |
| `nova`               | 按步骤拆解开发任务，结合项目结构给出代码建议。                 | 官方彩色       | [来源](https://www.compassap.ai/nova/)                                                   |
| `opencode`           | 开源且不限定模型供应商，可分别规划方案和执行代码修改。         | 官方黑白       | [来源](https://github.com/anomalyco/opencode)                                            |
| `pi-acp`             | 核心精简，通过扩展、技能与主题定制自己的工作方式。             | 官方彩色       | [来源](https://pi.dev/press-kit)                                                         |
| `poolside`           | 配合 Poolside 模型处理代码，兼顾本地开发和批处理。             | 官方彩色       | [来源](https://github.com/poolsideai/pool)                                               |
| `qoder`              | 先理解整个代码库，再规划实现，并保留项目知识与记忆。           | 官方黑白       | [来源](https://docs.qoder.com/cli/overview)                                              |
| `qwen-code`          | 为通义千问模型优化，也可连接其他模型与开发工具。               | 官方彩色       | [来源](https://github.com/QwenLM/qwen-code)                                              |
| `sigit`              | 把模型推理留在本机，也可按需选择云端服务。                     | 官方彩色       | [来源](https://github.com/getsigit/sigit)                                                |
| `stakpak`            | 持续关注应用运行状况，协助部署、排障和维护基础设施。           | 官方彩色       | [来源](https://stakpak.dev/)                                                             |

## 变更与验证

仅更新 `src/runtime/agent_brands.ts`、相关品牌测试与 `public/agents/` 官方素材。6 个已改用官方 PNG/JPEG 的条目删除对应旧 SVG，源码与网页资源检索无剩余引用。统一映射继续被探索页、我的 Agent 和共用图标组件使用，没有新增 Agent 专属界面分支。验证结果见 [checks.txt](checks.txt)。
