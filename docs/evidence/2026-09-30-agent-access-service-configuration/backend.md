# 官方服务配置动作：后端范围与验证

基线为 `8d46b23`。本片提供独立的准备动作，不修改协议认证方法，不从说明文字解析命令。正式安装版、Goose 官方配置程序、账号、模型请求和续接仍由根任务验证；下述回归仅使用自有临时文件、SQLite 与受控连接/命令夹具。

## 源码范围与不变量

- [recipes.rs](../../../src-tauri/src/acp_client/recipes.rs) 增加有固定官方标签及核对日期的声明；首样本仅适用于 `registry:goose`、登记版本 `1.52.0`、绝对 `goose` 路径、参数恰为 `["acp"]`、条目环境为空。该范围只决定是否提供补充动作，不限制通用安装或连接。
- [preparation_actions.rs](../../../src-tauri/src/acp_client/preparation_actions.rs) 读取既有 `installations.v1` 类型，核对来源、版本、参数、当前实际程序与已登记目录。路径经规范化并检查目录层级，不靠字符串前缀猜归属，不核对二进制 SHA。动作预览只返回程序、参数和官方来源；启动时取得现有配置保护后重新派生，旧预览或任意客户端命令不成为执行入口。
- [preparation.rs](../../../src-tauri/src/acp_client/preparation.rs) 返回可选 `actions`；[mod.rs](../../../src-tauri/src/acp_client/mod.rs) 与 [lib.rs](../../../src-tauri/src/lib.rs) 接入 `agent_preparation_action_run`。动作参数是 `["configure"]`，不会执行 `acp configure`，也不经过 shell 拼接。
- [manager.rs](../../../src-tauri/src/acp_client/manager.rs) 对配置动作保留同 Agent 全来源的原子空闲 lease，忙 API、忙请求及待处理操作均拒绝，部分保留失败时回退。既有认证的来源范围和 `auth_recheck` 原目录/已有设置的精确替换保持原义，不关闭其他目录或 API 连接。
- [pty.rs](../../../src-tauri/src/pty.rs) 的内部受控入口复用同一 `Operation.abandoned` flag。早到取消在执行前检查，迟到取消由原进程 owner 回收精确进程组；原 `spawn` 调用仍沿用同一 PTY 实现。配置保护、scope 和 attempt 由原 `terminal_output` 持有到真实回收/退出帧，页面暂离或 IPC 接收者消失不提前释放。

动作只使用正常 shell/process 环境与 HOME，不调用 `auth::environment_for`、`credentials::apply` 或 Keychain 读取，不交付用户所选 API 服务 Key。用户原环境仍可能含凭据或服务覆盖值；不能据此声称子进程没有秘密。终端正文不由产品写入设置或日志；本片受控测试不读取用户终端正文。程序退出只提供真实退出帧，不生成认证、模型或请求成功；不自动重新读取模型或发送原稿。

## 已取得的失败证据

[backend-red.json](backend-red.json) 与 [backend-red.log](backend-red.log)：复用旧行为的受控入口下，3 项均失败，退出 `101`。忙 API 连接未被原认证 scope 保留；取消先于启动仍产生子进程；同一个取消 flag 未到达运行中的 PTY owner。所有红测试子进程均按精确 ID 回收，没有运行真实 Agent 或配置程序。

[backend-shutdown-red.json](backend-shutdown-red.json) / [backend-shutdown-red.log](backend-shutdown-red.log)：原 PTY 退出只快照当时已有进程，关闭后的迟到启动仍产生子进程，单项失败，退出 `101`。现在退出标志与快照在原 registry 锁内设置；启动也在同锁内检查并完成注册。先注册者必进入退出快照，后到者拒绝，进程回收等待在解锁后执行。

[backend-green.json](backend-green.json) / [backend-green.log](backend-green.log)：本片 9/9 通过，退出 `0`。覆盖适用范围/旧预览/来源、目录及程序别名逃逸、空环境和协议声明保持、忙 API 回退、早取消、运行中同 flag 回收、真实 owner 释放、关闭后迟到启动；生命周期夹具在异常时也会精确回收自己的进程。

相关旧行为定向回归全部退出 `0`：

| 收据                                                       | 结果    | 范围                                                                         |
| ---------------------------------------------------------- | ------- | ---------------------------------------------------------------------------- |
| [regression-auth.json](regression-auth.json)               | 14 通过 | typed Terminal、旧声明、认证/配置完成语义及子进程保护；Keychain 用例明确跳过 |
| [regression-pty.json](regression-pty.json)                 | 6 通过  | 正常流式输出、已退出终端、拒绝挂起进程回收及新取消/关闭边界                  |
| [regression-manager.json](regression-manager.json)         | 5 通过  | 原认证范围、精确认证目录、忙成员回退与终止后释放；含新增全来源配置准入       |
| [regression-preparation.json](regression-preparation.json) | 12 通过 | 原依赖/版本诊断与安装准备信息                                                |
| [regression-recipes.json](regression-recipes.json)         | 2 通过  | Amp/Pi 原声明适用范围                                                        |
| [regression-manual.json](regression-manual.json)           | 2 通过  | 原显式命令与参数语义                                                         |

部分用例在新功能筛选和所属旧模块筛选中重复，表中数字不能相加当成独立用例总数。各自实际命令与日志路径保留在收据。全部 Rust 文件均小于 1500 行；未增加依赖。前端作者只读复核共享 PTY 退出锁顺序及来源/lease/保护释放路径通过，未另跑 Cargo 或正式应用。

单测不能替代正式应用中的审阅、配置交互、暂离/取消、重查、显式模型读取及首发/续接。本片没有启动 Goose、认证账号、读取/写入官方配置或操作正式应用。
