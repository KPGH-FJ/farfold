# P18 命令输出尾部保真

2026-10-30：[源码与反例](source-summary.json)记录UTF-16裁边及截断提示修正。原始输出与工具状态保持，尾部仍最多65536个UTF-16单元、显示最多200行。

受影响240项通过，完整七项在功能提交前通过（前端695文件9363项，Rust2326通过、6既有忽略）；已随2063416d8正式更新；[安装](formal-installation-summary.json)与[原对象只读回归](readonly-summary.json)分别留证，不能把受控输入当作真实Agent压力验收。独立源码审阅无阻断，[完整工程及独审](engineering-summary.json)分别留证。

[另一次真实命令观察](../2026-10-30-p18-live-command/readonly-summary.json)超过原180秒窗口，处理中内容栏仍未验证，结束后两行输出窄证保留。审批缺输入的来源条件不足，本次没有推断补齐。当前事实见[状态](../../status.md)，执行顺序只见[唯一活动计划](../../../plans/agent-access.md)。
