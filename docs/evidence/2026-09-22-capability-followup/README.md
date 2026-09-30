# 2026-09-22 能力补验与恢复漂移定位

状态：本轮可执行补验完成，有新增通过项、已定位的外部恢复缺口和新增安装版缺陷；整体 J1–J6 不关闭。用户要求继续验证此前证据不足的部分，并追查 Codex 模型漂移原因；限本机可覆盖项，不需要独立账号，不展开上线准备。本轮不修改业务源码、官方 Agent/接入包或日常配置。

安装对象为唯一 `/Applications/Farfold.app` 0.1.7，业务源码 `29330b4`，程序 SHA-256 `f642dfb3de290ff2e5e5d4d4aae6e2f000204bde25720dddbe2c146c6ed0a07b`。Codex CLI 0.155.1 / codex-acp 1.12.0，身份摘要见 [identity.json](identity.json)。协议探针、可控 MCP 服务、安装界面操作分别标注，均不代替用户真人签收。

## 1. Codex 模型漂移：已定位参数触发机制，未修复

新建专用测试会话，显式选择 `gpt-5.5 / low` 并取得真实回复，退出全部探针进程。只读取这个新会话的原始 `turn_context` 中 model/effort/turn_id 字段，确认记录确实为 5.5 / low；不导出正文或账号信息。

同一历史、同一 CLI、同一 HOME，通过官方 `thread/resume` 作单变量对照，每项使用全新进程且恢复后不发送消息：

| 恢复参数                                   | 返回模型 / 推理等级 |
| ------------------------------------------ | ------------------- |
| 不传 config 和 modelProvider               | **5.5 / low**       |
| 仅增加 `config: {}`                        | **6 Astra / high**  |
| 仅增加 `modelProvider: "openai"`           | **6 Astra / high**  |
| config 仅设置 diff feature                 | **6 Astra / high**  |
| config 仅设置测试目录 trust                | **6 Astra / high**  |
| 与 codex-acp 等价的 config + modelProvider | **6 Astra / high**  |
| 等价参数同时显式给定历史模型和 effort      | **5.5 / low**       |
| 最后再次不传 config/modelProvider          | **5.5 / low**       |

证据：[model-results.json](model-results.json)、[resume-matrix.json](resume-matrix.json)，对应可重跑探针 `model_probe.py` / `resume_matrix.py`。5.5 / low 原始历史在这些只恢复、不续发的对照后仍保持原值。

安装的官方 codex-acp `dist/index.js:28565–28583` 中，`loadSession` 总是把 `createSessionConfig(...)` 的返回值和 `getResumeModelProvider()` 传给 `thread/resume`，但没有传历史 model/effort。`createSessionConfig` 在 28690–28711 行至少生成 features/projects 配置；`getResumeModelProvider` 在 28746 附近提供当前 provider。于是触发上述 CLI 的配置覆盖分支，未明确保留的模型/推理等级落回当前默认值。它随后直接把返回的 model/reasoningEffort 转成 ACP configOptions，因此 Farfold 收到的已经是漂移值。

这是当前安装组合的确定性参数触发机制；不是 Farfold 错把 5.5 名称显示成 6 Astra，也不是原历史没保存模型。不能笼统说 CLI 任何恢复都会漂移：不带覆盖参数的对照能保持原值。[官方接口说明](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)允许在恢复时覆盖配置；本轮的空对象/provider 单变量行为以实测为准，未声称检查过该版本全部 Rust 内部实现。

此前仅通过绕过 Farfold 的 ACP 对照划出了问题层级，并做了模型保护/新草稿出口，没有继续拆分接入包到 CLI 的请求参数，因而停留在“外部接入问题”。本轮补齐了这段因果证据。恢复问题仍未修复：不修改官方包、不让 Farfold 读取 Agent 私有历史或偷偷改模型，也不把显式参数对照当成产品修复。官方接入路径需正确保留原会话模型与 effort 后再验收 B5/R5/J5。

## 2. 新缺陷：仅推理等级漂移未被保护

安装版新建 `Reasoning restore readiness` 测试会话，保持 6 Astra，第一次回复后在会话选项显式选择 Low，再取得 `FARFOLD-REASONING-LOW` 回复。原始 turn_context 为 6 Astra / low。完成后通过设置仅断开 Codex，再从原会话重连：模型仍为 6 Astra，推理等级变为 High，无漂移警告，输入框可用。本轮没有在漂移后续发。

