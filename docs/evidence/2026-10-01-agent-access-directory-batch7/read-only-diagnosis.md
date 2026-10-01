# VT Code 请求失败：只读核对

本次仅核对本批已保存的公开登记、界面文本、协议元数据、当前源码及官方固定 tag 源码。没有运行 Agent、发请求、读凭据或用户配置、读取错误正文、修改产品源码或运行编译。以下安装事实仍属于 `26e9592`，不是当前工作区的新验收。

## 已确认的范围

- [登记](vtcode-registration.json)记录目录/包版本 `0.96.14`，自报 `vtcode / Zed / 0.96.12`；安装、initialize 和新建测试对话已成功。公开登录声明为空，没有可选模型。[读取结果](vtcode-result.txt)中的 `Thought level=none` 没有更改。
- [协议元数据](protocol-metadata-final.json)的 `protocol-v1-1790802630090-8.jsonl` 中，唯一 `session/prompt` 时间为 `1790802726414`，三条入站更新后，在 `1790802727462` 出现 `response/error=protocol`，相隔 **1.048 秒**；中间没有其他出站请求。元数据没有请求 ID，不能单靠此文件独立证明回复关联，也不能从 1268 字节推测错误内容。
- [测试对话](vtcode-test-conversation.txt)收到计划事件、随后显示请求未完成，没有目标标记成功回复。[短测结果](vtcode-request-result.txt)保留“重新准备测试”和“打开测试对话”出口。本批没有重试、登录或账号配置，具体失败原因仍未知。

## 官方固定源码线索

1. **自报版本差异有源码解释。** 官方 `0.96.14` tag 的 [Cargo.toml](https://raw.githubusercontent.com/vinhnx/VTCode/0.96.14/Cargo.toml) 中 package 与 workspace 均为 `0.96.12`；[helpers.rs](https://raw.githubusercontent.com/vinhnx/VTCode/0.96.14/vtcode-acp/src/zed/helpers.rs) 用 `CARGO_PKG_VERSION` 生成自报版本。该差异不能证明装错包或解释请求失败。
2. **计划事件不是服务请求成功的证明。** [0.96.12 handlers.rs](https://raw.githubusercontent.com/vinhnx/VTCode/0.96.12/vtcode-acp/src/zed/agent/handlers.rs) 在模型调用前发送计划并完成分析项；后续服务流、生成或其他处理失败可折成内部错误。本次界面计划与这种顺序相容，不能据此锁定模型、认证或网络原因。
3. **登录声明与 tag 源码有待核差异。** 同一 `0.96.12` 文件的 initialize 没有登录声明；[0.96.14 handlers.rs](https://raw.githubusercontent.com/vinhnx/VTCode/0.96.14/vtcode-acp/src/zed/agent/handlers.rs) 则声明两项 agent、一项 terminal 和两项环境变量方式。现场空表更接近前者，但自报版本无法区分这两个 tag，当前材料也不能证明发布归档的确切构建提交。源码中的 authenticate 直接返回成功收据，不能把它当成实际登录验证。

`26e9592` 的 `Handshake::decode` 会保留上述五项有效 ID，并在公开快照中保留其类型；本次静态核对没有发现将这些有效声明整表删空的路径。仍须以实际连接声明为准，不能根据 tag 源码替现场补登录或环境变量交付路线。

## 当前产品错误链

当前 [pump.rs](../../../src-tauri/src/acp_client/pump.rs) 的 `describe_acp_error` 对 `AUTH_REQUIRED` 保留固定标记，其他 SDK 错误转成字符串；prompt 回调随后经 `turn_end_event` 发出失败结束事件。[completion.ts](../../../src/runtime/completion.ts) 对普通错误统一使用固定“请求未完成”说明，认证错误和已验证的结构化失败类别另行处理。它解释了当前通用文案，不能反推本次 SDK 错误码或远端根因。

现有失败结算与短测出口没有把计划当成功；未发现有证据可直接修复的 VT Code 专属产品问题。通用说明缺少细分属于可改进的失败出口，不等于 VT Code 请求问题已被定位。

## 最小下一步

1. **先核官方发布身份，保持只读。** 核对 `0.96.14` release 的 tag/构建提交、发布流程及 macOS arm64 归档来源，解释“tag 源码有五项登录声明、安装记录为空”的差异。保留归档和源码对应关系的不确定性，不升级现有程序、不增加品牌分支或根据描述拼命令。
2. **若做下一片代码，只补通用安全错误出口。** 复用现有 prompt 回调与失败结束事件，保留有限错误类别和固定文案；`AUTH_REQUIRED`、取消、断线、普通 SDK 检查失败保持各自语义。不能用 SDK 数字码直接断言“对端拒绝参数”，因为本地解码也可生成相同码；只有传输层真实关联到本次回复时才记录远端错误类别，关联信息仅留内存，不新增账本，不持久化 ID、message、data 或 stderr。
3. **必要受控反例。** 真实受控子进程分别返回协议错误、畸形结果、本地 EOF、标准认证要求和取消后迟到结果；验证固定说明、失败结算、原草稿/队列/来源保持、无自动重发及错误 canary 不进入界面或安全诊断。该片最多改善通用失败出口，不能算 VT Code 首发通过。真正 VT Code 重试仍须单独授权和留证，不能猜 Key、模型或版本。

本次没有新增安装、请求、登录或恢复通过项；[本批 README](README.md)与[覆盖表](coverage.md)中的 VT Code 首发失败继续有效。
