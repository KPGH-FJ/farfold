# Copilot 同包登录入口

本片修复已核实官方包的旧登录声明指向同包平台程序、却与登记的 Node 入口不同而被拒绝的问题。仅在唯一受管收据、同版公开清单、精确入口与最近解析位置均匹配时，用原选中的 Node/loader 执行 `login`；不放宽其他路径、参数或环境声明。依据与受控范围见 [backend.md](backend.md)。

`eb075a7` 已于 2026-10-01 06:22–06:27 完成限定安装验证：原登录方法可运行，两个真实登录进程匹配固定预期参数及目录；暂离返回保持同一进程，取消结果可见，最终退出核对七个采样身份结束，原稿与原数据摘要保持。见 [installed.md](installed.md)。账号授权、凭据和首条消息均未验证。

- [完整 Rust 检查](checks-rust-full.json)：fmt/clippy 退出 0，482 项通过、3 项既有忽略；[原日志](rust-full-2.log)。
- [完整格式检查](checks-format-final.json)退出 0；[前端输入核对](frontend-checks-reused.json)确认 307 个输入未变，复用 1,132 项及类型/构建结果。
- [独立审查](review.md)与[作者 8 文件摘要](source-final.json)保留具体范围；[430 个构建输入](candidate-source.json)用于后续安装前后核对。
- [原数据基线](data-before.json)为 33 条会话索引、37 个启动配置、46 项设置；[未发字段](unsent-before.json)仅保留摘要，不复制内容。

受控 SDK/PTY 派发没有调用正式 AppHandle 入口，实际应用结果另见安装记录；两者都不合并成真实账号成功。取消后收起终端仍显示“继续登录”的文案问题已进入下一片，本候选保留该缺口。
