# 安装验证：安全启动诊断与失败候选回收

2026-10-01 05:49–06:00（UTC+8）。正式 `/Applications/Farfold.app` 候选 `5b831c0` 已完成 Junie、Minion 各一次明确重试、诊断预览与导出、原 Amp 原稿返回及退出核对。两项仍连接失败，**本片验证的是安全事实保留与回收，不是失败原因已定位或 Agent 已可用**。

## 候选身份

[安装收据](candidate-install.json)记录 05:49:15 安装，二进制 SHA-256 为 `39fecabd3456df42f5308a81f31e7348e6a3f63df862636a1cbedeea9431ff73`；四个候选文件与正式安装完全匹配，签名校验退出 0。[安装前核对](before-launch.json)至 06:00:28 的[最终退出收据](after-exit.json)，[428 项输入](candidate-source.json)无变化，正式二进制摘要一致。后续 Copilot 源码工作不属于本片安装观察期间。

## 实际结果

版本与安装路线以本次[目录快照](catalog-targets.json)为准。最后摘要来自[最终安全协议元数据](protocol-metadata-final.json)，没有读取错误正文或 stderr 内容。

| 项目                                             | UI 与登记结果                                                                                                                                                                                           | 最后安全摘要                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Junie `3419.24.0`，macOS arm64 ZIP、`--acp=true` | 一次明确重试后仍显示“连接在检查完成前结束，请检查程序后重试”；安装入口恢复、使用未放开，未登记且候选目录 `[]`。[截图](01-junie-result.png)、[AX](junie-result.txt)、[登记核对](junie-registration.json) | `startupOutcome=ended`、`failurePhase=initialize`、`initializeResponse=not_observed`、`initializeAccepted=false`；实际 `exitCode=1`、无退出信号；`childReaped/groupEnded/connectionRemoved=true`、`candidateCleanup=deleted`。 |
| Minion Code `0.1.44`，uvx、`acp`                 | 一次明确重试后同样提前结束；UI 已找到 uv/Python，但不将依赖存在当作连接成功，未登记且候选目录 `[]`。[截图](02-minion-result.png)、[AX](minion-result.txt)、[登记核对](minion-registration.json)         | 与 Junie 相同：initialize 未匹配/未接受，`ended`、实际退出码 1，已 reap、进程组结束、连接移除且候选目录删除。                                                                                                                  |
| 原 Amp                                           | 正常启动摘要为 `success`、initialize `matched_result` 且 accepted；自动读取已有模型，没有发送消息。随后返回原空稿。[原稿截图](05-original-draft.png)                                                    | 最终退出后实际 `exitSignal=15`、`childReaped/groupEnded/connectionRemoved=true`，`termRequested=true`、`killRequested=false`；连接成功结论与之后的清理状态分开。                                                               |

Minion 的 `exitObservedBeforeTerm=true`，Junie 为 false；它们只说明 owner 观察退出状态与请求 TERM 的顺序，**不能证明退出因果**。Junie 另有两条 outgoing response 的固定 `protocol` 错误分类，没有具体方法信息，不能归为某个不支持接口或认证故障。两项精确原因均保留未知，旧候选失败不按本片新字段追溯补写。

## 预览与导出边界

实际打开诊断预览并导出桌面 ZIP，见[预览截图](03-diagnostics-preview.png)、[导出完成截图](04-diagnostics-exported.png)、[预览 AX](diagnostics-preview.txt)、[完成 AX](diagnostics-exported.txt)。[导出检查](diagnostics-export-check.json)记录 ZIP 摘要 `52f48f0a198a7631ea4726d3c44eab1cdeed09ab25d8fca2fde738bb13b691b6`，含 32 个日志文件、日志合计 31,956 字节，三份 v2 摘要完整匹配导出前收集结果；两个失败摘要均含最终删除结果，Amp 在此时仍为已连接/尚未 reap。

AX 对每个较长文本仅暴露前缀，三份可见前缀与 ZIP 匹配；`03` 截图只覆盖下部列表和部分 manifest。**未验证安装版整个预览逐字等于 ZIP**；完整三摘要的数值依据 ZIP 检查与导出前收集，完整快照隔离另有受控测试，不能混成安装版全文验证。

[退出后 ZIP 核对](diagnostics-export-after-exit.json)确认文件 hash 和已导出摘要未变；后来的 Amp signal 15/reap 终态未进入之前已导出的包。这是本次实际导出快照保持的证据。

## 数据与退出保护

[安装基线](data-before.json)、[最终计数](installed-counts.json)与[退出核对](after-exit.json)确认原 **33 条会话索引、37 个 Agent 启动配置、46 个设置**保持：无新增索引、原整行/启动配置/设置摘要无变化，全部原未发字段无变化。原稿返回未改选中模型或推理设置。

本次三个协议文件共有 3 次 outgoing initialize、1 次 outgoing session/new、2 次 outgoing response 固定 protocol 错误、2 个 stderr 字节标记、22 条启动摘要，**0 次 prompt、0 次 authenticate**。Amp 自动读取模型产生 session/new，不能称整批只有 initialize；摘要数量不等于启动次数。stderr 标记不提供内容或精确原因。

[外部采样身份](all-observed-processes.json)只捕获正式应用 `6960` 与 Amp `7183`，按 PID+启动时间核对已全部退出。Junie/Minion 瞬时 Child 的 reap 与进程组结束由生产唯一 owner 的固定记录证明；没有宣称外部采样捕获全部 PID 或瞬时后代。

[重复应用清理证明](duplicate-app-cleanup.json)先核对四文件与正式安装相同，再精确删除本次打包副本；正式应用保留。未清理用户 Agent 配置、凭据或历史。

## 未覆盖

没有登录成功、API Key 保存/交付、真实成功消息、两失败 Agent 的模型读取或恢复成功。未确定 Junie/Minion 根因；Grok/Factory 没有在此候选重试。程序可用性与完整 J1–J6 仍按活动计划逐项验证。本片受控实现及审查记录见 [README](README.md)、[backend](backend.md)、[review](review.md)。
