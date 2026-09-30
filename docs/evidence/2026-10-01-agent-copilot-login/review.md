# Copilot 同包登录：独立只读审查

2026-10-01。结论：**冻结版本未发现剩余源码阻断。**本次没有修改生产/测试，没有运行 Cargo、正式应用、官方 Agent、登录或 Keychain。本文件只记录独立审查，不替代安装版登录与取消验收。

## 固定范围

核对[已批准范围](../2026-10-01-agent-copilot-target/implementation-scope.md)、[初始化观察及其边界](../2026-10-01-agent-copilot-target/review.md)、[作者说明](backend.md)与最终生产/测试。重新计算[源码摘要](source-final.json)中的全部 8 个文件，均与 `2026-10-01T06:17:02.961235+08:00` 的 SHA-256 一致；文件为 163–1,064 行，均小于 1,500 行。摘要用于核对审查输入，不作为 Agent 二进制准入条件。

## 实现核对

| 边界                             | 实码结论与支持                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 证明来自当前选中受管收据         | [copilot.rs](../../../src-tauri/src/acp_client/auth_route/copilot.rs)第 53–81 行要求 registry ID/source/版本及精确已登记 Node/loader 参数；匹配当前 command/args 的记录须唯一，且是 managed、非 programOnly、版本一致。receipt ID/path/root 相互一致，根须为规范化指定父目录的直接子目录。目录路径不产生所有权，没有新增存储或二进制摘要门槛。 |
| loader 实际解析关系              | 第 83–128 行只接受已核实扁平布局，loader、两份清单与平台入口规范化后仍须与原路径相同。两处近层包以及对应 node_modules/@github 的存在、破损链接、重定向或不能确认的状态均拒绝；不会仅因叶项返回 NotFound 而放行被遮蔽的解析位置。固定清单/依赖/平台/导出逐项核对，每份读取有界。                                                                |
| 原始声明不会被过滤成可运行空声明 | [handshake.rs](../../../src-tauri/src/acp_client/handshake.rs)的 metadata 对旧嵌套 env 非空/畸形保留无效标记，不保存值，也不把它过滤成可运行的空环境。合法顶层 method.env 保留在所属 live 执行声明中，Copilot 补充拒绝非空值；畸形顶层环境也不可运行。公开快照不保存执行参数或环境值。                                                         |
| 标准 Terminal 权威               | [auth_route.rs](../../../src-tauri/src/acp_client/auth_route.rs)仍先按 typed Terminal 的字面追加与环境语义执行；Handshake 对此类型不读取旧扩展。已解码的标准声明即使带畸形旧元数据也不退化为 Copilot 补充或普通 Agent。无效标准字段和重复身份仍拒绝。                                                                                          |
| 补充路线仅适用已观察形状         | copilot.rs 第 140–162 行要求缺省类型、copilot-login、同包绝对导出、精确 login 参数及空声明环境。冻结结果为已登记 Node + 同一 loader + login，不追加接入用 --acp，不二次查 PATH。范围外仍保留固定不可用说明和明确手动配置出口，不误发 authenticate。                                                                                            |
| 查询不授权后续执行               | [auth.rs](../../../src-tauri/src/auth.rs)第 427–462 行仅 exact live/已有来源可运行，缓存、另一目录与 API 来源均不可执行。第 537–556 行在当前配置保护下重新读登记/live 声明并重新派生 proof；runnable_auth_method 拒绝发生在 environment_for、Keychain 与 PTY 之前。既有 Kilo/Amp/Qwen 路线只改 proof 传参，没有扩张它们的适用范围。            |

## 反例与验证边界

已读[首轮红](route-red.log)：5 通过/1 失败，合法同包仍不可执行；[解码链红](normalization-red.log)：旧嵌套环境被丢失；[近层作用域红](shadow-red.log)：破损 @github 链接误当叶项不存在。三项均有明确失败收据，并在[最终 10 项绿](dispatch-green.log)/[退出收据](dispatch-green.json)中关闭。

最终 fixture 包括不同/重复/缺失收据、版本/清单/平台/导出不符、合法超限清单、不同程序、未知参数/环境、内部与外部链接逃逸、近层包遮蔽，以及真实 Handshake 解码后的 typed Terminal 优先。收口增强的合法超限清单用例另有[绿收据](manifest-bound-green.json)；未把重复单例加到 10 项总数。

SDK/manager/PTY 用例确实启动任务自有控制子进程并观察其只收到 login，协议对端只收到 initialize；查询的其他目录/API 来源、断线缓存和移除收据后的新派生均被拒绝，拒绝后环境回调计数未增加。它复用真实执行入口的 runnable 守卫与终端所有者，未直接调用带 AppHandle 的正式 auth_run，也不是官方 Node loader 解析或真实 Copilot 登录测试。静态包关系与受控派发的证据范围分别保留。

[相关回归收据](regressions.json)中的统一路由、Handshake、声明传输及账号方法组全部退出 0；账号组明确跳过 Keychain 相关用例。独立审查没有重复运行这些命令，也没有运行全量检查。

工程全检及安装版重查、明确启动、实际目标/目录、暂离/取消、返回原稿和退出回收仍由根任务完成。未填写新凭据，不声明账号成功、模型成功或首条消息成功。
