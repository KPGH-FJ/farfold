# Farfold 全项目评估

2026-09-24｜当前源码、安装版与功能体验

**结论：统一工作台的技术主体已经成立，设置管理比日常任务体验更成熟。整体属于可实际使用的工程候选，尚未达到稳定、顺畅的日用产品水平。** 最突出的差距集中在任务切换、恢复续接和结果检查；功能入口多，不代表每条链已经完成。

这是本次审查快照，不是新的活动计划。未修改生产源码、测试源码、凭据或模型选择；未发送新的模型任务、删除用户会话或重新安装应用。安装操作包括浏览设置、打开已有会话、输入不发送的测试草稿，以及选择 Agent 预开草稿。

## 技术架构

```text
React 19 / TypeScript / CSS：统一工作台、设置、会话与审批
                 ⇅ Tauri invoke / 每会话事件 Channel
Tauri 2 / Rust：接入安装、认证、连接与进程、会话协调、元数据
                 ⇅ 官方 agent-client-protocol SDK / 进程标准输入输出
OpenCode / Codex / Pi：模型调用、工具执行、权限、完整历史
```

| 层         | 实际责任                                                                     | 评价                                                             |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 前端       | App 装配；会话状态、队列、事件归一化；统一聊天、审批、产物和设置             | 统一界面成立；输入等局部状态与会话状态衔接不足                   |
| 桌面后端   | Agent 发现/安装/登录；按 Agent、项目、服务修订隔离连接；生命周期和恢复校验   | 责任划分清楚，异步边界与外部能力差异是主要复杂性                 |
| 外部 Agent | 自己的执行循环、模型、工具、历史和配置                                       | Farfold 没有另建 Agent 循环；实际可靠性受官方接入能力影响        |
| 数据       | SQLite 四表：agents、sessions、settings、dismissed_sessions；秘密在 Keychain | 不存完整对话/事件账本；重启后的正文和产物依赖 Agent 回放         |
| 支持能力   | 诊断白名单、进程回收、更新框架、LifeModel 空接口                             | 诊断/回收有实现与局部证据；更新发布与 LifeModel 仍未形成使用闭环 |

源码入口：[App](/Users/tw/Desktop/farfold/src/App.tsx:1)、[桌面命令](/Users/tw/Desktop/farfold/src-tauri/src/lib.rs:95)、[连接管理](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/manager.rs:95)、[事件分发](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/pump.rs:367)、[元数据](/Users/tw/Desktop/farfold/src-tauri/src/meta_store.rs:84)。

## 全部功能点与链路

评级表示本次判断，不是官方发布等级：**较完整**＝实现和相关实际样本较齐；**基础可用**＝主线存在但使用细节或覆盖有限；**关键缺口**＝核心路径有确定失败/未完成能力；**预留**＝当前不提供实际能力。未验证不会被直接判作缺陷。

