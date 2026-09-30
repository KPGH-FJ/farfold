# 目录第二批：五个 npx 条目

2026-10-01 01:37–01:52，复用正式安装版验证 Auggie、Codebuddy Code、DeepAgents、Autohand、Agoragentic。五项均完成包安装、候选连接检查及登记后的连接；认证和模型阶段结果各不相同。本批没有登录成功，唯一一次消息请求由 DeepAgents 发出并失败，没有新增成功回复。

## 安装身份与源码边界

正式应用 `/Applications/Farfold.app` 来自提交 `38c6ba9224171053a6d5296dcab042d3a880c2d9`，可执行文件 SHA-256 为 `d3b201ca3de10fbdb6763c944a9313ae414ef6cf2c4fb44dfff773f56c01a0b2`。本批复用 01:31:23 安装，当时的复制比对和签名检查通过；01:37 记录复用起点，没有重新安装，见[安装收据](candidate-install.json)与[上片安装](../2026-10-01-agent-startup-errors/candidate-install.json)。

[源码清单](candidate-source.json)记录 403 个输入。操作期间 `src-tauri/src/installations.rs` 与 `src-tauri/src/installations/uninstall_history_tests.rs` 已变化，[退出核对](after-exit.json)仍确认正式二进制 SHA 相同。因此本批结果属于上述已安装二进制，**不能声称操作期间源码一致，也不能作为新安装历史修复的安装验收**。

## 五项实际结果

下表包版本来自受管安装收据；握手自报版本另列，不互相替代。五项均使用既有 Node 22.22.3，未升级日常程序。完整历史覆盖见[41 条汇总](coverage.md)。

| 条目           | 实际安装 / 连接                                                              | 账号操作                                                                         | 模型与请求                                                                              | 证据                                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auggie         | `@augmentcode/auggie@0.36.0` 安装及连接通过；自报 `0.36.0 (commit 7c61e5bb)` | 需要登录；官方终端启动与取消回收通过，未输入凭据、未登录                         | 创建对话被认证要求阻塞，未读到模型；消息与恢复未测                                      | [登记](auggie-registration.json)、[01 认证要求](01-auggie-auth-required.png)、[03 取消](03-auggie-login-cancelled.png)                                                                                        |
| Codebuddy Code | `@tencent-ai/codebuddy-code@2.160.0` 安装及连接通过；未提供 `agentInfo`      | 4 种方法可见，未选择或执行                                                       | 创建对话被认证要求阻塞，未读到模型；消息与恢复未测                                      | [登记](codebuddy-registration.json)、[方法](codebuddy-auth-options.txt)、[05 认证要求](05-codebuddy-auth-required.png)                                                                                        |
| DeepAgents     | `deepagents-acp@0.1.7` 安装及连接通过；自报 `0.0.1`                          | 方法可见，未执行；环境 Key 声明归一化存在静态确认的信息丢失缺口                  | 创建对话成功，但没有可选模型，实际模型/推理未知；显式短测请求**失败**，无回复；恢复未测 | [登记](deepagents-registration.json)、[06 模型页](06-deepagents-model-state.png)、[07 请求失败](07-deepagents-request-failed.png)、[08 对话](08-deepagents-test-thread.png)、[静态调查](deepagents-static.md) |
| Autohand       | `@autohandai/autohand-acp@0.2.1` 安装及连接通过；自报 `0.2.1`                | 声明缺少 Autohand CLI；声明的全局 npm 安装命令未能确认目标，自动按钮禁用，未执行 | 创建对话失败，未读到模型；消息与恢复未测                                                | [登记](autohand-registration.json)、[09 缺程序与禁用入口](09-autohand-missing-program.png)                                                                                                                    |
| Agoragentic    | `agoragentic-mcp@1.3.0` 安装及连接通过；自报 `2.0.0`                         | 未声明认证方法，未执行账号动作                                                   | 创建对话/模型读取**失败**，具体原因未知；消息未测；未声明历史读取能力，未实测恢复       | [登记](agoragentic-registration.json)、[10 读取失败](10-agoragentic-connection-result.png)                                                                                                                    |

