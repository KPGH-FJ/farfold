# 受管候选路径：补丁准备记录

2026-10-01。以下为应用前的补丁准备记录：当时未修改生产源码或测试文件，未运行 Cargo、Agent 或安装版。原三份补丁及其摘要保持；后续授权实施的红绿与冻结身份见[实施记录](implementation.md)。本材料不是第二活动计划。

[候选补丁](candidate.patch)共 14 个文件：8 个生产文件、6 个测试文件；其中新增 10 个测试、调整 2 个既有安装回归。所有候选单文件不超过 1,500 行，最长 1,106 行。[输入与候选摘要](patch-manifest.json)记录应用前应重新核对的精确源码身份。

## 已证事实与范围

Junie 官方 ZIP 的 `$APPDIR` 类路径经过 jpackage 原样展开，JVM 在 macOS 按冒号拆分；旧受管路径含 Farfold 加入的 `registry:junie`。公开源码链、独立探针与旧安装证据差异见 [path-followup.md](../2026-10-01-junie-framing/path-followup.md)。这证明存在可构造的路径分隔风险，**没有证明旧 `parse_error` 的具体原因，也没有证明候选已修复 Junie 安装**。

新候选统一使用 `data/agent-installations/agent-<字节百分号编码>/install-*`。例如 `registry:junie` 的目录组件为 `agent-registry%3Ajunie`。这只避免 Farfold 自己加入的分隔符；不改变 app data_dir、不改外部 Agent，也不承诺用户自选祖先路径不存在其他分隔符。

## 最小生产边界

- 新 `managed_paths.rs` 集中现有纯编码、逐级非符号链接目录检查和精确根验证；`managed_programs.rs` 继续提供原伴随程序父目录，名称与位置不变。新普通目录与旧 `agents` 独立，避免编码后的 ID 与旧原文 ID 混入同一命名空间。编码互异测试只证明词法字符串互异；未证明大小写不敏感文件系统上所有 ID 都有不同物理目录。
- `agent_install.rs` 仅将共有 staging 父目录切至上述函数，覆盖 Npx、Binary、Uvx。参数、环境、cwd、候选握手、取消、CAS、收据提交及 `keep` 流程保持。
- `installations::owned_root` 以 `program_only` 区分新普通根与伴随程序根；二者均可核对合法旧 `agents/<原 ID>`，但不能互认新命名空间。只接受已存在收据里的精确直接子目录。缺失根仅用于原卸载后元数据重试；其父目录仍必须可核验。
- Kilo 的受管证明、Copilot 同包 loader/platform 证明、Goose 显式配置动作证明使用相同普通根校验，保留各自原收据、版本、命令、参数和包结构条件。路径自身不增加权限，不把伴随程序收据当普通组件。
- 原安装不迁移，不改旧 command/args/收据/当前选择。旧 ID 必须确为单个目录组件；绝对 ID、`..`、路径分隔及旧父目录被符号链接替换不能凭“兼容”扩大管理权。没有新索引、映射表或别名账本。

## 应用与红绿顺序（尚未执行）

根任务完成当前安装并明确释放源码后：

1. 重核 [manifest](patch-manifest.json) 中所有 base 摘要；不匹配时先重审补丁，不能盲目应用。
2. 应用 [red-tests.patch](red-tests.patch)。它只使用既有生产 API，可先运行安装父目录、旧/新归属、逃逸及三种既有认证/配置证明反例；此时未实现新目录应出现行为失败。不要把编译失败当红证据。
3. 应用 [implementation-after-red.patch](implementation-after-red.patch)，再运行对应回归及新 `managed_paths` 纯路径测试。组合结果与一次性 [candidate.patch](candidate.patch) 相同；不能将两种应用方式重复叠加。
4. 根任务统一 fmt/clippy/全量检查、打包与正式 Junie 安装复验。安装失败必须保旧选择和收据；最终握手仍由 SDK 决定，不放宽协议解析。

受控覆盖包括：编码互异及独立命名空间；祖先/根/broken symlink；旧路径逃逸和缺失根重试；普通与伴随程序不可互认；旧新安装可分别选择与卸载；Kilo/Copilot/Goose 原证明仍可使用新目录；原 native 安装 argv/env/提交/候选失败保护。原未变认证/typed Terminal、取消、握手与全部历史出口仍需相称集成检查。

## 当前检查

[patch-checks.json](patch-checks.json)：三份补丁的 `git apply --check` 均为 0；14 份候选文本经 stdin 交给 rustfmt，仅保存格式化后的补丁，未写回源码或递归处理模块。输入源码核对保持。**这不是编译或测试通过记录**；Cargo、真实回归红绿及安装结果均待后续授权阶段。
