# 第 12 周期 · Cline 重新登录与旧对话来源核对

## Cline 根因与产品修复

Cline 3.0.74 在原 `cline` 服务、Claude Sonnet 5.5 下的独立 ACP 复现和官方无界面复现，都与各自原请求精确匹配。Cline 本机 `run.failed` 回执明确要求重新认证。按该版本代码，OAuth 刷新在原凭据未被其他流程替换且未返回新凭据时抛出这个错误。当前掌握的是认证刷新失败，具体上游 HTTP 响应未知。两次均无助手正文。[OAuth 刷新实现](https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/runtime/orchestration/runtime-oauth-token-manager.ts#L166-L183) · [错误生成位置](https://github.com/cline/cline/blob/cli-v3.0.74/sdk/packages/core/src/runtime/host/local-runtime-host.ts#L2802-L2815)

Cline 的协议库会把普通异常包装成 `internal_error`，把具体异常放在 `details`。Farfold 现在只将已匹配原请求、且来自 Cline 登记的固定重新认证回执当作认证要求。同批补齐 Cline 3.0.74 的官方 `auth` 终端入口，沿用现有程序、管理归属及启动参数核对。只有用户主动选择后才开始登录，原错误请求仍可单独关闭，不自动重发。[协议库错误包装](https://github.com/agentclientprotocol/typescript-sdk/blob/v0.16.1/src/acp.ts#L980-L1068) · [官方登录命令](https://github.com/cline/cline/blob/cli-v3.0.74/docs/cli/cli-reference.mdx)

新版已安装并从正式设置打开 Cline 的「启动设置终端」入口。匹配错误和认证终端的 12 项 Rust 定向回归通过，严格 Clippy、格式与正式打包通过。用户用原账号重新登录后，在正式设置页临时选 Sonnet 5.5，只发一次。原服务约 11.4 秒后准确返回全部测试记号，界面显示完成。无界面对照曾把当时已生效的 Sonnet 保存为显式选择，新登录已写入自己的当前配置，实测后该 Nemotron 默认仍在。[脱敏回执](results.json)

## MiniMax 和 Pi

- **MiniMax Code 0.2.7。** 用户确认十月七日旧对话使用当前同一中国区托管账号。正式版按原目录和精确原标识打开、带入并从对话库重开，原消息及 MiniMax-M2.7 均读回。当前索引缺原配置，页面仍明确只读，零发送。续答还需能核据恢复配置的入口。[前序预览](../2026-11-15-cycle12-followup/expanded-history-samples.json)
- **Pi。** 官方原记录与以前的 Farfold 元数据备份都确认了 OpenRouter、Nemotron 3 Ultra 免费版和 Medium。用 Pi 当前已有凭据读原请求的官方生成元数据，HTTP 200、原请求标识及时间匹配，证实当前凭据能访问该原记录。服务端模型字符串与本机选项字符串不同，原因未证。首次在正式版读取约 120 秒无回执，macOS 当时已发起桌面文件夹授权。再次按原目录打开后，用户允许 Farfold 访问桌面文件夹，同一次待定读取返回正文、原模型及 Medium，共 39 条历史更新。预览仍明确只读，当前索引无原配置，零带入、零发送。[OpenRouter 官方接口](https://openrouter.ai/docs/api/api-reference/generations/get-generation)
