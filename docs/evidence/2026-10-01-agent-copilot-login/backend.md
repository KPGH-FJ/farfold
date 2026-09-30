# Copilot 同包登录路线：实现与受控检查

本片按[已核准范围](../2026-10-01-agent-copilot-target/implementation-scope.md)接通已登记官方 Copilot `1.0.89` 的同包平台登录声明。依据为[一次真实初始化观察](../2026-10-01-agent-copilot-target/observation.json)、[公开包与 loader 核对](../2026-10-01-agent-access-directory-batch5/copilot-followup-design.md)及官方[版本发行](https://github.com/github/copilot-cli/releases/tag/v1.0.89)/[登录说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)。版本仅限定这条已核对补充，不是安装或连接准入限制。

## 改动范围

- [recipes.rs](../../../src-tauri/src/acp_client/recipes.rs)保存固定官方包/平台/入口范围；[同包证明](../../../src-tauri/src/acp_client/auth_route/copilot.rs)只读现有受管收据、文件关系和两份公开清单（每份读取至多 64 KiB 加一个超限判定字节）。不调用 CLI、不读取凭据、不写配置、不增加存储。
- 当前收据必须唯一匹配登记 command/args，来源 `managed`、非 `programOnly`、版本一致，ID/path/root 相互一致，规范化 root 为指定数据父目录的直接子目录。主包、平台包、固定依赖、bin、os/cpu、导出和实际文件逐项核对；目录名本身不授予权限，未作二进制摘要准入。
- 仅接受已核对扁平布局：loader、包清单、平台入口规范化后必须仍为原路径；两个更近 `node_modules` 的平台包不得存在。叶项、`node_modules` 或其 `@github` 目录的破损链接、重定向、不可确认状态均拒绝，避免核验根下 A 却由 loader 解析 B。
- [统一路由](../../../src-tauri/src/acp_client/auth_route.rs)使用当前调用内的 `ManagedTerminalProof`，保留原 Kilo 证明及其他既有路线。标准 Terminal 先行；只有缺省类型、正确方法 ID、绝对同包平台目标、精确 `['login']` 和空环境声明可补充。冻结输出为已登记 Node + 同一绝对 loader + `login`，不含接入用的 `--acp`。
- [查询/执行](../../../src-tauri/src/auth.rs)共用证明和派生规则，实际执行重新派生；沿用实际连接、原目录、已有设置来源与操作保护。`runnable_auth_method` 是真实执行入口使用的拒绝守卫，位于环境/Keychain/PTY 前。UI 查询仍不返回动态执行字段，缓存和其他目录/API 来源不能用旧查询授权执行。
- [Handshake](../../../src-tauri/src/acp_client/handshake.rs)对旧终端扩展中非空或畸形嵌套 `env` 标记既有无效状态，避免丢字段后误变成“空环境”；不保存其值。标准 Terminal 不读旧扩展，因此旧元数据不会污染其权威语义。

## 真实红绿与受控范围

[第一轮红](route-red.json)/[日志](route-red.log)：6 项中 5 通过、1 失败，合法同包仍被归为不可运行的 Agent 方式。[解析链红](normalization-red.json)/[日志](normalization-red.log)证明旧嵌套环境在实际 `Handshake::decode` 中消失；[遮蔽红](shadow-red.json)/[日志](shadow-red.log)证明更近层破损 `@github` 链接不能仅用叶项不存在判定放行。失败收据保留。

[最终 Copilot 定向检查](dispatch-green.json)/[日志](dispatch-green.log)：10 项通过。包括唯一收据、错误清单/版本/平台、范围外登记、无界清单、不同目标、未知参数、非空环境、近层包/破损链接、内部与外部重定向，以及真实解码后标准 Terminal 字面追加不退化。

其中一项使用任务自有临时包、Python 控制对端、真实 SDK/manager 与既有 PTY 派发：实际子进程只收到 `['login']`；协议侧只收到 `initialize`，`authenticate` 被现有守卫拒绝。原目录查询可用，其他目录/API 来源及断线缓存不可执行。删除收据后重新派生被拒，注入的环境回调计数不增加。测试使用相同生产方法选择守卫与终端所有者，没有调用正式 IPC `auth_run` 的 AppHandle，也没有接触真实官方 Agent 或 Keychain；不把受控派发写成真实账号成功。

[既有回归与格式收据](regressions.json)依次为统一认证路由 16 项、Handshake 7 项、实际声明传输/分类 6 项、账号与手动账号方法组 15 项，全部退出 0；最后一组明确跳过两个 Keychain 相关测试。收口时把超限清单反例改为语法合法且保留必需字段的超大 JSON，避免仅证明拒绝无效 JSON，[该用例复验](manifest-bound-green.json)/[日志](manifest-bound-green.log)通过。本任务不运行完整前端/后端套件，交根任务统一全检。[源码摘要](source-final.json)记录本片 8 个文件；每文件均少于 1,500 行。

## 剩余出口

独立审查与根任务全检后仍须打包安装：原 Copilot 重查、明确启动、正确目标/目录、暂离/取消、回原稿及退出回收。真实账号授权、凭据、实际回复均未验证。既有初始化 probe 的 `processGroupAbsent=false` 与随后选中程序匹配为零的不同范围按[原证据](../2026-10-01-agent-copilot-target/README.md)保留，不据此声称所有后代已审计。
