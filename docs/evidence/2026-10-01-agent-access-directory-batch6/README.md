# 目录第六批：五项连接、Devin 请求认证要求与 Harn 匿名方法

2026-10-01 04:40–04:53，复用 `d00e2c8` 正式候选检查 Devin、Corust Agent、crow-cli、Harn、Kimchi。五项官方二进制均安装并连接；Devin 读取完成但无可选模型，唯一显式短测要求认证。Harn 的本地匿名方法明确执行一次并完成重查，模型读取仍失败。**没有新增成功回复、真实账号验证或冷恢复结果。**

## 候选与范围

[复用收据](candidate-install.json)指向 04:35:11 的[标签片安装](../2026-10-01-agent-selection-labels/candidate-install.json)，本批未重新打包/复制。`/Applications/Farfold.app` 二进制 SHA-256 始终为 `ff4fbff7295fbf7dfbee3a04f0a1e1bc82fece85c50000e6f21c8c021da51349`。

[起点核对](before-launch.json)的 421 项输入无变化；[04:53:05 退出](after-exit.json)记录测试期间并行修改 5 个认证路由相关生产/测试文件，正式二进制保持相同。因此结果只属于已安装 `d00e2c8`，不声称源码全程冻结，也不把下一片尚未安装的修复计入本批。

[实际目录快照](catalog-targets.json)保留 41 个 ID；本批五项均使用 macOS arm64 `.tar.gz` 分发。目录版本、登记版本和程序自报版本分别记录，不用自报名称或版本差异推定安装错误。

## 实际结果

| 条目         | 安装 / 连接                                                                                 | 模型、账号与请求                                                                                                                                                                                           | 证据                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Devin        | 官方 `3000.11.3`，`install-KtPXzS/bin/devin acp`；自报 `affogato / Devin Agent / 0.0.0-dev` | 模型读取完成、未提供可选模型，界面显示“默认模型”不证明具体模型身份。浏览器和终端两方法可见，未选择。唯一明确短测返回 AuthRequired，转回账号准备，“使用此 Agent”禁用；未登录或重试                          | [登记](devin-registration.json)、[01 读取](01-devin-result.png)/[文本](devin-result.txt)、[菜单 AX](devin-auth-options.txt)、[02 请求认证要求](02-devin-request-auth-required.png)/[文本](devin-request-auth-required.txt)                                       |
| Corust Agent | 官方 `0.6.0`，`install-Y6u6GV/corust-agent-acp`；自报 `corust-acp / 0.1.0`                  | 自动模型读取要求认证；`Login via browser` 入口与 OAuth 说明可见，未点击。模型成功、首发、恢复未测；未声明 loadSession 支持，不将其当实测恢复失败                                                           | [登记](corust-registration.json)、[03 结果](03-corust-result.png)、[文本](corust-result.txt)                                                                                                                                                                     |
| crow-cli     | 官方及自报 `0.1.24`，`install-vptM8N/crow-cli acp`                                          | 模型读取失败，原选择保留，具体原因未知。`No Authentication Required` 声明可见，但对应程序未核实，自动入口禁用；没有点击或 prompt                                                                           | [登记](crow-registration.json)、[04 结果](04-crow-result.png)/[文本](crow-result.txt)、[账号文本](crow-auth.txt)                                                                                                                                                 |
| Harn         | 官方及自报 `0.10.151`，`install-tVNYzZ/harn serve acp`                                      | 初次模型读取失败。明确点击声明的 `Local (no authentication)`（ID `none`、type `agent`）一次，authenticate 返回后连接重查完成；返回模型页仍读取失败。没有输入凭据、发送 prompt 或将匿名完成称为真实账号验证 | [登记](harn-registration.json)、[05 初次失败](05-harn-result.png)/[文本](harn-result.txt)、[方法说明](harn-auth.txt)、[06 匿名方法结果](06-harn-anonymous-method.png)/[文本](harn-anonymous-method-result.txt)、[随后模型仍失败](harn-after-anonymous-model.txt) |
| Kimchi       | 官方及自报 `1.3.0`，`install-UiTDqa/bin/kimchi --mode acp`                                  | 自动模型读取要求认证。`Kimchi Login`、`Kimchi Login (US)`、`Log in from terminal` 三方法可见，未选择/执行；“退出登录”入口可见但未点击。没有模型成功、消息或恢复验证                                        | [登记](kimchi-registration.json)、[07 结果](07-kimchi-result.png)/[文本](kimchi-result.txt)、[菜单 AX](kimchi-auth-options.txt)                                                                                                                                  |

