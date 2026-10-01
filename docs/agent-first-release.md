# 首批 Agent 目录范围

审核日期：2026-10-02。按用户本次授权，已审核的 41 个目录身份中，**33 项保留为首批候选，8 项暂缓展示**；新增且未审核的目录身份先不进入首批。此处只决定“探索 Agent”列表，不是协议兼容性判定，也不代表完整接入已经通过。

暂缓条目的已有接入、程序、账号设置、原稿和对话历史保留，仍可从“我的 Agent”管理或从原对话进入；用户添加的程序及本机发现不按同名目录条目筛除。目录缓存与安装信息不删除，也不按版本限制 Agent。

## 暂缓的 8 项

| Agent / 目录 ID                 | 当前依据                                                                                                                                                                                                                                                                                                              | 重新进入首批的条件                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Agoragentic / `agoragentic-acp` | 安装与连接通过；创建对话、模型读取失败，原因未知；目前没有已交付的服务准备路线。[第二批](evidence/2026-10-01-agent-access-directory-batch2/README.md)                                                                                                                                                                 | 核实可完成准备的官方路线，安装版读模型及实际请求验证。                                 |
| Cortex Code / `cortex-code`     | 未声明登录方法；真实请求返回缺少 Snowflake 连接，目前没有对应的连接配置动作。[第五批](evidence/2026-10-01-agent-access-directory-batch5/README.md)                                                                                                                                                                    | 提供经过核实的官方连接准备动作，按用户选择验证实际请求。                               |
| crow / `crow-cli`               | 模型读取失败；旧自动账号方式无法确认程序目标，仍禁用。名称“No Authentication Required”不能替代可用性验证。[固定原因安装验证](evidence/2026-10-01-agent-auth-route-diagnostics/installed.md)                                                                                                                           | 安全核实实际准备方式并验证模型、请求；无需登录时按免登录路线验证。                     |
| DeepAgents / `deepagents`       | 环境 Key 方式只显示说明，当前不能直接交付；setup 和 authenticate 在已装包中为空操作。真实请求失败原因仍未知。[静态核对](evidence/2026-10-01-agent-access-directory-batch2/deepagents-static.md)、[声明安装验证](evidence/2026-10-01-agent-auth-declarations/installed.md)                                             | 实现经过核实的官方服务交付方式，验证实际模型请求，不能把空成功回执当作 Key 已配置。    |
| GLM / `glm-acp-agent`           | 1.13.0 的普通 authenticate 直接返回空成功；Key 仍依赖外部 `Z_AI_API_KEY` 或官方 `--setup`，当前没有已交付的设置动作。旧环境方法只读；实际短测缺 Key。[第四批](evidence/2026-10-01-agent-access-directory-batch4/README.md)、[同名方法说明](evidence/2026-10-01-agent-access-directory-batch4/auth-label-diagnosis.md) | 提供已核实的设置或明确 Key 交付路线并验证实际请求；不从说明文字自动生成命令。          |
| Harn / `harn`                   | 连接通过；明确调用一次匿名方法后，模型读取仍失败，原因未知。没有成功回复。[第六批](evidence/2026-10-01-agent-access-directory-batch6/README.md)                                                                                                                                                                       | 核实实际模型准备条件并验证请求；不把匿名 authenticate 返回当作模型可用。               |
| Minion Code / `minion-code`     | 多次连接检查提前结束，未登记，候选目录已回收；尚无可用安装结果。具体运行根因仍未知。[启动诊断安装验证](evidence/2026-10-01-agent-startup-diagnostics/installed.md)                                                                                                                                                    | 官方可安装发行或已核实路线通过安装、连接、模型与实际请求检查；不修改外部依赖制造通过。 |
| VT Code / `vtcode`              | 当前实际声明没有登录方法；首次真实请求失败，后续历史仍未恢复。空方法表和版本差异不是故障原因的证明。[发行核对](evidence/2026-10-01-agent-access-directory-batch7/vtcode-release-diagnosis.md)、[安装复验](evidence/2026-10-01-protocol-error-classification/installed.md)                                             | 核实可用的已有设置或官方准备路线，并验证实际请求及相应恢复能力。                       |

GLM 的静态判断另以本次只读的已装官方包 `glm-acp-agent@1.13.0` 为依据：`dist/protocol/agent.js:182–197` 声明外部 Key/设置方式，`:228–234` 的 `authenticate` 不收集或验证 Key、直接返回 `{}`。这次没有调用它，也不把静态判断改写成新增登录实测。

## 保留的 33 项及已知边界

