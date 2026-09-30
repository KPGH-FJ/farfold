# 安全启动诊断：源码与受控检查

本片记录连接启动与候选回收的固定事实，未运行真实 Agent、正式应用或用户账号。正式安装版旅程由根任务另行验证；本文件不将测试通过写成真实 Minion/Junie 已定位。

## 实现范围

- `startup_diagnostics` 为每次实际连接维护一份内存快照。只在发出的 `initialize` 转发前记一个请求 ID，并与同方向、同 ID 的返回匹配；请求 ID、正文、错误详情和声明都不落盘。收到结果、收到错误与 `Handshake::decode` 接受分别记录。调用方结果只在确定时写入，后续退出或迟到回复不能改写取消/超时。
- `process` 的唯一 Child 所有者记录实际 spawn、成功 wait 得到的 code/signal、wait 失败、我方 TERM/KILL 请求及程序组结束。未启动 Child、`closed()` 返回、意外退出标志和 wait 错误均不等于已经回收。信号请求不代表送达，也不证明其导致退出。
- `manager` 仅在同一连接实例实际移除时设置 `connectionRemoved`；正常 READY 复用不新建诊断文件。候选原登记和设置保持，成功检查需保留原回收确认；诊断的已观测 Child 回收/程序组/实例移除联合条件也限制候选文件删除，未知或不可读取状态保留文件。
- 单一诊断写入线程沿原 64 容量队列读取固定记录。最新摘要独立于队列，状态变化仅用非阻塞唤醒；队列满已有消息即会唤醒，最后发送者释放后再读取最新槽。没有空闲轮询，磁盘 IO 不持有状态锁，也不参与 Child 回收等待。
- 普通日志仍一次轮换和原上限；另保留 64 KiB 的固定摘要预算。`safe_record` 重建严格枚举、布尔和整数，拒绝非法类型/状态，不透传任意字段。
- 候选临时目录只在原检查已确认安全关闭后显式 `TempDir::close`，随后 `try_exists` 确认。只有 close 成功且路径确实不存在才记 `deleted`；仍存在记 `retained`，检查未知记 `unconfirmed`。不覆盖原启动错误；未确认所有权仍沿原 keep/收据路线。原子选用失败或取消后也显式清理，成功选用保留目录。

## 固定记录

版本 2 的 `startup` 记录含 `ts`、`phase`、`failurePhase`、`startupOutcome`、`initializeResponse`、`initializeAccepted`、`childStarted`、`childReaped`、`waitFailed`、`exitCode`、`exitSignal`、`termRequested`、`killRequested`、`exitObservedBeforeTerm`、`groupEnded`、`connectionRemoved`、`candidateCleanup`。

所有新字段仅为固定枚举/布尔/有界整数或 null。`not_observed` 表示观察器没有捕获匹配响应；不能当作对端绝未发出。`initializeAccepted=true` 可以是迟到解码事实，不保证调用方成功。普通实时连接成功在 ready/status 返回前确定；候选成功在确认回收后确定。

## 证据边界

- [backend-red.log](backend-red.log)：新增 5 项实际受控子进程检查全部失败，确证原实现没有启动摘要。
- [export-behavioral-red.log](export-behavioral-red.log)：6 项 1 通过/5 失败，其中 4 项为尾部、预算、截断行为缺口；预览项首次失败来自字段顺序断言，随后改为 JSON 语义比较，ZIP 仍要求与已审阅 text 逐字一致。前两份 export 编译失败不作行为红。
- [ready-reuse-red.log](ready-reuse-red.log)：同 READY 连接连续复用 40 次产生 41 个日志文件，真实反例。修复后仍只有一个实际 initialize/文件。
- [spawn-cancel-red.log](spawn-cancel-red.log)：真实 OS spawn 失败后选择取消的受控排列，旧提前写结果会保留 `start_failed`，与调用方取消不一致。已删除进程侧提前结果，仅保留真实 spawn 失败原子标志，由调用方选定结果；普通 spawn 失败仍归 `start_failed`。
- 初次 expanded 组中信号时序与迟到 accepted 两项失败来自测试断言超出事实；已保留原日志并纠正。取消后的迟到解码是可记录事实，但不能改变取消结果。中间 `unknown` 摘要读取也改为等待明确调用方终态。
- 最终启动组与退出收据见 [startup-final-stable.log](startup-final-stable.log) 及本目录 `*-freeze-green.log/json`；导出 12 项（该筛选组共 19 项，另含 7 项观察器测试）、实际 cwd 6 项、安装 7 项、tap 1 项的输入未受最后 lazy-open 修正影响，沿已完成 `export-final`/`cwd-final-confirmed`/`install-final-confirmed`/`tap-final-confirmed` 收据保留，不重复运行。
- 导出窗口、全局预算、完整换行及预览快照说明见 [export-design.md](export-design.md)。

未注入真实 OS wait 错误；该未知分层由受控状态反例验证。超时不可改写由短接收器/快照反例验证；实际子进程覆盖取消后迟到回复及 SIGKILL。文件系统不可写/日志打开失败不会产生记录，不能从缺记录推出启动未发生；本片不承诺磁盘刷新已在进程关闭返回前完成。

根任务接管最终检查后，首轮 `rust-full-0.log` 仅因 `acp_client/mod.rs` 声明排序未通过格式检查。根任务已只移动 `startup_diagnostics` 声明到排序位置，重新冻结 428 个输入后格式通过；clippy/全量测试仍由根任务运行。`source-final.json` 保留作者 05:42 冻结，最终候选以根任务重新采集的冻结为准，本记录不提前宣称全量完成。
