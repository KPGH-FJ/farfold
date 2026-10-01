# Messages 官方 SDK 本机请求检查准备

截至 2026-10-01，已按本方案准备官方固定测试工具并执行独立 SDK 本机请求；[实际结果](sdk-canary-results.md) 为 14 例符合预期、13 次本机请求、退出 0。**尚未验证 OpenCode 的最终服务交付。** 产品源码、仓库依赖、正式应用和用户配置均未改动。

## 当前可执行材料

- [messages-sdk-canary.mjs](messages-sdk-canary.mjs)：官方 `@ai-sdk/anthropic@3.0.111` 的独立请求脚本；`node --check` 退出 0。
- [sdk-missing.json](sdk-missing.json)：未指定可用 SDK 时的实际退出收据，退出 2、`executed=false`、请求数 0。此结果不是请求验证通过。
- [sdk-packages.json](sdk-packages.json)：单版本元数据、固定归档地址及 SHA-512 完整性值、发布日期和采集完整性收据。
- [research.md](research.md) / [implementation-boundaries.md](implementation-boundaries.md)：产品实现前仍须解决的配置覆盖、请求地址、密钥交付和来源保护边界。

本机 Node 为 `22.22.3`。已发现 OpenCode 可执行文件，但没有在公开模块目录中找到可直接导入的 Anthropic SDK。检查限定于仓库模块、OpenCode 模块与常见公共工具缓存的 `package.json`；未执行 OpenCode、未读取认证文件、用户配置或环境值。现有 OpenCode 模块目录含 `zod@4.1.8`，无需新增此包。

## 固定测试工具包清单

以下八项在 2026-10-01 UTC 00:00 评估时均已发布至少 7 天。选择精确版本，不运行 `latest` 或宽范围解析。包元数据未声明 `preinstall`、`install`、`postinstall`，后续准备仍须禁止执行任何安装脚本。

