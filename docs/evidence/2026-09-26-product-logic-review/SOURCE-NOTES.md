# 全产品逻辑梳理：源码核对

2026-09-26。范围：当前工作区源码与产品契约的只读核对；本文仅支撑产品地图中的相关判断。
本子任务未操作安装版、未运行测试、未读取账号或密钥。以下不作为新增安装版复现证据；旧审查截图也不自动代表当前运行状态。

## 1. 未发送草稿的保留边界

- **当前源码事实：** 文字与附件放在模块内存 Map；新对话的 Agent、资料目录、API 选择和配置也只是模块对象。代码明确生命周期为本次应用运行。[drafts.ts:20](/Users/tw/Desktop/farfold/src/runtime/drafts.ts:20)、[drafts.ts:64](/Users/tw/Desktop/farfold/src/runtime/drafts.ts:64)
- 首条消息只有进入 established 才视为已接纳；确定拒绝时从待发队列取回，错误交回编辑器。[new_conversation.ts:5](/Users/tw/Desktop/farfold/src/runtime/new_conversation.ts:5)
- **产品影响：** 页面往返保留不等于退出后保留。不能把“草稿已保留”的局部行为扩大为可靠的中断续写。
- **未进行实测：** 本次未退出/强退应用，也未测试重启后的草稿、附件或选择恢复。

## 2. 文件意见在组件卸载时丢失

- **当前源码事实：** 尚未加入对话的意见只存在 FileArtifactView 的局部 state；按对话和文件路径设置组件 key，换文件会换组件；关闭右栏会卸载整个 ArtifactPane。[FileArtifactView.tsx:261](/Users/tw/Desktop/farfold/src/components/FileArtifactView.tsx:261)、[ArtifactPane.tsx:200](/Users/tw/Desktop/farfold/src/components/ArtifactPane.tsx:200)、[ThreadView.tsx:659](/Users/tw/Desktop/farfold/src/components/ThreadView.tsx:659)
- 只有点击加入，意见才追加到对应对话的统一草稿，不自动发送。[FileArtifactView.tsx:498](/Users/tw/Desktop/farfold/src/components/FileArtifactView.tsx:498)、[drafts.ts:72](/Users/tw/Desktop/farfold/src/runtime/drafts.ts:72)
- **产品影响：** 同样是未发送的输入，正文草稿与文件意见有不同保存规则；检查另一文件或收起内容栏即可失去意见。
- **未进行实测：** 本子任务未输入意见、切文件或关闭右栏；这是组件生命周期核对。

## 3. 两层 Agent / 分组筛选取交集

- **当前源码事实：** 侧栏 Agent 按钮设置上层 LibraryFilter；对话库另有本地 agent/group 下拉状态。过滤同时应用上层条件与本地条件。[Sidebar.tsx:185](/Users/tw/Desktop/farfold/src/components/Sidebar.tsx:185)、[ConversationLibrary.tsx:64](/Users/tw/Desktop/farfold/src/components/ConversationLibrary.tsx:64)、[ConversationLibrary.tsx:104](/Users/tw/Desktop/farfold/src/components/ConversationLibrary.tsx:104)
- 上层 filter 变化会重置下拉；下拉自身变化不替换上层同维度条件。[ConversationLibrary.tsx:82](/Users/tw/Desktop/farfold/src/components/ConversationLibrary.tsx:82)
- **产品影响：** 侧栏选 Agent A，再在库内选 Agent B，会形成不可同时满足的条件；空列表可能来自筛选冲突，而非没有对话。分组有相同机制。
- **未进行实测：** 本子任务未操作筛选；现场截图和数据样本由主审查另行记录。

## 4. 首条接纳后推理等级仍可显式修改

- **当前源码事实：** 契约要求首次消息接纳后固定 Agent、来源、模型和推理选择。[PRODUCT.md:50](/Users/tw/Desktop/farfold/PRODUCT.md:50)
- 已建立对话仍渲染非模型选项，禁用条件没有 established/resumed；前端 setConfig 仅锁模型。[SessionOptionsMenu.tsx:23](/Users/tw/Desktop/farfold/src/components/SessionOptionsMenu.tsx:23)、[SessionOptionsMenu.tsx:73](/Users/tw/Desktop/farfold/src/components/SessionOptionsMenu.tsx:73)、[sessions.ts:797](/Users/tw/Desktop/farfold/src/runtime/sessions.ts:797)
- 后端锁定后只直接拒绝模型，正常可发送状态仍允许其他选项；推理修改成功会保存新确认值并重新锁定。[model_guard.rs:229](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/model_guard.rs:229)、[pump.rs:644](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/pump.rs:644)
- **产品影响：** 当前实现与“固定推理选择”的契约有明确差异，不能用恢复漂移保护已存在来关闭此项。
- **未进行实测：** 本次未修改任何对话的模型或推理等级，未发送请求验证 Agent 是否接受修改。

## 5. 手动归档可隐藏待回应：仅源码风险

