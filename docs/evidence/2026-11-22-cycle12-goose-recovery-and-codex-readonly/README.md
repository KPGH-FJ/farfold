# 第 12 周期 Goose 401 恢复与 Codex 只读续验

2026-11-22，北京时间。正式应用 CDHash `8b990faeef206603cc5fbd1f822266d99a2f7a29`。Copilot 原 ACP 对话保持，Gemini CLI 和 Antigravity 实际授权继续暂缓。

## Goose 原失败对话恢复

在原 401 样本 `20261122_7` 冷开回看，只加载历史。用户在独立 `FF_C12_GOOSE_401_TEST` 更换密钥，保留原服务 ID、`https://api.xiaomimimo.com/v1`、Chat Completions 和 `mimo-v2.6-flash`。普通 `Xiaomi` 配置摘要保持。保存后无自动发送。正常退出、重开同一对话，旧 401 及未自动重发提示仍在。收起提示并输入原短句时，协议仍只有初始化和历史读取、Goose 原对话用量为零。

从原对话只点一次发送。Farfold 收到准确标记并显示已完成。Goose 原记录中同一 ID 追加一次人工请求和对应答复，用量新增一条 `mimo-v2.6-flash`，提供方 `openai`。再正常退出并冷开，原 401 与新答复同时可见，只读历史，整个续验总共一条出站提示，无工具请求、无新对话。未核外部账单，前批未知停止回执保留。 [正式续验回执](goose-401-recovery.json) · [原 401 及停止回执](../2026-11-22-cycle12-sdk-and-goose-isolation/goose-installed-route.json)

源码既有密钥更换测试通过。同一服务的连接版本改变，对话所记的服务身份保持。无需改代码或安装。

## Codex 账号与实际只读前检

官方 Codex CLI 0.171.0 新版独立临时对话回报实际只读、工具网络关闭、`gpt-6-astra / Ultra`、原提供方 `openai` 和用户审批，空历史且没有持久路径。单独通过官方账号接口验证当前已有 ChatGPT 登录和官方工作区路由，脱敏回执只保留账号、套餐、工作区字段是否存在。原安装标识保持。 [实际只读](codex-readonly.json) · [官方账号回执](codex-account.json)

上次正式样本的原厂 CLI 是 0.155.1，原记录没有实际账号标识。该版本的官方登录检查证实原配置当前已有 ChatGPT 登录，仅回报类型。隔离账号查询未完成握手，仍缺可比对标识。新版同一进程的联合检查仍停在官方工作区路由，沿已通过的账号检查入口附加精确只读规则后复验同样未建立临时线程。两次独立成功保留，待原账号一致性和发送连接的实际权限核合。用户批准的短测尚未发送，本批零模型。 [原版登录](codex-original-login-status.json) · [原版比对](codex-original-account-check.json) · [新版联合停点](codex-combined-check.json) · [沿账号入口复验](codex-account-then-scope.json) · [上次正式首答](../2026-11-21-cycle12-s1-s2-restore/README.md#codex-单次首答与实际权限)

## Kilo 发送前的服务地址核对

官方 7.8.1 隔离样本用同一模型 ID、两个回环模拟地址。高优先级的管理配置覆盖后，原 Kilo 进程报告了变化的模型显示名，模型 ID 保持。该进程的官方 `/config/sources` 只显示来源和次序，能指出管理文件优先，无法给出实际请求地址。两台模拟服务本批均未收到请求。官方提供方全量接口的返回范围超出安全核对单个地址所需，未调用。Kilo 继续按官方设置使用。统一 API 仍待最终地址的窄回执，或官方进程级排他选择和对应实测。 [优先级对照](kilo-managed-source-control.json) · [运行内来源回执](kilo-config-sources.json) · [官方源码链接](kilo-7.8.1-source-review.json)
