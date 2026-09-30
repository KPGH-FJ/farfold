# M6：Pi 组件与程序版本调查（2026-09-30）

结论：当前接入组件为 `pi-acp 0.0.34`，实际所选 Pi 程序报告 `0.80.5`。该组件固定发布文档声明 Pi `0.81.0+`，所以存在可诊断的官方支持范围缺口；这不证明当前所有接口不可用，也不能解释此前所有请求失败。下一片可复用现有依赖准备、受管程序清单和候选检查，提供独立安装候选及明确选用动作，保留日常 Pi 和旧安装。

## 当前版本与来源

2026-09-30 仅只读正式应用自己的注册与安装记录；不读取其他会话正文、凭据或私人配置内容，不打印环境值。

| 对象         | 当前字段与来源                                                                                                                                                                        | 核对结果                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Agent 身份   | 已注册 `pi`，来源 `registry`；`registry_agent_id` 保留内建 ID                                                                                                                         | 不新增 ID，不迁移既有对话                                                       |
| 接入组件     | 注册命令 `/Users/tw/.nvm/versions/node/v22.22.3/bin/node`；参数 `/Users/tw/Library/Application Support/ai.farfold.desktop/agents/pi/install-t261dt/node_modules/pi-acp/dist/index.js` | 安装 `package.json`、注册 `version`、保存握手 `agentInfo.version` 均为 `0.0.34` |
| 实际 Pi      | 所选程序 `/Users/tw/.local/bin/pi`；符号链接解析至 `/Users/tw/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`                                                    | 本机包声明 `0.80.5`，真实 `--version` 同为 `0.80.5`                             |
| Node         | 上述注册 Node；普通登录环境解析出的 Pi shebang Node 也是同一路径                                                                                                                      | 真实 `--version` 为 `v22.22.3`                                                  |
| 官方目录     | 本地缓存与本次浏览的官方目录都提供 `pi-acp@0.0.34`                                                                                                                                    | 目录分发只安装组件，不声明附带 Pi 程序或最低 Pi 字段                            |
| 现有安装收据 | `installations.v1` 中记录组件的 `install-t261dt` 根目录、版本、命令与参数                                                                                                             | 实际日常 Pi 是外部程序；不能凭路径给它受管卸载权限                              |

两个版本命令均关闭 stdin、使用 5 秒限时和自有进程组，退出 `0`，无超时、stderr 均为 0 字节。只保留严格版本字符串。Pi 的版本分支在交互模式、迁移与会话创建前退出；普通 CLI 启动会自行读取初始设置，未提取这些值，也没有设置或更新操作。

没有运行 `pi-acp --version`：本机 `dist/index.js:3040` 之后只处理 `--terminal-login`，否则进入协议输入等待，没有版本选项分支。组件版本应取包声明或保存的握手，不能把对组件的超时版本探针误记为程序坏了。本次没有启动组件握手、认证、`session/new` 或 prompt，也没有操作正式应用。