| Agent / 目录 ID                       | 已知登录或准备路线                              | 实际验证边界                                                                         |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Amp / `amp-acp`                       | 已核实的设置终端                                | 启动、取消和 Medium 读取通过；实际请求要求认证，无成功回复。                         |
| Antigravity / `antigravity-acp`       | Google / Enterprise 等协议声明                  | 安装连接通过；模型要求认证，未执行登录。                                             |
| Auggie / `auggie`                     | 同程序的官方登录终端                            | 安装连接、登录启动/取消通过；当前合法声明环境兼容修复另片验证；没有账号成功结论。    |
| Autohand / `autohand`                 | 官方伴随 CLI 准备动作                           | 组件连接与缺程序出口通过；实际 CLI 安装待用户确认，登录、首发未测。                  |
| Claude / `claude-acp`                 | 两种标准终端方法                                | 既有组件连接、Default 读取通过；短测要求认证，未完成登录。                           |
| Cline / `cline`                       | 三种协议方法                                    | 旧候选连接及方法展示通过；当前安装、模型与请求仍未测。                               |
| CodeBuddy / `codebuddy-code`          | iOA / Google-GitHub / WeChat / 企业域等协议方法 | 安装连接通过；模型要求认证，未执行登录。                                             |
| Codex / `codex-acp`                   | 已有设置；官方服务交付                          | 6 Astra / Ultra 首发成功；冷恢复返回模型漂移，发送保护仍阻止续发。新登录未测。       |
| Corust / `corust-agent`               | 浏览器 OAuth 声明                               | 安装连接通过；模型要求认证，未执行登录。                                             |
| Cursor / `cursor`                     | Cursor Login 声明                               | 安装连接通过；模型要求认证，未执行登录。                                             |
| Devin / `devin`                       | 浏览器、标准终端方法                            | 安装连接通过，无可选模型；唯一短测要求认证，未登录。                                 |
| DimCode / `dimcode`                   | 标准终端设置方法                                | 安装连接、声明参数逐字追加、启动/取消通过；未完成认证或模型读取。                    |
| Dirac / `dirac`                       | 官方服务设置、ChatGPT、终端等声明               | 原模型及两个思考项读取通过；真实请求未测，旧历史仍失败。                             |
| Factory Droid / `factory-droid`       | Login / Factory API Key 声明                    | 新受管程序安装连接通过；模型要求认证，未执行登录。                                   |
| fast-agent / `fast-agent`             | 沿用已有设置；公开配置说明                      | 实际首发、冷恢复和显式续接成功；未提供可选模型，具体模型身份未知；新设置未测。       |
| Gemini / `gemini`                     | 四种协议方法                                    | 安装连接通过；模型要求认证，未执行登录。                                             |
| GitHub Copilot / `github-copilot-cli` | 同受管包的官方登录程序                          | 后续安装版登录启动、暂离和取消通过；账号、实际回复未测。                             |
| Goose / `goose`                       | 官方配置服务动作                                | 配置终端审阅、暂离/取消/重查通过；尚未完成配置，模型读取仍失败。                     |
| Grok Build / `grok-build`             | Grok 登录声明                                   | 新受管 1.0.46 安装连接通过；模型要求认证，未执行登录。                               |
| Junie / `junie`                       | 账号方法及标准终端方法                          | 新目录安装连接通过；模型受认证阻挡，未执行登录。旧失败保留。                         |
| Kilo / `kilo`                         | 精确核实的官方登录程序                          | ZIP 安装连接、模型目录读取、登录启动/取消通过；无成功登录或请求结论。                |
| Kimchi / `kimchi`                     | 普通 / US / 标准终端方法                        | 安装连接通过；模型要求认证，未执行登录。                                             |
| Kimi / `kimi`                         | 已核实的官方登录终端                            | 安装连接、登录启动/取消通过；模型要求认证，未完成登录。                              |
| MiniMax / `minimax-code`              | 标准终端登录方法                                | 安装连接通过；模型要求认证，未执行登录。                                             |
| Mistral Vibe / `mistral-vibe`         | AI Studio / 标准终端 Key 设置                   | 安装连接通过；模型要求认证，未执行登录。                                             |
| Nova / `nova`                         | 标准终端设置方法                                | 安装连接通过；模型要求认证，未执行配置。                                             |
| OpenCode / `opencode`                 | 已有设置；官方服务交付                          | 原 Nemotron 来源/模型、真实首发与多次冷续接通过；新云端服务条件未测。                |
| Pi / `pi-acp`                         | 已有设置及官方程序准备/回选                     | 原 DeepSeek/off 读取、程序选择保持通过；真实请求无正文/旧 402 失败保留，新认证未测。 |
| Poolside / `poolside`                 | 官方登录终端声明                                | 安装连接通过；模型要求认证，未打开终端。                                             |
| Qoder / `qoder`                       | login / personal token 两项声明                 | 安装连接通过；模型要求认证，具体账号动作未执行。                                     |
| Qwen / `qwen-code`                    | 官方设置终端                                    | 旧终端打开/返回重连与当前安装连接通过；账号、模型和请求成功未测。                    |
| siGit / `sigit`                       | 浏览器授权声明                                  | 安装连接及模型目录读取通过；未登录或首发，旧历史仍未恢复。                           |
| Stakpak / `stakpak`                   | 浏览器登录声明                                  | 安装连接通过；模型要求认证，未执行登录。                                             |

上述事实首先定位于[41 项跨候选覆盖索引](evidence/2026-10-01-agent-access-directory-batch7/coverage.md)，并以之后的 [Copilot 登录验证](evidence/2026-10-01-agent-copilot-login/installed.md)、[Autohand 准备验证](evidence/2026-10-01-agent-access-companion-program/installed.md)、[Junie 新目录验证](evidence/2026-10-01-managed-installation-paths/installed.md)、[多模型项验证](evidence/2026-10-01-agent-config-categories/README.md)及[历史恢复复验](evidence/2026-10-01-agent-history-retry/installed.md)补充。不同候选的成功不合成一次完整接入通过；公开方法可见不证明实际登录成功。

缺账号、Key、服务额度或本地模型条件的条目继续记录未测；没有认证方法的 Agent 也可以沿已有设置工作。33 项保留只说明目前有官方或已有接入路线可继续验证，不替代完整首发、继续、取消与恢复验收。

## 实现与再审核

集中名单在 [first_release.rs](../src-tauri/src/acp_client/first_release.rs)，只匹配官方 registry ID。目录接口继续返回完整条目，通过 `firstBatchVisible` 交给通用发现列表；已添加、详情与原对话不使用该字段作执行许可，也不撤销已有选择。未知新 ID 在核实准备路线后再显式加入；暂缓项在相应出口验证后重新审核，不通过修改版本、伪造身份或自动替用户登录恢复展示。

本次目录筛选的定向测试与安装验证分开记录。源码/受控测试通过不等于这份目录已在正式安装版验收；安装版结果由相应候选证据补记。
