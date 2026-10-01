# 真实 OpenCode Messages 请求脚本：执行前审阅

本片只新增证据脚本。**尚未启动 OpenCode，尚未创建其会话，尚未验证其实际 Messages 请求或冷恢复。** 已完成 Python 语法检查、本机 HTTP/SSE 自测及脚本 bookkeeping 自测；这些不能代替真实 Agent 或安装版验收。

## 文件与当前检查

- [actual-opencode-messages-probe.py](actual-opencode-messages-probe.py)：明确 `--run-agent` 才能启动 `/Users/tw/.opencode/bin/opencode acp`；默认和 `--self-test` 均只做自测。实际初始化必须返回本次研究发行 1.18.31，差异时不发 prompt、不升级程序；此限制只界定样本，不改变产品的版本兼容规则。
- [actual_opencode_messages_fixture.py](actual_opencode_messages_fixture.py)：只监听 `127.0.0.1` 临时端口，生成固定纯文本 Messages SSE，正文/头仅在内存比较，不存原始值。
- [actual_opencode_messages_selftests.py](actual_opencode_messages_selftests.py)：纯分类检查和无子进程的短 deadline 检查；测试替换只发生在自测内存，未改脚本执行逻辑或产品。
- [actual_opencode_messages_timing_selftests.py](actual_opencode_messages_timing_selftests.py)：不创建子进程的 HTTP 时点、异常、记录上限、最终判定和配置形状回归。
- [最终自测](actual-opencode-messages-selftest-timing-final.json)：退出 0、`agentStarted=false`；9 项 HTTP/SSE/回收、10 项阶段分类/超时报告及 14 项时序/最终判定检查均通过。外层 HTTP/SSE 检查 5 次本机请求；时序回归另外使用独立本机监听，不计入这 5 次。所有请求均为固定 canary，未运行 Agent。
- [时序真实红](actual-opencode-messages-timing-red.json) 的 11 项检查有 10 项失败、1 项回收通过；[首轮绿](actual-opencode-messages-timing-green.json) 11 项通过，再补三项边界后形成上述最终 33 项。原 [首版冻结](actual-opencode-messages-source-before-timing-review.json)、[前版自测](actual-opencode-messages-selftest-stable.json) 和 [更早完整自测](actual-opencode-messages-selftest-final.json) 均保留，不用后续修复覆盖早版结果。
- [初始 SSE 自测](actual-opencode-messages-selftest.json)：原样保留；[bookkeeping 初失败](actual-opencode-messages-selftest-localfailure.json) 是测试夹具误用 macOS 默认临时目录，被脚本 `/tmp` 边界拒绝，未启动 Agent。改为显式任务 `/tmp` 后通过，不计为 Agent 行为失败。

