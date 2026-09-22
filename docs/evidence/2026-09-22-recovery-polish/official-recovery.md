# 官方恢复调查与最小复现（未对外发送）

2026-09-22 查询 npm 官方包元数据：Codex CLI 正式版仍为 0.155.1，codex-acp 正式版仍为 1.12.0，与本机相同。另只读检查 1.12.1-preview.2 的发行归档，loadSession 仍调用 threadResume(config=createSessionConfig(...), modelProvider=getResumeModelProvider())，未显式保留原模型/effort；没有安装或执行 preview。见 official-versions.json、preview-restore.txt。

[官方文档](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)说明 thread/resume 可以覆盖配置；没有承诺传空 config 时保留历史模型。现有参数级证据见 ../2026-09-22-capability-followup/resume-matrix.json：同一 5.5/low 历史，无覆盖保持原值，单加空 config 或 modelProvider 则变为默认 6 Astra/high。未在漂移后续发。官方文档只用于接口语义，具体参数行为以本机实测为准。

复现步骤：新建独立测试会话，选 5.5/low 并完成一句无工具回复；关闭测试进程；同一 CLI/HOME 对同一 threadId 分别用无覆盖、config:{}、modelProvider:openai 恢复；比较响应 model/reasoningEffort，不发送后续请求。对应可重跑脚本为前轮 model_probe.py 与 resume_matrix.py。预期：无关配置不应丢弃历史模型/推理等级；实际：覆盖参数使二者回到当前默认。

没有查证到可直接采用的正式修复；本次 preview 静态检查不能证明其运行结果，也不构成对所有未来/alpha 版本的判断。Farfold 不删除必要配置、不替换协议通道、不修补官方程序。B5/R5/J5 保持未通过。复验触发条件：官方恢复路径明确保留历史参数后，用独立入口覆盖 5.5/low、6 Astra/high/low 的恢复和真实续发，检查 MCP/权限/登录复用。现有保护是缓解，不是外部根因修复。
