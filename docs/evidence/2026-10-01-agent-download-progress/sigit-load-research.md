# siGit 1.5.11 本地模型载入：只读调查

2026-10-01。官方源码支持在 ACP 的普通消息中发送 `/load`，载入当前本地模型；Farfold 已有通用斜线命令入口，不需要新增 siGit 专用界面。但本轮没有发送该命令，没有下载权重或启动模型，不能记为载入、推理或取消成功。

## 已有安装事实

- 正式候选 `7a23471` 中，siGit 1.5.11 沿原 `Qwen 2.5 3B - 32K ctx [Onde]` 选择执行短测，返回未载入本地模型的说明，没有完成指定回复。见 [实际结果](sigit-result.txt)。
- [快捷指令现场](sigit-commands.txt) 只显示三个 Farfold 预设。该菜单不是输入 `/` 后的 Agent 命令列表，不能据此断言协议没有发送命令声明。
- [原注册收据](../2026-10-01-agent-access-directory-batch4/sigit-registration.json) 为官方 1.5.11 二进制、`args=[]`。本调查没有改变启动参数、模型选择或任何外部配置。

## 固定版本源码结论

siGit 官方 tag `v1.5.11` 对应 commit `823781441b94695d894905405fa8570f6cf6aca7`。以下均核对该版本，不能用当前主分支替代。

