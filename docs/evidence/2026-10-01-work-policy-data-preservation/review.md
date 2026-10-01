# 工作设置数据保护：独立源码复核

2026-10-01，仅读取最终 [`work_policy.rs`](../../../src-tauri/src/work_policy.rs)、与其直接相关的 `MetaStore` 读写实现、源码差异和本目录检查收据。没有运行 Cargo、应用、Agent 或采集脚本，没有读取或修改正式数据库；只新增本文。

结论：本片最终源码未发现阻断问题。实际文件为 451 行，SHA-256 `36807e04c60a96fe1cf259e222641fc96d83e478aa9340ffef17e60ac21cae04`，与 [source-final.json](source-final.json) 和定向绿收据逐字摘要一致。生产差异只有根对象检查及 `Policy` 的 `deny_unknown_fields`，不改变既有准入、保存或锁的路径。

## 数据与兼容边界

- 有既有设置时，`load` 先拒绝非对象，再严格解码已知根字段，之后验证版本。未知根字段或三/四元素数组均在 `snapshot`、`admit`、`set` 的后续作用之前返回固定读取错误，不落入缺记录的旧默认迁移，不用默认值覆盖原记录。`set` 的两个作用范围都必须先成功读取，`admit` 失败时不调用工作 callback。
- 旧 version 1 对象缺少 `locations` 仍由原 `serde(default)` 接纳；只读 snapshot 和准入不重写它。明确更新后新增位置项，原 defaults/projects/version 保留。Agent ID 和位置键仍是现有映射的字符串身份，不新增 trim 或筛选。
- 严格根字段不等于拒绝 defaults/projects/locations 中未见过的 Agent 或位置键；这些仍是原 `BTreeMap` 数据。已知映射值的类型检查、未知版本拒绝和 KEY 缺失时旧 `agent.*.work` 布尔默认迁移均保留。没有增加格式版本或自动修复/删除损坏记录。
- `MetaStore::get_setting` 原先的 JSON/数据库读取错误仍传播；`set_setting` 成功前不会有本片新增写入。当前测试覆盖已解析 JSON 的未知根和数组，不声称覆盖原始重复 JSON 键、全部磁盘错误或未来迁移。

## 锁与准入

每位置 `gate`、全局 `POLICY_LOCK` 和原保存顺序没有生产差异。`admit` 持位置锁完成策略读取与后续准入操作，策略全局锁在读取闭包结束时释放；`set` 先取同位置锁，再在全局锁内读取和保存，释放全局锁后生成 snapshot。新增失败在这些原作用域内返回，锁 guard 正常释放，没有增加反向取锁、异步等待或新的状态表。

原别名归一/更新等待准入的真实临时目录回归仍通过；它证明原锁行为没有被本片修改，不等于所有并发排列或安装版暂停旅程已验证。当前正式数据库没有注入未知/损坏记录。

## 实际红绿与尚未通过项

[红命令收据](red.json)与[原始红日志](red.log)为同一 `work_policy::tests` 筛选：编译成功，4 通过、5 失败，退出 101。三项未知根反例分别实证被接受、callback 被调用、扩展被更新删除；两项数组反例实证读取/准入被接受并重写为对象。无 `locations` 兼容正例和原三个回归保持通过。

[最终绿收据](green.json)及[原始绿日志](green.log)为最终同摘要源码，9/9 通过、退出 0；[fmt](fmt.json) 退出 0。这里只核已有命令与结果，没有重跑。

根任务首轮[完整 Rust 收据](checks-rust.json)不能写成全通过：clippy 退出 0，完整 test 退出 101；[完整日志](rust-1.log)是 **562 通过、5 失败、3 既有忽略**，其中本文件 9 项仍通过。五失败位于协议入站、最终环境及三个版本/工具探测测试。原日志保持，本复核不把不同文件名当成已证明无关联，也不把局部 9/9 扩成全仓出口。

本片尚未安装验收。[前序位置暂停安装记录](../2026-10-01-location-send-pause/README.md)属于此前未修改源码的 `61e8fb4`，不能替代此最终文件的正式安装验证。未知/数组保护的证明仍是自有临时目录与真实 `MetaStore` 的受控证据。

## 后续协议测试断言的有限复核

根任务另行完成有界夹具检查后，授权调整 [`protocol_error_tests.rs`](../../../src-tauri/src/acp_client/protocol_error_tests.rs) 的单个 bridge 测试断言。独立核对该文件为 278 行、SHA-256 `96ebb66f41034ae4e50b2b93ed46a60fead9fc44b69a64ee4404d9bd5d347f42`；没有修改工作策略或诊断生产代码。

该测试仍要求实际入站 protocol 错误、与 null/non-null 行为对应的 matched startup、原登记完整保持、候选清理和秘密 canary 不落日志。若任一分类字段存在，三个字段的实际值必须全部严格匹配；仅三个字段均不存在时允许继续。这符合生产 `try_lock` 失败整组省略的既有非阻塞契约，不把缺失字段视为另一种错误类别。

[`startup_diagnostics/tests.rs`](../../../src-tauri/src/acp_client/startup_diagnostics/tests.rs) 的确定性纯测试保持：无争用时九种入站有限类别及 null/accepted 值严格检查；持锁或 poison 时只留六个基础字段、整组三字段省略，非错误事件同样不能伪装分类。没有放宽生产格式或以阻塞换取日志。本次只读复核未运行该调整后的测试。

随后核对根任务[最终检查收据](checks-rust-final.json)与[最终日志](rust-final-2.log)：fmt、clippy 均退出 0；完整测试命令明确带 `--test-threads=4`，567 通过、0 失败、3 既有忽略，退出 0，本文件 9 项及上述 bridge 例均通过。这是限制测试并发后的实际结果，不覆盖或隐去首次默认并发的失败，也不代表正式安装已验证未知数据保护。
