# 目录第七批：最后四项安装连接与 VT Code 请求失败

2026-10-01 05:04–05:17:53，复用 `26e9592` 正式候选检查 Mistral Vibe、Poolside、Stakpak、VT Code。四项官方二进制均安装并连接；前三项自动模型读取要求认证，未登录。VT Code 读取完成但未提供可选模型或登录声明，唯一显式短测失败，未得到成功回复，原因未知。**至此 41 个目录 ID 都有部分执行证据，不能据此宣称全部可用或完整上市验收通过。**

## 候选与范围

[复用收据](candidate-install.json)指向 04:55:56 的[认证拒绝原因片安装](../2026-10-01-agent-auth-route-diagnostics/candidate-install.json)，本批没有重新打包或复制应用。`/Applications/Farfold.app` 二进制 SHA-256 为 `acb5a5be5f2c1680e1086715df1fc8eecd89ede877022157d13d18b5b4f6eec6`。

[起点](before-launch.json)核对 422 项输入无变化；实际应用 PID `91714` 于 05:04:15 启动，见[目录采样](cwd-vibe-install.json)。[05:17:53 退出](after-exit.json)记录并行修改八个启动诊断相关生产/测试文件，正式二进制保持相同。因此本批只属于已安装 `26e9592`，不声称源码全程冻结，也不把下一片启动诊断计入实测。

[实际目录快照](catalog-targets.json)为 41 个唯一 ID；本批四项均使用 macOS arm64 `.tar.gz` 分发。目录版本、登记版本和自报版本分别记录，不从名称或版本差异猜测运行故障。

## 实际结果

| 条目         | 安装 / 连接                                                                                   | 模型、账号与请求                                                                                                                                                                                                | 证据                                                                                                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mistral Vibe | 官方及自报 `2.25.8`，`install-PUTVka/vibe-acp`，无基础参数；安装/连接通过                     | 自动模型读取要求认证。仅展开账号菜单，`Sign in through Mistral AI Studio` 与 `Register your API Key` 可见，未选择或执行；未读到模型、未发消息                                                                   | [登记](vibe-registration.json)、[01 结果](01-vibe-auth-required.png)/[文本](vibe-result.txt)、[菜单 AX](vibe-auth-options.txt)                                                                                                                                                                  |
| Poolside     | 官方及自报 `1.0.16`，`install-20famu/pool-darwin-arm64 acp`；安装/连接通过                    | 自动模型读取要求认证。`Log in to Poolside`、`pool login` 说明和终端登录入口可见，未打开；没有登录、模型成功或请求结果                                                                                           | [登记](poolside-registration.json)、[02 结果](02-poolside-result.png)、[文本](poolside-result.txt)                                                                                                                                                                                              |
| Stakpak      | 官方及自报 `0.3.88`，`install-htLCVx/stakpak acp`；安装/连接通过                              | 自动模型读取要求认证。`Login to Stakpak` 与浏览器登录说明可见，未点击或打开浏览器；未读到模型、未发消息                                                                                                         | [登记](stakpak-registration.json)、[03 结果](03-stakpak-result.png)、[文本](stakpak-result.txt)                                                                                                                                                                                                 |
| VT Code      | 目录/登记 `0.96.14`，自报 `vtcode / Zed / 0.96.12`；`install-4ujdqW/vtcode acp` 安装/连接通过 | 读取完成、未提供可选模型；`Thought level` 显示 `none`，未更改。没有 `authMethods`，账号页明确没有声明登录方式。唯一短测显示请求未完成，对话中有计划事件但没有目标标记的成功回复；失败原因未知，未重试或配置账号 | [登记](vtcode-registration.json)、[04 读取](04-vtcode-result.png)/[文本](vtcode-result.txt)、[账号 AX](vtcode-auth.txt)、[05 请求失败](05-vtcode-request-incomplete.png)/[文本](vtcode-request-result.txt)、[06 测试对话](06-vtcode-test-conversation.png)/[文本](vtcode-test-conversation.txt) |

VT Code 的唯一固定标记为 `FARFOLD-ad55be56-425c-46f2-8ec5-b08bea898525`，失败测试 native ID 为 `vtcode-zed-session-0`，见[动作记录](progress.json)及[退出索引核对](after-exit.json)。未提供可选模型只说明没有模型选择项，不能证明最终具体模型；计划或更新事件也不等于成功回复。没有据此推定缺 Key、版本不匹配或其他原因。

## 数据、协议与退出

[原数据基线](data-before.json)为 32 条会话、33 个 Agent、42 项设置。[退出核对](after-exit.json)保持全部原索引、原启动字段和全部原未发字段（version、composers、choice、feedback、queues、activity）。仅新增 VT Code 失败测试索引与四项登记，最终为 **33 条会话、37 个 Agent、46 项设置**，见[计数](batch-counts.json)。变化设置为 `installations.v1`、`unsentWork.v1`、`agentSetup.v1`，新增四个对应 `installPrevious.*`；不将这些变化写成全部设置逐字不变，也不声称外部配置全面无写入。

[协议元数据](protocol-metadata-final.json)共九个文件，记录九次 initialize、五次 session/new、一次 session/prompt、零次 authenticate。唯一 prompt 属于 VT Code。五条 stderr 字节标记不包含正文，不能用来猜测失败原因；安装检查、管理页自动模型读取和短测分开记录，不能称为 initialize-only。结束前回到原 Amp / Medium 空稿，见[07 截图](07-original-draft.png)/[原稿 AX](original-draft.txt)。

[累计观察](all-observed-processes.json)中的 **八个 PID + 启动时间身份**在 [05:17:53 退出](after-exit.json)时均已结束；仅证明已采样身份，不声称捕获全部瞬时进程。目录采样见 [Mistral Vibe](cwd-vibe-install.json)、[Poolside](cwd-poolside-install.json)、[Stakpak](cwd-stakpak-install.json)、[VT Code 安装](cwd-vtcode-install.json)及[VT Code 短测](cwd-vtcode-test.json)；安装检查与已连接进程分开观察，未读取进程环境。

重复应用清理沿用[认证拒绝原因片的精确删除证明](../2026-10-01-agent-auth-route-diagnostics/duplicate-removal.json)，本批没有新打包产物或应用删除。

## 保留缺口

Mistral Vibe、Poolside、Stakpak 仍需合适账号条件下的模型读取、真实请求及恢复；本批未输入凭据、执行认证或确认账号成功。VT Code 的真实请求失败原因保持未知，未从包版本、自报名称或短错误反推原因。

[41 条覆盖表](coverage.md)更新为 **41 行都有部分真实执行证据，零行尚无安装/连接执行结果**。历史 Grok、Factory Droid、Junie、Minion 等安装检查失败仍保留；kilo、sigit 的 npx 分发、新登录/Key 交付、完整首发/恢复和 J1–J6 仍有缺口。失败计作已执行，不计作已通过；此前不同候选的成功也不合并成一次完整验收。
