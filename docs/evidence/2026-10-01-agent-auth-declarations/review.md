# 认证声明保真：独立只读实现审查

后端审查时间：2026-10-01 02:26；前端审查完成：02:36（Asia/Shanghai）。结论：当前稳定的前后端修复范围内未发现可行动的阻断。此记录不表示整片正式安装验收完成。

02:31 补核官方范围：[Terminal Authentication RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/auth-methods.mdx)明确记载 2026-07-27 移除实验性 `env_var`，Rust 对旧类型归入 Agent 是有意的兼容策略；2026-08-20 Terminal 完成并稳定。因而本片处理的是已装旧发行声明与实际不可执行动作之间的诚实兼容出口，不是修复 SDK 漏升级、实现当前标准 EnvVar 或恢复旧协议。environment/unsupported 继续不可自动执行，未加入凭据交付或外部配置写入，符合本片官方接入边界。完整来源及限制见[官方范围补充](official-auth-scope.md)。

## 当前审查范围

读取新增 `acp_client/handshake.rs`、其测试、manager/initialization/mod/session 接线、`auth.rs`、`auth_route.rs`，以及两个新增认证声明测试模块；对照真实 SDK 2.2.0 与 schema 1.9.1 的公开接口。当前这 10 个文件逐一 SHA-256 核对均与 [backend-files.json](backend-files.json)一致。该清单只固定后端审查范围，不是完整安装候选身份。

重要生产摘要：

| 文件                       | 行数 | SHA-256                                                            |
| -------------------------- | ---: | ------------------------------------------------------------------ |
| `acp_client/handshake.rs`  |  268 | `3f0f10dddc2f1ba07fef50c3f555cd51f757bc17801e208960c54ef2c392dc8f` |
| `acp_client/manager.rs`    | 1386 | `780f6a0d6a14584ffba9f2b4828bbbe5aebc74c7f1221b61faf4b4f2f7a521f8` |
| `auth.rs`                  | 1044 | `ee6c29a47cd6840817b920a4d31df209b7ff22d5a0cc38d21b014dec0b649598` |
| `acp_client/auth_route.rs` |  347 | `402976fdcf57a0dcf34ec72596ec0c0940153325bbe6960c699d6bb68bd2115d` |

前端读取五个生产文件及声明 UI、IPC、动作的新回归，另核对既有重查/配置/工作阻断测试的事件 mock 接线。02:36 的生产摘要如下；作者此后只写证据。`agents.ts` 最后仅改公开快照不暴露参数的注释，已包含在本摘要内。

| 文件                              | 行数 | SHA-256                                                            |
| --------------------------------- | ---: | ------------------------------------------------------------------ |
| `components/AgentAuthSection.tsx` |  629 | `124bf8600c18da5fb3817b712e836bdd1fac03ed050d4e50e633387621830eec` |
| `runtime/auth_method.ts`          |   21 | `0a40ab8710a82b960a4e3834e5b0f06ffb63b889e3421ca40660f357da8a6efd` |
| `runtime/auth_actions.ts`         |  155 | `dc3adae958e2aaa887e35da00849c9bc95b682ed192fcaf6b7b9d7a912b14d93` |
| `runtime/agents.ts`               |  925 | `b370fd27f82e4e99cda2fcfa6cba23cbad0b0ff6223ed84519b43cc6128c8e52` |
| `runtime/auth_strings.ts`         |   33 | `6f4ecec30dbc33d147f28ef3eb1e97057eec89ffe33b24af159e4e8d1190680a` |

## 已核对边界

