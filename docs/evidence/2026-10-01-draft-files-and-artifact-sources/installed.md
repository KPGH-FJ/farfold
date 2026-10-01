# 新稿文件查找与产物来源：安装验证

2026-10-01 13:01–13:12，正式 `/Applications/Farfold.app`，源码 `350643f`（含 `091304c`），二进制 `b529957d20e9f83a47a24fb9ca4c15eb4d2e6a807bbbceaaf83767baa924e9f9`。[安装收据](candidate-install.json)确认 4 个文件匹配、签名检查通过；[446 项构建输入](candidate-source.json)至最终退出保持。

已测成功：

- 新 OpenCode 草稿选择自有 [work-area](work-area/draft-proof.txt) 后，仍显示“正在创建会话”且发送禁用时，`@` 已列出并能添加文件，见 [02 截图](02-files-before-connection.jpg) / [AX](02-files-before-connection.txt)、[03 截图](03-unsent-file-before-connection.jpg) / [AX](03-unsent-file-before-connection.txt)。这是实际预览准备完成前的新稿入口，不据此判断 initialize 尚未完成；旧候选预查只覆盖已连接 Amp，不称为安装前失败复现。
- 离开再返回，[文字与附件保持](04-returned-file-draft.jpg)。[原模型选择](05-original-opencode-model.txt)为 Nemotron 3 Ultra Free，沿用已有设置；没有选择不同模型。正常退出再开，[恢复原稿并要求核对附件](06-cold-recovered-file-draft.jpg)；明确保留附件后，[核对成功、发送可用](07-cold-attachment-reviewed.jpg)。全程未点击发送。
- 打开前片真实 OpenCode 文件修改历史，`after → final` 差异下同时显示“Agent 报告的内容不代表文件当前状态”及片段行号说明，见 [01 截图](01-installed-artifact-provenance.jpg) / [AX](01-installed-artifact-provenance.txt)。拟写入内容来源分支本片只由组件测试覆盖，不计真实 Agent 输入分支验收。
- 最后通过 UI 清除仅本轮加入的未发测试文字、附件与文件夹，恢复[原 Amp / 已有设置普通空稿](08-original-empty-draft-restored.jpg)。操作时观察到模型弹层 Medium 已选（仅当次工具回执，未另存截图）；最终 JSON 核对原选择已恢复，没有切换模型。

[协议计数](protocol-counts.json)按安装时间分离前查与新候选；[有限元数据](protocol-metadata-final.json)内全窗口 0 prompt、0 authenticate、0 cancel。新候选有 7 initialize、6 session/new、1 session/load，配置设置用于恢复已选值；不以零 prompt 声称没有建立预览连接。冷草稿另有 [8 秒进程与目录采样](cold-draft-processes.json)。

[最终保护核对](after-exit.json)：原 36 条索引、37 个启动配置、46 项设置及全部原未发字段保持，无新索引；[12 个采样身份](all-observed-processes.json)至正常退出均结束（包括旧候选前查的 3 个）。[重复应用精确清理](duplicate-app-cleanup.json)前核对 4 文件一致，正式应用保持。测试文件未发送，作为本片证据保留。

工程检查见[实现记录](implementation.md)：前端 138 文件 1,229 项、类型、构建通过；133 个后端输入不变，复用 535 Rust、3 项既有忽略及 fmt/clippy。两处旧证据 JSON 仅格式修正后，[格式](checks-format-final.json)与[打包](checks-bundle.json)通过。两项源码均经独立审查。

本片只计新稿文件准备、导航/冷恢复及已有产物来源显示的有限通过。旧仓库目录初始化超时原因仍未知，本次目录成功不构成根因修复。Messages 云端、Autohand 新 CLI 安装确认、其余真实账号/首发/续接与最终同候选完整验收仍开放。
