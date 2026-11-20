# 第 12 周期 S1–S2 接入复验

2026-11-20，北京时间，macOS arm64 正式 Farfold 0.1.7。测试短消息使用同一自建空目录 `/private/tmp/ff-s12-live.4f3AQKqN`，每条新对话只发一次，不使用工具。日志中的标记缩写只用于本批样本。

## 已有设置首答

| Agent          | 发送时的已选设置                                    | Farfold 记录的原 ID                                  | 协议日志、出站及正常响应行                     |
| -------------- | --------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Kilo           | Kilo Gateway / Nemotron 3 Ultra (free)              | `ses_e06959dbcffeLwPIFg1ERhXDvw`                     | `protocol-v1-1795185855867-32.jsonl` L13 / L19 |
| Dirac          | 已有设置 / `nvidia/nemotron-3-ultra-550b-a55b:free` | `628816b8-0c0e-4f88-a4ab-c120772a738d`               | `protocol-v1-1795186163052-33.jsonl` L12 / L63 |
| Cline          | 已有设置 / Nemotron 3.5 Super VL (free)             | `1795186298503_sE1oU_cli`                            | `protocol-v1-1795186297993-34.jsonl` L14 / L21 |
| Autohand       | 已有设置 / Fantail                                  | `e2cc64f0-3a24-46e5-aede-413000690951-1795187457783` | `protocol-v1-1795187453922-5.jsonl` L15 / L40  |
| GitHub Copilot | 原 GitHub 设置 / Auto                               | `18e28ef8-5e91-4c60-86ec-c638b545aa77`               | `protocol-v1-1795187760240-6.jsonl` L13 / L33  |

Kilo、Dirac 和 Cline 在 CDHash `7a12d4eb79db18a183a5a5f3f2a8389a9ff88a91` 上完成，Autohand 和 Copilot Auto 在 `9a0eb3e5d370fdef18b6caac8ffd29ff9ba90233` 上完成。均在界面显示准确标记及已完成。Kilo、Dirac、Cline 和 Autohand 的选择页证据只对应已选模型和本次回复，实际凭据归属与独立账单未核。Copilot 原账号日志含 Auto 路由、原用户提示和结束，原生事件文件为 `~/.copilot/session-state/<原 ID>/events.jsonl`。

## 一份 API 在两家复用

正式版 CDHash `30e104dfe6095985a6523fcd6d2d2708d104c26f`，主程序 SHA-256 `d000a30f125233c7546c11c23d1d4340a0fa7efef7b12c69906d9058deccd478`。正常退出后换装。两次停机前后各 264,505 项元信息及 6 份关键摘要核合，换装包仅主程序内容变化。

- 同一已存服务「Xiaomi」为 Chat Completions，地址 `https://api.xiaomimimo.com/v1`，模型 `mimo-v2.6-flash`。设置页同一服务卡列出 OpenCode 和 GitHub Copilot。依次从正常新对话选择两家，再选该服务下的同一模型。Farfold 两条对话落盘的服务 ID、指纹和模型一致。没有再次填写密钥，也没有改变原账号的 Auto 对话。
- Copilot 原 ID `bfc09d6f-4045-404e-9c3b-281569b16474`。协议 `protocol-v1-1795188030570-1.jsonl` L13 唯一发送、L32 正常响应，前 32 行 SHA-256 `e8c7178f6b1dbcd852ceeb5d3c768fd1e4460d011a5404396c7e2f04249798f5`。厂商事件 L7 使用记录为 `isByok:true`、`byokKind:remote_user`、`model/responseModel:mimo-v2.6-flash`、`finishReason:stop`，L8 原标记、L9 结束，前 9 行 SHA-256 `a0b94db956216868062d85ed26e59657b98bbfef33bd2789e38ae490b27ee69f`。
- OpenCode 原 ID `ses_e0672880affefESAxYTjgz4JhK`。协议 `protocol-v1-1795188160126-3.jsonl` L11 唯一发送、L23 正常响应，前 23 行 SHA-256 `342db6be500f9b2c0871822ecfc83ddd49fb80a4ef80b51286d9b68b0f969cdd`。界面精确回复测试标记，使用同一已存服务与模型。上游独立账单未核。

