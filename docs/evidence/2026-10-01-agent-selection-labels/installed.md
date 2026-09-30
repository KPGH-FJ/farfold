# 标签与恢复选择说明：安装复验

2026-10-01，Asia/Shanghai。候选 `d00e2c8880fd8761e1fcb9a5fd912a5b63aa7588` 在同一 `/Applications/Farfold.app` 完成 GLM 账号标签、Codex 漂移弹层、OpenCode 正常历史弹层的实际复验。**本片显示目标通过，登录、凭据交付与新回复未执行；Codex 原模型/推理恢复漂移仍失败。**

## 候选身份与工程检查

[安装收据](candidate-install.json)记录 04:35:11 复制完成，4 个应用文件与打包结果一致，签名检查退出 0。正式二进制 SHA-256：`ff4fbff7295fbf7dfbee3a04f0a1e1bc82fece85c50000e6f21c8c021da51349`。[421 项候选输入](candidate-source.json)与 04:39:06 的[退出核对](after-exit.json)一致，无源码变化；随后下一片源码修改不属于这份候选。

[前端全量](checks-frontend-full.json)为 133 文件、1,132 项通过，类型检查和构建通过；[稳定格式](checks-format-stable.json)、[打包](checks-bundle-final.json)退出 0。[后端复用](backend-checks-reused.json)基于 114 个输入未变，沿上一片 439 通过/3 忽略，不声称本片重新执行 Rust 全量。[实现与红绿](frontend.md)和[独立终审](review.md)保留受控验证范围。

## 安装观察

| 入口                                      | 实际结果                                                                                                                                                                                                  | 证据与限制                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已登记 GLM 1.13.0，账号方式菜单           | 两个原名称 `Z.AI API key` 分别附“Agent 登录”和“环境变量说明，暂不能在此配置”，未自动选中其一。                                                                                                            | [注册声明](glm-registration.json)、[实时菜单 AX](glm-auth-options.txt)。[01 截图](01-glm-distinct-auth-options.png)只捕获选择器，未捕获系统菜单浮层，不能单用该截图证明两条菜单标签。                                                          |
| 明确选择 GLM 环境说明项                   | 已选长标签完整可见；显示公开变量名 `Z_AI_API_KEY` 和不能在此配置的原因，没有普通登录/API 配置按钮；更多登录选项与重查仍可见。                                                                             | [02 截图](02-glm-environment-readonly.png)、[对应 AX](glm-environment-readonly.txt)。没有填入凭据或执行该方法；不代表旧环境声明已支持 Key 交付。                                                                                               |
| 同一 Codex 已知漂移历史，打开模型与来源   | 弹层明确标“Agent 当前返回的模型”并显示 `6.1 Sol`；差异保留 `Model: gpt-6-astra → gpt-6.1-sol`、`reasoning_effort: ultra → 未提供`，继续提示暂停发送、保留原内容与待发消息。没有再无条件宣称原模型已恢复。 | [03 截图](03-codex-current-versus-recorded.png)、[恢复 AX](codex-restored.txt)、[弹层 AX](codex-readonly.txt)。没有确认变化、改回模型或发送；原漂移失败没有被关闭。                                                                            |
| OpenCode 原 Nemotron 历史，打开模型与来源 | 原 4 条 Agent 回复作为历史可见；模型为 `OpenCode Zen/Nemotron 3 Ultra Free`、来源沿用已有设置，正常显示保持创建时设置的说明。                                                                             | [04 截图](04-opencode-retained-choice.png)、[恢复 AX](opencode-restored.txt)、[弹层 AX](opencode-readonly.txt)。该对话 v2 保存与前次续发来自[上一片安装证据](../2026-10-01-agent-config-categories/installed.md)；本片只重读历史，没有新回复。 |
| 返回原稿                                  | 回到 Amp / Medium 空稿，来源沿用已有设置，发送不可用。                                                                                                                                                    | [05 截图](05-original-amp-draft.png)、[原稿 AX](original-draft.txt)，并以下方未发字段摘要核对为准。                                                                                                                                            |

## 数据、协议与退出

[安装前基线](data-before.json)含 31 条会话索引、28 个启动配置、37 项设置。[安装前核对](before-build.json)及[退出核对](after-exit.json)证明所有原索引和原启动字段摘要保持；无新增会话索引。原未发数据的 version、composers、choice、feedback、queues、activity 均保持。仅设置 `agentSetup.v1` 变化，没有新增设置键；不能概括为全部设置逐字未变。

[协议元数据](protocol-metadata-final.json)共 4 文件，记录 4 次 initialize、2 次 session/new、2 次 session/load、3 次 session/set_config_option，**0 次 prompt、0 次 authenticate**。本片确有准备流程的临时 session/new，不能把“无新增持久索引”写成“没有新建协议会话”，也不能写成 initialize-only。此处不保存协议正文，不由元数据推断外部配置完全无写入。

实际工作目录见 [GLM/Amp](cwd-glm.json)、[Codex](cwd-codex.json)、[OpenCode](cwd-opencode.json)：所采 Agent/后代均在原普通对话目录，正式应用本身为 `/`。[累计观察](all-observed-processes.json)包含 10 个 PID + 启动身份；[最终退出](after-exit.json)核对这些身份均已结束，正式应用也退出。这是已采样身份的回收证明，不扩大为未采到的所有瞬时进程审计。

[重复产物删除证明](duplicate-removal.json)在核对 4 个文件完全相同后，只删除本次 `src-tauri/target/release/bundle/macos/Farfold.app`，保留正式 `/Applications/Farfold.app`，正式二进制摘要保持。

GLM 登录/Key 交付及真实回复未补测，原缺 Key 失败保留；Codex 漂移仍阻止续答；OpenCode 本轮没有续发。以上结果不替代完整账号旅程、多 Agent 恢复矩阵或产品全部出口。
