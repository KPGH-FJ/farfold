# Farfold 下一阶段开发进展审查

> 2026-09-12 文档校正：本文件保留当时的研究、交接或验收记录。正文中的“当前”、Pi-only / Pi 唯一 Runtime、未采用适配器、未完成或下一步等描述仅对应原记录时点，不是当前执行指令。正式 0.1.7 已支持 Pi、OpenCode、Codex；OpenCode ACP 的 C 阶段已通过 Dev 工程出口，D Pi 仅部分实现、普通 ACP 工作台未接通，E 未开始。开发和自动续接已按用户要求暂停。最新状态以[唯一活动计划](../../plans/runtime-neutral-lifemodel.md)和[正式使用说明](../../INTERNAL-USE.md)为准；不得按旧报告重做已完成工作或清理当前用户数据。

审查对象：新开发任务截至本次 review 的 S0–S2 代码、唯一活动计划及任务完成记录。只读审查应用源码，重跑相关单元测试；没有修复应用、安装新版或读取真实凭据。

## 结论

目前处于公共基础实现阶段，尚未完成任何一路新的 ACP 用户流程，也未完成“一次配置、多 Agent 复用”的产品闭环。规格、活动计划、能力信息、Provider 元数据与版本记录有实际代码进展，但不能等同于原生配置已被分发或活动任务配置已隔离。

新开发任务本次检查时处于 idle：上一轮已结束，并非仍在持续运行。此前“会持续推进”表达的是交接要求，不是后台永不停止的运行保证。

## 需要修正的发现

### R1 · P1：旧配置的应用回执可以被记到新配置上

位置：`src-tauri/src/host_store/provider_projection.rs:62`、`:384`、`:419`。

目标投影输入只带可选的“请求验证版本”，没有每次配置应用所针对的版本。写入时取数据库最新 current_version；只有 request_state 为 verified_success / verified_failure 时才检查版本。

触发过程：开始应用配置 A → 用户保存配置 B → A 的异步应用完成，回报 applied + not_requested。该回报不进入验证版本检查，并被写成“B 已应用”。这会让 UI 与实际原生配置不一致。

建议：每个保存 / 应用 / 验证结果都绑定目标配置版本与相应操作身份；更新时比较预期版本，旧回执拒绝或只写历史。新增 A 应用中切到 B、A 完成晚到的行为测试。当前发现来自明确代码路径，尚未在安装应用复现。

### R2 · P1：任务配置绑定只是记录，未验证或约束实际执行配置

位置：`src-tauri/src/host_store/provider_projection.rs:436`；`src-tauri/src/turn_coordinator.rs:1502`、`:1524`。

bind_turn_provider_config 仅插入给定 Provider 连接和版本；数据库外键只能保证该版本存在，不能证明它已应用到本任务的 Runtime / 安装 / 连接。输入甚至不含要校验的目标 Runtime 身份。随后 OpenCode 发任务仍使用独立的 input.provider_id / input.model_id；Pi 仍直接发送原生命令，未从绑定版本取得或校验实际配置。

因此可以记下“任务使用 A”，而 Agent 实际按自己的配置或输入使用 B。当前基础代码没有兑现“活动任务保持启动时配置”的执行保障。现有测试证明了 ID 被存下，未证明运行时配置一致。

建议：任务准入时原子核对目标安装 / 连接、已应用版本和选定模型；按原生支持方式固定进程配置或会话配置，并让配置写入遵守活动任务边界。不能只增加一个状态枚举。新增错误目标、未应用版本、绑定与实际模型不一致、运行中配置变更的行为测试。

### R3 · P2：连接归属变化不使验证失效

位置：`src-tauri/src/host_store/provider_projection.rs:235`、`:279`、`:310`。

配置版本只由连接 ID、端点指纹、模型映射指纹生成；upsert 同时允许修改 provider_key 和 source，但验证失效只比较版本 ID。若端点 / 映射未变，将 managed 改为 unmanaged，旧 verified_success 仍在数据库中；改回 managed 又可沿用旧验证。record 方法对 unmanaged 的限制不能覆盖这条 upsert 路径。

建议：明确连接归属是否不可变；允许变化时强制失效相关投影和验证。后续接凭据管理时也需要独立的凭据引用 / 修订身份，不能把端点未变当作认证未变。

## 产品进展核对

