# 新 API 空表单提示：独立审查

结论：**最终两文件未发现必须修复的问题。** 生产修改只收窄来源变更提示的触发条件，没有降低密钥重填、请求失效或显式操作保护。此次只读审查，没有运行测试、应用、Agent 或凭据操作。

[source-final.json](source-final.json) 的两个文件已重新计算摘要，均与 2026-10-01T02:29:16Z 冻结一致：

- [CredentialSettings.tsx](../../../src/components/CredentialSettings.tsx)：`47c8cd45f3e637841d0121a159e04770858605b8efe0d5c5fc686692fc85e953`，1174 行。
- [CredentialSettings.lifecycle.test.tsx](../../../src/components/CredentialSettings.lifecycle.test.tsx)：`b8b1d7e4e8ca764aa24cc909ec938d713d375ad74f52fc84640b7aecc82edd95`，882 行。

`sourceChanged` 仍无条件清空本轮 Key、使在途模型读取失效并增加操作 revision。只有确有已保存记录或当前输入被清空时，才设置 `keySourceChanged`。新空稿的 `item` 为 null，因此 `sameSavedSource` 和 `retainingKey` 始终为 false；不显示“重新填写”不代表可以复用密钥，仍需首次输入 Key 才能读取、保存或测试。

已保存记录一旦改变实际地址或格式，原 sticky 标志仍置 true；改回原地址/格式也不会恢复旧 Key。重新填入非空 Key 只使提示不再显示，没有重置该标志。再次清空仍需重新填入，未触发自动读取、保存或测试。名称、模型编辑及规范化后未变的地址仍保持原行为。

已核新增和现有组件行为用例：空新稿两种来源变化及改回、补齐非秘密字段后仍缺 Key 且直接调用三个操作不发请求；未保存但已填 Key 的两种变化仍清空并提示，重新输入后提示消失；已保存记录四种变化/改回仍不能保留旧 Key；旧格式保留不能绕过重填；迟到模型读取被忽略，只有重新输入后明确重试才发送新 Key。

[行为红例](frontend-red.json)保留原实现的 2 项失败；[最终定向检查](frontend-checks.json)为 3 文件 59 项通过、类型/两文件格式/diff 检查退出 0。本审查读取这些收据及相应源码，没有重复运行。正式安装界面的提示变化仍由根任务单独验收；组件用例不等于新凭据实际交付成功。
