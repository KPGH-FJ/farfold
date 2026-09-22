# J1–J6 问题定位

日期：2026-09-21。源码基线 `5842407`，在此前安装版验收后做源码追踪及真实进程对照。这里只记录诊断，不宣称已修复；未升级或修改 Agent/接入包，未改变模型、推理等级、凭据或应用源码。

## 已确认的根因

### 1. Codex 请求失败：实际 CLI 与当前模型不兼容

- 实际执行文件 `/Users/tw/.nvm/versions/node/v22.22.3/bin/codex` 返回 `codex-cli 0.143.0`。
- 接入包是 `@agentclientprotocol/codex-acp 1.12.0`。设置页的 1.12.0 是接入包版本，不是 CLI 版本；前端 [agents.ts](../../../../src/runtime/agents.ts) 第 282–286 行优先采用握手版本/登记版本。
- 只读核对 `/Users/tw/.codex/config.toml` 的两个非敏感字段：模型 `gpt-6-astra`，推理等级 `high`。诊断未改这些字段。
- 绕过 Farfold 直接调用已登记的接入命令，`session/new` 返回模型 `gpt-6-astra`，纯文本请求仍出现 `requires a newer version of Codex`，与安装版相同。因此错误不是 Farfold 换模型导致，也不是仅仅 UI 无法显示。
- 实验：[codex-acp.json](codex-acp.json)。请求约 19.410 秒收到模型不兼容文本，19.413 秒收到 `stopReason=end_turn`。

### 2. Codex 失败显示“已完成”：接入包降级为文本，Farfold 缺失结构化错误处理

实际因果链：

1. Farfold [manager.rs](../../../../src-tauri/src/acp_client/manager.rs) 第 390–407 行只声明当前表单/认证能力，没有接入包提供的 `jetbrains.air` / `sessionFailure` 扩展。
2. 当前 codex-acp 的 `dist/index.js` 第 25376–25426 行：没有该扩展时，普通服务错误被转换为 `agent_message_chunk`。只有特定额度/认证错误会赋值给失败对象。这次模型错误走普通文本分支。
3. 接入包最终返回 `stopReason=end_turn`，不是 JSON-RPC error。真实直连实验确认，错误文本和正常终止响应同时存在。
4. Farfold [sessions.ts](../../../../src/runtime/sessions.ts) 第 557–569 行仅检查 `error` 与 `cancelled`，其余均记 `done`；第 816–824 行随后允许尝试继续排队消息。

对照实验只改变初始化时的客户端能力声明，保持同一接入命令、CLI、模型和无工具纯文本任务：

- 原能力：错误进入正文，结束响应 `end_turn`。
- 声明 `_meta.jetbrains.air={version:1, capabilities:["sessionFailure"]}` 后：同一模型拒绝被编码为响应元数据中的 `category=service, severity=error`，仍以 `end_turn` 结束，但失败性质可机器读取。见 [codex-typed-failure.json](codex-typed-failure.json)，约 10.400 秒。

因此“仅增加能力声明”仍不够：后端 [pump.rs](../../../../src-tauri/src/acp_client/pump.rs) 第 253–254 行保留 `_meta` 为 `meta`，但前端第 816–820 行丢掉它；`session_info_update` 在第 540–546 行也只处理标题，忽略错误元数据。这是明确的 Farfold 接入缺口。

源代码推断而非本轮实测：当错误仅是普通文本且结束响应仍为 `end_turn` 时，排队消息不会按失败暂停。不能把上轮“失败后暂停队列”推广到此类错误。

### 3. Pi 一直在跑/停止中：pi-acp 等待当前 Pi 不会发送的事件

