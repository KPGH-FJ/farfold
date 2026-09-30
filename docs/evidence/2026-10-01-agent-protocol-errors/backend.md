# 有限出站错误分类：后端实现与受控验证

本片只补充已观察到的出站错误诊断，不改变协议请求处理、能力声明、启动命令、进程回收或安装准入。代码和定向测试已经完成；真实安装版及 Junie 再次观察由根任务执行，本文件不代表其根因已确认。

## 实现范围

- [startup_diagnostics.rs](../../../src-tauri/src/acp_client/startup_diagnostics.rs) 从 typed outgoing `RpcResponse::Error` 只读取固定 `ErrorCode` 类别、`RequestId::Null` 形状和观察时的 `initializeAccepted` 状态。新增读取使用 `try_lock`；锁冲突或失效时省略整个可选字段组，不等待、不填默认值。没有新增请求表或请求 ID 留存。
- [process.rs](../../../src-tauri/src/acp_client/process.rs) 仅在现有 outgoing inspection 内为旧 v1 记录补充字段，仍返回 `Ok(())`，仍走现有普通有界队列。新增路径不进行磁盘写入，也不改变已有子进程及清理行为。
- [tap.rs](../../../src-tauri/src/acp_client/tap.rs) 的 `safe_record` 只在 `out / response / protocol` 上保留完整且类型正确的三字段组。缺字段、错误类型、未知分类或错误上下文时一起剥离，六个旧字段仍可读取。写盘和 [safe_logs](../../../src-tauri/src/diagnostics.rs) 使用同一个重建验证器，因此预览与导出无需新格式或旁路。v2 启动摘要不变。

v1 新增字段为 `protocolErrorClass`（`parse_error / invalid_request / method_not_found / invalid_params / internal_error / other`）、`responseIdNull`（布尔）和 `beforeInitializeAccepted`（布尔）。其余标准或自定义错误码均压成 `other`，不保存数值。错误 message/data、任意 method、ID 值、参数、环境、凭据或原始行都不进入这些字段。

`responseIdNull=true` 也可能来自合法的未知方法请求，不能据此判断格式错误。`beforeInitializeAccepted=true` 只表示出站观察时尚未接受握手；超时、取消或清理时也可能成立，不能证明请求的接收阶段、处理器归属或具体失败原因。

## 红绿证据

初次 [backend-red.json](backend-red.json) / [日志](backend-red.log) 运行六项新增测试，退出 101：四个真实 SDK 受控子进程已经收到预期的固定错误码，但旧日志没有分类；旧验证器也剥离该字段组。初次预览用例另有我写错的顺序期望，原收据保留。修正为既有行顺序后，[独立重跑](backend-preview-red-corrected.json) / [日志](backend-preview-red-corrected.log) 仍退出 101，此次只剩字段被剥离的真实反例。

[focused 绿收据](backend-green-focused.json) / [日志](backend-green-focused.log)：12 项、退出 0。覆盖：

- 实际 SDK 对端分别触发 parse error、invalid request、合法 unknown method + null ID、合法 unknown method + 非空 ID；没有官方 Agent、登录、会话或消息请求。
- 五种固定标准类别及其他标准/自定义码、结果和请求不被附加错误组、超时后及接受后的观察布尔、锁冲突不等待、锁失效整组省略。
- 完整字段组严格白名单，以及部分/伪造/错误上下文整体剥离。
- 真实 `safe_logs → preview → ZIP` 保留旧 v1、新 v1 和 v2，删除秘密 canary 与自定义码，预览之后的新记录不混入已审阅 ZIP。

[相关检查](backend-related-green.json)：observer 12、旧 startup subprocess 8、tap 3、safe_logs/export 8，均退出 0。31 次执行中有 8 项与 focused 重叠，合计 35 个不同测试；没有执行全量套件。现有普通队列满载、日志轮转/封顶、最终 v2 尾态以及导出头尾窗口/预算测试保持通过。

## 冻结与边界

[source-final.json](source-final.json) 记录三个生产文件、四个测试文件的精确 SHA256/行数，全部与 focused 绿输入相同；局部 [rustfmt](backend-rustfmt-final.log) 和 [diff check](backend-diff-final.log) 退出 0。Cargo runner 已释放，源码和测试冻结。未改 SDK 或依赖、全局计划/状态、正式数据、外部配置；未运行真实 Agent 或正式应用。

新增分类走普通记录预算，没有 v2 摘要优先权。队列满、写盘失败、日志封顶、导出窗口或总量限制均可能令记录缺失，缺失不是“没有发生错误”的证据。预览只保证本次已收集且经过验证的快照，导出不补入之后的事件。
