# OpenCode Messages：实际 Agent 与本机测试服务结果

**本次独立探针成功完成 A/B 两个来源的首次请求、进程退出后的冷恢复及明确续发。七项 inline 配置观测均达到预先定义的结果，其中模型与认证头覆盖是风险复现，不是这些组合已受支持。** 这不是正式 Farfold 安装版、Keychain 或真实云端验收。

根任务于 2026-10-01 10:06:21–10:06:57（+08:00）执行一次，实际退出 0，stderr 为空。依据为[执行收据](actual-opencode-messages-run-first.json)与[原始固定字段报告](actual-opencode-messages-result-first.json)；执行使用[最终脚本冻结](actual-opencode-messages-source-final.json)。脚本限定官方 OpenCode 1.18.31，初始化检查通过后才继续；没有升级 Agent。本次结果文档没有重跑 Agent、SDK 或测试套件。

## 两个来源的首次与冷恢复

| 阶段             | 实际结果                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A/B 首次         | 新建两个独立会话，按真实模型选项确认对应提供方与模型；明确发送后各产生一次 Messages HTTP，请求路径、API 模型、各自 canary Key、版本头和流式回复均匹配。没有另一来源的 Key、prompt 或 receipt，正文没有 canary Key。 |
| 首进程退出       | 已实际 wait/reap，所属进程组确认为空，才开始冷恢复。                                                                                                                                                                |
| A/B 冷恢复       | 第二进程加载原会话 ID；历史 receipt 回放成功，全部既有受保护选项的 ID、类型和值保持，没有重选模型。两阶段 `protectedChoiceCount` 均为 2（A/B 合计），不将其推成额外推理选项已被验证。                               |
| 冷恢复后明确续发 | 各一次 Messages HTTP，保留原来源路径、API 模型和 Key；请求包含本来源上一轮 receipt，不含另一来源内容，回复均完成。                                                                                                  |

两个阶段均 `modelsMatched/protectedChoicesMatched/historyMatched=true`，各 2 次请求，`positivePassed=true`。正例模型对象没有人为添加 context/output 限额。每次初始化和模型准备之后只观察 **400ms**，在这个窗口及后续受跟踪阶段未见自动 HTTP；这是有界观测，不代表任意等待时长都不会自动请求。首次与冷恢复使用继承 HOME 的官方 Agent；其本轮自有测试历史保留，脚本不读取或清理用户其它历史。

## 七项 inline 观测

每项另起一个进程、只建新的 A 草稿，模型准备后再明确发送。七项均 `observationCompleted=true`、`expectedOutcomeMatched=true`；其中五项 prompt 完成，两项明确拒绝。`expectedOutcomeMatched` 表示符合事先定义的观测，不能当作服务交付支持判定。

| 固定案例                                     | HTTP 数 | 实际观测及边界                                                                                                                                           |
| -------------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model_id_override`                          |       1 | 实际 API 模型变成测试覆盖值；读取的模型选项仍匹配，但请求模型已改变。复现模型 ID 覆盖风险。                                                              |
| `model_provider_override`                    |       1 | 显式发送后进入已知 Responses/Chat 路径类别，被本机服务拒绝，prompt 返回 `RPC_REJECTED`。记录不区分这两种具体路径，也没有错误正文；不能据此推断其它根因。 |
| `model_api_override`                         |       1 | 提供方明确 `options.baseURL` 保持原 A 路径，所选 API 模型和 Key 保持，prompt 完成。这只证明本次两字段优先级样本。                                        |
| `provider_headers_override`                  |       1 | 提供方 headers 的测试覆盖 Key 进入真实请求，原 Key 不再匹配；prompt 完成。复现认证头覆盖风险。                                                           |
| `model_headers_override`                     |       1 | 模型 headers 的测试覆盖 Key 进入真实请求，原 Key 不再匹配；prompt 完成。复现模型级认证头覆盖风险。                                                       |
| `empty_provider_headers_keeps_model_headers` |       1 | 空提供方 headers 没有消除模型 headers，实际 Key 仍被覆盖；prompt 完成。两个独立 inline 字段的观测，不是磁盘配置多层深合并试验。                          |
| `nonempty_auth_token`                        |       0 | 模型准备成功、明确发送后收到 `RPC_REJECTED`，没有 HTTP。没有保存异常正文，不能仅由该结果断言具体 SDK 报错原因。                                          |

四次正例 HTTP 加六次 inline HTTP，共 **10 次**。其中 9 次 Messages 请求保留固定布尔/计数观测；另一条错误 API 路径只记类别和拒绝计数，因此 `httpObservations` 为 9 行，不能误读成少了一条请求。报告中 `rejectedRequests=1`、`automaticRequests=0`、`httpHandlerErrors=0`、`httpLimitExceeded=0`。

## 回收与证据边界

共启动 **9 个进程**：首次、冷恢复各一个，加七项 inline 各一个。九个均 `processReaped=true`、`groupEndedConfirmed=true`；均记录 TERM 请求，没有 KILL 请求。TERM 请求和实际回收分别留证，不把发送信号本身当作退出证明。监听关闭、本次精确任务目录删除及全部进程组结束均确认；没有因回收未知保留任务目录。此范围限直接子进程及其所属进程组，不能证明所有可能脱离这些组的后代。

本次沿官方 OpenCode 与其实际 SDK 路径完成流式请求和回复，补上了[执行前独立审查](actual-opencode-messages-review.md)中“实际 SDK 接受流仍待执行”的条件。该审查是运行前结论，不能被重新标成运行后验收。

本机服务只使用固定、无价值 canary。观测的 10 次 HTTP 均到本次 loopback 服务；未授权真实云请求，没有真实云端账号、模型或秘密验证，也没有正式 Farfold 界面、服务选择、Keychain 取用或安装版续接验证。脚本不提供整进程网络沙箱，不能由这些请求推出任意用户插件都未联网。磁盘配置、组织策略与后合入 hook 未在本次构造；inline 成功不能扩大为所有配置层的隔离保证。Messages 产品能力是否开放仍须依生产编译器与正式安装旅程另行判断。

## 保留的失败轨迹

- [首版冻结](actual-opencode-messages-source-before-timing-review.json)、[时序真实红](actual-opencode-messages-timing-red.json)保留；11 项中 10 项失败、1 项回收通过。修复后[最终零 Agent 自测](actual-opencode-messages-selftest-timing-final.json)33 项通过，再交根任务实际执行，不覆盖早版结果。
- [bookkeeping 初失败](actual-opencode-messages-selftest-localfailure.json)为自测临时目录边界问题，没有启动 Agent；不是 OpenCode 失败。
- 先前独立 SDK 的[缺包收据](sdk-missing.json)、[归档大小门拒绝](sdk-tool-preparation-size-rejected.json)、[首轮执行收据](sdk-loopback-first-executed.json)及[最终 SDK 结果](sdk-canary-results.md)均保留。它们和本次官方 Agent 实际请求属于不同验证层，不能互相替代。
