# 余下目录条目：只读准备材料

核对：2026-10-01 03:38（UTC+8）。本文件仅汇总候选顺序与静态分发事实，不是活动计划，也没有安装、运行、登录、发送请求或修改用户配置。

## 集合与版本边界

[第三批覆盖表](../2026-10-01-agent-access-directory-batch3/coverage.md)中尚无安装执行结果的 19 个 ID，减去第四批实际尝试的 `glm-acp-agent`、`grok-build`、`minimax-code`、`nova`、`sigit`，剩 **14 个唯一 ID**。这里按“是否已有安装执行结果”计数：Grok 失败也已测，不把它或 Factory、Minion 的失败算回这 14 个。第四批[目标快照](catalog-targets.json)、[计数](batch-counts.json)另保留 5 次尝试与 4 条新登记的差别。

读取的是正式应用现有 `registry-cache.json`，来源 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，`fetchedAt=1790795794427`（2026-10-01 03:16:34.427 UTC+8），仍为相同 41 个 ID；与[第四批目标收据](catalog-targets.json)的获取时间一致。本次没有触发目录刷新。当前缓存 SHA-256：`c115f0762fe590d9f3dfa8790dba081086494606b6600514e9b3dc7ebcd608cf`；只读取公开目录，未读 Agent 凭据或外部配置。下表保留本次读到的精确版本/命令，不采用 09-30 初表旧版本。此缓存会被后续刷新覆盖，因此执行时仍要记录当次实际目录对象。

## 建议顺序与安装落点

建议先做前 5 项：唯一剩余 npx、两个 ZIP 特殊入口，再核带版本目录/资源目录的 tar.gz；其后按余下目录 ID 顺序。这个顺序基于分发结构覆盖，**不表示更可能免账号成功**。其余 13 项均是目录 `darwin-aarch64` 二进制路线：2 个 ZIP、11 个 tar.gz；没有剩余 uvx 条目。所有项目的本机账号、模型、首发和恢复条件仍未知。

