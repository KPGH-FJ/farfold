# 第 9 周期 Windows 安装脚本与交叉检查

在 macOS 上用 PowerShell 7.4.22 解析完整安装验证脚本，解析错误为 0。直接从其语法树运行 `Plain-Path`，普通中文及空格路径、未创建路径和根目录通过，符号链接祖先下的现有和未创建文件均被拒绝。同轮在 macOS 上测试 Python 启动控制器，3 个命令参数正例、6 个拒绝例和 6 个进程账目判断例通过。安装器、应用和子进程均未启动，也未调用 Windows API。

基于 `975f1c7ec63d5523333ccaace822177e459c848f` 及当时工作区改动，在 macOS 对 `x86_64-pc-windows-gnullvm` 目标执行锁定依赖、包含所有目标的严格 Clippy 检查，耗时 72.417 秒，退出码 101。日志记录 Windows 库编译中的网页共享入口未使用及错误回退写法，以及测试模块声明位置、枚举命名等告警。原始日志的摘要和执行回执一致。

Windows 实际安装、升级、卸载以及数据和凭据保留仍待实机验收。

本机原件 `output/2026-11-15-cycle9-installer/README.md`、`output/2026-11-15-cycle9-windows/cross-clippy.json`、`output/2026-11-15-cycle9-windows/cross-clippy.log`。
