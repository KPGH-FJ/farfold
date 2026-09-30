# Gemini CLI 0.62.0：公开归档与固定版本源码核对

读取：2026-09-30。本轮只读取公开 HTTP 元数据、固定 tag 文本和 npm 归档；未运行 Gemini、Node/npm 脚本、安装、登录、发请求或读取用户配置/凭据。所有下载只进入任务自有临时目录并已回收。以下不是正式安装、握手、账号或模型可用证明。

## 1. 版本与归档

目录条目为 `gemini` / `@google/gemini-cli@0.62.0`，参数 `--acp`。[官方 release 页](https://github.com/google-gemini/gemini-cli/releases/tag/v0.62.0)显示 `29 Sep 21:17`、tag `v0.62.0`、提交 `b460678`。页面时间未自行加时区；tarball HTTP `Last-Modified` 为 `Tue, 29 Sep 2026 21:25:46 GMT`。这两个来源足以说明该 release 截至 9/30 尚不足 7 天；npm `time["0.62.0"]` 精确发布时间仍未取得，不把对象修改时间冒充 npm 发布时间。是否允许目录安装由当前已批准规则判断，本轮不作安装决定。

[单版本元数据](https://registry.npmjs.org/@google%2Fgemini-cli/0.62.0)与真实 tar 内 manifest 一致：Node `>=20`，`bin.gemini=bundle/gemini.js`，包自身没有 `scripts`、`dependencies`，有 8 个固定 `optionalDependencies`，包括 keytar 与 node-pty 系列。[归档收据](archive-check.json)记录完整 transfer 20,787,241 bytes、npm integrity 一致、449 个条目、98,359,283 bytes；未发现越界路径、特殊文件、符号/硬链接或 `.node/.dylib/.so/.dll` 文件。没有解压到磁盘或执行包代码。此检查不覆盖可选依赖的安装脚本、运行时行为或账号环境，不能称整个安装无副作用。

`bundle/gemini.js` 是 4,747 bytes 的加载入口，导入 `gemini-J6X2T2ZI.js` 等分块；不能因入口自身不含登录字符串判定无 ACP。后者包含 ACP 模块与四种登录声明标记，见[分块检查](bundle-check.json)。标记检查不是代码运行结果，也不是对 tag 与整个发布包逐字等价的证明。源码工作区 `packages/cli/package.json` 的 `dist/index.js`/开发脚本与发布包 manifest 分开判断。

第一次 urllib 归档遍历遇 EOF；随后先核对 HTTP 元数据，改用有界 HTTP/1.1 transfer，并在 tar 遍历前验证完整性，才得到上述成功收据。此前 npm 全包元数据两次 IncompleteRead、GitHub API rate limit 与部分源码 urllib 长度不符均保留；未盲目重复这些路径。源码改用有界 curl 后的字节数、哈希与实际文件行号见[源码收据](source-receipts.json)。哈希仅用于本次公开材料收据，不是 Agent 启动准入条件。

## 2. ACP 与认证声明

固定 tag 的入口是 `gemini.tsx` → [acpStdioTransport.ts](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpStdioTransport.ts) → [acpRpcDispatcher.ts](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpRpcDispatcher.ts#L47)。当前[ACP 文档](https://geminicli.com/docs/cli/acp-mode/)仍提到旧 `acpClient.ts` 路径；本轮以固定源码的实际导入为准。`--acp` 是现行入口，旧 `--experimental-acp` 已弃用。

`initialize` 源码声明四种方法，未声明 typed terminal；缺省 type 属于 agent 方法：

| id               | 公开声明/官方路线                                   | 本轮可确认的边界                                                |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `oauth-personal` | Google 登录                                         | 走协议 authenticate；浏览器、实际身份与权益未测                 |
| `gemini-api-key` | Gemini API Key；`_meta.api-key={provider:"google"}` | 没有 `env` 字段；不能从 provider 猜交付授权                     |
| `vertex-ai`      | Vertex AI                                           | 认证方法有声明；实际 ADC/Key/project/location 条件未核实        |
| `gateway`        | `_meta.gateway` 声明 Google 协议与无须重启          | 需要官方 authenticate 的 baseUrl/headers 路线；Farfold 尚未验证 |

方法 id 来自 [AuthType](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/core/src/core/contentGenerator.ts#L63)。官方 Key 解析可接受 `GEMINI_API_KEY`；Vertex 使用 `GOOGLE_API_KEY` 或 project/location 条件，见该文件 L141 起。现有 selectedType 优先于 `session/new` 默认路线，因此只注入一个 Key 环境变量不能保证切换已有身份。[认证文档](https://geminicli.com/docs/get-started/authentication/)给出 Google、Gemini Key、Vertex/ADC 条件；本轮没有检查机器条件。

官方 `authenticate` 接受 `_meta["api-key"]` 和 gateway 详情，成功后写用户 `security.auth.selectedType`（dispatcher L162 起）；切换认证方法时会清缓存凭据（L113）。这是官方动作的副作用，不是 Farfold 写配置。本轮没有执行或模拟该动作。后续必须在用户选择方法后执行，不能为取得模型自动尝试其他方法。

当前 Farfold `auth.rs:208` 只从明确 `_meta.api-key.env` 提取变量名；`auth.rs:496` 的 Key 方法返回配置入口，`manager.rs:656` 的 authenticate 不传 Key/gateway 元数据，`service_config.rs:36` 的已验证服务编译仅覆盖既有 Codex/OpenCode 路线。因此上述 Gemini 声明不能当作当前 Farfold 已完成 Key/gateway 交付的证据；也不能伪造 terminal 登录或直接套用 Goose 配置动作。

## 3. 模型、恢复与错误边界

[acpSessionManager.ts](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpSessionManager.ts#L58)的 `session/new` 读取 cwd 设置并尝试认证；失败或缺 Gemini Key 返回通用 `-32000`（L107），并非标准 AUTH_REQUIRED。`session/load` 缺选择或认证失败使用 `RequestError.authRequired()`（L244/L262）。因此不能把全部 `-32000` 归为认证，也不能让两条路径共用臆测错误码。成功 new/load 返回 legacy `models` 与 `modes`；load 重放官方历史并调用 resumeChat，实际冷恢复模型保持仍未测。

模型选项由 [acpUtils.ts L254](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpUtils.ts#L254)生成，currentModelId 来自 config，候选随官方设置、访问权与模型配置变化，不写死名单。dispatcher `unstable_setSessionModel`（L224）和 [acpSession.ts L236](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/packages/cli/src/acp/acpSession.ts#L236)提供 legacy 设置模型；模式走独立 setSessionMode。该样本可验证本批已修的合成 model/mode 路由，但源码声明不等于实际选择、首发或续接通过。

prompt 的源码会透传结构化 RequestError、429 等失败（session L487/L545）；不是所有请求失败都可判登录。启动、initialize 与 session/new 会进入官方配置/初始化流程，不能称零写入或纯只读。后续不启用会记录请求正文的 ACP debug/telemetry，只采必要白名单字段。

## 4. 下一次正式安装可验证的范围

1. 先按发布年龄规则确定可执行的目录版本；从现有正式安装入口准备，核对实际 Node/入口与 initialize，保留安装/启动失败出口。版本年龄或 Node 声明不替代握手。
2. 仅观察真实 authMethods；未选择登录时，不发 authenticate/prompt、不自动换方法。若模型读取失败，保留实际错误与显式重新读取出口；分别记录 session 与 request 层。
3. Google 登录仅在用户明确选择并具备账号条件后验证浏览器返回、精确原目录重查、显式模型读取、首条真实消息。Key/Vertex/gateway 路线在当前交付缺口明确前保留未测，不读/复制既有秘密。
4. 由用户选择草稿模型与模式后，核对 legacy setter 的实际路由；首发成功后保持该选择，正常退出再冷恢复，检查历史、模型/模式保持和续发。若声明/返回漂移，保留保护与原值，不为通过改模型。

本轮只完成公开材料核对；所有安装、initialize、认证、模型读取、请求与续接格仍为未测。
