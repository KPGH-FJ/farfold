# 账号操作拒绝原因

本片沿现有认证目标检查保留六类固定原因，使声明格式错误、目标无法核实、解释器入口不支持和程序/脚本不一致能够分别说明；不增加可执行路线、不更改认证来源与工作位置守卫，不输出声明正文、参数或环境值。

正式候选 `26e9592` 已于 2026-10-01 04:55:56 安装，05:02:41 退出。Copilot 显示程序不一致，crow-cli 显示无法确认程序路径，两项登录入口继续禁用；DimCode 标准终端与 Amp 既有终端路线均实际启动并完成普通取消。没有执行新账号授权，也没有验证账号成功。完整范围见[安装结果](installed.md)。

- [实现及受控红绿](backend.md)、[冻结源文件](source-final.json)、[独立审查](review.md)
- [完整 Rust 检查](checks-rust-full.json)：fmt/clippy 通过，446 测试通过、3 项既有忽略。
- [前端检查复用](frontend-checks-reused.json)：前端全部输入未变，复用 1,132 项通过及类型/构建。
- [格式检查](checks-format-stable.json)、[打包](checks-bundle-final.json)：最终通过；[首次格式检查](checks-format-final.json)因同期目录证据 JSON 未格式化失败，原记录保留。
- [422 项候选输入](candidate-source.json)、[安装及签名](candidate-install.json)、[退出核对](after-exit.json)：截至本次退出，原 32 条会话、33 个启动配置、42 项设置摘要和全部原未发字段保持，候选输入未变。
- [协议元数据](protocol-metadata-final.json)：4 个文件，无实际消息请求或协议认证请求；终端启动与取消另由界面、工作位置及进程记录证明。
- [11 个观察到的进程身份](all-observed-processes.json)退出后均未存活；[重复应用删除证明](duplicate-removal.json)保留正式应用。

这次安装验证不覆盖新凭据、完整登录、真实回复或早取消竞态；也不将固定诊断分类当作未经采集的具体命令证据。后续目录测试与源码改动不计入本候选结果。
