# 目录续验：fast-agent、Claude 与 Kimi

2026-10-01 00:54–01:07（Asia/Shanghai），复用同一正式 `/Applications/Farfold.app` 候选 `c39b05d`。fast-agent 首发、冷恢复及显式续答成功；Claude 连接和选项读取成功，但实际请求要求认证；Kimi 新安装和连接成功，登录终端启动、取消通过，未完成账号登录。

本轮没有重新打包、替换应用或运行工作区后续改动。[41 条覆盖汇总](coverage.md)更新到本轮退出，仅按各自候选累计证据，不拼成当前候选全目录通过。

## 候选与范围

[本轮身份](candidate-install.json)于 00:54 核对，复用[00:41 原安装](../2026-10-01-agent-access-auth-sequencing/candidate-install.json)；二进制 SHA-256 为 `610ec230d20cdb540f17f636a24dfc383d231dd01d7b4b030287fecf055fc634`。签名、复制一致，[398 项冻结输入](candidate-source.json)至 [01:07:35 退出](after-exit.json)均未变。此后解除冻结开展的源码工作不属于本轮候选。

工程检查沿用[同候选记录](../2026-10-01-agent-access-auth-sequencing/README.md)：1,046 项前端、401 项 Rust 通过，3 项既有忽略，以及类型、格式、构建、fmt、clippy 和打包；本轮未重跑。没有新增重复应用，引用上一轮的[精确删除证明](../2026-10-01-agent-access-auth-sequencing/duplicate-cleanup.json)，不声称本轮再次删除。

## 实际旅程

| 路线                    | 操作与实际结果                                                                                                                                           | 证据及限制                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fast-agent 首发         | 复用刚安装的 0.10.1，沿用已有设置及目录启动参数，未手选模型。显式短测准确返回随机标记，正常结束                                                          | [01 首发](01-fast-agent-real-reply.png)、[测试索引](fast-test-session.json)。模型页诚实显示没有可选模型；本轮没有新认证                                                                                                         |
| fast-agent 冷恢复与续答 | 正常退出后重开，恢复同一 `2610010054-BZNiH6` 的历史；显式发送“只回复 FARFOLD-FAST-RESUME-OK，不要使用工具，不要读取或修改文件。”，实际返回对应标记并完成 | [重启前退出](fast-before-restart-exit.json)、[02 历史恢复](02-fast-agent-cold-restored.png)、[03 续答](03-fast-agent-cold-resume-reply.png)；不自动重发                                                                         |
| Claude 读取选项         | 复用既有 0.81.2 接入程序，连接成功，读到 `Default (recommended)` 模型和 `Default` Effort，未切换选择                                                     | [04 模型](04-claude-models.png)、[运行进程](claude-auth-required-processes.json)、[版本与声明投影](claude-declaration.json)。不是冻结目录 0.84.0 的新安装验收；默认选项不能当具体模型身份                                       |
| Claude 实际短测         | 显式发送一次短消息，返回 `auth_required`，界面进入需要登录，未收到成功回复                                                                               | [05 认证要求](05-claude-request-auth-required.png)、[协议元数据](protocol-metadata-final.json)。新测试 ID 为 `0345eb6b-9406-4dac-ae37-e24e6f03af76`；模型读取不能清除请求认证条件                                               |
| Claude 账号入口         | 现场查看方法只有 `Claude Subscription`、`Anthropic Console`，未选中、未登录、未输入凭据                                                                  | [06 选择框](06-claude-auth-options.png)未捕获原生弹出菜单；现场 AX 与[白名单声明](claude-declaration.json)确认 `claude-ai-login`、`console-login` 均为 typed terminal。旧候选账号限制与本次请求认证要求分别保留                 |
| Kimi 新安装             | 官方目录二进制 1.52.0 安装、候选连接检查和正式连接成功；自动 `session/new` 要求认证，未取得模型选项                                                      | [07 安装后认证要求](07-kimi-installed-auth-required.png)、[启动及声明投影](kimi-registration.json)。实际注册为受管 `kimi` 加 `acp`，不称 initialize-only 或模型可用                                                             |
| Kimi 登录终端及取消     | 显式运行已注册程序的 `kimi login`，PID 39490 及子进程 39496 启动；未填写凭据，点击取消后两身份均结束，原 ACP 连接仍保留                                  | [08 终端](08-kimi-login-started.png)、[精确目标](kimi-login-target.json)、[运行进程](kimi-login-processes.json)、[09 取消](09-kimi-login-cancelled.png)、[取消后核对](kimi-after-cancel.json)。登录成功、模型读取成功与首发未测 |
| 返回原稿                | 结束准备后回到原 Amp 新稿，Medium 保持                                                                                                                   | [10 返回原稿](10-original-amp-medium.png)、[退出字段核对](after-exit.json)。没有把其他 Agent 的默认模型写入原选择                                                                                                               |

