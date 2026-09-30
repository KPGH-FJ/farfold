# Copilot 同包登录入口

本片修复已核实官方包的旧登录声明指向同包平台程序、却与登记的 Node 入口不同而被拒绝的问题。仅在唯一受管收据、同版公开清单、精确入口与最近解析位置均匹配时，用原选中的 Node/loader 执行 `login`；不放宽其他路径、参数或环境声明。依据与受控范围见 [backend.md](backend.md)。

当前源码已冻结并完成完整工程检查，尚未写入安装验收成功。真实登录、凭据和首条消息均未验证；下一步在正式应用检查登录启动、暂离、取消、原稿与退出。

- [完整 Rust 检查](checks-rust-full.json)：fmt/clippy 退出 0，482 项通过、3 项既有忽略；[原日志](rust-full-2.log)。
- [完整格式检查](checks-format-final.json)退出 0；[前端输入核对](frontend-checks-reused.json)确认 307 个输入未变，复用 1,132 项及类型/构建结果。
- [独立审查](review.md)与[作者 8 文件摘要](source-final.json)保留具体范围；[430 个构建输入](candidate-source.json)用于后续安装前后核对。
- [原数据基线](data-before.json)为 33 条会话索引、37 个启动配置、46 项设置；[未发字段](unsent-before.json)仅保留摘要，不复制内容。

测试记录不合并成真实账号成功；受控 SDK/PTY 派发没有调用正式 AppHandle 入口，实际应用仍须单独验证。
