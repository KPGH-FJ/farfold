# 普通 UDS helper 冻结检查

候选源码：`../backend-staging/browser_sharing/helper.rs`。

源码 SHA256：`a186832c1e537195f552c49174754fc5e09078454c8c4bd4cbcd56a62991d7f1`。

入口仍为 `run_if_requested() -> Option<i32>`、`MODE`、`CAPABILITY_ENV`。普通 UDS JSON lines 承载 hello、request、response、written、stop、stopped、failed。候选没有 SCM_RIGHTS、recvmsg、FD 转交或扫描。单 worker 非阻塞轮询保留 stdin/stdout；written 仅在整帧 stdout 写完后发送。

停止修复：非关闭 ACK 排在已排 request/written 后；ACK 全写前暂停 stdin；已有未转发 stdin 缓冲则关闭 stdout、确认 closed 后退出。部分页面已写时也关闭 stdout，再发送停止确认。控制通道失败不能表示 broker 已收到 ACK。非关闭且没有旧缓冲时可保留通道供下一次授权。

`main.rs` 是独立 runner 源码；使用现有缓存 libc/serde_json，以 rustc edition 2024、`-D warnings` 编译成功。没有新依赖、生产修改或 GUI 启动。

`test_relay.py` 实际运行 12/12 通过，仅使用自有临时 Unix socket、合成 capability 与独立子进程管道。结果见 `relay-results.json`、`relay-tests.log`。覆盖正常 written/单 inflight、未写页面取消、非页面保留、部分页面停止、显式关闭、两端 EOF、stdout 1 秒写期限、UDS 背压、旧已缓冲请求关闭、FIFO 及 ACK 待发时 stdin 暂停。

保留的失败证据：`relay-tests-first-run.log` 为 9/10，1024 字节 socket 接收缓冲低于 Darwin POLLOUT low-water，测试在 hello 阶段结束；夹具改为 4096 字节后仍真实迫使 65 KiB 控制帧部分写入。`relay-tests-second-run.log` 为 11/12，错误地在 stdin 管道写端查询 FIONREAD；改为保留自有读端观察后证明 ACK 完整写出前没有读取新 stdin。上述修正只改测试夹具。

边界：本次不是实际 Agent 或 Tauri 联合验证；该项由主任务执行。协议依赖 broker 将旧 response 排在 stop 前，并取消停止期间的旧任务。1 秒期限内无法完成控制写入时允许失败退出，不声称停止 ACK 已送达。已进入 stdout 管道的字节不能撤回，停止 ACK 保证不再追加旧正文。

`manifest.json` 只列源码、runner 源码、测试源码、说明和结果/失败日志及其 SHA256；不含可执行文件、rmeta、socket 或 capability。

正式仓库 Clippy 窄修复核：将 write_stdout 的两个相同错误分支合并，不改变成功、WouldBlock 或 Interrupted 行为。此目录已按最终仓库源码重新编译并完整复跑 12 项，仍全部通过。修正前源码及原 12 项结果保存在 pre-clippy/；本次编译记录见 compile-after-clippy.json。
