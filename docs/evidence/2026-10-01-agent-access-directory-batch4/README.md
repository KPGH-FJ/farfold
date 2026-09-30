# 目录第四批：四项接入、启动早退与缺 Key 请求

2026-10-01 03:16–03:32，复用 `959fc00` 正式候选检查 GLM Agent、Grok Build、MiniMax Code、Nova、siGit Code。四项安装并连接，Grok 在连接检查完成前退出。本批唯一 GLM 短测失败，没有新登录成功或成功回复。

## 候选与目录

`/Applications/Farfold.app` 二进制 SHA-256 为 `6f66b86187a70d21a75f6b76baead0e6a27a0a85dc45807a1d189202b53f6226`，本批[复用收据](candidate-install.json)指向 02:41:26 的[原安装核对](../2026-10-01-agent-auth-declarations/candidate-install.json)，没有重新复制、签名或打包。

[开始](before-launch.json)与[退出](after-exit.json)列出工作区同时开发多配置类别修复的源码/测试变化；正式二进制保持相同。因此本批结果属于已安装的 `959fc00`，不声称 411 个源文件全程冻结，也不验证尚未打包的修改。

[实际目录](catalog-targets.json)取得于 03:16:34，仍是相同 41 个 ID。本批按实际包/二进制版本记录，没有改外部包、目录声明或用户账号配置来制造通过。

## 实际结果

| 条目         | 安装与连接                                                                       | 模型 / 账号 / 请求                                                                                                                         | 证据                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GLM Agent    | `glm-acp-agent@1.13.0` 安装/连接通过，`install-4Svtv0`                           | 自动读到 GLM-5.3 / Thinking Max，未手选；两个同名账号选项均未执行。唯一一次显式短测返回缺少 API Key 错误，无成功回复                       | [登记](glm-registration.json)、[01 模型](01-glm-models.png)、[菜单](glm-auth-options.txt)、[06 请求失败](06-glm-request-failed.png)、[实际结果文本](glm-request-result.txt) |
| Grok Build   | `@xai-official/grok@1.0.45` 连接检查提前结束；未登记、无候选目录                 | 显示“连接在检查完成前结束，请检查程序后重试”，安装按钮恢复、使用禁用、0 份安装。未重试；认证、模型、消息与恢复未测                         | [02 失败](02-grok-startup-failed.png)、[无登记/目录](grok-registration.json)、[安装观察](grok-installing.json)                                                              |
| MiniMax Code | `@minimax-ai/code@0.2.7` 安装/连接通过，`install-jp9GJE`                         | 自动模型读取要求认证；标准 Terminal `Sign in to MiniMax Code` 入口可见，未点击、未输入。模型成功、首发与恢复未测                           | [登记](minimax-registration.json)、[03 认证要求](03-minimax-auth-required.png)                                                                                              |
| Nova         | `@compass-ai/nova@1.1.49` 安装/连接通过，`install-HBbl5q`；自报 `kore-cli@1.0.0` | 自动模型读取要求认证；标准 Terminal `Nova Setup` 可见，未点击/配置。包发行与自报身份分别记录；模型成功、首发与恢复未测                     | [登记](nova-registration.json)、[04 认证要求](04-nova-auth-required.png)                                                                                                    |
| siGit Code   | 官方 1.5.11 arm64 `.tar.gz` 二进制安装/连接通过，`install-FtVLs2`；npx 未测      | 模型读取通过，显示 `Qwen 2.5 3B – 32K ct…` 截断标签，未手选/发送；浏览器授权说明与登录入口可见，未点击。未证明本地模型、账号或实际请求可用 | [登记](sigit-registration.json)、[05 模型](05-sigit-models.png)、[账号页文本](sigit-auth.txt)                                                                               |

GLM 的缺省 Agent 方法 `z-ai-api-key` 与旧 `env_var` 方法 `z_ai_api_key` 同名，公开变量名为 `Z_AI_API_KEY`。实际菜单两项均显示 `Z.AI API key`，选择前不易区分，见[界面问题](glm-account-labels.md)。本轮没有运行任一方法或配置 Key；保真识别旧声明不等于支持其凭据交付。短测的缺 Key 原因来自实际回复与协议错误，不是从方法名或静态代码猜测。失败测试 native ID 为 `83c831d8-428a-43e9-a78f-374313f9b9ca`；没有按错误文本执行设置命令。

Grok 只有提前结束这一已测事实；stderr 字节数不提供精确异常原因，不推断是账号、版本或依赖问题。MiniMax 安装采样中观察到 node-gyp、Python、make/clang 后代，只证明这次安装实际经过这些进程，不推成所有设备都必需的依赖清单。

## 数据、协议与退出

[操作前](data-before.json)为 29 条会话索引、20 个 Agent、29 项设置。[退出后](after-exit.json)原索引所核字段、原启动配置和全部原未发字段（composers、choice、feedback、queues、activity）均不变；新增上述 GLM 失败测试后共 30 条索引，新增 GLM、MiniMax、Nova、siGit 四个 Agent 后共 24 个，见[计数](batch-counts.json)。设置变化为 `installations.v1`、`unsentWork.v1`、`agentSetup.v1`、`conversationReadState.v1`，并新增对应四项 `installPrevious.*`。这不是外部配置或凭据的全面审计。

[协议元数据](protocol-metadata-final.json)共 10 文件、10 次 initialize、5 次 session/new、1 次 session/prompt、0 次 authenticate。管理页实际自动读取模型，不能写成 initialize-only。唯一 prompt 属于 GLM；其余四项没有消息请求。本轮未运行认证终端。原 Amp / Medium 空稿已返回，见[07 原稿](07-original-draft.png)，不计作新对话回复或恢复成功。

[累计观察](all-observed-processes.json)的 **23 个 PID+启动时间身份**在 03:32:31 [退出核对](after-exit.json)中均已结束。进程汇总第一次断言把同一 PID/启动时间的程序标题变化误作 PID 复用；辅助脚本修正后保留所有观察标题，原始采样未改，见[取证说明](process-observation-notes.md)。结论仅覆盖采到的身份，不声称捕获所有瞬时子进程。工作目录记录见[GLM](cwd-glm-install.json)、[Grok](cwd-grok-install.json)、[MiniMax](cwd-minimax-install.json)、[Nova 补采](cwd-nova-completion.json)、[siGit](cwd-sigit-install.json)，未读取进程环境。

重复 Farfold 应用的删除证明沿用[原安装片](../2026-10-01-agent-auth-declarations/duplicate-cleanup.json)，本批没有重新打包或删除。

## 保留缺口

五项均无登录成功、成功首发或冷恢复/续答。GLM 需要真实可用的官方账号/服务路线并改善同名方法辨识；MiniMax、Nova 仍需认证；siGit 还须真实请求确认；Grok 仍需定位早退及明确重试。下一片源码修改不能关闭这些安装版结果。[41 条覆盖表](coverage.md)现为 27 行有部分执行、14 行尚无安装/连接结果，失败也计已执行；[余下目录材料](remaining-directory.md)只作静态准备，不计实测或另建计划。