| 顺序 / ID / 版本               | 本次目录分发                                                                                                                                                    | 精确入口与附加参数                                                          | 依赖线索与下一观察点                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1. `github-copilot-cli` 1.0.89 | npx `@github/copilot@1.0.89`                                                                                                                                    | 包声明入口；`["--acp"]`                                                     | 复用受管 Node/npm；本轮未读取 1.0.89 的包清单，最低 Node 版本未知。官方当前说明要求可用 Copilot 资格/组织许可，本机资格未知。 |
| 2. `antigravity-acp` 1.2.1     | [ZIP](https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip)                                                                | `./agy_acp_server.par`；`[]`                                                | `.par` 是目录的可执行入口；不能仅凭后缀推定需要系统 Python。官方当前文档列 Google 账号浏览器授权；固定版本声明/本机认证未知。 |
| 3. `junie` 3419.24.0           | [ZIP](https://github.com/JetBrains/junie-acp-release/releases/download/3419.24/junie-release-3419.24-macos-aarch64.zip)                                         | `./Applications/junie.app/Contents/MacOS/junie`；`["--acp=true"]`           | 入口位于归档内 `.app/Contents/MacOS`，需保留完整目录/资源；是否含或另需 Java 未核实，不预先安装 Java。                        |
| 4. `cortex-code` 1.0.73        | [tar.gz](https://sfc-repo.snowflakecomputing.com/cortex-code-cli/a4643c4278/1.0.73%2B180523.e6179a031de9/coco-1.0.73%2B180523.e6179a031de9-darwin-arm64.tar.gz) | `./coco-1.0.73+180523.e6179a031de9-darwin-arm64/cortex`；`["acp", "serve"]` | 带 `+` 的版本子目录及 URL `%2B` 需按声明保留；官方当前文档有 Snowflake 账号/权限条件，固定版本声明与本机条件未知。            |
| 5. `cursor` 2026.09.28         | [tar.gz](https://downloads.cursor.com/lab/2026.09.28-64d2043/darwin/arm64/agent-cli-package.tar.gz)                                                             | `./dist-package/cursor-agent`；`["acp"]`                                    | 归档内 `dist-package`，伴随资源/运行库是否自包含未核；不因同名桌面产品已装而推定 CLI 已登录。                                 |
| 6. `devin` 3000.11.3           | [tar.gz](https://static.devin.ai/cli/3000.11.3/devin-3000.11.3-aarch64-apple-darwin.tar.gz)                                                                     | `./bin/devin`；`["acp"]`                                                    | 归档内 `bin`；动态库/伴随程序和账号条件尚未核实，不借用桌面 Devin 的登录成功声明。                                            |
| 7. `corust-agent` 0.6.0        | [tar.gz](https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-darwin-arm64.tar.gz)                                                  | `./corust-agent-acp`；`[]`                                                  | 顶层专用入口；目录未声明外部运行依赖，实际是否自包含/需账号未知。                                                             |
| 8. `crow-cli` 0.1.24           | [tar.gz](https://github.com/crow-cli/crow-cli/releases/download/v0.1.24/crow-cli-darwin-aarch64.tar.gz)                                                         | `./crow-cli`；`["acp"]`                                                     | 顶层入口；目录未声明外部运行依赖，已有服务/模型设置是否必需未知。                                                             |
| 9. `harn` 0.10.151             | [tar.gz](https://github.com/burin-labs/harn/releases/download/v0.10.151/harn-aarch64-apple-darwin.tar.gz)                                                       | `./harn`；`["serve", "acp"]`                                                | 目录给归档 SHA-256；描述涉及 `.harn` pipeline，但未证明默认启动要求用户项目文件，不能自行生成文件。                           |
| 10. `kimchi` 1.3.0             | [tar.gz](https://github.com/getkimchi/kimchi/releases/download/v1.3.0/kimchi_darwin_arm64.tar.gz)                                                               | `./bin/kimchi`；`["--mode", "acp"]`                                         | 目录给归档 SHA-256，入口在 `bin`；多模型描述不能代替实际配置/账号声明。                                                       |
| 11. `mistral-vibe` 2.25.8      | [tar.gz](https://github.com/mistralai/mistral-vibe/releases/download/v2.25.8/vibe-acp-darwin-aarch64-2.25.8.tar.gz)                                             | `./vibe-acp`；`[]`                                                          | 采用目录的二进制路线，不改成 uvx；目录给归档 SHA-256，是否自带 Python/依赖以及服务条件未知。                                  |
| 12. `poolside` 1.0.16          | [tar.gz](https://downloads.poolside.ai/pool/v1.0.16/pool-darwin-arm64.tar.gz)                                                                                   | `./pool-darwin-arm64`；`["acp"]`                                            | 目录给归档 SHA-256；账号/组织资格及是否有额外运行依赖未知。                                                                   |
| 13. `stakpak` 0.3.88           | [tar.gz](https://github.com/stakpak/agent/releases/download/v0.3.88/stakpak-darwin-aarch64.tar.gz)                                                              | `./stakpak`；`["acp"]`                                                      | 目录未声明外部运行依赖；实际服务配置、账号/工具条件未知。                                                                     |
| 14. `vtcode` 0.96.14           | [tar.gz](https://github.com/vinhnx/VTCode/releases/download/0.96.14/vtcode-0.96.14-aarch64-apple-darwin.tar.gz)                                                 | `./vtcode`；`["acp"]`                                                       | 保留目录变量 `VT_ACP_ENABLED`、`VT_ACP_ZED_ENABLED`；只核变量名，不在此复制值。服务/伴随工具条件未知。                        |

## 账号与依赖资料的限度

仅补读了几个已有目录链接指向的官方页面，没有重新研究全部 14 项：

- [Copilot 官方仓库](https://github.com/github/copilot-cli#prerequisites)列出订阅与组织策略限制，以及未登录时的登录入口。当前 README 不是 1.0.89 的完整启动源码；未据此断言 ACP initialize 是否要求账号。精确版本 npm 元数据通过网页工具读取失败，故不填写猜测的 engines/bin。
- [Antigravity 官方说明](https://antigravity.google/docs/ide/extensions#authentication--licensing)列个人 Google 账号浏览器授权和企业身份路线。文档描述当前产品，不证明 1.2.1 的实际 authMethods，更不能推断其沿用本机 Gemini 认证。
- [Junie 官方发行仓库](https://github.com/JetBrains/junie-acp-release)未在本次可读页面中确认 Java 或账号前置条件；保持未知。没有下载 ZIP 来推测可执行文件或资源布局是否完整。
- [Snowflake 官方说明](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code)说明 CLI 连接 Snowflake 账号并受相应权限条件约束。该当前页面不是目录 1.0.73 的逐版本声明；没有读取本机 Snowflake 设置或替用户配置连接。

“目录没有声明依赖”不等于“没有依赖”。除 npx 的现有 Node/npm 安装链外，表中均未验证额外解释器/动态库/伴随 CLI；不得从名称或文件扩展名自动安装另一程序。安装后管理页可能自动 `session/new`，实际记录应区分握手、模型读取、认证、真实首发和恢复；不能把进入账号页或出现模型清单写成全流程通过。新日志/现场若显示启动失败，保留失败与旧目标，按真实公开错误继续定位，不预先补配置、换模型或输入新凭据。
