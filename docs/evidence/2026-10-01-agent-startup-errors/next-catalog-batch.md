# 下一批五条 npx 目录：只读准备材料

核对日期：2026-10-01。本文件从[截至 01:07 的覆盖汇总](../2026-10-01-agent-access-directory-continuation/coverage.md)按目录顺序选取前五条尚未实测的 npx 条目，仅整理冻结声明、官方公开资料及后续验证条件。**五条的安装、连接、认证、模型、首发和恢复仍全部未测**；这不是新的活动计划，也没有执行安装、Agent、登录、注册、模型请求或配置修改。

## 冻结声明与公开包入口

依据[目录快照](../2026-09-30-agent-access-first-slice/registry-snapshot.json)：缓存取得于 2026-09-30 11:53:59，投影读取于 16:16:12；当次在线刷新失败，不能称为 10-01 最新目录。快照只保留环境变量名称，删除了值。下表的包、版本、参数均逐项核对该快照；`bin` / Node 要求另从 npm 官方对应版本元数据读取，未安装包。

| 顺序 / 目录 ID      | 精确包                               | 分发附加参数 | 公开包入口 / Node 声明                                                                                              | 快照环境变量名                                  |
| ------------------- | ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1 `agoragentic-acp` | `agoragentic-mcp@1.3.0`              | `["--acp"]`  | `agoragentic-mcp` → `mcp-server.js`；Node `>=18.0.0`                                                                | 无                                              |
| 2 `auggie`          | `@augmentcode/auggie@0.36.0`         | `["--acp"]`  | `auggie` → `augment.mjs`；Node `>=20.0.0`                                                                           | `AUGMENT_DISABLE_AUTO_UPDATE`，值未包含于此投影 |
| 3 `autohand`        | `@autohandai/autohand-acp@0.2.1`     | `[]`         | `autohand-acp` → `dist/index.js`；Node `>=18.17.0`                                                                  | 无                                              |
| 4 `codebuddy-code`  | `@tencent-ai/codebuddy-code@2.160.0` | `["--acp"]`  | `codebuddy-code`、`codebuddy`、`cbc` 均指向 `bin/codebuddy`；另有 prewarm / lowmem 入口，不能混用；包未声明 engines | 无                                              |
| 5 `deepagents`      | `deepagents-acp@0.1.7`               | `[]`         | `deepagents-acp` → `dist/cli.js`；包未声明 engines                                                                  | 无                                              |

