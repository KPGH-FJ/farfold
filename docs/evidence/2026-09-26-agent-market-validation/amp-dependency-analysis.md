# Amp v0.9.0 依赖与认证核对

核对日期：2026-09-26。对象为目录条目指向的 `tao12345666333/amp-acp` 仓库 **v0.9.0**。本次仅联网读取该仓库及 Amp 官方文档；未启动程序、安装依赖、操作界面，未读取或写入用户认证文件。以下均为源码/文档结论，安装实测由本目录主记录另列。

## 连接与 CLI 依赖

- `initialize` 直接返回版本、能力与认证方式；`newSession` 只创建内存状态和选项，不执行 Amp CLI，也不校验账号。因此，完成握手不能证明可真实发送。[server.ts:138–222](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/server.ts#L138-L222)
- 默认执行方式为 `cli`，命令是 `AMP_CLI_PATH` 或 PATH 中的 `amp`。首次 `prompt` 才调用执行函数并创建子进程；二进制接入程序本身可独立握手，但真实执行仍依赖另行可用的 Amp CLI。[server.ts:287–288](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/server.ts#L287-L288)、[amp-transport.ts:92–154](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/amp-transport.ts#L92-L154)
- CLI 不存在时，故障发生在首次执行的 `spawn`，进程创建错误进入拒绝路径；一般会包含 ENOENT，但确切的客户端文案和程序是否退出须以实际运行确认。非零退出码另有包含 stderr 的执行失败路径。认证和初始化并不预先检查这个依赖。[amp-transport.ts:101–135](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/amp-transport.ts#L101-L135)

## 公布的认证方式与真实行为

`authMethods` 只有一个条目，字段如下。它没有显式 `type`，终端指令位于扩展元数据中。[server.ts:157–169](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/server.ts#L157-L169)

| 字段                             | v0.9.0 的值或含义                                        |
| -------------------------------- | -------------------------------------------------------- |
| `id`                             | `setup`                                                  |
| `name`                           | `Amp API Key Setup`                                      |
| `description`                    | 说明需运行交互设置以配置 Amp API Key                     |
| `_meta["terminal-auth"].command` | `getTerminalAuthCommand()`，打包二进制下为该接入程序本身 |
| `_meta["terminal-auth"].args`    | `["--setup"]`                                            |
| `_meta["terminal-auth"].label`   | 与上面的 `name` 相同                                     |

`authenticate` 忽略传入参数，只检查当前进程的 `AMP_API_KEY` 是否非空：非空返回成功，否则返回需要认证。它不运行 `amp login`，不校验 Key，不检查 CLI 是否存在，也不查询 CLI 的网页登录状态。因此，单独的认证成功不能证明 Key 有效；CLI 已登录也不必然使这个方法成功。[server.ts:218–222](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/server.ts#L218-L222)

终端 `--setup` 会询问 API Key，并由接入程序自行保存到其配置目录的 `credentials.json`，创建权限为 `0600`；macOS 默认根目录为 `~/.config/amp-acp`，可受 `XDG_CONFIG_HOME` 影响。普通启动时才把此处保存的 Key 载入 `AMP_API_KEY`。该设置流程不在线验证，也不安装 CLI；已运行的其他进程不会因此自动更新环境。[index.ts:113–182](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/index.ts#L113-L182)

## 官方流程与本轮边界

仓库 README 的前置流程为：按 [Amp 官方 CLI 安装说明](https://ampcode.com/docs/cli)安装 CLI，运行 `amp login`，再确认版本；如果桌面程序拿不到 shell 的 PATH，提供 CLI 的绝对路径。预编译的 `amp-acp` 无须单独的 JavaScript 环境，但不因此包含可用的 Amp CLI。[v0.9.0 README:10–35](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/README.md#L10-L35)

README 同时列出 `AMP_API_KEY` 和 `amp-acp --setup` 作为其他认证方式。Amp 官方文档支持本机 `amp login`；非交互环境的 `AMP_API_KEY` 应使用 Settings 中的访问令牌，不能把网页登录保存的短期会话令牌提取后放入环境。[仓库认证说明](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/README.md#authentication)、[Amp SDK 认证说明](https://ampcode.com/docs/sdk)、[Amp 非交互认证说明](https://ampcode.com/docs/cli/execute-mode#non-interactive-environments)

本次没有执行这些步骤，也没有证明本机 CLI 缺失、账号未登录或 Key 不可用。可据此划分验收：接入程序下载、协议握手、CLI 可执行、认证完成、真实消息返回分别记录；不得把前两项写成 Amp 已可用。任何账户登录或 Key 输入由用户控制，本核对不代填、不读取认证文件。

## 首条消息断连的补充分析

主审随后报告当前安装版已完成 v0.9.0 下载和握手，终端设置成功显示 Key 输入提示，未输入或保存；退出设置后创建对话成功，但发送无工具短消息立即断连且结果未知。见 [10-amp-request-disconnected.png](screenshots/10-amp-request-disconnected.png)。这是主审的安装观察，本分支未重复操作；断连本身尚不能证明依赖缺失。

源码存在一个具体的未处理 Promise 拒绝窗口：`amp-transport.ts:109–112` 创建 `completion` 并让进程 `error` 事件拒绝它，接着先等待 stdout 迭代结束（`119–128`），直到 `130` 才等待 `completion`。若创建进程失败而 stdout 尚未结束，该 Promise 暂无拒绝处理，运行环境可能在外层捕获执行错误之前退出。`server.ts:317–326` 的捕获范围并不能消除这个窗口。**这是解释断连的源码推断，不能在未观察退出信息时断言根因。** [执行源码](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/amp-transport.ts#L109-L130)、[外层捕获](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/server.ts#L317-L326)

该仓库的已有传输测试覆盖已成功启动程序的非零退出及取消，没有缺少可执行文件的测试。发布二进制使用 Bun 编译，不能用另一个 JavaScript 环境的表现代替此二进制结果。[测试:135–156](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/src/amp-transport.test.ts#L135-L156)、[打包脚本:21](https://github.com/tao12345666333/amp-acp/blob/v0.9.0/package.json#L21)

主审的有界协议探针将另行记录退出码、缺失可执行文件或 ENOENT 分类、未处理拒绝分类，以及请求是否先获得协议错误再 EOF；不输出环境、认证内容或原始日志。该探针只用于判因，不替代上面的安装版结果。