| #   | 功能点 / 链                                    | 当前水平与边界                                                                                                                            |
| --- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 开始页 ↔ 会话 ↔ 设置                           | **基础可用**。页面与返回通路齐；设置往返保留输入，会话切换不保留未发草稿                                                                  |
| 2   | 选项目 → 选 Agent → 取模型 → 首发              | **基础可用**。自动预开草稿；本轮未发送即出现英文时间戳空会话，和“发消息即创建”说明冲突                                                    |
| 3   | 发现本机 Agent → 目录/筛选 → 连接              | **基础可用**。三品牌常驻、自定义接入、缓存及本机扫描存在；干净用户未完整验证；连接不等于模型请求可用                                      |
| 4   | 安装/更新 Agent → 检查 → 选用                  | **较完整的实现**。进度、取消、重试、失败保留旧目标；全部真实异常分支仍未覆盖                                                              |
| 5   | 多份程序 → 版本/路径 → 切换/卸载               | **较完整的实现**。区分程序/接入组件、管理安装/外部安装；连接与在用状态有保护                                                              |
| 6   | 断开 → 移除接入 / 高级自定义接入               | **基础可用**。统一管理及明确保留边界；高级命令配置面向技术用户                                                                            |
| 7   | 条件登录 → 浏览器/内嵌终端 → 重连使用          | **基础可用，覆盖不足**。沿用现有登录有证据；未登录用户的完整认证旅程未验                                                                  |
| 8   | API 服务 → 地址/格式/Key/多模型 → 保存编辑删除 | **较完整**。独立表单、密钥引用、变更影响提醒；本轮看见 GLM/Atria 两条已保存记录                                                           |
| 9   | 读取模型 → 单模型 API 测试 → 取消/结果         | **较完整的诊断功能**。保存前可测、迟到结果失效、固定短请求；不等于 Agent 任务成功                                                         |
| 10  | 选 API 来源/模型 → Agent 实际使用              | **部分接通**。OpenCode：Chat Completions/Responses；Codex：Responses；Pi：沿用已有配置。当前可见对应来源的回复历史，完整跨 Agent 共用未证 |
| 11  | 模型/推理/模式 → 选择 → 首发固定               | **基础可用**。能力驱动与锁定存在；通用菜单仍直接显示 Session Mode/build 等术语                                                            |
| 12  | 输入文本 → 发送/换行/中文组词                  | **关键体验缺口**。基本输入可用；本轮确认 A→B→A 会丢失未发送文字；附件同属组件局部状态                                                     |
| 13  | @文件 / +附件 / 图片粘贴 → 交给 Agent          | **基础可用**。按声明能力处理；文件列表缓存不自动刷新，图片真实理解与中文组词未完整验证                                                    |
| 14  | /命令 / Skills / MCP 能力                      | **按 Agent 能力接入**。命令补全存在，Skills/MCP 执行归 Agent；没有统一安装/管理这些能力的页面                                             |
| 15  | 流式正文 → Markdown/思考/计划/工具步骤         | **基础可用**。步骤、代码复制、展开和未知耗时处理存在；文件链接无打开动作，部分工具内容仅文本展示                                          |
| 16  | 运行中发送 → 排队 → 暂停/手动继续              | **实现较认真，验证有限**。接纳后才移除，失败/未知不自动重发；无队列编辑排序，重启不保留待发队列                                           |
| 17  | 停止 → 等待确认 → 停止/未知/重试               | **基础可用，外部差异明显**。有超时与未知状态出口及历史成功样本；不能推广为所有 Agent/模型稳定                                             |
| 18  | 多 Agent 并行 → 切换 → 在跑/需要你             | **基础可用**。事件与运行状态分离，有局部并行证据；草稿丢失削弱核心多任务价值                                                              |
| 19  | 审批 → 批准/记住/拒绝 → 回执/撤销              | **实现较完整**。请求独立归属、重复提交保护、记住批准的撤销窗口；当前真实并发审批未完整验                                                  |
| 20  | Agent 表单 → 填写/校验 → 提交/取消             | **基础可用**。常用字段与独立草稿存在；有限 schema 支持，本轮未现场触发真实表单                                                            |
| 21  | 工具结果 → 产物 → diff/命令输出/日志           | **关键体验缺口**。本轮六项产物压扁卡片、部分正文不可见；diff 是旧全文删除+新全文新增，合计200行截断无展开                                 |
| 22  | 会话 → 项目分组/置顶/改名/归档/删除            | **基础可用**。管理动作齐；项目主要是目录分组；源码确认删除当前会话后停留“载入中”，失败缺反馈                                              |
| 23  | 搜索会话/项目/Agent → 键盘切换                 | **基础可用**。命令面板可用；搜索不含正文和已归档索引，普通侧栏键盘语义不足                                                                |
| 24  | 重启/重连 → 历史 → 校验 → 续发                 | **关键缺口**。本轮 Codex 已有会话 high→ultra 后阻止续发；保护有效，但继续原工作失败。其他组合有历史成功/失败样本                          |
| 25  | 项目工作开关 → 限制新建/续发                   | **实现较完整**。双端准入、现有任务与审批保留、待发手动继续；本轮仅审源码/入口                                                             |
| 26  | 主题/自动归档/状态栏                           | **基础可用**。主题元数据保存；自动归档依赖已加载且已观测结束的会话；无当前会话也显示“事件流正常”                                          |
| 27  | 诊断导出 / 退出 / 空闲回收                     | **工程实现较完整**。白名单导出及进程归属保护，有历史安装证据；本轮未重跑导出与退出场景                                                    |
| 28  | 应用更新                                       | **框架已实现，发布链未接通**。本轮界面明确“没有配置发布通道”；不能实际完成线上更新                                                        |
| 29  | LifeModel 采集 → 提案 → 批准 → 注入            | **预留**。静态页面和空接口，当前没有此使用链；符合阶段范围                                                                                |

## 最影响交付满意度的具体问题

### 1. 切换任务会丢草稿｜当前安装版复现

在已有 OpenCode 会话输入 `FARFOLD-REVIEW-DRAFT-UNSENT`，未发送；切换到另一已有会话再回来，输入框为空。只是切换侧栏筛选不会丢，切换会话会丢。源码将文字/附件保存在 Composer 本地状态，切换会话按 key 重挂载。

[输入前后源码](/Users/tw/Desktop/farfold/src/components/Composer.tsx:77) · [重挂载入口](/Users/tw/Desktop/farfold/src/App.tsx:75)

| 切换前                                                                                               | 切回后                                                                                              |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| ![切换前草稿](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/14-draft-before.png) | ![切回后为空](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/16-draft-after.png) |

