# 第 12 周期 Copilot 新版、Pi 模型设置和 Mistral 拒绝

2026-11-17，macOS arm64。下列界面实测使用 `/Applications/Farfold.app` 0.1.7 源码 `a036904e1`，CDHash `3a0a31f4d81fd0b19866dff0d610c610a1b22e56`。沿用现有服务及明确选择，未更换账号。新建样本使用自有临时目录。

## Mistral Vibe 拒绝当前命令

Mistral Vibe 2.25.8，在普通新对话选用现有 Mistral Medium 3.5 / High，手动向 `1c207709-2d0e-4492-5baf-037ab4064f6e` 发一份请求。实际审批卡在工具过程折叠时显示「该步骤报告的输入」和原命令 `/bin/sh /private/tmp/ff-c12-vibe-reject-qpnyPoVU/task.sh`。核对归属后只按一次「拒绝 Deny」。卡片显示「已拒绝 · 已告知 Agent」，随后回复「命令被拒绝，未执行。任务结束。」并结束。脚本唯一副作用是写入 `result.txt`，拒绝前后该文件均不存在，目录只含原脚本，脚本 SHA-256 `23950e84c55a58087639983abea1d429c3a2751c6611f9ee554efed4d3892804`。

`protocol-v1-1794903596557-10.jsonl` 含一次 `session/prompt`、一次 `session/request_permission`（第 67 帧），后者没有自带输入，紧邻同原标识 `in_progress` 事件带输入。验证只覆盖准确的这一项拒绝及该脚本未执行。记住授权撤回、断线待审批和其他权限方式保持待验。 [同命令单次批准正例](../2026-11-17-cycle12-approval-and-lf/README.md)

## Pi 新草稿与原配置

Pi 0.87.1 / pi-acp 0.0.34。一个独立普通新草稿读到保存的 OpenRouter Nemotron 3 Ultra 免费版、Medium 和额外的 `mode`。当前选项未提供该 `mode`。Farfold 明示原选择保留并暂停发送。仅在这份草稿用「沿用当前设置」解除旧选项冲突，再明确选回 `openrouter/NVIDIA: Nemotron 3 Ultra (free)` 并重开模型选择器确认该行已选。思考选择器只提供 `Thinking: off`，本次未发送，未碰原已续答对话和全局原选择。设置诊断 `protocol-v1-1794902875374-3.jsonl` 只有新建与设置更新，零 `session/prompt`。

