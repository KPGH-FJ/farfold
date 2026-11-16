# 第 12 周期 · Cline 重新登录与旧对话来源核对

## Cline 根因与产品修复

Cline 3.0.74 在原 `cline` 服务、Claude Sonnet 5.5 下的独立 ACP 复现和官方无界面复现，都与各自原请求精确匹配。Cline 本机 `run.failed` 回执明确要求重新认证。按该版本代码，OAuth 刷新在原凭据未被其他流程替换且未返回新凭据时抛出这个错误。当前掌握的是认证刷新失败，具体上游 HTTP 响应未知。两次均无助手正文。[OAuth 刷新实现](https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/runtime/orchestration/runtime-oauth-token-manager.ts#L166-L183) · [错误生成位置](https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/runtime/host/local-runtime-host.ts#L2802-L2815)

Cline 的协议库会把普通异常包装成 `internal_error`，把具体异常放在 `details`。Farfold 现在只将已匹配原请求、且来自 Cline 登记的固定重新认证回执当作认证要求。同批补齐 Cline 3.0.74 的官方 `auth` 终端入口，沿用现有程序、管理归属及启动参数核对。只有用户主动选择后才开始登录，原错误请求仍可单独关闭，不自动重发。[协议库错误包装](https://github.com/agentclientprotocol/typescript-sdk/blob/v0.16.1/src/acp.ts#L980-L1068) · [官方登录命令](https://github.com/cline/cline/blob/cli-v3.0.74/docs/cli/cli-reference.mdx)

新版已安装并从正式设置打开 Cline 的「启动设置终端」入口。对匹配错误和认证终端的 12 项 Rust 定向回归通过，严格 Clippy、格式与正式打包通过。官方重新登录后仍需用原模型在正式 Farfold 验一次真实回复。无界面对照时，官方 CLI 把原先已生效的同一模型保存成显式选择。设置审阅已打开，之后择无认证活动的时间按官方方式恢复诊断新增字段。[脱敏回执](results.json)

## MiniMax 和 Pi

- **MiniMax Code 0.2.7。** 当前官方中国区托管登录已验证。原会话模型 MiniMax-M2.7 在本机官方目录仍可选，与原记录的未分档选择对应。十月七日的旧会话在五处原生元数据均未记录旧账号。需确认原对话使用的是当前同一官方托管账号，之后才用该账号测试旧对话续答。没有发送新的模型消息。[前序预览](../2026-11-15-cycle12-followup/expanded-history-samples.json)
- **Pi。** 官方原记录与以前的 Farfold 元数据备份都确认了 OpenRouter、Nemotron 3 Ultra 免费版和 Medium。用 Pi 当前已有凭据读原请求的官方生成元数据，HTTP 200、原请求标识及时间匹配，证实当前凭据能访问原账户范围的该条记录。服务端模型字符串与本机的选项字符串不同，原因未证。正式版正常对话库能列出同一自建原对话。实际 `session/load` 发出后 120 秒未回，预览显示正文未能读取，零发送。当前索引还缺该对话的原配置入口，未写入备份元数据、未换模型或服务。[OpenRouter 官方接口](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