| 部分               | 实际情况                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 规格与计划         | 已建立规格并在唯一计划顶部列出 S0–S5，历史交付记录保留。                                                                                       |
| 公共 Host          | 新增能力保留信息和 Provider 元数据表；身份 / 任务基础已有历史实现，新增配置绑定仍需上述修正。                                                  |
| Provider 一次配置  | 尚未接通。新 API 只有导出函数与 Tauri 命令，检索未发现设置组件调用；现有 Pi 提交也不发送新增绑定字段。没有实际配置分发器、统一凭据与目录闭环。 |
| 公共 ACP           | 本轮应用源码仅有 ACP 风险和能力说明，未发现新公共 ACP 客户端或实际协议接入。三路仍沿原有路径。                                                 |
| 本机发现与按需安装 | 目标已写进计划，现有打包配置仍包含 Pi / OpenCode 资源；去随包分发与按需安装尚未交付。                                                          |
| 文件 / diff 审阅   | 仍需按规格补全，本轮没有新完整审阅闭环证据。                                                                                                   |
| 安装应用验收       | 新任务明确未安装或替换应用，也未执行真实 Provider 请求；不能将本轮单测计为新版桌面产品可用。                                                   |

Provider 接线证据：`src/runtime/provider-projection.ts:188` 起仅声明三个调用函数；全 src 的引用检索没有设置界面调用。`src/runtime/pi.ts:296` 起的任务提交仍只组装会话、原生命令与既有可选字段。`src-tauri/tauri.conf.json:38` 起仍列出 Pi / OpenCode 资源。

## 验证证据

本次独立重跑：

- Provider 前端测试：1 个文件、5 项通过。
- Host Provider Rust 测试：3 项通过。

这些测试涵盖版本变更清理请求验证、拒绝旧验证 / 原生独立配置验证，以及绑定 ID 持久化；不覆盖本审查 R1–R3，也没有覆盖设置 UI → 配置分发 → 原生实际执行的完整链路。

新任务上一轮报告全量前端 213 项、Rust 库 288 项通过（3 ignored），类型检查、构建、clippy 和格式检查通过。本 review 没有重新跑全量检查，因此这些是上一轮记录，不是本次新验收。

## 建议后续顺序

1. 先修 R1–R3，并用行为测试保证版本、目标与实际执行一致；把进度表中的“任务保持原配置”明确分成记录已完成、执行保障未完成。
2. 做一个可见的 Provider 最小完整流程：统一入口保存连接 → 给兼容 Agent 实际应用 → 显示逐路结果 → 任务实际使用选定配置。优先闭合现有两路可复用场景，不继续只添加状态表。
3. 同时给三路 ACP 已知缺口形成明确候选处理结论，选定第一路可落地的组合；随后完成任务、交互、停止、恢复的真实安装应用流程。能力缺口未解决时不能声称无损替换。
4. 再推广安装管理、公共接入和审阅等其余切片，按同一版本做三路验收，删除被替代的旧控制路径。

本次没有修改产品代码，也没有擅自启动另一条开发路径。

## 2026-09-10 监督复核后的修复状态

本节记录后续实现对上述审查发现的处理；保留原审查文本作为当时证据，不改写历史结论。

| 项目                        | 当前处理状态                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 旧配置应用回执写入新配置 | 已在 Host 层修正。目标投影写入必须携带 `config_version_id`，与当前 Provider connection version 不一致时拒绝；晚到旧应用回执不能更新当前投影。                                                                                                               |
| R2 任务配置绑定只记录 ID    | 已补强到目标投影匹配。Turn binding 现在必须匹配已 applied 的 Runtime product、installation、runtime connection、runtime provider、runtime model 和 config version；仍未完成真实 Provider 任务的安装应用验收，不能宣布全程配置真实性闭合。                   |
| R3 连接归属变化不失效       | 已修正。Provider key、source、endpoint、model mapping 均参与 config version；后续又加入 credential revision，凭据更换 / 删除也会生成新 version 并使旧请求验证失效。                                                                                         |
| P1 请求验证误报成功         | 已修正源码边界。OpenCode 请求验证不再使用“最后模型”作为成功证据，而是以提交前原生历史长度为基线，只接受基线之后无 native error、成功 finish 且 provider/model 精确匹配的新 assistant；旧成功历史、本次错误、取消、未知和模型不匹配均不写 verified_success。 |
| P1 凭据变更身份不变         | 已升至 Host schema 10。`provider_connection_versions` 新增非敏感 `credential_revision_fingerprint`，OpenCode 每次保存 / 删除 API key 生成新的操作 revision，不存原始 key，不把 endpoint/model 未变误判为认证未变。                                          |
| UI 自报 applied             | 已补一层原生回读。OpenCode 保存后必须重新读取原生 Provider 列表，目标 provider 报告 connected 才记录 applied；重连失败或原生未报告 connected 记录 failed。成功重连仍不等于请求验证。                                                                        |