后续用正式版截图、实际选择和官方回报核对。这里的「只提供 Off」来自辅助功能树只列出当前行。Medium 实际可选，另有保存设置后发送仍暂停的缺陷，见[后续复验](../2026-11-17-cycle12-pi-history-scope/README.md#pi-新目录复现)。

同一套官方 Pi 0.87.1 在独立临时空会话以官方 RPC 模式从启动选项指定 `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`。`get_state` 回报精确模型、reasoning true、当前 `medium`、零消息、无历史文件，`get_available_thinking_levels` 实际回报 `off`、`medium`、`high`。在禁止网络和临时目录外写入的独立进程中，`get_available_models` 可用列表为空，通过列表切换的 `set_model` 返回 `Model not found`。该边界与直接指定模型的能力回报分别成立。仍需沿实际接线核清 Farfold 选中模型和回报思考档是否一致，随后再从正常入口验本机工具、双任务和停止。 [原对话按配置实答](../2026-11-16-cycle12-original-config/results.json)

独立调用同装 pi-acp 时，真实配置在 `session/new` 返回 `auth_required`。另一隔离样本显式禁网、禁止目录外写入、使用临时官方配置目录和进程内合成凭据，`initialize` 和 `session/new` 成功。`session/set_config_option` 选精确免费版，回执和同一会话 `config_option_update` 都回报 `medium`，选项为 `off`、`medium`、`high`，没有独立 `mode`。两种独立探针均为零模型请求。该受控结果证明桥接能刷新选项，真实 Farfold 的差异仍待定位。

## Copilot 1.0.112 更新、历史和停止回执

从正式管理设置点「重新下载 / 更新」。同一登记切为官方 `1.0.112`，旧 `1.0.89` 仍可选。从「检查程序」成功连接，账号页的「使用已有设置继续」可选，读取原 Auto 成功。厂商的 `Log in with Copilot CLI` 一度灰置并报程序不一致。独立零请求握手证明新版仍声明 `copilot-login`、同一平台程序及唯一 `login` 参数。Farfold 原规则只识别 1.0.89。`86bb5f853` 为核实过的 macOS arm64 官方 1.0.112 补充适用，继续核对当前登记、同一安装、两份包清单及实际启动入口。13 项 Copilot 认证测试通过，含错误版本不放行。

按搜索原对话冷开，同一 `f42b41e3-2978-4ce8-ac4d-7b92dce52646` 读回历史，服务为已有设置、模型 Auto。16:19:34 只发一条无工具续问，5 分钟后仍无答复。16:25:01 点一次停止，最终显示「结果未知」「尚未收到停止确认，任务可能仍在执行」。`protocol-v1-1794903480225-8.jsonl` 各一次 `session/load`、`session/prompt`、`session/cancel`，零新建、零审批，且未收到该请求和其取消的终态。旧登记下的原账号、Auto 有一次成功续答证据。保留旧安装、记录和原 Auto，不自动重发。 [旧版正反例](../2026-11-16-cycle12-eight-check/README.md#copilot-原账号原对话和-auto-路由)

## 两家同名文件冷开取回

从普通搜索分别重开 CodeBuddy `01a1e7a3-3252-7dcd-9bcf-72ca4b835e8f`、Kilo `ses_e17edf205ffeAcPiHro6EE9HgS`，从历史对话的精确成品链接实际打开 `result.txt`。CodeBuddy → Kilo → CodeBuddy，每次展开「文件位置」核原路径和预览正文。前者正文首行为 `Farfold test record codebuddy`，原目录 `ff-c12-codebuddy-file-h9zi81lt`；后者为 `Farfold test record kilo`，原目录 `ff-c12-kilo-preserve-lf-mwbh98m6`。两个文件均显示 `Status: ready` 和「完整文件另存为…」。未执行另存或写入。

两文件 78、73 字节，各末尾一个 LF。摘要分别为 `475634f41b5b2996ab7b3e633bc289ec500ce0afb614e7dc0dd47fbb83bfa21f`、`daee9feb7d922d60ea8d4c21b5b9209c56cf3f80373508ba62cf99012782d3fd`，与首次交付一致。`protocol-v1-1794904030678-11.jsonl`、`protocol-v1-1794904117709-12.jsonl` 各一次加载、零模型请求及零审批。 [CodeBuddy 交付](../2026-11-17-cycle12-stop-delivery-approval/README.md#文件返工审批与验收字节) · [Kilo 交付](../2026-11-17-cycle12-approval-and-lf/README.md#kilo-与-dirac-的换行)

## 正式安装与登录入口复验

共用修复 `3b3dda3c3` 保留审批中的有效空字符串选项 ID，并仍过滤缺失和非字符串选项。受控回归证实相同拒绝只提交一次，原请求及会话归属不变。此测试覆盖打开对话阶段，Mistral 的真实拒绝样本则来自回复流程中的正常审批卡。

前端格式、类型及 786 文件的 10,979 项测试通过。Rust 格式、Clippy 及 2,815 项测试通过，11 项既有忽略。内部生产包成功。仅余自有 Copilot 测试结果未知时，Farfold 退出确认准确指出该对话，正常保存并退出。正式安装基线为 `86bb5f853`、0.1.7，CDHash `72bb689a04befbfe5ecc22460e326732a38347d4`，二进制 SHA-256 `37215cc507130acbd744ddbb751023c83940c5b19c87217d0dc17efcebe57e88`。关闭期间三处数据共 263,005 项的前后摘要相同，SQLite 副本完整性检查通过。核验两份签名后只清理构建目录所留的旧重复应用。

新版启动后显示首发 21 家。从探索目录打开 GitHub Copilot 程序管理，正常检查并前往「账号与服务」。1.0.112 的 `Log in with Copilot CLI` 已可选择，下一步明确是「启动设置终端」。退出并放弃本次临时选择，未启动登录、未更换原账号。再打开同一原对话，界面显示「此前请求结果未确认，未自动重发」。`protocol-v1-1794904422954-0.jsonl` 只有一次初始化，`protocol-v1-1794904498784-1.jsonl` 只增加一次历史读取，零发送、零认证。实际重新登录、Auto 续答和停止终态仍分别待验。
