# Junie：一次 initialize 输出形态诊断（待执行）

2026-10-01。当前只创建探针和公开预核记录，**没有下载归档、解压、启动 Junie 或修改生产源码**。根任务已有的基线、`probe-run.json` 与候选输入清单保持原样。

## 已核对的输入

[公开来源预核](public-source-precheck.json)与当前[官方目录](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)一致：`junie / 3419.24.0`，归档为 `junie-release-3419.24-macos-aarch64.zip`，唯一入口 `Applications/junie.app/Contents/MacOS/junie`，唯一参数 `--acp=true`，目录环境为空。[官方 GA 3419.24](https://github.com/JetBrains/junie-acp-release/releases/tag/3419.24)仍标记 Latest。发行资产大小、摘要沿用此前[官方元数据核对](../2026-10-01-agent-startup-diagnostics/upstream-followup.md)；本次没有重新下载资产来复核其内容。

新下载需要 **334,525,087 字节，约 319.03 MiB**：旧候选与归档已经清理；旧[真实安全记录](../2026-10-01-agent-protocol-errors/protocol-after-junie.json)仅证明握手前两次 `parse_error`，未保留引发错误的字节形态。本次目的仅为新增这项观测，不换版本、不重试参数。公开归档摘要仅核对本次来源，不是产品新增的二进制兼容门槛。

[initialize-input.json](initialize-input.json)逐项对照当前 [manager.rs](../../../src-tauri/src/acp_client/manager.rs)、[failures.rs](../../../src-tauri/src/acp_client/failures.rs)、锁定 SDK 2.2.0 与 schema 1.9.1：

- `protocolVersion=1`；`clientInfo={name:farfold,version:0.1.7}`，没有额外 title。
- `fs.readTextFile=false / writeTextFile=false`、普通 `terminal=false`；`auth.terminal=true`；`elicitation.form={}`。
- 保留原 `_meta.terminal-auth=true` 与 `jetbrains.air` 的 `sessionFailure` 声明，不增加能力。
- SDK 使用随机 UUID 字符串 ID。本文件使用探针自有同形 UUID，不是旧请求 ID；仅精确匹配这个请求。
- 紧凑 JSON 为 404 字节，随后写一个换行；与旧 metadata 的 404 字节数相符。这里只进行了源码/serde 字段核对，**没有运行 SDK 序列化器**；字段顺序和 ID 不称为历史请求逐字相同。独立只读审查也确认以上默认字段。

SDK 来源：[JSON-RPC 构造与 ByteStreams](https://docs.rs/crate/agent-client-protocol/2.2.0/source/src/jsonrpc.rs)、[v1 client schema](https://docs.rs/crate/agent-client-protocol-schema/1.9.1/source/src/v1/client.rs)、[v1 initialize schema](https://docs.rs/crate/agent-client-protocol-schema/1.9.1/source/src/v1/agent.rs)。输入和相关当前源码的摘要已保存，执行前发生变化即停止重新核对。

## 单次运行边界

[initialize-framing-probe.py](initialize-framing-probe.py)没有网络代码；默认执行只显示“已准备”，不读取候选。根任务复核后才可先下载上述精确公开归档，再显式传入 `--execute --archive <本次归档>`。探针核对归档来源摘要，使用 `/usr/bin/ditto -x -k` 解压到独有临时目录，实际 argv 为：

```text
<本次临时目录>/extracted/Applications/junie.app/Contents/MacOS/junie --acp=true
```

不执行官方安装脚本、登录、`--version` 或其他试探命令；不注册到 Farfold，不安装或选择新组件。环境通过 `env=None` 原样继承启动探针的登录 shell，不读取/打印环境值、不改 HOME、不写外部配置、不加载 Keychain。它不是正式 App 的环境逐字对照；Junie 自身可能读取或写入其官方配置/日志，探针没有以配置隔离或审计 guard 改变该行为，也不宣称外部配置零写入。

根任务已确定本次使用旧正式安装检查的同一 cwd：`/Users/tw/Library/Application Support/ai.farfold.desktop`（`probe_launch_diagnosed` 的 app data_dir）。要求这个精确目录已存在且未跳转到别处，不创建或清空它；仅这一个 cwd，不尝试 conversations 或其他目录。临时解压位置、探针进程环境与正式 App 仍有差异，不能把观察直接当作旧安装失败的完整归因。

只写入上述一条 initialize；不写认证、会话、模型或 prompt 请求，也不回复 Agent 请求。遇到匹配响应、任意请求或 batch 即停止；其他行只分类、不会被修正或喂入另一个解析器继续工作。不会因“跳过非 JSON 行后看到了结果”宣称连接成功。原 SDK 会对某些 malformed 行回复错误，本探针**不模拟这些交互**。

## 内容保护与有界回收

- stdout/stderr 正文仅短暂存在于内存，从不保存、打印、散列正文或回显异常。只记录各流已观察长度、完整换行/尾片段、UTF-8 合法性及错误偏移、BOM/空行/ANSI/NUL/末尾 CR 布尔、固定 JSON 语法类别/错误字节位置/是否在末尾、固定 JSON 根与消息形态枚举。
- Python JSON 分类不是 Rust serde_json 的逐项替代：显式拒绝 Python 默认接受的 NaN/Infinity；重复键语义、超范围数值、孤立 surrogate、深度限制和错误位置仍有实现差异。收据固定标记 `parser=python_json_shape_only / sdkAcceptanceVerified=false`；自检明确展示 `1e400`、孤立 surrogate 与 129 层嵌套只是 Python 形态通过。`initialize_result` 仅表示相关 ID 的 JSON 形态，**不表示 Handshake::decode 接受、连接可用或账号成功**。官方[传输规范](https://agentclientprotocol.com/protocol/v1/transports)仍要求每行有效消息，生产解析不变。
- 每流最多观察 1 MiB，每行最多 64 KiB，总最多 128 条形态；超限立即结束。正常观察至多 45 秒，预留清理时间，子进程总目标上限 60 秒。排空同时处理两个流；收尾再排空最多 16 轮、256 KiB、1 秒。
- 独立新进程组；`Popen` 之后所有设置与写收据均在 finally 回收范围内。结束对本组 TERM；leader 已回收后必须有同组已采 PID/开始时间/comm 仍吻合才允许 KILL，不能只凭数字组 ID 存在。等待有界；记录退出、同组是否仍在及采样到的 PPID 后代身份。脱组或未结束的采样后代使清理未确认、保留临时目录；不根据同组消失声称所有后代已经结束。脱组后代不追杀；返回非零并停止后续操作，保留精确临时位置交根任务处理。短命且两次采样之间脱组的进程仍是观测盲区。
- 只有确认 child、原组及所有已采身份均结束，才清理本次精确临时目录；源归档由根任务独立处置，不扫删、不清用户目录。一次结果存在即拒绝再次执行；中断也写安全收据。脚本本身被不可捕获地终止、内核阻塞或磁盘写入失败仍可能阻止完整收据，不能承诺绝对回收。

## 当前自检

[selfcheck.json](selfcheck.json) / [原始结果](selfcheck.log)：两个 Python 文件语法检查通过，12 个纯内存用例通过，覆盖 canary 不落盘、UTF-8/BOM/截断位置、空行/ANSI、非标准常量、请求/batch 停止、分段换行、输出限制及公开请求字段。没有执行 Agent、下载或读取正式候选；这不是安装验收。根任务仍需审阅后才决定是否执行唯一一次探针。
