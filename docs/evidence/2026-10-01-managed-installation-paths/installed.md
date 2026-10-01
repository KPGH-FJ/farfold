# 新受管目录的正式安装验证

2026-10-01 15:28–15:46。代码 `61e8fb4` 安装到唯一 `/Applications/Farfold.app`，二进制 `c02f1ff781b805c95891d718c40aa6fbd12a86e3432f8e11585149f4ed625504`。本片证明新目录安装和三个旧入口的有限回归，不代表全部目录或账号旅程通过。

## 实现与检查

新普通安装进入独立的 `agent-installations/agent-<字节百分号编码>/install-*`；旧安装不迁移。普通程序、伴随程序与旧根的精确归属共用检查，三个既有接入层证明继续核对原收据、参数和包结构。见[实施记录](implementation.md)及[源码审查](review.md)。只移除 Farfold 自己加入的路径分隔符，不保证任意用户祖先路径兼容，也未证明旧 Junie `parse_error` 的唯一原因。

- 定向红例为 8 失败、2 通过，非编译失败；实现后相关 73 项通过。
- [完整 Rust 检查](checks-rust.json)：561 通过、3 既有忽略；clippy 与 [fmt](fmt.json) 通过。
- [314 个前端输入保持](frontend-check-reuse.json)，复用 `207c01f` 的 1,266 项 /139 文件测试及类型、构建检查；本次[全仓格式](checks-format.json)和[打包](checks-bundle.json)通过。
- [安装收据](candidate-install.json)与 [453 项输入](candidate-source.json)固定候选；至退出源码无变化。

## 安装版实际结果

| 操作               | 结果与边界                                                                                                                                                                            | 证据                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Junie 官方目录安装 | 3419.24.0 安装并连接成功；正式 SDK 接受初始化。新根为 `agent-installations/agent-registry%3Ajunie/install-fykWYY`，官方入口参数仍为 `--acp=true`                                      | [安装中](02-junie-downloading.jpg)、[已连接](06-junie-installed-connected.jpg)、[公开收据字段](targets-while-running.json) |
| Junie 账号与模型   | 两种账号方式可见：Junie Account / Junie CLI (interactive)；没有选择或执行。明确读取模型后返回认证要求，未取得模型选项，未登录或发送消息                                               | [账号菜单](08-junie-auth-methods-menu.jpg)、[最终认证要求](10-junie-auth-required.jpg)；09 只是读取中                      |
| Kilo 旧安装        | 7.8.1 原程序重新连接，账号页保留可用“在终端登录”；没有执行登录                                                                                                                        | [Kilo](03-kilo-legacy-auth.jpg)                                                                                            |
| Copilot 旧安装     | 1.0.89 原程序重新连接，账号页保留可用“在终端登录”；没有执行登录                                                                                                                       | [Copilot](04-copilot-legacy-auth.jpg)                                                                                      |
| goose 旧安装       | 1.52.0 原程序连接；查看配置操作仍列出旧绝对路径 `agents/registry:goose/install-CZRnMj/goose`、`configure`、原资料文件夹和副作用说明。随后返回，没有运行配置程序。自动模型读取失败保留 | [配置预览](05-goose-legacy-config-review.jpg)                                                                              |
| 原草稿             | 返回原 Amp 普通空稿，已有来源、Medium 保持，未发送                                                                                                                                    | [原选择](11-original-amp-draft.jpg)                                                                                        |

旧 Junie 的提前结束和两次 `parse_error` 仍为原候选失败；本次新目录成功不补写旧失败正文或唯一根因。新根的卸载、切换、失败取消及其他分发类型使用新根的真实安装旅程未在本片复测，相关归属与保留边界只有受控回归。本片不验证三个旧入口实际登录/配置成功。

## 数据、协议与退出

[退出核对](after-exit.json)：原 36 条对话索引、39 个 Agent 启动配置、所有原未发字段（含意见、队列、活动）保持；无新增对话。新增 Junie 后共 40 个 Agent、49 个设置。变化只在 `installations.v1`、`agentSetup.v1` 及新增 `installPrevious.registry:junie`，其余原设置逐项保持。准备进度存在变化，本片没有旧逐项进度快照，不将其声称为逐项相同。

[收据增量核对](installation-delta.json)从当前 44 条安装记录移除唯一 Junie 项，重构后的完整旧记录摘要与基线相同；43 条原安装记录均保持。三个专项旧目标的公共字段也与 [基线](target-baseline.json) 相同。未读取凭据值、未计算 Agent 二进制摘要。

[脱敏协议](protocol-metadata-final.json)：6 文件、50 条启动记录，发出 6 initialize、5 session/new、5 session/set_config_option；均来自既有连接/模型准备流程，没有手选其他模型或改已有对话。0 prompt / authenticate / load / cancel / permission，无解析错误；Junie 的 new 返回 auth_required，goose 的 new 返回 internal_error。六个连接最终均 childReaped / groupEnded / connectionRemoved；Junie 安装候选目录最终 retained。

正常退出后，[27 个采样进程身份](all-observed-processes.json)均不在；不声称采样捕获所有瞬时进程，也不覆盖前序另行记录的两个 UE 夹具。[重复应用清理](duplicate-app-cleanup.json)逐一核对四个文件后仅移除本次构建副本，正式应用保持。

后续继续同一正式候选的文件意见跨页面与冷恢复旅程；Junie 账号、首发和续接，其他账号条件及全目录同候选验收继续开放。
