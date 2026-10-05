# 连接检查超时：源码定位边界

2026-10-05；只读当前源码。未读取真实日志、配置、环境值或对话；未操作 GUI、重试或修改仓库。

**`AGENT_INITIALIZE_TIMEOUT` 表示等待新连接启动/握手完成回执超过 60 秒；不是模型响应或会话操作队列超时。仅凭该错误仍无法断言 initialize 请求已经送到 Agent。**

- 唯一编码处是 `src-tauri/src/acp_client/initialization.rs:35`：对握手结果 `oneshot` 做 timeout；超时返回 `Failure::Timeout`，`:18` 转成此代码。
- `src-tauri/src/acp_client/manager.rs:41` 设置 60 秒；`:522` 启动异步连接任务，`:652` 等待上述回执。这个范围包含进程启动、登记完成、传输建立、发送 initialize、等待返回和握手解码。
- 进程真正拉起位于 `process.rs:194`；之后仍等待进程登记 `process.rs:365`，然后才建立 ByteStreams 和消息桥。故不能把该错误缩窄成“对方收到 initialize 后不回复”。
- initialize 构造/请求/解码在 `manager.rs:546`、`:572`；`:584` 交出成功回执，之后 `:587` 才开始消费 session 操作队列。因此这次还未进入 session/new、模型列表或 prompt 执行阶段。
- 入口配置锁 `service_connection.rs:87`、等待旧连接退出 `manager.rs:415`、服务与启动环境准备 `manager.rs:431` 都在本次 60 秒等待之前。它们可影响总等待时间，但不会直接生成这个 timeout 错误；SDK/进程登记自身的启动期等待仍在计时范围内。
- 超时会请求 `StartupFailed` 关闭（`manager.rs:664`）；进程是否实际回收由后续 owner 收尾确认，不能把 UI 已返回超时等同于进程已结束。

## 与此次显示修复的关系

`src/runtime/session_projection.ts:372` 的 `modelConfigOption` 只从已经返回的 configOptions 中确定主模型控件。实际列表需要先成功握手和 session/new；这一纯前端选择函数不参与 Rust initialize 构造、进程启动或 60 秒期限。它可能改变后续模型控件显示和配置目标，不能直接造成当前这条启动阶段 timeout。当前事实不足以判断是 Agent 启动、宿主传输/登记、机器当时状态还是其依赖条件，不能用“前端修复后发生”推断因果。

根任务提供的本轮实测边界：Cline 初次与唯一重试超时；OpenCode 一次冷创建超时；Pi 无消息预开成功并返回实际列表；最后 Codex 空草稿预开成功、无活动/终端且未分享。故既不能宣称新版三家普通消息已验收，也不能宣称全部 Agent 的冷连接均失败；Pi/Codex 成功尚不能排除只影响部分启动方式的共用问题。

## 后续必要诊断的最小范围（本次未执行）

仅需精确失败尝试的现有、无正文启动摘要：`failurePhase`、`childStarted`、`initializeResponse`、`initializeAccepted`，以及 `childReaped/groupEnded/connectionRemoved`、退出码/信号。字段来自 `startup_diagnostics.rs:51`，并有固定 schema 的 `safe_record`（`:331`）。无需输出请求体、原始 stderr、账号配置、启动参数或环境值。

判断次序：未 `childStarted` 定位进程启动/调度；已启动而 failurePhase=registration 定位登记到消息桥之前；failurePhase=initialize 只证明消息桥观察到请求（`:242`），不证明 Agent 已处理；匹配返回存在但未 accepted 才需进一步核解码/本地完成；退出回收另行看真实收尾字段。先消费这份现有摘要，缺证据再决定是否增加受控、无模型的定向复现，不继续盲目重试或放大超时时间。