SSE 形状依据固定官方 [Anthropic 3.0.111 chunk schema](https://github.com/vercel/ai/blob/%40ai-sdk/anthropic%403.0.111/packages/anthropic/src/anthropic-messages-api.ts#L971)；纯文本开始、分片、结束与输出 usage/stop reason 均按该 schema 构造。自测只确认自己的服务器与增量接收器，**没有在本片执行官方 SDK 来接受这些流式帧**。上一片 SDK 实际请求为非流式，见 [sdk-canary-results.md](sdk-canary-results.md)，不倒填为本片流式成功。

## 未来实际执行序列

1. 根任务明确提供一个尚不存在的 `/tmp/farfold-actual-messages-…` 绝对路径。脚本创建这一唯一任务目录并保留其 inode；不扫描或删除其它前缀目录。
2. 启动继承 HOME/普通环境的官方现有绝对程序，只替换本次进程 `OPENCODE_CONFIG_CONTENT` 和两个无价值 canary Key。配置不写文件，不读正式 DB、用户配置、Keychain，不清环境、不建私有 HOME、不改用户默认模型。
3. 本机 A/B 两 provider 使用同一模型 map key、相同明确 API model ID，各有独立基础路径与 canary；不在模型对象里人为添加 context/output 限额。初始化确认后，创建两新会话，逐字确认 offered/current model；只在首条 prompt 前按真实选项选择，后续不改模型。
4. 读取/确认后观察 400ms 窗口，禁止任何自动 HTTP；明确派发固定 A/B prompt，再核实际 `/a/v1/messages`、`/b/v1/messages`、API model、认证头/版本、流式回复及各自 receipt。请求体上限 1MiB、头 32KiB；请求读入与 SSE 写出均有界；不批准工具或文件操作。
5. 首个进程实际 wait/reap 后，确认其进程组为空，才创建第二个进程。加载刚创建的原 ID，确认全部既有 model/thought_level 选项的 ID、类型和值保持及本来源 receipt 回放；当前类别省略或改变时仍按既有 ID 读取，不把新同值 ID 当成保持。不重选模型，不创建成功空历史。再次检查 400ms 窗口内零自动 HTTP，再明确续发，验证实际请求包含本来源前轮 receipt、无另一来源内容。
6. 正例成功后逐项使用任务自有 inline 对象做七项配置反例，每项新进程且只新建一个 A 草稿：model.id、模型级 npm、模型级 api、提供方 headers、模型 headers、空提供方 headers 与非空模型 headers 并存、非空 authToken。替代地址仍只能是同一 loopback 服务，所有 Key/令牌都是固定无价值 canary。

这些是最终 inline 对象的实际行为，**没有写磁盘配置来模拟深合并或组织策略**。特别是“空提供方 headers 与模型 headers 并存”只核两个独立官方字段，不冒充同字段多层深合并证明。后合入策略、启用/禁用 provider、真实用户插件、任意配置层仍保持静态已证/本轮运行未证。

## 判定与安全回收

实际报告分三层：`positivePassed`、`inlineObservationsCompleted`、`expectedInlineOutcomesMatched`。总 passed 还要求全部已启动进程实际回收、所属组确认为空、监听关闭、本次目录删除确认、自动请求为 0、HTTP 处理异常为 0 且没有超限。初始化全部失败、只完成部分 inline 行、prompt timeout 或未知路径均不能因行数齐全而通过。

每个正例/反例在启动前记下请求计数，初始化和模型准备后观察 400ms；计数改变、自动请求、处理异常、超限或仍有未完成 HTTP 连接均不开放 prompt。请求头读取后、路径拒绝前记录请求时点，未知路径也不能漏计准备阶段请求；正文合法 JSON 但不是对象时记固定处理异常。每个监听总请求上限 32、同时处理连接上限 16、记录上限 32，超限只保留计数并使结果失败。最终计数在监听关闭后读取，覆盖迟到收尾异常。

模型级 API 反例按已核官方优先级期待提供方明确 baseURL 保持原路径；模型 ID/认证头反例必须在显式 prompt 后实际观测到对应固定覆盖值，准备阶段被拒的请求不能作为证据。模型级 npm 仅按显式 prompt 后的已知 Responses/Chat 路径或明确进入 prompt 后的 RPC 拒绝记录；非空 token 仅允许模型准备成功后、明确 prompt 被 RPC 拒绝且零 HTTP。拒绝原因不读取、不推断为某个 SDK 错误；其它阶段错误和 timeout 不算风险复现。

总执行 deadline 为 720 秒，位于 actual 内部；partial positive/inline 行即时留在报告，超时后仍有固定失败及 cleanup 结果。单条初始化/打开/设置 RPC 限 30 秒、prompt 限 45 秒。收尾独立限 45 秒，HTTP 收尾限 7 秒；终止记录与实际 wait/group 确认分开。回收未知保留任务目录，不把发出 TERM/KILL 或 Child 不存在写成 reaped。

报告只保留固定标签、布尔、计数及固定本地失败枚举；不落动态协议、错误正文、原始 HTTP、session ID、启动参数、环境值或用户路径。Agent 正常使用继承 HOME，可能读取其自身配置并保存新测试历史；脚本不读取/删除这些历史，不宣称正式 DB 或 Agent 自有存储零变化。已知测试模型地址全部为 loopback；脚本不提供整台进程的网络隔离，也不声称控制任意用户插件。

执行命令形状（**本轮没有执行**）：

```sh
python3 docs/evidence/2026-10-01-agent-service-messages/actual-opencode-messages-probe.py \
  --run-agent \
  --task-cwd /tmp/farfold-actual-messages-<明确本次唯一名称> \
  --out docs/evidence/2026-10-01-agent-service-messages/actual-opencode-messages-result.json
```

输出文件须位于同证据目录、使用 `actual-opencode-messages-` 名称且此前不存在，避免覆盖早版证据。实际执行须等根任务结束当前正式应用安装验收并审阅本脚本，避免进程记录混淆。
