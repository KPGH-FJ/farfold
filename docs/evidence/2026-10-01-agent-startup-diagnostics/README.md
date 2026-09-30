# Agent 启动诊断：固定事实与候选清理

本片源码及检查已完成，正式安装验证尚未执行。用于下一次 Junie/Minion 原失败重试，不能据此补写旧候选的失败原因。

## 问题与行为

此前连接检查只给出安全错误，无法区分收到错误回复、结果解码失败、程序退出及候选文件清理；普通日志队列或文件达到上限后，也可能遗漏最终状态。

现沿同一连接及唯一 Child 所有者记录固定启动摘要：匹配 `initialize` 的回复类别、是否接受、调用方结果、实际退出 code/signal、我方终止请求、进程组和连接移除，以及候选目录的实际清理结果。请求 ID 只在内存关联，不持久化正文、stderr、参数、环境、路径或错误详情。收到回复与成功连接分别记录；迟到回复不能改写取消或超时。

最新摘要使用独立有限槽和预算，普通队列满或日志达到上限后仍可写入，回收不等待诊断磁盘。导出在原有总预算内读取完整头尾行，优先保留每文件最后合法摘要，ZIP 仍逐字采用用户已审阅的预览。复用 READY 连接不创建新的启动记录。

候选临时目录只在确认安全回收后显式关闭并检查实际不存在；未知状态保留文件和原收据，原选用目标不变。具体机制与限制见 [backend.md](backend.md)、[export-design.md](export-design.md)，独立审查记录见 [review.md](review.md)。

## 源码与验证入口

- 启动观察：[startup_diagnostics.rs](../../../src-tauri/src/acp_client/startup_diagnostics.rs)、[process.rs](../../../src-tauri/src/acp_client/process.rs)、[manager.rs](../../../src-tauri/src/acp_client/manager.rs)。
- 落盘与导出：[tap.rs](../../../src-tauri/src/acp_client/tap.rs)、[diagnostics.rs](../../../src-tauri/src/diagnostics.rs)。
- 候选清理：[agent_install.rs](../../../src-tauri/src/agent_install.rs)、[cleanup.rs](../../../src-tauri/src/agent_install/cleanup.rs)。
- 作者冻结与定向收据：[source-final.json](source-final.json)、[focused-final.json](focused-final.json)。最终候选重新冻结见 [candidate-source.json](candidate-source.json)；其与作者冻结的差异为根任务修正模块声明排序。

受控红绿覆盖真实错误回复、畸形结果、EOF/code、实际 signal、spawn 失败、取消后迟到回复、队列满/日志上限、复用连接、TempDir 删除失败，以及候选旧登记保持。红例与修正边界保留在 backend 文档，不把编译失败或测试断言问题算作功能红。

全量 Rust 已通过 **472 项，3 项既有忽略**；fmt 和 clippy 均退出 0，见 [checks-rust-full-formatted.json](checks-rust-full-formatted.json) 及 [原始测试日志](rust-full-formatted-2.log)。[全仓格式检查](checks-format-final.json) 通过。前端 307 个输入与已验收的显示片相同，复用 **1132 项、类型与 build** 的检查，见 [frontend-checks-reused.json](frontend-checks-reused.json)。各筛选组存在重叠，不相加为覆盖数量。

未注入真实 OS wait 错误；该未知分层由受控状态检查验证。短接收器验证超时不可改写，真实子进程验证取消后的迟到回复。终止请求不证明送达或退出因果；缺少日志也不能证明启动未发生。

## 安装验证待办

本片尚未提交、打包或完成 `/Applications/Farfold.app` 验证。独立审查最终收口后，由根任务完成同候选的 Junie/Minion 原失败重试、旧原稿返回、进程回收、诊断预览与精确 ZIP 导出，并核对数据和冻结输入。安装记录将另行补入；当前没有登录成功或真实首条消息的新结论。
