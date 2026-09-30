# 结束后查看终端记录

本片只修复折叠终端的入口文案。前一候选 `eb075a7` 的 [取消截图](../2026-10-01-agent-copilot-login/03-login-cancelled.png) 和 [现场界面文本](../2026-10-01-agent-copilot-login/login-cancelled.txt) 同时显示“已取消此次操作”“继续登录”和另一个“在终端登录”按钮。前一个按钮实际只展开旧终端，文案会让人误以为继续执行登录。此前真实登录启动与普通取消的结果不因此改写。

## 改动与范围

- [AgentAuthSection.tsx](../../../src/components/AgentAuthSection.tsx) 复用已有 `terminalOutcome`：收起且已有终端结果时显示“查看终端记录”；尚无结果的普通登录保留“继续登录”，配置保留“查看配置终端”。展开后仍为“暂时收起”。
- [auth_strings.ts](../../../src/runtime/auth_strings.ts) 增加共用记录文案。没有品牌分支，没有修改账号操作、终端生命周期、取消或重查。
- 判断依据是终端结果，不是 `authActive`：进程退出后的连接重查仍可能处于 `checking`，但终端已经结束；关闭尚未确认且没有结果时不会称为已结束记录。
- 点击继续只执行原 `setHidden`，展示原终端、输出和操作结果，不重新登录、运行配置或检查连接。

## 验证

[现有组件测试](../../../src/components/AgentAuthSection.configuration.test.tsx) 使用真实 `AuthActivity` 与 `BufferedLoginTerminal`，终端端口是本测试的受控回调；不启动操作系统进程。新增 12 例覆盖普通认证与服务配置两条路线：退出 0、非零退出、普通取消、启动失败、启动取消、关闭未知，以及结束后的连接重查中/成功/失败。断言展开后仍是同一终端对象、原输出与结果，启动次数保持一次，未调用新的认证或配置动作；未知关闭保留进行中入口。

- [首次行为红](red.json) / [日志](red.log)：14 例中 6 失败、8 通过，失败为已结束终端缺少记录入口。
- [补充边界红](boundaries-red.json) / [日志](boundaries-red.log)：18 例中 10 失败、8 通过，追加启动取消/失败后的记录入口反例。
- [定向绿](focused-green.json) / [日志](focused-green.log)：4 个组件测试文件、41 例通过，包含 12 个新增用例。
- [类型检查](typecheck.json) / [日志](typecheck.log)：退出 0。
- [源码冻结摘要](source-final.json) 记录本片 3 文件的 SHA-256 与行数；[文档及格式自检](checks.json) 记录本地链接与定向格式检查。

本片尚未完成新候选安装验收；全量前端检查、联合候选打包和正式应用复验由根任务执行。本任务没有运行 Cargo、正式应用或外部 Agent，没有读取凭据或改动用户数据。
