# Cline 提供方被显示为模型：当前安装包与宿主源码核对

2026-10-05，只读；未运行 Cline、发送消息、操作 GUI 或读取用户配置、凭据、环境值、日志、真实对话。仓库未修改。

**结论：已定位 Farfold 共用模型投影缺陷。Cline 同时暴露提供方和真实模型，Farfold 错取了排在前面的提供方选项。不能称 Cline 没有返回模型，也不能把“Cline Usage-Billing”当作具体模型。**

## 官方安装包的实际声明

登记入口由根任务安全核实：`…/agents/registry:cline/install-so8oyQ/node_modules/cline/bin/cline`。其公开 `package.json` 为 `cline@3.0.65`；Node 包装器使用平台包二进制。只读平台包 `@cline/cli-darwin-arm64/bin/cline` 的内嵌公开 JavaScript，未执行程序、未计算或要求二进制摘要。精确文件路径与字节偏移摘录仅保留在本地 `cline-installed-public-config-excerpts.json`，不随本次上传。

| 返回字段                                           | 实际含义           | 官方公开实现                                                                                     |
| -------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `id:"provider", name:"Provider", category:"model"` | 认证/服务提供方    | `FJ`；描述为 `The authentication provider to use`，选项来自支持的 provider 名称                  |
| `id:"model", name:"Model", category:"model"`       | 真实模型           | `HJ`；当前值来自 `currentModelId`，列表来自当前提供方模型集合                                    |
| `configOptions`                                    | 提供方排在模型前面 | `newSession` 返回 `[FJ(provider), HJ(model,…), mode, autoApprove,…]`；`loadSession` 使用同样顺序 |
| 顶层 `models`                                      | 另一份明确模型信息 | `newSession/loadSession` 都返回 `availableModels` 和 `currentModelId`                            |

`session/set_config_option` 也明确区分 `provider` 和 `model`：选择提供方会更新 provider 并可能重新确定模型；选择 model 更新 `currentModelId`。因此 UI 中把这三个提供方放到“使用这个模型”下有实际误操作风险，不能当纯文案差异。

## Farfold 的错误位置与边界

- `src/runtime/session_projection.ts:354` 按收到的数组顺序保留 configOptions 的 id/name/category/currentValue。
- `src/runtime/session_projection.ts:372` 的 `modelConfigOption` 直接 `.find(category === "model")`。Cline 的 provider 在前，因而成为错误的主模型控件。
- `src/components/EmptyState.tsx:458` 及 `src/components/ThreadView.tsx:518` 共用该投影；`src/components/NewConversationPickers.tsx:264` 直接将选中的 option 列表显示到模型选择框。这完整解释根任务的实际 AX 收据中三个提供方条目。
- `src/components/SessionOptionsMenu.tsx:81` 只排除被主模型控件占用的 id，其他选项仍保留，因此真实 `id:model` 理应仍在通用配置列表里；是否在当前安装界面可见需另行只读核实，不能据源码冒称已经看到真实当前模型。
- `src/components/EmptyState.tsx:372` 按真实 config id 校验和恢复已保存选择，缺失/不支持则报错；`:479` 才同步实际 draft config。provider 标签错误本身不证明实际 `model` 已改成其他值。
- `src/runtime/protected_config.ts:25` 与 `src-tauri/src/acp_client/model_guard.rs:159` 会保护和比较全部 `category:model` 选项；这层仍应保留，不能为了改显示删除 provider 原始分类或放宽恢复保护。`modelValueOf` 等沿主模型投影取值的调用应纳入最小修复复核，不能只修一个标题。

## 最少安全下一步

1. Cline 暂不加入本次付费消息提案。准确记录“本次连接/无消息预开成功，主模型入口误显提供方，当前实际模型尚未由当次回执核对”，不写成整体不可用。
2. 根任务如能在自有无消息草稿的通用配置界面仅展开查看 `Model`，可核对真实当前值，不选择任何项、不确认模型、不改变提供方；否则等待最小修复后重新读取。已有保存值 `stealth/space-bunny-alpha` 只证明保存意图，不单独证明此次实际会话值。
3. 最小修复应在共用 `modelConfigOption` 选择逻辑中处理**多个 model 分类项**：有明确的真实 model id 时不能被前置 provider 抢占；保持单一分类、无分类旧声明及未知歧义场景的原有兼容/保护，不写 Cline 专属 UI 分支，不改上游数据。补一条 provider/model 同分类且 provider 在前的回归，并核主控件、其他设置、记录/恢复取值相关调用。具体算法与写代码不属本只读子任务。
4. 当前联合收费提案继续仅 OpenCode/Pi 各一条原配置短回复。Cline 修复并从当次官方返回核实模型后，再决定是否提出独立消息预算；不能借一次请求探猜模型或提供方。

额外限制：此报告证明安装包所含官方协议实现与宿主误选机制。根任务已经提供当前安装 UI 的对应结果；本子任务没有抓取实时 IPC，因此不宣称拿到了 Cline 此次完整 `configOptions` 原始回执。

## 根任务拟议最小算法评审

优先 model 分类组中的唯一 `id=model`，其次唯一 `name=Model`，大小写无关；单一 model 分类继续兼容任意既有 id。这一方向合理，依据是同一官方返回对象的显式标识，不需要按 Agent 名称分支。建议保留以下界限：

- 多个分类项既无唯一 model id、也无唯一 Model 名称时，返回无确定主模型，不重新选第一项；已经存在歧义分类组时，不再落入旧正则后备。
- 重复明确 model id 不通过名称打破平局。配置命令按 id 发送，重复 id 的请求目标本身不唯一。
- 单一 model 分类且 id 为 `engine`、`llm` 等仍正常使用；无分类的历史兼容单独处理。不把有其他显式 category 的 provider/model_config 误吸入新的主模型判定。
- 保持 provider 的原始 `category:model`、通用设置可见性及保护集合；只修主模型选择，不顺手修改后端的全部模型相关选项比较规则。

最低有意义的回归是：①真实形状 provider→model；②对调顺序结果一致；③唯一明确 id 优先于另一项的 Model 名称；④无明确 id 时唯一 Model 名称；⑤单一非标准 id 兼容；⑥多项无明确候选和重复 model id 不误选；⑦主选择器操作请求 `setConfig(thread,"model",value)`，不请求 provider；⑧provider 仍在 `sessionOptions` 且两个 model 分类都在 `protectedConfigIds`；⑨按选中的 model id 读取 `storedModelValue`，不会把 provider 的保存值当模型。这里只给审查依据，未替根任务执行测试。

调用目标核对：`EmptyState.tsx:789`、`:794` 与 `ThreadView.tsx:1091` 都依赖 `modelOption.id`，因此修正共用投影能同时修复实际请求目标；测试不能只断言显示文本。`SessionOptionsMenu.tsx:84` 依主模型 id 排除一项，修正后 provider 自然回到其他设置，无需另建 UI。
