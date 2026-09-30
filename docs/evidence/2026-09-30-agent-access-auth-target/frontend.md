# 登录目标检查与启动模型输入框：前端验证

2026-09-30。对应本片未提交源码；正式应用仍需由根任务统一打包、安装后验证。本记录不代表登录或模型请求已成功。

## 安装观察与修改

上一候选 `0b6d74c` 的 [无效输入截图](../2026-09-30-agent-access-startup-options/02-invalid-model.png) 与 [返回后的输入截图](../2026-09-30-agent-access-startup-options/03b-model-return-visible.png) 显示：浅色准备面板中的启动模型输入框使用了默认黑底。源码只有宽度规则，没有套用现有表单样式。

`AgentInstallOptions` 复用已有 `custom-input`，继承 `--card`、`--ink`、`--line`、焦点与间距规则；只为本输入框的无效状态增加 `--red` 边框，不修改全局主题。使用稳定的 React ID 将字段限制、目录默认值、重新审阅说明和当前错误关联到 `aria-describedby`，并设置 `aria-invalid`。输入校验、保存与安装语义不变；无效原文仍仅留组件内，不写入进度。

同一正式候选的 [Gemini 账号方式截图](../2026-09-30-agent-access-directory-gemini/02-connected-auth-required.png) 还显示下拉框保留了浏览器黑色渐变：其既有规则已有浅色 token，但没有关闭系统外观。账号方式选择器复用服务设置现有 `api-select-wrap`（`appearance: none`、浅色背景与箭头），保留原来的 `label` 关联；装饰箭头设置 `aria-hidden`，并为箭头留右侧内边距。未改变默认选项、选择处理函数或登录行为。

与后端约定 `AuthMethodInfo.unavailableReason?: string | null`：非空只表示该登录方式不能自动运行。账号页显示安全原因，禁用该方式的主按钮及注册返回后的继续登录，并在处理函数和 `beginAuthentication` 入口再次阻止自动执行。拒绝发生在创建认证活动和失效准备结果之前；显式手动配置、其他登录方式和重新检查保留原有保护，不新增 Agent 专属界面分支。

## 源码范围

| 文件                                            | 行数 | 修改                                                 |
| ----------------------------------------------- | ---: | ---------------------------------------------------- |
| `src/components/AgentInstallOptions.tsx`        |  243 | 复用表单类、错误与说明的可访问关联                   |
| `src/agent-setup-presentation.css`              |  388 | 局部无效边框                                         |
| `src/runtime/agents.ts`                         |  916 | 可选不可执行原因字段                                 |
| `src/components/AgentAuthSection.tsx`           |  558 | 登录方式级提示、入口保护、注册返回传递与统一下拉外观 |
| `src/runtime/auth_actions.ts`                   |  145 | 自动登录启动前守卫                                   |
| `src/components/AgentInstallOptions.test.tsx`   |  329 | 无效输入及纠正后描述有效性                           |
| `src/components/AgentAuthSection.work.test.tsx` |  208 | 两个登录入口、手动配置、重查与其他方法               |
| `src/runtime/auth_actions.test.ts`              |   73 | agent/terminal 两种自动路线均不启动活动或 IPC        |

## 检查

- [红测](logs/frontend-red.log)：3 文件 22 例，4 失败、18 通过。失败分别确认缺少无效输入的可访问关联、未呈现和阻止不可执行方式，以及两种自动路线仍会创建活动。
- [定向绿测](logs/frontend-green.log)：相同 22 例全部通过。
- [相关回归](logs/frontend-focused.log)：8 文件 45 例通过，覆盖安装输入、账号忙状态、重新检查、配置动作结果、注册返回、认证活动和集中字符串规则。
- [类型检查](logs/frontend-typecheck.log)：`corepack pnpm typecheck` 通过。
- 下拉框样式补充后的 [4 文件 18 例相关回归](logs/frontend-select-focused.log) 和 [类型检查](logs/frontend-select-typecheck.log) 通过；没有为纯样式新增镜像测试。
- [局部格式检查](logs/frontend-format.log)：上述 8 文件和本记录通过；未执行全量套件、构建或正式应用操作。

安装验收仍需检查输入框实际浅色渲染、无效/恢复/禁用状态，以及后端返回不可执行原因时的真实入口。前端受控回归不证明官方登录命令已经执行，也不替代后端目标归属验证。
