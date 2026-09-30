# 同名账号方式与恢复选择标签

正式候选 `d00e2c8` 已在 `/Applications/Farfold.app` 完成本片安装复验：GLM 同名方式在选择前可区分，环境变量项仍只读；同一 Codex 漂移历史的弹层明确展示当前返回模型和原记录差异，发送继续被阻止；OpenCode 原历史正常恢复并保留模型说明。**这是标签与说明修正的验收，不是 GLM 登录/Key 交付成功或 Codex 冷恢复漂移修复。**

- [安装结果与边界](installed.md)：04:35:11 安装，04:39:06 退出；[复制与签名](candidate-install.json)、[退出核对](after-exit.json)、[精确重复产物删除](duplicate-removal.json)。二进制 SHA-256 为 `ff4fbff7295fbf7dfbee3a04f0a1e1bc82fece85c50000e6f21c8c021da51349`。
- GLM 菜单以[实时 AX](glm-auth-options.txt)为证；[01 截图](01-glm-distinct-auth-options.png)未捕获系统菜单浮层。[02 截图](02-glm-environment-readonly.png)/[只读文本](glm-environment-readonly.txt)显示选中的长标签和环境说明，无自动登录或 API 配置入口。
- Codex 的[03 截图](03-codex-current-versus-recorded.png)/[弹层文本](codex-readonly.txt)保留 `gpt-6-astra → gpt-6.1-sol`、`ultra → 未提供`；OpenCode 的[04 截图](04-opencode-retained-choice.png)/[弹层文本](opencode-readonly.txt)保留 Nemotron 模型及正常说明；[05 截图](05-original-amp-draft.png)回到原 Amp / Medium 空稿。
- [前端实现与受控红绿](frontend.md)、[八文件摘要](frontend-checks.json)
- [独立审查](review.md)
- [完整前端检查](checks-frontend-full.json)：1,132 项通过，类型、构建通过。
- [后台检查复用](backend-checks-reused.json)：114 项 Rust/构建资源输入未变，沿用上一片 fmt、clippy 和 439 项通过、3 项既有忽略。
- [稳定格式检查](checks-format-stable.json)、[打包记录](checks-bundle-final.json)均退出 0；[候选输入](candidate-source.json)421 项在本片退出时无变化，随后开发不计入本候选。

[退出核对](after-exit.json)确认 31 条原会话索引、28 个原启动配置及全部原未发字段保持，无新增索引；设置只有 `agentSetup.v1` 变化。4 份[协议元数据](protocol-metadata-final.json)中没有 prompt/authenticate；10 个[已观察进程身份](all-observed-processes.json)退出后均不再存在。没有执行登录、确认配置变化或发送新消息；GLM 原缺 Key 失败及 Codex 原恢复漂移结论保留。