- 实际 Pi 为 `0.80.2`；已登记的 `pi-acp` 为 `0.0.33`。
- pi-acp 的 `dist/index.js` 第 790–792 行说明只在 `agent_settled` 后结束；第 1205–1211 行对 `turn_end` 不处理、对 `agent_end` 仅改内部标志；第 1212–1234 行才 resolve 待处理请求。
- Pi 0.80.2 已安装 `dist` 的 `.js/.d.ts` 中没有 `agent_settled`。它的 `rpc-mode.js` 第 264 行转发会话事件；第 325–327 行 abort 等待完成后正常应答。
- [pi-native.json](pi-native.json)：直接运行该 Pi 的官方 RPC（`--no-session`，不保存这条诊断历史）。2.516 秒收到 `turn_end`、`agent_end`；4.520 秒状态返回 `isStreaming=false`；4.570 秒 abort 成功。没有 `agent_settled`。
- [pi-acp.json](pi-acp.json)：直接运行已登记的 pi-acp，绕过全部 Farfold 前后端。4.361 秒拼接出完整回复标记；之后等待 8 秒没有 `session/prompt` 响应；12.371 秒发取消，再等 8 秒仍无响应。说明丢失的结束响应发生在接入包这一层，而非 Farfold 丢包。
- pi-acp 第 853–868 行的 cancel 只调用 Pi abort，不直接 resolve 当前请求；它仍等待上述不会出现的结束事件。因此停止也不能结束。

Farfold 的关联缺口：[sessions.ts](../../../../src/runtime/sessions.ts) 第 1172–1197 行发取消后一直等 `turnEnd`；后端取消成功只是通知送出，并不代表 Agent 确认停止。当前没有“迟迟未确认”的可恢复状态出口。这会把外部兼容问题表现为永久等待，但不能用收到正文就伪造完成/已停止。

[ACP 官方规则](https://agentclientprotocol.com/protocol/v1/prompt-turn)要求完成和取消最终响应原 `session/prompt` 请求；文字输出不能替代该响应。本次 Pi 组合没有满足这个完成约定。

## 其余观察的边界

- J1 的进程 cwd 为 `/`：manager 的启动配置没有设置进程 cwd；项目目录传给 `session/new/load`。OpenCode 实际工具 `pwd` 正确，不能将操作系统进程 cwd 不同直接归为项目执行错误。
- UI 禁用术语和路径：目录说明原样进入卡片（agents.ts 第 280 行），Pi 接入包把启动 Skills 信息作为普通消息发出（其 dist/index.js 第 822–827 行），Codex 错误又走正文；属于未区分用户文案与外部自由文本的呈现问题。
- 旧 R5 的 5.5→6 Astra 冷恢复漂移：本轮没有改模型重新制造。已安装 codex-acp `loadSession` 第 28568–28583 行依赖 `threadResume` 返回模型，未传回原模型覆盖；这解释了需进一步检查的位置，但不把它当作本轮新完成的因果验证。
- J1 全新安装、J3 记住批准/并发审批、J6 无登录态认证等仍是未覆盖，不是本轮已定位的失败。

## 修复边界与下一步

- Codex 执行能力：需要验证官方 CLI 与当前选定模型可兼容的组合；保留用户的模型与推理等级，不用自动换模型掩盖问题。本次未升级。
- Farfold 失败语义：在 `acp_client` 边界接收官方扩展并归一化为统一失败状态，同时保留原始元数据；前端统一处理状态和队列。不能靠匹配任意正文里的“error”判断失败，也不能在 UI 写 Codex 专属分支。
- Pi：验证官方 Pi 与 pi-acp 的兼容组合，不 patch/fork 接入包，不在 Farfold 实现第二套 Pi 结束判断；另为长时间未确认停止提供诚实、可恢复的状态。
- 每项修复后仍需同一正式安装包重走相应 J2/J4/J5；本轮协议直连证据只用于定位，不替代安装验收。

## 实验可追溯性

脚本 [probe.py](probe.py) 只读 Farfold 中已登记的命令和 env，继承当前环境，使用同一真实模型与既有认证；只保存事件类型、受控标记是否出现、状态码和有限失败分类，不保存凭据、完整正文或环境值。所有实验结束均清理其自己启动的进程树，结果中的 `cleanup_survivors` 均为空。ACP 新测试会话由 Agent 自己保存；未写入 Farfold 会话索引。

两条初始仪器限制明确保留：`codex-typed-failure-initial.json` 的能力形状最初误用对象，未启用扩展；`pi-acp-initial.json` 最初未拼接流式文字导致标记检测超时，未走取消。修正后只重跑这两项，以上结论均使用修正后的结果。