Auggie 的自动登录实际使用当前登记的绝对 Node 程序和同一个受管 `augment.mjs`，仅把 `--acp` 换成 `login`。登录进程 `46475` 的精确参数见[目标核对](auggie-launch-targets.json)；[启动时收据](auggie-login-processes.json)记录其存在，[取消后](auggie-after-cancel.json)该身份已消失，原 Auggie、Amp 与应用进程仍在。此结果证明启动/取消路径，不证明账号设置未改变或登录成功。

Autohand 的已装连接程序与其声明要求的伴随 CLI 分开记录；前者安装成功不等于后者已存在。没有运行声明中的全局安装命令，也没有按说明文本补造另一个安装命令。

DeepAgents 的[协议元数据](protocol-metadata-final.json)只保留请求类别、错误类别和字节数。其 `session/new` 成功，唯一一次 `session/prompt` 收到协议错误；没有异常原文、错误码或服务状态码，**不能归因为缺 Key、401、余额、模型或缺依赖**。[静态调查](deepagents-static.md)确认环境 Key 类型/公开字段被当前 Rust schema 归一化丢失，以及已装包的默认与加载路径；这些静态事实不替代本次运行归因，也未验证任何认证动作。

## 请求、原稿与保护范围

[批次统计](batch-counts.json)与[协议元数据](protocol-metadata-final.json)共 11 个协议文件、11 次 `initialize`、6 次 `session/new`、**1 次 `session/prompt`**。这一次仅属于 DeepAgents 的失败短测；其他四项和原 Amp 均未发消息。方法显示、终端启动、连接成功或模型页面可见均未记成登录/首发成功。

[原稿截图](11-original-amp-draft.png)确认返回原 Amp／Medium 空稿，沿用已有设置。它不是本批的成功消息、历史续答或新账号验证。

[操作前基线](data-before.json)为 28 条会话索引、11 个 Agent、20 项设置；[退出收据](after-exit.json)与[批次统计](batch-counts.json)为 **29 条索引、16 个 Agent**：新增仅 DeepAgents 失败测试索引和上述五项登记，原 28 条索引所核字段及原 11 个 Agent 的启动字段均保持。原未发内容的 version、composers、choice、feedback、queues、activity 所核字段均未变，见[未发基线](unsent-before.json)。

设置并非全部不变：`installations.v1`、`unsentWork.v1`、`agentSetup.v1` 摘要变化，新增五项 `installPrevious.*`；这些变化与新安装/测试分别记录，不抹去原稿字段保持的核对边界。外部 Agent 配置、凭据和全部缓存未作全面摘要审计。

[累计观察](all-observed-processes.json)包含 13 个带启动时间和程序身份的进程，退出后均已结束；此结论限于观察到的身份，不声称覆盖所有瞬时子进程。各次工作目录观察见 [Auggie 安装](cwd-auggie-install.json)、[Auggie 登录](cwd-auggie-login.json)、[Codebuddy](cwd-codebuddy-install.json)、[DeepAgents](cwd-deepagents-install.json)、[Autohand](cwd-autohand-install.json)、[Agoragentic](cwd-agoragentic-install.json)，未采到的进程目录保留未知。

## 尚未完成

本批五项均未完成新账号登录和完整首发/恢复旅程。Auggie、Codebuddy 仍需可用账号；Autohand 需官方伴随程序准备出口；DeepAgents 需保真处理声明并独立定位真实请求失败；Agoragentic 需定位模型读取失败。升级、卸载、其他服务、工具/审批/停止及全部 J1–J6 未在局部安装成功中自动通过。

本文件仅整理已有收据、截图和静态调查，没有新增安装、网络、登录、Agent 请求或程序执行。
