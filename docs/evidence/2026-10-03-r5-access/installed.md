# R5 与两项共用功能：本机安装验收

用户明确回复“已全部完成，可以更新”后执行。沿同一 checkout 保留全部未提交修改，只替换 `/Applications/Farfold.app`，没有重新登录 Codex、输入密钥、退出账号或发送模型请求。以下为安装版实际结果；全 33 项静态及受控展示证据仍单列。

模型读取修复已安装为 `dbe26170…`，见[最新安装验收](options-read-repair/installed.md)。以下仍是 `72e1539d…` 的前序窗口记录，“当前”均指该窗口，不将后续结果混入。

## 正式版本与直接修复

当前正式程序 SHA-256：`72e1539d77b10d668691e37451f68c0abad04be621eb5dda5d8a561d2486719d`，标识 `ai.farfold.desktop`。2026-10-03 08:51:25 +08:00 安装，4 文件与签名收据完全一致。501 输入打包前后摘要 `3d5d194a20be6c994a72caf03ef44266ea4b4780442f0f6686ebc6f025de4259`；四文件摘要 `6e91d21fac8e6bf7179d5e2bafbf341b52f2750497db124d295be033853cd76d`。严格签名通过，独立只读复核通过。

- `85e11357…` 于 08:00 首次安装；实机发现 Codex 恢复到账号步骤后列表为空、页脚仍可登录。窄修复保留既有/完成摘要与 API/终端子步骤，补回普通协议方式的恢复列表。`89addd72…` 于 08:24 安装，115/115 针对检查通过，见 [首项修复收据](repair-selector/installed/installation.json)。`restored-choice-repair` 是同一 501 输入与同一 `89addd72…` 的后续核验，非额外安装。
- `89addd72…` 实机发现 Pi 唯一终端方式默认高亮，首次点继续只切阶段，没有保存方法 ID，误显示已有设置并开放模型。终端/API Key 两个用例先复现失败，再在用户点击时验证当前目标、当前声明及实时工作，保存方法选择后进入设置步骤；渲染不自动选择或认证。当前 `72e1539d…` 修复并复验，8 个文件 138/138、类型、范围格式、diff、打包通过。源文件 1436/1282 行，无 Rust 生产变更，沿用对应既有 Rust 检查，不重复历史全套。

## 实机结果

| 路径                  | 实际结果               | 证据及边界                                                                                                                                                                              |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex 恢复列表        | 已测成功               | 当前正式版显示 OpenAI API Key、ChatGPT 与实际支持的模型 API 服务；页脚与 ChatGPT 所选一致，没有执行登录。[最终页面](actual-render/codex-check-only-final.png)                           |
| 仅重新检查程序连接    | 已测成功               | 显示程序已连接及连接已重新检查；没有登录成功/授权已确认，模型仍禁用。既有 09:22 真实认证证据保留，本轮没有新增真实认证回执。                                                            |
| Pi 默认方式到设置步骤 | 已测成功               | 不主动重选卡片，首次继续进入终端步骤，出现启动设置终端，模型禁用；没有误进已有设置。[启动前页面](actual-render/pi-preview-final.png)                                                    |
| 已保存确认及返回      | 已测成功               | 终端收起后首次完成进入确认，模型仍禁用；“继续在终端操作”撤回确认，PID 78036/78037 仍在，不取消或结束程序。                                                                              |
| 确认结束、回收、重查  | 已测成功               | 确认后新增终端 PID 78036/78037 均消失，原连接重查完成，才开放模型下一步；摘要为终端设置/设置已检查，没有冒报登录成功。[完成页面](actual-render/pi-finished-final.png)                   |
| 模型下一步            | 已测成功（到达与读取） | 成功进入并读取选项，没有点击模型、推理、保存或测试按钮。[模型页面](actual-render/pi-model-final.png)。显示 `zai-coding-cn/GLM-4…`、Thinking off，与用户 Cohere 意图及精确模型仍未核实。 |

终端启动后只观察白名单按钮，立即收起；不截图/读取终端内容，不读取 AXValue、密钥、Keychain、环境值、auth 文件或 Agent 配置。进程证据只记录 PID、父 PID 与程序名。只结束本轮验收启动、无用户输入的设置终端，不强关已有工作。

当前窗口的内容为空诊断统计：0 `session/prompt`、0 `authenticate`；Pi 模型页读取期间有 2 次 `session/set_config_option`，不能宣称读取无配置调用。对象按当前 Pi 页面及操作时序对应本次新建的模型准备对话：00:56:55.836 UTC `session/new` 后，00:56:57.965/.971 发出两次配置请求；日志没有参数或关联 ID，因此这是结合页面、时序与源码的归因。源码 `AgentSetup.currentInput` 携带既有 `selection.config`，`PreparationController.prepare` 交给 `session_open`，`pump/open.rs` 不先比较当前值而逐项应用已存准备参数。

当前遗留问题是进入模型页会应用已存准备参数，不能按纯读取操作对待。本轮没有主动选择新参数；无内容日志不能确认两次请求的精确 ID/值、是否实际改变模型，或是否改变 Agent 持久设置。仅能确认应用后可见 `zai-coding-cn/GLM-4…`，没有此前非秘密当前模型对照可证明变化；Cohere 当前提供方/精确模型仍未确认，不猜测恢复。已停在探索管理页，不再打开模型页触发旧准备参数，不替用户切模型或按旧目标发请求。此轮没有扩展或重新开发模型功能。

真实认证正回执、重新登录按钮的实际正路径、API 保存/实际交付、非零关闭、取消和回收失败在当前候选没有新实机覆盖；对应受控测试与旧候选真实结果分别保留，不冒称当前全通过。B 其他机制、C 实际能力配置确认、D 用户评分及 E 逐家参数仍未关闭，不恢复 J1–J6。

## 数据与收尾

每次替换前后限定元数据与数据库文件摘要相同；最新安装保留 48 会话、40 Agent、49 设置、62 已忽略记录。验收后会话与已忽略记录逐字段摘要完全相同；Agent 仅 3 行 `updated_at` 因连接检查变化，设置仅 `agentSetup.v1` 准备进度变化，没有增删行。替换完整性与交互后的允许更新分列，未将后者写成字节完全不变。

当前正式应用仍打开在探索管理页，无验收终端，未保存新的模型。已精确移除 `src-tauri/target/release/bundle/macos/Farfold.app`，正式 4 文件再次匹配；没有清空 target、创建应用备份、删除用户历史或 Agent 配置，没有 Git 提交、推送或发布。

收据：[安装](default-choice-repair/installed/installation.json)、[输入对比](default-choice-repair/source-comparison.json)、[候选](default-choice-repair/built-bundle.json)、[确认按钮](default-choice-repair/installed/controls-finish-confirmation.json)、[回收进程](default-choice-repair/installed/processes-after-finish.json)、[完成按钮](default-choice-repair/installed/controls-after-finish.json)、[诊断](default-choice-repair/installed/protocol-metadata-final.json)、[数据对比](default-choice-repair/installed/acceptance-data-comparison.json)、[重复产物清理](default-choice-repair/installed/duplicate-cleanup.json)。10 张非秘密实机图及摘要见 [actual-render](actual-render/manifest.json)，与受控图分开保存。
