# Junie / Minion 安装观察：独立审查

本次只读核验已保存的安全协议 JSON、公开包元数据采样、注册状态及界面文本，并读采样脚本。没有运行应用、Agent 或 Cargo，没有读取 stderr 正文、原协议正文、用户配置或凭据，没有改变生产文件。正式候选身份见 [candidate-install.json](candidate-install.json)，本文件不替代最终退出、全数据保护和导出验收。

## 已实测结果

| 范围             | Junie                                                                                                                 | Minion Code                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 对应安全日志     | `protocol-v1-1790808908832-2.jsonl`                                                                                   | `protocol-v1-1790809023339-3.jsonl`                                      |
| 初始化           | 各发出一次 `initialize`，没有匹配响应、没有接受握手                                                                   | 同左                                                                     |
| 新分类/输出观察  | 两条 outgoing `parse_error`，均 `responseIdNull=true`、`beforeInitializeAccepted=true`                                | 一条 3,637 字节 stderr 标记，没有保存正文，未观察到出站错误分类          |
| 最后启动摘要     | `ended`、`exitCode=1`、`exitSignal=null`、`childReaped/groupEnded/connectionRemoved=true`、`candidateCleanup=deleted` | 同左                                                                     |
| 退出与 TERM 观察 | `exitObservedBeforeTerm=false`，不能确定二者因果                                                                      | `exitObservedBeforeTerm=true`，只表明 owner 在请求 TERM 前已经观察到退出 |
| 注册与目录       | `registered=false`、`directories=[]`                                                                                  | 同左                                                                     |
| 界面             | “连接在检查完成前结束，请检查程序后重试”；尚未安装、0 份安装，使用按钮禁用                                            | 同左；uv 与 Python 分别显示已准备好                                      |

依据：[Junie 协议收据](protocol-after-junie.json)、[Minion 协议收据](protocol-after-minion.json)、[Junie 注册](junie-registration.json)、[Minion 注册](minion-registration.json)、[Junie 界面](junie-result.txt)、[Minion 界面](minion-result.txt)。两个失败目标均无 `session/new`、prompt 或 `authenticate` 记录。整份协议采集同时包含原 Amp/Copilot 自动读取的两次 `session/new`，因此不能把整个安装观察称为 initialize-only。记录缺失仍受普通队列及采集窗口约束。

两份协议收据都保留了同一 Junie 文件；它们是前后采集快照，不能把重复出现的两条 `parse_error` 计为第二次 Junie 执行。Minion 是后一个新文件，归属仍结合此次操作顺序与时间，不是诊断内另存 Agent 身份。

## 公开安装材料与实际执行的区别

[junie-bundle-later.json](junie-bundle-later.json) 在 06:55:08 采样到本次 `install-MBI4Xq` 下的 `Applications/junie.app/Contents/MacOS/junie`：198,928 字节、模式 `0755`、系统 `file` 识别为 arm64 Mach-O；Info.plist 的公开版本为 `3419.24`，执行入口字段为 `junie`。[采样脚本](observe_junie_bundle.py) 不执行候选。它足以排除“此次采样入口没有执行权限/不是 arm64 文件”这种直接猜测，但不是完整归档、运行时系统依赖或实际执行字节的一致性证明。

[minion-metadata.json](minion-metadata.json) 在 06:57:03 同一 `install-vISxis` 候选内观察到 `minion-code=0.1.44` 与 `agent-client-protocol=0.12.1` 的 `pair_observed`。此前、此后部分采样为 `partial`；60 秒有界扫描共读 23 次元数据、有 1 次读取错误、无目录数量上限命中。[脚本](observe_minion_metadata.py) 只保留 Name/Version，不导入包、不读取配置或日志。该结果证明此时存在这组公开分发元数据，不证明进程实际导入的模块路径/字节，更不等同本次 traceback。

此前 [Minion 公开接口调查](../2026-09-30-agent-access-uvx/minion/README.md) 已静态核对 `0.1.44` 顶层导入 `ModelInfo`、`SessionModelState`、`SetSessionModelResponse`，一次限定 SDK 检查确认缓存官方 `0.12.1` 的这三项不能导入。当前版本组合采样使这条调查线索更具体，但没有取得本次异常类别，仍不能写成“已确认此次失败由这三个导入导致”。同为 3,637 字节也不是正文或异常一致性的证据。

## 最小下一步与边界

1. **Junie：优先核实官方 ACP stdio 输出与启动分支。** 本次观察是固定 `parse_error`，不是 `method_not_found`；先前“可能是合法未知方法”的分支不能作为这两条错误的解释。结合 [固定 SDK 的只读调查](../2026-10-01-agent-startup-diagnostics/junie-next-investigation.md)，下一项应核对官方 `--acp=true` 是否提供纯逐行 JSON 输出及日志分流，并在获准后只采集 malformed-frame 的有限结构类别。现有记录没有具体行、方法或错误正文，不能猜测是哪段 banner、堆栈、换行格式、Java 缺失或账号问题；Null ID 和观察时尚未接受握手也不能识别处理器或证明退出因果。没有新依据前不重复同条件安装，也不放宽握手准入或过滤未知正文来伪造成功。
2. **Minion：将本次版本组合与已有公开接口复现材料并列。** 下一项有判别价值的证据是这组官方包的三项公开类型存在性及顶层导入关系，或经安全白名单确认的实际异常类别；仅重复旧缓存导入或同条件安装不会确认本次异常。可整理无用户路径/秘密的官方包复现材料，待官方支持此 SDK 组合或调整依赖/发布修复后再验证。Farfold 不改外部包、不私自固定 SDK、不代写用户配置；uv/Python 准备完成不代表包可启动，也不能把这里的失败显示成“账号未登录”。

当前收据的有限结论自洽，没有观察到安装准入被放宽或失败候选发布。两项仍是实际连接失败；认证、模型、首条成功消息和续接没有完成。退出码和回收状态来自生产 owner 的固定摘要，不能扩大为本审查采样过所有 OS 进程身份。
