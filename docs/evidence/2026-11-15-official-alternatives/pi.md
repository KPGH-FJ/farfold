# Pi 官方替代入口受控验证

2026-11-15，macOS arm64，Node 22.22.3。结论：**保留 Pi 作为待接入验证的首发对象**。现有目录 `pi-acp` 0.0.34 的网页链路仍不通。Pi 厂商 1.5.2 SDK 的确有可实施的替代路线，本次只在合成会话验证，尚未在 Farfold 正式接线。

## 入口与原会话

- 实际安装包元数据：Farfold 所用 `pi-acp` 0.0.34、同安装体系 Pi 依赖 0.87.1。交互 shell 另有 Pi 0.80.5，未用于本测试。`pi-acp` 发行版明示会暂存 ACP 传入的 MCP 描述，但不转发给 Pi，也不提供 ACP 文件、终端回调。更换 Pi 依赖本身不能接通这段桥接。 [适配器同版限制](https://github.com/svkozak/pi-acp/blob/v0.0.34/README.md#limitations)
- 安装版适配器发行代码 `dist/index.js:754–774` 以 Pi RPC `get_state().sessionId` 为新对话 ID，只有拿不到该 ID 才生成自己的随机 UUID。Pi 1.5.2 的官方 `SessionManager.findById`、`list`、`open` 与 RPC `get_state`/`switch_session` 能承担常规原 ID 的查找与打开，旧适配器降级 UUID、重名或来源无法确证继续保留未知，不猜测、不读私有映射强配。RPC 能返回模型、思考级别、原 ID 与文件；其命令集没有列举历史或临时注册 MCP 的标准指令，前者可用官方 SDK，后者走官方扩展接口。 [同版会话接口](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/session-manager.ts) · [同版 RPC 类型](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- Pi 0.99 开始提供原生 MCP。1.5.2 的 `createMcpExtension()` 与 `pi.registerMcpServer()` 在当前 SDK 会话内注入 stdio 或 Streamable HTTP，允许扩展 `tool_call` 拒绝或在 RPC 中经 `ctx.ui.confirm` 取得同 ID 应答。Legacy SSE 不在官方传输范围。文件配置同名优先，集成不得把同名既有服务器误认成临时网页服务器。 [0.99 发行说明](https://pi.dev/changelog/releases/0.99.0) · [MCP 和权限](https://docs.pi.dev/latest/mcp#permissions) · [会话内注册](https://docs.pi.dev/latest/mcp#add-servers-from-extensions) · [RPC 扩展确认](https://docs.pi.dev/latest/rpc-extension-ui#confirm)

## 实际运行边界与结果

从官方 npm 取得 `@earendil-works/pi-coding-agent@1.5.2` 到任务目录，忽略安装脚本。运行期 macOS sandbox 禁网络，文件写入限该任务目录，并屏蔽用户 Pi 数据、Keychain 文件及 Farfold 数据。只读取既有 0.87.1 安装包的代码模块生成合成历史，未读取其历史或账号，未启动 Farfold、改配置、更新已选程序或发模型请求。 [厂商版本](https://pi.dev/changelog/releases/1.5.2) · 运行回执（本机 `output/2026-11-15-official-alternatives/pi/receipt.json`） · 测试脚本（本机 `output/2026-11-15-official-alternatives/pi/probe.mjs`）

| 检查                 | 实际结果                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原对话               | 0.87.1 官方 SessionManager 创建的合成对话由 1.5.2 列出、以精确 ID 找到并读回原用户及助手文本。错误 ID 与错误工作目录都找不到。`SessionManager.open`/读取上下文后原件字节一致。完整 SDK 会话启动时对原来没有思考设置的样本追加 `off` 设置项，原记录未改写，因此不能拿完整启动当只读预览。                      |
| 临时工具、授权与撤回 | 同目录 A/B 两个 SDK 会话只有 A 接到自有 stdio echo。允许操作实际到服务器并回显；扩展拒绝操作返回错误，服务器未收到。撤回后主动、间接可调用工具名单都移除，stdio 连接关闭，继续调用失败且服务器未收到。工具定义仍在全量目录里，暴露状态是 `hidden`，与同版源码相符。冷开同 ID 可读原消息，临时工具未自动恢复。 |
| 停止归属             | 两个 SDK 会话同时执行各自的短命令，A 通过官方 `abortBash()` 停止。原执行返回 `cancelled`，A shell PID 消失，无迟到输出；B 原命令正常结束。此项覆盖 SDK 自有本机 bash，不覆盖模型循环或独立远端 MCP。                                                                                                          |

初次断言要求撤回后工具定义从全量目录消失，实际失败。对照官方 `hideTools`，它保留定义供记录和渲染，执行入口确实撤销。复验分别核对定义隐藏、不可调用、原连接关闭及拒绝操作未到服务器。另一初始断言把完整会话启动当成只读，真实观察到缺失的思考设置被追加；合成结果与同版 SDK 条件一致。 [同版隐藏工具实现](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/extensions/mcp/index.ts#L420-L437) · [同版 SDK 实现](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/sdk.ts)

## Farfold 可推进的范围与待验证项

- 可按官方 SDK/扩展路径做隔离验证与受影响接线。先确证选中的官方程序、用户已有登录、目录和原 ID；只读预览与进入可写会话分别控制。模型和推理档沿原保存值核实，发现漂移时保留人工确认。Pi 1.5.1 起有官方 shell 登录及退出，本轮未调用。 [厂商认证发行说明](https://pi.dev/changelog/releases/1.5.1)
- Farfold 继续以自身会话和页面控制网页许可，撤回先拒绝旧作用域并防止迟到数据回填，再核 Pi 临时注册关闭。支持 Streamable HTTP 的结论目前来自官方接口，实际应用测试、签名与秘密交付、并行页面权限、带真实图像回包及旧会话无重发尚无结果。
- RPC `abort` 等运行空闲才回包，厂商说明有队列时还会继续后续消息。若实现停止并保稿，应先取回待发队列再核原终态。`abort_bash` 的命令回包只确认调用，须等原 `bash` 终态。远端 MCP 服务必须提供可核实停止证据，无法确认时显示未知。 [RPC 停止与清队列](https://docs.pi.dev/latest/rpc-commands#abort) · [同版 RPC 停止源码](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
