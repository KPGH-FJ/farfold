# 候选二的新稿模型交接反例

候选身份见 `candidate2-install.json`。2026-09-28 17:10–17:12 CST，使用正常安装界面：冷恢复本轮 OpenCode 对话，模型页显示 OpenCode Zen/Nemotron 3 Ultra Free / build；真实续答为 `FARFOLD-C2-RESTORE-OK`（截图24）。随后从该对话进入探索，点击 OpenCode 的“开始新对话”。此前全局新稿为本轮选择的 Codex。

实际进入新草稿后，模型菜单显示 OpenCode Zen/Big Pickle，正式数据库的 `unsentWork.v1.choice.config.model` 只读观测为 `opencode/big-pickle`。未向此默认模型发送消息。之后通过正常模型菜单手动恢复验收前的 Nemotron；没有修改数据库或 Agent 配置。

原 `candidate2-before-exit.json` 已记录 OpenCode 的 `completed`、`pending` 和 Nemotron/build 准备进度。代码独立复核确认：已完成后的无上下文探索使用新 scope，卡片无法找到选择，传出 `undefined`；跨 Agent 新稿因此用默认配置创建。这是新稿交接缺陷，不是旧会话恢复改模。输入框内显式切换 Agent 存在同类入口。

修复边界：独立保存明确确认的新稿选择，准备 scope 仍隔离；探索与输入框选择使用该确认结果。管理页只有明确完成才更新，关闭与旧会话只读管理不能覆盖。保存失败不宣称确认，遗留数据不能证明选择时回到确认步骤。候选三须以相同安装操作复验，不能把手动恢复模型记作修复通过。
