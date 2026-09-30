# M6 后端：版本诊断与未选程序候选

本记录覆盖后端源码、公开官方字段与自有临时目录中的定向回归。真实安装、选用、回选、首发与续接由本目录主记录另外验收；本记录不能替代安装版旅程结果。未启动实际 Agent、认证、对话或修改外部 Agent 配置，也未升级日常 Pi。

## 实现边界

- `acp_client/recipes.rs` 将既有 Amp 程序依赖迁为接入层声明，并增加 Pi 样本。匹配先检查注册来源及官方启动形状，再读取组件公开包清单。不是只凭 Agent ID 匹配；同名自定义命令不会取得官方组件补充。Amp 官方二进制记录的组件版本未知时仍保留原依赖行为。
- Pi `>=0.81.0` 要求仅用于已核对的 `pi-acp 0.0.34`。组件版本或启动形状不匹配时不泛化该范围，诊断为未知，停止使用该条版本补充。低于要求或版本命令无法给出可核对版本，都允许继续尝试真实连接；兼容性仍由 `initialize` 判断。
- 准备返回实际程序版本、组件版本、带出处的要求与满足/不满足/未知。显式重查可绕过缓存；Pi 的版本诊断每次重新观察实际程序。找到可执行程序但版本检查失败时说明“版本暂时无法核对；仍可尝试连接”，不会称检查通过。账号、模型与回复是否可用仍单独验证。
- `agent_dependency_install` 的 `prepare_candidate` 在自有安装目录准备一个未选程序，通过既有 `installations.v1` 收据保存；不改变注册命令、程序环境、当前连接或会话。默认 `install_missing` 保留原入口语义。候选准备失败或提交前取消只回收自己的临时目录；保存开始后的取消不能撤销已提交结果。
- 正式选用仍走既有空闲/配置保护与真实连接检查。程序候选只替换已有声明的程序环境；校验当前组件与候选的实际 Node/入口，不因历史收据中的旧组件后来被合法移除而误拒选用。既有程序保留，可从原清单回选。
- 没有增加第二个执行循环或新账本。候选启动文件只是固定 Node 与官方程序入口的 `exec ... "$@"` 转发，保留工作目录及继承环境；不会建立私有 HOME。候选收据中的版本和发布字段是安装来源与安全检查依据，不成为任意 Agent 的连接版本白名单。

## 官方来源与版本选择

Pi 组件要求来自 [pi-acp v0.0.34 README](https://raw.githubusercontent.com/svkozak/pi-acp/v0.0.34/README.md)。程序来源为 [官方 npm 包元数据](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent)。[来源收据](npm-release-source.json)记录本次成功读取的完整响应为 **243,531 字节、51 个版本**，小于实现的 8 MiB 上限。

本次公开元数据中，满足下界且发布已满七天的最高稳定候选为 `@earendil-works/pi-coding-agent@0.87.1`：发布时间 `2026-09-22T19:42:48.221Z`，Node 要求 `>=22.19.0`，官方 `pi` 入口 `dist/bundle/cli.js`。实现每次依据公开发布记录选择明确版本，不使用 floating `latest`；排除预发布、弃用、过新或无法核对引擎/入口的记录。发布时间小数秒向上取整，保守判定七天门槛。此次元数据观测不代表实际候选已下载或接入成功。

Node 根据候选包的官方 `engines` 检查实际版本；现有 Node 满足时复用，不满足时只准备 Farfold 受管 Node，保持日常 CLI。当前通用版本解析不支持 npm 范围的全部语法；无法解析的范围保持未知/不给该候选安装通过结论，不能当成满足。

新官方命名包安装路线显式指定公共 registry 及相应 scope，避免继承用户镜像把来源混淆；原通用 npm 路线不改。使用已有 Node/npm，在自有临时 `.npmrc` 将 scope 指向 `https://example.invalid` 后执行一次只读 `config get`，显式 scope 参数得到公共官方 URL，退出 0、stderr 0，临时文件已移除。详见 [优先级收据](npm-scope-source-check.json)。此检查没有执行包安装、写用户 npm 配置或读取配置内容输出。

候选保存与选用还核对安装包公开清单的 name/version/bin/engines，固定入口及包目录都必须留在受管根中；实际 Node 要满足引擎，而不是必须等于旧收据的 Node 版本。

## `--version` 与配置边界

选择版本的 [官方 v0.87.1 main.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.87.1/packages/coding-agent/src/main.ts) 第 577–580 行在 `--version` 分支打印版本并退出；`runMigrations` 位于第 607–609 行，晚于该退出。准备阶段只走版本检查，不进入普通程序循环。

启动自举仍可能读取官方全局设置并临时锁文件，不能据此称零 I/O。该官方版本的受管旧发行清理还取决于官方根目录、标记与程序所在位置；Farfold 自有 `agents/pi/` 候选不采用那个日常发行布局。后续用户实际选用并创建对话时，程序与日常 Pi 共享官方 HOME，可能执行官方配置迁移；需按主记录的配置摘要进行前后核对。“未修改日常二进制”不能扩大成“外部配置零写入”。

## 定向回归

最终命令统一为 `cargo test --manifest-path src-tauri/Cargo.toml --locked <filter> -- --nocapture`，全部退出 0，见 [最终命令收据](targeted-checks.json)。

| 过滤范围                              | 通过数 | 原始输出                                    |
| ------------------------------------- | -----: | ------------------------------------------- |
| `acp_client::preparation`             |     12 | [日志](target-acp_client-preparation.log)   |
| `acp_client::recipes`                 |      2 | [日志](target-acp_client-recipes.log)       |
| `acp_client::versions`                |      1 | [日志](target-acp_client-versions.log)      |
| `dependency_install::tests`           |      5 | [日志](target-dependency_install-tests.log) |
| `npm_release::tests`                  |      2 | [日志](target-npm_release-tests.log)        |
| `program_launch`                      |      9 | [日志](target-program_launch.log)           |
| `installations::tests`                |     11 | [日志](target-installations-tests.log)      |
| `agent_discovery::tests`              |      6 | [日志](target-agent_discovery-tests.log)    |
| `node_runtime::tests`（本轮先行定向） |     11 | [日志](node-green.log)                      |

覆盖低版本仍可连接、未知版本的诚实说明、组件作用范围、显式刷新、Amp 未知组件版本的既有依赖、七天门槛、Node 引擎、精确公开来源、包/入口消失或逃逸、清单与启动文件变化、准备时取消、提交失败不出版候选、未选保存不修改注册目标、切换组件后选用程序与回选。

新增包目录符号链接反例先取得退出 101：旧验证只比较入口是否在包目录内，包及入口同时外移时漏过，共 7 通过/1 失败，见 [红记录](launcher-red.log)。补包及入口相对受管根的约束后，8 通过，见 [绿记录](launcher-green.log)；最终 `program_launch` 过滤连同 argv 转发回归共 9 通过。所有该类执行对象都是自有 TempDir 中的测试程序，不是实际 Agent。

其他早期日志保留为编译/测试修正痕迹。例如 `dependency-install-green.log` 的一次失败来自测试把保存后的迟到取消误期望为成功；既有取消接口正确返回已无法取消，修正测试断言后的最终五例全部通过，未将它报告成产品取消缺陷。

## 尚未由本记录证明

定向回归与公开版本字段不能证明候选在安装版完成握手、模型读取、首发或冷续接，也不能证明旧 Pi 的历史失败整体来自低版本。新候选的真实行为、选择/回选界面、当前工作与外部配置保留情况，依本目录主记录及真实安装版观测分别判断。
