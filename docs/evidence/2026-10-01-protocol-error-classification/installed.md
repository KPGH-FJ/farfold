# 入站固定错误分类：安装验证

`45e054d` 于 2026-10-01 11:59 安装到唯一正式 `/Applications/Farfold.app`，二进制 SHA-256 为 `9c6212b74ffe645bd2b0a3befa17d9a69bd3d4a51beecfea26a5dc0f165ef309`。复制文件摘要一致、签名检查通过，见[安装收据](candidate-install.json)与[445 项输入](candidate-source.json)。[完整 Rust 检查](checks-rust.json)为 535 通过、3 既有忽略，fmt/clippy 通过；[312 前端输入不变](frontend-reuse.json)，复用前片 1,213 项、类型与构建。[格式](checks-format.json)、[打包](checks-bundle.json)及[独立源码审查](review.md)、[导出审查](export-review.md)通过。

## 本次真实结果

仅打开原 VT Code 失败测试历史，界面仍如实显示打开/重连失败，发送禁用，见[截图 01](01-vtcode-original-history.jpg)及[界面文本](01-vtcode-original-history.txt)。本次历史读取期间记录一条入站 `response/error=protocol`，固定类别 `internal_error`，`responseIdNull=false`、`beforeInitializeAccepted=false`，见[读取后元数据](protocol-metadata-history.json)。这只证明本次观察到的错误类别与时点，不含请求 ID 或错误正文，不能独立反推内部原因，也不回填[旧首次请求失败](../2026-10-01-agent-access-directory-batch7/README.md)的错误码或根因。

[预览截图 02](02-incoming-error-preview.jpg)完整显示该记录及三个新增字段；[AX 文本](02-incoming-error-preview.txt)受长文本截断限制，不作为完整逐字证据。[截图 03](03-export-saved.jpg)与[界面文本](03-export-saved.txt)显示本机导出完成。[导出核对](export-verification.json)确认 19,173 字节的 ZIP 副本一致，包含 32 个受限日志文件；`logs/protocol-0.jsonl` 中该记录与本次元数据匹配。本次整理再次核对了 [ZIP](reviewed-diagnostics.zip) 的 SHA-256 与该条记录，不把单条匹配扩大为全部安装预览逐字比对。ZIP SHA-256：`e4952bb1829be9b9c6eb7c58dbe018da958a74417864b5937fe0be43fe908cd1`。

[最终有限元数据](protocol-metadata-final.json)为 2 个当前日志文件：2 次 initialize、1 次自动 session/new、1 次 session/load，**0 prompt、0 authenticate、0 set_config_option**。未输入凭据或调整模型/来源，没有把打开旧历史当作再次短测。随后返回原 Amp 空稿，见[截图 04](04-original-draft-restored.jpg)及[界面文本](04-original-draft-restored.txt)。采集脚本限定完整行与安装至采集时点的记录时间窗，只取当前 `.jsonl`，不包含旋转副本；日志缺项不代表事件未发生。

## 保留与清理

[基线](data-before.json)、[退出前](before-exit.json)和 12:06:36 的[退出后核对](after-exit.json)一致：原 35 条索引、37 个启动配置、46 项设置全部保持，无新索引；原未发字段（草稿、选择、反馈、队列及活动）均未改变。445 项源码输入至退出未变，正式二进制摘要保持。

[累计采样](all-observed-processes.json)包含正式应用、Amp、VT Code 三个 PID＋启动时间身份；退出后均不再存在。此处只证明已采样身份，不声称覆盖所有瞬时子进程。[重复应用删除证明](duplicate-app-cleanup.json)核对四个文件摘要后，仅清理仓库中的重复 bundle，正式应用保留。

本片通过安装版入站有限分类、可见预览、本机导出及原数据保护验证；VT Code 历史仍失败、原首发原因仍未知。下一步在同一正式候选补 OpenCode 实际排队、停止和冷续接，尚未计入本片。账号条件、Autohand 新 CLI 安装确认、Messages 正式云端与全目录同候选验收继续开放。
