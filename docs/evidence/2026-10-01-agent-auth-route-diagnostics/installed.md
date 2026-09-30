# 认证目标诊断安装结果

正式候选为 `26e959273485dac6edae9b67a86f3ff5e97177c5`，2026-10-01 04:55:56 安装到 `/Applications/Farfold.app`，05:02:41 正常退出。二进制 SHA-256 为 `acb5a5be5f2c1680e1086715df1fc8eecd89ede877022157d13d18b5b4f6eec6`。[安装收据](candidate-install.json)确认复制的 4 个文件一致、签名检查通过；[退出核对](after-exit.json)确认本次 422 项[候选输入](candidate-source.json)到退出时未变。

## 实际覆盖

| 入口                      | 安装版结果                                                                                                     | 证据与边界                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot 原接入的登录方式  | 显示“此登录方式的程序与当前程序不一致，请在更多登录方式中明确配置”，开始登录禁用。                             | [截图 01](01-copilot-program-mismatch.png)、[实时界面文字](copilot-auth-result.txt)、[进程工作位置](cwd-copilot.json)。确认 `ProgramMismatch` 分类及入口，未点击禁用操作；没有采集本次完整声明命令，不能进一步指定不一致的参数。                                                                               |
| crow-cli 原接入的登录方式 | 显示“无法确认此登录方式的程序路径，请检查程序或在更多登录方式中明确配置”，开始登录禁用。                       | [截图 02](02-crow-auth-rejection.png)、[实时界面文字](crow-auth-result.txt)、[进程工作位置](cwd-crow.json)。确认 `PathUnavailable` 分类；不表示主程序未安装或连接失败。此前[模型读取失败](../2026-10-01-agent-access-directory-batch6/README.md)仍未取得成功结果，未运行认证或实际消息。                       |
| DimCode 标准终端登录      | 从原目录启动终端，随后普通取消；取消后显示“已取消此次操作，账号设置是否改变仍需检查”，登录和重新检查入口恢复。 | [截图 03](03-dimcode-standard-terminal.png)、[启动界面文字](dimcode-terminal.txt)、[取消结果](dimcode-cancelled.txt)。[工作位置收据](cwd-dimcode-terminal.json)采到终端 Node `91097` 与 bun `91098`，均在原 `conversations` 目录。截图仅露出终端输入窗口底部，不证明完整终端内容；没有输入凭据或确认账号成功。 |
| Amp 既有终端登录          | 终端显示 API Key 输入提示；未输入，随后普通取消。                                                              | [截图 04](04-amp-legacy-terminal.png)、[启动界面文字](amp-terminal.txt)、[取消结果](amp-cancelled.txt)。[工作位置收据](cwd-amp-terminal.json)采到终端进程 `91246`，使用已有受管程序且工作位置仍为原 `conversations` 目录。只验证启动、暂留界面和普通取消，不验证凭据或真实请求。                               |
| 返回原稿                  | 返回原 Amp / Medium 空稿，发送不可用，未自动发送。                                                             | [截图 05](05-original-draft.png)、[实时界面文字](original-draft.txt)及退出后的未发字段核对。                                                                                                                                                                                                                   |

两项拒绝入口继续使用原目标保护；更多登录方式和重新检查入口可见，不将单个方式不可运行扩大为整个 Agent 不可用。两个终端样本验证普通取消，没有覆盖启动中的早取消竞态，也不把结束进程称为撤销外部账号设置。

## 数据、请求和回收

[安装前数据基线](data-before.json)与[退出核对](after-exit.json)比较：原 32 条会话索引、33 个 Agent 启动字段、42 项设置摘要全部保持，零新增会话索引、零新增设置；原未发 `composers`、`choice`、`feedback`、`queues`、`activity` 及版本字段全部保持。没有输入或保存新凭据；本批没有对所有外部 Agent 配置制作全量摘要。

[协议元数据](protocol-metadata-final.json)共 4 个文件，记录 4 次 `initialize`、4 次 `session/new`、2 次 `session/set_config_option`，没有 `session/prompt` 或 `authenticate`。因此“零新会话索引”不等于没有模型读取用的 `session/new`；终端登录流程也不能以协议 `authenticate` 的零计数替代其实际启动证据。

[累计观察记录](all-observed-processes.json)的 11 个 PID 与启动时间身份，在退出时全部结束；范围限于已采样身份，不声称捕获所有瞬时后代。正式应用保留；[删除收据](duplicate-removal.json)记录比较 4 个文件一致后，仅删除本项目打包目录中的重复 `Farfold.app`。

## 工程验证与未覆盖项

[完整 Rust 检查](checks-rust-full.json)的格式、clippy、测试均退出 0；[测试日志](rust-full-2.log)为 446 项通过、3 项既有忽略。前端 307 项输入未变，按[复用收据](frontend-checks-reused.json)沿用此前 1,132 项测试、类型检查和构建通过结果，没有宣称本片重跑前端全套。[首次格式检查](checks-format-final.json)因同期 batch6 的 9 个证据 JSON 未格式化退出 1，[原日志](format-final-0.log)保留；[稳定后的格式检查](checks-format-stable.json)及[打包](checks-bundle-final.json)均退出 0。

本次未验证账号成功、提供新凭据、实际回复、恢复续答、更多登录方式中的自定义配置或早取消竞态。固定拒绝原因的安装表现不替代这些旅程，也不覆盖后续批次或后续源码。其他四类诊断仍仅有[受控验证](backend.md)。
