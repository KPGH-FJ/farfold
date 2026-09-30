# 登录拒绝原因：独立只读审查

完成于 2026-10-01 04:50（UTC+8）。审查当前差异、受控红/绿收据及对应源码；未运行 Cargo、Agent、登录或应用，未读取凭据/用户配置，未修改生产或测试文件。

**结论：最终范围内未发现阻断问题。**变更只将既有不可执行分支投影成固定原因，没有增加 Copilot 或其他登录执行路径，也没有把程序核验失败解释成账号未登录。

## 范围与冻结核对

[source-final.json](source-final.json)的五个文件于 04:48:43 冻结，独立读取实际文件并重算 SHA-256，五项全部一致；均不超过 1,500 行。生产文件为：

| 文件                                                             | SHA-256                                                            | 行数  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ | ----- |
| [auth_route.rs](../../../src-tauri/src/acp_client/auth_route.rs) | `53d92639ac9145f215dc913c60e0c25daa65ba2cb99038b55e5600e5aaa15ab6` | 391   |
| [auth.rs](../../../src-tauri/src/auth.rs)                        | `8d7ed4667ede6ad3ddbcd2e1be1b38417f9e762c4669c97dc990729aa2d92840` | 1,041 |

同时审查三个测试文件：`acp_client/auth_route/tests.rs`、`auth/route_diagnostics_tests.rs`、`auth/declaration_transport_tests.rs`。没有依赖、协议解析、Keychain、进程、安装或前端逻辑改动。

## 核对结果

- `same_program` 的 Option→Result 改动逐分支保留原成功条件和实际 argv：原来任何无法解析、缺少简单绝对脚本或目标不一致的情况仍不可执行；只是区分声明格式、路径无法确认、参数形状、程序/脚本不一致和未核实。路径分类不声称文件必然缺失，也不泄露 OS 错误或原路径。
- 标准 Terminal 仍优先于旧元数据，完整基础参数后字面追加声明参数；旧 terminal-auth 仍按完整登录 argv 校验。Amp 显式伴随程序、Kilo 窄收据补充及 Qwen 已核入口未扩大；未知类型/畸形声明没有退回普通 authenticate。
- 六个原因均来自固定静态中文，未插入 argv、env、协议正文或动态错误。`auth.rs` 仅将枚举消息接入已有 `unavailableReason`，kind 和可执行标记规则保持；公开 `terminalCommand` 继续清空，缓存/无当前连接/其他目录/API 来源仍覆盖为重新检查或原来源限制，不能离线利用具体原因启动。
- `auth_run` 的既有 source、cwd、live 声明重派生及启动前拒绝未改；新真实受控管理器测试检查 live 原因后，另一 cwd、API 来源、未给 cwd、断开后的缓存仍不可授权，且未产生 authenticate 请求。对外只增加原因说明，不增加凭据交付或账号成功判定。

## 证据与限制

[原始红收据](backend-red.json) / [日志](backend-red.log)为 6 项：5 项固定原因断言失败，标准 Terminal 原语义 1 项通过。[最终 focused 收据](backend-green-focused.json) / [日志](backend-green-focused.log)为 7 项全通过，新增的第 7 项是实际 SDK/管理器与自有对端的目标/缓存保护反例。[相邻检查](backend-related-green.json)中 route、target、声明、声明传输、兼容、handshake 六组分别为 16 / 6 / 3 / 3 / 2 / 7 项通过；声明传输新增项与 focused 重叠，不将它重复计作独立覆盖。

以上只核对作者已执行的收据，没有另跑测试；真实程序对应关系、账号登录、终端取消及安装版固定文案仍由后续正式验收记录。Copilot 当前被拒绝的精确声明形状尚未取得，本片分类与测试不能替代该事实，也不能被描述为 Copilot 登录修复。
