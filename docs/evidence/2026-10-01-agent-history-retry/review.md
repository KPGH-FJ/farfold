# 历史重试独立审查

结论：最终八文件范围内未发现剩余阻断。审查为只读源码、差异与已有检查收据核对；没有运行测试、应用、Agent 或 Cargo，也没有读取外部配置或历史正文。本结论不替代安装验证，`59985da` 的 [siGit 重试失败](../2026-10-01-agent-history-recovery/installed.md) 保留为失败事实。

## 最终身份与检查

已按 [最终八文件摘要](source-final.json) 核对三个生产文件和五个测试文件。生产身份如下；完整测试摘要以该收据为准。

| 文件                                                            | 行数 | SHA256                                                             |
| --------------------------------------------------------------- | ---: | ------------------------------------------------------------------ |
| [sessions.ts](../../../src/runtime/sessions.ts)                 | 1500 | `b5e8f6f9a9d357b2004b621617e8e4de3d779608a88fee6f2837c57eec834642` |
| [session_recovery.ts](../../../src/runtime/session_recovery.ts) |  255 | `a1abdf4d28af985574983bacdd4ba44b880b0b0eedbfc5f5af48474fff2aeab9` |
| [strings.ts](../../../src/runtime/strings.ts)                   |  689 | `9696678d34752ef64ca4d18c56d33d23c6ac83fffa2391c541ffed2d94bfe1c1` |

[最终相关检查](frontend-centralized-final.json)及其[日志](frontend-centralized-final.log)为 12 文件、184 项通过，其中 24 项是本片有状态路由回归；[最终类型检查](frontend-centralized-typecheck.json)退出 0。新增提示已按 [PRODUCT 文案原则](../../../PRODUCT.md#6-文案原则)移入集中字符串表，文字与行为未变。四个旧测试文件仅补只读目录响应，原断言未削弱。

## 已核边界

- **关闭后再读取。** 普通重试和列表重入共用 `openTarget` 的同一关闭、读取 Promise。有状态 IPC 对端保留已打开路由，重复打开会真正抛出 `already open`。关闭未确认或失败时不发第二次读取，不把原历史失败改成普通断线，也不丢正文、队列、模型及来源保护。关闭期间目标已被移除时，归属检查阻止读取与失败占位重建。
- **精确目标。** 已有精确目标直接走原入口。仅在需核对旧路径时复用只读 `agent_work_get` 的规范化目录，随后按 Agent、目录、会话 ID 精确查找；不按会话 ID 模糊选取，不应用工作策略返回值，不改索引，不增加别名表。helper 回调的是 `openTarget`，没有递归规范化。
- **成功之后仍可重入。** 初审确认“唯一失败目标后来读取成功，旧路径列表再次打开”仍可能撞已有路由。最终使用既有 `resumed` / 历史失败事实决定是否检查目录；本应用标记的目录检查失败占位可独立再次检查。三个独立 Agent 反例先出现 [3 失败、21 通过](frontend-after-success-red.log)，最终全部通过；成功重入复用原状态，不重复关闭或读取。
- **输入不合并。** 本次目录校验失败的内存标记不持久化。只有默认空占位且没有正文、队列、编辑稿、待发送状态或其他保护值时才可移除；有内容则保留原页并显示固定说明。目录检查失败和内容冲突两条错误分支都保留独立队列；不把原路径输入搬到另一个目标。
- **事件归属。** 等待关闭时仍接收旧连接的真实断线。新读取开始前撤销旧 channel 资格，后续迟到旧事件不能删除或污染新 channel。真实断线清除 `stopUnconfirmed` 是既有语义，首轮要求恢复该标记的错误测试预期已纠正，不把它算作生产修复。

后端未改。已核 [session_close](../../../src-tauri/src/acp_client/session_commands.rs)、[close 策略](../../../src-tauri/src/acp_client/session.rs)、[唯一来源选择](../../../src-tauri/src/acp_client/service_connection.rs)和 [mutation 回执](../../../src-tauri/src/acp_client/mutation.rs)：只路由同 Agent、同规范化目录的唯一会话 owner；来源歧义及关闭结果未知仍拒绝。`allowAlreadyClosed` 只接受确证不存在，迟到关闭确认后才能再次使用；真实关闭成功在回复前移除路由并释放操作锁。原 [迟到关闭回归](../../../src-tauri/src/acp_client/lifecycle_tests.rs)支持这条既有边界，本次没有重跑 Rust。

## 证据范围

中间 `frontend-after-success-green` 收据实际退出 1：新 24 项通过，三个旧夹具缺少目录响应；该轮不计最终通过。旧失败和夹具修正保留在 [工程说明](frontend.md)。本审查仅确认实现与受控回归；真实 siGit / Dirac 再次读取、正常恢复反例及安装期间数据保护由根任务继续验证。
