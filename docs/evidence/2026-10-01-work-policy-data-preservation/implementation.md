# 工作设置读取保护：隔离红绿

2026-10-01。唯一源码修改是 [`work_policy.rs`](../../../src-tauri/src/work_policy.rs)：`Policy` 增加 `deny_unknown_fields`；`load` 在反序列化前要求根值是 JSON 对象。新增生产代码 4 行，最终连测试共 451 行。既有固定错误、`locations` 默认、版本检查、旧默认迁移、位置优先级和准入锁保持原行为。

未知根字段和数组根现在令 `snapshot`、`admit`、`set` 返回固定读取错误。它们不重置或改写该记录，`admit` 不运行 callback；完整读取旧 version 1 对象后，用户仍可明确暂停/恢复。未改变历史只读恢复与真实发送各自使用工作设置的边界。

## 实际验证

应用前已逐字核对 [patch-manifest.json](patch-manifest.json) 的源码与 [red-tests.patch](red-tests.patch) 摘要，`git apply --check` 通过。先只应用测试补丁，再运行 `cargo test --manifest-path src-tauri/Cargo.toml --locked work_policy::tests -- --nocapture`。

- [红日志](red.log)及[命令收据](red.json)：编译成功，9 例中 **5 失败、4 通过**，退出 101。未知根字段 3 例实际复现读取被接受、callback 执行、更新丢失扩展；三元素与四元素数组 2 例均实际被读取、准入并改写成对象。旧版无 `locations` 正例及原有 3 例保持通过。
- 只加上述生产保护后，同命令[绿日志](green.log)及[收据](green.json)为 **9/9 通过、退出 0**。覆盖两个更新作用范围、未知数据保持、旧格式明确更新，以及既有别名/准入锁、默认/项目/位置优先级。
- [`cargo fmt --check`](fmt.json) 退出 0；[格式日志](fmt.log)无错误输出。`git diff --check` 退出 0，记录在[最终源码身份](source-final.json)。未运行全量 Rust、clippy、打包或安装。

全部新增用例仅使用自有临时目录与真实 `MetaStore`。未接触正式数据库，没有启动应用或 Agent，也没有构造正式用户损坏数据。准备补丁及原 manifest 身份保留，未因实际应用而覆盖历史记录。

## 交接范围

源码 SHA-256 为 `36807e04c60a96fe1cf259e222641fc96d83e478aa9340ffef17e60ac21cae04`，已冻结并交还 Cargo。根任务接全量检查和正式安装；按位置暂停/恢复的前序安装事实见[独立证据](../2026-10-01-location-send-pause/README.md)，不能替代这份新源码的安装观察。

本片只保护已解析 JSON 的根对象形状与已知根字段，不宣称覆盖原始 JSON 重复键、未来迁移格式或存储损坏的全部类别。当前没有正式用户记录发生上述损坏的证据。
