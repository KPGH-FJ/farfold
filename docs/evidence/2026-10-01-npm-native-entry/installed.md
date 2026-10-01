# npm 独立程序入口与历史列表完成顺序：安装验证

2026-10-01 14:22–14:29，正式 `/Applications/Farfold.app` 已安装 `4277a2a`（含 `6857aed`），二进制 `28fda12158b7654b6f372dc6fb9668455fd250374196dff1181c8967c4111bcc`。两项目录安装/连接与连续历史查找在本候选通过；账号、模型请求和完整目录验收保持开放。

## 实际结果

| 路径              | 本候选结果                                                                                                                                                             | 证据与范围                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Factory Droid     | 官方目录 `droid@0.230.0` 安装、直接启动 arm64 Mach-O、连接通过。命令为本次安装的 `node_modules/droid/bin/droid`，参数仍为 `exec --output-format acp-daemon`            | [登记与入口](factory-registration.json)、[连接后要求登录](01-factory-auth-required.jpg)、[账号路线](02-factory-auth-options.jpg)。自报 `@factory/cli` 0.230.0；自动模型读取返回 `auth_required`。Login / Factory API Key 可见，未选择或执行。 |
| Grok Build        | 当前目录 `@xai-official/grok@1.0.46` 安装、直接启动 arm64 Mach-O、连接通过。命令为本次安装的 `node_modules/@xai-official/grok/bin/grok-native`，参数仍为 `agent stdio` | [两项登记](both-registration.json)、[安装中](03-grok-installing.jpg)、[连接后要求登录](04-grok-auth-required.jpg)。未提供 agentInfo；自动模型读取返回 `auth_required`，Grok 登录入口可见，未执行。旧 1.0.45 静态材料不替代这次 1.0.46 实测。  |
| OpenCode 历史查找 | 默认范围首次查找及两次显式重新查找均返回结果，无“上次操作尚未结束”误拦                                                                                                 | [首次](05-history-first-query.jpg)、[重查一](06-history-repeat-one.jpg)、[重查二](07-history-repeat-two.jpg)。[列表底部](08-history-list-bottom.jpg)没有下一页入口，本次未实测真实分页。没有选择、预览、导入或打开任何结果。                  |
| 返回原稿          | 原 Amp / 已有设置 / Medium 普通空稿恢复，发送禁用                                                                                                                      | [原稿](09-original-draft-restored.jpg)、[原模型](10-original-draft-model.jpg)。未选新模型、未填凭据、未发送消息。                                                                                                                             |

截图对应同名 `.txt` 保存当时可访问界面；历史结果较多，顶部和底部各保存其可见范围，不能据此宣称全部正文已读取。界面的连续操作验证不替代同步唤醒点的确定性竞态回归。

本次目录启动参数没有人为调整。入口辨识仍以实际 `initialize` 判定兼容，没有计算 Agent 程序 SHA、固定额外版本、私有 HOME 或改写 Agent 配置。官方程序自身的行为不由本次元数据核对证明为无配置副作用。两项此前失败保留原候选和条件；未保存旧入口载荷，不能唯一归因旧失败。

## 工程与候选身份

- [入口实现及红绿边界](implementation.md)、[列表完成顺序及确定性红绿](discovery-result-order.md)。两个独立提交分别为 `6857aed`、`4277a2a`。
- [最终 Rust 检查](checks-rust-final.json)：551 通过、3 项既有忽略，fmt/clippy 通过。首次全量 545 通过/1 失败/3 忽略的发现保留在 [首次检查](checks-rust.json)；随后修复列表操作释放顺序再全量通过。
- [前端复用](frontend-check-reuse.json)：313 项前端输入与 `802be9c` 一致，复用 138 文件/1,238 项测试、类型与构建通过；没有把前端复用说成此次重跑。
- [最终格式](checks-format-final.json)、[打包](checks-bundle.json)退出 0。[安装回执](candidate-install.json)核对四个文件及 codesign；[450 项冻结](candidate-source.json)至退出没有变化。
- 独立只读审查见 [入口](native-static-review.json)与[列表顺序](discovery-static-review.json)。首次格式失败、系统副本夹具失败、错误 `updated_at` 断言及各原始日志均保留，不计入成功。

## 数据与进程

[退出核对](after-exit.json)：原 36 条索引、37 份启动配置及所有原未发字段（包括 activity）保持不变，没有新会话。新增 Factory/Grok 两个 Agent；设置仅安装库存、准备进度及这两项先前选择记录因操作变化。正式数据库索引数与界面非归档数量分别判断，不把界面 35 段写成数据库 35 条。

[协议摘要](protocol-summary.json)以实际安装时间 14:22:37 为窗口起点，初始研究时间另保存在 [candidate-run](candidate-run.json)：6 次 initialize、3 次 session/new、3 次 session/list、49 条启动记录，0 prompt/authenticate/load/cancel/permission。两项模型读取各出现明确 `auth_required`；Amp 空稿创建不计作首发。

[实际采样的 20 个正式候选进程身份](all-observed-processes.json)在退出后均未继续存在；不声称采样捕获了每个瞬时子进程。[重复应用清理](duplicate-app-cleanup.json)只删除四文件匹配的本项目打包副本，正式应用保留。

**独立未解决项：** 早期测试直接执行 Apple 系统程序副本时的两个进程（85862、85872，均 14:00:29）仍为 UE，见[安装后复查](early-fixture-after-install.json)。它们不是正式候选进程；已保留其精确临时目录，不再次终止或删除，不将本片正式应用退出写成整机没有本任务残留。自有 clang 夹具随后已用有界执行完成回归；系统副本异常原因仍未知。

## 后续

补 Factory/Grok 可用账号条件下的登录、模型、首发与恢复；核对 Junie/Minion 剩余安装失败。全目录同候选、Messages 云端、新凭据管理与其他旅程缺口继续按活动计划推进。本片只关闭已验证的 npm 启动分类和列表真实终态交付顺序问题。
