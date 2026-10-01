# 队列计数更正

2026-10-01。`inspect_policy.py` 首版对 `queues[target]` 使用 `len(queue)`，把对象字段数当成待发消息数；所以 [policy-paused.json](policy-paused.json) 中 `queueEntries=2` 不正确。原收据和基线不改写。

16:54:42 只读核对精确目标队列，键名实际为 `blocks`、`uncertainIndex`，不是 `paused`。`blocks` 外层长度为 1，内容未打印或另存；整个队列对象按原采集方式计算的摘要与暂停收据完全相同。因此[更正收据](queue-shape-correction.json)可将该次暂停观测的实际待发数推导为 **1**，与[暂停界面](03-location-paused.txt)一致。这是采集计数错误，不是界面丢失第二条消息。

后续 helper 已改为读取 `blocks.length`，缺失记录计 0，不认识的形状记 `null` 并标记 `unrecognized`，不假装空队列。输出增加 `queueShape` / `queueKeys`，仍不复制待发正文。源码形状见 [drafts.ts](../../../src/runtime/drafts.ts) 的 `QueuedDraft` 与恢复校验；只是只读依据，没有修改产品代码。

6 个纯形状样本和 Python 语法检查通过，没有启动应用/Agent或执行发送。`data-before.json`、`unsent-before.json`、`policy-before.json`、`policy-paused.json` 的原字节摘要已记录并核对不变；原基线目标无队列，计数 0 不受此次错误影响。
