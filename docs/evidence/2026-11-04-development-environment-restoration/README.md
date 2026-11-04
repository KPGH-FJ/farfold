# 2026-11-04 开发环境恢复与工程检查

本次已恢复当前机器的 macOS arm64 开发环境，完整七项工程检查全部自然退出 0。用户本次授权仅覆盖环境恢复和检查，产品开发、Windows候选实际执行与真实Agent验证继续暂停。

起点为 `8e4c9da08` 及原有未提交候选，文件基线见 [baseline.json](baseline.json)，完整结果见 [result.json](result.json)。正式应用仍对应 `168db42e5`，本次没有替换或启动它。

| 检查                                                                        | 实际结果                                     |
| --------------------------------------------------------------------------- | -------------------------------------------- |
| `corepack pnpm format:check`                                                | 最终通过；首次六份原始清理回执的格式失败保留 |
| `corepack pnpm typecheck`                                                   | 通过                                         |
| `corepack pnpm test`                                                        | 704 个文件，9450 项通过                      |
| `corepack pnpm build`                                                       | 通过                                         |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml`                    | 通过                                         |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings` | 通过                                         |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked`                  | 2335 项通过、6 项既有忽略、0 失败            |

额外执行 `cargo build --manifest-path src-tauri/Cargo.toml --locked` 成功，生成 arm64 开发可执行文件。Vite开发服务器实际启动，页面和 `/src/main.tsx` 均返回HTTP 200，随后关闭并核实1420端口释放；未启动桌面应用或真实Agent。

恢复使用 Node 22.22.3、pnpm 9.15.0、Rust/Cargo 1.96.0，依赖分别通过 `pnpm install --frozen-lockfile`、`cargo fetch --locked` 恢复。当前为 macOS 27.0、Apple M6、16 GiB内存，现有Command Line Tools和SDK 15.5已完成本项目编译，无需为本次检查补装完整Xcode。Tauri info仍提示完整Xcode缺失，以及当前源码未使用的JS插件配对包；不将该诊断说成全部绿色。Windows交叉工具链载荷仍在项目内，可按绝对路径调用，本次未做Windows交叉编译或实际执行。

格式修复仅为六份已有清理回执补入精确的 `.prettierignore` 路径；没有忽略整个目录，也没有改写原件。2260份所列源码和锁文件、原Windows候选、新测试与六份原始回执的内容摘要保持；正式应用主程序摘要保持。详见 [preservation.json](preservation.json) 与 [raw-receipts-before.json](raw-receipts-before.json)。这些核对不构成原子快照或运行中用户数据的字节不变证明。

七项逐项命令、自然退出码、耗时和日志位置保存在 `checks/`。本机检查不替代Windows实际执行、真实Agent、完整产品界面、长期资源或29家八项验收。既有Windows全量17项失败和四条新增未执行测试保持开放。

原始检查日志逐字节保存在 [raw-check-logs.zip](raw-check-logs.zip)，对应摘要见 [raw-check-logs.json](raw-check-logs.json)。本地单独日志保持原样；不为格式检查改写命令输出。