### 2. 续接保护生效，但旧工作仍无法继续｜当前安装版复现

打开已有 Codex“Farfold reliability check”会话，历史可回放，但界面明确 high→ultra，输入被禁用，只提供新会话出口。原问题仍在。提示在顶部和输入区重复出现，底栏同时显示绿色“事件流正常”，不同层级状态需要用户自行理解。

![恢复后阻止续发](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/17-restored-codex.png)

### 3. 产物窗格尚不能可靠承担结果检查｜当前安装版复现＋源码限制

已有 OpenCode 会话的六项产物在右栏同时显示时，部分卡片被压扁，`proof.txt` 单行新增正文也被裁掉；滚动后未恢复。正文存在于可访问性树，并非 Agent 未提供。CSS 的纵向 flex 子卡片默认收缩且 overflow:hidden，与现象吻合；未做临时样式对照实验。此外，文件链接不可打开、diff 不是实际逐行差异、200行之后没有展开入口，均为源码确认。

[卡片布局](/Users/tw/Desktop/farfold/src/styles-artifact.css:66) · [diff 截断](/Users/tw/Desktop/farfold/src/components/ArtifactPane.tsx:25) · [文件链接](/Users/tw/Desktop/farfold/src/components/MessageContent.tsx:21)

![多产物内容裁切](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/21-diff-and-output.png)

### 4. 创建与管理动作仍有未收尾的路径

本轮仅选择 OpenCode、尚未输入发送，侧栏已出现 `New session - 时间戳`，与主区“发消息即创建新会话”冲突。当前本机另有同名 OpenCode、自定义验收接入及大量测试会话，主路径缺少足够区分；这反映本机配置与界面呈现共同造成的负担，不能推断为干净安装自带这些数据。

源码另确认：删除当前会话先清内存但不导航，主区会停在“载入中”，直至用户主动切换页面；关闭/删除失败被吞掉。本轮没有删除真实数据复现。[删除实现](/Users/tw/Desktop/farfold/src/runtime/sessions.ts:1035) · [无会话时界面](/Users/tw/Desktop/farfold/src/App.tsx:74)

![未发送即出现空会话](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/23-new-task-ready.png)

### 5. 视觉语言基本统一，交互和状态表达仍不均衡

纸白、紫色操作强调、边框和间距已有一致性。Agent/API 设置页明显比旧工作台细致；开始页与会话仍使用字母块身份，设置页使用真实品牌，原生 select 与定制控件混用。多个位置有小号浅灰说明，阅读负担较高。侧栏主要操作缺完整 button/键盘语义；不能凭快捷键和截图认定可访问性完成。

![较完整的 API 配置页](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/06-api-list.png)

## UI/UX 分区评价

| 部分                | 水平               | 主要判断                                                                           |
| ------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| 开始页与新任务      | 基础               | 留白清楚；同名接入难辨、创建语义冲突、模型来源控件精致度不足                       |
| 侧栏与项目          | 基础               | 项目分组、待处理和状态可见；长标题截断、同名 project 难区分、测试内容挤占主路径    |
| 搜索与快捷操作      | 基础               | Cmd+K 与键盘选择易用；搜索边界窄，普通导航的键盘支持未齐                           |
| 模型与来源菜单      | 偏粗糙             | 一个菜单混合当前选项、新建和切换会话；Session Mode/build 等原文暴露                |
| 输入与多任务        | 不达日用预期       | 草稿丢失是直接损失；附件、队列、命令入口已具备基础                                 |
| 对话与工具流        | 基础               | 正文阅读清楚；冗长路径、重复信息与较弱的结果定位拖累长任务阅读                     |
| 恢复/异常/状态栏    | 保护充分、解释不足 | 原因有提示；缺能继续原工作的出口，重复提示和“正常”状态容易分散注意                 |
| 审批与表单          | 待现场补验         | 源码具备归属与状态保护；本轮未实际触发，不能给视觉完成度结论                       |
| 产物                | 未达核心用途       | 六项产物已出现正文裁切，差异与文件导航也有限                                       |
| Agent 目录/程序管理 | 较完整             | 真实品牌、状态筛选、展开与保护说明齐；详情/登录层级较深，技术说明偏多              |
| API 列表/表单       | 当前较成熟         | 保存/测试分开、表单滚动与固定操作栏可用；仍要求理解接口格式/模型ID，列表暴露 other |
| 通用/更新           | 基础               | 项目少而清楚；更新入口有明确不可用原因，缺实际发布通道                             |
| LifeModel           | 占位清楚但术语重   | 明示即将推出；Proposal/Canonical 等概念仍像研发说明，不计实际功能交付              |

## 本轮界面步骤与证据索引

