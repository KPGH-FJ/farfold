# 准备选项保留：安装独立复核

2026-10-01。独立只读核对最小源码差异、保存的检查收据、01–07 全部截图及对应 AX、正常退出后的数据和进程摘要。未运行产品测试、应用、Agent 或数据库查询。此次有限旅程及修复范围未发现阻断；可复查输入摘要见 [summary.json](summary.json)。

## 源码与检查

源码提交 `ae23da5` 的生产改动仅在 [setup_storage.ts](../../../src/runtime/setup_storage.ts)：`parseSelection` 遇到非字符串、非布尔、非有限数字的选项，拒绝整个选择；合法选项完整保留。原读取入口在解析成功后才发布 `ready=true`，读取失败继续阻止保存，避免另一 Agent 的普通进度更新覆盖被裁剪的原记录。没有改变模型、推理、来源或执行规则。[源码审查](source-review.md) 中的两份 SHA 与 [候选摘要](candidate-source.json) 及本次独立读取一致：生产文件 371 行，测试文件 596 行，均在文件长度约束内。

[红测收据](red.json) 与 [原日志](red.log) 是实际 **6 失败、26 通过**：进度和确认选择分别使用 `null`、数组、对象作为模型值，直接断言模拟存储，显示原 `model` 被过滤后由无关更新写回。[绿日志](green-tail.log) 为 **33 通过**，另有合法字符串、`false`、`0` 保留正例。正式数据库未注入这些损坏记录，安装旅程不能替代该受控反例，反例也不代表正式数据已有损坏。

[第一次前端收据](checks-frontend.json) 的类型检查退出 0；首次全量命令参数被 `pnpm` 拒绝，[日志](frontend-1.log) 没有执行测试。[更正命令](checks-frontend-corrected.json) 对应 [139 文件、1,279 测试通过](frontend-corrected-0.log) 及 [构建退出 0](frontend-corrected-1.log)。[格式](checks-format-before-install.json) 和 [打包](checks-bundle.json) 退出 0。后端 141 输入未变，[复用收据](backend-reuse.json) 及其指向的原摘要、检查和日志 SHA 均匹配；原 fmt/clippy 及四并发 **575 通过、3 忽略**是已有检查复用，不是本片重跑，也不证明默认并发稳定性。

## 实际安装与冷恢复

[安装收据](candidate-install.json) 记录 21:47:45 替换正式应用，二进制 SHA-256 为 `45214b2d68d0bc93806ad83357663a6d06a0a3a88dc920d887a65f441400f94a`，四文件匹配、签名退出 0。[退出收据](after-exit.json) 在 21:57:24 仍为同一二进制、455 输入无变化。本次复核时当前 455 输入也与该候选摘要一致；后续证据提交不改变本片源码身份。

- [01](01-original-empty-draft.jpg) / [AX](01-original-empty-draft.txt)：原 Amp 空稿显示 Medium、沿用已有设置。
- [02](02-preparation-original-medium.jpg) / [AX](02-preparation-original-medium.txt)：准备页模型选项已读取，Medium 和原来源可见，同时明确“当前选择尚无成功回复”。这不是认证成功或模型回复证据。
- [03](03-returned-draft-preserved.jpg) / [AX](03-returned-draft-preserved.txt)：暂返目录后有“继续草稿”入口；该截图没有直接显示输入标记。[04](04-original-draft-after-preparation.jpg) / [AX](04-original-draft-after-preparation.txt) 返回原稿后才实际显示本次自有标记。
- [正常退出](cold-exited.json) 后，[05](05-cold-draft-preserved.jpg) / [AX](05-cold-draft-preserved.txt) 冷启动仍显示同一标记、Amp、Medium、原来源。[06](06-cold-preparation-original-medium.jpg) / [AX](06-cold-preparation-original-medium.txt) 再入准备页仍为模型页和 Medium，也仍提示尚无成功回复。
- [07](07-original-empty-draft-restored.jpg) / [AX](07-original-empty-draft-restored.txt)：仅清理本次测试标记后恢复原空稿，Medium、原来源仍可见。

以上支持该样本的准备页导航、草稿标记与选择显示的正常冷恢复，不能扩成所有 Agent、所有准备状态、强杀或保存失败的安装验收。

## 原数据、回收与观察边界

[基线](data-before.json) 为原 36 会话索引、40 Agent 记录、49 设置。[冷退出前](before-cold-exit.json) 只新增本次 `new` 输入条目，全部原未发字段保持；[最终退出](after-exit.json) 原索引与原 Agent 记录无变化、无新索引或设置键，本次新增未发条目也已清除，全部原未发字段恢复。

最终原设置只有 `agentSetup.v1` 的整体摘要变化；现有收据没有内部逐字段比较，无法断言全部原准备记录逐字不变或把其变化精确归因到某一个字段。Agent 核对保护原 40 条记录，回执没有当前完整 Agent 总数或新增条目列表，结论不扩大为完整 Agent 表逐字一致。

[协议摘要](protocol-metadata-final.json) 是内容无关观察：2 文件、16 条启动摘要、2 次 initialize、4 次新对话读取、4 次选项设置、10 次响应、8 次更新、2 个 stderr 标记；没有 prompt、authenticate、load、cancel 或 permission。两条连接的最终状态均为初始化成功、实际子进程回收、进程组结束、连接移除；stderr 标记不提供正文或原因。

[采样汇总](all-observed-processes.json) 的 4 个 PID 与开始时间身份在最终退出回执中全部消失。这是采样身份退出证据，不声称捕获全部进程。[重复应用清理](duplicate-app-cleanup.json) 在四个文件精确匹配后只移除打包副本、保留正式应用。[原始格式保护](raw-format-preservation.json) 的 7 个观测 JSON 字节 SHA 均再次匹配，独审没有重排原始文件。

协议窗口没有 prompt；本片没有实际登录或交付密钥，没有正式损坏记录注入，也没有覆盖跨 Agent 全旅程或强制退出恢复。安装 UI 仅显示当前返回与选择，协议不保存请求正文；上述模型页结果不能推成首发或账号成功。

## 最终叙述核对

[README](README.md)、[安装记录](installed.md) 与 [comparison.json](comparison.json) 的作者冻结 SHA 均独立匹配。派生文件的 37 份输入摘要未变，18 项有限判断分别与本次读过的原收据一致；安装叙述准确区分模拟持久对象的非法值保护、正常 UI 冷恢复、整体准备设置变化和无参数值的配置请求，没有把它们提升为登录、首发或全部内部字段保留。

根任务退出后的首次全仓文档格式检查仅报告本独审尚在编写的 `summary.json` 未格式化，[原收据](checks-format-final.json) 和 [日志](format-final-0.log) 保留。这不是源码或产品测试失败；本独审最终只格式化自己两份输出，全仓格式重查由根任务执行。
