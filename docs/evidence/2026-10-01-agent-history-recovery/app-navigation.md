# 历史恢复的规范化 key 返回入口

2026-10-01。范围仅 [App.tsx](../../../src/App.tsx) 与 [App.navigation.test.tsx](../../../src/App.navigation.test.tsx)。运行层可能把路径别名对应的旧 key 替换为实际目录 key；App 原先忽略 `threads.open` 返回值，导致成功或本地历史读取失败后仍指向已经删除的旧 key。

现在 `openRow` 成功使用该次返回的 `state.key`，本地 typed 失败使用 `historyFailureKey(error)`。`ThreadPage` 透传可选 `onRecover` 到 `ThreadView`，重试由持久存在的 App 调用 `threads.reconnect` 并使用同一返回函数，不依赖可能因旧 key 删除而卸载的 ThreadView。

每次打开/重试都有本地操作序号。只有仍属于最新这次操作、当前页仍指向原目标时，才更新可见页面与 thread key。切到 B、Start 或另一次同目标打开，不被迟到结果抢回焦点。暂离设置或准备页时，只修正已有 `routeHistory` 中该次原目标的 key；当前页面不变，返回时才进入规范化目标。没有模糊匹配其他 Agent 的 native ID，没有持久别名表，也不自动创建、发送或修改原稿。

验证使用现有 App hook harness，通过真正的 `ConversationLibrary.onOpen` / `ThreadPage.onRecover` 入口及 deferred Promise。失败由真实 `requireReadableHistory` 生成；带同名 `failedKey` 字段的普通错误不能触发跳转。

- [初始红](app-navigation-red.log)：27 项中 3 项失败，确认成功与 typed 失败都留在旧 key，以及最新同目标操作无法跟随返回。
- [返回与重试入口红](app-navigation-origin-red.log)：30 项中 6 项失败，增加设置返回与尚不存在的 App 重试入口。
- [最终定向结果](app-navigation-final-green.json) / [日志](app-navigation-final-green.log)：34/34 通过，包含成功/空历史、切 B/Start、同目标重复打开、设置返回、旧 thread 消失后的持久重试 owner、重试期间切页和伪造错误字段。
- 两文件 Prettier 通过，单文件分别 1090 / 955 行；最终摘要见上述 JSON。没有运行全量前端、Cargo、正式应用或 Agent。类型检查及同候选安装验收由主片统一完成，本记录不替代真实恢复旅程。
