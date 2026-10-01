# VT Code 0.96.14 发行归档：只读静态核对

结论：**尚未发现有证据可直接修复的 Farfold 映射、缓存或分发错误；真实请求失败原因仍未知。** 官方目录指定归档的结构与 arm64 入口正确，静态内容与现场自报 `0.96.12`、空认证表相容；当前 tag 源码的五项认证声明不应直接替补到已装程序。归档与 tag 的确切构建对应关系仍待官方构建证据确认。

本次只读公开目录记录、发行清单、固定源码和已有公开登记；另下载一次官方归档到唯一 `farfold-vtcode-release-static-*` 临时目录，只在内存分析 tar 成员与固定字串。没有提取成员到文件、执行内容、运行 Agent/请求/登录/安装/Cargo、读取用户凭据或配置、修改产品源码。临时目录精确清理后存在性检查为 false。安装事实仍属于 [batch7](README.md) 的 `26e9592`，本次不是新安装验收。

## 目录、发行与入口

[catalog-targets.json](catalog-targets.json) 的 `registry:vtcode` 固定记录为：版本 `0.96.14`，`darwin-aarch64` 地址为[官方归档](https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-aarch64-apple-darwin.tar.gz)，`cmd=./vtcode`、`args=[acp]`，公开目录环境声明为 `VT_ACP_ENABLED=1` / `VT_ACP_ZED_ENABLED=1`，目录 `sha256=null`。[既有公开登记](vtcode-registration.json)的受管根与 `vtcode` 入口、`[acp]` 参数一致，目录版本为 `0.96.14`，initialize 自报 `vtcode / Zed / 0.96.12`、认证表为空。

