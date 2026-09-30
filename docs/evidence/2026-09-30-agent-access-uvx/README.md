# uvx 安装与请求认证恢复

日期：2026-09-30。源码候选 `85235cd` 已通过工程检查，362 个输入文件已冻结，17:58:44 替换唯一正式应用；本候选实测已结束，存在下列失败，不代表 uvx 接入或全目录可用。

## 本批范围

- uvx：继承官方目录的包、参数和环境声明，显式准备 uv/Python 后安装持久受管程序，复用安装取消、候选检查和选用；[官方来源与边界](../2026-09-30-agent-access-mechanisms/uvx/README.md)。
- 通用准备界面分别处理安装依赖与使用依赖；[前端接口与受控验证](frontend.md)。
- 修复上一安装候选的真实 Amp 反例：`session/new` 可成功但 `session/prompt` 仍要求认证。模型读取不能清除真实请求失败；[安装反例及红/绿回归](../2026-09-30-agent-access-mechanisms/auth-model-read.md#安装反例与后续修正)。

认证状态仍由同一来源和目录入口管理，仅区分失败发生于会话创建还是实际请求；不新增持久化账本。用户可以重读模型，并主动发送短消息确认请求是否恢复。登录提示与使用门槛在对应成功证据前保留，不自动请求、不改原模型、不替用户写账号配置。

## 官方运行工具来源

以下固定版本只用于 Farfold 显式安装的通用工具；已有工具仍按实际检测复用，Agent 版本仍来自目录，不增加 Agent 身份摘要准入。调查日期均为 2026-09-30，下载成功与这些来源事实分开验证。

| 工具                                     | 发行与官方来源                                                                                                                                                                                                            | 本候选固定下载归档 SHA256                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| uv 0.12.18 / macOS arm64                 | [2026-09-22 release](https://github.com/astral-sh/uv/releases/tag/0.12.18)，[资产摘要](https://github.com/astral-sh/uv/releases/expanded_assets/0.12.18)                                                                  | `cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b` |
| CPython 3.12.13 / 20260807 / macOS arm64 | [20260807 release](https://github.com/astral-sh/python-build-standalone/releases/tag/20260807)，[uv 0.12.18 冻结下载清单](https://raw.githubusercontent.com/astral-sh/uv/0.12.18/crates/uv-python/download-metadata.json) | `25baa97c65b3f0aa90e21131b4f9e80aef8899e8144006db8a9d2c1ab9e807e3` |

下载 URL 分别为 [uv 官方归档](https://github.com/astral-sh/uv/releases/download/0.12.18/uv-aarch64-apple-darwin.tar.gz) 和 [Python 官方归档](https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-aarch64-apple-darwin-install_only_stripped.tar.gz)。两者发布均超过七天；源码记录固定 URL、压缩/展开大小限制和归档摘要，未经校验不展开执行。

复用已有 uv 的安装工具基线为 0.2.37：该版 [官方 CLI 源码](https://raw.githubusercontent.com/astral-sh/uv/0.2.37/crates/uv-cli/src/lib.rs)明确提供本实现使用的 `--no-config` 与 `--no-python-downloads`。低于该基线的 PATH 工具不会遮住受管候选，也不会被自动升级。这个条件属于安装工具的已支持接口，不是 Agent 的兼容性或版本白名单；具体包和解释器组合仍须实际安装验证。

官方目录当前两个 uvx 声明分别为 `fast-agent-acp==0.10.1 -x` 和 `minion-code@0.1.44 acp`。后者按 uv 官方具名包语义转换为安装 requirement `minion-code==0.1.44`；参数/环境读取实际目录，不能由脱敏快照重建。安装后的 console-script 必须在该包的真实元数据中存在，且实际路径留在候选内。详情与官方包声明出处见上一批 [uvx 调查](../2026-09-30-agent-access-mechanisms/uvx/README.md)。

## 当前证据

`checks-final-frontend.json` 记录类型检查、114 文件 / 907 项前端测试和前端打包通过。包括会话/请求认证分层与实际准备控制器回归；认证成功来自受控事件，不能称为真实账号成功。

`checks-final-rust.json` 记录 Rust 格式、clippy 和 286 项测试通过，3 项既有手动测试忽略；`checks-final-format-verified.json` 记录仓库格式检查通过。此前格式失败保留在原日志中，修正仅涉及测试排版。[独立审查](review.md)的三处安装隔离问题已修复并加入回归。

`data-before.json` / `unsent-before.json` 固定本批前 22 条会话索引、7 个启动配置、16 项设置和原未发字段摘要；不存秘密或原稿正文。上一候选已正常退出，正式应用保留，精确重复应用已移除。后端检查、正式候选身份、安装旅程、失败条件和删除证明在执行后补入。

## 安装版实测

候选 SHA256 `fbf8723a7b06ba6004d82d6cf8292d9c3bb3ed488fa29ab6b4273b0553551fb1`；`candidate-install.json` 记录签名通过、全部安装文件与打包文件一致。以下结果只属于此候选。

| 操作                   | 结果                                                     | 证据与边界                                                                                                                              |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 打开 fast-agent 准备页 | 缺少 uv 与 Python，Agent 安装按钮禁用                    | [01](01-missing-tools.png)；未要求账号或创建会话                                                                                        |
| 下载 uv 后主动取消     | 取消完成，可重试                                         | [02](02-tool-cancelled.png)、after-tool-cancel.json；原会话/Agent/未发字段摘要不变，准备页进度设置更新                                  |
| 重试 uv，再安装 Python | 两项成功，分别显示 0.12.18 / 3.12.13，Agent 安装按钮开放 | [03](03-tools-ready.png)、installed-tools.json；安全版本命令均退出 0，未升级日常程序                                                    |
| 安装 fast-agent        | 包准备进入连接检查后失败，界面保留重试；尚未注册选用     | [04](04-fast-agent-connection-failed.png)、after-fast-failure.json；原因待查，原 22 条会话、7 个 Agent、未发字段不变，已有 Amp 进程保留 |

Minion Code 复用这两个已备工具，包准备后的连接检查同样失败，未注册选用，见 [05](05-minion-connection-failed.png)。两者都未进入模型读取、登录或首条请求；失败原因调查分开记录，不用其中一个的结果替代另一个。

Amp 沿用已有设置 / Medium，模型读取成功后由用户操作显式发送固定短消息，创建测试 `S-munxx8x9-rugtjo`，实际结果为认证要求。重查连接将原 PID 67052 替换为 67715，但模型重读持续禁用，关闭准备再进入也未解除，见 [06](06-amp-recheck-still-busy.png)。源码定位为已明确失败的测试在正常旧连接关闭时，被准备控制器误标为“结果未知”；登录要求仍保留，完整恢复路径未通过。没有输入密钥或完成登录。

18:11 正常退出，`validation-exit.json` 记录原 22 条会话索引、7 个 Agent 配置、原未发字段摘要均保留，仅增加本次一条 Amp 短测；设置变化限准备进度与新增短测的未发工作信息。两个跟踪进程全部结束，362 个冻结文件仍一致。`duplicate-removal.json` 记录仅移除精确打包副本，正式应用保留且摘要不变。

## 下一步

在独立修复候选中补已结算测试重查的回归与实际安装复验，保留真正未结算请求的保护；继续核实两条 uvx 的精确启动失败。工具安装通过不关闭 uvx 接入、账号成功、全目录或完整 J1–J6 缺口。
