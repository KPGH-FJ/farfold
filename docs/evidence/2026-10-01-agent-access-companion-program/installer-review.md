# 官方伴随程序安装：发行选择与准入

本子任务负责 `npm_release.rs`、`dependency_install.rs` 及两个同目录测试文件；未运行 Cargo、真实安装、Agent 或正式应用。所有 Cargo 检查由根任务串行执行。配方/准备信息由另一子任务维护，受管父目录及收据归属兼容由根任务维护。

## 设计与当前实现

- `npm_release::select` 的 `range` 改为 `Option<&str>`。已查全仓只有 `dependency_install.rs` 一个生产调用；`Some` 继续解析并要求匹配原范围，`None` 不创造最低版本，但仍只选名称一致、未弃用、稳定且发布满 7 天、Node 要求可识别、命令入口有效的最高明确发行。没有 floating 安装规格。
- 原实现将“没有最低版本声明”直接归为要求尚未核对。新增回归先以机械签名迁移保留该拒绝语义；两项新增行为失败、两项旧测试通过后，才落 `None` 分支修复。
- Npm 安装独立核对 `recipes::verified_for(previous)` 的当前声明身份；有 `support` 仍须 `support_for` 成功，无 `support` 才允许不传范围。此准入发生于已有程序检查、候选目录创建与下载之前，不以缺少最低版本等同于未经核验。安装器红例先确认真实 Autohand 配方命中，再证明旧实现拒绝无最低版本及 Pi 未知要求在拒绝前已经创建父目录。
- 新伴随程序父目录使用根任务提供的 `managed_programs::parent(data, agent_id)`。安装器对返回的 data 内相对路径只允许 Normal 组件，并保留逐级符号链接拒绝、目录检查与 canonical 归属检查。避免把含冒号的目录加入 PATH；不迁移旧安装、不改组件安装位置。
- 既有候选临时目录、取消检查、程序执行核对、未选收据发布和 compare-and-swap 选择链保持。新父目录的回选/卸载只由现有 program-only 收据获得权限，根任务单独收紧兼容两种精确父目录；本子任务不放宽删除范围。

## 有意义的回归范围

[npm_release_tests.rs](../../../src-tauri/src/npm_release_tests.rs)覆盖无最低版本选择、官方包名/弃用/预发布/不足 7 天/未来或无效日期/Node 要求/入口路径排除；保留 `Some` 范围，并验证精确 7 天与毫秒边界。

[dependency_install_tests.rs](../../../src-tauri/src/dependency_install_tests.rs)覆盖已核验 Autohand 组件无最低版本、不匹配来源/参数/版本拒绝，以及 Pi 原最低版本保持、未知组件在 staging 前拒绝且原 Agent/收据不变。测试仅用临时公开包清单、元数据和现有配方；不安装或执行真实程序。

## 实际检查收据

[发行选择红收据](release-red.json)及[原始日志](release-red.log)：4 项中 2 失败、2 通过，退出 101。[安装器红收据](installer-red.json)及[原始日志](installer-red.log)：3 项中 2 失败、1 通过，退出 101。上述失败均在根任务确认后再修复，未以编译失败替代行为红例。

根任务[首轮完整检查](checks-rust.json)的 fmt/clippy 退出 0；测试 525 通过、1 失败、3 既有忽略。发行选择 4 项和安装器 8 项均已通过；唯一失败是新增 manager 测试把正常 handshake/更新时间刷新误作启动设置变化。根任务仅修正该测试的比较范围，保留[首轮日志](rust-2.log)。

根任务[最终完整检查](checks-rust-final.json)的 fmt/clippy/test 均退出 0；[最终日志](rust-final-2.log)为 **526 通过、3 既有忽略**，包含发行选择 4 项及安装器 8 项。本人没有另启 Cargo，也没有将这些结果写成真实安装、账号或请求验收。

## 合并边界独立只读审查

对根任务实现的 [managed_programs.rs](../../../src-tauri/src/managed_programs.rs)、[installations.rs](../../../src-tauri/src/installations.rs)、[dependency_environment.rs](../../../src-tauri/src/acp_client/dependency_environment.rs) 与 [manager.rs](../../../src-tauri/src/acp_client/manager.rs) 未发现本片阻断：

- 新路径编码无映射表；新父目录每一级拒绝符号链接，只有匹配 Agent 的 program-only 收据可拥有其精确直接子目录。旧 `agents/<id>` 根仍可通过原归属规则；组件收据不能借新父目录取得卸载权限。相关[目录回归](../../../src-tauri/src/installations/program_directory_tests.rs)覆盖旧根、错误身份、嵌套根、缺失根后续清理与新父目录符号链接拒绝。
- SearchPath 仅应用于当前已核实配方；在服务与登记环境最终合并后执行。显式缺失选择不回退到同名程序，纯命令按最终 PATH 定位；路径有冒号或不可安全表达的命令名时拒绝，不静默换程序。保留原 PATH（包括显式空值），只对启动副本交付安全 basename 与前置目录。
- 持久登记继续保存原绝对选择；[真实 manager 受控进程测试](../../../src-tauri/src/acp_client/dependency_environment_tests.rs)分别核对已有来源及 prepared 环境、实际命令输出与持久启动字段保持。该夹具不是外部 Agent，不证明 Autohand 全旅程。

## 本作者冻结范围

四文件均未超过 1,500 行；后续只更新本证据，不改源码。

| 文件                                        | 行数 | SHA-256                                                            |
| ------------------------------------------- | ---: | ------------------------------------------------------------------ |
| `src-tauri/src/npm_release.rs`              |  246 | `3101510684bcdcff2b27578cc60b97b88d5964640743e7d283f6041a7ac5f8bf` |
| `src-tauri/src/npm_release_tests.rs`        |   85 | `e6e24f852e6bbdf1a5669d1ca55d3e2b1f6a2ff51978d7471c91ff4152d8df8e` |
| `src-tauri/src/dependency_install.rs`       |  611 | `56f7035a9a9321ed8674aae4632b81a26b9a3ca2b916bfdd297c7464c371c1b8` |
| `src-tauri/src/dependency_install_tests.rs` |  102 | `00c119abbc99bf9aa796ffa7f785ceb530c4c4049e5ff40b36892c2ed6e03c58` |

本文件是安装子任务的工程交接，不是新活动计划。受控检查、实际下载/安装与正式应用旅程分别记录，尚未验证项不得写成通过。