新增验证：

- 前端 OpenCode conversation / opencode / provider-projection / managed-runtime-installation 目标测试：4 文件、34 项通过。
- Rust Host schema 迁移测试：1 项通过，确认 schema 10 记录存在。
- Rust Host provider_projection 测试：7 项通过，包含凭据修订变化使旧验证失效且不存 secret。
- Rust Host runtime_registry 目标测试：5 项通过，包含 Pi / OpenCode 固定身份维度、fetch 脚本 pin、
  随包候选发现、实际文件 sha256 流式计算、错误版本 / 摘要拒绝。

仍未关闭：

- 尚未在隔离 QA 候选应用中完成真实设置 → 原生配置 → Provider 任务 → 状态回写验收。
- Pi / Codex Provider 可见流程未接入，旧 Provider 入口尚未到可删除时点。
- WP-C 仍需冻结一个不牺牲停止 / 交互 / 恢复能力的官方 ACP 组合；当前记录的 OpenCode v1.15.13
  ACP cancel 缺口只是阻断依据，不是 WP-C 完成。追加核验显示 OpenCode `1.18.30` 官方标签源码已有
  `session.abort` 支撑的 ACP cancel 路径，可进入 no-model 候选检查；Codex ACP `1.11.0` 仍依赖
  `@openai/codex ^0.153.4`，与当前接受的 Codex `0.143.0` 不匹配。

补充执行边界：

- 当前未读取或修改正式凭据，也未消费真实模型额度。真实 Provider QA 需要隔离候选应用、隔离 Host
  数据、明确测试凭据和可消费模型；缺少这些条件时不能用现有正式 / QA 配置代跑。
- WP-C 下一候选不再平均推进三路：OpenCode 固定 v1.15.13 ACP 先排除为首路，Pi ACP 在保留
  steer / follow_up 前不优先；OpenCode `1.18.30` 可作为官方后续版本候选进入 handshake / cancel /
  权限 / 恢复核验；Codex 可继续探测，但必须冻结 adapter / `@openai/codex` / 本机 CLI 组合并证明不丢已接受能力。
- WP-D 当前可独立推进的是安装引用与发现 / 校验入口；删除随包 Pi / OpenCode 资源必须等同一候选应用
  通过外部安装启动、重定位和恢复后进行。本轮新增的 Pi / OpenCode 本机安装入口只做候选发现、手动选择、
  固定版本和 sha256 检查，结果为 `checked_not_active`；它没有改变启动路径，也没有安装、升级或覆盖全局 CLI。

监督复核后追加结果：

- WP-D 已从“候选检查”推进到“系统安装引用登记 + OpenCode 新会话启动接入”的首个切片。候选发现新增
  PATH、用户常见 bin、nvm、Homebrew 与 `/usr/local/bin` 的有限搜索，不全盘扫描；外部候选按 canonical
  path 生成独立 system installation / runtime build / connection，保存实际 sha256，不再套用随包 hash
  或 bundled installation id。随包候选仍可检查，但不能登记为系统安装。
- HostStore 允许 Pi / OpenCode 系统安装记录写入同一 launch 表；Codex 安装列表已过滤为 Codex-only，避免
  新记录破坏 Codex 连接面板。OpenCode 工作台保存系统安装后会把 connection 用于下一次新建会话；Host
  启动前重核验路径、版本和摘要后才交给 OpenCode lifecycle。Pi 外部安装只登记和重核验，非随包 Pi 新会话
  目前明确阻断，因为 Pi sidecar wrapper 仍只启动随包 `pi`。
- WP-C 已固定下载 `opencode-ai@1.18.30` 主包和 `opencode-darwin-arm64@1.18.30` 平台包到隔离临时目录，
  npm metadata 与下载结果的 integrity / shasum 一致。`opencode acp --help` 可运行；隔离 HOME/config/data
  下 newline JSON-RPC `initialize` 成功返回 1.18.30 能力，`session/new` 在空项目成功并返回 configOptions
  与 available_commands_update。对空闲 session 发送 `session/cancel` notification 未报错。该结果仍不是
  真实模型请求停止验收；顶层 `opencode --version` / `--help` 在本环境 137 退出，需要继续作为候选异常排查。
