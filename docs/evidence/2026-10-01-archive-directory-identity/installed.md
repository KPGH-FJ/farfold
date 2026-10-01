# 归档保护：正式安装验证

2026-10-01 23:10–23:32，正式 `/Applications/Farfold.app`，源码 `ab7a3ec`，二进制 `22ac66ae2dff94b3e99bc905d64fc9d8eab181c72cef42e5ee9de84df18a361b`。[安装收据](candidate-install.json)四文件一致、签名通过；[候选输入](candidate-source.json)458 项至退出保持。工程红绿与完整检查见 [README](README.md)。

目标仅为本任务自有 OpenCode 历史 `opencode:/private/tmp/farfold-stop-queue-idn3cxh0:ses_f0a560db1ffeJTUeGpvCgi6hIG`，保持 Nemotron 3 Ultra Free / 沿用已有设置 / build。截图均由正式应用 UI 获取，同名 `.txt` 保留完整 AX；旧历史指令仅作回放内容，没有重新执行。

| 实际动作与结果                                                                                                    | 证据                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 原 Amp / Medium 空白新稿；打开目标历史，只加入 `FARFOLD-ARCHIVE-DRAFT-20261001`，归档禁用且提示清除或发送未发内容 | [01](01-original-empty-draft.jpg)、[02](02-unsent-archive-blocked.jpg)                                        |
| 正常退出后进程采样为空；冷启动找回同一历史，测试稿仍在；设置返回后原模型、来源和 build 保持                       | [退出核对](draft-after-exit.json)、[03](03-cold-draft-preserved.jpg)、[04](04-return-selection-preserved.jpg) |
| 只清本次稿后归档可用；归档成功，未归档数 35→34，菜单变为恢复；归档列表包含目标                                    | [05](05-archived.jpg)、[06](06-archived-list.jpg)、[archived.json](archived.json)                             |
| 从归档列表恢复目标，未归档数返回 35；重开同一历史，原模型、来源、build 与空稿保持                                 | [07](07-restored-history-selection.jpg)、[restored.json](restored.json)                                       |
| 返回原 Amp / Medium 空稿，正常退出                                                                                | [08](08-original-empty-restored.jpg)、[最终核对](after-exit.json)                                             |

[基线](data-before.json)与[未发基线](unsent-before.json)对比：原 36 索引无增删；归档阶段目标仅 `archived/updated_at` 改变，恢复后仅 `updated_at` 变化，其他 35 行时间也保持。目标 id、目录、外部历史 id、标题、模型配置、收藏及创建时间均保持；最终 `archived=false`。40 行原 Agent 摘要保持，该比较不扩大为新增 Agent 全表计数。49 项原设置仅 `unsentWork.v1` 变化，其逐字段核对仅目标 activity 时间变化；结束状态仍 true，其他活动、文字、选择、反馈、队列及所有原字段保持，无新增设置或未发键残留。编辑测试稿和恢复动作都会刷新活动时间，不能把全部时间变化归因于其中一次操作。

[协议元数据](protocol-metadata-final.json)窗口从本次安装开始：4 个文件、32 条启动摘要、4 initialize、2 new、2 load、8 response、110 update，另有 2 条 stderr 长度标记，0 拒收记录。0 prompt/authenticate/cancel/permission/set_config_option；这些计数不证明未记录事件的内容。[6 个实际采样身份](all-observed-processes.json)均在最终退出后消失；采样不能覆盖所有短命后代。[重复应用清理](duplicate-app-cleanup.json)仅移除与正式四文件完全相同的本次打包 `.app`，正式应用保留。

正式索引目录均为规范路径，本片只计普通归档保护与恢复回归；旧别名、目录无法核实、链接改指及竞争反例属于[受控后端证据](backend.md)。未改正式索引制造别名，未验证真实自动到期归档、强杀、登录、首发或全目录同候选完整旅程；账号/API 云端等条件继续开放。