- initialize 仍使用官方请求与能力，通过官方 `UntypedMessage` 和同一个 `SentRequest::map` 解码。SDK 管理原请求 ID、协议版本核验、响应归属与取消；没有传输旁路、tap 缓存、第二连接状态或新账本。现有 oneshot/OnceLock 只改为单一 Handshake。
- mapper 在 typed 解码前取出 authMethods，typed 对象不再保存另一个已压平的认证副本。未知显式 type、非字符串 type、重复 ID（包括同 ID 但畸形 name 的成员）与畸形声明不会通过协议登录守卫。
- 已知 Terminal 的原始 args/env 容器先严格检查，避免 schema 的容错规则删成员或归空后改变调用。有效标准 Terminal 保持注册程序和完整基础参数，再逐字追加声明参数；不去重，不改环境覆盖，不发送 authenticate。标准 type 优先于旧扩展；已核验 legacy 路线只保留当前消费者需要的参数、环境及目标核验字段。
- public_json 不含运行 args/env/_meta；env_var 只保存合法、唯一且有界的变量名称，未知 payload、vars 值/default/file 与 link 查询不进入公开投影。Handshake 没有派生通用 Debug/Serialize；运行所需值只在所属连接的内存对象中供 route 派生。日志仍走原无正文 tap，固定错误不插入解码正文。
- auth_methods 接收 cwd/source，取得原目录已有设置来源的当前 live 声明；无 live、旧缓存或 API 来源只给不可执行的说明，退出登录不可用。它不会因另一目录更新 AgentRow 而授权原目录的自动操作。对 UI 的返回还移除 live 命令预览，避免运行参数进入前端快照。
- auth_run 与 logout 必须先取同目标 live 声明，去掉旧存储回落；配置锁释放再取得后重新核对原程序设置与 live 声明。manager 的协议登录与退出登录守卫也读取同一个 Handshake。手动明确配置仍是独立入口，没有把未知自动声明升级为手动授权。
- candidate 仍不写注册握手；session.rs 只是机械读取 typed 能力，不改会话恢复或关闭协议。ProcessTransport、退出回收和 startup 固定错误分类没有新增生产差异。
- 前端查询传实际 cwd/source；默认目录解析后重新查询。方法表 owner 与 request 序号阻止旧目标或迟到响应覆盖新目标。原目标未完成新查询时隐藏旧表；状态事件只对相同 Agent 同步使旧按钮失效并重读当前目标，不主动连接、登录或发请求。
- environment/unsupported 只显示说明和公开变量名，没有普通登录、API 设置或注册后继续登录按钮。公共动作 helper 即使缺少 unavailableReason 也拒绝这两种自动操作；其他合法 Terminal 仍可单独选择。“更多登录方式”仍是明确配置的独立手动授权，不借旧声明获得自动执行资格。
- 重查失败与方法表加载错误分别保存，状态刷新不会清掉真实失败。原 job 的重查继续返回发起目标；API 来源保留既有服务管理入口，不被旧认证按钮当成登录来源。登出同样经过当前方法表 owner 和后端 live 守卫。

## 已读取的后端证据

评审人未运行任何 runner，只读取作者的命令收据、退出码和原日志：

- `declarations-red.json/log`：真实旧归一化边界下 4 项反例全部失败。
- `declarations-green.json/log`：纯声明、路线与 manager 入口回归 11 项通过。
- `auth-stable.json/log`：最终认证相关 77 项通过，包含新增重复 ID 边界。
- `lifecycle-stable.json/log`：24 项通过；`startup-stable.json/log`：12 项通过；`initialization-stable.json/log`：2 项通过；以上退出码均为 0。

新增 transport 测试使用临时 SQLite、临时 cwd 与自有 Python 对端，经实际 SDK/manager 收发一次 initialize；检查两个目录、API 来源隔离、candidate 不回写、默认登录允许、env_var/未知/Terminal 不发送 authenticate。标准 Terminal 的完整字面参数与环境仅测试派生，未运行真实终端登录。秘密 canary 被放在未知字段、vars 值和 Terminal/legacy 运行值；公开存储、UI 响应及无正文日志检查没有它。

这些证据证明所覆盖的受控边界，不证明某个外部 Agent 的登录、Key 有效性或真实回复。env_var 当前诚实呈现为未提供直接配置的入口；没有新增 Keychain 查找、密钥保存/选择/交付流程，完整 Key 交付不计完成。

## 已读取的前端证据

- `frontend-confirmed-red.log`：旧实现基线 11 项失败、4 项通过；失败包含目标透传及 environment/unsupported 错误回落。
- `frontend-final-boundaries-red.log`：新增旧 Agent/API 按钮即时失效与明确失败保留反例，3 项失败、8 项通过。
- `frontend-green-final.log`：8 个文件、56 项全部通过，包含上述反例、迟到响应、默认目录、状态刷新、手动出口及正常 Terminal 选择；作者报告命令退出码 0。
- `frontend-typecheck.log` 中类型检查无错误；作者报告退出码 0，集中字符串检查 2 项通过。评审未另跑测试或类型检查。

前端新 UI 测试使用受控 hook/IPC/event mock，运行真实组件和 helper 的相应判断；它们不是实际窗口、真实登录或凭据交付证据。原始 payload canary 只检查没有被组件呈现；存储和日志秘密边界以该片后端受控测试为依据。

## 结论限制

当前源码与已读取受控证据未发现新增阻断。正式安装旅程、完整目录覆盖及 DeepAgents 原真实请求失败根因仍须分别验证。本次评审未运行 Cargo、前端 runner、Agent、正式应用、登录或请求，未读取用户配置、原始正文或凭据；只写此证据文档及既有设计审查的官方范围补充。