- [02 选择 Low](02-reasoning-low-selected.jpg)、[03 恢复成 High](03-reasoning-restored-high.jpg)、[04 输入仍可用](04-reasoning-restored-send-enabled.jpg)。
- [installed-reasoning-before.json](installed-reasoning-before.json)：该测试会话 Farfold 元数据只保存 model，原始历史确实有 low。
- `src/runtime/sessions.ts:455` 的恢复比较只检查 model；`src-tauri/src/acp_client/model_guard.rs` 同样只比较 model。其保护不能覆盖推理等级单独漂移。

判定：真实安装版失败，未修复。下一片应沿现有会话元数据保留用户选择的推理等级，前后端采用同一准入比较；未知值诚实处理，不从私有历史补建第二份会话真相、不自动改回配置。本轮只记录缺陷，不将“已拦住模型漂移”扩写为“已保护全部会话配置”。

## 3. MCP / Skills

本地 `mcp_fixture.py` 只提供整数乘法，无网络、账号或任意文件操作；每次调用生成随机 receipt 并在本目录记录，以区别真实工具调用和模型口头回答。独立测试入口使用已安装的官方 codex-acp 和 CLI，通过官方 `CODEX_CONFIG` 进程级配置增加该服务；日常 Codex 定义及 `~/.codex/config.toml` 不修改，无私有 HOME。

- 初次限定“不要使用其他工具”的请求，新建和恢复均回答不可用（[capability-results.json](capability-results.json)）。这是失败尝试，不是已证实服务加载失败。
- 改为明确允许先搜索指定工具后，显式 ACP mcpServers 的 6 Astra 和 5.5 都取得服务端实际调用和随机回执（[mcp-controls.json](mcp-controls.json)）。
- 官方进程级 MCP 配置 + ACP `mcpServers: []` 的新建、冷恢复均取得新调用、新回执及正常结束（[capability-discovery.json](capability-discovery.json)、[mcp-calls.jsonl](mcp-calls.jsonl)、[mcp-lifecycle.jsonl](mcp-lifecycle.jsonl)）。不能再由空列表推断 Codex 丢失原有 MCP 配置，也不能把最早的口头“不可用”当成配置不支持。
- 无副作用的项目 Skill `$farfold-local-proof` 在直接 ACP 新会话中返回只存在于 SKILL.md 的标记，正常结束；恢复后再次返回标记。未出现 read 工具事件，因此不将其声称为“读取工具可视化已验证”；恢复标记可能来自历史，不单独证明重新读取 Skill。
- `mcp-status.json` 是官方全局状态接口的只读名字/工具清单，不含配置或 token；其中没有测试服务不能反推会话级配置不可用，实际工具调用是更强证据。

安装版使用独立自定义入口“能力验收 MCP”，底层仍为上述未经修改的官方程序。参数通过标准 `/usr/bin/env` 和 Node import 传入官方进程级配置；没有复制程序、写 Agent 配置或修改日常 Codex 定义。`Application Support` 中的空格用 JavaScript Unicode 字符串编码表达，因为现有自定义参数输入按空白分词。

- 新会话实调 6×7 = 42，回执 `FARFOLD-MCP-0771a4bc9000`（[05](05-installed-mcp-new.jpg)）。
- Skill 在命令菜单可见并通过 `/$farfold-local-proof` 返回只存在于项目文件中的标记（[06](06-installed-skill-menu.jpg)、[07](07-installed-skill-result.jpg)）。
- 仅断开这一测试入口后重连原会话；待发消息需显式点击“继续发送”，未自动发送。实调 8×9 = 72，新回执 `FARFOLD-MCP-c6f08a5b8c1e`（[08](08-installed-mcp-restored.jpg)）。两个服务 PID 和时间均在 `mcp-calls.jsonl`，排除了只复述旧结果。
- 冷恢复之前才在测试项目增加第二个 Skill，恢复后命令菜单已出现（[09](09-new-skill-after-resume.jpg)），实际返回独有标记 `FARFOLD-RESUME-SKILL-D82E46-OK` 并正常结束（[10](10-new-skill-result-after-resume.jpg)）。这一挑战排除旧会话历史直接复述第一个 Skill 标记。

其他 Agent 为直接官方 ACP 对照，**不是本轮安装界面通过证明**：

