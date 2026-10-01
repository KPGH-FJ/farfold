# 官方伴随程序准备与启动交付

Autohand 目录组件已经连接，但声明的 `npm install -g autohand-cli` 不能当成已核实的登录命令运行。本片将官方伴随程序接入现有准备、候选和程序库存。没有新增 Agent 专属界面、外部配置写入、登录动作或模型选择。

## 实现范围

- 精确识别 `registry:autohand` 的 `@autohandai/autohand-acp` 0.2.1 与 `autohand-acp` 命名入口。未知组件只保留诊断，不能借此补环境、安装或强制依赖；Amp/Pi 原声明继续回归。
- 官方未声明整体最低版本时，发行筛选不虚构版本范围；仍要求官方名称、稳定发行、满 7 天、有效入口和可核 Node 要求。安装使用明确版本，并经现有程序核对和原子选择；不运行全局 npm 命令。
- 组件对绝对路径的检查/恢复和新消息解析方式不同。只在最终启动副本使用安全程序名和前置 PATH；保留用户显式 PATH、其他环境及持久绝对路径，坏选择不回退。
- `Application Support` 含空格，旧 `registry:autohand` 目录还含 PATH 分隔符。新伴随安装放在应用数据内的 `companion-programs/agent-<百分号编码 ID>`，实际目录而非外部链接。旧目录不迁移；新位置仍须程序收据、精确直接父目录及无符号链接检查。
- 账号声明仍由原守卫处理。固定组件会将工作位置内的同名条目当测试程序，因此仅对该声明在新连接启动前核对同名文件/目录/有效链接是否存在，存在或检查未知则拒绝；不读取内容，不删除条目，不监控后续文件变化。准备或连接成功不等于登录、模型请求、权限和恢复可用。

官方依据与限制见[调查](official-autohand.md)，声明/准备切片见[配方复核](recipes-review.md)，发行/安装和独立合并审查见[安装复核](installer-review.md)。

## 工程与受控证据

初始红检查分别保留在 `environment-red`、`release-red`、`recipes-red`、`manager-red`、`installer-red` 的 JSON/原日志；混合过滤中的未就绪 fixture 不充当安装语义红，安装红随后单独执行。

[最终 Rust 检查](checks-rust-collision-final.json)：fmt、Clippy 和测试均退出 0，527 通过、3 项既有手动忽略。追加同名项守卫前的完整检查为 526 通过/3 忽略；该守卫单项红与范围变化分别见 [collision-red.json](collision-red.json)、[collision-scope-change.json](collision-scope-change.json)。首轮完整检查为 525 通过/1 失败/3 忽略：新增 manager 测试错误期待 initialize 不保存声明与观测时间；只修正该断言，生产代码不变，见[差异记录](initial-check-source.json)。测试通过已有设置及人工构造的所选服务两条实际 manager 启动路径，确认进程环境使用同一包装、原登记路径保持；这仍是受控进程，不是实际云端服务。

[前端复用](frontend-reuse.json)：312 个前端/构建输入与前片一致，复用 1,213 项前端测试、类型及构建；不据此代替本片实际界面验证。445 项构建输入由 `candidate-source.json` 冻结，后续候选检查继续比对。

[官方解析器受控验证](official-command-path-run.json)于 11:08 执行一次，退出 0、无 stderr；[13 项结果](official-command-path-result.json)全部符合预期：安全命令名三条路径成功，含空格裸路径/引号路径和含冒号 PATH 的对应失败如实复现，超时项回收通过，所有观察进程收口且本次临时目录精确移除。仅加载审阅过的官方纯解析函数并执行自有假程序，没有执行 Autohand CLI/Agent、网络、登录或读取用户配置。

## 安装与未完成

本文件当前记录源码和受控验证。正式候选、伴随程序实际下载/安装、重新连接、账号、首发及冷恢复须在各自证据中分别填写；此处没有提前关闭安装旅程或全目录门槛。
