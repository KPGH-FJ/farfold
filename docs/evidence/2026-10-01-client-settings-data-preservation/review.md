# 前端设置未知根字段保护：独立审查

2026-10-01。只读核对四个冻结源码/测试文件、原保存门控和红绿日志；未运行测试、应用、Agent、安装 helper 或正式数据库操作。结论：本片根字段保护没有发现阻断问题。安装验收及全量检查由根任务另行记录。

## 冻结身份与改动

[source-final.json](source-final.json)的四个 SHA256 均与实际文件一致，最长 541 行：

| 文件                                                                | SHA256                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [setup_storage.ts](../../../src/runtime/setup_storage.ts)           | `4072abc453e8bb432dc071c8446dac1617f346341a2ceb5303e98b38f7aa6d0b` |
| [setup_storage.test.ts](../../../src/runtime/setup_storage.test.ts) | `26c7d590b594dea95c07d7072ccfe8a2dff994ed085a6edb180257f4763d6254` |
| [drafts.ts](../../../src/runtime/drafts.ts)                         | `6a96c25e51c3ee5bb9cb663e06e17471b6b675d34ec4c6ead6bcadf5e8cd0b2b` |
| [draft_storage.test.ts](../../../src/runtime/draft_storage.test.ts) | `10c626e8d25a9e15f49ee87478411660a4ef2b2a672421fba8be7d191f8c82bb` |

生产差异仅在原解析入口增加已知根 key 检查。准备设置允许 `version/completed/pending/progress/selections`；未发内容允许 `version/composers/choice/feedback/queues/activity`。对象和版本门槛仍在，未知根字段在内容发布前拒绝，不先筛掉未知字段再继续保存。

## 保护与兼容路径

`setupStorage.load()` 只有 `parse` 成功才发布 `ready:true` 和已确认选择；失败保留未就绪状态并用现有固定读取错误。`remember` 检查 ready，`complete/forget/flush` 先等待 load，未知记录因此不能进入 `settings_set`。原序列化写循环、revision、agentEpoch 和确认选择规则没有改动。

`drafts.ts` 的检查先于 composer、选择、文件意见、队列和 activity 的恢复。原 [draft_storage.ts](../../../src/runtime/draft_storage.ts) 与[准备时摘要](patch-manifest.json)一致：hydrate 抛错不发布 ready，编辑只更新内存，flush 先读取，读取未成功不会保存。本地编辑在明确重试读取后按原合并规则保留；没有把本片变成新的草稿迁移机制。

原 version 1 的 `selections` 缺省分支继续仅恢复精确的已完成选择；`activity` 缺省仍由原恢复接口处理。两个新增兼容测试均检查只读加载没有写回，再明确编辑/保存并重新加载。原写失败、并发编辑和附件行为没有生产变化，不能由本片额外宣称这些分支的安装版效果。

## 实际测试证据与限制

[红收据](red.json)与[原日志](red.log)为真实行为测试：2 失败、38 通过，退出 1；失败均在未知根记录应拒绝的断言，不是编译失败。两例在断言前已尝试 mutation/flush，但没有执行到其后完整原值保持断言，安装说明没有将其误称为磁盘丢失实测。

同命令[绿收据](green.json)与[日志](green.log)为 40/40、退出 0。六个新增测试覆盖两个未知根反例、两个读取失败写门控及重试、两个旧缺省兼容与冷加载；使用 mock IPC 和独立模块状态。未知根两例在绿版明确核所有调用仅为 `settings_get`、模拟磁盘原对象保持、ready 仍 false，修正读取后可明确重试。

边界只覆盖同版本未知根 key；没有新增格式版本、自动清空、筛选写回或读取失败兜底，也没有覆盖全部嵌套扩展、原 JSON 重复键、外部文件或正式损坏数据。原准备方案和[实现说明](implementation.md)保留各阶段事实，不将这些受控结果当作正式安装或认证/首发完成。
