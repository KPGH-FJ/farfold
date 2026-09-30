# Agent 首次使用全链路审查

2026-09-26。范围：发现 Agent → 准备程序 → 获取账号或密钥 → 登录/配置 → 选择模型 → 首次回复 → 返回继续。只找问题，不修改产品代码、配置或安装包。

## 结论

当前已经有目录、安装、连接、登录终端和测试组件，但它们尚未组成普通新用户可以顺畅完成的使用流程。上一轮以“入口能打开、程序能连接、已有账号的样本能回复”推到“整条链路已打通”，结论过大。

本轮安装版直接复现了无法继续的 API 路径、认证失败后的无效重试、入口之间丢失目标，以及 Qwen 登录界面的可读性问题。账号缺失只能解释为什么暂时不能调用模型，不能解释这些 Farfold 流程缺陷。

**阶段判断：接入基础设施已有，首次使用流程仍处于需要开发者协助的验证阶段，不能按“新用户一键开始使用”验收。** 此判断只针对 Agent 接入链路，不扩展为整个产品全部旅程的评级。

## 证据范围

- 现场：`/Applications/Farfold.app`，版本 0.1.7，应用标识 `ai.farfold.desktop`。
- 可执行文件 SHA-256：`b4283a115f315fa934e65a62b16fc6a406cd423260904914773a6c477d3fbdc3`。
- 当前机器已有安装和配置，不是干净的新用户环境。实际操作 Qwen、Amp 的准备/登录入口，以及新对话选择 Antigravity 的跳转；没有安装 Antigravity。
- 未注册账号、未输入密钥、未选择或保存外部服务配置，未提交真实模型消息。Qwen 在创建测试对话前遇到认证要求，点击重新准备后仍失败。
- 未重装/卸载程序、未模拟断网、未重启应用；关于这些条件的结论明确标为源码确认或条件风险。
- 临时登录终端均已取消；审查打开的 Qwen 文档标签已关闭。原有草稿仍在且未发送。
- 审查前后 188 个源文件及契约/依赖文件哈希一致，安装版二进制一致，见 [unchanged-check.json](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/unchanged-check.json)。新增内容仅为本目录的审查记录与截图。

## 按用户任务检查整条链路

| 步骤 | 当前健康度 | 用户遇到的问题 | 证据类型 |
| --- | --- | --- | --- |
| 1. 找到并选择 Agent | 有明显摩擦 | 新对话选 Antigravity，跳到市场后仍显示先前搜索的 Qwen，需要重新找一次 | 安装版复现 |
| 2. 准备所需程序 | 部分具备，未验证首次安装闭环 | 程序、接入组件、依赖安装和连接分别处理；依赖安装后仍需检查连接。现有 Amp 的程序就绪，但连接未就绪 | 当前界面 + 源码；未重装 |
| 3. 获取账号/密钥 | 导航不完整 | 设置中的登录页没有市场向导里的账号链接；Qwen 的“获取账号和密钥”实际打开英文认证说明文档 | 安装版复现 |
| 4. 登录或配置服务 | 存在阻断 | Qwen 完整设置界面被塞入小终端，选项显示异常；Amp“登录账号”实际要求手动粘贴 API key | 安装版复现；未提交凭据 |
| 5. 选择模型和验证 | 存在阻断 | 不支持的 API 路径仍能进入；认证失败后主要动作只是重复准备，不能直接去解决认证 | 安装版复现 |
| 6. 进入正式对话 | 规则不一致 | 市场必须通过特定测试才能开始；新对话的已添加 Agent 没有同样门槛；测试配置的交接还存在条件风险 | 源码确认；未发新消息 |
| 7. 中断后返回或失败恢复 | 不完整 | 仅关闭向导就让通过的测试失效；只记住步骤，不足以表达真实准备状态；终端失败后输出被移除 | 源码确认；部分状态在界面可见 |

## 主要问题

### 1. P1：展示了当前无法完成的 API 路径

**复现：** Qwen → 使用 API 配置 → 继续。下一页只剩“沿用 Agent 已有设置”，同时提示此 Agent 不支持这里的 API 配置；测试和继续均不可用。再次选择“沿用已有设置”，仍停留在 API 路径，按钮仍不可用。

“前往 API 配置”又把用户带到全局服务设置，本机已有服务显示适用于 OpenCode，不能解开当前 Qwen 死路。该设置页的“返回刚才的页面”可以正常返回，这是有效的已有行为，但没有解决能力不匹配。

**原因：** 三种使用方式无条件展示；下一页却要求 API 服务兼容。下拉框清空服务没有同步切换使用方式。[AgentSetup.tsx:454](/Users/tw/Desktop/farfold/src/components/AgentSetup.tsx:454)、[AgentSetup.tsx:129](/Users/tw/Desktop/farfold/src/components/AgentSetup.tsx:129)、[ServicePicker.tsx:113](/Users/tw/Desktop/farfold/src/components/ServicePicker.tsx:113)。后端已明确声明不支持，并非无法预先判断。[service_config.rs:31](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/service_config.rs:31)