精确元数据来源：[Agoragentic 1.3.0](https://registry.npmjs.org/agoragentic-mcp/1.3.0)、[Auggie 0.36.0](https://registry.npmjs.org/@augmentcode%2Fauggie/0.36.0)、[Autohand 0.2.1](https://registry.npmjs.org/@autohandai%2Fautohand-acp/0.2.1)、[CodeBuddy 2.160.0](https://registry.npmjs.org/@tencent-ai%2Fcodebuddy-code/2.160.0)、[DeepAgents 0.1.7](https://registry.npmjs.org/deepagents-acp/0.1.7)。未声明 engines 不等于支持任意 Node；Auggie 当前仓库 README 的 Node 22+ 建议也不能覆盖 0.36.0 元数据的原始声明。

这里只描述声明对应的逻辑入口，例如包中的 `auggie --acp`，没有执行 `npx`。后续应由 Farfold 正式安装器解析该精确包的入口和目录参数，记录最终受管命令；不能手工运行浮动版本、用本机同名命令替代或猜测被投影删除的环境值。

## 逐项条件与证据边界

### Agoragentic：先核实会话协议完整性

冻结目录指向[官方仓库](https://github.com/rhein1/agoragentic-integrations)。npm 1.3.0 的 `gitHead` 为 `73f444782653dc307f21e5e0728a53cad0804d18`；对应[固定源码](https://github.com/rhein1/agoragentic-integrations/blob/73f444782653dc307f21e5e0728a53cad0804d18/mcp/mcp-server.js#L648-L780)存在 `--acp` 分支，但方法分派仅有 `initialize`、`initialized`、`tools/list`、`tools/call`、`shutdown`，没有 `session/new` / `session/prompt`。没有环境 Key 时返回的 terminal 认证项只有 type 和 description，缺少 id、name、command。这是源码确认的兼容风险，尚未证明正式应用实际会停在哪一层；不能把其文本描述转换成终端命令或用 MCP 调用补出另一套对话流程。

[同提交说明](https://github.com/rhein1/agoragentic-integrations/blob/73f444782653dc307f21e5e0728a53cad0804d18/mcp/README.md)区分无需认证的市场检索与需 `AGORAGENTIC_API_KEY` 的能力调用；注册会生成秘密，能力调用涉及付费。当前仓库主分支另有无账号本地 harness 的说明，不能套用到此包。本次未注册、未核对可用账号/余额；即使无 Key 握手成功，也不能推定能聊或免费首发。

### Auggie：账号条件明确，先看真实声明

冻结目录的[官方仓库](https://github.com/augmentcode/auggie)与[登录文档](https://docs.augmentcode.com/cli/setup-auggie/authentication)明确要求有效 Augment 账号和认证会话，并提供 `auggie login`。自动化认证材料属于秘密，本次没有运行 token 输出命令、读取本机认证文件或注入凭据。该文档是当前公开说明，不是 0.36.0 协议返回收据。

后续可先通过正式 UI 验证精确包安装、连接以及实际 `authMethods`；若需要登录，在当次声明和目标核验完成后再处理账号条件。当前未知本机是否已有有效会话、账号权益是否足够、0.36.0 是否能在未登录时完成模型读取，均不能由文档预判通过。

### Autohand：组件之外还有程序和配置条件

npm 0.2.1 的 `gitHead` 为 `ad2efed4183b26778cbf0494ece87e46f5548126`。[固定 README](https://github.com/autohandai/autohand-acp/blob/ad2efed4183b26778cbf0494ece87e46f5548126/README.md#requirements)要求另有已安装并配置的 `autohand` CLI；默认从该命令启动并使用官方配置位置。故安装 `autohand-acp` 成功不能证明伴随程序或账号已准备好。该文档还说明默认权限模式为 auto，而客户端审批转发需 external；冻结目录没有相应环境变量，后续不能把未核实的模式写成已具备审批保护。

[官方 CLI 说明](https://github.com/autohandai/code-cli#configuration)列有云服务与本地推理路线，因此不能一概要求某一模型品牌账号；实际需要哪种认证取决于用户已有服务选择。本次未检查本机 CLI/配置、未选择服务或模型，也未核实其版本与 0.2.1 组件的组合。先记录缺失的伴随程序/配置出口，不代写配置或升级日常 CLI 来制造成功。

### CodeBuddy：有官方登录流程，包的多入口需核对

冻结目录未提供 repository 字段，只指向[官方 CLI 网站](https://www.codebuddy.cn/cli/)；npm 2.160.0 的 homepage 指向官方 [CodeBuddy Code 项目](https://cnb.cool/codebuddy/codebuddy-code)，不凭名称补猜 GitHub 仓库。[官方快速开始](https://www.codebuddy.cn/docs/cli/quickstart)要求首次使用登录，并区分中国站、国际站、企业服务与 iOA；选择哪条属于账号条件，不能由 Agent 名称推定。[官方命令参考](https://www.codebuddy.ai/docs/cli/cli-reference)说明 `--acp` 默认使用 stdio，不能替换为 HTTP 启动参数。

后续先确认安装器从多 bin 包选到 `bin/codebuddy`，再记录 2.160.0 实际连接和认证声明。本次未确认本机已有登录、站点或企业资格；公开文档未提供本次版本的握手、模型或免费请求证据。若要求账号，保留该具体阻塞，不自动选择站点或把其他服务的密钥交付给它。

### DeepAgents：固定版本有服务 Key 说明，首发条件仍待测

目录指向[官方仓库](https://github.com/langchain-ai/deepagentsjs)。[0.1.7 标签包清单](https://github.com/langchain-ai/deepagentsjs/blob/deepagents-acp%400.1.7/libs/acp/package.json)与 npm 入口一致；[同标签 README](https://github.com/langchain-ai/deepagentsjs/blob/deepagents-acp%400.1.7/libs/acp/README.md#environment-variables)明确列出默认 Claude 路线的 `ANTHROPIC_API_KEY` 与 OpenAI 路线的 `OPENAI_API_KEY`，不是从模型名猜测的账号需求。目录未给附加模型参数或这些环境变量值。

同版本文档声明会话创建/恢复与认证透传能力，但未证明实际 `initialize` 会提供可由 Farfold 操作的 Key 输入方法，也未证明没有 Key 时在哪一步阻塞。后续保持目录默认参数先验证连接/模型读取边界；本次不替用户换模型、不新配服务、不以握手成功推定服务有效。模型、首发与冷恢复仍需分别取得真实结果。

## 建议验证顺序及共同边界

建议 **Auggie → CodeBuddy → DeepAgents → Autohand → Agoragentic**：前三项先覆盖正式 CLI 登录、多 bin 入口及服务 Key 条件；Autohand 单独观察伴随程序缺失出口；Agoragentic 最后核实不完整协议声明，避免把账户准备误当其首要问题。此顺序是上述静态条件推导出的建议，不表示前三项更可能免账号成功。

每条先记录当次候选、实际包/命令、安装检查、真实声明和错误。进入管理页若自动发出 `session/new`，必须如实记为已尝试模型读取，不能称 initialize-only。账号登录、首次请求和恢复分别保留未测或阻塞；有模型清单、终端入口或空成功返回都不升级为真实回复通过。执行前若在线目录版本/参数变化，应保留差异并另记实际对象，不将新版本结果回填为本表冻结版本通过。

本次只进行了本地证据读取与官方网络 GET。五个精确 npm 元数据均已读取；公开归档正文读取曾出现网络断开/不完整 JSON，未使用未完成的归档内容作依据，固定源码链接与公开文档的边界如上。没有安装包、执行下载脚本、启动 Agent、读取秘密或改变覆盖表中的实测结论。
