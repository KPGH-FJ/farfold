# 登录目标候选的安装结果

候选 `869df8e`，2026-09-30 23:46:19 安装；观察至 2026-10-01 00:00。唯一正式应用 `/Applications/Farfold.app`，主程序 SHA256 `3c9bf3f0983ea919dc6231d14e26f1f9e6c1d575f99419e49727d51eef08befd`。391 个输入的[冻结记录](candidate-source.json)、[复制与签名](candidate-install.json)及[最终源码核对](after-quit.json)一致。冻结清单的写入晚于打包启动，具体时间和原因按清单 `freezeNote` 保留，不倒填时间。

工程检查：前端 123 文件 / 1,028 项、Rust 382 项通过（3 项原有忽略），类型、构建、fmt、clippy、正式打包通过。全仓格式初次失败因新增调查文档未格式化，原结果保留；修正后[复检通过](checks-format-recheck.json)。工程检查不替代下面的真实旅程。

## 安装观察

| 用例                          | 结果和证据                                                                                                                                                                                                 | 边界                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Kilo 连接、自动读取模型       | 显示 Kilo Gateway / Nano Banana Pro、Thinking，见 [01](01-kilo-login-ready.png)                                                                                                                            | 未手选模型、未发送                                                                       |
| Kilo 读取模型后的首次登录     | 点击后被“请先完成此 Agent 的任务、待处理事项及账号操作”阻止；没有启动登录子进程，见 [02](02-kilo-login-blocked.png)、[目标观察](kilo-target-first.json)                                                    | **已测失败**，不能被第二次成功覆盖                                                       |
| Kilo 准备稿关闭后的第二次登录 | 同一安装程序实际启动 `kilo auth login`，PID 27854，见 [07](07-kilo-second-running-collapsed.png)、[精确目标](kilo-target-second.json)                                                                      | 仅改变了准备稿已关闭的前置条件，不是首点回归通过                                         |
| Kilo 普通取消                 | UI 显示已取消且账号结果需检查；27854 消失，连接保持，见 [08](08-kilo-cancelled.png)、[进程核对](kilo-after-cancel.json)                                                                                    | 未输入终端内容、选择服务、登录或保存凭据；启动前取消另待验证                             |
| Amp 启动与普通取消            | 实际声明并启动当前注册的 `amp-acp --setup`，PID 27408；取消后结束，见 [03](03-amp-running-collapsed.png)、[04](04-amp-cancelled.png)、[精确目标](amp-setup-target.json)、[取消核对](amp-after-cancel.json) | 当前版本使用同程序路线；伴随 `amp` 路线只有受控证据                                      |
| Gemini 账号下拉框             | 统一浅色样式可见，自动模型读取停在认证要求，见 [05](05-gemini-select-style.png)                                                                                                                            | 未选账号、未登录                                                                         |
| fast-agent 公开模型输入       | `bad model` 被拒绝，安装按钮禁用，红色边框及说明在 AX 中可见，见 [06b](06b-public-input-error-visible.png) 与对应 AX                                                                                       | 截图底部说明部分被页脚遮挡，不能作为完整错误文案可见的证据；本轮未安装。验证值随后已清空 |
| 返回原草稿                    | Amp、Medium 和空白输入保持，见 [09](09-original-draft.png)                                                                                                                                                 | 无自动发送                                                                               |

观察工具最初错误地以伴随 `amp` 为预期，保留的 `amp-target.json` 没有匹配。核对当前公开声明后改为真实的 `amp-acp --setup`，`amp-setup-target.json` 已匹配。这是观察预期修正，不能将首次无匹配解释成产品启动失败。

## 首次登录阻断与下一片

源码中登录入口先异步关闭模型准备稿，再立即申请账号操作。Kilo 声明远端关闭能力，关闭会暂时持有操作锁；Amp 走本地收尾。首点击窗口的脱敏元数据出现一次 52 ms 的 `other` 请求及成功响应；诊断将 `session/close` 归为 `other`，仅凭这份元数据不能证明请求正文。结合源码调用链和第二次对照，下一片将等待真实关闭成功后再登录，保留失败、未知、取消及原目标的保护，不删除后端互斥。

## 数据和进程

[最终核对](after-quit.json)：原 26 条会话、9 个 Agent 与未发字段摘要保持，没有新增会话；仅 `agentSetup.v1` 变化，没有新增设置。三个[协议元数据文件](protocol-metadata-final.json)无 `session/prompt`，不保存终端正文或秘密。

[累计观察的 7 个进程](all-observed-processes.json)在退出后全部结束，身份核对包含启动时间，覆盖被重新托管的子进程。只删除本次精确重复打包应用，正式应用摘要保持，见[删除证明](duplicate-cleanup.json)。正式应用已退出。

新身份登录、实际请求、启动前取消和完整 J1–J6 均未因此关闭。fast-agent 的两个独立上游包入口与进程目录问题见[精确调查](../2026-09-30-agent-access-startup-options/fast-agent/README.md)，不将独立探针成功改写成安装成功。
