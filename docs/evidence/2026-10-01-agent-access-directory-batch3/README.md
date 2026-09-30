# 目录第三批：安装、标准认证终端与失败出口

2026-10-01 02:09–02:24，复用 `423aed4` 正式候选检查 DimCode、Dirac、Qoder、Factory Droid、Qwen。四项安装并连接，Factory Droid 在连接检查完成前退出；本批没有模型请求或账号登录成功。

## 候选与目录

正式应用 `/Applications/Farfold.app` 二进制 SHA-256 为 `457edd0197b33de1972c7b7c56912f5ecb7f14074cb5254894ab983c1874d78a`，本批没有重新安装。[复用收据](candidate-install.json)记录 02:09 起点，[原安装](../2026-10-01-agent-installation-history/candidate-install.json)于 02:00:32 完成复制和签名核对。

工作区同时开发下一片认证声明处理，[开始](before-launch.json)和[退出核对](after-exit.json)明确记录源码变化。因此不声称本批源码冻结一致；结果只属于上述安装二进制。

应用本次刷新后的[目录读取](catalog-readback.json)仍为同一 41 个 ID，没有新增或移除；DimCode 已从首日快照 0.5.15 更新至 0.5.16。[追加目标](catalog-additional-targets.json)显示 Factory Droid 从 0.229.0 更新到 0.230.0，Qwen 仍为 0.24.7。按实际目录与登记版本记录，不套用历史版本；没有修改锁定依赖、外部包或目录条目。

## 实际结果

| 条目          | 安装与连接                                                          | 账号/模型/请求                                                                                                                                               | 证据                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DimCode       | `dimcode@0.5.16` 安装及连接通过；受管 `install-ZRn5lh`              | 自动读取模型要求认证。标准 Terminal 启动及普通取消通过，未输入内容；模型成功、登录、消息和恢复未测                                                           | [登记](dimcode-registration.json)、[01 认证要求](01-dimcode-auth-required.png)、[02 终端启动](02-dimcode-login-started.png)、[03 取消](03-dimcode-login-cancelled.png) |
| Dirac         | `dirac-cli@0.5.17` 安装及连接通过；受管 `install-vRKF11`            | 自动模型读取最终失败；界面保留返回的 `~anthropic/claude-fable-latest`、Medium、Off 字段，但未手选，也不证明该模型可请求。四种账号选项可见未选择，未登录/发送 | [登记](dirac-registration.json)、[04 读取失败](04-dirac-model-read-failed.png)、[菜单观察转录](dirac-auth-options.json)                                                |
| Qoder         | `@qoder-ai/qodercli@0.2.14` 安装及连接通过；受管 `install-u3oLE7`   | 自动模型读取要求认证；`qodercli login` 与 personal access token 两项可见，未选择或执行。模型成功、消息和恢复未测                                             | [登记](qoder-registration.json)、[05 认证要求](05-qoder-auth-required.png)、[菜单](qoder-auth-options.txt)                                                             |
| Factory Droid | 本次目录 `droid@0.230.0` 的连接检查提前结束；没有登记成功候选       | 显示“连接在检查完成前结束，请检查程序后重试”；安装按钮恢复、使用禁用、0 份安装。没有重试或猜测账号原因                                                       | [06 失败](06-factory-install-state.png)、[无登记和目录](factory-failed-registration.json)、[本次目录](catalog-additional-targets.json)                                 |
| Qwen          | `@qwen-code/qwen-code@0.24.7` 安装及连接通过；受管 `install-2DuVcV` | 自动模型读取要求认证；显示已有官方设置终端入口，本轮未打开、未配置或发送。旧版本结果仍保持其历史范围                                                         | [登记](qwen-install-checkpoint.json)、[07 认证要求](07-qwen-auth-required.png)                                                                                         |

DimCode 的[标准声明](dimcode-auth-target.json)追加 `acp --auth-setup`；注册启动已经含 `acp`，实测完整参数是 `node <dim.mjs> acp acp --auth-setup`，其 bun 子进程同样保留两个 `acp`。官方 schema 明确追加到现有启动参数，本轮没有自行去重或改命令。[进程参数](dimcode-launch-targets.json)与[取消后核对](dimcode-after-cancel.json)确认认证父子 `54641/54642` 已结束，原连接 `54273/54274` 及原 Amp 保持。只证明启动/取消，不证明账号设置没有变化或该重复参数下的认证功能成功。

Dirac 的 `session/new` 响应成功后有模型字段，但最终读取失败，原因保持未知；没有用固定提示猜测登录、额度或关闭协议故障。[包内官方接口静态核对](dirac-static.md)确认标准关闭接口存在，不能据此推断本次失败原因。原始协议正文、用户配置和秘密未读取。账号菜单的第一次文件捕获未含弹出选项，[页面文本](dirac-auth-page.txt)仅保留页面；四项来自工具实际返回菜单的独立文字转录，不冒充截图或原始 AX 文件。

## 原数据与进程

[操作前](data-before.json)为 29 条会话索引、16 个 Agent、25 项设置；[退出后](after-exit.json)原索引所核字段、16 个启动配置字段与全部原未发字段均保持，无新会话。新增 DimCode、Dirac、Qoder、Qwen 四项登记，共 20 个 Agent；只改安装/准备设置并新增四项 `installPrevious.*`，见[计数](batch-counts.json)。Auggie 待确认副本本批没有操作，原 Amp 空稿已返回，见[08 原稿](08-original-draft.png)。此核对不扩大为外部配置或凭据全面审计。

[协议元数据](protocol-metadata-final.json)共 10 个文件、10 次 initialize、5 次 session/new、0 次 prompt。Factory 未收到成功握手；其余成功连接与请求能力仍分开。工作目录观察没有读取进程环境，见各 `cwd-*.json`。

[累计观察](all-observed-processes.json)的 30 个具体进程身份退出后均结束；仅限已采到的身份，不声称覆盖所有瞬时子进程。正式候选的重复应用删除证明沿用[原安装片](../2026-10-01-agent-installation-history/duplicate-cleanup.json)，本批没有重新打包或再次删除。

## 未完成

上述五项均未完成登录成功、首条请求成功或历史续答。Factory 的精确启动故障、Dirac 的模型读取失败、DimCode/Qoder/Qwen 的认证条件继续开放。下一片处理认证声明保真和目标目录隔离，不能把它计为环境 Key 已可配置或本批失败已修复。覆盖汇总见[41 条索引](coverage.md)，最终同候选全目录和完整 J1–J6 尚未完成。
