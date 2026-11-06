# 第 1 阶段原目录与 Copilot 额度复核

macOS arm64 27.0（26A425）的唯一正式应用仍使用功能源码 `dbe23bb6e`。本轮实测完成后核对了原未发稿、1 份保留草稿及原工作位置。两个旧对象保持原设置，原请求没有重发。

## 原桌面目录

- **Kilo** 的原自测目录查找未完成。同一实时桌面权限请求关联了实际 Kilo 子进程及其负责进程 Farfold，持久日志确认进入 `AUTHREQ_PROMPTING`。从请求开始到子进程退出后的核查时段，未捕捉到同一请求的授权决定。系统设置中的 Farfold 桌面访问开关显示开启。邻近拒绝日志属于全磁盘访问检查。当前可确认的是 Kilo 查找与桌面权限提示处理重合，系统调用的实际路径、返回值、权限请求未结算的机制仍待核实。[Apple 桌面访问说明](https://developer.apple.com/documentation/bundleresources/information-property-list/nsdesktopfolderusagedescription)
- **Goose** 的指定原会话在原工作位置读回正文。内容无关协议日志观察到一次初始化、一次历史加载、两条回复帧及 35 条历史更新。此次未复现旧目录卡点，实时窗口未见归属该子进程的桌面权限请求。原免费模型的续接发出一次，未见最终回复。稍后发出一次取消，界面保留停止结果未知和暂停发送，后续观察仍无归属终态。本次续接的日志与栈样本未显示前次目录打开卡点。

## Copilot 当前账号与实测

- 项目登记版本为 `1.0.89`，实际注册程序直连和官方 SDK 均报告 `1.0.106`。只读 SDK 与 GitHub CLI 的账号一致，用户登录后又核对网页版为同一身份。测试前账户页显示 **Copilot Free、包含额度已用 0%、Copilot CLI 启用**。SDK 报告额度耗尽后不允许继续用或超额用。旧请求口径的计数保存在私有证据中，未当作 AI Credits 数量。实际测试使用 Free 套餐的 Auto，未调整套餐、预算或支付设置。[Copilot 套餐](https://docs.github.com/en/copilot/get-started/plans) · [个人计费规则](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)
- 正式应用读回指定已归档原会话的旧正文，保留旧工具未知和发送暂停。只读核对同一条记录的 v2 保存设置，原模型选择为空。当前 `auto` 因缺少原模型基线而被挡下。补原对象续接需取得原模型保存证据或已有产品恢复路径。旧记录未重发。
- 在自有空目录沿用同账号，**Auto / Agent / Allow All Off** 的一次短消息返回精确标记；另一条纯文本请求收到明确已停止终态。两次分项各有正式界面与独立于原会话的内容无关协议回执。

## 隔离验证与缺项

真实跨 Agent 实测中，Goose 原会话与 Kilo 空目录测试会话同时运行。只向 Goose 发出一次取消，Goose 停止结果未知，Kilo 独立返回其测试标记并回到空闲。另有受控前端回归覆盖同 Agent、同目录的双对话。A 的取消回执丢失后，A 保留原审批、暂停待发，B 的原审批只向 B 发出一次。该项使用受控回执与时钟。

首波完整验收仍为 0/3。原 Kilo 桌面历史、原 Goose 续接终态、原 Copilot 模型基线与旧工具状态、真实审批和安装版存储故障分别待补。Windows 安装依赖可用 runner。 [本批证据指纹](summary.json) · [当前计划](../../../plans/agent-access.md)
