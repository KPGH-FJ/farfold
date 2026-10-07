# 首批 Agent 目录范围

当前范围决定：2026-10-07。用户明确将 Corust Agent（`corust-agent`）、Junie（`junie`）、Stakpak（`stakpak`，用户消息拼作 starpak）和 Auggie CLI（`auggie`）移出首批，并删除相关专属内容。当前产品目录与接入开发范围为 29 项，八项接入标准保持；移出条目的专属开发和验收任务撤销。移除是用户主动缩减，不是对官方接入方式或登录结果的判定；未来增加须另行授权和审核，没有自动重新纳入条件。

本次不改写旧实测数字，不删除原始证据、用户历史、凭据或外部 Agent 配置。正式应用及已有数据的实际状态另见 [当前状态](status.md)，不能由名单变更推定已经安装或清理。

2026-10-03 旧清理执行边界（仅历史追溯）：正常退出不授权永久删除历史，4 条会话索引及对应安装先保留。先明确可恢复处理、历史访问、安全恢复材料，并核每个托管目录的归属和用户内容；原删除草案暂停，尚未执行。

此前范围决定：2026-10-02 用户为减少本轮工作量，明确移除原暂缓的 8 项，当时保留 33 项；下方旧清理记录只作历史追溯。

2026-10-02 的目录清理保留了旧登记。2026-10-03 用户进一步明确要求将这 8 项清理干净：按精确身份清理 Farfold 登记、会话索引、自有设置引用和有记录且未共享的托管安装，应用须先正常退出且无未发送工作。外部 Agent 账号、配置、凭据与历史，以及其他 Agent 数据保留；不按名称扫删，实际执行与范围核验见[清理收据](evidence/2026-10-03-brand-and-input/README.md)。

## 已移出当前范围的 8 项（仅历史追溯）

| Agent / 目录 ID                 | 当前依据                                                                                                                                                                                                                                                                                                              | 历史未关闭条件（非当前任务）                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Agoragentic / `agoragentic-acp` | 安装与连接通过；创建对话、模型读取失败，原因未知；目前没有已交付的服务准备路线。[第二批](evidence/2026-10-01-agent-access-directory-batch2/README.md)                                                                                                                                                                 | 核实可完成准备的官方路线，安装版读模型及实际请求验证。                                 |
| Cortex Code / `cortex-code`     | 未声明登录方法；真实请求返回缺少 Snowflake 连接，目前没有对应的连接配置动作。[第五批](evidence/2026-10-01-agent-access-directory-batch5/README.md)                                                                                                                                                                    | 提供经过核实的官方连接准备动作，按用户选择验证实际请求。                               |
| crow / `crow-cli`               | 模型读取失败；旧自动账号方式无法确认程序目标，仍禁用。名称“No Authentication Required”不能替代可用性验证。[固定原因安装验证](evidence/2026-10-01-agent-auth-route-diagnostics/installed.md)                                                                                                                           | 安全核实实际准备方式并验证模型、请求；无需登录时按免登录路线验证。                     |
| DeepAgents / `deepagents`       | 环境 Key 方式只显示说明，当前不能直接交付；setup 和 authenticate 在已装包中为空操作。真实请求失败原因仍未知。[静态核对](evidence/2026-10-01-agent-access-directory-batch2/deepagents-static.md)、[声明安装验证](evidence/2026-10-01-agent-auth-declarations/installed.md)                                             | 实现经过核实的官方服务交付方式，验证实际模型请求，不能把空成功回执当作 Key 已配置。    |
| GLM / `glm-acp-agent`           | 1.13.0 的普通 authenticate 直接返回空成功；Key 仍依赖外部 `Z_AI_API_KEY` 或官方 `--setup`，当前没有已交付的设置动作。旧环境方法只读；实际短测缺 Key。[第四批](evidence/2026-10-01-agent-access-directory-batch4/README.md)、[同名方法说明](evidence/2026-10-01-agent-access-directory-batch4/auth-label-diagnosis.md) | 提供已核实的设置或明确 Key 交付路线并验证实际请求；不从说明文字自动生成命令。          |
| Harn / `harn`                   | 连接通过；明确调用一次匿名方法后，模型读取仍失败，原因未知。没有成功回复。[第六批](evidence/2026-10-01-agent-access-directory-batch6/README.md)                                                                                                                                                                       | 核实实际模型准备条件并验证请求；不把匿名 authenticate 返回当作模型可用。               |
| Minion Code / `minion-code`     | 多次连接检查提前结束，未登记，候选目录已回收；尚无可用安装结果。具体运行根因仍未知。[启动诊断安装验证](evidence/2026-10-01-agent-startup-diagnostics/installed.md)                                                                                                                                                    | 官方可安装发行或已核实路线通过安装、连接、模型与实际请求检查；不修改外部依赖制造通过。 |
| VT Code / `vtcode`              | 当前实际声明没有登录方法；首次真实请求失败，后续历史仍未恢复。空方法表和版本差异不是故障原因的证明。[发行核对](evidence/2026-10-01-agent-access-directory-batch7/vtcode-release-diagnosis.md)、[安装复验](evidence/2026-10-01-protocol-error-classification/installed.md)                                             | 核实可用的已有设置或官方准备路线，并验证实际请求及相应恢复能力。                       |

