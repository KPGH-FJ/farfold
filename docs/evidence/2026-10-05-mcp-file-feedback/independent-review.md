# MCP、真实文件与待办增量独立审查

结论：最终冻结的生产增量未发现剩余源码阻断点。审查覆盖工作区增量和精确提交选择；全套工程结果由主任务汇总，本审查不代替最终测试、打包或真实 Agent 验证。

基线为 HEAD `4f68c8312181eb40da6e0ae846384acd1a922c70` 与 `before/files`。审查遵循仓库规则及 code-review-excellence，仅审本轮增量，未将原 247 项未提交工作混入结论。41 个选定文件的工作区/提交内容 SHA-256 记录于 [independent-review-files.json](independent-review-files.json)。摘要用于标识审查证据，不是 Agent 可执行程序的准入门槛。

## 审查中已纠正的问题

1. **内联 MCP 覆盖风险。** `CODEX_CONFIG` 的 `mcp_servers.*` dotted override 与顶层 `mcp_servers` 都可能被官方逐路径覆盖过程影响。现在 Node 路线对 exact key 和 dotted 前缀都拒绝临时注入，普通对话保持；已复核实际源码、反例与官方函数两种覆盖顺序的受控证据。
2. **未知回执误清待办。** 查询或回应失败不再清除已观察到的待确认请求。保留原请求标识及待办，`ready=false` 阻止旧回执操作，原请求卡提供重新检查；只有可信无请求状态、页面失效、明确断连/销毁才清除。当前 owner 的错误 task/page/revision 回执也进入未知状态；迟到旧 owner 回执被丢弃。权威重查解决后不会重新显示旧操作错误。
3. **Node 条件误套 Binary。** `APP_SERVER_LOGS` 的泄露证据来自 Node 实现，不能由此限制原直接 Binary 路线。最终只对 Node 捕获并应用日志与内联配置条件；Binary 沿既有来源、READY 连接和生命周期边界，没有新增同名环境变量限制，也没有声称已证明 Rust/RUST_LOG 或任意包装器安全。
4. **测试跳过正式准入。** 原 positive transport fixture 手写 launch 事实，现已移除。Binary/Node 形态受控脚本均经过正式 registry/绝对命令/参数及 manifest 准入，由生产 manager 生成 launch 事实。unsafe offer 在实际请求前 revoke 的回执、新建/加载、READY 复用、stale row、服务连接隔离均有覆盖。

新增并发 fixture 曾错误要求同一连接两次 open 都成功；最终保留既有串行准入，允许精确的 busy 拒绝，并验证两个 offer 都撤回、后续正常打开、会话释放。没有为测试放宽生产并发规则。

## 已核对的边界

- 官方 Node 来源只接受既有登记身份、绝对 Node、单个绝对 bin、正确公开 package/name/bin 和包内规范路径；manifest 有 64 KiB 上限，非普通文件和包外链接被拒绝。没有版本或二进制 SHA 门槛。
- Node 条件在实际 spawn 的同一个 Command 上取有效覆盖/继承值并冻结原值或缺省，成功后发布一次性事实。READY 复用使用原连接事实；最初 row 不能为重新读取后另一条启动命令背书。拒绝的 offer 在入队/序列化前显式释放，不修改 Agent 配置或用户日志开关。
- 工具未注入、查询中、工具目录返回、网页许可分别呈现。工具目录返回不等于真实网页调用成功；没有在前端按 Agent 品牌分叉。
- 待办只保留 task/request 标识，复用现有发送、队列、侧栏与关注判断；不新增审批队列、历史账本或持久化许可。未活动页面继续观察取消回执而不能操作，断连保留未知结果语义。
- 真实文字文件刷新重走 inspect/read 并比较完整回执；失败撤下旧文字。意见归原对话、规范路径和磁盘版本，正文不持久化；原子追加输入框保留附件/sendPending，不自动发送。隐藏、切任务、卸载、刷新与版本竞争有 guard。

## 精确提交版本

HEAD 的 `pump.rs` 尚未包含 before 基线已有的用户 refactor。独立由 HEAD 生成 `selected-pump-review.rs`，仅增加三处 `browser_unavailable` 接线：`SessionEntry` 字段、inline open 参数、构造赋值。结果 1343 行，SHA-256 `785c1c47d98f9b7dd58f32426e8b274b02cc4b4a0e4e3d4841be63d92aa3f52b`，与实现者选择及最终暂存内容一致。

没有把原未跟踪 `src-tauri/src/acp_client/pump/open.rs` 和 `src-tauri/src/acp_client/api_key_auth/tests.rs` 纳入提交；它们仍以 `??` 保留在工作区，含此次接口配对所需的少量兼容字段/参数。原 refactor 不被提交、回滚或丢弃。HEAD 全部 `ManagerCommand`、`SessionEntry`、`ManagedConnection` 构造点已核对；`session_projection` 的选择只保留本轮 pending/unknown 变更，没有误带既有 `connectionCloseReason` 工作。原 247 项状态是否完全保持由主任务提交后最终对比，不在此提前声称。

## 验证依据与限制

- 已核对前端作者 63/63 定向回归及类型检查回执；真实文件作者 44/44 回执。
- 已核对修正后的 transport 路由定向测试 14/14 通过日志。Binary 与 Node fixture 都是受控 peer，不是官方 Agent 执行。
- 精确提交前端格式、类型、测试、构建结果已生成；合并工作区与精确提交全套结果由主任务汇总，不把不同输入的数量合并为一组通过。
- 审查者没有启动真实应用、Agent、模型，没有读取真实用户配置、环境值、日志或对话，没有修改生产文件或 Git 暂存区。本文件及摘要只写执行工作区。
- 真实已安装应用、指定 Codex/账号/服务/模型的网页请求、原生工具并存及实际文件返工闭环仍留给已约定的明日验收。官方函数和受控 peer 的证据不能替代这些结果。

## 最终焦点补正复核

`ThreadView` 的“返回对话确认”先把原请求区域写入既有 `artifactReturnFocus`，复用 `ArtifactPane` 在真实页面隐藏且解除 inert 后的焦点恢复。宽屏保留立即聚焦；全窗/窄屏即使即时 focus 受 display:none/inert 阻止，后续原 cleanup 仍会恢复到正确请求。请求区域只响应自身 focus 的滚动，不因子按钮或输入框的冒泡 focus 拉动阅读位置。仅修改 `ThreadView.tsx` 及原 `ThreadView.reading.test.tsx`；没有更改 `ArtifactPane` 的隐藏/恢复机制。只读复核未发现阻断点；两个文件已重暂存并同步精确源码目录；最终摘要已更新。

## 最终工程结果（主任务回执）

合并工作区 Rust 821 通过、4 项既有忽略；精确提交 Rust 747 通过、3 项既有忽略；精确提交前端 1570 通过。最终焦点补正后，合并工作区与精确源码定向检查各 30/30，精确源码 tsc+vite 最终构建通过。这些是不同输入范围的结果，不相加为一个总数；焦点复验没有运行真实应用或模型。主任务正在打包，本文不声称安装或明日真实验收完成。
