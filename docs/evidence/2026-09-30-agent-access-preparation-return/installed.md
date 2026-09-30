# 配置返回与明确读取：安装候选 a1bb4c5

2026-09-30 21:52–22:01，正式 `/Applications/Farfold.app`。源码提交 `a1bb4c5`，二进制 SHA-256 `ef89d81b06c44b18ade7da21d1bea07b07d5961380432529c7ff6c85b30acc8c`；[安装收据](candidate-install.json)的复制差异为空、签名验证成功。[379 项构建输入](candidate-source.json)在安装前及退出后均无变化。

## 工程检查

[完整前端检查](checks-frontend-final.json)：120 个测试文件、986 项测试及类型检查、生产构建通过；[内部打包](checks-bundle.json)、[全量格式检查](checks-format-pass.json)通过。[Rust 复用依据](rust-reuse.json)比较前后完整 Tauri 输入集合，93 项无增删或内容变化，沿用 `c22ed6c` 的 fmt、clippy 和 336 项测试（3 忽略），没有声称重新执行。

[前端修复与定向反例](frontend.md)涵盖旧回调、目录别名、其他目录未完成进度、原稿返回及失败选项回写。本片首次全量前端为 983 通过 / 1 失败：SSR 用例未提供已经解析的目录；修正真实读取前置条件，保留失败文案断言后全量通过。全量格式首次仅研究文档格式失败，修正后通过，原日志保留。

## 实际安装旅程

Goose 使用已有受管官方 1.52.0，工作位置为原普通对话目录，沿用已有设置。未选择新服务、未输入任何终端文本、未提交默认遥测 Yes、未输入或保存凭据、未发送模型消息。

| 操作与结果                                                                                 | 证据与范围                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接现有 Goose，实际模型读取失败；显示失败原因、保留原选择与重试入口                       | [01 截图](01-initial-model-failure.png)，连接 PID 6476；不称模型可用                                                                                                                           |
| 审阅同一受管程序的 `configure` 参数与原工作位置，再显式启动                                | [02 截图](02-reviewed-action.png)、[03 终端](03-config-running.png)；终端停在官方遥测初始选择，无输入                                                                                          |
| 模型页与目录准确显示配置进行中；目录“查看配置进度”回账号页                                 | [05 模型页](05-cross-page-progress.png)、[06 目录](06-directory-config-progress.png)；[启动](config-running.json)与[返回](config-reopened.json)均为 PID 6522、21:54:13，同一进程，没有重复启动 |
| Farfold 取消配置，终端退出；终端外取消结果只显示一次                                       | [07 截图](07-cancel-result.png)、[取消后进程](config-cancelled.json)。终端记录本身保留取消文字；没有删除终端历史                                                                               |
| 显式断开空闲 Goose，仍能从程序页返回账号页查看取消结果                                     | [08 截图及完整 AX](08-disconnected-result-return.ax.txt)、[08 截图](08-disconnected-result-return.png)、[断开收据](disconnected.json)。Goose 6476 已结束，Amp 6443 保持原身份                  |
| 明确重查原目录连接，新 Goose PID 7001；重查状态与原取消结果分别保留                        | [10 截图](10-recheck-results-visible.png)、[重查后](before-explicit-read.json)。未把取消改成配置成功                                                                                           |
| 重查及进入模型页不自动读取；点击一次读取后实际失败，返回目录再进入仍保留失败和明确重读要求 | [11 待明确读取](11-explicit-read-required.png)、[12 失败](12-explicit-read-failed.png)、[13 目录](13-directory-keeps-read-requirement.png)、[14 再进入](14-reopened-failure.ax.txt)            |
| Pi 的已有程序与模型读取回归成功，原 DeepSeek V4 Pro / Thinking off 可见                    | [15 截图及 AX](15-pi-preserved-model.ax.txt)、[15 截图](15-pi-preserved-model.png)。未发送请求，先前 HTTP 402 不因此关闭                                                                       |
| 返回原空白 Amp 草稿，Medium 仍选中                                                         | [16 截图](16-original-amp-choice.png)，未切换来源或确认另一模型                                                                                                                                |

[无内容协议元数据](protocol-metadata-final.json)记录本次 4 条连接，零 `session/prompt`。重查后的 Goose 连接于 21:57:19 仅 initialize；直到用户操作对应的 21:58:25 才有一次 session/new，此后返回/再进入未增加 session/new。Pi 的 `other` 事件不能从本收据判定具体方法，其模型选择以界面及工程验证分别判断。初始 Amp 草稿恢复、初次连接 Goose 和 Pi 分别有 session/new，不把模型读取称为无副作用只读。

## 数据与退出

[退出后比较](after-quit.json)：原 26 条会话、7 个 Agent、16 项设置摘要均一致，无新增会话；未发内容各字段摘要一致。中途只有接入页进度按操作变化，返回原状态后设置摘要恢复。已知 Goose 默认配置文件在[前](goose-config-before.json)/[后](goose-config-after.json)均不存在；没有审计其他路径或 Keychain，不能据此扩展为全部外部数据不变。

应用正常退出后，[累计 7 个进程身份](process-exit-proof.json)均不再存在（PID、启动时间、命令共同核对）。退出后的 CUA 查询报告进程不存在，未因此重新启动。只在确认构建副本与正式应用完整文件摘要相等后，移除确切重复应用；[删除证明](cleanup.json)。正式应用、安装程序、缓存及原始证据保留。

## 仍开放的边界

已完成接入标记、历史恢复失败后原稿、多目录及目录别名反例在受控前端回归验证；没有修改正式数据库伪造这些前置状态。配置操作跨应用重启恢复未实现。Goose 配置成功、账号交付、首发与续接仍未测；全目录与全产品出口没有关闭。

安装发现一处文案待精确化：[12](12-explicit-read-failed.png)同时保留“读取失败”及“尚未检查”的要求提示，且引号内按钮名称与实际按钮稍有差异。失败与阻止隐式重读行为正确，下一片将要求提示改成“尚未确认”并对齐按钮名称；本候选不冒称该文案已经修复。
