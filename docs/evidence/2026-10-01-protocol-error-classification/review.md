# 入站有限错误分类：独立终审

结论：未发现阻断。只读核对[方案](proposal.md)、三项生产差异、三个受控测试文件和原始收据；六文件当前 SHA 均与作者的[source-final.json](source-final.json)一致。未运行 Cargo、应用、Agent 或请求，没有改生产源码、测试或收集器。

[process.rs](../../../src-tauri/src/acp_client/process.rs)仅在原入站 bridge 观察闭包中追加固定组，仍返回 `Ok(())`；不增加请求、等待、进程或错误结算。[startup_diagnostics.rs](../../../src-tauri/src/acp_client/startup_diagnostics.rs)只对实际 typed `RpcResponse::Error`分类，入站九类、出站原六类；其余码折成 `other`。不读取错误正文，ID 只取 null 布尔。状态使用 `try_lock`，失败省略完整组，不编造初始化状态；注记不修改启动结果、初始化匹配或进程所有权。

[tap.rs](../../../src-tauri/src/acp_client/tap.rs)按方向、response/protocol 上下文和完整类型组重建记录；出站不能取得新增三类，stderr/部分字段/未知类型均不获分类。message/data/ID/method/env/argv/code 不透传。原六字段 v1 与 v2 启动摘要保持，仍走普通日志预算，没有新保底送达承诺。

已核[真实红收据](incoming-red.json)及[原日志](incoming-red.log)：0 通过、3 失败，确实命中真实 bridge 的类别缺失和 validator 剥离。[最终分类组](protocol-final.json)20 例、[启动失败组](startup-failure-related.json)6 例、[观察状态组](startup-observer-related.json)16 例、[导出组](log-export-related.json)8 例均退出 0；组间重叠，不累加为独立总数。

关键受控反例可达且与本片范围匹配：实际初始化 ID 的错误保留原 `AGENT_INITIALIZE_FAILED` 和旧登记；接受前独立 null Error 后的正常初始化仍为 `matched_result`，不误关联 null；接受后真实 session/new 五种码、自定义/null 与本地 decode/EOF/超时分开。纯状态回归保留已定 Timeout/Cancelled，不能据该观察扩大为真实 Agent 迟到行为已验证。预览/ZIP 回归保留合法入站组与旧版本，剥掉错方向、伪类和 canary；预览后新增记录不进入已审快照。

安装结果仍待根任务分列记录。`beforeInitializeAccepted` 只是观察时点，null 是合法 ID；没有 prompt/auth 请求匹配，类别不能直接证明账号、模型、网络或具体处理根因。队列、文件及导出窗口可丢普通记录，缺分类不能作没有错误的证明。[VT Code 验收路径](acceptance-plan.md)保留旧失败与原选择，最多一次明确短测，不回填旧码。
