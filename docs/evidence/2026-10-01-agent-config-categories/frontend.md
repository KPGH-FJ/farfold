# 多个配置选项共享类别：前端验证

本片前端按每个公开选项 ID 保留模型与推理选择。相同类别不再表示只有一个选项；原声明顺序、来源、各项值保持。以下是源码与受控测试证据，尚不能替代安装版或 Dirac 的真实旅程。根任务同时使用此前已安装的 `959fc00` 观察目录，那个安装候选不包含本片源码。

## 最终行为与边界

- `protected_config.ts` 统一保护当前声明中全部 `model` / `thought_level` ID，连同后端 `protectedIds` 中的历史 ID。已有和恢复对话不能修改这些选项；当前类别被省略、改变或选项消失时，历史 ID 仍被保护。保留既有无类别模型与推理声明兼容；不将 `model_config` 扩入本片保护范围。
- 输入区继续突出第一个模型和推理项，其余同类选项通过现有选项列表可达。列表控件和实际回调都检查保护范围，实际 `threads.setConfig` 亦拒绝发送受保护 ID 的修改请求。
- 接入页的新稿可分别选择所有声明的模型和推理项；改变其中一个选项后，完整选项集合和服务来源保持。已有对话的接入审阅显示全部受保护选项，包括类别改变但 ID 仍被记录的项，保持只读。
- 确认卡显示 `ConfigCheck.current.choices` 的完整公开选择，兼容旧版 `model` / `thoughtLevel`。名称通过同 ID 的公开声明匹配，值来自所确认的快照；不从无关字段或畸形记录推断选择。确认仍将完整 `current` 原样传递，未迁移或改写持久记录，不发送消息，不释放已暂停的待发消息。
- 配置提示以同 ID 的公开名称区分多个推理项。`storedModelValue` 可按精确 ID 读取 v2、v1 与旧平面记录；不同 ID、重复 ID 或不适用类型不借用另一个模型值。原服务元数据不参与推断或重写。

## 红测与通过记录

| 记录                                                           | 结果                       | 实际覆盖                                                                          |
| -------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| [frontend-runtime-red.log](frontend-runtime-red.log)           | 6 失败 / 11 通过，退出 1   | 实际会话 store 对第二个模型、历史 ID 类别变化与缺项未保护；v2 读取不支持          |
| [frontend-ui-red.log](frontend-ui-red.log)                     | 7 失败 / 37 通过，退出 1   | 第二推理不可达、已有/恢复控制与迟到回调未锁、接入审阅遗漏第二模型、同类提示缺名称 |
| [frontend-selection-red.log](frontend-selection-red.log)       | 1 失败 / 10 通过，退出 1   | 接入新稿只有首模型选择控件                                                        |
| [frontend-confirmation-red.log](frontend-confirmation-red.log) | 1 失败 / 9 通过，退出 1    | 实际对话确认卡未显示完整当前快照                                                  |
| [frontend-first-green.log](frontend-first-green.log)           | 72 / 72，退出 0            | 第一轮实现与实际 store / 接入 / 列表回归                                          |
| [frontend-related-green.log](frontend-related-green.log)       | 139 / 139，退出 0          | 完整确认展示及既有会话、历史恢复等相关回归                                        |
| [frontend-final-green.log](frontend-final-green.log)           | 196 / 196，14 文件，退出 0 | 最终本片、既有准备、历史、输入错误与集中文案检查                                  |
| [frontend-typecheck-final.log](frontend-typecheck-final.log)   | 退出 0                     | 最终 TypeScript 类型检查                                                          |

测试使用公开受控选择，例如模型、速度、推理等级、思考预算四个独立 ID，不调用真实 Agent、应用或账号。红测分别在对应修复前运行；后续通过记录有交叉，不相加。实际生产组件和 store 的入口覆盖了新稿、已有对话、恢复标记、历史 ID 改类别或缺项、多个同类选项、旧 v1 / 平面读取、完整 v2 确认与不自动发送。

## 最终输入与后续验收

前端范围为 15 个生产文件、8 个测试文件。完整文件列表、SHA-256、行数及检查结果见 [frontend-checks.json](frontend-checks.json)。`AgentSetup.tsx` 1482 行，`sessions.ts` 1468 行；额外模型行、确认展示与共享保护判定拆为小模块，均低于单文件限制。

根任务负责最终全量工程检查、冻结和同一 `/Applications/Farfold.app` 安装验收。下一候选应实测 Dirac 等真实同类别多项声明是否完整读取与显示、新稿逐项选择、确认后不自动发送，以及已有/恢复对话保持原模型和推理集合；没有实测的项仍为未测。
