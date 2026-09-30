# 共用配置动作与模型读取恢复：前端实现证据

本记录对应[本片验收入口](README.md)及[配置动作约定 §6](../2026-09-30-agent-access-mechanisms/goose/next-action.md)。本子任务只改前端源码与受控回归，未启动真实 Agent、配置命令或正式应用，未读取账号秘密。安装版出口仍由主任务验证。

## 已实现

- `PreparationInfo.actions` 与协议登录方法分开。公共账号区域独立读取动作，先展示官方命令、原目录与副作用，再由用户明确运行；API 来源和同 Agent 未完成工作均禁用。后端重新核对审阅值并控制进程准入。
- `AuthActivity` 冻结操作种类、标题、动作/方法标识和完成规则，复用原终端所有者。操作可暂离重入；方法列表消失、断线或重查失败均保留原操作及终端。终端结果独立于随后连接检查保留，退出零只说明命令结束，取消或非零结果不会因重查成功被抹去。
- 启动中取消立即调用原 `auth_cancel`，同时等待迟到 PTY ID 并关闭、确认真实退出；配置动作不调用 `auth_end`。早到 `AUTH_CANCELLED` 保持取消状态，退出未知仍保留操作所有权。
- 服务动作在共享 `AgentPreparation` 按原 Agent/目录/来源设置显式读取门控。重查、切页、暂离重入和其他目标读取均不消耗它；原目标明确重读才执行 `session_open`。不自动发送、不清请求级认证失败、不改原稿、模型或推理等级。

## Pi 反例的红绿证据

安装版失败形状由主任务给出：`session/new` 成功后恢复选项存在协议错误，保存选择含模型、`thought_level: off` 与 `mode: off`；具体失败选项不能仅靠元数据推定。

1. [选择不一致红测](frontend-choice-red.log)复现实际返回值与明确请求不一致却被记为未测试且无错误；[绿测](frontend-choice-green.log)验证读取失败有安全提示、原选择不回写、同一失败自动重进不重试，明确重读后实际一致才继续。公开 warnings 本身不决定失败，也不将其原文展示到界面。
2. [模式事件红测](frontend-mode-red.log)复现 `config_option_update` 两次更新后丢掉顶层 modes 合成选项，随后 `current_mode_update` 无法补回；[绿测](frontend-mode-green.log)以真实 sessions/controller 事件重放保留有效的独立模式。真实 mode 标识或同 category 声明优先并取消合成路由；普通设置响应复用相同替换规则。
3. Setup 组件回归验证失败显示而非退回“尚未读取”，返回受阻，明确重试保留调用方选择。此处不默认认定是哪一个选项失败；后端模式恢复接口修复另见本片 `backend-mode/` 证据。

## 回归与边界

- [全量前端](frontend-full-before-outcome.log)：119 个文件、947 例通过；时间早于最后的终端结果独立保留补强及额外 API 结果用例。
- [最后定向检查](frontend-final-targeted.log)：13 个文件、113 例通过，覆盖真实 sessions/controller、共享操作/终端、审阅 UI、结果保留、显式读取与文案。其后增加的 [API 并存结果用例](frontend-api-result.log)：对应组件文件 5 例全部通过。
- [类型检查](frontend-typecheck.log)通过；[文件行数](frontend-files.json)列出本子任务最终前端改动范围，所有文件 ≤1,500 行，其中 `AgentSetup.tsx` 1,407 行、`sessions.ts` 1,490 行。
- UI 回归保留 React 状态和 effect 依赖，终端/方法回调可迟到；不把 mock 的退出、握手或选项读取计作真实认证、首发或续接。

### 主任务审查后的早取消补强

[红测](frontend-early-cancel-red.log)确认：启动返回 `AUTH_CANCELLED` 时操作所有者已记为取消，并行终端关闭仍把该异常留作“退出未确认”。`BufferedLoginTerminal.close` 现在仅在尚无 PTY ID 且启动明确取消时清除此视图错误，不制造退出码。收到实际终端 ID 后的同形异常仍保留为真实关闭失败；原迟到 ID、未知关闭和重试保护继续生效。[定向绿测](frontend-early-cancel-green.log)与[类型检查](frontend-early-cancel-typecheck.log)记录最后补强后的结果。

配置命令预览另加 `agent-preparation-command`，使用 `pre-wrap` 与 `overflow-wrap: anywhere` 适应受管绝对路径；仅格式检查，实际卡片布局待主任务安装截图验证。

### 独立审查后的首次模式优先级补强

[首次模式红测](frontend-initial-mode-red.log)确认真实 `id: mode` 没有 category、同时存在顶层 modes 时，首次打开会重复加入 mode 并误标独立模式。首次合成现与更新路径一致：真实 id 或 category 都优先。[绿测](frontend-initial-mode-green.log)通过真实 sessions/controller 验证只保留一项、原选择可读取，之后修改调用 `session_set_config` 而非 `session_set_mode`；[类型检查](frontend-initial-mode-typecheck.log)另记。

源码尚未提交。统一全检、冻结和安装验证由主任务完成。