以下截图全部来自本次安装版浏览，窗口约1199×768；没有把原型或旧截图当现状。关联步骤合并描述，但保留每张原图。

| 步骤 | 所见与健康状态                                                         | 图                                                                                             |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | 开始页：基础，重复名称/验收条目并列                                    | [01](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/01-start.png)           |
| 2    | Agent 目录：较完整                                                     | [02](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/02-agents.png)          |
| 3    | 程序管理展开：保护清楚                                                 | [03](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/03-programs.png)        |
| 4    | Agent 详情：功能齐、层级较深                                           | [04](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/04-agent-detail.png)    |
| 5    | 登录选项：条件说明存在，英文命令原文可见；未执行登录                   | [05](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/05-auth-options.png)    |
| 6    | API 列表：保存记录/兼容范围可见                                        | [06](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/06-api-list.png)        |
| 7    | 添加API表单：字段齐全                                                  | [07](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/07-api-form.png)        |
| 8    | 表单滚动/Escape返回：可用，未保存                                      | [08](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/08-api-form-bottom.png) |
| 9    | LifeModel：明确占位                                                    | [09](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/09-lifemodel.png)       |
| 10   | 通用：基础可用，未改设置                                               | [10](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/10-general.png)         |
| 11   | 更新：真实无发布通道，反馈明确                                         | [11](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/11-update.png)          |
| 12   | 打开OpenCode会话的过渡状态：先见连接未知，随后自行恢复；不判为持久故障 | [12](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/12-thread-error.png)    |
| 13   | 会话选项：功能混合、技术词可见                                         | [13](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/13-session-options.png) |
| 14   | 输入不发送的草稿：文字存在                                             | [14](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/14-draft-before.png)    |
| 15   | 侧栏筛选返回最近：草稿仍在                                             | [15](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/15-sidebar.png)         |
| 16   | 切到另一会话再返回：草稿丢失                                           | [16](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/16-draft-after.png)     |
| 17   | Codex历史恢复：推理漂移，阻止发送                                      | [17](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/17-restored-codex.png)  |
| 18   | 单项命令产物：入口和输出可见                                           | [18](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/18-artifacts.png)       |
| 19   | 搜索并打开既有会话：可用                                               | [19](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/19-search.png)          |
| 20   | OpenCode工具历史：能回放，长路径阅读负担大                             | [20](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/20-tool-history.png)    |
| 21   | 多项产物：内容裁切                                                     | [21](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/21-diff-and-output.png) |
| 22   | 产物下滚：未恢复被裁正文                                               | [22](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/22-artifact-scroll.png) |
| 23   | 选择OpenCode预开草稿：未发消息即出现空会话                             | [23](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/23-new-task-ready.png)  |

## 验证范围与反例核对

- 当前应用：`/Applications/Farfold.app` 0.1.7，`ai.farfold.desktop`；摘要 `1706cc4fa486f563327fd06201dc785acc7c42412e48e1e514b2d8748ca07675`，严格签名校验通过。
- `eefa4df` 加现有工作区；候选3记录的134项源码/依赖快照全部匹配。其中包含21个独立测试源码路径，不称134个纯生产文件；不是完整可复现构建证明。[本轮身份复核](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/review-identity.json)
- 本轮前端110通过；Rust167通过、3默认忽略。忽略项是两个真实Agent检查和一个Keychain检查。[前端日志](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/frontend-tests.txt) · [Rust日志](/Users/tw/Desktop/farfold/docs/evidence/2026-09-24-project-review/cargo-tests.txt)
- 本轮没有新增真实模型请求、未登录认证、安装卸载、并发审批/表单、重启/退出、深色模式、窄窗口、屏幕阅读器或性能采样验证；对应结论保留来源与覆盖限制。
- 历史证据：OpenCode/Atria直接探测有文字/工具/冷恢复通过，Codex/Atria冷恢复续发失败；当前候选的OpenCode/Big Pickle曾协议失败；Pi曾丢失错误而报告结束。它们不全是同一根因，也不等于本轮重新执行。[服务证据](/Users/tw/Desktop/farfold/docs/evidence/2026-09-23-service-validation/README.md:23) · [可靠性证据](/Users/tw/Desktop/farfold/docs/evidence/2026-09-23-reliability/README.md:36)
- 当前UI已经存在Atria保存记录与对应会话历史，旧文档“尚未保存”不能继续作为当前结论；完整跨Agent共用和冷恢复仍未由本轮证明。
- 反例核对撤回了一项潜在误判：停止时返回取消审批是官方协议义务，不能直接报作功能缺陷；任务停止仍等待结束回应。当前架构文档“不提前失效”的描述不准确。本轮没有更改文档。

**建议优先处理已经实际复现的草稿丢失、产物裁切和恢复续接三条链，再以真实任务结果衡量整体交付质量。**
