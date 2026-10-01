# 工作设置保护：正常安装旅程

`41cb5b23ae2b1cfe1552ebcd3a4db66f76853277` 已于 2026-10-01 17:55:04 安装到 `/Applications/Farfold.app`，18:06:35 正常退出。正常位置策略的暂停、冷启动保持和恢复通过；既有 OpenCode 历史、来源及模型可读取，随后返回原 Amp / Medium 空稿。原 36 条索引、40 个启动配置、49 项设置及全部未发字段最终摘要保持。没有新 prompt、认证或审批请求。

未知根字段及数组根的拒绝只由隔离测试证明，**没有向正式数据库注入损坏记录**。本轮正常安装旅程不能替代这层失败机制证据，也不宣称覆盖所有存储损坏。

## 候选与检查

[执行身份](candidate-run.json)、[安装收据](candidate-install.json)和[453 项冻结输入](candidate-source.json)对应二进制 SHA256 `53a0351ace3b6a81aee3b3eb37616612a26c258e649d7629c2d0f01c9f722573`；安装复制比较为空、签名核验退出 0。[安装前核对](before-install.json)仍为旧二进制，不能当成新候选行为；[最终退出收据](after-exit.json)的新二进制匹配安装身份，源码输入变化为空。

源码保护及自有临时存储的 5 失败/4 通过→9/9 通过，见[红收据](red.json)、[绿收据](green.json)、[作者源码冻结](source-final.json)、[实现说明](implementation.md)及[独立审查](review.md)。最终 [fmt/clippy/Rust 全量](checks-rust-final.json)退出均为 0，567 通过、3 既有忽略，测试使用 `--test-threads=4`；[格式](checks-format-final.json)及[打包](checks-bundle.json)退出 0。314 项前端输入未变，[复用](frontend-check-reuse.json)前片 1,266 项测试、类型及构建结果。

[检查诊断](checks-diagnosis.md)保留此前默认并发的两次全量失败、逐项隔离重查和四并发对照。本片另修正一个测试对可选观测字段的断言，见[修正身份](observer-test-correction.json)：缺失时整组省略，存在时仍须三个字段完整精确；没有改生产超时或工作设置保护。最终通过不等于默认并发问题全部解决。源码作者的 `source-final.json` 仍保留当时“全量和安装待根任务”的历史状态，不覆盖该原始收据。

## 界面与正常策略

本轮沿用此前自有测试位置 `/private/tmp/farfold-stop-queue-idn3cxh0`，不修改其他位置、Agent 默认或外部 Agent 配置。

| 阶段             | 观察依据                                                                                                                                                                       | 保存的目标策略 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 起点             | [01 截图](01-existing-location-policy.jpg) / [AX](01-existing-location-policy.txt)显示目标行“暂停发送”；[基线](policy-before.json)已有显式启用。                               | `true`         |
| 暂停             | [02](02-normal-policy-paused.jpg) / [AX](02-normal-policy-paused.txt)显示目标“已暂停 · 1 段对话”和“恢复发送”。[阶段收据](policy-paused.json)。                                 | `false`        |
| 正常退出与冷启动 | [冷退出](cold-exited.json)确认前一组采样结束；[03](03-cold-policy-still-paused.jpg) / [AX](03-cold-policy-still-paused.txt)仍显示目标暂停。[冷策略](policy-cold-paused.json)。 | `false`        |
| 明确恢复         | [04](04-policy-restored.jpg) / [AX](04-policy-restored.txt)显示目标已恢复，操作回到“暂停发送”。[恢复收据](policy-restored.json)。                                              | `true`         |

本次起点已经是 `true`，恢复后[整个策略摘要](policy-after-exit.json)与起点一致，其他策略摘要始终一致；最终原设置摘要也全部匹配。[派生比较](comparison.json)逐阶段列出上述事实。它与[上一片](../2026-10-01-location-send-pause/README.md)“无显式覆盖→false→true，仅恢复启用语义”的结果不同，两片起点不能混用。

[05](05-original-model-and-history.jpg) / [AX](05-original-model-and-history.txt)显示原 OpenCode 历史和 OpenCode Zen / Nemotron 3 Ultra Free、已有设置、`build`；画面的 A/B 固定标记是历史消息，**本轮没有重发或取得新回复**。[06](06-original-empty-draft.jpg) / [AX](06-original-empty-draft.txt)返回原 Amp / Medium、已有设置空稿。[07](07-original-amp-medium.jpg) / [AX](07-original-amp-medium.txt)实际为对话选项，虽然文件名含 Medium，不能独立证明模型选中；明确 Medium 选中依据是 [08](08-amp-medium-selected.jpg) / [AX](08-amp-medium-selected.txt)的勾选状态。

## 数据、协议与退出

[17:08 基线](data-before.json)、[未发摘要](unsent-before.json)与[最终核对](after-exit.json)比较：原索引、启动配置、设置没有改变或缺失，无新增索引或设置；原 composer、选择、文件意见、队列和 activity 全部保持。[派生比较](comparison.json)另外检查未发各容器新增键及新增根字段，均为空；整个目标的 composer、附件、文件意见和队列在各阶段均不存在。原数据摘要证明的是 Farfold 元数据及未发内容，不是外部 Agent 全部文件的普查。

[最终协议元数据](protocol-metadata-final.json)以本次安装收据为窗口起点，完整白名单记录中有 3 个文件、23 条启动摘要、3 次 initialize、2 次新稿准备及 1 次历史读取；prompt、cancel、authenticate 和审批请求均为 0，拒绝记录数为 0。新稿准备不等于消息派发；截图中的历史回复不计本轮请求。有限窗口和安全元数据不包含正文、秘密或完整 stderr，也不证明窗口外行为。

[进程采样汇总](all-observed-processes.json)记录 5 个身份，最终均不再存在，正式应用进程列表为空；采样不保证捕获每个瞬时子进程。[重复应用清理](duplicate-app-cleanup.json)仅移除逐项匹配此候选的 bundle，重复产物不存在，正式应用保留。

本轮未发送新消息，未执行账号操作、审批响应、实际停止、队列继续或编辑、强制退出；这些分支仍未由本候选验收。[helper 来源](installed-helper-provenance.json)与[原始字节保护](raw-format-preservation.json)保留；本次整理仅从保存的 JSON、截图和 AX 派生，没有启动应用、Agent、测试或读取正式数据库。
