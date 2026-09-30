# 启动检查失败的明确出口

2026-10-01 安装验证：Minion Code 0.1.44 的首次安装和一次明确重试均未完成连接检查；两次都显示固定中文错误，随后恢复安装入口，未登记失败候选。已有 fast-agent 历史可恢复，Amp 原稿保持。Minion 本身仍未接入成功。

## 安装身份

正式应用 `/Applications/Farfold.app` 来自提交 `38c6ba9224171053a6d5296dcab042d3a880c2d9`，于 01:31:23 安装；可执行文件 SHA-256 为 `d3b201ca3de10fbdb6763c944a9313ae414ef6cf2c4fb44dfff773f56c01a0b2`。复制比对及签名检查通过；403 个输入至 01:35:19 应用退出后均未变化。见[源码清单](candidate-source.json)、[安装收据](candidate-install.json)、[打包前核对](before-bundle.json)、[退出后核对](after-exit.json)。

## 安装版结果

| 旅程                     | 实际结果                                                                                                           | 证据                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 恢复已有 fast-agent 对话 | 通过命令菜单恢复 `2610010054-BZNiH6`，显示此前首发与续答历史；本轮未发送新请求，历史回复不计为本候选的新首发验证。 | [01 历史](01-fast-agent-history.png)、[协议元数据](protocol-metadata-final.json)                                              |
| Minion 首次安装          | 显示“连接在检查完成前结束，请检查程序后重试”；“安装程序”恢复可操作，“使用此 Agent”禁用，仍为 0 份安装。            | [02 首次失败](02-minion-first-failure.png)、[失败后核对](minion-first-failed.json)、[首次存储核对](minion-first-storage.json) |
| Minion 明确重试一次      | 再次显示同一错误，安装入口再次恢复；无 Minion 登记、无残留受管安装目录。未尝试换包、改依赖或新增第三次安装。       | [03 重试](03-minion-explicit-retry.png)、[重试后核对](minion-retry-failed.json)、[最终存储核对](minion-final-storage.json)    |
| 返回原稿                 | 回到 Amp／Medium 空稿，沿用已有设置；原稿未发送。                                                                  | [04 原稿](04-original-amp-medium.png)、[未发字段基线](unsent-before.json)、[退出后核对](after-exit.json)                      |

[协议元数据](protocol-metadata-final.json)共 4 个文件、0 次 `session/prompt`。两次 Minion 都记录了发出的 `initialize` 及 stderr 字节数，未记录初始化响应；这些元数据不包含异常原文，不能据此确定具体依赖错误。

## 数据与进程边界

[保护基线](data-before.json)为 28 条会话、11 个 Agent、20 项设置。与[退出后收据](after-exit.json)比较，原会话索引所核字段、Agent 启动配置字段和设置摘要未变，无新增会话或设置，Minion 未登记；未发内容的 composers、choice、feedback、queues、activity 及版本字段均未变。这是 Farfold 指定字段的核对，不包括握手缓存或外部 Agent 配置的全面摘要审计。

Minion 两次失败期间，原 Amp 进程 `45000` 与 fast-agent 进程 `45021` 的身份保持，见[安装前](before-minion.json)、[首次失败后](minion-first-failed.json)、[重试失败后](minion-retry-failed.json)。[目录观察](cwd-before-minion.json)记录二者位于 conversations；[首次安装观察](cwd-minion-first.json)记录受管 uv 在候选目录、候选 shell 在 Farfold 数据目录。

[累计观察](all-observed-processes.json)包含 6 个具体进程身份，退出后均已结束。[第二次观察](cwd-minion-retry.json)开始较晚，未采到该次瞬时安装进程，因此不将这组观察写成全部瞬时子进程的全面审计。重复打包产物已按[删除证明](duplicate-cleanup.json)精确移除，正式应用保留。

## 工程验证与未完成项

前端类型检查、测试、构建，Rust 格式、clippy、测试，以及仓库格式检查和打包均退出 0，分别见[前端全检](checks-frontend-final.json)、[Rust 全检](checks-rust-final.json)、[格式检查](checks-format-final.json)、[打包检查](checks-bundle-final.json)。定向红绿与实现范围见[前端说明](frontend.md)、[后端说明](backend.md)、[独立审查](review.md)。

- 本次安装版覆盖“连接在检查完成前结束”的错误出口；初始化失败、初始化超时、进程启动失败三类固定错误仅有受控验证，未将它们写成安装版实测。
- Minion 仍不能完成握手，认证、模型、首发及恢复均未验证。[官方发行核对](official-release-check.json)和[0.1.44 wheel 静态检查](minion-wheel-static.json)揭示 SDK 接口兼容风险，但没有本次运行异常原文或完整解析依赖证明，不作为精确运行归因；[前次 uvx 失败记录](../2026-09-30-agent-access-uvx/minion/README.md)继续保留。
- [下一批目录材料](next-catalog-batch.md)仅为官方静态核对，不代表安装、认证或真实回复验证。
