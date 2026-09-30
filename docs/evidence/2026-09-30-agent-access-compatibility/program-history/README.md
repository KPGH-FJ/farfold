# 显式程序选择历史与卸载清理回归

本片基于已提交的 `6b02dae`，只修改 [installations.rs](../../../../src-tauri/src/installations.rs) 及拆出的 [history_tests.rs](../../../../src-tauri/src/installations/history_tests.rs)。沿用 `installations.v1`、`installPrevious.*` 与现有选择原子事务；没有新增存储体系。本文件记录源码及自有临时目录/SQLite 测试，正式安装版验证由根任务另行执行。

## 根因与修复范围

此前程序清单只加入当前显式路径与本机发现结果，未将切走的显式 `programPath` 持久保留。程序不在发现结果中会消失；发现结果为已解析路径时，回选也可能丢失用户原别名。

现在选择提交在覆盖旧快照前，将旧快照及当前显式路径记入既有清单。连续三次选择仍保留最初程序；通过 `same_path` 去重，但同目标外部条目保留当前显式选择的原拼写。历史条目标记为外部程序，`managedRoot=None`，不借用组件版本、不获得卸载权限。命令、参数、组件版本及其他环境字段保持原语义；清单与选择一起由原事务提交，过期选择或存储失败不能发布半份历史。

卸载仅删除经已有收据和 `owned_root` 验证的目录，并清理该目录覆盖的程序历史引用。当前任一接入仍依赖该目录时拒绝卸载，包括目录内指向外部文件的别名。用户目录中的别名文件保留。历史清理只修改有效 `installPrevious.*` 的公开 `programPath`，不修改其命令、参数、版本、来源或当前接入环境；包括没有实体清单条目的旧跨接入快照。先保存历史清理，再删除收据；若目录已删除但元数据保存失败，保留收据供精确重试。删除后的别名解析使用有界 64 层上限，覆盖当前 macOS `MAXSYMLINKS=32`；测试使用实际可解析的 12 层链，不把有界解析称为无限支持。

## 失败证据与定向验证

- 原始根因：[corrected-red.json](corrected-red.json) / [corrected-red.log](corrected-red.log)，`6b02dae` 生产实现加修正后的自有 fixture，4 项真实失败，退出 101。较早 `red.log`、`green.log` 含 fixture 更新时间及环境顺序错误，不作为产品失败证据。
- 持久化已解析条目与卸载幽灵反例：[review-red.json](review-red.json) / [review-red.log](review-red.log)，7 项中 2 项失败，退出 101；对应修正后 [review-green.json](review-green.json) 为 18 项通过。
- 最终两项边界：[final-boundaries-red.json](final-boundaries-red.json) / [final-boundaries-red.log](final-boundaries-red.log)，19 项中 17 项通过、2 项失败，退出 101。跨接入旧快照未清；12 层别名在目录删除后被漏过，预期元数据失败也未触发。
- 最终修正：[final-boundaries-green.json](final-boundaries-green.json) / [final-boundaries-green.log](final-boundaries-green.log)，实际命令与退出结果保留在收据；覆盖空发现清单、原别名逐字回选、三程序选择、旧快照迁移、过期选择/原子失败、外部不可卸载、跨接入当前配置保护、删除后不复活及两类元数据失败重试。

上述用例没有运行外部 Agent、认证、对话或正式应用，也未修改用户配置。正式应用中的选择/回选、真实连接以及全量检查不能由这些 fixture 代替。
