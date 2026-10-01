# 新建 API 表单的密钥提示

本片只修提示触发条件。首次空表单从 Chat 改 Messages、再改回，或先填写地址，不再暗示曾保存或清除过密钥；**首次 Key 仍必填**。已有记录和本轮实际已输入 Key 的来源变更保护保持。

## 根因与范围

正式候选 `637e1ef` 的 [原现场截图](../2026-10-01-agent-service-messages-implementation/02-messages-unsaved.png) / [AX](../2026-10-01-agent-service-messages-implementation/02-messages-unsaved.txt) 显示：新表单没有 Key 或旧记录，仅改接口格式即出现“地址或接口格式已改变，请为此服务重新填写密钥”。

[CredentialSettings.tsx](../../../src/components/CredentialSettings.tsx) 原先对所有 `sourceChanged` 都将 `keySourceChanged` 永久置 true。本片仅在已有记录，或当前 Key 输入非空时置 true，没有新增状态、文案或后端接口。来源变化仍清空 Key、失效在途读取及模型候选；`retainingKey`、旧格式保护、保存/测试准入未更改。既有记录改来源再改回仍要求重新填写，不恢复原 Key。

[生命周期测试](../../../src/components/CredentialSettings.lifecycle.test.tsx) 是另一个可写源文件。精确摘要见 [source-final.json](source-final.json)，两个文件均小于 1500 行。

## 实际检查

- [红收据](frontend-red.json) / [日志](frontend-red.log)：改生产前，生命周期 30 项中 2 项失败、28 项通过，exit 1。两个新反例分别为无 Key 新表单改地址/格式后误提示。
- [最终检查](frontend-checks.json) / [相关测试](frontend-green.log)：生命周期、字段校验、凭据接口三个测试文件 59 项通过，exit 0。
- [类型检查](frontend-typecheck.log)、[两源格式](frontend-format.log)、[diff 检查](frontend-diff.log) 均 exit 0。

新增反例逐次核对地址/格式改变和返回原值没有误提示；非秘密字段完整后仍出现首次 Key 必填反馈，获取模型、保存和短测实际调用均未发生。既有含 Key 草稿变更两例加强提示仍在、重新输入后消失的断言；已有记录改地址/格式再改回四例保持原 Key 不可复用。原在途读取失效、旧记录及其他表单保护测试继续通过。

本片没有运行全量测试、正式应用、真实 Agent、Keychain 或任何 API 请求；以上是受控前端检查，不能替代根任务安排的安装版旅程验证。未修改安装辅助脚本、提交或打包。