上表失败及未关闭条件仅作历史追溯，不再是本轮实现或接入检查依赖。GLM 的旧静态记录以已装官方包 `glm-acp-agent@1.13.0` 为依据：普通 `authenticate` 不收集或验证 Key，直接返回空对象；此事实不代表新增实测，也不构成移除理由。

## 当前 29 项的既有验证记录（历史候选）

| Agent / 目录 ID                       | 已知登录或准备路线                              | 实际验证边界                                                                         |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Amp / `amp-acp`                       | 已核实的设置终端                                | 启动、取消和 Medium 读取通过；实际请求要求认证，无成功回复。                         |
| Antigravity / `antigravity-acp`       | Google / Enterprise 等协议声明                  | 安装连接通过；模型要求认证，未执行登录。                                             |
| Autohand / `autohand`                 | 官方伴随 CLI 准备动作                           | 组件连接与缺程序出口通过；实际 CLI 安装待用户确认，登录、首发未测。                  |
| Claude / `claude-acp`                 | 两种标准终端方法                                | 既有组件连接、Default 读取通过；短测要求认证，未完成登录。                           |
| Cline / `cline`                       | 三种协议方法                                    | 旧候选连接及方法展示通过；当前安装、模型与请求仍未测。                               |
| CodeBuddy / `codebuddy-code`          | iOA / Google-GitHub / WeChat / 企业域等协议方法 | 安装连接通过；模型要求认证，未执行登录。                                             |
| Codex / `codex-acp`                   | 已有设置；官方服务交付                          | 6 Astra / Ultra 首发成功；冷恢复返回模型漂移，发送保护仍阻止续发。新登录未测。       |
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

上述事实首先定位于[41 项跨候选覆盖索引](evidence/2026-10-01-agent-access-directory-batch7/coverage.md)，并以之后的 [Copilot 登录验证](evidence/2026-10-01-agent-copilot-login/installed.md)、[Autohand 准备验证](evidence/2026-10-01-agent-access-companion-program/installed.md)、[多模型项验证](evidence/2026-10-01-agent-config-categories/README.md)及[历史恢复复验](evidence/2026-10-01-agent-history-retry/installed.md)补充。不同候选的成功不合成一次完整接入通过；公开方法可见不证明实际登录成功。

剩余 29 项的账号、Key、服务额度或本地模型条件分别记录，真实登录和秘密输入交用户本人完成；缺账号不自动缩减保留范围。方法存在、连接成功与入口打开不代表账号或请求成功。当前完成标准以 [产品契约](../PRODUCT.md#3-当前接入完成标准) 的八项要求为准，代表结果只证明实际覆盖路径；实测顺序与授权以 [活动计划](../plans/agent-access.md) 为准。

## 实现与再审核

集中名单在 [first_release.rs](../src-tauri/src/acp_client/first_release.rs)，仅保留当前 29 项精确目录 ID。`catalog_list` 只给出当前目录条目，目录安装和准备入口也核对当前范围；完整远端缓存不因范围变化清除。客户端仍用通用卡片处理已有登记；目录外旧登记退出日常列表，历史访问与自定义接入沿共用规则保留，不删除外部程序或用户配置。

安装版 `b751575` 曾观察到探索 33 项及已有 40 项管理入口，见[原安装记录](evidence/2026-10-02-agent-onboarding-consistency/installed.md)；那是旧范围与展示策略的历史结果，不证明当前 29 项目录已在正式应用生效，也不代表账号或完整接入通过。

## 当前保留的 29 项

名称和精确目录身份见下表；能力达标结果另见当前状态，不由名单推出。

| Agent / 目录 ID                       |
| ------------------------------------- |
| Amp / `amp-acp`                       |
| Antigravity / `antigravity-acp`       |
| Autohand / `autohand`                 |
| Claude / `claude-acp`                 |
| Cline / `cline`                       |
| CodeBuddy / `codebuddy-code`          |
| Codex / `codex-acp`                   |
| Cursor / `cursor`                     |
| Devin / `devin`                       |
| DimCode / `dimcode`                   |
| Dirac / `dirac`                       |
| Factory Droid / `factory-droid`       |
| fast-agent / `fast-agent`             |
| Gemini / `gemini`                     |
| GitHub Copilot / `github-copilot-cli` |
| Goose / `goose`                       |
| Grok Build / `grok-build`             |
| Kilo / `kilo`                         |
| Kimchi / `kimchi`                     |
| Kimi / `kimi`                         |
| MiniMax / `minimax-code`              |
| Mistral Vibe / `mistral-vibe`         |
| Nova / `nova`                         |
| OpenCode / `opencode`                 |
| Pi / `pi-acp`                         |
| Poolside / `poolside`                 |
| Qoder / `qoder`                       |
| Qwen / `qwen-code`                    |
| siGit / `sigit`                       |
