# Messages 官方 SDK 本机请求结果

`@ai-sdk/anthropic@3.0.111` 的独立 canary **14 例符合预期，13 次实际请求全部到本任务的 `127.0.0.1` 监听，Node 和准备脚本最终退出 0**。选定值被覆盖的五例是成功复现风险，不能解释为安全交付通过。未运行 OpenCode、正式应用、真实云服务或模型；未读写用户凭据与 Agent 配置。

## 实际材料与准备

- [固定包来源/日期/归档完整性值](sdk-packages.json)：8 项完整运行/peer 依赖均固定，发布已至少 7 天。宽范围只用来核对兼容关系，没有运行解析器选择 latest。
- [准备执行脚本](prepare-and-run-sdk.py) / [准备退出收据](sdk-tool-preparation.json)：8 个官方归档 HTTP 200，实收字节与声明长度一致，SHA-512 integrity 和 npm SHA-1 shasum 均匹配。逐项 manifest name/version/dependencies 匹配；无 optional 运行依赖、无安装脚本执行。采用严格归档条目限制，拒绝路径穿越、链接与特殊文件，包均置于本次唯一 `/tmp` 目录。
- [请求脚本](messages-sdk-canary.mjs) / [最终请求结果](sdk-loopback.json)：Node 22.22.3，固定无价值 canary，输出仅固定 case、公开版本、布尔与计数。所有实际 TCP 由 fetch 检查并固定到本机监听；两个官方域名例只拦截 URL 构造，没有公网请求。
- 最终 `listenerClosed=true`、`openSockets=0`；准备收据 `cleanupConfirmed=true`，再次路径存在性检查确认唯一临时目录已不存在。未改仓库 package/lock、HOME 或 Agent 配置。工具进程只移除 Node 的 preload/模块路径覆盖，再由请求脚本替换两个 Anthropic 测试认证环境值；不读取、输出或持久化这些原值。

## 观测

| 固定例                                           | 实际结果                                           | 产品含义                                                           |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------ |
| 自定义根                                         | 请求路径 `/messages`                               | 自定义根不自动补 `/v1`                                             |
| 自定义 `/v1`、前缀、前缀 `/v1`、末尾斜杠（4 例） | 请求为明确基础地址追加 `/messages`，末尾斜杠被归一 | 应统一中央短测与 Agent 交付地址语义                                |
| 官方裸根与官方 `/v1`（2 例，拦截到本机）         | 两者生成 `/v1/messages`                            | 仅官方精确根有默认补全，不能泛化给自定义服务                       |
| 显式替换模型                                     | 请求模型变成替换值                                 | 后合入的 model.id 会改变实际请求模型；显示名称不证明交付           |
| 显式替换基础地址                                 | 请求改到另一基础路径                               | 后合入 endpoint/options 会改变实际请求目标                         |
| 小写与混合大小写 `x-api-key`（2 例）             | 所选 key 被 header canary 完全替换                 | 头名比较应忽略大小写；不能仅设置 options.apiKey 就宣称隔离         |
| 额外 Bearer 认证头                               | 请求同时携带所选 x-api-key 与 Bearer canary        | 不可允许其它认证头合入本次所选服务                                 |
| 同时提供非空 apiKey 与 authToken                 | SDK 返回错误，没有 HTTP 请求                       | 认证交付应选择唯一模式，不同时提供两种                             |
| 显式空 authToken                                 | 正常请求使用选定 key，没有 inherited key/Bearer    | 在这个固定 SDK 工厂配置中空值不触发额外 token，未推广到 Claude CLI |

7 个普通地址例及空 authToken 例均逐字保留固定选定模型、选定 key、版本头，正文没有 canary。两种 x-api-key 覆盖均真实到达监听，不是只看配置 JSON 推断。详细每例布尔见最终 JSON；不存原始请求头或正文。

## 失败与重跑边界

[sdk-missing.json](sdk-missing.json) 保留原始 SDK 不可用的 exit 2、0 请求，未计入通过。两次 urllib 准备尝试在下载完整性门拒绝，分别见 [首次](sdk-tool-preparation-first.json) 和 [明确 size 拒绝](sdk-tool-preparation-size-rejected.json)：SDK 尚未加载/请求，两个独立临时目录均删除确认。早版收据没有记录被拒的具体包、HTTP 状态或字节数，不能回填推断；固定上限为 8 MiB，确切门因未知。随后有界 curl 归档收集每包的公开状态/实收/声明长度，全部完整并校验成功，不将下载门失败写成 SDK 行为失败。

首次已执行 SDK 的 [请求](sdk-loopback-first-executed.json) 与 [准备](sdk-tool-preparation-first-executed.json)收据同样为 14 个行为预期成立，但 close 回调时 Set 尚有 1 个未处理的关闭回调计数。修复为逐 socket 等待真实 `close`，把监听关闭与零计数纳入最终 passed，再执行同一固定包矩阵；最终计数为 0。首次收据原样保留，不能用最终关闭证据倒填早版。

## 仍须完成的产品验证

这些结果是固定官方 SDK 对独立配置对象的请求行为，**不是整个 OpenCode 的服务交付验证**。下一最小实现仍须在 `acp_client/service_config` 复用已有独立 provider 与 secret-env 交付：明确 model.id / provider npm / API 目标，不允许已知冲突的模型设置、基础地址或认证头覆盖所选服务；对 known inline 冲突先拒绝，不能靠空对象清除其它层配置。

OpenCode v1.18.31 的磁盘/组织策略在 inline 之后合入、启用/禁用 provider 名单、model-level npm/API/header、插件钩子仍是不同待证边界。此前 [研究](research.md) / [实现约束](implementation-boundaries.md) 的拒绝结论继续有效。仅 ACP 返回模型 ID 正确不足证明实际认证头或请求目标正确，不能将 Messages 标记为已安装实测通过。

下一验证应先使用用户明确选择的测试资料目录与本机服务，通过正式官方 OpenCode 的实际请求验证原服务选择、model/API/provider 合入及来源隔离，再安排安装版中央短测→明确选服务→首条消息→冷恢复。真实云服务需要用户明确提供/选择 endpoint、key、model；此次本机 canary 不需要且未获取这些条件。
