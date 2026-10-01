# 准备选项完整保留

`ae23da5` 已于 2026-10-01 21:47 安装到唯一 `/Applications/Farfold.app`，21:57 正常退出。正常 Amp / Medium / 已有设置的准备页、暂返目录后继续草稿、未发标记冷恢复及再次读取 Medium 通过，最后只清本片标记还原空稿；全窗口 0 prompt。原 36 索引、40 个原 Agent 摘要及全部未发记录保持；49 项原设置中仅 `agentSetup.v1` 整体摘要变化，内部差异没有基线，不能宣称只改了某一步或所有内部字段保持。见[安装记录](installed.md)与[派生核对](comparison.json)。

旧 `parseSelection` 会静默滤掉非法模型选项值，随后无关 Agent 的普通进度保存可把删减后的整份设置写回。本片发现任一非法选项值即拒绝整个选择，保留读取失败时的写入保护；合法字符串、布尔和有限数字完整保留。只改 [setup_storage.ts](../../../src/runtime/setup_storage.ts) 与[测试](../../../src/runtime/setup_storage.test.ts)，不改认证、模型执行或来源路由。

- 隔离模拟存储的[真实红测](red.json) / [日志](red.log)：6 失败、26 通过，直接对模拟持久对象断言证实 `model` 字段被丢弃；没有向正式数据注入损坏。[修复后同文件](green-tail.log) 33 通过。
- [类型检查](checks-frontend.json)通过；首次 `pnpm test --maxWorkers=4` 被 pnpm 参数解析拒绝，未运行测试，[原日志](frontend-1.log)保留。[更正命令](checks-frontend-corrected.json)后 [139 文件、1,279 项通过](frontend-corrected-0.log)，[构建](frontend-corrected-1.log)、[格式](checks-format-before-install.json)和[打包](checks-bundle.json)退出 0。
- [后台复用](backend-reuse.json)：141 个输入与 `6064d05` 相同，复用其 fmt/clippy 和四并发 575 通过、3 既有忽略；本片未再跑 Rust，不称默认并发问题已解决。
- [源码审查](source-review.md)写于安装前，其“安装待执行”是当时状态；后续[安装身份](candidate-install.json)、01–07 UI 与最终退出收据补充了实际正常旅程结果。[455 输入清单](candidate-source.json)至退出无变；[重复应用](duplicate-app-cleanup.json)已精确清理，[7 份原始观测 JSON](raw-format-preservation.json)字节保留。

损坏选项的拒绝只在隔离测试覆盖；正常安装旅程没有新登录、首发、模型主动改选或正式异常注入。真实账号/密钥授权、尚未完成的程序准备与全目录最终同候选验收继续开放；本片不关闭这些条件。
