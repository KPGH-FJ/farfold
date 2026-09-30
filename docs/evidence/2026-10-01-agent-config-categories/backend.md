# 多类别配置保护：后端实现与受控验证

2026-10-01，在 `959fc00` 安装验收后的授权范围内实施。这里只记录 Rust 源码和自有测试对端；未启动 Dirac 或其他真实 Agent、未操作正式应用、未读写现有数据库或外部账号配置。原始安装失败及推断边界见 [diagnosis.md](diagnosis.md)。安装复验由根任务另行记录。

## 实现

- [model_guard.rs](../../../src-tauri/src/acp_client/model_guard.rs)按各唯一 ID 保留全部既有 `model` / `thought_level` 选项，而非每个类别只容许一项。显示顺序不改变；比较集合按 ID 排序，比较 ID、类型与值。已记录 ID 继续沿原保护角色读取当前值，同值时仅改变或省略界面类别不阻断恢复，也不解除该 ID 的保护。新草稿可准备，真实请求准入才锁定和保存；原有对话任一选择变化、消失或换 ID 仍阻止误续答。
- [model_guard/format.rs](../../../src-tauri/src/acp_client/model_guard/format.rs)保存 `_farfoldConfig: 2` 与 `choices: [{id, category, type: "select", value}]` 到既有会话索引 `config_options`。严格读取新版，兼容旧 v1 的 `model` / `thoughtLevel` 和无标记 flat map；未知标记、损坏类型、重复 ID 不落回旧格式猜测。旧单值的 ID 原样保护，flat map 仅按实际 ID 对齐；旧记录未保存的额外模型不放行，额外推理必须确认完整当前集合。没有新表或第二份基线，也不批量改写旧记录。
- flat map 没有保存历史类别；某个旧 ID 现在无法分类时保留为未知阻断，不忽略该 ID、不猜保护角色，也不回显它的旧值。明确的模式选项与既有 `mode`键不因此被纳入模型保护。
- `ConfigCheck`保持原状态和原因种类，新增 `protectedIds`（当前与原记录的保护 ID 并集）和问题的可选 `id`；`current`为完整 `choices`。确认请求仍原样交回当前值，第二个选项在确认前变化也使原确认失效。
- [pump.rs](../../../src-tauri/src/acp_client/pump.rs)恢复参数准入使用完整保护 ID，因此第二项改类别或从声明中消失也不能借恢复传参修改。API 准入改用显式单模型读取方法；[service_config.rs](../../../src-tauri/src/acp_client/service_config.rs)未改，继续要求唯一、精确的服务模型匹配，不把任意匹配项当授权证明。既有 `_farfoldService`随同一次保存保持。

本片没有扩展 `model_config` 的冻结语义，没有自动选择模型、修改推理值、写 Agent 配置或创建真实请求。新旧快照兼容只发生在读取与既有显式保存路径。

## 红绿与回归

初次 [categories-red.log](categories-red.log)编译成功，6 个反例全部真实失败：多类别误阻、新建响应成功仍误阻、换 ID 同值误放、跨类别重复 ID 误放、未知快照版本误落回、旧记录无法确认两个新增推理项。然后 [categories-green.log](categories-green.log)同 6 例通过。

独立审查又分别复现了 [界面类别改变误阻](category-metadata-red.log)和 [旧 flat map 未分类 ID 被丢弃](legacy-unclassified-red.log)，各 1 例真实失败后修复；没有把这两种相反情况统一放行。

[category_guard_tests.rs](../../../src-tauri/src/acp_client/category_guard_tests.rs)最终扩为 12 例，见 [categories-stable.log](categories-stable.log)：

- 自有真实 SDK 对端成功返回新建结果和完整选项通知；没有自动 prompt、设置或关闭请求，也没有新增会话索引。
- 自有对端的一次受控 prompt 准入保存模型与两个推理值以及原 `existing` 来源；断开后换序恢复通过，第二项值改变时阻止续答/确认，第二项改为其他类别时仍拒绝恢复传参修改。原完整记录不变，对端未收到任何设置调用。
- 双模型类别、跨类别重复 ID、非字符串值、未知/损坏新快照、v1/flat map、新增未记录模型、旧 ID 改名、迟到第二项及失败保存后的确认边界。

最终源码的兼容检查命令、用例数与退出码见 [stable-checks.json](stable-checks.json)；中间检查保留在 [focused-checks.json](focused-checks.json)。源文件摘要与行数见 [backend-files.json](backend-files.json)。

| 范围                                   | 结果   | 日志                                                       |
| -------------------------------------- | ------ | ---------------------------------------------------------- |
| 既有纯 ModelGuard                      | 5 通过 | [model-guard-stable.log](model-guard-stable.log)           |
| 原持久化、请求准入、旧数据确认整条回归 | 1 通过 | [config-guard-stable.log](config-guard-stable.log)         |
| 真实模式与旧顶层模式读取/恢复          | 9 通过 | [preparation-mode-stable.log](preparation-mode-stable.log) |
| API 配置与精确选中模型                 | 6 通过 | [api-service-stable.log](api-service-stable.log)           |
| 实际工作目录及旧单模型/推理冷恢复      | 6 通过 | [cwd-stable.log](cwd-stable.log)                           |

首次 `process_cwd`筛选命中 0 个用例，[原日志](process-cwd.log)保留且不计为验证；随后使用实际模块名 `acp_client::process::cwd_tests`完成 6 例。`config_guard_tests.rs`的旧存储断言改为按 ID 查找新版集合中的同一推理值，不依赖数组下标。

这些结果不证明 Dirac 登录、模型服务或首发可用，也尚未关闭安装版读取失败。正式复验应保持原程序、目录、模型和推理值，明确重新读取；不把受控对端请求计作用户账号请求。
