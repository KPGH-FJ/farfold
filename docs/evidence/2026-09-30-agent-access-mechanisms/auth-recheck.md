# 账号检查的连接范围

日期：2026-09-30。当前记录源码与受控回归，安装结果另见本目录 README。

## 原问题与修复

`auth_actions.ts` 在协议认证或终端退出后，先调用不带目录的 `agent_disconnect`，再连接原目录。后端明确断开同一 Agent 的全部目录及 API 连接；页面中的重查同样使用这条路径。

现在 `auth_recheck` 持有既有配置锁，只定位 `{agent_id, cwd, candidate: false, service: None}`。准备替换前，通过现有账号操作准入原子检查任务及未结束操作，确认旧进程退出，再使用当前登记程序握手。其他目录、API 来源及候选连接不被关闭；原目录已开始工作或仍有结果未知的操作时保留它们，检查失败仍可重试。账号变更本身的共享凭据保护不放宽，API 来源不能调用此账号检查命令。

前端完成登录后仍回到操作的原目录；手动检查使用同一命令。检查按钮只被其准确连接的相关工作阻塞，登录与退出仍按账号变更范围保护。检查失败不再立即刷新方法表清掉错误。连接握手、登录回执与真实模型请求仍分别判断。

## 定向验证

- 修复前 `auth_actions.test.ts` 实测调用 `agent_disconnect` 与 `agent_connect` 两个命令，未调用精确检查命令；预期测试失败。修复后只调用一次 `auth_recheck`，目录保持原值；后台拒绝时登录已完成、检查未完成分开记录。
- `AgentAuthSection.work.test.tsx` 复现“其他目录有工作会禁用重查”后，修复为可以检查当前目录；原目录在点击前新出现任务仍拒绝。账号变更与 API 边界继续受保护。
- `account_recheck_keeps_other_directories_and_api_work_connected` 使用真实受控子进程验证原进程被回收、重新握手；另一目录和同目录 API 进程 PID、工作租约及 ready 状态保持。
- `account_recheck_refuses_work_in_its_exact_connection_without_closing_it` 验证任务进行中拒绝、PID 保留；任务结束后可检查。
- 独立审查发现 `close(false, None)` 单独使用只检查工作、不检查操作租约。`account_recheck_preserves_an_unfinished_effectful_operation` 修复前失败（返回成功并关闭原连接），加入原子空闲准入后通过，保留未结束的加载/设置操作。
- 三项后端定向回归均通过；完整工程检查与安装候选身份以本目录最终记录为准。受控进程测试不代表真实 Agent 登录成功或完整并发旅程通过。