**应达到的体验：** 用户看到的每条主要路径都能完成；不支持的能力应在做选择之前讲清楚，不能让用户靠试错发现。

![Qwen API 路径无法继续](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/05-qwen-api-deadend.png)

### 2. P1：认证错误没有通往解决问题的动作

**复现：** Qwen 沿用已有设置 → 选择与测试。尚未发出测试消息，就提示需要认证，同时显示“测试请求未完成，请查看对话中的实际结果”。当前并没有可查看结果的测试对话；主要按钮是“重新准备测试”。点击一次后重复同一认证错误。

登录入口只在上一步的“登录账号”分支，错误页没有“去登录/配置”动作。用户需要自行推断返回哪一步、改哪个选项。

**原因：** 创建测试失败进入通用失败状态，重试重新执行同一准备；认证提示没有转成当前目标的恢复动作。[AgentSetup.tsx:272](/Users/tw/Desktop/farfold/src/components/AgentSetup.tsx:272)、[AgentSetup.tsx:473](/Users/tw/Desktop/farfold/src/components/AgentSetup.tsx:473)、[AgentSetup.tsx:646](/Users/tw/Desktop/farfold/src/components/AgentSetup.tsx:646)、[access_strings.ts:91](/Users/tw/Desktop/farfold/src/runtime/access_strings.ts:91)

**应达到的体验：** 缺什么，就直接带用户补什么；补完后回到原来的 Agent 和模型选择，不让用户重走向导。

![认证失败后的主要动作仍是重复准备](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/08-qwen-auth-recovery.png)

### 3. P1：打开终端没有完成登录体验

**Qwen 实测：** 设置终端显示 `Connect a Provider`，右侧选项文字挤到边缘，伴随英文缺少密钥错误和程序警告。页面要求输入 `/auth`，但此时已经处于服务选择界面。用户需要自己理解命令、服务、密钥、模型和错误。不能把“终端出现了”当成“用户能完成登录”。

**Amp 实测：** “登录账号”打开英文 `AMP API key` 输入提示，要求用户去官方设置页拿密钥再回来。这个官方认证方式可以使用，但 Farfold 的名称和引导没有把“网页账号 → 获取密钥 → 回来填写 → 确认有效”解释成一条清晰的路径。

**归因边界：** Qwen 的缺少密钥和程序警告来自外部程序；终端布局问题已在 Farfold 中观察到，但具体根因未定。源码有“固定 100×28 启动后再调整尺寸”的时序差，以及 220px 固定高度；没有发现行列传反，不据此宣称已经找到全部根因。[InlineTerminal.tsx:94](/Users/tw/Desktop/farfold/src/components/InlineTerminal.tsx:94)、[auth.rs:493](/Users/tw/Desktop/farfold/src-tauri/src/auth.rs:493)、[styles-settings.css:430](/Users/tw/Desktop/farfold/src/styles-settings.css:430)

**应达到的体验：** 必须交给官方页面或终端的步骤，应说明要做什么、怎样算完成、如何返回，并保证操作区域可读可用。

![Qwen 登录界面的实际显示问题](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/03-qwen-terminal.png)

[Amp 登录现场](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/11-amp-login.png)

### 4. P2：多个入口没有汇成同一条准备流程

**复现 A：** 设置 → Agent 与账号 → Qwen 登录。只有登录操作、重连和手动配置，没有市场向导中的获取账号链接，也没有明确通往模型测试/开始对话的下一步。[设置登录现场](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/02-qwen-settings-login.png)

**复现 B：** 新对话 → 选择 Agent → Google Antigravity 未连接。跳到市场后，搜索词仍是 Qwen，只显示 Qwen；用户刚选的目标被丢弃。代码点击事件没有传递 Agent ID。[AgentPick.tsx:54](/Users/tw/Desktop/farfold/src/components/AgentPick.tsx:54)

**应达到的体验：** 无论从市场、设置还是新对话进入，都接着完成同一个 Agent 的剩余准备，而不是让用户自己在页面之间拼流程。

[选择入口的界面与无障碍记录](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/09-select-antigravity.txt) · [跳转后却仍显示 Qwen](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/10-selected-agent-lost.png)

### 5. P2：账号入口的承诺与目的地不匹配

Qwen 的“获取账号和密钥”实测打开英文认证配置文档，内容包含不同服务、配置方式和命令，没有直接完成注册或取得密钥。用户仍需要先读懂服务差异，再自行寻找目标页面。

不是所有 Agent 都有一个可直接注册的自有账号，因此不能统一把文档链接包装成“获取账号”。当前应该明确区分官方账号、服务商账号、密钥和已有配置。[链接声明 preparation.rs:104](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/preparation.rs:104)、[实际目的地](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/07-qwen-account-document.png)

