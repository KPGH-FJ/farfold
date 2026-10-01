# 旧终端声明的环境设置保真

Auggie 的入口失败有确定的源码原因。已安装 `@augmentcode/auggie@0.36.0` 的公开 `augment.mjs` 提供完整的 `node + 当前脚本 + login` 声明，并在 `_meta["terminal-auth"].env` 指定两项登录环境设置。旧 `handshake::metadata` 拒绝所有非空 nested env，将该方法标为无效，后续路由因此返回“信息不完整”。这不是缺少命令，也不是官方不支持终端登录。[公开包字段与文件摘要](official-auggie-package.json)；官方 [CLI reference](https://docs.augmentcode.com/cli/reference) 明确提供 `auggie login`，官方 [0.7.0 发布说明](https://www.augmentcode.com/changelog/auggie-cli-0-7-0-release-notes)已有终端认证支持。此前同包的[启动及取消观察](../2026-10-01-agent-access-directory-batch2/README.md)不能替代本片安装复验。

本片只改 `handshake.rs` 与 `auth_route.rs` 两处生产文件。旧终端的 nested env 沿现有有界环境校验保存在当前连接的执行声明中；路由合并 top-level 与 nested 两个位置，合并结果最多 64 项，超过上限整条拒绝而不截断。不同名称或相同值可逐字保留，同名不同值因旧扩展没有已核实的交叉位置优先合同而明确拒绝，使用既有固定原因，不展示任何值。Typed Terminal 仍优先，忽略旧 metadata，按标准追加完整参数与环境；没有改变 legacy 的完整 argv、所选程序/脚本核验或认证流程。

公开快照、缓存及日志不保存命令参数、环境值或 metadata。新真实 SDK 受控对端测试证明入口只针对当前目录、当前已有设置来源可用；其他目录、API 来源和断开后缓存不可执行，方法不传给 `authenticate`。受控对端未启动官方 Agent、终端登录或提示请求，未读取/写入用户配置、凭据或正式数据。没有新增配方、依赖、环境开关、认证成功判定或执行路线。

## 实际检查

- [原始红日志](backend-red.log)、[命令与退出收据](backend-red.json)：7 项中 4 失败、3 通过，退出 101；均为行为断言失败，非编译失败。
- [最终定向收据](backend-green.json)：新纯声明 7、新 SDK/live 1、完整路由 24、声明入口 7、捕获 7、Copilot 11，各命令退出 0。分组有重叠，不合计独立测试数。
- 最后追加合并总数边界：[原红](backend-combined-limit-red.json)真实 1 项失败，退出 101；[最终收据](backend-final-checks.json)完整路由 25（含新增纯声明 8）与 SDK/live 1 均退出 0，覆盖 64 项保留、65 项拒绝及同名同值去重。前一份[源码摘要](source-before-combined-limit.json)保留，最终身份以 `source-final.json` 为准。
- [五文件冻结摘要](source-final.json)：两生产、三测试，全部低于 1500 行；局部 rustfmt 与 diff 检查均退出 0。这里只冻结本片文件，不代表完整安装候选身份。

Copilot 原精确平台程序补充仍拒绝其未核实的非空环境；合法 nested env 现在保留给验证器，而非通过先过滤再放行。畸形 env、重复方法身份、Node/脚本不匹配、Typed 优先及敏感 canary 的公开/缓存/日志隔离均有定向覆盖。此处尚未执行安装版 Auggie 登录，也未验证账号成功。

## 已核入口与范围

| 官方方式                                                                                   | 当前通用途径/证据                                                                                                                                                                | 范围                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 标准 Typed Terminal（包括已观察的 DimCode、Claude、MiniMax、Nova、Devin、Kimchi、Mistral） | [标准定义](https://agentclientprotocol.com/rfds/auth-methods)、[声明保真安装证据](../2026-10-01-agent-auth-declarations/installed.md)及各目录批次声明                            | 同所选程序、基础参数逐字追加方法参数；方法展示不等于登录成功 |
| 完整 legacy terminal-auth（Auggie、Amp 等）                                                | 本片通用修复；[Amp 启动/取消](../2026-10-01-agent-auth-route-diagnostics/installed.md)                                                                                           | 仍核验相同程序；解释器还须相同入口脚本，不解析描述文字       |
| Amp 官方伴随程序补充                                                                       | [官方 CLI](https://ampcode.com/docs/cli)、现有 `recipes::verified_for`/所选伴随程序                                                                                              | 仅已核声明形状；坏的显式选择不回退 PATH                      |
| Qwen 官方设置终端                                                                          | [官方认证说明](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)、现有 `auth_compat.rs`                                                                      | 已核官方组件入口和精确旧声明，交互 `/auth`，非标准方法替换   |
| Kilo `auth login`                                                                          | [官方命令](https://kilo.ai/docs/code-with-ai/platforms/cli-reference#kilo-auth-login)、[旧安装入口观察](../2026-10-01-agent-access-auth-sequencing/README.md)                    | 精确 7.8.1 官方受管来源及旧声明补充                          |
| Copilot `login`                                                                            | [官方认证说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)、[安装启动/取消](../2026-10-01-agent-copilot-login/README.md) | 精确 1.0.89 loader/平台包与当前受管收据，非任意名字猜测      |
| Goose `configure`                                                                          | [官方固定入口](https://github.com/block/goose/blob/v1.52.0/crates/goose-cli/src/commands/configure.rs)、现有 preparation action                                                  | 服务配置动作，与协议认证分开                                 |

以上是已核声明类型和现有补充，不是所有 Agent 均已登录或全部目录均可执行。缺少命令字段且无法核实的声明仍提供明确配置出口；环境型/未知型不会被改成普通登录。

## GLM：仅静态下一步

已安装 `glm-acp-agent@1.13.0` 的公开 bin 为 `dist/index.js`；[官方固定入口](https://github.com/stefandevo/glm-acp-agent/blob/v1.13.0/src/index.ts)在 `--setup` 时运行[交互设置](https://github.com/stefandevo/glm-acp-agent/blob/v1.13.0/src/setup.ts)并结束，写入 Agent 自己的凭据文件。其 `authenticate` 空返回不能证明账号可用。此入口真实存在，但当前没有提供相应准备动作，不能称官方不支持。

后续可复用 Goose 的 service_configuration/PTY/attempt 流程，不过不能只加一条静态配方：现来源验证要求命令本体在受管目录，而 GLM 的命令是外部 Node；需通用 npm 入口证明（当前收据、官方 manifest/bin、入口在已验证 root 内）并构造所选 Node、当前脚本、`--setup`。本片没有实施或执行这条路线。
