# 队列编辑与恢复：只读审查

2026-10-01（Asia/Shanghai），在 `/Users/tw/Desktop/farfold` 只读检查 `queue_edit.ts`、`Composer.tsx`、`sessions.ts` 及直接相关的草稿持久化路径。没有修改产品源码、增加测试、启动正式应用或执行真实 Agent。

## 本次定向测试

实际执行命令：

```sh
corepack pnpm exec vitest run src/runtime/queue_edit.test.ts src/runtime/sessions.queue-edit.test.ts src/runtime/draft_storage.test.ts src/components/Composer.work.test.tsx src/components/Composer.attachments.test.tsx
```

工具返回收据：

```text
RUN v4.1.11 /Users/tw/Desktop/farfold
Test Files  5 passed (5)
Tests       24 passed (24)
Start at    16:30:10
Duration    2.82s
Exit code   0
```

来源为本轮 `exec_command` / `write_stdin` 的真实返回，进程会话编号 `7795`。本轮没有生成独立 stdout 日志；本页保存该次返回中的命令、计数、时间和退出状态，没有重新运行测试。全部为既有前端定向测试，不计作安装版或真实 Agent 旅程。

## 只读结论

- 热编辑通过 WeakMap 认领同一个待发项对象，不因前项移除而改错目标；冷恢复不凭下标或相同内容猜测目标，编辑文字仍可保留为草稿。见 [queue_edit.ts](../../../src/runtime/queue_edit.ts) 与 [身份回归](../../../src/runtime/queue_edit.test.ts)。
- 保存等待期间取消编辑后改选另一项，旧保存不能覆盖新目标。实际组件回归位于 [Composer.work.test.tsx](../../../src/components/Composer.work.test.tsx)；执行路径见 [Composer.tsx](../../../src/components/Composer.tsx)。
- 草稿保存失败保留内存内容和可重试的保存错误；发送前等待持久化，编辑中的队列不会自动派发。见 [draft_storage.ts](../../../src/runtime/draft_storage.ts)、[保存回归](../../../src/runtime/draft_storage.test.ts)、[sessions.ts](../../../src/runtime/sessions.ts) 与 [队列编辑回归](../../../src/runtime/sessions.queue-edit.test.ts)。

在本次源码范围及上述 24 项测试中，未发现确定的数据丢失、错目标或误发缺陷。这不等于覆盖全部异步排列或冷启动路径。

## 尚未覆盖

安装版按位置暂停与恢复由根任务另行观察。本次没有执行安装版暂停队列的编辑、移除或冷编辑恢复，不能用这些测试替代实际旅程。

`work_policy.rs` 接受未知根字段后重新序列化可能删除该字段，是另一个独立修复候选；本页的测试未覆盖它，也未证明正式数据已发生丢失。
