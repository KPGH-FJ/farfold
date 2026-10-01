# 历史读取重试：正式安装复验

2026-10-01 09:37–09:44，唯一正式应用 `/Applications/Farfold.app`，源码 `a95aaaf`。本片修复的重试路由出口通过；siGit / Dirac 的旧测试历史仍未返回正文，不能计为这两个 Agent 的历史恢复成功。

## 候选与工程证据

- [436 项输入身份](candidate-source.json)从打包到退出未变。应用二进制 SHA256 为 `8744abb0bda3f524ac89bee9c0e98ccf9dffe2a7d770450dbd73e433cb72c752`；[安装回执](candidate-install.json)中四个文件与产物一致，签名检查通过。
- [工程检查](engineering-checks.json)：全量 1,211 前端、类型、构建通过；其后仅把相同提示文字提取至字符串表，最终相关 184 项、类型及完整打包通过。115 后端输入完全不变，复用已有 494 Rust（3 既有忽略）及 fmt/clippy。完整格式检查和[独立终审](review.md)通过。此前红测和夹具失败保留原回执，不以文件名中的 green 推断成功。

## 实际操作

| 样本                                                    | 安装观察                                                                                                                                                              | 证据                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| siGit 旧失败对话 `7a7b4261-aeff-4ec4-a521-6479a4239ac9` | 冷打开、显式重试一次、返回列表再进入，均显示准确的读取失败及重试/新稿出口；没有再次退化为泛化的会话打开失败                                                           | [首次](01-sigit-cold.png)、[重试](02-sigit-retry.png)、[列表再入](03-sigit-list-reentry.png) |
| siGit 新稿                                              | 从失败页进入独立空稿，沿用已有设置、Qwen 2.5 3B、Local / Manual；原工作目录保持。只输入 `/` 检查声明菜单，仅观察到 `/help`，随后清空，没有发送或执行 `/load`          | [来源](04-sigit-new-draft-source.png)、[命令菜单](05-sigit-command-picker.png)               |
| Dirac 旧失败对话 `b888c42d-ea7c-4145-abba-e82f2029bc6d` | 冷打开、显式重试一次、返回列表再进入，均保留准确读取失败及两个出口；重试中显示正在读取，结束后可再次操作                                                              | [首次](06-dirac-cold.png)、[重试](07-dirac-retry.png)、[列表再入](08-dirac-list-reentry.png) |
| Dirac 新稿                                              | 独立空稿、沿用已有设置、`~anthropic/claude-fable-latest`、Medium、Thinking Budget Off 保持；没有发送失败消息                                                          | [原选择](09-dirac-new-draft-source.png)                                                      |
| OpenCode 正常历史 `ses_f0e8e5a03ffeHDMo5rR4YFfsaM`      | 冷恢复五组既有测试问答，包括最新 `FARFOLD-HISTORY-RECOVERY-OK`；来源仍为已有设置，模型仍为 OpenCode Zen/Nemotron 3 Ultra Free。返回列表再次进入正常，没有新的读取请求 | [历史/来源](10-opencode-history-source.png)、[再次进入](11-opencode-list-reentry.png)        |

每张图均有同名完整 AX `.txt`。正常 OpenCode 本片只读，未重复前片已验证的续发；别名成功后再入、关闭拒绝/未知、并发和保留有输入占位的反例由受控回归覆盖，不能冒称安装版均已制造这些条件。

## 请求、保护数据和退出

[协议计数](protocol-counts.json)及[无正文元数据](protocol-metadata-final.json)记录：Amp 一次新建；siGit 三次读取和一次新建；Dirac 三次读取和一次新建；OpenCode 一次读取。所有文件共零 prompt、零协议错误记录。Agent 归属结合启动时间、观察进程和操作顺序，不是协议文件自带 Agent ID。Dirac 另两条 `other` 不能凭计数解释其方法。协议元数据不包含 IPC 错误正文，也不证明空历史的外部原因。

[退出核对](candidate-after-quit.json)：原 35 条索引与 37 个启动配置全部保持、无新索引；46 项设置中仅 `unsentWork.v1` 摘要变化。原 composer、选择、反馈、队列、活动均保持；[新增差异](unsent-additions.json)只有本轮 siGit 的一个活动项，没有新增未发文本或附件。恢复[原 Amp 空稿](12-original-draft-restored.png)后正常退出，5 个[观察进程身份](all-observed-processes.json)在全局进程表均不存在。首次退出核对误传了不存在的汇总文件名，未生成成功回执；改用实际汇总文件后得到以上结果。

[精确清理证明](duplicate-app-cleanup.json)记录仅移除与正式应用四文件一致的仓库打包副本；正式应用和其他数据保留。未改 Agent 设置、账号、模型或密钥；siGit `/load`、Messages 交付及全目录同候选最终验收仍开放。
