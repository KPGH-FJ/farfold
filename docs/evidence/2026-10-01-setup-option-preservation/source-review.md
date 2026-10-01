# 准备选项保留：独立源码审查

2026-10-01。只读核对最终两文件、原始红绿输出和根任务工程检查收据，未重跑产品测试、操作应用或修改正式数据。未发现本次最小修复的阻断；正式安装验证仍由根任务执行，本记录不代表安装通过。

## 最终源码身份

两份当前文件的独立 SHA-256 与本片 [candidate-source.json](candidate-source.json) 相同，均未超过 1,500 行。

| 文件                                                                | 行数 | SHA-256                                                            |
| ------------------------------------------------------------------- | ---: | ------------------------------------------------------------------ |
| [setup_storage.ts](../../../src/runtime/setup_storage.ts)           |  371 | `56cd3032c23e113c398391b156a371aea7c0d8a49f0c0ceeeaa8a8b00e77f04b` |
| [setup_storage.test.ts](../../../src/runtime/setup_storage.test.ts) |  596 | `34856d591fb02c73fbaa8f31c7e5542e506dae8602cfea71dae1f76e76cc0890` |

## 缺陷与修复边界

旧 `parseSelection` 用 `filter` 丢弃 `config` 中的非字符串、非布尔、非有限数字值。`load` 随后发布删减后的进度或确认选择，并置 `ready=true`；另一个 Agent 的普通 `remember` 会通过 `flush` 写回整份设置，使原字段永久丢失。此次受控反例使用隔离的 `settings_get/settings_set` 模拟存储，不向正式数据库注入损坏值。

修复只改变 `parseSelection` 的选项验证：发现任何非法值就拒绝整个选择；合法值完整浅拷贝。进度和确认选择共用该入口，读取在发布 `ready` 前失败，后续写入继续受既有读取门控保护。没有新增恢复格式、丢弃按钮或默认模型替代。

- 合法字符串、布尔和有限数字仍支持；新增正例验证 `false`、`0` 在进度、确认选择及其他 Agent 更新后的存储中保持。
- 没有 `selections` 的合法旧记录仍沿原精确迁移规则读取。只有旧 scope 内嵌选择无法核实时，既有迁移分支保留进度、不发布确认；损坏的进度选择或显式确认选择则拒绝读取整份记录。
- `registration` 的 URL/方法核对与忽略无效页面记录未改变。`installationInput` 的公开参数校验、拒绝文本不再保存以及 `installationInputInvalid` 标记未改变；这些已有明确安全规则不作为过滤模型选项的理由。
- 本次不扩展到其他嵌套字段的格式策略，不修改来源、模型、推理选择或正式旧数据。

## 已核检查与未测范围

[red.json](red.json) 与 [red.log](red.log) 记录旧实现真实执行 **6 失败、26 通过**：进度/确认选择分别使用 `null`、数组、对象作为模型值，先断言整份模拟存储，输出明确显示 `model` 被移除并由无关 Agent 保存覆盖。不是编译或运行器失败。

[green-tail.log](green-tail.log) 记录修复后同文件 **33 通过**，包含 6 个拒绝反例、合法值正例及既有迁移、保存失败、脱敏处理用例。独立审查核读这些结果，未另起测试运行。

根任务 [checks-frontend.json](checks-frontend.json) 的类型检查退出 0；其首次全量命令因 `pnpm test --maxWorkers=4` 参数转发被拒绝，未执行测试，原 [错误日志](frontend-1.log) 保留。[更正命令收据](checks-frontend-corrected.json) 使用 `pnpm run test --maxWorkers=4`，对应 [139 文件、1,279 测试通过](frontend-corrected-0.log)；[前端构建](frontend-corrected-1.log) 退出 0，仍有产物大小提示。

后端未改，独立文件比较见 [backend-reuse.json](backend-reuse.json)：141 个后端构建输入与此前 `6064d05` 候选一致，复用原 fmt/clippy 及四并发 575 通过、3 忽略结果，不扩大为默认并发稳定性结论。

本片安装验证拟观察正常 Amp Medium 准备页导航与冷恢复选择保留。该正式旅程尚未在本审查中执行；受控损坏数据测试不替代它，也不要求修改正式数据制造错误。
