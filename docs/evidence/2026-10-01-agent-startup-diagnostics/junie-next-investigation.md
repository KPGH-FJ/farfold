# Junie：下一次只核协议错误的生成分支

2026-10-01，延续 `5b831c0` 安装结果的只读调查。应用与 Junie 未运行；未读取用户配置、凭据、原始协议正文或 stderr；未改生产源码、安装数据或发布 issue。采用 systematic-debugging 的先调查、后提出最小观测原则。本文件不是第二活动计划。

**最值得核验的分支是输入解析/JSON-RPC 形状失败，与合法请求没有处理器之间的区别。**现在不应先补文件/终端能力、换启动参数或解释为账号问题。已有摘要缺少错误码，尚不能确认其中任何分支。

## 已实测与证据缺口

[本次安装](installed.md)中 Junie `3419.24.0` 已启动 Child，在 initialize 阶段提前结束，实际退出码 1；未收到匹配 initialize 响应、未接受握手，候选已删除、未登记。对应[安全协议元数据](protocol-after-junie.json)有两条 outgoing response，错误类别均为 `protocol`，没有入站消息记录，也没有 session/new。

这里的 `protocol` 只表示出站 JSON 有 error 字段，[tap.rs](../../../src-tauri/src/acp_client/tap.rs#L31)没有保存 error.code、ID 的 null/非 null 形状或处理分支。日志本身是尽力写入，缺少入站记录不能单独证明没有收到合法消息；不能用 136/219 字节数反推方法或错误正文。`exitObservedBeforeTerm=false` 也不证明我方 TERM 导致退出。

## 源码定位使下一步更具体

本次核对的 `manager.rs`、`process.rs`、`pump.rs`、`tap.rs`、`startup_diagnostics.rs` 五文件摘要仍匹配[本片安装输入](candidate-source.json)，不是后续 Copilot 源码行为。

| 分支                                              | 固定源码事实                                                                                                                                                                                                                                                                                                                                                                                 | 对 Junie 当前记录的意义                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 输入不是可解析 JSON，或 JSON 不符合 JSON-RPC 形状 | 锁定 SDK 2.2.0 [transport_actor.rs 第 17–56 行](https://docs.rs/crate/agent-client-protocol/2.2.0/source/src/jsonrpc/transport_actor.rs)将其保存为 `TransportFrame::Malformed`，分别使用 ParseError/InvalidRequest；[incoming_actor.rs 第 379–388 行](https://docs.rs/crate/agent-client-protocol/2.2.0/source/src/jsonrpc/incoming_actor.rs)对不是纯响应形状的 malformed 输入生成错误响应。 | 可以产生 outgoing error，却不进入当前入站观察；值得优先区分，但未证实本次走了它。                                |
| 合法请求没有处理器                                | SDK [incoming_actor.rs 第 617–620 行](https://docs.rs/crate/agent-client-protocol/2.2.0/source/src/jsonrpc/incoming_actor.rs)返回 MethodNotFound。Farfold 的[全局处理器](../../../src-tauri/src/acp_client/manager.rs#L489)不认领请求，有 sessionId 的消息要求等待动态处理器。                                                                                                               | 不能由两条错误推成缺某个具体方法；若是合法请求，应在当前桥接观察点可见，仍须排除记录缺失。                       |
| 合法输入的观察边界                                | SDK [jsonrpc.rs 第 239–245、6513–6553 行](https://docs.rs/crate/agent-client-protocol/2.2.0/source/src/jsonrpc.rs)的 `bridge_with_inspection` 只逐条观察合法消息，Malformed 原样转发而不调用观察闭包。Farfold [process.rs 第 297–312 行](../../../src-tauri/src/acp_client/process.rs#L297)正使用它。                                                                                        | 现有安全摘要能确定“没有匹配 initialize”，却不能排除之前的 malformed 输入；仅在全局请求处理器加计数会漏掉此分支。 |
| 已创建会话的请求处理                              | [pump.rs](../../../src-tauri/src/acp_client/pump.rs#L480)在动态会话处理器中处理 permission/form elicitation，其他请求返回固定 internal error。                                                                                                                                                                                                                                               | 本次没有完成 initialize 或创建会话，不能把该后续分支直接当作两条错误的来源。                                     |

[初始化声明](../../../src-tauri/src/acp_client/manager.rs#L509)提供 terminal auth、form elicitation 和既有公开 sessionFailure 扩展；没有声明文件访问或普通命令终端能力。没有固定 Junie 实现证明它在 initialize 时要求这些能力，不能为试过而虚报支持或返回伪成功。

## 固定官方资料核对范围

[GA 3419.24](https://github.com/JetBrains/junie-acp-release/releases/tag/3419.24)及[固定 tag 目录](https://github.com/JetBrains/junie-acp-release/blob/3419.24/registry-ga-staging.json)继续支持包内 `Applications/junie.app/Contents/MacOS/junie`、`--acp=true` 的发行形状；staging 下载地址不能替换实际 GA 归档。

本次只读取得[固定 tag 完整树](https://api.github.com/repos/JetBrains/junie-acp-release/git/trees/3419.24?recursive=1)：SHA `dde94274bb3e2a062bf60157e2153049f273881a`、`truncated=false`，仅 README 和三个 registry JSON。[固定 README](https://raw.githubusercontent.com/JetBrains/junie-acp-release/3419.24/README.md)明确它是发布托管仓库，不是产品源码树；因此未取得此版本的 initialize/客户端请求实现，不能假定某个方法必然被调用。当前[官方 ACP 文档](https://junie.jetbrains.com/docs/junie-cli-acp.html)没有列出 initialize 前必须执行的客户端方法。

旧实际候选及归档已回收，未取得可复用的包内实现清单。本次没有下载 334,525,087 字节归档；若后续确需包内启动结构，再于正式安装回收前保留公开文件/运行环境清单，而不是先重下大包推测 Java/权限。一般发行结构的未知项仍见[旧诊断](../2026-10-01-agent-access-directory-batch5/junie-startup-diagnosis.md)，本次优先级由新的协议错误事实决定。

## 最小无秘密观察方案

1. 下一片若授权实现观测，只扩展**现有出站 RawJsonRpcMessage::Response::Error 观察点**：将 SDK error.code 转为固定 `parse_error / invalid_request / method_not_found / invalid_params / internal_error / other`，仅保存 ID 是否为 null 的布尔及发生于 initialize 未接受阶段的布尔。编码对应锁定 [schema 1.9.1 ErrorCode](https://docs.rs/crate/agent-client-protocol-schema/1.9.1/source/src/v1/error.rs)：ParseError `-32700`、InvalidRequest `-32600`、MethodNotFound `-32601`。不保存原 message/data/code 扩展值、方法字符串、ID 值、输入行、argv/env 或异常详情；无需新请求表、raw 日志、SDK 补丁或替换 ByteStreams。
2. 先用自有受控对端验证：秘密 canary 的非 JSON 输入只得到 parse_error+null ID 分类；合法但未知的方法只得到 method_not_found+非 null ID，原方法/canary 不落盘；合法 initialize 成功、取消与候选回收保持。此任务没有创建或运行这些测试。
3. 之后由根任务决定是否再执行一次同固定发行、原声明 argv 与候选检查 cwd 的 initialize-only 调查，不改 HOME/环境/目录配置，不发 authenticate/session/new/prompt，不读取或保存原始内容。只收集固定分类与现有退出/回收摘要；在实际候选回收前同时记录所选入口的公开文件属性即可，不需要提前增加系统依赖。

若得到 parse_error，先核“程序标准输出出现非 JSON 内容”这一具体兼容分支，仍不推其文本或产生原因；invalid_request 则核 JSON-RPC 形状。若得到 method_not_found，才增加经过公开协议来源确认的**精确方法白名单分类**，未知方法仍记 other，绝不回显或散列任意方法名。若无分类收据，停止按该分支提出修复，保持原因未知。

## 最小贯通建议：v1 有限可选字段，不增加独立记录版本

这一观察仍是现有出站协议记录的安全分类，**v1 增加有限可选字段足够**，不需独立 v3、另一个文件/请求表或修改 v2 启动状态格式。建议三个字段名仅用于后续接口讨论：`protocolErrorClass` 为上述六个固定枚举之一，`responseIdNull` 和 `beforeInitializeAccepted` 均为布尔。最后一项只表示观察时原诊断状态尚未接受 initialize，不解释请求发生的原因。

| 现有落点                                                                                       | 最小改动与边界                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [process.rs 出站观察闭包](../../../src-tauri/src/acp_client/process.rs#L300)与原 `Diagnostics` | 从已经存在的 typed `Response::Error` 取 code 分类及 ID 的 null 形状，从同一连接原状态取接受标志；构造固定元数据后立刻丢弃临时输入。只对 `dir=out/event=response/error=protocol` 添加字段，不抄 `error.message/data`，也不新增 ID 关联表或保留任意方法。 |
| [tap::safe_record](../../../src-tauri/src/acp_client/tap.rs#L59)与 `write_record`              | 保持旧 v1 六字段的验证和重建。仅在上述方向/事件/错误组合下，三个可选字段齐全且枚举/布尔严格有效时重建它们；未知、部分或类型错误的新字段全部去掉，保留合格旧六字段，不能把任意输入对象原样转发。旧 v1 无新增字段仍可读取，v2 验证原样保持。              |
| `Diagnostics::record` 的普通 64 项队列与 tap 文件上限                                          | 使用既有 `try_send`，不阻塞协议、不新建 worker。队列满、文件达到普通记录上限或磁盘失败时可能没有该分类；新增字段不会得到独立 v2 摘要的保留优先级，不能声称无损或“没有记录就没有错误”。本次最低目标是取得存在的错误分类，不据缺失排除任何分支。          |
| [diagnostics::safe_logs](../../../src-tauri/src/diagnostics.rs#L200)                           | 仍由同一个 `tap::safe_record` 重建白名单；若只在落盘处加字段而 validator 不保留，导出会再次剥掉它们。新字段字节计入原 256 KiB/文件、32 文件、2 MiB 总预算；每文件 v2 最后摘要优先机制不变，普通错误记录可能被截断或预算舍弃。                           |
| [现有预览与 ZIP 快照](../../../src/runtime/diagnostics.ts#L37)                                 | 已有 `entries[].text` 无独立协议字段解析，后端重建后的文本进入同一预览/导出快照；不添加新 UI 或重新读取记录。先取得预览，再导出原快照，之后错误不能混入旧包。                                                                                           |

相称回归至少包括：旧 v1 六字段逐字重建继续可导出；合格新字段落盘后又通过 `safe_logs` 进入预览/ZIP；未知枚举、错误类型、缺一字段、错误方向及同名秘密 canary 全部无法出现在新增字段中；普通队列满/文件上限下不得宣称必然保留；预览之后的新错误不能进入旧导出快照。无须重复原完整进程测试，除非后续代码触及启动或回收路径。

若未来产品要求这些分类在日志满时也必定保存，那是另一项明确的保留要求，需要另评估同一 v2 固定槽的有界计数及旧 v2 默认值兼容；本次不顺带扩大，不能以 v1 可选字段冒充该保证。当前只给最小建议，未实现或执行验证；保持生产冻结，等待 Copilot 安装观察结束后的单独授权。
