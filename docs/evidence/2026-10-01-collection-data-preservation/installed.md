# 分组记录保护：安装验证

2026-10-01 15:13–15:17，`207c01f` 已安装到唯一 `/Applications/Farfold.app`，二进制 `26ce98b23e06ce2a38014ce91eab82eba0d0c00a9e73a75b6b58c8eadbe1d29c`。正常旧记录的保存、冷读取与原样恢复通过；未知/损坏输入的拒绝与零写入仅在受控测试验证，没有向正式数据库注入损坏。

## 安装结果

1. [原有两个分组](01-original-groups.jpg)可读取，分别包含 4 / 2 条关系。把既有验收分组临时改名为“验收 0928 保存验证”，[保存后名称与四条成员](02-renamed-group-and-members.jpg)正确。
2. 正常退出并冷启动，[新名称与同样四条成员](03-cold-group-and-members.jpg)保留。没有打开正文、导入历史或发送消息。
3. 通过正式编辑入口[恢复原名](04-original-group-restored.jpg)，[另一分组及其两条成员](05-other-group-preserved.jpg)保持。[原 Amp 普通空稿](06-original-draft-restored.jpg)及[已有设置 / Medium](07-original-model.jpg)保持，模型弹层只查看后关闭。

每张截图有同名 `.txt` 保存当时界面。[中途核对](after-rename.json)仅分组设置变化；[完整值重构](rename-scope.json)确认当时唯一差异是这个临时名称。最终[退出核对](after-exit.json)确认原 36 索引、39 Agent 配置、48 设置和全部未发字段均恢复基线，没有新会话或新增设置；原两组的完整设置值摘要一致，不只比较界面计数。

## 检查与范围

- [实现及红绿](frontend.md)：旧行为 28 例中 25 失败、3 通过；修复后 4 文件 74 项通过。未知字段、部分损坏、重复身份和孤儿关系均整条拒绝，后续修改不得覆盖原值；正常无版本字段的旧格式保持。[独立审查](review.md)无阻断。
- [单次类型检查](typecheck.json)、[全量前端与构建](checks-frontend.json)通过，139 文件 / 1,266 项测试；[格式](checks-format.json)、[打包](checks-bundle.json)通过。137 后台输入未变，[复用](backend-check-reuse.json) `4277a2a` 的 551 Rust（3 既有忽略）及 fmt/clippy，不称本片重跑。
- [安装回执](candidate-install.json)四文件完全匹配，签名检查通过；[451 输入](candidate-source.json)至本片退出保持不变。没有引入新依赖、设置格式或 UI 分支。
- [协议摘要](protocol-summary.json)：两次启动各有 initialize 与空稿 session/new，共 16 条启动记录，0 prompt/authenticate/load/cancel/permission；两个连接最终均已回收。空稿创建不等于用户消息发送。
- [31 个实际采样身份](all-observed-processes.json)在退出时均不存在，不承诺采样覆盖瞬时全部后代。[重复应用](duplicate-app-cleanup.json)只在四文件匹配后精确移除，正式应用保留。早期系统副本 UE 仍是[前片独立未解决项](../2026-10-01-npm-native-entry/installed.md)，本片没有再次处置。

本片只关闭分组格式被静默裁剪并被下次保存覆盖的问题。损坏输入的真实安装错误页和修正存储后的安装重试未测；正常安装路径不替代这些受控边界。继续按计划修复受管安装目录的分隔符问题并补真实 Junie 安装，账号、API 云端与全目录最终验收保持开放。
