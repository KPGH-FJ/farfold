# 真实 OpenCode Messages 探针：执行前独立审查

结论：**当前冻结版本可交根任务执行已授权的真实探针，未发现剩余确定阻断。** 本审查仅阅读源码、官方固定 schema 与作者已有检查收据，并核对文件摘要；没有启动 OpenCode、执行 SDK、自测或真实请求。结论不代表 Messages 已可用，也不代替安装版验收。

## 审查身份与修正

审查对象为 [最终冻结清单](actual-opencode-messages-source-final.json)（2026-10-01T02:02:53Z）的四个 Python 文件及[执行范围](actual-opencode-messages-plan.md)。五个当前文件的实际 SHA-256 均与清单一致；主脚本为 `328c3db6acee39dd4a1a3c31ea3b4973567e9de8e5d28745f0c8af406f403b77`，HTTP 夹具为 `6e8126235030ce179167108c54f01b222083ebd6c819aee0215c372aff682ca4`。

首版存在请求时序和结果归类缺口：初始化期间的未知路径请求可能漏计，提前收到的覆盖值可能被后续 prompt 拒绝误当反例成功，最终判定也未强制自动请求及处理异常为零。另有 JSON 数组未归类为处理异常、观测记录缺总量上限。当前版本已逐项关闭：

- [主脚本](actual-opencode-messages-probe.py)在启动及初始化之前记录计数；正例和每项反例均在准备完成后的观察窗口要求请求数不变、无错误/超限、无未完成连接，才允许显式 prompt。
- [HTTP 夹具](actual_opencode_messages_fixture.py)在路径拒绝前记录是否处于允许请求阶段，未知路径也计入自动请求；合法 JSON 非对象计固定处理异常。总请求/记录上限 32，同时处理连接上限 16，正文、头和读写等待另有界限。
- 反例分类要求准备阶段检查成功、已明确派发 prompt、观测均来自允许阶段；错误 API 路径只使用显式阶段计数。初始化失败、选项失败或超时不算预期拒绝。拒绝仅记录其发生阶段，不能推定某个 SDK 异常。
- 最终计数在监听关闭后读取；总成功强制 `automaticRequests`、`httpHandlerErrors`、`httpLimitExceeded` 全为零，并要求进程/监听/任务目录收尾确认。模型对象中的人为 context/output 限额已移除。

[时序红例](actual-opencode-messages-timing-red.json)保留 11 项中 10 项失败、1 项回收通过的原结果。[最终无 Agent 自测](actual-opencode-messages-selftest-timing-final.json)退出 0，33 项检查通过（HTTP/SSE 9、阶段与超时 10、时序与总判定 14）；`agentStarted=false`。审查已核对相应[阶段测试](actual_opencode_messages_selftests.py)和[时序测试](actual_opencode_messages_timing_selftests.py)，没有重复运行。

## 可验证范围

受控地址只监听 loopback，A/B 使用独立路径和无价值 canary。实际脚本继承 HOME/普通环境，只在本次进程交付 inline 配置和 canary；不读取用户配置、Keychain、正式数据库或原始日志。协议与 HTTP 内容仅在内存作有界比较，报告保留固定标签、布尔和计数，不落正文、动态错误、会话 ID、头值或环境值。

纯文本 SSE 的事件顺序、usage 与结束字段符合固定官方 [Anthropic 3.0.111 schema](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.111/packages/anthropic/src/anthropic-messages-api.ts#L971)。现有自测仅证明夹具和自有接收器；官方 SDK 实际接受这些流式帧仍须本次真实运行确认。

总执行 deadline 在报告内部保留 partial 行；关闭独立有界，TERM/KILL 请求与实际 wait、进程组为空分别记录。只在全部受跟踪进程组确认结束且原目录身份一致时删除本次精确目录，否则保留。此收据只证明直接子进程及其进程组，不证明脱离这些组的全部后代。

实际结果应继续分开记录正例、七项反例完成情况与预期匹配，不能用行数或总退出码替代逐项观察。新建/冷加载必须核对实际模型及全部既有 model/thought_level 选项，冷恢复不重选模型；实际请求还须核对各来源路径、Key、模型、流式正文及本来源历史 receipt。

这不是进程级网络沙箱，不能证明任意用户插件或后合入策略都受控；Agent 仍可能自行读取其正常配置并保存测试历史。七项 inline 对象反例也不是磁盘配置深合并或真实用户冲突的实测。真实 Agent 请求、正式安装版服务交付以及跨全部配置层的隔离均不在本审查的已验证结论内。
