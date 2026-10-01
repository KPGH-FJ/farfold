# 归档目录身份：独立源码审查

最终审查未发现阻断问题。本次只读源码与已保存收据，没有运行测试、应用、Agent 或正式数据库操作。审查时间、11 个文件的 SHA-256 与行数见 [机器摘要](source-review.json)。

后端六文件逐项匹配 [最终冻结清单](backend-source-final.json)，前端五文件也已核实；全部不超过 1500 行。首绿后的生产差异仅为 `session.rs` 与 `meta_store/archive.rs` 两处目录错误文案统一，最终 alias 14 项与格式检查已再次通过。没有把首绿清单当作最终身份。

已核的保护边界：

- [前端归档入口](../../../src/runtime/archive_admission.ts) 保留原 raw 状态保护，核实 canonical cwd 后等待未发内容保存，再同步复查 raw 与 canonical 两个精确 key；保存或目录核实失败不会继续归档。`IndexRow` 为 type-only 导入；[sessions 接线](../../../src/runtime/sessions.ts) 没有新增别名表。恢复归档仍走原 touch 与 metadata 更新。
- [后端准入](../../../src-tauri/src/acp_client/session.rs) 自行核实真实 cwd。`expectedCwd` 只能否决与前端刚核目标不一致的操作，不能选择连接或授权归档；[IPC](../../../src-tauri/src/acp_client/session_commands.rs) 保持其可选，恢复操作不依赖它。raw/canonical 两份现有预留交给同一 owner 或存储 future；同一个 life 去重，两个不同 owner 拒绝，跨目录相同 native ID 不借用另一连接。
- [pump](../../../src-tauri/src/acp_client/pump.rs) 保留运行、审批与未知结束的忙状态保护，调用方放弃后预留不会先于实际操作释放。[存储事务](../../../src-tauri/src/meta_store/archive.rs) 重读原行并比较 Agent、cwd、native ID，再次真实解析 cwd 与捕获目标比较；原 key 和 canonical key 均通过既有未发内容检查，只更新原索引行，不迁移身份。

这分别覆盖“前端核到 A 后，后端首次解析已变 B”和“后端捕获 A 后，等待至事务时已变 B”两个窗口。资料文件夹缺失或不可核实则拒绝归档，恢复归档仍可执行；没有引入缺失路径祖先推导。检查不等于锁定文件系统，也不声称解决所有历史别名改指。

真实红例均运行到行为断言：[前端 3 项失败](frontend-red.log)；后端分阶段 [3 项](backend-red.log)、[7 项](backend-boundaries-red.log)、[2 项](backend-retarget-red.log)、[1 项](backend-expected-red.log) 失败。阶段存在重叠，不累计为独立用例数。受控范围含 canonical 草稿/队列/意见/首发指针、运行连接、不同目录隔离、调用方放弃、目录消失/改指与行身份变化；没有在正式数据中注入这些状态。

已有绿收据：[前端定向 46 项](frontend-focused.log)、[归档筛选 31 项](backend-green.log)、[最终 alias 14 项](backend-directory-final.json)、[审批 1 项](backend-permission-green.json)、[工具 3 项](backend-tools-green.json)、[最终格式检查](backend-fmt-final.json)。根任务的 [完整前端收据](checks-frontend-final.json) 与 [日志](frontend-final-1.log) 为 140 文件/1290 项、类型与打包均退出 0；[完整 Rust 收据](checks-rust.json) 与 [日志](rust-2.log) 为四并发 589 通过/3 项既有忽略，fmt/clippy 均退出 0。这些是收据核对，并非审查者重复执行。

[两份原始收据格式保留清单](raw-format-preservation.json) 的字节摘要已核实。安装旅程尚不属于本次源码结论；正式索引的目录目前均为 canonical，后续普通归档安装验证不能被描述成真实 alias 复现。