### 6. P2：步骤进度与真实可用状态脱节

Amp 当前程序已准备好，但尚未连接；打开记住的向导后处于第二步，第一步显示勾选，继续却不可用。返回第一步才看到“检查连接”。[第二步现场](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/11-amp-login.png)、[返回第一步后的实际状态](/Users/tw/Desktop/farfold/docs/evidence/2026-09-26-agent-onboarding-audit/12-amp-program-state.png)

Qwen 同时出现“已连接”和缺少认证也有技术上的合理解释，但用户需要一个“目前还差哪一步”的明确总状态。已有技术状态不足以指导下一步。

源码还表明向导只在应用内存中保存步骤；关闭操作无条件让测试失效，即使用户没有改模型、账号或程序。返回后可能宣称“设置已变化”并要求重测。[AgentHub.tsx:37](/Users/tw/Desktop/farfold/src/components/AgentHub.tsx:37)、[AgentSetup.tsx:268](/Users/tw/Desktop/farfold/src/components/AgentSetup.tsx:268)、[agent_preparation.ts:384](/Users/tw/Desktop/farfold/src/runtime/agent_preparation.ts:384)。后半项是源码确认，本轮没有消耗模型额度重现“通过后关闭”。

### 7. P2：把工程验证步骤变成了不一致的用户门槛

源码确认：市场必须通过指定回复测试，才允许开始使用；新对话选择已添加 Agent 则没有同样门槛。测试本身有价值，但目前用户从不同入口得到不同规则，而关闭向导又能使结果失效，增加重复操作与模型请求。

[AgentHub.tsx:95](/Users/tw/Desktop/farfold/src/components/AgentHub.tsx:95)、[AgentSetup.tsx:750](/Users/tw/Desktop/farfold/src/components/AgentSetup.tsx:750)、[AgentPick.tsx:34](/Users/tw/Desktop/farfold/src/components/AgentPick.tsx:34)。本轮未发真实测试消息；不能据此声称账号或模型已验证成功。

### 8. P2：失败恢复还没有覆盖完整

- **依赖准备后没有接着连接：** 主安装路径立即连接；需要另装依赖时会先断开，安装后仅刷新。流程由多个动作拼接，用户仍需理解何时再次检查连接。[agents.ts:638](/Users/tw/Desktop/farfold/src/runtime/agents.ts:638)、[AgentSetup.tsx:348](/Users/tw/Desktop/farfold/src/components/AgentSetup.tsx:348)。源码确认，本轮未重装。
- **重新检查可能仍返回旧失败：** 程序版本探测的失败结果会按文件属性缓存；同一进程、同一文件且缓存未清除时，重新检查未必重新执行探测。短暂失败后用户可能反复得到同一失败。[preparation.rs:248](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/preparation.rs:248)。源码条件风险，未注入故障。
- **终端退出后原因消失：** 登录终端退出后立即移除，非零退出只显示一般失败信息。若原因只在终端输出中，用户难以判断该重新登录、检查网络还是处理程序问题。[AgentAuthSection.tsx:247](/Users/tw/Desktop/farfold/src/components/AgentAuthSection.tsx:247)。源码确认，未提交错误密钥制造失败。

## 另需验证的两项接入正确性风险

1. `authenticate` 在同一 Agent 的多个工作目录连接中按目录排序选择一个空闲连接，没有定位本次准备使用的连接。若某 Agent 的认证只对进程生效，就可能发生登录连接 A、测试连接 B 仍需认证。源码已确认选择逻辑；是否影响具体 Agent 取决于其认证实现，本轮没有真实复现，不能外推到所有 Agent。[manager.rs:654](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/manager.rs:654)
2. 从测试进入新对话时，如果新对话没有之前测试的某个配置项，或其选项已不包含原值，前端会跳过该选择继续开草稿。不同工作目录/能力变化时，存在测试选择与实际新对话选择不一致的风险。本轮未观察到真实模型漂移。[EmptyState.tsx:184](/Users/tw/Desktop/farfold/src/components/EmptyState.tsx:184)

## 责任与验收边界

账号注册、权益、收费、密钥有效性和 Agent 提供哪些认证方式，属于外部服务/Agent。Farfold 应负责可执行的入口、依赖准备、能力判断、可用的交互区域、状态说明、错误恢复及回到原任务。协议没有包办外部账号，不意味着 Farfold 可以把不能执行的按钮、丢失选择或无效重试归因于协议。

降低用户复杂度的验收应按用户结果判断：用户选定 Agent 后，只需完成必要的个人授权或填写；剩余步骤连续推进。没有账号时能找到正确官方入口；已有配置时能复用；遇错直接到解决位置；返回后保持选择；最后用选定模型完成第一条实际消息。不能用目录数量、连接成功、终端能打开或某一个已有账号的成功样本代替整条链路。

本轮只形成问题与证据，没有开始修复。