| 包                       | 固定版本  | 官方发布日期（UTC）      | 来源                                                                                                                                                                 |
| ------------------------ | --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ai-sdk/anthropic`      | `3.0.111` | 2026-08-14T19:54:45.514Z | [单版本元数据](https://registry.npmjs.org/%40ai-sdk%2Fanthropic/3.0.111) / [归档](https://registry.npmjs.org/@ai-sdk/anthropic/-/anthropic-3.0.111.tgz)              |
| `@ai-sdk/provider`       | `3.0.15`  | 2026-08-11T04:58:59.345Z | [单版本元数据](https://registry.npmjs.org/%40ai-sdk%2Fprovider/3.0.15) / [归档](https://registry.npmjs.org/@ai-sdk/provider/-/provider-3.0.15.tgz)                   |
| `@ai-sdk/provider-utils` | `4.0.46`  | 2026-08-14T19:56:12.566Z | [单版本元数据](https://registry.npmjs.org/%40ai-sdk%2Fprovider-utils/4.0.46) / [归档](https://registry.npmjs.org/@ai-sdk/provider-utils/-/provider-utils-4.0.46.tgz) |
| `zod`                    | `4.1.8`   | 2025-09-11T18:01:08.023Z | [单版本元数据](https://registry.npmjs.org/zod/4.1.8) / [归档](https://registry.npmjs.org/zod/-/zod-4.1.8.tgz)                                                        |
| `json-schema`            | `0.4.0`   | 2021-11-09T02:04:08.632Z | [单版本元数据](https://registry.npmjs.org/json-schema/0.4.0) / [归档](https://registry.npmjs.org/json-schema/-/json-schema-0.4.0.tgz)                                |
| `undici`                 | `6.28.0`  | 2026-07-24T12:55:27.721Z | [单版本元数据](https://registry.npmjs.org/undici/6.28.0) / [归档](https://registry.npmjs.org/undici/-/undici-6.28.0.tgz)                                             |
| `eventsource-parser`     | `3.0.8`   | 2026-04-19T17:45:17.687Z | [单版本元数据](https://registry.npmjs.org/eventsource-parser/3.0.8) / [归档](https://registry.npmjs.org/eventsource-parser/-/eventsource-parser-3.0.8.tgz)           |
| `@standard-schema/spec`  | `1.1.0`   | 2025-12-15T20:49:46.431Z | [单版本元数据](https://registry.npmjs.org/%40standard-schema%2Fspec/1.1.0) / [归档](https://registry.npmjs.org/@standard-schema/spec/-/spec-1.1.0.tgz)               |

依赖图闭合：Anthropic 直接依赖 `provider@3.0.15` 和 `provider-utils@4.0.46`；后者依赖同一 provider，并声明 undici、eventsource-parser、standard-schema/spec 的兼容范围，本清单采用其明确最低兼容版本；provider 声明 json-schema，本清单固定 0.4.0。zod 4.1.8 满足官方 peer 范围。其余包没有进一步运行依赖。Node 22.22.3 满足这组包的已公布 Node 下限。

最初部分完整包元数据请求虽然返回 200，但响应小于 Content-Length、JSON 不完整，收据原样保留且不作为发布日期证明。随后一次有界采集修复取得完整 JSON；provider 最后一轮 `curl --compressed --retry 2` 最终退出 0、完整 JSON 442738 字节。zod 用有界 Range 响应取得完整公开 `time` 对象，不能声称取得整个包元数据。对应证据在 JSON 的各 followup 字段。

## 临时工具准备方式（已执行）

实际通过 [prepare-and-run-sdk.py](prepare-and-run-sdk.py)，只在明确任务临时目录中准备独立 `node_modules`，不改变仓库 package/lock、不写 Agent 配置、不修改 HOME。逐项从上述官方固定归档下载，有下载及解包上限；校验 JSON 中的 SHA-512 integrity 后，仅接受归档 `package/` 内普通文件与目录，拒绝绝对路径、`..`、链接和特殊文件。核对每份公开 manifest 的 name/version 与依赖清单，再按 Node 的公共模块解析形状摆放精确依赖。全程不调用 npm 安装、包安装脚本或 Agent 入口。现有 zod 可只读复用；若独立目录需自含模块，另明确采用同一固定官方归档，不替换已有模块。

准备路径、包校验和公开 manifest 收据见 [sdk-tool-preparation.json](sdk-tool-preparation.json)；完成后显式删除任务临时目录，已确认不存在。包目录本身不得留在证据目录下，避免被仓库格式/源码检查误收。

可执行命令形状：

```sh
node docs/evidence/2026-10-01-agent-service-messages/messages-sdk-canary.mjs \
  --sdk-root /tmp/<明确任务目录>/node_modules/@ai-sdk/anthropic \
  --out docs/evidence/2026-10-01-agent-service-messages/sdk-loopback.json
```

`--sdk-root` 必须为已核实官方固定归档的绝对目录。脚本自身只核对 manifest 并不证明归档来源，不能拿任意同名目录代替官方包。

## 请求检查边界

脚本使用固定无价值 canary；仅此测试进程替换 Anthropic 两个环境值，不读取或写入原值。只监听 `127.0.0.1` 的临时端口；SDK fetch 必须匹配本例固定方法、目标与路径，实际 TCP 目标强制为同一监听。官方 `api.anthropic.com` 两例只观察 URL 构造并拦截到本机，不解析或连接该公网域名。无重定向、请求正文上限 16 KiB、响应上限 64 KiB、单次请求限 3 秒，结束关闭 socket 和监听。

已执行 14 例覆盖自定义根、`/v1`、自定义前缀、末尾斜杠、官方根特殊补全、模型与基础地址被覆盖、不同大小写认证头覆盖、额外 Bearer 头、同时提供两种认证参数、空 authToken。覆盖反例真实观测到选定值被改变，不将该现象称为可安全交付。输出只保留固定 case 标签、公开版本、布尔和字节/请求计数；不输出原始正文、URL、头、密钥、错误正文、环境或用户路径。

即使 SDK 14 例全部通过，也只证明此固定官方 SDK 对独立配置对象的本机请求行为。OpenCode 的配置合并、model.id 与 provider/npm/API 优先级、组织策略、插件请求钩子，以及正式安装版中的来源隔离、真实选定服务首发和冷恢复仍分别待验证；不能据 SDK 局部结果启用已验证 Messages 能力。
