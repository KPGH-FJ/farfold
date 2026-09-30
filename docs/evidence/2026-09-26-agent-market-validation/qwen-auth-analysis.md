# Qwen Code 0.24.5 认证核验

日期：2026-09-26。范围：读取本次安装的 Qwen 开源包、数据库中该 Agent 的握手白名单字段、主线程采集的截图及官方协议文档。未运行或修改 Agent，未读取用户 Qwen 配置、凭据、环境值或完整日志。未修改产品源码。

## 安装版结果

- 已安装并完成握手，UI 显示“已连接”；这不代表认证或真实模型请求成功。
- 点击“开始登录”后仅显示“登录失败”，没有出现密钥输入或授权交互。见 [04-qwen-auth-failed.png](screenshots/04-qwen-auth-failed.png)。
- 选择“沿用已有设置”进入新对话测试后，创建失败，提示当前操作需要认证。见 [06-qwen-conversation-auth-blocked.png](screenshots/06-qwen-conversation-auth-blocked.png)。未发出真实模型请求。
- 现场错误只确认认证未完成，不能据此断言底层一定是 `MISSING_API_KEY`；原始认证错误与用户配置没有读取。

## 实际握手（不含秘密）

从 `registry:qwen-code` 已保存握手按字段提取，未输出元数据值：

```json
{
  "protocolVersion": 1,
  "agentInfo": {
    "name": "qwen-code",
    "title": "Qwen Code",
    "version": "0.24.5"
  },
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {
      "image": true,
      "audio": true,
      "embeddedContext": true
    },
    "mcpCapabilities": { "http": true, "sse": true },
    "sessionCapabilities": { "list": {}, "resume": {} },
    "auth": {},
    "_metaKeys": ["imageCapability"]
  },
  "authMethods": [
    {
      "id": "openai",
      "name": "Use OpenAI API key",
      "description": "Requires setting the `OPENAI_API_KEY` environment variable",
      "_metaKeys": ["type", "args"]
    }
  ]
}
```

唯一方法没有顶层 `type`，没有声明 `auth.logout`。`_metaKeys` 是证据中的键名摘要，不是协议字段。

## 安装包实际实现

包目录：`/Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:qwen-code/install-fZJN8x/node_modules/@qwen-code/qwen-code/`。下列文件均位于其 `chunks/` 中。

| 源码位置                                                              | 确认行为                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acpAgent-CAPZFZCW.js:890–903`                                        | 仅声明 `openai`；公开源码将 `type: "terminal"`、`args: ["--auth-type=openai"]` 放在 `_meta` 中。与 [Qwen v0.24.5 官方源码](https://github.com/QwenLM/qwen-code/blob/v0.24.5/packages/cli/src/acp-integration/authMethods.ts#L9-L20) 一致。 |
| `acpAgent-CAPZFZCW.js:19526–19571`                                    | `authenticate(openai)` 根据已有模型/提供商设置确定认证类型，然后刷新已有配置；该分支没有收集密钥、结构化输入或浏览器登录的调用。只有未被本次握手声明的 `qwen-oauth` 分支注册授权 URL 通知。                                                |
| `acpAgent-CAPZFZCW.js:19554–19565`                                    | 此调用会清理 Qwen 的缓存认证文件；成功后写入其认证类型设置。它是有副作用的登录操作，不是只读检测；本子任务未执行它。                                                                                                                       |
| `acpAgent-CAPZFZCW.js:27306–27308`；`chunk-SYZPPX3O.js:156374–156422` | 调用 `config.refreshAuth`，从已有生成配置解析凭据/模型，再创建内容生成器，没有交互输入过程。                                                                                                                                               |
| `chunk-ALTMZEBU.js:89–107, 696–701, 718–751`                          | 配置验证可因密钥或模型缺失抛错。公开缺密钥错误明确支持已有 `security.auth.apiKey` 或指定环境变量，因此不能把该实现概括为“只检查 OPENAI_API_KEY”。这仅是可触发路径，不是本次原始错误的已证实内容。                                          |

结论：`authenticate(openai)` 无法在缺少已有配置时自行弹出密钥收集流程；即便刷新配置成功，也不能替代一次真实模型请求的验证。

## 标准、扩展与 Farfold 边界

- [当前 ACP V1 认证规范](https://agentclientprotocol.com/protocol/v1/authentication)规定无顶层 `type` 时按 `agent` 处理；终端认证使用顶层 `type: "terminal"`、`args`、`env`，并要求客户端声明终端认证能力。客户端为终端方法单独启动交互进程，不能对其调用 `authenticate`。
- [官方 Terminal Authentication RFD](https://agentclientprotocol.com/rfds/auth-methods#revision-history)记录终端认证于 2026-08-20 稳定。该文档及当前规范没有把 `_meta.type/args` 定义为这一稳定格式。此次有界核验未找到可将 Qwen 这一形状归属到某个官方已发布版本的证据，故只标为 **Qwen 0.24.5 实际使用的扩展声明**，不虚称“旧版官方标准”。[_meta 本身是协议允许的自定义扩展位置](https://agentclientprotocol.com/protocol/v1/extensibility#the-_meta-field)。
- Farfold `src-tauri/src/auth.rs:58–88` 识别顶层 `type` 及另一种 `_meta["terminal-auth"]` 声明，不识别 `_meta.type/args`；`197–207` 因而将该方法归为 `agent`，`519` 调用协议认证。这是与 Qwen 现有扩展的兼容缺口，不能称为遗漏现行标准要求的字段。
- Farfold `src-tauri/src/acp_client/service_config.rs:31–48` 只为已验证接入提供服务配置编译，Qwen 落入“不支持新 API 配置”分支。因此当前产品内既不能通过这条认证请求收集 Qwen 密钥，也不能用已保存的 Farfold API 服务替 Qwen配置新服务。后者是 Farfold 尚未实现的接入能力。
- Farfold `src/components/AgentAuthSection.tsx:165–179` 在失败时经 `uiError` 呈现错误。此次安装版只剩“登录失败”，没有可执行的下一步；结合“需要认证”的新对话错误，会把用户送回无法完成准备的同一入口。

尚未验证：Qwen 的独立交互终端如何完成该参数声明的登录、该启动方式是否需要替换已有 `--acp` 参数、正常凭据下的真实请求。不能断言仅增加 `_meta.type/args` 解析就能修复整条链路；没有执行未声明 OAuth、绕过认证或修改外部程序。
