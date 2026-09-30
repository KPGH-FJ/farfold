# Minion Code 启动失败调查

## 结论与证据边界

安装候选 `85235cd` 的 Minion Code `0.1.44` 安装检查未完成 `initialize`：本次诊断仅记录发出初始化请求，随后收到 stderr，没有协议响应。当前缓存官方 Minion 包的顶层代码依赖三个已从缓存官方 ACP Python SDK `0.12.1` 消失的符号；一次独立 SDK 导入检查验证三项均为 `ImportError`。这是一项可确定的公开包接口不兼容，足以阻止使用这组包启动 Minion。

原失败候选的虚拟环境已被清理，诊断未保留原始 stderr 或完整解析结果。因此，**当时具体 traceback 未取得**，不能将独立 SDK 检查称为完整 Minion 启动复现，也不能只凭缓存修改时间断言原进程解析的 SDK 版本。当前证据支持将该接口不兼容列为高度吻合的启动失败原因，不支持认定为账号、Key、模型或 Farfold 会话恢复问题。

## 已安装候选的失败观察

- 根任务在安装版完成受管 uv/Python 准备，按目录 `minion-code@0.1.44`、参数 `acp` 安装并检查连接；界面显示连接失败，未发布 Agent 注册记录。截图：[05-minion-connection-failed.png](../05-minion-connection-failed.png)。
- 与该操作时间对应的诊断为 `/Users/tw/Library/Logs/Farfold/protocol-v1-1790762700688-2.jsonl`；记录已按白名单转存为 [startup-diagnostics.json](startup-diagnostics.json)。18:05:00.689（UTC+8）发出 `initialize`，18:05:02.589 记录 stderr 3,637 字节，无入站协议响应。
- 该日志没有 Agent 身份或进程退出码字段；操作归属依据根任务的现场观察及时间。18:06:44 的 `protocol-v1-1790762804129-3.jsonl` 属于根任务随后发起的 Amp 账号重查，不是 Minion 重试。
- `/Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:minion-code` 当前为空，未发现该 ID 的已注册行；只证明候选未发布，不据此声称已审计全部进程或外部副作用。

## 官方包与缓存源码事实

官方发布元数据可核对 [PyPI Minion Code 0.1.44 JSON](https://pypi.org/pypi/minion-code/0.1.44/json)。本次缓存只读取公开包代码和分发元数据，未读取用户配置或凭据。

| 材料                                                                       | 核对结果                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bJpHRMpPHRkvTOaG/minion_code-0.1.44.dist-info/METADATA:6,13`              | Python `>=3.11`；ACP Python SDK 仅约束 `>=0.7.0`，无上限                                         |
| 同包 `entry_points.txt:6`、`minion_code/cli.py:595,646,669`                | `minion-code` 启动 `cli:run`，`acp` 是实际子命令，转入 `acp_server.main`；目录参数有官方代码依据 |
| 同包 `minion_code/acp_server/main.py:46`                                   | 在进入协议运行函数前顶层导入 `MinionACPAgent`                                                    |
| 同包 `minion_code/acp_server/agent.py:42,47,49`                            | 顶层从 `acp.schema` 导入 `ModelInfo`、`SessionModelState`、`SetSessionModelResponse`             |
| `BiwflEjzmXY-a5jv/agent_client_protocol-0.12.1.dist-info/METADATA:3,19,20` | SDK `0.12.1`，Python `>=3.10,<3.15`，Pydantic `>=2.7`；当前 Python 3.12.13 满足要求              |
| 同 SDK `acp/schema.py`                                                     | 三个旧符号均不存在；限定正常导入检查也证实不能导入                                               |
| `uidJ_X8suwawWEBO/acp/schema.py:794,1435,1652`                             | 缓存 SDK `0.10.1` 仍有三项定义；仅作静态差异核对，未导入此 SDK，也未改 Minion 的依赖             |

上述根目录均位于 `/Users/tw/Library/Application Support/ai.farfold.desktop/uv/cache/archive-v0/`。Minion 元数据修改时间为 10:04:10.990425 UTC，SDK 0.12.1 为 10:04:06.504144 UTC，均吻合本次安装时段；缓存时间不是原虚拟环境的依赖解析收据。

fast-agent-mcp `0.10.1` 的官方分发元数据明确要求 ACP `==0.10.1`，其对应缓存时间为 10:02:19.092643 UTC。本结论不能解释另一项 fast-agent 连接失败；两项调查分别保留。

## 一次限定 SDK 导入检查

根任务明确授权后执行 [sdk_schema_probe.py](sdk_schema_probe.py)，完整命令、时间、退出码和白名单结果见 [sdk-schema-receipt.json](sdk-schema-receipt.json)。

- 使用已有受管 Python `3.12.13`，参数 `-I -B`，关闭 stdin；仅将缓存公开 SDK、Pydantic 及其必要依赖加入 `sys.path`。
- 事先核对 SDK `acp/__init__.py` 及其导入链：仅定义、公开类型/函数导入和 logger，无配置读写或主动启动进程。检查正常 `import acp.schema`，未使用 package stub。
- 没有导入 `minion_code`，没有运行 `minion-code acp`，未发送 `initialize`、`session/new`、prompt 或认证请求，也未修改环境秘密、外部配置或安装依赖。
- 执行设 10 秒上限，拥有独立进程组，超时回收并等待退出。实际 0.916 秒结束，退出码 `0`，stderr `0` 字节；脚本成功完成检查不代表 Minion 成功。
- 官方 `acp.schema` 从指定缓存正常导入，三个公开符号的独立 `from acp.schema import ...` 全部捕获 `ImportError`。结果确认 `minionImported: false`、`usedPackageStub: false`。

不能擅自把完整 Minion 启动称为只读：其 `minion_code/__init__.py:13–15` 调用 `ensure_minion_root_env()`，`runtime_paths.py:26–28` 会创建目录并设置进程环境；官方 ACP 入口 `main.py:103–104,144` 还会追加自己的调试日志。本次探针没有执行这些代码；原安装检查已启动 Minion，可能有它自己的启动副作用，未审计或清理用户目录。

## 恢复出口与实现边界

1. 当前停在启动/初始化之前，不能显示“登录后重试”作为已识别原因，也不能因安装包准备成功就显示“可使用”。保留已有已注册程序；当前失败候选不应覆盖它们。
2. 可把失败阶段明确为“程序未能启动并完成连接检查”，提供重试和查看经脱敏诊断的出口。若后续具有原始异常的安全分类依据，再显示具体包兼容说明；不得把本次缓存推断直接用于所有 Minion 失败。
3. 公开包修复应由官方恢复 SDK 兼容、调整依赖范围或发布更新。Farfold 不给外部包偷偷固定 SDK、写兼容 shim 或修改源码；本调查未实施这些操作，也未发公开 issue。
4. 下一次获准安装验证时，应在发布候选前保存**不含秘密**的解析包版本及结构化启动异常类别，分别验证安装、启动、握手。修复后的官方包仍需真实 `initialize`、认证/模型/首发旅程验证，本调查没有完成后续旅程。
