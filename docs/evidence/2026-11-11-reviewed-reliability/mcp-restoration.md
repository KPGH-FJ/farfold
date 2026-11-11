# MCP 撤回与恢复：11月11日只读结论

本记录是既有P41调查，未启动Agent、发协议/模型请求或执行恢复实验。原连接、模拟模型单次只读调用及关闭证据继续按原范围使用。

已核Goose 1.52固定官方提交302b60806639ea9f0ae8f053f49f8bf0e88b26f4：[激活准备](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/acp/server.rs#L1183)只在非空mcpServers时合并扩展，空数组不删除旧项；load/fork随后仍会激活保存的对话。官方[会话扩展操作](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/agents/agent.rs#L1479)先改活动集合再保存，故保存失败不等于持久撤回成功。

官方[读取扩展](https://github.com/aaif-goose/goose/blob/302b60806639ea9f0ae8f053f49f8bf0e88b26f4/crates/goose/src/acp/server/extensions.rs#L101)没有先激活Agent，可作为前置读取候选；返回值不区分会话保存与全局回退，也不保证与load原子一致。当前Farfold的空数组及“未新增提供”校验不能据此宣称已撤回Agent保存的项目；脱敏报告里的显示名不能作为删除依据。

下一判别限一个自有空闲对话和一个无凭据回环HTTP项：经官方接口读取基线、添加、核准确新增key与工具清单、按同一归属移除、确认持久回执，再关闭/重开及分支观察旧端点计数；不发送模型提示、不调用工具。保存失败、回执缺失/取消、描述或归属变化保持失败/未知，不继续依赖它的恢复，不猜删其他项目。跨重启归属和前置读取的不足仍待解。

实际“撤回后重开是否复活”尚未运行；不据源码推定已经失败或修好。任何恢复保护须限本次Farfold自有或已撤回项目，尚待设计和验证，不因此给全部官方原有扩展或全部历史新增门槛。NEW-24和已用完Mistral探针保持原限制。

17份源码的路径、SHA与一基行号，5份旧回执和4份旧源码核合结果，以及完整停止条件，保留在output/2026-11-11-reviewed-reliability/mcp-next/。root另核17份SHA及激活、读取、增删保存顺序。此处不是新执行队列，顺序仍由唯一活动计划管理。
