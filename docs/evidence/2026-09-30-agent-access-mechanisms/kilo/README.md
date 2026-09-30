# Kilo 7.8.1：有限静态核对

日期：2026-09-30。仅核对[冻结目录](../../2026-09-30-agent-access-first-slice/registry-snapshot.json)中的 Kilo `7.8.1`：官方发布时间、公开包内容和对应标签源码。未安装、执行 Agent 或安装脚本，未连接协议、读取用户配置或操作正式应用；不代表安装、认证、匿名首发或续接已通过。

原始字段投影、下载校验与读取范围见 [static-receipt.json](static-receipt.json)，完整 ZIP 目录清单见 [zip-contents.json](zip-contents.json)。没有保存二进制或用户数据到证据目录。

## 发布与入口

| 项目           | 已核实事实                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub release | `v7.8.1` 发布于 **2026-09-25 17:16:45 UTC**（北京时间次日 01:16:45）；标签指向 `4089197545a01bbc9fa8041c1305b3fb0b0f8e66`。[官方 release API](https://api.github.com/repos/Kilo-Org/kilocode/releases/tags/v7.8.1)、[标签](https://github.com/Kilo-Org/kilocode/tree/v7.8.1)                                                                         |
| npm            | `@kilocode/cli@7.8.1` 发布于 **2026-09-25 17:23:15.412 UTC**（北京时间次日 01:23:15.412）。父包与 `@kilocode/cli-darwin-arm64@7.8.1` 元数据均没有 `engines`；不能据此宣称任意 Node 版本兼容或替它编造最低版本。[发布时间元数据](https://registry.npmjs.org/@kilocode/cli)、[版本元数据](https://registry.npmjs.org/@kilocode/cli/7.8.1)              |
| ZIP            | 官方 `kilo-darwin-arm64.zip` 为 52,619,716 字节，完整读取及 CRC 检查通过；SHA256 与冻结目录及官方 release digest 一致，为 `d94ab724ce384f9a8e7cda72460c5eb643ed44cb481f80cdd4b7571d005cc0b1`。这是目录自带归档校验，不增加程序二进制身份或版本准入规则。                                                                                             |
| ZIP 内容/入口  | 共 411 项，展开大小 205,387,117 字节；顶层为 `kilo`、`console/`、`tree-sitter/`、`kilo-sandbox-mutation-worker.js`，无绝对/父级路径、无符号链接。根入口 `kilo` 为 139,038,050 字节、权限 `100755`；只读文件头符合 64 位 Mach-O，CPU 类型为 arm64。冻结启动声明是 `./kilo` 加参数 `["acp"]`。资源目录也属于归档，不能只凭入口存在便声称整个程序可用。 |
| npm 内容/入口  | 父包的 `kilo`、`kilocode` 两个 bin 都指向 `bin/kilo`，它是 Node 包装器；macOS arm64 对应精确平台依赖 `@kilocode/cli-darwin-arm64@7.8.1`。父包 tarball 的完整性与官方 `dist.integrity` 相符。冻结参数同为 `["acp"]`。                                                                                                                                 |

截至核对日，两种分发的发布时间均不足 7 天；本页只记录版本年龄，不执行安装或替代适用规则判断。

npm 包的 `postinstall.mjs` 会复制/硬链接平台二进制及资源到父包目录，再执行 `--version`；回退分支还可能在临时目录调用 npm 下载平台包。`bin/kilo` 优先使用 `KILO_BIN_PATH`，否则使用包内缓存或查找平台依赖，并继承环境启动子进程。因此 npm 安装不能描述为只下载；本轮仅作为文本读取了这些公开文件。ZIP 与 npm 的真实安装行为仍须分别验证。

## 7.8.1 认证与匿名路线的具体依据

以下均来自官方 `v7.8.1` 标签源码，文件摘要记录于收据；没有把静态声明写成已收到的真实握手。

- **标准认证声明**：`packages/opencode/src/acp/service.ts` 94–148 行声明一个 `kilo-login` 方法，名字为 `Login with Kilo`，没有显式 `type`；按标准缺省解释为 Agent 方法。`authenticate` 只校验方法 ID 后返回空成功，不执行登录或验证凭据。[固定版本源码](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/service.ts#L94-L148)
- **旧扩展有不一致**：同一文件 104–111 行仅在客户端声明旧 `terminal-auth` 能力时补充元数据，但其中命令为 `opencode`，参数为 `["auth", "login"]`；description 却指向 Kilo 登录。不能把 description 解析为命令，也不能借该旧扩展把缺省 Agent 方法改成标准 Terminal。现有纯协议入口和用户明确配置的入口仍应分别处理。
- **匿名分支有版本依据**：`packages/opencode/src/kilocode/provider/provider.ts` 203–231 行检查环境、已保存认证及 provider 配置；没有凭据时将 `apiKey` 设为 `anonymous`，有模型时可自动加载该 provider。[固定版本匿名分支](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/kilocode/provider/provider.ts#L203-L231)
- **模型清单仍依赖当时条件**：该版模型代码读取当前配置和目录缓存，可能刷新在线清单；ACP 通过公共 provider 列表形成可选模型，并优先选择排序后的 Kilo 模型。上述路径没有提供“默认选中的一定免费”的证明。[模型来源](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/provider/models.ts#L79-L106)、[ACP 模型列表](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/directory.ts#L111-L132)、[默认模型](https://github.com/Kilo-Org/kilocode/blob/v7.8.1/packages/opencode/src/acp/service.ts#L787-L812)

官方当前 Gateway 文档允许免费模型匿名访问；这与 7.8.1 的匿名代码路径相符，但它是当前服务政策，不能反推该版本在本机必然取得可用免费模型或首发成功。[官方匿名访问说明](https://kilo.ai/docs/gateway/authentication)

因此 Kilo 可以保留为 **ZIP/npx 分发、缺省 Agent 认证与旧扩展边界、匿名模型读取/失败出口**的候选。真实验证时必须以实际声明和模型清单为准，明确选定当时可用的免费模型再考虑短测；空认证回执、静态匿名分支和模型读取均不能替代请求成功。

## 本轮执行边界

只用只读 HTTP 获取官方公开资料，以 Python 读取 npm tarball、ZIP 目录和文件头，未将 ZIP 解包为可执行安装。大归档下载中断后从既有临时文件续传，最终大小、摘要及 CRC 均核对；早期网络失败不记为产品安装失败。临时公开下载在完成提取后精确清理，清理结果写入收据。

未测试：Farfold 安装/取消/回选、实际 Node 兼容、握手声明、用户既有配置影响、匿名模型可用性、真实请求、停止/审批、冷恢复与进程回收。后续正式安装验收另留候选与截图，不改本页的未运行结论。