菜单结论以 Devin/Kimchi 当时的实时 AX 为准；系统菜单浮层不保证出现在截图中，不将只显示选择器的截图当菜单全项证据。

Devin 的固定测试标记为 `FARFOLD-e48c6f7a-2d42-40ee-9ceb-866e0fff57ce`，失败测试 native ID 为 `hulking-plough`，见[动作记录](progress.json)和[新增索引核对](after-exit.json)。实际结果要求认证，未得到成功回复。Harn 的一次 authenticate 与后续重查只证明该匿名声明操作返回；不能从方法名称或连接成功推定模型/账号/请求可用。crow 的禁用原因只记录界面事实，本片没有据此补猜具体旧声明或绕过保护。

## 数据、协议与退出

[原数据基线](data-before.json)为 31 条会话、28 个 Agent、37 项设置。[退出核对](after-exit.json)保留全部原索引、原启动字段和全部原未发字段（version、composers、choice、feedback、queues、activity）。只新增 Devin 失败测试索引和五项 Agent 登记，最终为 **32 条会话、33 个 Agent、42 项设置**，见[计数](batch-counts.json)。变化设置为 `installations.v1`、`unsentWork.v1`、`agentSetup.v1`，新增五个对应 `installPrevious.*`；不将允许变化写成全部设置逐字未变，也不声称外部配置全面无写入。

[协议元数据](protocol-metadata-final.json)共 12 文件，记录 12 次 initialize、7 次 session/new、1 次 session/prompt、1 次 authenticate。唯一 prompt 属于 Devin，唯一 authenticate 属于 Harn。管理页自动读取模型并在 Harn 操作后重查，不能写成 initialize-only；连接或正常返回不等于成功回复。结束前回到原 Amp / Medium 空稿，见[08 截图](08-original-draft.png)/[原稿文本](original-draft.txt)。

[累计观察](all-observed-processes.json)中的 **25 个 PID + 启动时间身份**在 [04:53:05 退出](after-exit.json)时均已结束；这只证明已采样身份，不声称完整捕获所有瞬时进程。目录采样见 [Devin](cwd-devin-install.json)、[Corust](cwd-corust-install.json)、[crow](cwd-crow-install.json)、[Harn](cwd-harn-install.json)、[Kimchi](cwd-kimchi-install.json)及[最终 Agent](cwd-final-agents.json)；安装检查与已连接进程分开观察，没有读取进程环境。

重复应用清理沿用[标签片精确删除证明](../2026-10-01-agent-selection-labels/duplicate-removal.json)，本批没有新打包产物或删除应用。

## 保留缺口

Devin、Corust、Kimchi 仍需合适账号条件下的模型/真实请求；crow 和 Harn 的模型读取失败原因仍未定位，crow 自动方法目标尚未核实。五项都没有成功首发或恢复/续答，本批也没有填入新凭据。

[41 条覆盖表](coverage.md)更新为 **37 行已有部分执行、4 行尚无安装/连接执行结果**，其余为 `mistral-vibe`、`poolside`、`stakpak`、`vtcode`。标签片已经验证的 GLM 同名区分、Codex 当前/原记录说明与 OpenCode 正常弹层仍引用[其独立安装结果](../2026-10-01-agent-selection-labels/installed.md)；不覆盖 GLM 旧缺 Key 失败或 Codex 原模型/推理漂移失败。
