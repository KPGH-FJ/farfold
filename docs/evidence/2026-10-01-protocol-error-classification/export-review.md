# 入站错误分类：隐私与导出审查

最终独立审查未发现隐私或导出兼容阻断。已读[方案](proposal.md)、三个生产文件及三个测试文件的最终差异，并逐项核对[冻结摘要](source-final.json)：六文件 SHA 与行数全部一致。该摘要 SHA-256 为 `cc2b81978ef5627a32146fb6efa5ea85a1bc4036f56d71ef45de2b36bcd8cb30`。本审查没有修改源码/测试、运行 Cargo、Agent 或正式应用，也未读取用户配置、凭据或原始协议正文。

## 现有入口与兼容边界

- [process.rs](../../../src-tauri/src/acp_client/process.rs) 的官方 typed bridge 是实际入站观察位置。分类只需读取 typed `ErrorCode`、`RequestId::Null` 布尔和已有 `initializeAccepted` 观察值；不得从 message/data、字符串化错误或本地 await 失败推断远端码。原有整条消息的临时序列化仅用于现有基础元数据计算，不应新增原文持久化。
- [tap.rs](../../../src-tauri/src/acp_client/tap.rs) 的 `DebugTap::write_record` 与 [diagnostics.rs](../../../src-tauri/src/diagnostics.rs) 的 `safe_logs` 共用同一个 `tap::safe_record`。全仓检索未发现第三个生产 v1 validator；应在这个共同入口重建三字段可选组，避免写入和导出采用不同白名单。
- `startup_diagnostics::safe_record` 是独立 v2 入口，既供 `tap::safe_record` 分流，也供 `DebugTap::write_summary` 使用。它按固定 `Snapshot` 重建，丢弃额外属性，未知枚举/错误类型拒绝整条摘要。本片无需扩展 v2 或摘要专用预算。
- 旧 v1 无分类组应原样保留基础字段。新组仅在各自方向的 `response/protocol` 上成立，三字段必须完整且类型正确；未知分类、部分字段或错误上下文只删除整个可选组，不丢原基础记录。生成端未知 typed code 可归固定 `other`，这不等于允许磁盘上的任意分类字符串。

## 导出不会重新收集

[safe_logs](../../../src-tauri/src/diagnostics.rs) 只读命名匹配的普通文件，最多 32 个；每文件从固定长度快照读取不重叠头尾，合计最多 256 KiB，只处理完整行。每行重新经过共同 validator，再按 2 MiB 总预算优先保留每文件最后一条合法 v2 摘要，其余 v1 分类仍属于普通记录。文件路径与 Agent 标识不进入导出日志名。

`DiagnosticsState::preview` 保存审阅快照，`export` 使用该快照的 UTF-8 文本，不再次调用 `safe_logs`。因此新分类不需要更改 ZIP 或预览入口；预览后出现的新记录不能被后来导出自动带入。用户主动填写的问题说明是另一项明确预览的内容，不能据此宣称整个诊断包所有文字都由固定枚举组成。

## 最终实现核对

1. 入站九类与既有出站六类分方向接受。入站专有 `auth_required`、`request_cancelled`、`resource_not_found` 放到出站时整组剥离；writer 与导出继续重建字段。测试中的 `message/data/id/method/env/argv/code` canary 不进入文件、预览或 ZIP。
2. 三字段缺任一项、布尔为数字/字符串、分类为数字/未知字符串、错误 dir/event/error 时剥离整组；旧 v1 与 v2 保持原验证。[纯观察回归](../../../src-tauri/src/acp_client/startup_diagnostics/tests.rs)核对锁争用/poison 时省略整组，timeout/cleanup/取消后的观察不改既有结果，接受前后布尔只表示观察事实。
3. [导出测试](../../../src-tauri/src/diagnostics/log_tests.rs)共同预览旧 v1、合法出站、合法入站及 v2，验证错方向/未知分类只保留基础字段，并证明预览后追加入站错误及新摘要不进入该次 ZIP。[真实 bridge 受控对端](../../../src-tauri/src/acp_client/protocol_error_tests.rs)从实际 typed 入站和 tap 文件核对分类，而非仅手写已分类 JSON；null ID 与准确 initialize 匹配仍分别判断。
4. 有效 Result 的本地解码失败、EOF/超时及非错误消息没有入站错误组。原 SDK 错误仍到达调用方；生产变更仅添加观察字段，没有改结算、认证、队列或取消链。

## 收据与现场采集边界

[首轮入站红收据](incoming-red.json)及[日志](incoming-red.log)为 3 项全部失败；修复后[入站定向](incoming-green.json)为 7 项通过，[最终协议错误组](protocol-final.json)为 20 项通过。另有[启动失败 6 项](startup-failure-related.json)、[启动观察 16 项](startup-observer-related.json)、[导出 8 项](log-export-related.json)通过；这些筛选存在重叠，不合并为独立测试总数。[作者格式/diff 检查](source-checks.json)均为退出 0。以上均为受控测试，完整工程与真实安装验收由根任务负责。

已复核根任务的 [collect_protocol.py](collect_protocol.py)，当次 SHA-256 为 `da27fae72e1d8ea3b6ed01255e4f8dd33a69d7ef93d20a880340fca185d22f4d`。其 in 九类/out 六类、三字段完整 bool 组与产品 validator 一致；未知/错上下文删除分类组。根任务的 [20 项分类清洗收据](collector-validation.json)与 [6 项基础类型收据](collector-base-validation.json)明确仅调用受控 safe 函数，未读取真实日志。

采集脚本已经要求行末换行、版本为严格整数，并同时限定文件创建时间下界及每条记录 `windowStart <= ts <= windowEnd`。本次复核关闭了旧快照中完整行和记录时间窗的差异。它仅读取当前 `.jsonl`，不含旋转 `.jsonl.1`，也不使用产品头尾/总预算策略；这些是验收材料采集范围，不能称为完整协议日志或诊断 ZIP 内容。安装来源/窗口事实与公开分类仍应一起解释。

普通队列满、轮转、头尾窗口和总预算仍可遗漏记录；缺少分类不能证明未收到错误。布尔仅表示观察时点，不能证明对应请求方法或具体账号问题，也不回填旧 VTCode 失败原因。实际新候选分类与导出尚未由本审查验证。