## Copilot 的 Messages 正式复验

最后安装版 CDHash `22836e0711b6551614434f8d0f5c16939205a227`，主程序 SHA-256 `07758e0d54daabbf96c28eab800ce2aaaa1fac2e6913670c36a60aed0cc9f9bb`。正常退出换装，停机前后 264,505 项数据元信息及 6 份关键摘要核合，正式应用包其余内容一致。完整前端 11,078 项通过，Rust 2,847 项通过、10 项忽略，另集成 10 项通过、1 项忽略。类型、格式、Clippy、安装包签名核对通过。Copilot 在注入服务凭据前核查实际父进程和已应用的环境冲突，相关回归通过。

- Farfold 普通 Copilot 新对话同时显示「Xiaomi」和「Xiaomi anthropic」。选择已有的后者（Messages，原保存的基础地址为 `https://api.xiaomimimo.com/anthropic/v1`），未编辑配置或重填 Key。
- 原 ID `4764561c-c160-4efb-be2f-68ece21b1bbc`。协议 `protocol-v1-1795189701013-1.jsonl` L13 唯一发送、L31 正常响应，前 31 行 SHA-256 `9d9f9227a9dc27fc29b693a8d0c60effca24e7ba1fc2508a04071d3942ce3489`。原厂商事件 L7 为 `apiEndpoint:/v1/messages`、`isByok:true`、`byokKind:remote_user`、`providerType:anthropic`、`model/responseModel:mimo-v2.6-flash`、`finishReason:stop`，零工具。L8 准确回复测试标记，L9 结束，前 9 行 SHA-256 `8e2daa47889586ba8c5cf37dc094606e4986a0b9f6c2622baf80378150392bd2`。
- Responses 已可按格式选用，当前无已存可用 Responses 配置供实答。Messages 只在官方根或可保持原请求路径的地址上提供，保留路径边界经自动化覆盖。独立账单及所选身份不从模型名字推定。

## 官方设置返回

- Goose 1.59.1 从原新草稿进入「账号与服务 → 在 Agent 中设置模型服务」，启动内嵌官方终端看到 `goose configure` 的提供方和扩展设置菜单。没有输入或保存，点取消、暂时返回、放弃本次选择。原文字与独立工作目录保留，输入区获得焦点。
- 第一版正式复验中，从设置页执行「重新读取模型」时，Goose 报告 OpenRouter、Off、Auto 与原来相同，但模型是 `anthropic/claude-sonnet-4`，原草稿选的是免费 Nemotron 3.5 Super VL。页面显示差异，拒绝直接发送。
- 新正式版在原草稿显示「检查已有设置」。点一次后仍保留原稿，明确提示「原设置尚未确认」和「前往模型选择」。没有自动恢复成默认付费模型，两个取消样本均无模型请求。保持发送保护的同时可以在原草稿发起检查。本轮实测覆盖漂移分支，完全匹配后直接恢复由自动化回归覆盖。
- 外部官方说明新增返回复查和手动「检查已有设置」。正式 Goose 走该链接后可见手动检查，随后已有设置流程报告完成连接检查。失焦、返回、切换目标、忙碌与迟到结果由自动化覆盖。

## 继续待验

Copilot 的丢失认证失败反馈仍需官方结构化结果。已核实 1.0.112 / 1.0.114 的官方程序。独立合成测试中，Chat Completions、Responses、Messages 普通模式的新建与同 ID 冷开续答均按选定服务发送，冷开零自动请求。1.0.114 合成 401 各路径可重试三次后把错误作为正文上报，协议仍结束，不能用作失败验收通过。三种接口以实际兼容性与可用配置逐条验。Goose 统一托管 API 仍缺可验证的服务路由，先沿用官方配置。

Gemini CLI 与 Antigravity 实际授权继续暂缓。已有配置首答不替代首次认证、失败恢复、账号与服务变更用例。各家全部适用接法验收前，完整 S1–S2 保持开放。
