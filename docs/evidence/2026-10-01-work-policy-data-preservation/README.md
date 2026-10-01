# 工作设置未知字段保护

当前入口（2026-10-01 18:06）：`41cb5b23` 已安装并正常退出，正常位置策略 `true→false→冷启动 false→true` 及原历史/模型返回通过，整个策略与原 36 索引/40 启动配置/49 设置/全部未发摘要最终保持，0 prompt，5 个采样身份结束，453 输入未变。见[安装记录](installed.md)及[保存收据派生比较](comparison.json)。未知对象/数组只在临时存储夹具测试，未注入正式数据库；不能由正常界面旅程扩为所有损坏数据的安装版验证。

实际隔离红绿见[实现说明](implementation.md)、[红收据](red.json)、[绿收据](green.json)、[作者源码身份](source-final.json)及[独立审查](review.md)。最终全量、前端复用、格式和打包与此前失败的边界见[安装记录](installed.md)和[检查诊断](checks-diagnosis.md)；默认并发全量失败保留，最终 Rust 检查使用四并发，不将其说成默认并发问题已经解决。

以下“源码判断、最小候选、预期红绿、补丁身份”保留 **17:08 应用补丁之前** 的准备阶段记录；其中“目前”“拟定”“尚未执行”“仍待”指当时状态。17:08–17:13 已按授权应用测试、取得真实失败，再完成最小保护与定向验证，随后根任务完成上述安装。上一片按位置发送暂停的独立结果见[前序有限验收](../2026-10-01-location-send-pause/README.md)，不与本片正常策略回归或隔离异常数据测试混算。这不是第二活动计划。

## 源码判断与最小候选

[`work_policy.rs`](../../../src-tauri/src/work_policy.rs) 的 `Policy` 目前仅派生 `Deserialize`，根字段是 `version/defaults/projects/locations`；`locations` 使用 `#[serde(default)]` 保留旧记录兼容。`load` 从 MetaStore 已解析的 JSON 值反序列化，随后只核版本为 1。未声明的根字段会被默认忽略：`snapshot` 可将删减后的对象当作可读；`admit` 可按剩下的已知规则执行 callback；`set` 则将删减后的 Policy 重新序列化写入同一 setting，存在丢失未知扩展的路径。当前结论来自源码链，**尚未执行受控反例**，不声称正式用户数据已经损坏。

三个入口共用 `load`。拟定的最小生产候选是先在 `load` 明确要求 JSON 根为对象，再在 `Policy` 上增加 `#[serde(deny_unknown_fields)]`，保留 `locations` 默认、现有版本检查、旧默认迁移、锁及位置优先级。反序列化错误继续映射到固定“无法读取工作设置”，不把未知内容输出为错误，不自动重置或迁移无法完整读取的记录。本补丁不包含该生产变更。

另需拒绝数组根 `[1, {}, {}]` 与 `[1, {}, {}, {}]`：派生结构体反序列化支持字段顺序形式，不能仅靠 `deny_unknown_fields` 表达本应用只接受对象的存储格式。补丁已补两种独立反例，仍待真实红绿。边界针对对象未知根字段与根形状；不能由此宣称重复 JSON 键或未来格式迁移都已覆盖；当前未添加第二存储模型或兜底猜测。新对话创建和真实消息分别在 [`session_commands.rs`](../../../src-tauri/src/acp_client/session_commands.rs) 通过 `admit`，已有历史读取仍沿既有不发送路线，不扩大保护为禁止恢复历史。

## 隔离测试与预期红绿

[red-tests.patch](red-tests.patch)只向 `work_policy.rs` 已有测试模块增加 6 个测试。每例使用自有 `tempfile::TempDir` 与真实 `MetaStore`，不使用正式数据、Agent 或应用，也不靠等待/重试伪造结果：

1. **snapshot**：存入合法 version 1 对象及未知 `futurePolicy` 根字段，应返回固定读取错误，全部临时 settings 保持。
2. **admit**：同一记录应返回固定错误，callback 的 `Cell<bool>` 必须保持 false；setting 不变。
3. **set**：分别用每 Agent 和整位置两个入口，应拒绝更新并保留原始未知字段及无关 setting；不先写删减结果再报错。
4. **旧 version 1 无 locations**：仍能 snapshot、按已有 defaults/projects 准入；只读阶段不写回。明确暂停/恢复该位置后，已知 defaults/projects 保持，旧规则及新增 location 决定按原行为生效。

5. **三元素数组根**：依次执行 snapshot/admit/set，再统一断言三个固定读取错误、callback 未执行及临时 settings 不变；不能将缺第四项当作合法旧对象。
6. **四元素数组根**：同样核对三个入口，不能因字段数量完整而将数组重写成对象。

授权后先应用测试补丁并运行 `work_policy::tests`，记录真实行为失败，不能把编译失败称为红。预计未知根字段 3 例和数组根 2 例触发现缺口，旧格式正例保持通过；这是待测预期。之后再应用上述对象门槛与单属性候选，复测新增及既有工作策略测试；全量检查和安装验收由根任务统一安排。

## 补丁身份与准备检查

[patch-manifest.json](patch-manifest.json)固定原源码、候选测试文本及补丁 SHA-256。补丁应用后单文件预计 447 行；原源码摘要 `627789f0fa8c303c3ad58c39553f20cde800c46e5b0ca0f722037333aecafc7c`。

仅对内存候选使用 `rustfmt --emit stdout`，输出写入证据补丁，没有传源码文件名。`git apply --check` 退出 0，原源码逐字未变。两项均不是 Rust 编译或回归通过记录。应用前必须重核原摘要；正式候选仍在冻结/安装观察时不得应用。

首版仅含未知字段与旧格式共 4 例，保留在 [red-tests-before-array.patch](red-tests-before-array.patch) 和 [原 manifest](patch-manifest-before-array.json)。当前 `red-tests.patch` 已包含全部 6 例，不应与首版叠加应用。