- **当前源码事实：** 对话顶栏归档按钮只检查索引存在和保存状态；命令面板也直连归档。前端与后端元数据操作均没有运行中/待审批的禁止条件。[App.tsx:241](/Users/tw/Desktop/farfold/src/App.tsx:241)、[App.tsx:589](/Users/tw/Desktop/farfold/src/App.tsx:589)、[sessions.ts:947](/Users/tw/Desktop/farfold/src/runtime/sessions.ts:947)、[session_commands.rs:457](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/session_commands.rs:457)
- 归档标记优先把条目排除于普通列表；侧栏待回应/运行数来自默认非归档列表。[sidebar.ts:117](/Users/tw/Desktop/farfold/src/runtime/sidebar.ts:117)、[sidebar.ts:147](/Users/tw/Desktop/farfold/src/runtime/sidebar.ts:147)、[Sidebar.tsx:49](/Users/tw/Desktop/farfold/src/components/Sidebar.tsx:49)
- **产品影响：** 在对应条件下，手动归档可能让仍需处理的工作从活动入口消失；归档没有停止 Agent 的含义。
- **未进行实测：** 本次未制造运行或审批样本，也未归档任何活动对话。不把这条源码路径写成新增安装版复现。

## 6. 普通对话目录与分组是不同对象

- **当前源码事实：** 未选资料文件夹时使用应用数据目录下稳定的 conversations 目录，所有普通对话共用该默认位置；显式文件夹覆盖该选择。[conversation_directory.rs:8](/Users/tw/Desktop/farfold/src-tauri/src/conversation_directory.rs:8)、[EmptyState.tsx:70](/Users/tw/Desktop/farfold/src/components/EmptyState.tsx:70)
- 分组只保存 id/name 和对话到组的关联；删除组只移除组及关联，不修改对话目录。[collections.ts:7](/Users/tw/Desktop/farfold/src/runtime/collections.ts:7)、[collections.ts:138](/Users/tw/Desktop/farfold/src/runtime/collections.ts:138)
- **产品影响：** 分组是整理方式，资料文件夹是工作位置；普通对话并非每条拥有独立文件目录，也不是文件访问隔离承诺。[PRODUCT.md:52](/Users/tw/Desktop/farfold/PRODUCT.md:52)
- **未进行实测：** 未创建文件、验证跨对话文件可见性或修改工作目录。

## 7. 三个查找入口的覆盖范围不同

- **当前源码事实：** 对话库搜索标题、完整目录、Agent 名称与分组名称；命令面板搜索未归档索引的标题、目录末级名称、Agent和操作命令。[ConversationLibrary.tsx:121](/Users/tw/Desktop/farfold/src/components/ConversationLibrary.tsx:121)、[CommandPalette.tsx:94](/Users/tw/Desktop/farfold/src/components/CommandPalette.tsx:94)
- 对话内查找检索当前 DOM 的用户消息、Agent、思考和步骤节点，滚动到第一项；不读取未加载的外部历史正文。[App.tsx:99](/Users/tw/Desktop/farfold/src/App.tsx:99)
- **产品影响：** 全局搜索不是历史全文搜索；当前对话查找也不是对外部完整历史的检索。不同入口出现不同结果不必然是丢数据。
- **未进行实测：** 未用已知正文标记、归档样本或延迟历史检查命中率。

## 8. 内容栏是 Agent 报告快照，不是当前磁盘文件

- **当前源码事实：** 产物从工具事件派生并只存内存；缺少正式 diff 时，可从编辑参数形成明确标识的片段。文件列表按路径取最后一份报告，不读取磁盘当前状态。[artifacts.ts:1](/Users/tw/Desktop/farfold/src/runtime/artifacts.ts:1)、[artifacts.ts:90](/Users/tw/Desktop/farfold/src/runtime/artifacts.ts:90)、[artifact_view.ts:161](/Users/tw/Desktop/farfold/src/runtime/artifact_view.ts:161)
- HTML 预览使用空 sandbox 与限制 CSP，禁脚本、网络及导航；它不是正在运行的网站预览。[artifact_view.ts:146](/Users/tw/Desktop/farfold/src/runtime/artifact_view.ts:146)
- **产品影响：** 可核对 Agent 汇报的结果，但不能据此证明文件现在仍相同、所有修改都被捕获或网页交互可用。界面已有“不代表文件当前状态”的说明。[workspace_strings.ts:62](/Users/tw/Desktop/farfold/src/runtime/workspace_strings.ts:62)
- **未进行实测：** 未在磁盘另改文件、制造未汇报修改或测试网络/脚本行为。

## 9. 历史导入与普通恢复的完成边界不同

- **当前源码事实：** 导入后端在历史事件之后，通过同一通道发带 previewToken 的完成标记；前端除等待命令返回，还等待对应标记，超时不会允许部分正文加入。[session_discovery.rs:108](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/session_discovery.rs:108)、[history_import.ts:51](/Users/tw/Desktop/farfold/src/runtime/history_import.ts:51)、[history_import.ts:74](/Users/tw/Desktop/farfold/src/runtime/history_import.ts:74)、[history_import.ts:112](/Users/tw/Desktop/farfold/src/runtime/history_import.ts:112)
- 普通打开/恢复先缓冲已到的通道事件，等待 session_open 和索引返回后发布新状态、处理当前缓冲并返回；没有等价的渲染端历史完成标记等待。[sessions.ts:392](/Users/tw/Desktop/farfold/src/runtime/sessions.ts:392)、[sessions.ts:462](/Users/tw/Desktop/farfold/src/runtime/sessions.ts:462)、[session_commands.rs:101](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/session_commands.rs:101)
- **产品影响：** 普通恢复的命令成功不能单独证明界面已消费全部历史；存在已显示可操作、历史仍在通道交付的条件风险。导入修复不能自动证明普通恢复拥有相同保障。
- **未进行实测：** 未注入 IPC 延迟、未制造交付失败、未在回放期间发送消息；不据此宣称本次丢历史或发生顺序错误。
