# uvx 分发机制调查与实施方案

调查日期：2026-09-30。此目录记录只读源码/官方资料调查和待实施方案；未安装 uv、Python 或 Agent，未运行 Agent，未操作正式应用。下述命令只描述拟议实现，不是成功记录。

## 当前事实与主要风险

- 登录 PATH 及 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.cargo/bin`、`~/.npm-global/bin` 未找到 `uv` / `uvx`，因此没有可报告的 uv 版本。PATH 中仅发现 `/usr/bin/python3`，`--version` 返回 `Python 3.9.6`；此检查不是全盘文件检索。
- 当前 `RegistryDistribution.uvx` 保留为 JSON，但 `AgentLaunch` 和安装分支仍只有 Binary / Npx。目录声明可用不等于可安装。
- [官方目录 fast-agent](https://raw.githubusercontent.com/agentclientprotocol/registry/main/fast-agent/agent.json) 声明 `fast-agent-acp==0.10.1`、参数 `-x`；[minion-code](https://raw.githubusercontent.com/agentclientprotocol/registry/main/minion-code/agent.json) 声明 `minion-code@0.1.44`、参数 `acp`。它们与[本片前序缓存快照](../../2026-09-30-agent-access-first-slice/registry-snapshot.json)中的两个 uvx 条目一致。快照中的 `envKeys` 是脱敏投影，不能据此重建环境值；实现必须读取实际目录声明，并复用现有用户环境覆盖规则。
- `name@version` 是 uv 工具命令的精确版本语法；传给 `uv pip install` 或 `--from` 的 requirement 必须变成 `name==version`。不能原样把 `minion-code@0.1.44` 当作 PEP 508 requirement。[uv 工具指南](https://docs.astral.sh/uv/guides/tools/)
- uvx 环境属于可删除缓存，清缓存后会重新创建。把共享 uvx 路径登记为“已安装 Agent”，会使后续连接隐式下载包，且无法定义每个 Agent 的卸载范围。使用受管 venv 后直接启动官方脚本可避免此问题。[uv 工具环境](https://docs.astral.sh/uv/concepts/tools/)
- [fast-agent-acp 0.10.1 的发行元数据](https://pypi.org/pypi/fast-agent-acp/0.10.1/json)要求 Python `>=3.12,<3.15`；[minion-code 0.1.44](https://pypi.org/pypi/minion-code/0.1.44/json)要求 `>=3.11`。当前发现的 3.9.6 不满足任一条。uv 默认可能自动下载 Python；探测、创建 venv、安装包必须显式禁用这种自动下载，缺依赖时转到准备页。[Python 选择与下载](https://docs.astral.sh/uv/concepts/python-versions/)

## 最小实施路径

1. `agent_catalog.rs` 增加 typed `RegistryUvx { package, args, env }` 和 `AgentLaunch::Uvx`，保留未知声明。维持已有 Binary → Npx 的优先级，仅在前两种没有可执行路线时选 uvx。不将包规格当 shell 命令执行。
2. `uv_runtime.rs` 做通用工具发现：从 `shell_env::command_env()` 的 PATH 找 `uv`，再找 `uvx` 旁的 `uv`；有界读取 `uv --version`。`uvx` 独自存在不代表可以调用 `uv venv`。发现已有工具后优先复用；不重写用户 PATH，不校验已有 uv 二进制摘要。
3. 准备页依照目录的 uvx 分发机制显示通用 `uv`、`Python` 依赖。首次添加 Agent 时 `row=None` 也必须工作。复用 `AgentPrerequisites` 的明确安装按钮、忙碌/取消/重读行为；工具检查本身不安装任何东西。
4. 明确点击依赖安装后，准备缺失的受管 uv / Python。依赖动作的作用域、官方来源、目录和所需程序应在现有准备详情里可见；完成后重读准备信息。此动作不要求已有 AgentRow、不修改选用目标、不发起 Agent 握手，也不进行账号或凭据操作。
5. 点击条目安装后，在现有 `app_data/agents/<agent_id>/install-*` 中建 venv、安装官方包、检查声明脚本存在，再通过原 `check_and_select` 完成候选握手、进程回收和事务提交。任何准备或检查失败保留旧目标。

依赖安装与 Agent 包安装是两个明确的动作。仅实现“已有 uv 可复用 + 缺依赖提示”可关闭一部分错误出口，不能关闭本机 uvx 安装目标。

### 包规格与入口

| 原目录 package           | 包安装 requirement    | 官方脚本         | 原目录 args |
| ------------------------ | --------------------- | ---------------- | ----------- |
| `fast-agent-acp==0.10.1` | 原样                  | `fast-agent-acp` | `-x`        |
| `minion-code@0.1.44`     | `minion-code==0.1.44` | `minion-code`    | `acp`       |

脚本来自[fast-agent 官方包装包声明](https://raw.githubusercontent.com/evalstate/fast-agent/main/publish/fast-agent-acp/pyproject.toml)和[minion-code 官方项目声明](https://raw.githubusercontent.com/femto/minion-code/main/pyproject.toml)。这些源码声明支持入口设计；安装后的真实包仍需从其 `.dist-info/entry_points.txt` 验证该 console-script，不以当前 main 的其他版本替代实际包证据。

先支持本目录用到的具名包、`name==exact`、`name@exact` 形式。解析器要验证名称与版本、拒绝空值/选项/路径/URL/控制字符；不把任意字符串拼进 shell。未来目录出现 extras、范围、URL 或包名不同于命令名的声明时，保留声明并给出诚实的暂不支持出口，再按官方语义补充；不要猜入口或执行任意 `--help` 来预热环境。这里读取/遵循目录自带版本，不新增 Agent 兼容性 pin。

拟议调用（Rust `Command` 逐参数构造；所有路径均为绝对路径）：

```text
<uv> --no-config --no-python-downloads --cache-dir <owned-cache> venv --python <existing-or-managed-python> <candidate>/venv
<uv> --no-config --no-python-downloads --cache-dir <owned-cache> pip install --python <candidate>/venv/bin/python <normalized-requirement>
<candidate>/venv/bin/<declared-console-script> <registry-args...>
```

`uv pip install --python` 可以指定目标 venv，避免依赖 `VIRTUAL_ENV` 或修改系统 Python。[官方环境说明](https://docs.astral.sh/uv/pip/environments/)

安装命令继承原有环境、不使用 `env_clear`；`--no-config` 避免安装器从项目/用户 uv 配置推断目标。最终 Agent 仍继承其原有用户配置和真实 HOME。候选目录创建后保持同一路径直到 `TempDir::keep()`，不重命名含绝对 shebang 的 venv。脚本路径必须位于候选根目录内；解释器可以引用已确认的共享运行环境。

## 受管依赖下载与目录

拟议固定运行工具版本是 **uv 0.12.18**，官方发布日期 **2026-09-22**，满足依赖存在 ≥7 天；截至调查时间，0.12.19/20/21 尚未达到此门槛。[官方 release](https://github.com/astral-sh/uv/releases/tag/0.12.18)

Apple Silicon 官方归档：

```text
https://github.com/astral-sh/uv/releases/download/0.12.18/uv-aarch64-apple-darwin.tar.gz
sha256: cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b
```

摘要来自[官方 release 的展开资产列表](https://github.com/astral-sh/uv/releases/expanded_assets/0.12.18)，资产时间 `2026-09-22T23:00:44Z`。这是运行工具下载归档的完整性校验，不是 Agent 握手之外的二进制身份门槛。本次没有下载此归档，因此未验证实际归档内容或运行结果。镜像 `.sha256` 本机 GET 返回 403；GitHub API 整体响应读取中断。不可把这些请求记为下载/校验成功。

Python 可采用 **CPython 3.12.13、20260807 build、darwin-aarch64**，满足两个样本且发行 build ≥7 天。[官方 build release](https://github.com/astral-sh/python-build-standalone/releases/tag/20260807)与[uv 0.12.18 固定下载清单](https://raw.githubusercontent.com/astral-sh/uv/0.12.18/crates/uv-python/download-metadata.json)给出：

```text
https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-aarch64-apple-darwin-install_only_stripped.tar.gz
sha256: 25baa97c65b3f0aa90e21131b4f9e80aef8899e8144006db8a9d2c1ab9e807e3
```

推荐与 Node 一样直接下载该冻结的官方 Python 归档，校验后展开到自有目录；这样已有系统 uv 也不会把同一 Python 版本解析到未审查的新 build。替代方案可使用受管 **0.12.18** 的 `uv python install --install-dir <owned-python-root> --no-bin 3.12.13`，但必须确认其选中的 build 与上述清单一致。任意系统 uv 的自动下载不能视为等价。[官方 CLI](https://docs.astral.sh/uv/reference/cli/)

拟议布局沿用 Node 的共享运行工具模式，不新增第二份安装账本：

```text
app_data/uv/uv-0.12.18/                 # 官方 uv / uvx
app_data/python/cpython-3.12.13+20260807-aarch64/  # 官方 Python
app_data/uv/cache/                     # 安装器自有共享缓存
app_data/agents/<id>/install-*/venv/    # 每次独立 Agent 候选
```

运行工具各自在同层临时目录完成下载/校验/展开/有界 `--version` 检查，再在 `Job::commit` 保护下原子保留到确认位置；失败/取消删除本次临时目录，已经完成且可能被其他 Agent 使用的依赖保留。后续操作传 Python 完整路径，因此无需 `UV_TOOL_DIR`、`UV_TOOL_BIN_DIR`、`UV_PYTHON_INSTALL_DIR` 或私有 HOME。`uv tool install` 的持久工具目录主要靠环境变量定位；本方案不采用这条路线，也不需要解释放宽“不得新增 env”规则。

`Job::download_bounded(..., origin=Some(...))` 只允许同 origin 重定向，不能机械套用 Amp 下载：GitHub 官方 release 会跳转到资产 CDN。这里使用 **固定官方起始 URL + `origin=None` 的现有 HTTPS-only 下载 + 固定官方归档摘要 + 压缩大小上限**，保留 reqwest 的有界重定向；不新增域名豁免。uv 归档可限 128 MiB，Python 归档 256 MiB，展开同样设置文件/总大小上限，并检查路径与链接。即使下载绕到 CDN，未通过摘要仍不得展开/执行。下载 403/中断/超限均保留明确失败出口，不跳过校验。

## 接入位置与现有机制复用

| 文件                                                                 | 最小改动                                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src-tauri/src/agent_catalog.rs`                                     | typed uvx 声明、分发选择、规格解析/保留未知声明                                                 |
| `src-tauri/src/uv_runtime.rs`（新）                                  | 通用 uv/Python 发现、受管依赖准备、目标 venv 包安装；复用 `node_runtime.rs` 的发现/官方归档思路 |
| `src-tauri/src/acp_client/preparation.rs`                            | 从目录分发机制派生运行工具依赖，支持首次安装 `row=None`；品牌知识仍留接入层                     |
| `src-tauri/src/dependency_install.rs`                                | 在 `get_agent` 前分流运行工具动作；复用 Job/配置预约/取消，保留原伴随程序候选语义               |
| `src-tauri/src/agent_install.rs`                                     | Uvx 准备返回同一 PreparedInstallation，复用 env 合并、`check_and_select`                        |
| `src-tauri/src/installations.rs`                                     | 复用现有 Agent 收据与 managedRoot；无需把共享 uv/Python 收据伪装成 Agent 程序                   |
| `src/components/AgentPrerequisites.tsx` / `src/runtime/preparation*` | 继续按准备数据驱动，必要时扩充通用依赖文案/阶段；不写 Agent 名称分支                            |
| `src-tauri/src/lib.rs`                                               | 注册通用运行工具状态；沿用现有依赖安装 IPC                                                      |

