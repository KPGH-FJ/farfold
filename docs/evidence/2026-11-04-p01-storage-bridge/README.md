# P01 真实SQLite只读保存错误桥接

首轮为1个独立Vitest用例、8次精确Rust ignored-driver调用：第4次返回生产MetaStore生成的SQLite只读回执，旧保存值保持，本地新输入与未保存状态保留，明确重试后写入并冷模块读回。原始命令、结果和边界见first-run-summary.json；原始日志、请求响应、源输入清单及当时7份关键源文件逐字节封存于first-run-original-receipts.zip，源摘要见first-run-source-manifest.json。

源码保留原位置，供精确纳入Git：src-tauri/src/meta_store/recovery_tests.rs的macOS默认ignored driver，以及output/2026-11-04-p01-storage-bridge/下frontend-storage-bridge.test.ts、vitest.config.mts、build-driver.py。普通pnpm test仍只收src/scripts，未引入Cargo前置或新生产入口、依赖、环境开关。

这是受控传输桥接，真实draftPersistence和MetaStore参与；不能称完整Tauri IPC、安装版界面、正式应用重启、物理满盘或Agent验收。临时路径检查不是原子防护，未证明抵抗同UID恶意替换；807项记录也不代表完整前端传递依赖连续冻结。

本次共享testbinary在Cargo释放后被后续编译改写；首轮hash及原始通过结果保留，但旧driver-binding不能直接复跑。未来明确复跑须重新显式构建和绑定实际二进制，并另存新回执；不能修改旧binding冒称原试验。后续退出协调器连通使用独立输入与运行记录，不覆盖首轮。

第二轮只扩展独立fixture的退出连通，原首轮不改。复用source线既有92ac1fe5测试二进制，额外Cargo为0；1个Vitest用例、10次交换中，第6次真实SQLite只读拒绝由实际DraftStartup保存退出事件触发。失败后不派发退出、退出锁释放、受控渲染错误节点和新输入保持；点实际重试按钮后真实保存成功，才记录一次退出请求，随后冷模块读回。见exit-run-summary.json、exit-run-source-manifest.json及exit-run-original-receipts.zip。

退出命令仅记录；React hooks/event、其他存储和非活动工作均为受控条件，不能称安装版界面、真实关闭或完整退出保护通过。新版fixture源码仍在原output路径，默认前端测试入口未变；两轮各自源码与原件ZIP保留各自范围。

可复现入口的最小衔接修订见builder-update-static.json：现在build-driver.py每次显式构建创建独占build-目录保留原件，成功后先把旧driver-binding-exit.json原字节保存到该轮，再原子更新与当前TS一致的binding文件。首轮driver-binding.json和两轮原件均不改。

显式复跑命令为：

```sh
python3 output/2026-11-04-p01-storage-bridge/build-driver.py
corepack pnpm exec vitest run --config output/2026-11-04-p01-storage-bridge/vitest.config.mts
```

这只是手动测试入口，不是默认pnpm test或新增执行队列。该builder衔接修订仅做AST静态检查，尚未实跑；此前两轮通过结果仍分别对应ZIP内当时的源文件，不能代称新builder已执行成功。

机械diff原字节另存builder-reproducibility-original.zip；保留补丁上下文空格，不修改原件，也不把补丁上下文误当源码空白错误。
