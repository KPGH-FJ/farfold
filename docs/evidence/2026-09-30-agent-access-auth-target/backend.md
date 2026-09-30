# 认证目标：后端范围与受控回归

本页只证明源码及受控夹具行为。未运行真实 Agent、登录命令或正式应用，未读取账号配置、Keychain 或保存凭据；安装版验证由本片其他记录另行给出。

## 共享执行路线

`acp_client/auth_route.rs` 同时供账号方法展示、`auth_run` 派生命令和连接层协议准入使用。标准 Terminal 的当前已配置程序、原参数与声明参数优先于旧扩展；无终端扩展的缺省 / Agent 方法继续使用协议认证。已协商且核实的旧扩展保留原终端语义，不能靠 description 推断命令。

旧扩展的命令、参数数组、环境字段与标签严格解析，不能过滤坏参数后运行剩余命令。其目标必须是当前选中程序的同一实际文件；运行保留原选中绝对路径，不再次搜索 PATH。已知共享解释器（Node、Bun、Deno、Python 及数字版本、sh/bash/zsh、Ruby、Perl）还必须核对同一绝对脚本。`-c` / `-e`、前置选项、相对脚本与其他无法确认的解释器形状保留为不可自动运行，不解析任意命令代码。

未知、畸形或不能确认的声明通过唯一可选字段 `unavailableReason` 提示，`auth_run` 在读取交付环境及凭据、启动进程前拒绝。手动配置、重新检查、其他已声明方法仍可用。运行读取配置锁保护下的当前 Agent 行；已有相同目录 / 已有设置连接时使用其当前握手，连接层再次按该连接声明判定协议认证。账号作用域、取消所有权和终端退出回收沿用既有机制。

## 已核实补充

- Amp 沿现有 `recipes::verified_for` 和 `preparation::resolve_dependency` 取得当前已选伴随程序；显式坏路径不能回退到 PATH 上的同名程序，不改变选择。
- Qwen 保留现有官方 Node 入口、`/auth` 配置及返回检查路线，保留合法声明环境；未知启动形状不猜测。
- Kilo 补充仅在 `registry:kilo` / registry 来源、7.8.1、参数 `[acp]`、`kilo-login` 和错误旧命令 `opencode auth login` 精确匹配，并有现存当前受管 ZIP 收据时适用。实际执行当前注册绝对 `kilo auth login`。收据根、所属 Agent 父目录、当前 / 收据程序均验证在既有数据目录内；外部记录、程序收据、缺失收据、替换根或父目录符号链接不授予补充权限。无新收据、二进制摘要、程序版本准入或自动配置写入。

Kilo 的类型限制针对当前输入：存在显式 `type` 不使用该补充。但 `agent-client-protocol` schema 1.9.1 的 Agent 变体序列化不输出 `type`，原始显式 `agent` 与缺省会在 typed roundtrip 后相同。因此不能宣称本片区分这两种原始 wire 声明；补充主要依赖上述精确版本、身份、收据和 argv 条件。单独回归核对这一归一化事实，不改 SDK 或协议事件。

固定官方 Kilo [服务源码](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/service.ts)与[登录命令](https://kilo.ai/docs/code-with-ai/platforms/cli-reference#kilo-auth-login)及既有归档形状见[静态收据](../2026-09-30-agent-access-mechanisms/kilo/README.md)。实际错误声明来自[目录安装观察](../2026-09-30-agent-access-directory/README.md)，先前未执行该错误命令。Amp/Qwen 的既有官方来源保留在 `recipes.rs` / `auth_compat.rs`。

## 红绿证据

| 受控检查                                               | 修复前                                 | 修复后                                                              |
| ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------- |
| 错误程序、畸形参数、绝对别名、共享 Node 脚本、脚本别名 | `target-red.log`：0 / 5，通过数为零    | `target-final-green.log`：6 / 6，含无效 typed Terminal              |
| 畸形终端扩展不能误调协议认证                           | `protocol-red.log`：0 / 1              | `protocol-green.log`：6 / 6，含既有目录与作用域回归                 |
| 共享 Python / shell 代码及 Kilo 输入类型界限           | `interpreter-red.log`：12 通过、3 失败 | `auth-verified-final-green.log`：54 / 54，包括 typed roundtrip 语义 |

最终同一 `auth` 过滤检查还覆盖路线、Kilo 收据/替换目录、Amp 显式坏路径、Qwen 环境、既有取消、账号作用域、终端退出保留及标准协议；Keychain 专项以 `--skip keychain` 明确跳过。夹具使用任务自有临时文件和受控通道，未把通过升级为真实认证、模型读取或首条消息成功。

单文件均低于 1,500 行。根任务负责最终工程全检、冻结候选和正式安装验收；本页不代替该出口。