现 `dependency_install::prepare` 要求已经有 AgentRow，且靠 `program_env` 交付伴随程序，不能直接复用为 uv/Python，否则首次安装形成前置环。运行工具依赖仅影响安装器，最终 Agent 的 command 是 venv 内官方脚本，无需注入新的程序路径 env。

包候选必须由现 `manager.probe_launch` 确认握手和退出，再由 `Job::commit + installations::commit_candidate` 一次提交目标/收据。取消、握手失败、旧选择发生冲突时均不选用候选；若候选进程回收状态未知，沿用现有保留目录/收据出口，不删除进程仍可能需要的文件。

卸载某 Agent 只删除其确认 ownedRoot 下的 install-*，沿用“当前选用、正在使用、被其他记录引用、符号链接”等拒绝规则。不执行 `uv cache clean`，不删除用户 uv/Python/工具目录，不因为删一个 Agent 删除共享运行工具。独立依赖卸载和依赖引用检查尚属后续完整生命周期工作，不能用这一安装切片宣称已完成。

## 测试与正式安装验收条件

- 规格/声明：两个真实目录形状及 env/args 保持；`@exact`→`==exact`、非法选项/路径/URL/控制字符失败；执行文件必须在候选内，错误入口不猜测、不标成功。
- 依赖：仅 uvx 或仅旧 Python、已有合适 uv/Python、首次无 AgentRow、受管依赖可复用、404/403/断流/摘要错误/超限、取消下载与展开；不写用户配置/PATH、不新增 env、不输出原始 stderr、HTTP 认证数据或环境值。
- 候选：包安装失败、缺 Python、包不支持选定 Python、握手失败、提交前取消、旧目标变化与清理未知都保留旧选择；成功只登记 venv 脚本/原 args/原 env/目录声明版本；卸载只删 ownedRoot。
- `Job.run` 已有安装子进程组、取消/超时清理及 stderr 脱敏。uv 错误先沿用通用诚实错误；若增加分类，只接受有限分类标识，禁止直接展示安装日志。
- 在同一正式 `/Applications/Farfold.app` 候选内实测：缺依赖页→显式准备 uv/Python→条目安装→fast-agent `-x` 与 minion-code `acp` 握手/模型读取；至少一个真实成功安装，以及一个取消/失败保留旧目标出口；退出核对本轮全部后代进程。
- 安装/initialize/模型读取与账号/首条消息/续接分别记录。缺账号、缺模型服务、无结构化登录声明都保留真实结论，不把 uvx 安装成功升级成两 Agent 全流程通过；首条消息、返回原稿、冷续接仍需实测后才能标成功。

当前结论：两个 uvx 目录条目的官方安装/入口语义已核对，最小接入与受管依赖方案可供编码；实际 uv/Python/包下载、候选握手和正式安装验收均未执行。