官方来源：[目录条目](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)、[组件 v0.0.34 包声明](https://raw.githubusercontent.com/svkozak/pi-acp/v0.0.34/package.json)、[组件启动入口](https://raw.githubusercontent.com/svkozak/pi-acp/v0.0.34/src/index.ts)。

## 支持范围与实际失败分开

- **已核实官方支持范围缺口：** 已安装组件的 README 第 44–46 行及官方 `v0.0.34` 文档要求 Node 22+、Pi 0.81.0+，并要求用户另行配置 Pi 服务。组件自身包的 `engines.node >=20` 只是组件约束，不能替代子程序的约束。Pi `v0.81.0` 官方包另声明 Node `>=22.19.0`；当前 Node 满足，当前 Pi 0.80.5 不在组件文档声明范围。[组件前置要求](https://raw.githubusercontent.com/svkozak/pi-acp/v0.0.34/README.md)、[Pi v0.81.0 包声明](https://raw.githubusercontent.com/earendil-works/pi/v0.81.0/packages/coding-agent/package.json)。
- **历史已复现接口缺失：** `docs/status.md:243` 及其原诊断记录为 Pi 0.80.2 不发送旧组件等待的 `agent_settled`，导致完成/取消不结束。这是特定旧组合的实测，不能直接套到当前程序。
- **当前静态反例：** 所选 0.80.5 的 `dist/core/agent-session.js:291` 已发出 `agent_settled`，`dist/modes/rpc/rpc-mode.js:266` 转发该事件。当前组件的 `dist/index.js:1287` 接收它；官方固定源码也明确等待这个事件。因此不能把当前程序低于文档下界等同于已经复现该事件缺失。[组件事件处理](https://raw.githubusercontent.com/svkozak/pi-acp/v0.0.34/src/acp/session.ts)。
- **仍未解决的实际请求失败：** [09-23 失败诊断](../../2026-09-23-reliability/pi-failure-diagnosis.md) 和 [09-27 冷恢复结果](../../2026-09-27-prototype-rollout/candidate7-pi-native-outcome.md) 记录零回答、服务连接错误和组件失败信息缺失。后者未留逐包收据，具体连接原因未知。本次没有请求复测，不把它归为版本根因，也不宣称兼容候选会解决它。

## 可复用接口与当前缺口

| 现有落点                                                                     | 可以复用                                                                                  | 本片必须补的边界                                                                                                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [preparation.rs](../../../../src-tauri/src/acp_client/preparation.rs#L15)    | 官方依赖声明、程序解析优先级、取消检查、修改时间/长度/权限的探测缓存、公共准备信息        | 目前只有 Amp 声明；版本探测缓存只保存布尔值，丢掉实际版本。应返回程序版本、所检命令来源及带出处的支持要求，不把未知或下界警告变成握手身份禁用表      |
| [agent_discovery.rs](../../../../src-tauri/src/agent_discovery.rs#L149)      | 有界 `version_output` 与自有进程组回收，现有版本解析                                      | 对经核实支持版本选项的程序复用；组件没有选项时取 manifest/握手，未知命令不能无差别启动                                                               |
| [dependency_install.rs](../../../../src-tauri/src/dependency_install.rs#L98) | 显式安装 job、配置 guard、取消/断开保护、独占候选目录                                     | 当前只支持 gzip 程序，且找到能执行的旧程序就直接返回；不能原样用于“旧版本仍存在但用户要另装兼容候选”。安装替代动作须有明确用户意图，失败不更改原选择 |
| [node_runtime.rs](../../../../src-tauri/src/node_runtime.rs#L302)            | 安装官方 npm 包到指定候选目录，读取其 bin；受管 Node 22.20.0 已存在实现                   | 通用系统复用只检查 Node 主版本 >=18；Pi 候选必须核对所选官方包 engines。别让 Node 18 的可用性代表满足 Pi >=22.19.0                                   |
| [installations.rs](../../../../src-tauri/src/installations.rs#L13)           | `ProgramReceipt`、`programOnly`、真实程序版本、受管根目录、原子元数据提交、选择与卸载权限 | 不新建账本；组件版本和程序版本分别呈现。先记录未选中的受管程序候选，再由用户在现有程序清单明确选用                                                   |
| [agent_install.rs](../../../../src-tauri/src/agent_install.rs#L227)          | 候选 `probe_launch`、进程未确认结束时保留文件、旧目标保护                                 | 检查组件 initialize 只证明组件连通；还须检查新程序自己的版本与发行要求，不能宣称真实首发/续接通过                                                    |

## 最小下一片方案

1. 在 `acp_client` 的核实声明中给 Pi 记录程序依赖、版本探测路线和固定组件文档出处；向现有准备信息增加实际程序版本及“支持范围满足/不满足/未知”的诊断。共用程序页显示“接入组件 0.0.34；程序 0.80.5；官方要求 0.81.0+”，提供检查和兼容候选动作。initialize 仍是连接准入；没有实测接口缺失时只报告支持范围，不把下界变成全功能失败结论。
2. 用户明确选择安装兼容候选后，按官方发布元数据准备满足已核实要求的完整 `@earendil-works/pi-coding-agent` 包到 `agents/pi` 的新独占目录。记录本次实际发布版本及 engines，不写全局 npm、不改 `/Users/tw/.local/bin/pi`，不删除旧组件或旧程序，不在 Agent 定义中固定一个版本白名单。仅知版本下界还不足以声称候选端到端兼容。
3. npm bin 是 Node 脚本；官方组件只接受一个程序名/路径，再自行附加参数，不能把 `node /path/cli.js` 塞成单一可执行路径。需保证它启动时使用已核对的 Node：可在本次受管目录生成仅转发 argv 的启动脚本，执行所选 Node 和原包 bin，既不改官方包，也不包含凭据、配置、HOME 或 Agent loop。这个启动文件同样由候选收据管理，检查它的 `--version`；不要假定组件绝对 Node 路径会改变子程序 shebang 的 PATH。
4. 对候选做有界程序版本检查、官方声明比较及既有组件握手检查。检查成功后保存 `ProgramReceipt` 并保留候选目录；原注册命令/参数、程序选择、会话/凭据不变。用户随后在原程序清单点选该候选，复用 `agent_installation_select` 的断开/配置保护和事务，只更新已有官方程序路径字段；故障/取消保留旧选择。若复用安装后自动选用流程，按钮必须明确表达“安装并选用”，不能让单纯安装悄悄替换日常程序。
5. 下一片验证必须分开：来源/版本诊断、候选下载与取消、明确选用/回选、程序与组件握手、同模型/推理的真实首发与冷恢复。已有 `Connection error` 和未知服务失败继续保留；不关闭保护或强改模型来证明新候选可用。

建议回归至少覆盖：0.80.5 低于有出处下界但不禁用 initialize；版本未知/非 semver 保留未知；组件无版本选项不启动等待；Node 18 与 Pi engines 不满足；已有旧程序仍能准备未选候选；取消/失败不改变原路径、历史和收据；候选明确选择/回选及受管卸载保留外部程序。上述是下一片实施输入，本次仅完成调查与两个版本命令，没有实现或安装验收。

## 具体类型与调用改动建议（只读续接）

本节只细化下一片输入，没有改源码或重跑探测。推荐采用“安装候选”和“选用”分开的动作，保留现有缺失依赖安装流程；不在这片扩展全目录配方或真实请求执行器。

### 1. 版本诊断不参与可用性布尔判定

在 `acp_client/preparation.rs` 的声明中增加可选官方支持要求，以及声明的版本来源。Pi 的程序来源为已核实的 `--version`，组件来源为包声明/握手；新组件版本没有经核对的要求时返回未知，不把 0.0.34 的说明套给所有未来组件。

建议线上的增量形状如下；前端对应 `src/runtime/preparation.ts` 的 `AgentDependency`，不放到 Agent 专属组件中：

```ts
interface OfficialVersionRequirement {
  componentVersion: string | null;
  range: string;
  sourceUrl: string;
  state: "satisfied" | "unsatisfied" | "unknown";
}
// AgentDependency 的可选新增字段；旧返回值仍可读。
interface ProgramVersionDiagnostic {
  programVersion?: string | null;
  componentVersion?: string | null;
  versionRequirement?: OfficialVersionRequirement | null;
  canInstallCandidate?: boolean;
}
```

保留 `status: ready/missing/failed` 与现有 `requiredForUse/requiredForInstall` 的职责：程序不存在或路径不可执行才属于依赖不可用；版本未解析、检查超时或未满足文档支持范围，只写诊断，不把它变成 `failed` 或让 `AgentPrerequisites.updateReadiness` 返回 false。版本未知不能宣称执行成功，但也不能仅凭这个观测阻止既有连接尝试。现有 Amp 的检查语义不必一起改：新增通用观测返回值，旧 `check_program` 可继续投影它原有的布尔检查结果。

程序探测的缓存由 `FileStamp -> bool` 扩展为保存实际版本/观测结果；显式“重新检查”应绕过旧结果。受管启动脚本还依赖 Node 与包入口，不能只以启动脚本本身的修改时间证明其依赖没有变化。选择候选前必须重新执行声明的有界版本检查；不引入 SHA、常驻监听器或新身份表。

共用准备页显示两个版本和要求出处。当前例文案为：“程序 0.80.5；接入组件 0.0.34。官方要求程序 0.81.0 或以上，当前未满足；仍可尝试使用。”提供“重新检查”和“安装兼容程序”动作。此警告不新增强制升级确认，也不关闭连接、模型读取或用户显式短测；原认证、忙碌、模型保护与实际接口失败准入继续生效。

### 2. 数据声明驱动候选安装

将 `DependencyDeclaration` 现有 gzip 分发字段收拢为内部 `DependencyDistribution`，保留旧 Amp 路线，新增官方 npm 包路线；Pi 名称、程序字段及官方依据仍只在 `acp_client` 声明中出现。`dependency_install.rs` 按通用分发变体调用 gzip 或 `node_runtime::npm_install`，不写 Pi 品牌分支。

最小内部形状可为 `Gzip { version_url, download_base, platform } | Npm { package_name, bin_name }`；通用声明仍保留 `id/name/binary/program_env/source_url`，另加可选 `support_requirement` 和已核实的 `version_source`。npm 路线先读官方发布元数据确定这一次用户可见的候选版本及 engines，再传具体包说明给现有安装器，不执行全局安装、不使用浮动 `latest` 包说明，也不把这次下载版本写成 Agent 的长期 pin。缺少发布或要求依据时只给官方说明入口。

给现有安装命令增加可选 `mode: install_missing | prepare_candidate`，缺省保持旧行为。对应 `installAgentDependency` 的参数也缺省原模式；新按钮只在 `canInstallCandidate` 有核实分发依据时显式传 `prepare_candidate`。新模式不走“已有可执行程序就返回”的分支，不覆盖原程序；没有出处的包名/要求不允许前端任意提交。

`AgentPrerequisites` 的候选按钮和处理器不能复用目前 `status === ready` 就返回、只对非 ready 显示安装的条件，否则当前低版本可执行程序仍到不了动作。候选模式独立检查 `canInstallCandidate`、同 Agent 安装所有者和取消状态。

候选准备不调用现有 `onBeforeInstall`：当前该回调会先 invalidate 准备结果并调用 `agent_disconnect`，会影响正在使用的程序。新模式在独占目录下载/检查/记录未选候选，复用 job、配置串行和取消；不替换目标、不 invalidate 当前已验证选择、不停正在工作的连接。`configuration_guard` 当前明确不串行 prompt 执行，可保留它保护候选记录与其他配置动作。发布前重新核对所依赖的组件/声明是否变化，变化则保留旧目标并提示重试，不借首次快照直接选用。

### 3. 固定 Node，复用安装清单

候选安装先按实际所选官方包的 engines 选择合格 Node；系统 Node 不满足时，用户的本次候选安装动作可以使用现有受管 Node 路线。不能只提高整个系统复用主版本到 22 就称满足 `>=22.19.0`，也不能改变日常 PATH/Node。对复用 Node 与下载 Node 都做本次实际版本核对。

`NodeRuntimeState` 可增加通用 `get_for_engine(requirement, job)`，旧 `get(job)` 的调用不变；它依据 Node 的真实版本筛选系统/已有受管候选，只有本次显式安装需要且没有合格工具时才进入现有下载路线。此要求来自官方包元数据，不由前端指定 Agent 名称或推测阈值。

候选目录中的纯 `exec` 启动文件使用独立 argv 执行所选 Node、官方 bin 和转发参数。路径需正确引用，含空格/引号时仍只表示路径，秘密不得进入脚本。它必须以原 cwd 和继承环境启动，不设置私有 HOME，不增加配置覆盖或关闭扩展。该文件不包含循环、协议、认证或会话逻辑。

建议 `ProgramReceipt` 和既有 `Installation` 仅增加可选 `nodeLaunch: { node, entrypoint, nodeVersion }`，保存在原 `installations.v1` 中，旧记录缺省为无；不改变清单身份，不另写 launcher 账本。这样选择前能核对当时固定的 Node 路径与版本、确认官方入口仍位于受管根目录，然后重新执行启动文件的 `--version`。旧外部程序记录没有此字段时沿原官方检查路线，不以缺字段要求迁移或删除。

完成下载、包/Node 版本检查和启动文件检查后，取消检查与 `record_with_program` 应在 `Job::commit` 内发布未选候选收据并保留目录；不调用 `commit_agent_candidate` 或现有 `check_and_select_program` 来偷偷选择目标。收据写失败不得报告已安装；已取消不得发布成功。若发布后才收到取消，返回已经完成的发布事实，不能伪报已回滚。

组件 initialize 留在下一步显式选择时执行；候选仅完成程序检查就发布时，界面只称“已安装，尚未选用”，不能称为已连接或完整兼容。这样候选下载也无需断开原连接或启动第二个真实会话。

### 4. 明确选用与回选

候选进入共用 `ProgramManager` 的 `programOnly` 列表，版本取真实 Pi 版本，组件行保持 0.0.34。用户先通过现有显式断开入口结束空闲连接，再点“选用”；工作、审批或结果未知时继续拒绝断开/选用，不自动取消任何活动。

`agent_installation_select` 继续复用 `configuration_guard`、`require_disconnected`、当前 row 比较和原子提交。对程序候选先重检 Node/入口/声明版本，再将其路径写到已存在的官方程序字段，保持组件命令/参数、用户配置、凭据和会话元数据不变，随后由现有候选 initialize 检查确认组件仍能连接。失败保留原选择；成功后才刷新目录/准备并使与程序选择相关的准备证据失效，后续模型和请求仍显式核验。

日常 `/Users/tw/.local/bin/pi` 保留在外部程序清单中，用户用同一选择动作回选；不需要复制、重装或撤销全局安装。旧版本支持范围警告仍显示，并仍可尝试。卸载只处理未选用、未使用且有合法受管收据的候选根目录，不能顺带删除共享 Node、日常 Pi、旧组件、设置或历史。

## 下一片回归矩阵

| 用例                                             | 应验证结果                                                                | 层级                             |
| ------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------- |
| 程序 0.80.5、组件 0.0.34、已核实 >=0.81.0        | 显示未满足及出处；依赖可执行仍 ready，initialize/显式短测不被版本警告阻断 | 声明/共用前端回归                |
| 无要求出处、新组件版本、非 semver、版本探测超时  | 保留未知，不伪报失败或满足，不无依据执行组件版本选项                      | 探测/类型回归                    |
| 组件无 `--version` 分支                          | 从 manifest/握手展示组件版本，外部调用次数为 0                            | 探测夹具                         |
| 旧 Amp/uvx 返回值没有新字段，旧安装命令不传 mode | 原依赖安装/取消和 readiness 语义保持                                      | 已有回归 + 类型检查              |
| 已有可执行低版本 Pi，点击安装兼容程序            | 不再 no-op；使用新目录，不调用 disconnect/invalidate，不自动选用          | 真实状态模块/受控安装            |
| 正在工作时准备未选候选                           | 原工作、模型、推理、队列、连接继续；发布仅多一条未选收据                  | 生命周期回归；安装版定向观察     |
| Node 18、22.18、22.19.0、当前 22.22.3            | 按所选包 engines 判断；不合格 Node 不生成“兼容”候选，系统 PATH 不变       | 版本比较/候选回归                |
| Node、bin 或目录含空格/单引号，转发多参数        | 严格 argv，固定所选 Node，原 cwd/继承环境保持；无命令拼接执行             | 自有临时 Node/脚本夹具           |
| 下载/执行/收据失败、取消早于提交                 | 原 row、程序选择、会话、凭据不变；无伪成功，所有自有过程回收              | 安装/事务回归                    |
| 提交完成后迟到取消                               | 返回已发布但未选用的事实，不声称删除了候选                                | job 边界回归                     |
| 准备期间组件/声明被替换，或选择前 Node/入口消失  | 拒绝过时声明/损坏候选；原选择保持，提示可重试                             | 竞争/重检回归                    |
| 已连接、有工作/审批/未知结果时点选候选           | 既有保护拒绝选用，不隐式停止或断开工作                                    | 共用操作保护回归                 |
| 空闲显式断开、选用新候选、再回选旧外部程序       | 同 Agent ID；只改变程序字段，组件命令/参数、旧对话/配置保持               | 事务 + 安装版程序旅程            |
| 未选候选卸载、候选被使用、旧外部 Pi、共享 Node   | 只卸载有权限的候选；其他目标保留                                          | 收据/卸载回归                    |
| 新候选原模型/推理首发与冷恢复                    | 原选择保持；分别记录真实成功、失败与未知，不抹去既有连接失败              | 正式安装版真实 Agent；本次未执行 |

这份矩阵用于确定下一片必要测试；声明、夹具和源码通过不能代替最后两类真实安装旅程。当前 uvx 候选冻结/打包不因本节增加任何源码修改。
