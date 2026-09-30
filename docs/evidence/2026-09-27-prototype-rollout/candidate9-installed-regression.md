# 候选九安装版独立回归

日期：2026-09-27。候选九相对候选八仅追加显式关闭权限菜单后向确认弹窗交接焦点的修复，前序主体实现仍包含在安装包内；候选八的焦点归还失败保留历史。当前有本候选焦点返回、输入法确认/明确发送/真实回复、同版本冷草稿/权限恢复及独立九轮计时通过；这些具体结果不等于完整交付或全部J1–J6通过。

## 正式安装与工程证据

[安装身份](candidate9-installed.json)：19:09:00.590784 CST（11:09:00.590784 UTC）替换唯一 `/Applications/Farfold.app`，版本0.1.7 / `ai.farfold.desktop`，主程序SHA256 `242b9e8b21323d2c05d1c3025648931b0ff6ebcd434a03128763a6f211904d94`。首PID78958，记录启动时点19:09:00.836623。[冻结245文件](candidate9-source.json)相比候选八仅WorkspacePopover.tsx及新增WorkspacePopover.focus.test.tsx；原型、模型、权限语义和Rust源码不变。完整打包与正式安装一致、签名通过，精确重复.app已移除。安装前[跟踪](candidate9-before-install-exit.json)与[退出确认](candidate9-after-install-exit.json)证明候选八所属17个本轮进程全部结束。

[工程检查摘要](checks/candidate9-focus-checks-summary.md)及[结构摘要](checks/candidate9-focus-checks-summary.json)记录全前端375项、类型和定向检查回执。它们是执行回执摘要，不是原始CLI日志；[打包日志](checks/candidate9-build.log)为原始输出。Rust没有变化，沿用对应旧源码检查证据，不声称本候选另跑后端。

## 本候选现场结果

- [截图142](screenshots/142-candidate9-original-draft-startup.png)：原全局草稿启动可见，未发送。
- [截图143](screenshots/143-candidate9-permission-escape-restores-focus.png)及[焦点记录](candidate9-permission-focus.json)：权限菜单选择Ask后Return打开确认，Escape后真实焦点回权限触发按钮。再次Ask并确认应用后焦点仍在该按钮；冷恢复权限未知，经真实匹配回执后解除发送保护，Ultra保留。本次关闭焦点归还反例已复验修正，不扩大为完整键盘验收。
- [截图144](screenshots/144-candidate9-ime-confirm-not-sent.png)及[确认状态](candidate9-ime-confirm-state.json)：带本轮测试前缀真实逐键ceshi组词，一次Return只确认、未发送；第二次普通Return于19:10明确发送。Codex19:10已真实完成并准确回复FARFOLD-C9-IME-OK（[147](screenshots/147-candidate9-ime-real-codex-result.png)），本次新版本确认/明确发送/回复闭环成功。

候选九[148](screenshots/148-candidate9-owned-chinese-draft-before-cold.png)另证已恢复原中文输入法，真实逐键zhongwen后Space得到“中文”、Shift+Return只换行；本轮自建C9-OWN-COLD-DRAFT含中文及换行保持未发送，待同版本冷恢复，原全局草稿另行保留且已返回。这是冷启动前的保存状态，恢复结果见下节。

## 同版本正常退出与冷恢复

[退出前](candidate9-before-cold-exit.json)跟踪8个本轮进程；[19:25:04退出后](candidate9-after-cold-exit.json)全部结束且正式进程列表为空。[明确重开](candidate9-cold-relaunch.json)为同SHA新PID80159，启动于19:25:11。

[149](screenshots/149-candidate9-original-draft-after-cold.png)原全局草稿保留；[150](screenshots/150-candidate9-owned-draft-restored-permission-blocked.png)本轮C9-OWN-COLD-DRAFT、中文与换行恢复，权限未知时发送禁用，Ultra保留。[取消焦点记录](candidate9-permission-cancel-focus.json)确认点击取消也回权限触发按钮。[151](screenshots/151-candidate9-permission-reconfirmed-draft-unsubmitted.png)明确选Ask并确认，真实回执后发送可用，原中文稿未自动发；随后仅清理本轮自建中文稿，回到[152原全局草稿](screenshots/152-candidate9-final-original-draft.png)，未发送。

## 最终数据保全范围

[19:31:35最终保全](candidate9-data-preservation.md)及[字段核对](candidate9-data-preservation.json)确认原62会话/10Agent/68忽略记录身份全部保留，当前83/10/81；原全局文字、附件、Agent/位置/服务/模型/思考选择逐字段一致，未处于发送或首次发送未知状态。收藏2、分组总数2，成员分别1/3；此前“组3”指安装验收组内3条对话。历史完整分组成员没有逐项基线，外部正文和秘密未审，不称所有用户数据完整审计。245源码、原型选定161文件及4个安装摘要匹配，新PID80159与唯一正式App身份一致。

## 性能与未完成边界

本候选三场景各三轮已由一名独立审计者完整核对通过，详见[运行中审计](candidate9-performance-validated.md)及[逐项来源](candidate9-performance-validated.json)：1170正式样本，每轮100输入/30切换，总900/270，最高p95输入31ms/切换90ms。当前静态负载数量及三轮双路窗口21.208/21.936/21.477秒完整覆盖，最短完成余量14.598934秒；不声称逐毫秒输出，也不冒称两人交叉审计。

候选八队列/双审批、候选七其他旅程及九轮性能均保持原候选归属，不改标签成为候选九通过。OpenCode两次已证429服务限流，Pi连接错误另列；不改模型或反复请求绕过失败。文字放大没有已承诺产品设置入口，保持布局未测；账号/API秘密/记住授权与真实签名发布源条件继续保留。完整J1–J6未完成。

[采集收尾](candidate9-performance-finalization.md)及[结构核对](candidate9-performance-finalization.json)确认19:24:49.078628正常exit0、storageFailure为空；最终1206条与运行中完整前缀逐字节一致，18条边界及非元数据来源不变，九轮重算仍通过。旧8进程和采集器OS PID78945均结束、锁释放；新80159同SHA。原运行中报告保留当时状态，不修改原始采样。完整帧、长任务、内存与线程预算未测；模拟界面负载不等于真实模型吞吐或J4全旅程。
