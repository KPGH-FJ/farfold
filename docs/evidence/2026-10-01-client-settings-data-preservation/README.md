# 客户端设置未知根字段保护

2026-10-01 19:25，`6064d05`（含 `bd65145`）已完成[安装版有限验证](installed.md)：原 Amp / Medium 稿在准备页往返和冷启动后保持，OpenCode 旧历史两次加载及原 Nemotron / 已有设置 / build 保持；经 UI 移除本片标记后原数据摘要恢复，455 输入至退出保持，0 prompt，8 个采样身份结束，重复应用已精确清理。见[派生比较](comparison.json)。18:14 的客户端[红测](red.json)为 2 失败/38 通过、修复后[40/40](green.json)，未知根数据的整条拒绝和零写回只由受控用例证明，正式数据未注入损坏。完整前端 1,272 项及类型/构建、后台四并发复验 575 项（3 既有忽略）、fmt/clippy/格式/打包通过；[此前失败与中断](engineering.md)保留，未称全部解决。文件身份见 [source-final.json](source-final.json)。

以下为原准备记录：[测试补丁](red-tests.patch)及[输入身份](patch-manifest.json)保留准备时的未执行状态，不用后续结果覆盖原始收据。同一 `version: 1` 下，接入进度和未发内容原来都接受未知根字段，但后续普通保存只输出已知字段，可能丢弃原扩展数据。

## 确定范围

- [setup_storage.ts](../../../src/runtime/setup_storage.ts) 的 `parse` 校验已知容器后重建 `Data`，`flush` 只序列化 `version/completed/pending/progress/selections`。合法旧值增加 `future: {text: "retain unknown preparation data"}` 后读取成功，随后记住进度、完成或移除操作可能覆盖该扩展。
- [drafts.ts](../../../src/runtime/drafts.ts) 的恢复入口检查根对象和版本，保存入口只输出 `version/composers/choice/feedback/queues/activity`。合法旧值增加 `future: {text: "retain unknown unsent data"}` 后读取成功，任何草稿编辑触发 [draft_storage.ts](../../../src/runtime/draft_storage.ts) 保存时会删除该扩展。
- 活动计划 [§6.2](../../../plans/agent-access.md) 要求未知格式或读取失败保留原数据。现有两文件的未知格式回归使用 `version: 2`，不覆盖同版本未知根字段；慢保存、失败重试与旧记录确认已有回归，本片不重做这些机制。

## 六个用例与原准备范围

补丁仅追加到 [setup_storage.test.ts](../../../src/runtime/setup_storage.test.ts) 和 [draft_storage.test.ts](../../../src/runtime/draft_storage.test.ts)，各三例，候选文件分别为 517、512 行：

| 存储     | 用例                  | 断言                                                                                                                    |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 接入进度 | 版本 1 加未知根字段   | 读取拒绝且 `ready=false`；`remember/complete/forget/flush` 均不能写回，保存副本与原值一致；修正读取输入后显式重试成功。 |
| 接入进度 | 读取接口失败          | 上述全部写入口无 `settings_set`；原值保持，恢复读取后正常保存。                                                         |
| 接入进度 | 旧记录缺 `selections` | 精确完成记录可读取，不自动写入；明确编辑并成功保存后，冷加载仍保留原模型、推理及来源选择。                              |
| 未发内容 | 版本 1 加未知根字段   | 读取拒绝且 `ready=false`；本地输入可保留，但 `flush` 不能写回；修正读取输入后重试保留本地编辑和已存队列/来源。          |
| 未发内容 | 读取接口失败          | 本地编辑不导致 `settings_set`，原值保持；读取恢复后保存最新输入。                                                       |
| 未发内容 | 旧记录缺 `activity`   | 不自动写入；明确编辑后可保存并冷加载，原来源、队列、文件意见保持。                                                      |

未知根用例先实际尝试修改和保存，再检查读结果、写次数和模拟磁盘副本；并非仅断言某个私有校验函数。两项未知根用例预期在当前源码失败，另外四项是兼容及读取失败控制；实际退出和数量须由后续授权执行记录。

## 最小生产建议

仅在两个恢复入口增加已知根键集合检查；遇未知键整条拒绝，沿现有读取错误状态和写前 `load` 门槛保留原数据。保留 `null/undefined` 表示未保存，以及旧 `selections` / `activity` 缺省兼容。检查对象自身键，不对会话身份、配置 ID 或已有容器键做规范化。

本片不收紧已有嵌套字段的安全处理，不更改注册记录、安装公开输入、附件重新读取策略，不新增格式版本或存储表，不改保存串行、完成确认或移除后的迟到回执规则。正式安装验证可使用合法现有记录进行准备进度、未发内容与冷恢复检查；未知/损坏输入只在夹具中验证，不注入正式数据库。

后续授权后可先应用补丁并执行两文件定向组留真实红，再增加最小根字段检查、运行相关回归及安装验收。建议命令：

```sh
git apply docs/evidence/2026-10-01-client-settings-data-preservation/red-tests.patch
corepack pnpm exec vitest run src/runtime/setup_storage.test.ts src/runtime/draft_storage.test.ts
```

准备阶段仅用 Prettier 从标准输入解析候选测试文本，并执行 `git apply --check`（退出 0），没有应用补丁或启动测试、应用、Agent。受保护源码摘要见[准备清单](patch-manifest.json)；后续输入变化时须重新核对补丁适用性。