| 问题                         | 已核实的行为                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP 是否支持 `/load`         | `handle_prompt` 先检查文本块中的内建斜线命令，`/load` 直接走 `exec_slash_acp`，而不是交给模型猜测；成功返回普通请求终态。见 [main.rs L2117–2150](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L2117)、[解析与处理 L3463、3887](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L3463)。                                                                                                                                                                                                                                                                       |
| 是否声明命令列表             | `advertise_commands` 包含 `load` 与 `models`；新建、加载历史时都会发送 `AvailableCommandsUpdate`。发送错误被忽略，因此源码声明不能证明本次前端实际收到。见 [L1239–1320](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L1239)、[L1857](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L1857)、[L1958](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L1958)。                                                                                                                                                     |
| 为什么能显示模型却未载入     | 默认配置优先读取 Agent 自己保存的有效模型，否则为 Qwen 2.5 3B。普通无参数非交互启动使用 `run_acp_server(false)`；该模式下普通请求不会自动载入。重新设置当前同一模型也明确不载入。见 [L4211–4232](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L4211)、[L2156–2183](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L2156)、[L2916–2935](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L2916)、[L4642–4651](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L4642)。 |
| `/load` 的副作用             | 对当前本地模型保持选择，设置 Agent 的 `local_inference=true`，后台加载线程调用 Onde；缓存不足时会下载。若当前选择是云模型，该命令会改为本地默认，所以不能泛化为永不改模型。见 [L3887–3906](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L3887)、[L892–949](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L892)。                                                                                                                                                                                                                                            |
| 是否可以取消或失败后直接重复 | 加载线程及 `await_model_ready` 没有使用普通请求的取消标记；斜线分支在建立 `prompt_cancellations` 之前返回。加载开始标记也会阻止重复启动。因此不能承诺普通停止可中止下载/载入，也不能承诺再次 `/load` 会重试先前失败。见 [L892–1011](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L892)、[L2149–2189](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L2149)、[L2635–2650](https://github.com/getsigit/sigit/blob/823781441b94695d894905405fa8570f6cf6aca7/src/main.rs#L2635)。                                                                                |

源码另有显式 `--acp` 自动载入分支，但本次官方目录无该参数；不能为绕过准备步骤擅自修改目录命令。`/models N` 或选择不同模型也可能开始下载并改变模型，本次不建议用它们替代保持原选择的载入。

## 模型文件、来源与硬件边界

siGit 的 [Cargo.lock](https://github.com/getsigit/sigit/blob/823781441b94695d894905fa8570f6cf6aca7/Cargo.lock) 锁定 Onde `1.2.2`。本次只下载并读取其公开源码归档，没有执行代码；归档 SHA-256 `8d84f62e53e6ce8efce62baac8e769d08f83ff19ed6cd9d1a91eeb769fedd618` 与 lock 一致。

| 项目                  | 核对结果                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 当前名称对应的模型 ID | `bartowski/Qwen2.5-3B-Instruct-GGUF`。                                                                                                                                                           |
| 权重文件              | `Qwen2.5-3B-Instruct-Q4_K_M.gguf`，Q4_K_M 量化。                                                                                                                                                 |
| 单个权重大小          | `1,929,903,264` 字节，约 1.93 GB / 1.80 GiB。不是 siGit 安装归档大小，也不是完整下载流量或总内存需求。                                                                                           |
| 来源                  | siGit/Onde 选择的 Hugging Face `bartowski` 量化仓库；基础模型来自 Qwen。不能把第三方量化文件称为 Qwen 官方发布的 GGUF。                                                                          |
| 公开访问状态          | 2026-10-01 的仓库 API 返回 `private=false`、`gated=false`；未下载权重，也未验证当前网络能完成下载。                                                                                              |
| 硬件                  | Onde 对 Apple silicon 有支持，将本模型描述为适合 macOS 桌面。没有核实到可作为承诺的 macOS 最低内存值；其 iOS 内存不足说明不能转换成 Mac 门槛。本机可用内存、磁盘、模型缓存和加载可行性均未检查。 |

依据：[Onde 1.2.2 模型定义](https://docs.rs/crate/onde/1.2.2/source/src/inference/models.rs) L78–87、L277–285；[配置与加载实现](https://docs.rs/crate/onde/1.2.2/source/src/inference/engine.rs) L416–467、L2024–2040；[模型公开文件](https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/blob/f302c64a2269a69fb27b2f9473b362f5bb8e78d8/Qwen2.5-3B-Instruct-Q4_K_M.gguf)。本次公开 API 返回仓库 revision `f302c64a2269a69fb27b2f9473b362f5bb8e78d8`，该文件 LFS SHA-256 `9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94`，大小与 Onde 常量一致。

载入使用 Agent 自己的模型缓存：macOS 默认共享 Onde App Group 模型目录，已有 `HF_HOME` / `HF_HUB_CACHE` 可改变落点；加载器还会修复对应缓存链接/残留锁。`local_inference` 写入 Agent 自己的设置位置。这里只读 [setup.rs](https://github.com/getsigit/sigit/blob/823781441b94695d894905fa8570f6cf6aca7/src/setup.rs#L1) 与 [settings.rs](https://github.com/getsigit/sigit/blob/823781441b94695d894905fa8570f6cf6aca7/src/settings.rs)，没有读取这些用户文件、环境值或凭据。`[Onde]` 标签也用于尚未下载的可选模型，不能当作缓存证明。

## Farfold 现有入口及后续验收边界

[session_projection.ts](../../../src/runtime/session_projection.ts) 接收 `available_commands_update`；[Composer.tsx](../../../src/components/Composer.tsx) L276–283 在输入仅为 `/token` 且有声明时显示独立命令列表，L310–317 选中后仅填入文本。L1335 起的“快捷指令”菜单始终是通用预设，两者没有合并。因此当前菜单截图是正确的有限观察，不足以判定命令声明丢失。

官方实现允许把独立 `/load` 作为普通消息手填发送；就静态路径而言可复用 Farfold 输入/发送和工具进度呈现。若后续进入真实验证，应先保持当前本地模型、确认接受模型下载及 Agent 设置副作用，再由正式界面明确发送一次；单独记录下载/载入终态、所选模型与随后的真实回复，不把命令结束当作推理成功。输入 `/` 的声明展示、实际下载、停止、失败重试与冷恢复均仍未测。本调查没有操作正式应用、启动 Agent、执行模型、改变参数、读取私有配置或发起任何模型请求。
