# 目录第五批：四项接入、Junie 早退与 Cortex 缺连接请求

2026-10-01 04:07–04:22，复用 `0a725e0` 正式候选检查 GitHub Copilot、Google Antigravity、Junie、Cortex Code、Cursor。四项安装并连接，Junie 在连接检查完成前结束且未登记。唯一 Cortex 短测返回缺少 Snowflake 连接的错误，没有成功回复；没有执行登录或配置命令。

## 候选与目录

`/Applications/Farfold.app` 二进制 SHA-256 为 `f70ed0a4b01090a0e41220b23b105c712bb4ef43394d1d86c6384fe28b0f34f5`。[本批复用收据](candidate-install.json)指向 03:50:02 的[原安装核对](../2026-10-01-agent-config-categories/candidate-install.json)，没有重新复制、签名或打包。

[开始](before-launch.json)无源码变化，[退出](after-exit.json)记录工作区并行修改六个标签相关生产文件及两个测试文件；正式二进制始终相同。结果属于已安装的 `0a725e0`，不声称 420 个输入全程冻结，也不把尚未打包的标签修复计入本次界面能力。

[实际目录](catalog-targets.json)缓存取得于 04:07:45、观察于 04:08:14，仍为相同 41 个 ID。本批按真实包、登记与自报版本分别记录，不改目录声明、外部包、依赖或账号配置制造通过。

## 实际结果

| 条目               | 安装与连接                                                                                           | 模型 / 账号 / 请求                                                                                                                       | 证据                                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Copilot     | `@github/copilot@1.0.89` 安装/连接通过，`install-UPmD8l`；自报 `Copilot@1.0.89`                      | 模型读取完成但未提供可选模型；`Log in with Copilot CLI` 可见，因未核实声明对应程序而禁用。未选择、登录或发送消息                         | [登记](copilot-registration.json)、[01 模型](01-copilot-model-result.png)、[02 账号](02-copilot-auth-options.png)、[现场文字](copilot-auth.txt)、[只读诊断](copilot-auth-diagnosis.md)                     |
| Google Antigravity | 官方 `1.2.1` arm64 ZIP 安装/连接通过，`install-E3Lwrl`；自报 `antigravity-acp@1.2.1`                 | 自动模型读取要求认证；四种账号方式可见，未选择/执行。模型成功、首发和恢复未测                                                            | [登记](antigravity-registration.json)、[03 认证要求](03-antigravity-result.png)、[结果文字](antigravity-result.txt)、[账号菜单](antigravity-auth-options.txt)                                              |
| Junie              | 官方目录 `3419.24.0` arm64 ZIP，包内 app 入口带 `--acp=true`；连接检查提前结束，未登记、候选目录回收 | 显示“连接在检查完成前结束，请检查程序后重试”，安装按钮恢复。认证、模型、消息和恢复未测；权限/目录布局/系统依赖原因未知                   | [04 失败](04-junie-startup-failed.png)、[结果文字](junie-result.txt)、[无登记/目录](junie-registration.json)、[只读诊断](junie-startup-diagnosis.md)                                                       |
| Cortex Code        | 官方目录 `1.0.73` arm64 `.tar.gz` 安装/连接通过，`install-5mxPQh`；自报 `Cortex Code@1.0.0`          | 模型读取完成但未提供可选模型，未声明登录方式。唯一显式短测返回 `No Snowflake connection available`，未完成标记验证；没有重试或按提示配置 | [登记](cortex-registration.json)、[05 模型](05-cortex-model-result.png)、[06 账号](06-cortex-auth-declaration.png)、[07 请求失败](07-cortex-request-failed.png)、[实际结果文字](cortex-request-result.txt) |
| Cursor             | 官方目录 `2026.09.28` arm64 `.tar.gz` 安装/连接通过，`install-8Z7ZWI`；未返回 `agentInfo`            | 自动模型读取要求认证；`Cursor Login` 入口可见，未点击/输入。模型成功、首发和恢复未测                                                     | [登记](cursor-registration.json)、[08 认证要求](08-cursor-result.png)、[结果文字](cursor-result.txt)                                                                                                       |

