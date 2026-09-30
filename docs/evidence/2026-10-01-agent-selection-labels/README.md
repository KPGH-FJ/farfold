# 同名账号方式与恢复选择标签

本片修复安装实测发现的两个显示问题：GLM 两个同名账号方法无法辨别，以及原 Codex 历史发生模型/推理漂移后弹层仍无条件声称保留原模型。方法选择继续使用精确 ID，配置保护与发送准入未改；安装复验尚待执行。

- [前端实现与受控红绿](frontend.md)、[八文件摘要](frontend-checks.json)
- [独立审查](review.md)
- [完整前端检查](checks-frontend-full.json)：1,132 项通过，类型、构建通过。
- [后台检查复用](backend-checks-reused.json)：114 项 Rust/构建资源输入未变，沿用上一片 fmt、clippy 和 439 项通过、3 项既有忽略。
- [候选输入](candidate-source.json)：421 项。[安装前数据核对](before-build.json)：31 条会话、28 个启动配置和原未发字段保持；无运行中的正式应用。

安装复验范围为实际 GLM 同名菜单、同一 Codex 漂移历史弹层，以及 OpenCode 正常恢复弹层。只检查选择入口与说明，不执行登录、确认配置变化或发送新消息。显示修正不代表 GLM 凭据交付或 Codex 模型漂移本身已解决。
