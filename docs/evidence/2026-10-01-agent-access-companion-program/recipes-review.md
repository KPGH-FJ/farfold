# 伴随程序配方与准备信息

本记录覆盖本片实现作者负责的配方、准备信息与受控测试，不是完整安装验收或独立审查结论。没有运行真实 Agent、安装程序、操作正式应用或读取用户账号配置。Cargo 由根任务串行执行。

## 官方范围与实现

依据[固定官方材料](official-autohand.md)及 [batch2 登记](../2026-10-01-agent-access-directory-batch2/autohand-registration.json)，新增 `registry:autohand` 的 `@autohandai/autohand-acp@0.2.1` 配方。适用启动形状是绝对 Node 程序加唯一绝对组件入口；完整 `node_modules/@autohandai/autohand-acp` 路径、manifest 包名、`bin.autohand-acp` 与 canonical 入口必须一致。包根和入口均须位于 canonical `node_modules` 范围内；外部包或入口的符号链接不取得补充能力。

配方的精确组件版本仅限定本次已核实补充。实际 manifest 与登记版本都须为 `0.2.1`；未知或不一致的组件只保留诊断，不交付环境、不增加使用门槛、不启用安装候选。其他 Agent 的通用 `initialize` 路线不增加此项限制。Amp/Pi 保留既有声明，Amp 未知组件版本的官方二进制登记仍有效。

伴随程序声明为 `autohand-cli`，命名入口 `autohand`，官方环境字段 `AUTOHAND_CMD`，交付类型 `SearchPath`。Amp/Pi 为 `AbsolutePath`。没有把 external permission callback 的 `v0.6+` 要求泛化为全部 CLI 的最低版本，也没有新增环境变量。Autohand 无已核 HOME 下标准位置，因此 `home_bin_dir` 为空；Amp/Pi 的原官方位置保留。

持久选择仍保留原绝对程序路径。启动副本的安全命令名与 PATH 交付由根任务的 `dependency_environment` 实现，本文件不把声明本身当成交付通过。准备解析与该模块共享 `is_command_name`：只有 ASCII 字母数字和 `-_.`，排除 `.`/`..`。显式或继承的安全命令名在现有 PATH 查找，SearchPath 尊重登记的显式 PATH（包括空值）；找不到所选名称时保留该失败选择，不改用声明默认命令。显式坏绝对路径仍不回退。

Npm 程序准备显示实际程序/组件版本；没有官方最低版本时 `versionRequirement` 为空，而不是编造范围。仅 `verified_for` 当前匹配可提供候选、缺失安装动作和必需程序提示。程序已找到但版本未知时诚实说明可以继续尝试连接；程序检查不代表账号或请求可用。准备显示根任务的新 `companion-programs/<编码 ID>` 目录，避免原 `registry:autohand` 目录名中的冒号进入 PATH；安装、收据和受管卸载的 ownership 由各自现有机制验证。

## 受控红与最终检查

[初始红收据](recipes-red.json)执行 `cargo test --manifest-path src-tauri/Cargo.toml --locked companion_ -- --nocapture`，退出 101。[原始日志](recipes-red.log)的总过滤范围混入其他作者测试，共 14 项、8 失败/6 通过；本作者当时新增 8 项为 **5 失败/3 通过**。失败分别证明 scoped 组件未识别、未知版本诊断未呈现、准备信息未呈现以及缺失程序未受准备守卫约束，不能把所有 8 失败都算成本作者证据。

初始 fixture 的 manifest bin key 是旧 helper 的通用 `component`。生产修复时改为包名末段，Autohand 使用真实 `autohand-acp`；原红仅证明 scoped 根缺口，不单独证明精确命名入口校验。之后补了同脚本但无关 bin key 的拒绝，以及 SearchPath 的显式 PATH/缺失名称/空 PATH 和未知组件版本动作门控。最终为配方 5 项、准备 5 项；均只使用测试自己的目录、公开 manifest、短程序版本脚本，不发现或执行真实 CLI。

根任务[首轮完整检查](checks-rust.json)的 fmt/clippy 退出 0，测试为 525 通过、1 失败、3 既有忽略，退出 101；本作者的 10 项在该轮全部通过。唯一失败是根任务新增 manager 测试把正常 handshake/更新时间刷新当成不应发生的登记变化，根任务仅修正该断言，保留[首轮失败日志](rust-2.log)，没有据此修改本作者生产源码。

根任务[最终完整检查](checks-rust-final.json)的 fmt/clippy/test 均退出 0；[最终测试日志](rust-final-2.log)为 **526 通过、3 既有忽略**，本作者配方 5 项与准备 5 项均通过。此处是受控代码验证，不能替代 Autohand 正式安装、账号、首次请求或恢复验收；旧 `npm install -g` 登录入口的安全验证保持原边界。

## 本作者冻结范围

以下四文件完成独立 `rustfmt` 与 `git diff --check`（退出 0），源码与测试已释放并保持冻结。摘要只描述本作者范围，不是整个安装候选身份。

| 文件                                                                                                           | 行数 | SHA-256                                                            |
| -------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------ |
| [recipes.rs](../../../src-tauri/src/acp_client/recipes.rs)                                                     |  496 | `b67b337abd77ecfbdfafbb307c9f5a5ad8176619ca303c0e24196938ebcb215a` |
| [preparation.rs](../../../src-tauri/src/acp_client/preparation.rs)                                             |  925 | `31b0af1c49f2c86e54446df9c341b78272020fc7a7a32c8d122daaf8a33b3212` |
| [companion_recipe_tests.rs](../../../src-tauri/src/acp_client/recipes/companion_recipe_tests.rs)               |  126 | `5439267d7ad0bccd946abae65d4e728d0cc552a6e7c2b700997f62bcedbcc8cf` |
| [companion_preparation_tests.rs](../../../src-tauri/src/acp_client/preparation/companion_preparation_tests.rs) |  158 | `2eeb517192f2e600aace4856bfc54587cca051a48bbefa6b52464c05fa49541b` |

根任务随后按固定组件的 `isStub` 事实追加 `reject_cwd_name_collision` 声明字段：仅已核 Autohand 为真，其他配方为假；最终交付检查实际启动 cwd 下的**词法命令名**，文件、目录或有效符号链接存在即拒绝，只有 metadata 的 `NotFound` 放行，其他读取错误明确拒绝。该检查不读取内容、不改名或删除文件、不新增账号状态或 UI 分支；仅针对新连接启动前，运行后新建同名项的变化不在本片保证内，账号与真实请求仍需独立验证。独立只读复核该增量未发现行为阻断，没有运行 Agent 或 Cargo。

因此上表是本作者先前冻结摘要，**不是最终候选摘要**；根任务追加影响 `recipes.rs`、`dependency_environment.rs` 与 `manager.rs`，见[范围变化](collision-scope-change.json)及[最终候选输入](candidate-source.json)。[同名冲突红收据](collision-red.json)退出 101、1 项失败；对应测试覆盖文件、目录、有效 symlink 三种自有 fixture，环境不被部分改写。根任务[追加后完整检查](checks-rust-collision-final.json) fmt/clippy/test 均退出 0，[日志](rust-collision-final-2.log)为 **527 通过、3 既有忽略**。这些结果仍不是 Autohand 正式安装、账号或请求成功证据。