fast-agent 的[索引投影](fast-test-session.json)明确为已有设置来源，`model=null`、`thoughtLevel=null`；界面默认模型标签及目录公开 `codexplan` 不能证明实际请求模型或推理等级。首次回复和续答通过只属于该路线及对话。

## 请求与进程目录

[脱敏协议元数据](protocol-metadata-final.json)覆盖两次应用启动的 7 个日志文件：7 次 `initialize`、5 次 `session/new`、1 次 `session/load`、**3 次 `session/prompt`**。三个消息请求分别属于 fast-agent 首发、fast-agent 冷续发、Claude 短测；Kimi 没有消息请求。元数据只保留事件类型、方向、时间、字节数和错误分类；Claude 与 Kimi 的对应返回是协议错误，认证语义结合现场界面判断，不保存错误原文或认证秘密。

[fast-agent 恢复目录](cwd-fast-restored.json)确认实际 Python 进程 PID 38434 在普通对话目录 `conversations`。[Kimi 登录目录](cwd-kimi-login.json)确认 Kimi ACP、登录父子进程，以及本次 Claude Node/SDK 进程均在该目录；正式应用自身在 `/`。[安装期采样](cwd-kimi-install-watch.json)在 Kimi 实际启动前结束，未采到其候选检查进程，因此不据此补写 Kimi 候选阶段目录已验证。未读取完整进程环境或认证文件。

## 数据与退出

相对[起点](data-before.json)的 26 条会话、10 个 Agent 和 19 项设置，以及[原未发字段摘要](unsent-before.json)，[01:07:35 退出核对](after-exit.json)确认：

- 会话索引总数 28，原 26 条核对字段均无变化或缺失；仅新增 fast-agent 成功测试及 Claude 认证失败测试。Kimi 没有新增 Farfold 会话索引，不能据此推定外部没有准备记录。
- 原 10 个 Agent 无变化或缺失，新增 Kimi 的实际注册见[kimi-registration.json](kimi-registration.json)。
- 原未发内容的 `version`、`composers`、`choice`、`feedback`、`queues`、`activity` 均保持。新增测试的数据不被算作原字段变化。
- `installations.v1`、`unsentWork.v1`、`agentSetup.v1` 按本轮安装/测试/准备变化，新增 `installPrevious.registry:kimi`；不声称全部设置不变。
- [累计观察清单](all-observed-processes.json)中的 12 个进程身份（含两次正式应用进程）在退出核对时均已结束。该结论限已观察身份，不扩大为所有瞬时或脱离进程的审计。

未进行全部外部配置或历史正文摘要审计，不以 Farfold 元数据保护核对证明外部数据全量不变。

## 保留的失败与未完成项

fast-agent 前序[uvx 安装失败](../2026-09-30-agent-access-uvx/README.md)及[启动参数候选失败](../2026-09-30-agent-access-startup-options/installed.md)保持原候选归属。本轮沿有效已装入口成功，不消除[两个官方包同名入口竞争](../2026-10-01-agent-access-auth-sequencing/fast-agent-package.json)，也不验证用户明确指定模型的安装路线。

Claude 本轮真实请求仍失败；09-28 的 `account_on_hold` 是旧候选的特定登录结果，本轮没有重新登录，不能将两次错误等同。Kimi 的终端启动、普通取消与声明的恢复能力不代表账号成功、模型可用或历史恢复通过。新账号登录、Kimi 首发/续接、Claude 成功回复、全目录和完整 J1–J6 仍开放。
