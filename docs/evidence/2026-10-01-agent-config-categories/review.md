# 多选项类别：独立只读审查

2026-10-01 02:50（Asia/Shanghai）。读取已稳定的 [diagnosis.md](diagnosis.md)、当前 model_guard/pump、会话选择与前端展示、现有配置保护测试和本地 schema 1.9.1；未修改生产或测试，未运行 runner、Agent 或正式应用，未读取用户配置或协议正文。设计稿 SHA-256：`b0875af21b10d7915adfd80312e79811be1d6665fadb0e5792f1fd45f59200f9`。

结论：诊断中的通用机制缺陷成立，按 ID 保存完整受保护选择集合是合适的最小方向。Dirac 本次读取失败是否恰由此触发仍未知，不以静态源码关闭真实失败。实施前应固定下面三处边界。

## 1. 类别重复合法；原 ID 被新 ID 替换也必须能查出

官方 [Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options#option-categories)明确把 category 作为界面提示，允许多个选项共享类别，并用数组顺序决定突出显示位置；设置值使用唯一 configId。当前 [choice()](../../../src-tauri/src/acp_client/model_guard.rs#L53)拒绝同类别第二项，不符合这个语义。主模型或思考工具栏选择第一项可以是显示策略，不能用它代表保护集合。

还有一条独立、必要的安全反例：[check()](../../../src-tauri/src/acp_client/model_guard.rs#L155)现在只比较 expected/current 的 value，没有比较 Choice.id。例如旧 `{id:"old-model", value:"m"}` 被 `{id:"new-model", value:"m"}` 替换，旧逻辑可能认为一致。迁移若按类别取第一项仍会延续这个问题。

建议比较集合时只按准确 ID 对齐，比较支持的类型和标量值。类别是保护范围的初始提示，随后不得因类别省略或改名而把已记录 ID 从保护集合中移除；数组重新排序不能改变准入。重复 ID 与重复类别分开处理，重复 ID 即便在不同类别或未知项中也不能制造执行歧义。未知类型的历史受保护 ID 无法核对时应保留不可确认结果，不把无法解析当成缺省值。

该片不需要把任意未知类别、未知对象值或完整选项菜单都写入元数据；仍只保存既有产品需要固定的公开模型与推理选择。`model_config` 是官方单独类别，不能凭名称把它当作模型 ID。若此片没有扩展该类别的保护，应明确范围，不声称所有模型相关参数已经锁定。

## 2. 旧数据只能证明原本保存的选择；确认不能掩盖已知漂移

可在现有会话 `config_options` 中版本化单一集合，保持 `_farfoldService` 原来源；不新增表或另一份恢复基线。新版本不能自动写回所有旧会话，打开历史也不应把当前返回值覆盖旧值。以下兼容行为应在编码前确定：

| 已有记录                         | 可相信的部分                                        | 必须保留的未知或失败                                                                 |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `_farfoldConfig:1` 的有效 Choice | Choice 自身的 ID/字符串值；不是该类别的任意 ID      | 新模型 ID、已知项缺失/值变/类型无法核对继续阻止发送；不能凭相同值换 ID               |
| v1 中明确为 null 的推理项        | 旧版本没有存下推理选择                              | 后来出现的推理项不自动视为已记录；若允许沿既有出口补存，须显示完整新增集合并显式确认 |
| 旧 flat map                      | 只对能够按实际 ID 逐字对齐的公开值建立期望          | 不能把 `model` 或类别键广播给多个 ID；无法唯一确定的映射保持未知                     |
| 新版完整集合                     | 已记录所有 ID、类型和值；空集合可表示当时没有可选项 | 新增的受保护 ID仍须判为未记录；新模型项不得由推理确认一起放行                        |
| 未知格式标记、损坏集合或重复 ID  | 不能确认有效基线                                    | 不得回落成 flat map 或采用当前返回值；保留旧数据和明确失败                           |

显式确认仅能补已允许的未知推理范围，所有已经记录的选择必须先逐 ID 一致；任一已知模型或推理漂移、缺失、类型变化都不能通过确认当前集合绕过。确认令牌应覆盖完整公开集合，排序变化可归一化，确认期间到达的新值使令牌失效。写失败保留原期望、当前值及待确认状态，重试不能把失败变成自动接纳。

## 3. 保护集合改变时要核对全部消费者

- [pump 的恢复参数过滤](../../../src-tauri/src/acp_client/pump.rs#L1141)目前只捕获单个思考项。恢复时用户传来的第二个受保护 ID、旧记录里保留但当前类别消失的 ID也不能发送设置请求；禁止更改必须发生在发送任何 set 请求之前。通知、设置回复与首次真实准入都沿同一集合更新及固定。
- [sessions.setConfig](../../../src/runtime/sessions.ts#L1204)只通过 `modelConfigOption()`锁主模型，推理则已检查全部当前项。[SessionOptionsList](../../../src/components/SessionOptionsMenu.tsx#L103)在主模型外仍显示其他模型类别项；后台虽另有 models 锁，但界面会给出可点的次模型设置。前后端均应覆盖所有受保护 ID，并保留草稿可选择、已有/恢复只读的原边界。主位 first 只用于位置，不能用于修改准入。
- [Prompt 的 API 检查](../../../src-tauri/src/acp_client/pump.rs#L792)仍读取 `/model/value`，而 [service_config::validate_selected_model](../../../src-tauri/src/acp_client/service_config.rs#L74)明确要求唯一实际模型选项。新集合格式要保留该既有消费者，或同时改为经过官方服务配置核验的具体模型 ID；不能让目录中的任意同类别项、菜单内存在 expected、或多个项中任一值相等就证明使用了所选服务模型。本片可以保持当前未核实的多模型 API 路线不可用，不降低来源保护。

## 最低有意义反例

这些是尚未添加或运行的测试建议，不是通过记录：

1. 实际 SDK 自有对端返回两个不同 `thought_level` ID，以及两个不同 `model` ID；新草稿 ready，全部当前值保留，无自动 prompt/set_config。
2. 准入保存完整集合，冷恢复换序通过；仅第二项改变或消失阻止发送；原 ID 换成新 ID 同值也阻止；原 ID 改类别或省略类别但值不变仍被保护。
3. v1、旧 flat map 与未知新版标记分别覆盖；旧值只按准确 ID迁移；新增模型保持 blocked，允许补存的新增推理必须完整确认，已知项漂移仍不可确认。
4. 同 ID 不同类别、未知类型历史项、损坏集合不 silently skip；正常未知非受保护类别不导致整个新草稿失败。
5. 恢复请求试图修改第二个推理/模型 ID，在对端收据中没有任何 set_config；前端次模型项只读，完整多项问题能逐项辨认。
6. API 原单模型成功与错误模型仍失败；不能用第二同类项或菜单内容证明来源。格式变化不会令原 API 正常路径因缺 `/model/value` 全部失败。
7. 确认写失败、保存期间到达第二项更新、重复确认和待发队列仍沿现有保护：不替换原基线、不自动发送；草稿设置返回依赖变化时保留调用方逐 ID核验。

现有 [config_guard_tests.rs](../../../src-tauri/src/acp_client/config_guard_tests.rs)已覆盖单模型/单推理的真实子进程、存储失败与旧推理确认；该证据不能代替以上多 ID边界。正式复验应只明确重新读取 Dirac 原程序返回，不改其模型或推理；仍失败就保留未知原因。前述建议不要求改外部 Agent、配置或凭据。

## 首版实现复核记录

03:27 读取作者已稳定的首版 model_guard、format、pump 与 11 项回归；前端尚未稳定。完整集合、准确版本标记、protectedIds 和 API 单模型消费者的改动方向符合上述设计，未新增存储或请求路径。本段不是最终实现通过结论。

当时确认并已交给作者修正两项：

- 首版 observe 只收当前已识别类别，check 又比较包含 category 的整个 Choice。旧 ID/type/value 不变但 category 省略、变成 `_custom` 或换类别时，会误认为缺失/变化。应按已记录 ID补收实际类型和值、沿旧角色保护；同值允许恢复但仍不可修改，类型/值变和重复 ID继续阻止。作者已接受，正在补独立红绿。
- 旧 flat map 的候选 ID只来自当前已识别集合及三个传统 ID。`{model:"m",thinking_budget:"0"}` 对应当前 `thinking_budget/category:_custom/currentValue:"1024"` 时，第二个旧值会被彻底忽略，进而 ready 且可修改。旧记录无法证明其原类别，不应借这个未知解除保护；当前明确为 mode 等普通非保护项仍可识别处理，避免把全部旧选项都冻结。作者收到该具体反例，尚待确认修复与证据。

评审人未运行上述反例；它们是首版源码可到达的逻辑路径。最终复核与关闭依据见下文，不以首版测试通过替代修复结论。

## 最终后端复核

2026-10-01 03:46（Asia/Shanghai）。逐个核对 [backend-files.json](backend-files.json) 的六文件 SHA-256 与当前文件，全部一致；范围为 `model_guard.rs`、`model_guard/format.rs`、`pump.rs`、`mod.rs`、`category_guard_tests.rs`、`config_guard_tests.rs`。未修改源码或测试，未运行 runner、真实 Agent 或正式应用。

结论：这六个冻结文件未发现剩余阻断。首版两项问题均已关闭：

- 已记录 ID 先沿原角色读取当前实际 type/value，准入按准确 ID/type/value 比较；category 省略、换为 `_custom` 或另一类别本身不造成漂移，也不能解除原 ID 的只读保护。实际值变、类型变、缺失或重复 ID 仍阻止。对应 [category-metadata-red.log](category-metadata-red.log) 保留 1 项真实失败；最终 [categories-stable.log](categories-stable.log) 包含修正后的回归。
- 旧 flat map 无法归类的既有 ID 保留为无效基线并加入 `protectedIds`，不猜原角色、不回显未知旧值，也不能确认放行。明确的普通 mode 和既有 `_farfoldService` 元数据不扩大保护。对应 [legacy-unclassified-red.log](legacy-unclassified-red.log) 保留 1 项真实失败；最终同组回归已通过。

完整集合在既有 `config_options` 中以 `_farfoldConfig:2` 保存，不新增账本。v1 只按 Choice 自身 ID 迁移，旧 flat map 不广播类别值；未知标记、损坏集合和重复 ID 不回落到当前值。`protectedIds` 包含当前声明、已记录 ID 与无法分类的旧 ID，恢复参数在发送任何设置请求前检查该集合。已知漂移、新增模型、无效基线不能借新增推理确认放行；确认展示值与完整当前集合必须相等，迟到更新会使原确认失效。API 消费者继续要求唯一实际模型，多个 model 项或仅菜单内存在所选值都不证明服务来源；`model_config` 不在本片新增保护范围。

只读核对作者的 [stable-checks.json](stable-checks.json)：类别 12 项、旧 model guard 5 项、SDK/SQLite 配置保护 1 项、模式 9 项、API 6 项、实际 cwd 6 项均退出 0，并与对应日志结果一致。自有 SDK 对端/SQLite 回归覆盖完整选择持久化、换序冷恢复、第二项漂移阻止 prompt/确认，以及类别改变后的旧 ID 在 wire 前拒绝设置；这是受控证据，不是 Dirac 或其他真实 Agent 成功证明。早期 `process_cwd` 过滤器命中 0 项的日志不计为 cwd 覆盖，最终使用准确的 `acp_client::process::cwd_tests` 过滤器。根任务 [checks-rust-final.json](checks-rust-final.json) 另记录 fmt/clippy/test 退出 0；评审人仅核收据，未重复运行。

## 最终前端复核

03:46–03:49 读取作者已稳定的前端生产差异与相应回归：`protected_config`、`sessions.setConfig`、配置检查/元数据显示、接入页、会话选项/推理控制、确认卡、历史与发送区提示及样式。逐个复核 [frontend-checks.json](frontend-checks.json) 的 15 生产文件和 8 测试文件 SHA-256，23 项全部一致。未发现剩余阻断。

共有判断按准确 ID 合并当前受保护声明与后端 `protectedIds`。已有或恢复对话的第二模型、第二推理、当前类别消失/变化或当前清单缺失的旧 ID 都不能发设置请求；菜单回调在运行时重新检查身份。新草稿仍可逐 ID 选择，其他选项及本片未扩展的 `model_config` 保持原范围。菜单只把首项放在主控制位置，其余同类项可达；接入页既有对话展示完整公开集合，不把它变成可编辑新草稿。

确认卡直接展示 `configCheck.current` 中完整公开字符串选择，按准确 ID 找显示名称；不拿实时菜单值替换已展示快照，不显示额外任意 payload。确认仍原样提交 opaque `current`，不重新拼装、发送设置或 prompt，也不自动恢复待发队列。v1 旧确认卡仍可只读展示；新 v2 模型显示按准确 ID 取唯一支持的 Choice，不把一个类别值复制给多个 ID。

已读 [frontend-final-green.log](frontend-final-green.log) 的 14 文件 196 项通过与 [frontend-typecheck-final.log](frontend-typecheck-final.log) 的类型检查结果，作者收据均记录退出 0。对应测试包括次项可达、已有/恢复的全部 ID 只读、类别变化保留保护、过时回调拒绝、完整确认原样传递且不自动发送，以及 v1 只读显示。前端受控通过不关闭 Dirac 现场失败；真实安装、读取、首发与续接仍由本片后续安装证据分别判定。
