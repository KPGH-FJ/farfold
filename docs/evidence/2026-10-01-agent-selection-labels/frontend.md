# 账号方法与恢复模型标签：前端修正

本片修正两个已观察的通用显示问题：[GLM 同名方法](../2026-10-01-agent-access-directory-batch4/auth-label-diagnosis.md)以及[Codex 恢复漂移弹层](../2026-10-01-agent-config-categories/readonly-drift-diagnosis.md)。以下是源码和受控组件验证；新候选的安装验收尚由根任务执行。此前安装候选的真实结果不因本片单测变为通过。

## 最终显示

- 同名账号方法保留原名称，并按公开 `kind` 补简短操作说明。`environment` 明确标示“环境变量说明，暂不能在此配置”，不将方法名称中的 Key/API 字样解释成可配置凭据。同名、同类型继续附公开方法 ID，列表调序后标签与已选 ID 不变。不同名方法保持原标签。
- 标签仅读取公开 ID、名称、类型与既有 `purpose`；不拼入原始载荷、命令参数、环境值或 description。选择后的原说明和公开变量名、更多登录方式、重新检查与返回继续沿用。方法选择和执行仍按原 ID，未改变认证路由、可执行性或默认选择。
- 已有/恢复对话未通过检查时，弹层明确标示“Agent 当前返回的模型”，展示当前返回值和 `ConfigCheck` 原记录/当前值差异，不再无条件宣称已保持创建时模型。当前模型选项缺失或值为 null 时显示“未提供”，不借用默认模型或可选 `recordedModel` 造原选择。
- 状态说明区分检查通过、阻止、待确认、保存失败、无完整检查与新稿。正常 `ready` 历史仍可显示保持原选择说明；新稿说明发送前可选模型与推理项。两个同名选项的差异用其公开 ID 区分，完整原名称和值保留。

范围只有显示与标签：没有修改 Rust、认证执行、配置守卫、会话 store、发送准入、服务来源、用户数据或外部程序。未知原值仍为未知；显示准确不等于 Codex 实际冷恢复漂移已修复。

## 受控红绿

| 记录                                                             | 结果                     | 证明范围                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [frontend-red.log](frontend-red.log)                             | 8 失败 / 11 通过，退出 1 | 真实 `AgentAuthSection` 两个同名标签不可辨；`ThreadView` 实际弹层未区别返回值/原值，状态与新稿仍有固定保持声明                                         |
| [frontend-same-options-red.log](frontend-same-options-red.log)   | 7 失败 / 0 通过，退出 1  | 增加两个同名保护选项的实际弹层差异后仍失败；与上一组有重叠，不相加                                                                                     |
| [frontend-first-green.log](frontend-first-green.log)             | 1 失败 / 19 通过，退出 1 | 显示断言已通过；唯一剩余断言把既有 `host_performance_origin` 只读测量也要求为零，属于夹具断言过宽。随后精确检查配置/确认/发送/账号动作，没有吞生产错误 |
| [frontend-related-green.log](frontend-related-green.log)         | 55 / 55，10 文件，退出 0 | 修正只读测量边界后，显示及既有认证、检查、历史、准备、确认与文案回归通过                                                                               |
| [frontend-missing-value-red.log](frontend-missing-value-red.log) | 8 / 8，退出 0            | 初次缺值用例只查整体文本，未直接验证模型行；不能作为该缺值问题的红测                                                                                   |
| [frontend-missing-row-red.log](frontend-missing-row-red.log)     | 1 失败 / 7 通过，退出 1  | 加强为实际模型 `dd` 行后，存在模型选项但当前值为 null 仍为空白，精确复现                                                                               |
| [frontend-final-green.log](frontend-final-green.log)             | 56 / 56，10 文件，退出 0 | 最终全部通过，缺选项/缺值均显示未提供，方法标签、状态与既有旅程相称回归保持                                                                            |
| [frontend-typecheck.log](frontend-typecheck.log)                 | 退出 0                   | 最终 TypeScript 检查                                                                                                                                   |

认证组件回归明确选择环境说明后没有普通登录/API 配置按钮，也不产生账号动作；明确选择并点击另一个 Agent 方法才使用其精确 ID。同类型方法调序后保留原选择。原始载荷 canary 不出现在文本中。

对话回归直接检查真实 `ThreadView` 给 `WorkspacePopover` 的弹层子树，覆盖 `ready` / `blocked` / `confirmation_required` / `record_failed` / 旧无检查状态及新稿。原配置和来源对象保持，渲染不请求设置、确认或发送；当前值只读显示，没有自动改回原值。测试不启动应用或真实 Agent，不读写正式数据。

## 最终输入与安装待办

6 个生产文件、2 个测试文件的准确路径、SHA-256、行数与退出记录见 [frontend-checks.json](frontend-checks.json)。`ThreadView.tsx` 901 行，`AgentAuthSection.tsx` 630 行；无新增依赖或环境开关。前端定向 runner 已释放，生产源与测试冻结，根任务继续全量工程检查和安装验证。

安装版应核对真实 GLM 菜单在选择前能区别两种方法、环境说明不能在此配置；再展开原 Codex 漂移历史的模型弹层，核对当前值与原记录差异、发送阻止及原内容保持。检查标签和控件不授权登录或保存凭据；没有实测的认证、回复与恢复结果仍为未测或保留原失败。