| Agent                                   | 显式 ACP MCP 新建 / 冷恢复       | 项目 Skill                   |
| --------------------------------------- | -------------------------------- | ---------------------------- |
| OpenCode 1.18.31 / Big Pickle           | 均实际调用服务并匹配新回执       | 正确返回未在请求中提供的标记 |
| Pi 0.80.5 + pi-acp 0.0.33 / GLM-4.5-Air | 均不可用，未匹配任何实际服务调用 | 当前样本不可用               |

见 [OpenCode 结果](opencode-capabilities.json)、[Pi 结果](pi-capabilities.json)。Pi 安装包 README 的 Limitations（第 198 行）明确说明 mcpServers 仅保存、不转交给 Pi；因此本轮已经有“官方接入能力缺口”的依据，不是 Farfold 丢弃工具的证据。未安装额外 Pi 扩展来隐藏缺口。

Pi 安装文档 `docs/skills.md:29–31` 要求项目可信才加载项目 Skill；本机 trust 记录没有覆盖该测试项目，因此这个未可信项目不构成 Skill 保真的成功对照，也不据此认定 Pi 完全不支持 Skill。模型还未遵守本轮“不要读取文件”的限制，尝试了目录检索和只读文件访问，并生成畸形工具名；相关名字/参数键在 [pi-tool-attempts.json](pi-tool-attempts.json)，不导出工具正文。未见写入工具，工作区无额外业务改动；本轮没有扩大 Pi 的信任或继续让模型搜索未知配置。

## 4. 纯空闲回收

安装版恢复已有 `HISTORY1000` 可控对端，PID 30331，由正式应用 PID 19177 启动；该对端不声明 session/list，后台索引刷新不会发送该命令。之后不再打开/发送该连接，不缩短 30 分钟产品超时，不退出应用、不主动断开该 Agent。`idle_observer.py` 每分钟只检查该 PID 及启动时间，不发信号。

[01 起点](01-idle-start.jpg)、[idle-process.json](idle-process.json)、[idle-wire.json](idle-wire.json)、[idle-result.json](idle-result.json)。旧连接最后协议活动为 14:45:30.127，之后一直无新协议事件；15:15:09 观察到原 PID 仍在，15:16:09 已退出。以一分钟采样精度，退出位于最后协议活动后 29分39秒至30分39秒；应用日志在 15:15:52.587 出现对应长度的连接清理记录，符合 30 分钟超时/60 秒检查周期。日志不含原始消息文本，因此不把长度匹配单独当作原因证明。

打开原会话后由应用启动新的测试进程 PID 43726，重新回放 1,000 条历史（[11](11-idle-recovered-history.jpg)）；消息先保留暂停队列，显式点击继续发送后取得 `SYNTHETIC-REPLY` 并正常完成（[12](12-idle-recovered-reply.jpg)）。期间没有退出应用、主动断开该 Agent、手动杀进程或修改超时。此项通过范围为“真实安装程序 + 可控对端”的纯空闲回收与恢复，不冒充三个真实 Agent 均已覆盖。声明 session/list 的真实 Agent 会收到后台索引请求，不能把界面未点击等同于协议纯空闲。

## 5. 验证和结束状态

22 个独立探针进程组关闭后均无本次跟踪残留，见 [probe-cleanup.json](probe-cleanup.json)。安装版完成本轮后正常退出，本轮跟踪的 16 个进程全部退出，清单见 [before-exit.json](before-exit.json) / [after-exit.json](after-exit.json)，旧 UE PID 3076/31388 始终排除，未强杀。保留专用测试入口、会话与证据，未删除 Agent 历史；验收后重新打开唯一应用供使用。

本轮 Python 探针语法及 JSON/JSONL 解析、关键证据一致性断言、`corepack pnpm format:check`、`git diff --check` 通过；格式化前后 40 个 JSON 文件的解析值完全一致，安装程序摘要再次确认未变。没有改动业务源码或官方接入包。旧验收目录的 `fixture-events.jsonl` 仅追加本次回放/发送记录，未改写过去结果。

## 剩余边界

干净用户首次安装/未登录认证、跨 Agent 真实 Key 共享仍缺独立环境和指定测试服务，沿用用户“先验本机可覆盖项”的决定。同会话真实同时审批、三 Agent 各自 MCP/Skills 全矩阵及固定负载前后对照仍不能由本轮样本替代；OpenCode 显式 ACP MCP 通过不等于 Farfold 目前空列表路径已覆盖 OpenCode 的既有配置。现有全部 Checks 通过记录属于 `29330b4` 修复片；本轮没有业务源码变更，不重复冒称跑过完整工程门禁。
