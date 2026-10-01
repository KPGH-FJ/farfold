# 归档目录身份保护

旧索引保留目录别名时，仅用索引 key 检查可能漏掉规范目录下的未发稿或忙连接。本片同时保护原路径与本次核实规范路径的两个精确目标：前端等待草稿保存后重查，后端在同一操作及原 SQLite 事务内复核索引身份、目录和未发内容；`expectedCwd` 只可否决不一致，不能扩大目标或使失败放行。目录不存在或无法核实时暂拒归档，`archived=false` 的移回仍允许。不迁移索引，不保存别名表，也不解析最近祖先。实现与分阶段真实红绿见 [backend.md](backend.md)，前端入口在 [archive_admission.ts](../../../src/runtime/archive_admission.ts)。

源码 `ab7a3ec` 已提交，[458 个候选输入](candidate-source.json)已冻结。[前端红测](frontend-red.json) / [日志](frontend-red.log)为 3 失败；[定向绿测](frontend-focused.json) / [日志](frontend-focused.log)为 6 文件、46 项通过。[完整前端](checks-frontend-final.json)为 140 文件、1,290 项，类型与构建退出 0；[完整 Rust](checks-rust.json)为四并发 589 通过、3 既有忽略，fmt/clippy 退出 0。[全仓格式](checks-format-before-install.json)与[打包](checks-bundle.json)退出 0。后端分阶段反例、组合断言和范围限制保留在原收据中；[源码独审](source-review.md) / [摘要](source-review.json)已完成，无源码阻断。

正式应用已于 23:10:53 替换，[安装身份](candidate-install.json)的 4 个文件差异为空、签名退出 0，二进制 `22ac66ae2dff94b3e99bc905d64fc9d8eab181c72cef42e5ee9de84df18a361b`。任务自有 OpenCode 历史完成未发字阻归档、正常退出冷保留、设置返回、清本次稿后归档与移回；原 Nemotron / 已有设置 / build 保持，最后还原 Amp / Medium 空稿并正常退出，见[安装记录](installed.md)及 01–08 截图。正式 36 条索引目录均规范，未改正式数据制造别名；安装结果只计普通回归，不代替隔离别名/竞争反例。

[最终核对](after-exit.json)：458 输入保持、原 36 索引无增删，恢复后只有目标更新时间变化；40 行原 Agent 摘要保持，49 项原设置仅未发记录中目标活动时间变化，其余原字段与结束状态保持、无新增未发键。窗口 0 prompt，6 个采样身份结束；[重复应用已精确清理](duplicate-app-cleanup.json)。账号/密钥条件、实际自动到期归档与最终同候选全目录验收继续开放。
