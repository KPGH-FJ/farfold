# 认证声明分类：前端

2026-10-01。本片前端根据通用认证声明展示可执行方法和暂不可自动处理的方法。`environment`、`unsupported` 不显示普通“开始登录”或自动 API 配置入口，也不在方法返回时猜测 Key 交付、模型或使用来源。本文件记录受控组件/调用验证；尚未替代正式安装版的真实账号旅程。

## 行为与边界

- `AuthMethodInfo` 接收 `environment`、`unsupported` 和可选 `envNames`。环境名称来自后端验证过的公开字段，仅只读显示，不作为环境值、Key 输入或 `ManualAuthSection.declaredEnv` 自动填充。没有展示或保存原始认证 payload。
- 两类声明显示后端安全原因；字段缺失时仍有固定说明，并在 `beginAuthentication` 创建操作前拒绝自动执行。真正的 `agent`、`terminal`、`api-key` 保持既有分工；另一种可执行方法不会被环境声明一同禁用。
- 官方说明/账号链接、更多登录方式、明确配置的手动命令和重新检查连接仍可到达。环境声明不会擅自转成 API 服务或复用已有秘密；手动命令沿既有明确配置路径，不把普通声明伪装成成功登录。注册返回页面不提供这两类的普通继续登录动作。
- `authMethods(agentId, {cwd, source})` 透传本次实际目录与来源；缺少目标时传 null，交由后端返回仅可显示的缓存说明。切换目录/来源后立即隐藏旧表，并重新查询，不改用户选择。
- 既有 `agent:status` 事件只使所属 Agent 的方法表失效并重读当前目标；不会自动连接、认证、修改配置或发送消息。目标标识、读取序号与清理函数排除迟到响应；旧 agent/API 按钮在事件发生后、页面重绘前就不能执行。
- 方法读取错误与明确账号操作错误分别保留：状态刷新不会抹掉一次明确失败的账号重查。已有账号操作继续显示原目标与真实结果；本片没有给历史恢复新增门控。

## 修改范围

生产文件共 5 个：

- [AgentAuthSection.tsx](../../../src/components/AgentAuthSection.tsx)：声明说明、公开名称、当前目标查询与失效保护。
- [auth_method.ts](../../../src/runtime/auth_method.ts)：共享只读类型与安全原因规则。
- [auth_actions.ts](../../../src/runtime/auth_actions.ts)：自动执行前的通用拒绝，保留明确手动/退出动作。
- [agents.ts](../../../src/runtime/agents.ts)：wire 字段和查询参数；公开握手快照及不暴露命令参数的注释同步。
- [auth_strings.ts](../../../src/runtime/auth_strings.ts)：固定通用说明。

新增 [组件行为回归](../../../src/components/AgentAuthSection.declarations.test.tsx)与 [IPC 透传回归](../../../src/runtime/agents.auth-methods.test.ts)，补 [动作前拒绝](../../../src/runtime/auth_actions.test.ts)。三个既有账号组件测试只补状态事件监听 mock，继续使用原有工作、重查及结果归属断言。本片没有 Agent 品牌分支、额外查询进程或新持久状态。

## 红绿记录

| 记录                                            | 范围与实际结果                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [首次红测](frontend-red.log)                    | 3 文件、10 失败 / 4 通过；复现普通按钮/自动认证误路由，以及缺少目录来源和目标刷新保护。                                                                        |
| [确认红测](frontend-confirmed-red.log)          | 新增缓存随连接变化重读反例；3 文件、11 失败 / 4 通过。                                                                                                         |
| [首轮绿测](frontend-green-first.log)            | 新声明、IPC、动作与既有工作/重查/设置结果共 6 文件、31 项通过。                                                                                                |
| [旧按钮红测](frontend-stale-button-red.log)     | 在同一连接事件后、页面重绘前调用旧 agent/API 按钮，2 失败 / 8 通过。                                                                                           |
| [末边界红测](frontend-final-boundaries-red.log) | 再加明确账号重查失败被声明刷新清掉的反例，3 失败 / 8 通过。                                                                                                    |
| [最终定向绿测](frontend-green-final.log)        | 8 文件、56 项通过，含环境/未知说明、公开名称与 raw canary、另一 terminal 选择、两目录/来源、迟到响应、默认目录、缓存刷新、旧按钮、失败结果保留及既有认证排序。 |
| [类型检查](frontend-typecheck.log)              | `corepack pnpm typecheck` 退出 0。                                                                                                                             |
| [集中文案检查](frontend-strings.log)            | 1 文件、2 项通过。                                                                                                                                             |

上述各命令分别退出 1（红）或 0（绿），见[命令收据与源码摘要](frontend-checks.json)。定向测试命令以收据为准；没有自行启动全量构建、正式应用或外部 Agent。独立审查与根任务的全量检查/安装记录另行归属，未由局部测试推定真实环境 Key 设置、账号成功或请求成功。
