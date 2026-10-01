# OpenCode 仓库目录初始化超时：只读调查

候选 `45e054d`。本调查只读安全协议元数据、当前 Farfold 源码、仓库内非秘密配置路径及固定官方源码；未运行 Agent、读取用户全局配置/凭据/协议正文/stderr 正文，也未修改产品源码。**仓库目录的一次初始化超时已证实，具体阻塞原因仍未知。**

## 实际观察

| 工作位置                | 对应协议文件                        | 初始化结果                                                      | 后续范围                                                                                          |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 应用 conversations 目录 | `protocol-v1-1790827696189-1.jsonl` | 约 1.439 秒观察到匹配结果，`initializeAccepted=true`            | `session/new` 成功，未发请求                                                                      |
| 仓库下 `work-area`      | `protocol-v1-1790827792956-2.jsonl` | 出站初始化观察后约 60 秒超时；`initializeResponse=not_observed` | 无 `session/new`、无 `session/prompt`；SIGTERM 后 `childReaped/groupEnded/connectionRemoved=true` |
| 仓库外中性空目录        | `protocol-v1-1790827948974-3.jsonl` | 约 1.170 秒观察到匹配结果，`initializeAccepted=true`            | 创建对话、真实请求与停止；后续冷恢复及明确继续已由本轮安装旅程验证                                |

依据：[初始化前元数据](protocol-before-send.json)、[停止时元数据](protocol-stopped.json)、[最终元数据](protocol-metadata-final.json)。文件归属结合进程启动时间与实际目录核对，没有按数组位置推断。

[仓库目录采样](active-before-first-prompt.json)中的 OpenCode PID `67716`，实际 OS cwd 为 `/Users/tw/Desktop/farfold/docs/evidence/2026-10-01-opencode-stop-queue/work-area`；[中性目录采样](active-neutral-directory.json)中的 PID `68077`，实际 cwd 为 `/private/tmp/farfold-stop-queue-idn3cxh0`。两者公开命令路径相同。中性目录创建范围见 [neutral-workdir.json](neutral-workdir.json)，原模型与队列旅程见 [模型截图](04-neutral-original-model.jpg)、[冷恢复截图](10-cold-model-source.jpg)、[明确继续结果](11-explicit-continue-result.jpg)及[继续后自有队列记录](own-queue-after-continue.json)。

出站 `initialize` 的 404 字节是 bridge observer 的发送前观察，**不能独立证明 OpenCode 已消费 stdin**。超时记录也不能说明阻塞发生在哪个 Agent 内部步骤。两次不同目录的先后执行不是严格的单变量重复实验；时间、缓存和外部状态差异仍存在，不能据此把工作目录认定为根因。原仓库目录没有再次重试。

## 源码支持的具体候选

Farfold [manager.rs:467–477](../../../src-tauri/src/acp_client/manager.rs)将同一注册命令和参数交给 `ProcessTransport`，并传递本次 cwd；[process.rs:109–119](../../../src-tauri/src/acp_client/process.rs)在实际 OS spawn 使用 `.current_dir(cwd)`。结合上述 OS 采样，没有发现本次目录透传错误；这不排除其他尚未观测的启动或传输问题。

固定 OpenCode 1.18.31 源码基线为 `014614d35b397775e5d397a490fc72368c894ec2`，本调查没有重新执行其版本命令：

- [effect-cmd.ts:75–87](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/cli/effect-cmd.ts#L75-L87)默认先等待 `InstanceStore.load(process.cwd())`，再进入命令 handler；[ACP 命令](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/cli/cmd/acp.ts)在 handler 内才建立协议 stream/connection。
- [instance-store.ts:49–56](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/project/instance-store.ts#L49-L56)等待项目解析与 bootstrap；[bootstrap.ts:32–41](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/project/bootstrap.ts#L32-L41)先读取配置、初始化插件，再等待 LSP、共享、格式、VCS、snapshot、project 初始化。因此，**协议连接建立前的项目 bootstrap 等待**是值得核验的具体分支，尚未实证本次停在哪一步。
- [initialize 实现](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/acp/service.ts#L89-L131)本身构造并返回能力信息，没有上述项目 bootstrap 等待。

本次仅沿 `work-area` 到仓库根检查已知项目配置路径：未发现 `opencode.json/jsonc` 或 `.opencode`，仓库根存在 `AGENTS.md` 与 `package.json`。[ConfigPaths:21–38](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/config/paths.ts#L21-L38)收集官方配置目录，普通仓库 `package.json` 不自动成为插件依赖安装目录。配置目录的[依赖准备](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/config/config.ts#L401-L438)及[插件等待/加载](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/plugin/index.ts#L142-L235)仍可能受未读取的用户全局或管理配置影响，不能断言本次没有插件。

标准 `AGENTS.md` 内容读取由 [prompt 链调用 `instruction.system()`](https://github.com/anomalyco/opencode/blob/014614d35b397775e5d397a490fc72368c894ec2/packages/opencode/src/session/prompt.ts#L1187-L1193)，不能用本次零请求的初始化超时直接归因于该说明文件。未知插件是否自行读取文件未核验。

## 下一步边界

现有对照已确认中性目录可用，暂不需要修改 Farfold、删除项目说明、禁用用户插件或延长超时。若继续定位，可另行执行一次有界、同注册命令/参数/正常 HOME 与登录环境的仓库 cwd `initialize-only` 探针，保留有限阶段与精确自有进程回收事实，不发认证、创建对话或模型请求；结合仅进程身份/固定安全启动标记区分协议前 bootstrap 等待与应用入口差异。该观察尚未执行，正常 Agent bootstrap 的自有读写也不能被描述为零写入。
