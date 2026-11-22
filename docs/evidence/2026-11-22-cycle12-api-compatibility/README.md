# 第 12 周期已存 API 选择与官方接法验证

2026-11-22，北京时间。范围为首发 21 家的 S1–S2。Gemini CLI 与 Antigravity 的实际授权继续暂缓。本轮未发真实模型请求。

## 已存服务不可选时的提示

旧界面的「账号与服务」和新对话的「模型与来源」只根据兼容服务数量展示空态。在测试夹具中，未保存 API、已有接口格式不匹配、已有地址不符合声明和资料待完善会得到同类提示。新对话还比准备页少校验一项现有配置的版本。

两处使用同一兼容过滤和提示。确实没有已存模型服务时提示添加。已存服务仍待完善、格式不匹配、地址不符合声明或正在移除时，说明原因并引导检查已有 API 配置。登录密钥按用途排除，接口格式和地址要求来自当前声明。展示要求时不读取或回显用户填写的密钥及不兼容地址。匹配服务继续照常可选。受控回归覆盖空白、仅登录密钥、不完整、空版本、移除中、格式不符、同格式地址不符及有兼容服务等条件。

正式 CDHash `70f2c87e5fd7eefd3342ca280fa5549dd725d328`，可执行文件 SHA-256 `bb3a165ffb3f4784372415bbd458fe50a4791005e57c259a7f6fc18a8c9d3adc`。正常退出换装，264,507 项数据元信息及六份关键摘要一致。前端全量 11,107 项、TypeScript、arm64 打包、签名与本批格式检查通过。正式从 OpenCode 的自有 Atria 草稿打开「模型与来源」，无匹配搜索显示换词提示，搜索 Atria 后读到已选的 Atria-Dawn。回「账号与服务」保留 Atria，暂时返回后原草稿、目录、发送入口和焦点保持。该批正式协议记录 `protocol-v1-1795316438569-0.jsonl` 零 `session/prompt`。当前正式保存的服务均有兼容样本，因此全不兼容等分支只记受控，未改实际 API 服务以构造负例。

## Copilot 请求归属

此前已证明 1.0.114 可以在会话仍打开时通过官方只读接口读到结构化 401。本轮向自建隔离 ACP 会话发送标准 `_meta` 的 `requestId`、`traceparent`、`tracestate`；请求有事件和准确的厂商根消息 ID，ACP 回包和持久事件均未提供这些调用方标识，ACP 回包也未给出该根消息 ID。 [原只读回执](../2026-11-22-cycle12-service-edit/README.md#copilot-厂商失败反馈) · [关联受控回执](copilot-acp-request-correlation.json)

两个同版 ACP 进程同时载入同一个自建会话。只读 `sessions.checkInUse` 在该重开场景返回空数组。A 尚在本机提供方等待时，B 的唯一请求也到达本机服务。在一份完整持久快照中两条提问各有根消息和结构化 401，甚至同用 `turnId:0`，两条 ACP 都返回 `end_turn`。因此会话 ID、游标增量、`turnId` 或 `checkInUse` 均无法独立绑定到 Farfold 发出的原请求。普通 ACP 失败反馈仍待准确关联；现有对话、工具和设置保持。 [并发受控回执](copilot-acp-writer-race.json)

独立官方 SDK 发送亦做隔离对照。使用 1.0.114 的 protocol 4 和同包包装器声明的 `session.create` 嵌套 `inference.providers` 与 `inference.models`，在同一连接核模型后，只提交一次合成 SDK `session.send` 并带 `clientTurnId`。发送回执原消息 ID、持久 `user.message.messageId`、实时与持久 `session.error.originatingMessageId` 一致，调用方 `clientTurnId` 原样保留。另两种创建或接回的试探在发送前失败，未调用提供方。官方 SDK 需拥有发送入口才能作这条关联，与现有 ACP 回执分开。登录、凭据、已存服务和模型、历史、审批、工具、停止、待发与恢复仍需在独立方案中验证。 [SDK 受控回执](copilot-sdk-request-correlation.json) · [官方消息契约](https://github.com/microsoft/copilot-sdk/blob/v1.0.34/nodejs/src/generated/rpc.ts#L37251-L37260)

## Goose 官方 Chat Completions

隔离复用本机登记的 1.59.1，按官方进程级设置选择 OpenAI 兼容服务、地址与模型，在自有回环服务完成首答，读回同一个原对话并手动续问。冷开零推理，续问请求包含原问答。同一服务及所选模型还有标题生成请求，另有模型列表读取。合成 401 返回 ACP `-32000 Authentication required` 和 `turn_failed`。所核运行文件未见测试密钥。 [受控回执](goose-1.59.1-controlled-api.json) · [官方启动方式](https://github.com/aaif-goose/goose/blob/v1.59.1/documentation/docs/guides/goose-cli-commands.md#L651-L661)

有继承的自定义请求头时，选中的新服务会在首答前的模型列表读取中收到旧请求头。Farfold 托管选择保持关闭。需先解决继承请求头和可影响路由设置的隔离，在打开、恢复与发送前同时核对实际提供方和模型，再验证正式入口。测试中使用独立的临时配置目录以隔离用户数据，未改变用户 HOME、配置、凭据或原会话。 [官方配置读取](https://github.com/aaif-goose/goose/blob/v1.59.1/crates/goose/src/providers/openai_def.rs#L58-L133)