Copilot 的程序对应关系仍需核实，不能直接忽略保护调用普通认证或按 description 拼命令；[诊断](copilot-auth-diagnosis.md)只核对了官方 npm 启动器与平台程序的公开关系，尚未拿到本次真实方法的执行字段。Antigravity 菜单为 Google、Gemini Enterprise、Gemini API key、Gemini Enterprise Agent Platform，选择入口不等于这四条服务路线已实现或账号成功。Cursor 没有自报版本，不以目录版本补写 `agentInfo`。

Junie 的现有协议元数据没有完整 initialize 响应；候选已回收，未保留实际 ZIP、加载器诊断或退出码。静态声明与解包方式一致不能替代实际包检查，尤其不能从 app 后缀或固定失败文案推断 Java 缺失。

Cortex 的失败测试 native ID 为 `cad90443-4bd2-4d5a-bec8-9e39c6dd9bf4`，发送的是通过界面明确点击的固定短消息，要求仅回复 `FARFOLD-bfe69949-836c-4b1f-b657-7be451d926b3`、不用工具、不读写文件。实际返回缺少 Snowflake 连接并提示官方交互/配置路径；本轮没有执行该提示、读取配置或填写凭据。协议 prompt 返回正常响应不等于业务成功，界面保留失败结果，没有第二次请求。

## 数据、协议与退出

[操作前](data-before.json)为 30 条会话索引、24 个 Agent、33 项设置。[退出后](after-exit.json)原 30 条索引、原 24 份 Agent 启动配置和全部原未发字段（version、composers、choice、feedback、queues、activity）均不变；只新增 Cortex 失败测试索引和上述四项 Agent，共 31 条索引、28 个 Agent，见[计数](batch-counts.json)。设置变化为 `installations.v1`、`unsentWork.v1`、`agentSetup.v1`、`conversationReadState.v1`，并新增对应四项 `installPrevious.*`。这不构成外部配置或凭据全面审计。

[协议元数据](protocol-metadata-final.json)共 10 文件、10 次 initialize、5 次 session/new、1 次 session/prompt、0 次 authenticate。唯一 prompt 属于 Cortex，其余四项没有消息请求。本轮管理页自动读取了模型，不能写成 initialize-only；未打开认证终端。原 Amp / Medium 空稿已返回，见[09 原稿](09-original-draft.png)，不计作新成功回复或历史恢复。

[累计观察](all-observed-processes.json)中的 **9 个 PID+启动时间身份**在 04:22:56 [退出核对](after-exit.json)中均已结束。范围仅限实际采到的身份，不声称捕获所有瞬时进程。工作目录采样见 [Copilot](cwd-copilot-install.json)、[Antigravity](cwd-antigravity-connected.json)、[Junie](cwd-junie-install.json)、[Cortex](cwd-cortex-connected.json)、[Cursor](cwd-cursor-connected.json)；Junie 采样未命中实际 Junie 进程，不能据此确定其 cwd。没有读取进程环境。

重复 Farfold 应用的精确清理沿用[原安装片](../2026-10-01-agent-config-categories/installed.md)，本批没有重新打包或删除应用。

## 保留缺口

五项均无登录成功、成功首发或冷恢复/续答。Copilot 还需核实官方登录目标；Antigravity、Cursor 需可用账号条件；Cortex 需用户明确完成官方 Snowflake 连接路线后重试；Junie 的检查早退仍需定位。没有以模型读取完成、空选项或菜单可见代替可用结论。

[41 条覆盖表](coverage.md)现在为 **32 行有部分执行、9 行尚无安装/连接执行结果**，失败也计已执行，不能将 32 行称为全流程通过。下一组无执行结果的 ID 为 `corust-agent`、`crow-cli`、`devin`、`harn`、`kimchi`、`mistral-vibe`、`poolside`、`stakpak`、`vtcode`；本批文档没有再安装或运行这些条目。
