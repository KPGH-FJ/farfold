# 候选五 Pi 官方修复发布状态核对

核对时间：2026-09-27 09:26:58 UTC（17:26:58 CST）。本记录对应 [候选五失败语义证据](candidate5-pi-failure-semantics.md)，只核实当前登记的无作用域 npm 包 `pi-acp` 及其维护仓库 `svkozak/pi-acp`，不把其他同名包或独立分支当成已批准替代品。

**结论：未发现该包已发布的失败语义修复；当前最新 `0.0.34` 仍保留三处问题，不推荐把升级到它作为本问题的修复。** 官方仓库已有精确对应的开放问题和修复提案，但尚未合并、发布或在本机验证。

## 已发布包与当前主分支

实时读取 [npm 官方元数据](https://registry.npmjs.org/pi-acp)，`dist-tags.latest` 为 `0.0.34`，没有更高已发布版本：

| 版本   | npm 发布时间（UTC）     | 发布源码提交                               | 本轮用途                           |
| ------ | ----------------------- | ------------------------------------------ | ---------------------------------- |
| 0.0.33 | 2026-07-30 17:06:15.441 | `1bfcb394088ed879db8fd936b570bb626017f878` | 与本机已安装版本的既有根因证据对应 |
| 0.0.34 | 2026-09-24 22:50:47.318 | `b0581c9c1d675e634234674484247008b03d69b4` | 最新发布包的静态对照，未安装或执行 |

来源为元数据中的 `time`、`gitHead` 和 `dist.tarball`，另与 [v0.0.34 官方发布页](https://github.com/svkozak/pi-acp/releases/tag/v0.0.34) 交叉核对。发布时间不采用搜索页面中的相对天数。

读取两个 npm 官方发布归档，在内存中解读 `dist/index.js`、source map 和 README，并比较对应源码；没有解包到应用目录、安装依赖或执行包内容。`0.0.34` 的 `src/acp/session.ts` 与 `src/acp/agent.ts` 又分别与实时 `main` 原文比较，均完全相同。已核实的问题如下：

| 路径                    | 0.0.34 / 当前 main 实际行为                                                           | 可复查源码                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto_retry_end`        | 未检查 `success`，仍统一输出重试结束且继续的文字                                      | [session.ts 857–862](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/session.ts#L857-L862)                                                                                                                 |
| `agent_settled`         | 调用 `settleTurn()`；该函数只按是否取消选择 `cancelled` 或 `end_turn`，未带出助手失败 | [事件入口](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/session.ts#L905-L907)、[结束处理](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/session.ts#L459-L468) |
| prompt 内部返回 `error` | 未取消时仍映射成 `end_turn`                                                           | [agent.ts 893–900](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/agent.ts#L893-L900)                                                                                                                     |

可复查 [0.0.33 → 0.0.34 差异](https://github.com/svkozak/pi-acp/compare/v0.0.33...v0.0.34)：结束处理抽成 `settleTurn()` 并增加上下文用量上报，并没有补齐这三处失败语义。主分支核对入口为 [session.ts](https://raw.githubusercontent.com/svkozak/pi-acp/main/src/acp/session.ts) 和 [agent.ts](https://raw.githubusercontent.com/svkozak/pi-acp/main/src/acp/agent.ts)；主分支结论只代表本次时间点。

此外，`0.0.34` 的 [README](https://github.com/svkozak/pi-acp/blob/v0.0.34/README.md#L44-L45) 声明需要 Pi ≥0.81.0；本轮已用 Pi 为 0.80.5。既不能将单独升级接入包视为符合其声明的组合，也没有理由为这三处未修问题连带升级日常 Pi。

## 官方问题与未发布提案

- [Issue #98](https://github.com/svkozak/pi-acp/issues/98) 明确记录非认证 prompt 失败被转成空 `end_turn`，以及重试耗尽后仍宣称继续；[Issue #92](https://github.com/svkozak/pi-acp/issues/92) 对应已接纳请求的服务错误未传给客户端。这些是既有官方仓库讨论入口；本次没有留言或新建问题。
- [PR #104](https://github.com/svkozak/pi-acp/pull/104) 于 2026-08-12 提出，实时页面仍为 Open，提交 `d96b50ba06f8c6237b2d447b80baa10eaee890fd`。其 [差异](https://github.com/svkozak/pi-acp/pull/104/commits/d96b50ba06f8c6237b2d447b80baa10eaee890fd) 增加失败文字、区分重试结果并记录最终助手错误，但仍以 `end_turn` 结束。它不能单独解决 Farfold 的权威失败状态和失败后自动续队列边界；不能靠解析该自然语言把它当作结构化失败。
- [PR #133](https://github.com/svkozak/pi-acp/pull/133) 于 2026-09-18 提出，实时页面仍为 **Open**。09:26:58 UTC 读取的页面内 `headRefOid` 和 [.patch](https://github.com/svkozak/pi-acp/pull/133.patch) 一致为 `467df4a2674354f17a9be16ece91ec3a837dbecf`（提交日期 2026-09-24），不是搜索缓存中较早的 `eefdf98`。其 [精确差异](https://github.com/svkozak/pi-acp/pull/133/commits/467df4a2674354f17a9be16ece91ec3a837dbecf) 删除 `error → end_turn` 转换；追踪助手失败和重试耗尽；在真正结束时拒绝失败请求，使用结构化请求错误，并拒绝关联的排队请求。它更直接对应本轮缺口，但**仍是贡献者提交到维护仓库的提案，不是官方已接纳或已发布修复**。提案自述的测试不等于本机安装验收。

## 方法、限制与下一步边界

GitHub REST API 本次返回 403 rate limit；未绕过限制，改用官方网页、公开 raw 文件和 PR patch 核实。实时 npm 元数据、发布归档、主分支原文及 PR 页面共同支持上述发布状态；不由单一搜索摘要推断。

本次没有安装、升级、执行新包，没有修改 Agent、配置、凭据、HOME 或生产源码，没有模型请求，也没有对外留言。归档内容仅在内存中读取；只新建本证据文件。

当前可具体准备的后续是经用户授权在既有官方问题中补充脱敏反例，或在维护者合并且正式发布结构化失败修复后，再提出限定版本组合的验证方案。未发布分支、其他维护者的同名包和本地补丁不作为本轮替代出口。本次调查不解释 `Connection error.` 的网络层根因，也不改变候选五真实失败和完整旅程尚未闭合的结论。
