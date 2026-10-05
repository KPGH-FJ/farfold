# R5 模型读取：最终安装及最小实机验收

用户此前明确“已全部完成，可以更新”，后续授权一次打包并完成最小验收。更新前无新增子进程或待发送记录，经正常菜单退出和保存屏障结束后，仅替换 `/Applications/Farfold.app`。未重复前序终端验收、登录或逐家测试。

最终程序 SHA-256：`dbe261705ba4331470876f6cc3e605e7a1b021fd179092ed34e726c90af41279`，标识 `ai.farfold.desktop`。2026-10-03 09:51:00 +08:00 安装。502 项输入签名前后及当前一致，摘要 `0152edc274c7bcedc1be45f79e6577c17fa644dae4eeef49751d6a78ebe33344`。四文件摘要 `c487229e89413416c386aa73fb697f7eaa7f1706e0186ec004fc7600b35fb5b5`，严格签名与独立只读复核通过。

只执行一次 Tauri app 打包，复用本片 265 项受控测试、类型、格式与前端构建。打包保留既有大文件警告和本地签名未公证提示。重复 bundle app 在正式四文件与签名再次匹配后精确移除，没有其他应用或备份，没有清空 target。

## 实际读取

冷启动后 Pi 位于程序/终端设置步骤。检查连接成功后，通过管理折叠区“已有设置”继续；源码确认该入口只调整 Farfold 准备方式，保留无 API 服务的原模型选择，不认证、不运行终端或配置接口。未重开前序用户输入过 Key 的终端。

| 操作           | 实际结果                                                                         | 无内容协议证据                                                |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 首次进入模型页 | 显示已读取当前模型选项，失配提示保留原选择，保存禁用；“沿用当前设置”可用但未点击 | 相对连接检查新增 1 次 session/new，0 配置、0 消息、0 认证请求 |
| 重新读取模型   | 返回新读取，失配提示和保存禁用仍在；没有选择、沿用、保存或测试                   | 相对首次读取新增 1 次 session/new，0 配置、0 消息、0 认证请求 |

从安装至重读收据结束，共 2 次 initialize、3 次 session/new：启动已有 1 次 new，两个模型读取各 1 次 new。整个窗口 **0 session/set_config_option、0 session/prompt、0 authenticate、0 拒绝诊断记录**。日志仅严格校验的无内容字段，没有参数或身份关联，不猜测启动记录所属对象。

完整非秘密模型显示名称为 **`deepseek/DeepSeek V4 Pro`**，画面为 Thinking off。组件 title 来自选项 name，显示名称不等于协议精确 ID；本轮未读取该 ID、Agent 配置、Keychain、环境值、账号文件或终端内容。Cohere 意图仍未核实，未代用户切换。前序两次配置请求的具体 ID/值及持久化影响仍未知。

实机图：[首次读取](installed/pi-first-read.png)、[重新读取](installed/pi-reread.png)，仅模型页，无终端或凭据界面。测试折叠区未打开或发送；本轮实机只核失配提示与保存禁用。测试门、明确重选/沿用、失败及旧回调保护仍用受控证据，不冒称全部实机通过。

## 保留与停点

替换前后 48 会话、40 Agent、49 设置、62 已忽略记录及三项数据库文件摘要完全相同。交互后会话、已忽略记录及未发送内容保持；Agent 仅 2 行 updated_at 变化，设置仅 agentSetup.v1 值变化，无增删。准备变化包含从终端方式转入已有设置及模型读取步骤，不能由整体摘要证明全部内部字段逐项相同。

**收尾进程名核查发现 `devin` 与 `docker` 子进程**。这是新版启动后的观察，未主动打开、检查或操纵该暂停路径，也未读取其参数、环境、输出、认证或工作内容。已按暂停约束停止进一步应用操作，未强关这些进程。零请求窗口不能证明这些进程没有其他工作；具体对象交回，不扩展排查。

正式应用留在 Pi 模型页，未点击模型、推理、沿用当前设置、保存或测试。所有代码审查子任务停止写入。下一步交用户评 R5 实际效果，不推进 E 或逐家测试，不将 B/C/D 整体记为通过。真实认证正回执、API 实际交付、非零退出/取消/回收失败、明确模型选择及 Cohere 精确目标没有新增实机验收，原证据边界保留。

Git HEAD 仍为 `cee3f8629f740e48f71668147e7755b3a96d92f8`；95 项已跟踪路径修改、44 个未跟踪路径条目、0 暂存，既有修改保留，无提交、推送或发布。

收据：[预核](installed/preflight.json)、[正常退出](installed/normal-quit.log)、[输入前](signed-source-before-build.json)、[输入后](signed-source-after-build.json)、[候选](built-bundle.json)、[打包](tauri-build.log)、[安装](installed/installation.json)、[读取对比](installed/protocol-comparison.json)、[首次控件](installed/controls-first-read.json)、[重读控件](installed/controls-reread.json)、[显示名称](installed/controls-model-label.json)、[数据对比](installed/acceptance-data-comparison.json)、[最终进程名](installed/processes-final.json)、[图片摘要](installed/screenshots.json)、[重复应用清理](installed/duplicate-cleanup.json)、[Git 摘要](installed/git-summary.json)。