2026-10-01 对[官方 release API](https://api.github.com/repos/vinhnx/VTCode/releases/tags/0.96.14)的有界读取退出 0，19972 字节、完整 JSON 解析成功；[tag ref API](https://api.github.com/repos/vinhnx/VTCode/git/ref/tags/0.96.14)退出 0，370 字节、解析成功。

| 公开发行字段                 | 核对结果                                                                  |
| ---------------------------- | ------------------------------------------------------------------------- |
| release ID / tag             | `305195564` / `0.96.14`                                                   |
| tag 当前指向                 | `5a065448d4febf4933b944f65f3561101444dac4`                                |
| release created / published  | `2026-04-04T01:39:44Z` / `2026-04-04T08:02:01Z`                           |
| arm64 归档 created / updated | `2026-04-04T01:26:04Z` / `2026-04-04T01:26:22Z`                           |
| arm64 归档大小               | `22644217` 字节                                                           |
| arm64 资产公开 digest        | `sha256:a648bd325977f90ee140d7dd90b8aed62a7b59ff7cbf464069515daf1f58bd7f` |
| draft / prerelease           | 均为 false                                                                |

公开 digest 是 release API 元数据，本次未把它加入产品校验或用作 Agent 兼容性判据。下载使用 HTTPS 限定重定向、50 秒期限与 32 MiB 上限，curl 退出 0，实际 `22644217` 字节与发行清单一致。

tar 共 10 项：唯一可执行入口 `vtcode`，大小 `41302256`、mode `0755`；另有 `ghostty-vt/` 下三个 dylib 与 AppleDouble 元数据。没有符号链接或硬链接。入口 Mach-O magic 为 `cffaedfe`、CPU type 为 `0x0100000c`（ARM64）。目录没有误指另一个包装入口或 x86_64 资产的静态迹象；这里没有核对当前安装文件的字节身份。

## 版本与五项认证声明差异

1. 固定 [5a065448 Cargo.toml](https://raw.githubusercontent.com/vinhnx/VTCode/5a065448d4febf4933b944f65f3561101444dac4/Cargo.toml) 的 package/workspace 版本均为 `0.96.12`。[helpers.rs](https://raw.githubusercontent.com/vinhnx/VTCode/5a065448d4febf4933b944f65f3561101444dac4/vtcode-acp/src/zed/helpers.rs) 以 `CARGO_PKG_VERSION` 产生 agentInfo；因此归档名 `0.96.14` 和自报 `0.96.12` 不能单独证明 Farfold 装错包。
2. 当前固定 [handlers.rs](https://raw.githubusercontent.com/vinhnx/VTCode/5a065448d4febf4933b944f65f3561101444dac4/vtcode-acp/src/zed/agent/handlers.rs) 的 initialize 无条件构造五个 ID：`oauth-openai`、`oauth-openrouter`、`terminal-login`、`env-api-keys`、`env-base-urls`。其 authenticate 仍直接返回空成功，声明不等于实际账号授权完成。[0.96.12 handlers.rs](https://raw.githubusercontent.com/vinhnx/VTCode/0.96.12/vtcode-acp/src/zed/agent/handlers.rs) 的 initialize 没有这组声明。
3. 本次归档入口中，精确 `0.96.12` 字串计数为 4，`0.96.14` 为 0；上述五个 ID 各为 0。统计只检查这些固定公开字串，没有输出其他二进制文本。**缺少字串是静态线索，不是完整反编译或握手结果，也不能证明精确构建提交**；编译优化/构建差异仍须考虑。
4. 固定 [release.yml](https://raw.githubusercontent.com/vinhnx/VTCode/5a065448d4febf4933b944f65f3561101444dac4/.github/workflows/release.yml) 的 macOS job 使用 checkout，但没有指定输入 tag 为 ref；输入 tag 用于命名归档和发布。该文件允许发行名与实际 checkout 分离，但本次没有取得产生此资产的具体 workflow run/head SHA，不能据此断言当次用了错误 ref。资产上传时间早于 release 的 created 时间也不证明构建提交。

读取 commit/文件历史 API 曾连续遇 curl 56，包括一次有界重试，未取得可解析内容；不把该失败写成不存在历史记录。公开 [tag commit 页面](https://github.com/vinhnx/VTCode/commit/5a065448d4febf4933b944f65f3561101444dac4) 可读，但不足以建立资产的构建 provenance。

## Farfold 路径核对与下一步

- [agent_install.rs](../../../src-tauri/src/agent_install.rs) 的二进制路线直接使用冻结的 `darwin-aarch64` archive/cmd/args，解包全部归档并验证所选入口位于候选根；AgentRow 的 version 保存目录版本，handshake 的 agentInfo 自报独立保存。两个版本字段本来就允许不同，不能通过重写自报版本制造一致。
- `26e9592` 与当前 [handshake.rs](../../../src-tauri/src/acp_client/handshake.rs) 都在 SDK typed 解码前收取认证表；这五项 ID/name 合法，环境方式也会保留公开变量名。静态没有发现会把这五项有效声明整表删空的路径。已有快照不是原始 wire，仍不能独立证明现场在进入 mapper 前就为空。
- 官方归档没有明显错误入口/架构，静态字串与现场空表相容，所以目前优先保留**官方资产与当前 tag 的构建关系未确认**。不按 tag 源码补认证方法、不改目录版本、不改 argv、不给未知方法制造可执行路线。
- 最小后续验证是一次受控、无 prompt 的 initialize-only：沿现已选官方目标和真实目录/来源，在映射前后仅对比公开认证 ID/count/type 与 agentInfo，确认空表来自程序还是本地转换；保留当前配置、模型与账号，原始 body 不落盘。若当前观测设施不能在不扩大日志范围的情况下做这个对比，先用固定五声明的受控 fixture 验证 mapper，再向官方核对资产对应的 workflow/head SHA；此文不授权或执行该验证。
- [原只读诊断](read-only-diagnosis.md)中的唯一真实 prompt 失败仍无法由发行差异解释。若继续真实重试，只保留匹配该回复的有限协议错误类别与阶段，不读取或输出 message/data/stderr，不猜 Key、模型、网络或版本；失败仍保留原稿、队列、来源和明确重试出口。

本次只补公开发行与静态分发证据；首发失败、登录/续接未测的既有结论保持，未新增任何真实旅程通过项。
