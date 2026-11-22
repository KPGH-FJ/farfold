# 第 12 周期 Goose 本机转发及独立官方接法续验

2026-11-22，北京时间。原 Copilot ACP 对话保持，Gemini CLI 与 Antigravity 实际授权继续暂缓。

## Goose 官方路由的证据

原登记 1.59.1 在隔离环境用进程级设置选择合成服务。对照组实际发送了原合成设置里的自定义请求头、组织、项目和密钥。显式限定已选设置后七次请求均采用同一已选合成令牌，并无旧值。新对话与冷开分别读回提供方 `openai` 和模型 `gpt-5`。另一条会话用官方接口切到 `openrouter`、换回同名模型，冷开即使进程设置仍选 `openai`，也读回 `openrouter`。因此正式入口在三个时点同时核所选来源与模型。 [受控回执](goose-request-isolation-controls.json) · [官方提供方设置](https://github.com/aaif-goose/goose/blob/v1.59.1/crates/goose/src/providers/openai_def.rs#L58-L133)

选中的本机合成服务返回 `307` 时，官方 1.59.1 向另一个自有回环地址重发了会话与标题请求正文，授权头未跟随。官方命令没有暴露同源限制开关。用户批准增加仅供 Goose 本次连接使用的 Farfold 本机转发。转发由 Farfold 持有所选服务密钥，Goose 只收到限本机连接的随机令牌。只接受固定模型及接口，不接收请求方指定的目标，拒绝上游重定向。打开、恢复和发送核提供方，所选模型也受现有设置保护及转发请求校验。同一转发固定一个所选模型，换模型可另开对话。 [官方传输实现](https://github.com/aaif-goose/goose/blob/v1.59.1/crates/goose-providers/src/api_client.rs#L450-L480)

## Goose 正常入口首答、冷续答与 401

本机正式应用 CDHash `8b990faeef206603cc5fbd1f822266d99a2f7a29`。Goose 原登记 1.59.1 的准备页只列出既有兼容的 Xiaomi Chat Completions。用新对话的模型与来源选择 Xiaomi 和 `mimo-v2.6-flash`，在独立空目录从普通发送收到准确短答并显示已完成。正常退出再打开，原会话 `20261122_5` 显示原正文，读入阶段只有 `session/load`，没有自动发送。手动只发一条续问后读到保留旧上下文的预期标记。Goose 原记录有同一原 ID、提供方 `openai`、模型 `mimo-v2.6-flash` 和两条对应模型用量。精确用量及费用归属未从外部账单独立核实。

另一独立对话 `20261122_7` 在测试配置 `FF_C12_GOOSE_401_TEST` 用合成无效密钥只发送一次。Goose 原记录返回 `401 Unauthorized`，用量表无记录。界面明确提示所选 API 认证失败，未显示已完成，后续发送保持暂停。随后点停止未获明确确认，正常退出释放连接并保留失败状态。原失败对话修好密钥后继续的流程仍待验证。测试配置及失败对话保留以供复验，已恢复原 OpenCode 草稿、Atria 和原目录。 [正式界面及脱敏原件核对](goose-installed-route.json)

定向 Rust Goose 测试 9 通过，覆盖旧凭据隔离、固定模型、拒绝跨目标重定向、401、流式转发及连接关闭。Rust Clippy、前端类型、11,108 项前端测试、格式、arm64 正式打包与签名验证通过。停机期间 264,507 项数据元信息和六份关键摘要保持。独立源码复核完成。

## Copilot SDK 的历史、审批、停止与恢复

官方 1.0.114 SDK 协议 4 的隔离样本，用新进程恢复同一原 ID，读回原问答，冷开零推理，手动续问后包含原上下文。真实写文件审批用原请求 ID 和工具 ID。拒绝后未创建文件，允许一次后写入预期 15 字节并读到成功终态。生成进行中关闭传输时合成上游连接结束，重开原会话可手动继续。 [历史与恢复](copilot-sdk-history-stop-recovery.json) · [审批回执](copilot-sdk-permission-allow-reject.json)

独立样本只放行一个精确长命令。系统验证该原 SDK 进程下 `/bin/sleep 14` 子进程在官方停止后退出，两个对照进程存活；在线 idle 标记中止，持久原工具有开始、没有完成回执。另一条写文件等待审批时断开，重开能读到已发生的审批和工具开始，官方已无该原待答请求，提交原决定返回 `false`，文件一直未创建。恢复时不能把原审批重新呈现为可点状态，工具终态仍待官方证据。以上未改变 Farfold 的现有 ACP 对话，也没有运行真实模型或使用真实凭据。 [实际子进程停止](copilot-sdk-subprocess-stop.json) · [待审批时断开](copilot-sdk-pending-after-reconnect.json)

## Codex 官方新版零模型前检

在独立临时目录准备官方 ACP 2.9.0 和配套原厂 CLI 0.171.0。原生初始化通过，后续给系统偏好只读权限后也读到了配置要求。禁止旧历史写入，原安装标识的文件身份、权限、内容摘要保持。账号读取 `-32603` 明确为工作区路由查询需要联网。新建线程在此前检中仍被拒，未获得所需的实际只读权限回执。原单次模型授权未用，现有 Farfold 登记和原对话保持。 [初次前检](codex-0.171.0-preflight.json) · [配置要求与账号查询](codex-0.171.0-config-diagnosis.json) · [只读线程检查](codex-0.171.0-permission-only.json) · [官方只读预设](https://github.com/agentclientprotocol/codex-acp/blob/v2.9.0/src/AgentMode.ts#L49-L76)
