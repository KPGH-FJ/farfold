# uvx 安装链独立源码审查

日期：2026-09-30。范围为本批 uvx 分发、工具准备、受管包安装、候选检查与准备界面用途字段的联接。审查期间未修改源码、未执行外部 Agent/CLI 安装、未操作正式应用，也未重复启动 Cargo 检查。

结论：首轮发现一个 P1 和两个 P2，均已由实现人员修复并增加对应回归；最后只读复审未发现新增阻断。这里的“已修复”指代码已关闭所列触发条件，回归已落盘；定向测试由实现人员执行，最终结果以本目录后续检查记录为准。源码复审不能替代安装版旅程。

## 三个具体发现与复审结果

### P1：显式 uv 配置可以改变包安装目的地

触发条件：用户环境含 `UV_CONFIG_FILE`，该文件设置了 `[pip] target` 或 `prefix`。原实现虽然传入 `--no-config` 与候选解释器的绝对 `--python` 路径，仍会继承该环境变量。uv 可能先向配置的外部目的地写入，再因候选内没有程序而被 Farfold 的后续校验拒绝；后验校验无法回滚此前的外部写入。

官方依据：uv 0.12.18 的 [CLI 声明](https://raw.githubusercontent.com/astral-sh/uv/0.12.18/crates/uv-cli/src/lib.rs)将 `UV_CONFIG_FILE` 绑定到显式配置文件参数；[配置加载源码](https://raw.githubusercontent.com/astral-sh/uv/0.12.18/crates/uv/src/lib.rs)先加载该文件，之后才检查自动发现是否关闭；[设置合并源码](https://raw.githubusercontent.com/astral-sh/uv/0.12.18/crates/uv/src/settings.rs)将未显式传入的 `target` / `prefix` 从配置合并；[pip 安装源码](https://raw.githubusercontent.com/astral-sh/uv/0.12.18/crates/uv/src/commands/pip/install.rs)随后应用该目的地。

修复位置：[uv_runtime.rs](../../../src-tauri/src/uv_runtime.rs) 的 `package_command_with_env` 在继承环境之后，仅对安装工具进程执行 `env_remove("UV_CONFIG_FILE")`。未使用 `env_clear`，未改变最终 Agent 进程的环境声明或用户配置。

对应回归：[uv_runtime/tests.rs](../../../src-tauri/src/uv_runtime/tests.rs) 的 `installation_ignores_explicit_uv_config_but_keeps_home_and_existing_environment` 检查该键被显式移除、原 HOME/PATH 保留、安装命令仍使用候选解释器绝对路径，且输入环境对象不被修改。

同版官方源码未将 `target` / `prefix` 绑定到 `UV_TARGET` / `UV_PREFIX` 环境变量，故没有增加猜测性的清理。`UV_SYSTEM_PYTHON` 虽然存在，但这里的绝对解释器路径进入 [PythonRequest::File 分支](https://raw.githubusercontent.com/astral-sh/uv/0.12.18/crates/uv-python/src/discovery.rs)，只查询指定路径，不回退到系统解释器；未发现它能重定向本调用链的证据。

### P2：创建父目录早于归属校验

触发条件：已有 `data/uv` 是指向受管数据目录外的符号链接，外部目录尚无 `cache`。原 `owned_parent(data, data/uv/cache)` 先执行 `create_dir_all`，再检查规范路径，因此会先在外部创建 `cache`，随后才返回失败。

依据为本批源码的调用顺序和文件系统反例，不依赖外部服务行为。修复位置：[uv_runtime.rs](../../../src-tauri/src/uv_runtime.rs) 的 `owned_parent` 改为逐级检查，确认既有目录不是符号链接且仍在规范数据根内，再进入下一层；`path_present` 使用 `symlink_metadata`，损坏的链接也视为既有对象，不能被当作空目标覆盖。

对应回归：[uv_runtime/tests.rs](../../../src-tauri/src/uv_runtime/tests.rs) 的 `prerequisites_cannot_create_directories_through_an_external_or_broken_symlink` 检查拒绝外链后外部 `cache` 未产生，并保留损坏链接及其不存在的目标。复审确认该修复覆盖所列静态路径反例；本审查没有执行恶意进程并发替换目录的实验。

### P2：旧 uv 被误判为可用并遮住合格候选

触发条件：PATH 中已有 uv 0.2.0。原就绪检测接受任意可解析版本，因此它被标为 Ready；界面不提供工具安装入口，安装时却必传该版本不支持的 `--no-config` / `--no-python-downloads`。优先取用旧 PATH 工具还可能遮住已存在的合格受管工具。

官方依据：[uv 0.2.0 CLI 源码](https://raw.githubusercontent.com/astral-sh/uv/0.2.0/crates/uv/src/cli.rs)没有这两个参数；[uv 0.2.37 CLI 源码](https://raw.githubusercontent.com/astral-sh/uv/0.2.37/crates/uv-cli/src/lib.rs)已经提供。0.2.37 是本实现有依据的安装工具支持基线，不宣称它是参数首次出现的版本。

修复位置：[uv_runtime.rs](../../../src-tauri/src/uv_runtime.rs) 的 `UV_INSTALL_BASELINE` / `usable_version` / `tools_in`：不把低于该基线的工具标为可用；继续检查后续 PATH 候选和受管候选，缺失时保留显式安装出口。界面说明所需工具基线；不会升级用户已有 uv。该规则不限制 Agent 版本或代替 ACP 握手。

对应回归：[uv_runtime/tests.rs](../../../src-tauri/src/uv_runtime/tests.rs) 的 `existing_tools_are_reused_and_old_python_does_not_meet_the_install_baseline` 和 `shared_managed_tools_are_discovered_without_changing_environment` 覆盖旧 PATH 工具、后续合格工具、受管替补及基线版本接受。

## 已核对的其余边界

- 取消与失败：uvx 包准备仍写入独立候选目录，使用既有 `Job::run` 回收子进程；只有 `check_and_select` 的检查及提交成功才选用新 AgentRow。已选目标、账号、会话与旧安装不因准备失败而被替换；未确认检查进程退出时沿用既有候选保留规则。
- 共享工具：uv/Python 安装由进程内全局锁串行化，等待期间可取消；摘要校验、受限解包和执行检查后才原子发布，既有目标保留。工具目录未进入 Agent 的安装收据和卸载入口，避免删除仍被 venv 引用的共享 Python。未将“没有卸载入口”写成已实现完整共享工具生命周期。
- 安装与使用：两项工具依赖均为 `requiredForInstall=true`、`requiredForUse=false`。已有 venv 直接沿用存储的命令和参数；目录缓存缺失时不会为了连接强制获取安装声明，有缓存而工具探测失败时返回缺失状态。相关回归位于 [preparation.rs](../../../src-tauri/src/acp_client/preparation.rs) 的 `installed_uvx_agent_remains_usable_without_registry_cache`、`catalog_uvx_preparation_is_available_before_registration_and_only_gates_installation`，以及 `missing_install_tools_do_not_block_existing_agent_use`。
- 启动目标：精确具名包声明、安装元数据中的包名/版本与 console-script、候选内可执行路径分别校验；venv 保持最终目录，避免搬迁破坏绝对 shebang。元数据读取只匹配目标分发并限制邮件头大小；无关包大元数据与目标长描述已有回归。
- 数据与日志：本链没有写入外部 Agent 的配置文件或增加凭据交付；安装命令输出继续走既有受限诊断，未新增原始 stderr、环境或凭据日志。目录声明的 Agent 参数和环境仍沿用既有合并方式。

## 未完成的安装验证

本审查没有下载或执行真实 uv/Python 归档，没有真实安装 fast-agent/minion-code，没有在 `/Applications/Farfold.app` 验证取消、失败、连接、登录、模型和首条回复，也没有验证共享工具的真实并行下载发布。合成归档、测试脚本、源码路径与协议握手各自只能证明对应层的行为。

后续须将检查结果、正式候选身份和实际界面旅程留在本批证据中；缺账号、网络或包兼容性条件时，记录实际失败与恢复出口，不能由本次复审结论推导为真实可用或全目录验收完成。
