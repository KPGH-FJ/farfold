# 正式安装证据独立复核

复核 `61e8fb4` 的 2026-10-01 15:28–15:46 安装窗口。只读取本目录的内容无关收据、界面文本及 03/04/05/06/10/11 截图；未运行应用、Agent 或测试，未读取正式数据库、凭据、消息正文或原始协议及 stderr。只新增本文。

结论：当前 [installed.md](installed.md) 与原始证据一致，未发现需要修改源码的证据矛盾。通过范围是新目录的 Junie 安装与连接、认证要求呈现，以及三个旧入口的有限回归。

## 候选与界面

- [安装收据](candidate-install.json)对应 `61e8fb4`，正式二进制 SHA256 为 `c02f1ff781b805c95891d718c40aa6fbd12a86e3432f8e11585149f4ed625504`；四个复制文件无差异，签名检查退出 0。[退出收据](after-exit.json)同一二进制摘要、453 个输入无变化。
- [06 截图](06-junie-installed-connected.jpg)及[界面文本](06-junie-installed-connected.txt)明确显示 Junie 3419.24.0 已连接、1 份安装。[运行中目标收据](targets-while-running.json)证明新根为 `agent-installations/agent-registry%3Ajunie/install-fykWYY`，仍使用公开归档中的 `Applications/junie.app/Contents/MacOS/junie --acp=true`。初始化匹配且被正式 SDK 接受。
- [08 菜单](08-junie-auth-methods-menu.txt)只证明两种账号方式可见；[09](09-junie-model-result.txt)仍为读取中。[10 最终界面](10-junie-auth-required.jpg)明确要求登录并禁用使用入口。未取得模型选项，未执行账号方式，不能计登录或首发成功。
- [03 Kilo](03-kilo-legacy-auth.jpg)、[04 Copilot](04-copilot-legacy-auth.jpg)的“在终端登录”按钮可用；未点击执行。[05 Goose](05-goose-legacy-config-review.txt)完整列出原程序路径、`configure`、资料文件夹与副作用说明，只有预览，没有运行配置程序。三个旧目标的公开字段与[安装前基线](target-baseline.json)相同。
- [11 原 Amp 选择](11-original-amp-draft.jpg)显示 Medium 和已有设置，不能扩大为真实回复验证。

## 数据、协议与退出

[退出核对](after-exit.json)中的原 36 条索引、原 39 个启动配置及全部原未发字段均无变化，无新增对话。[安装增量](installation-delta.json)记录仅新增 Junie：40 个 Agent、49 个设置；从当前 44 条安装记录移除唯一 Junie 项后，完整旧设置重构摘要与基线相同，支持原 43 条安装记录保持。变化范围为 `installations.v1`、`agentSetup.v1` 和新增 `installPrevious.registry:junie`；不把准备进度声称为逐项相同。

重新汇总 [protocol-metadata-final.json](protocol-metadata-final.json)：6 文件、50 条启动摘要；6 initialize、5 session/new、5 session/set_config_option，0 prompt / authenticate / load / cancel / permission。观察到入站固定类别 `auth_required`、`internal_error`，均在接受初始化之后；没有解析错误。该有限元数据不含请求 ID 或参数值，不单凭它声称逐项模型值已验证；本轮既有模型准备请求也不能描述成 initialize-only。

六个连接的最后启动摘要均为 childReaped / groupEnded / connectionRemoved，Junie 安装候选为 retained。[27 个采样身份](all-observed-processes.json)在退出核对中均不再存在，结论只覆盖已采样 PID 与启动时间，不声称捕获全部瞬时进程。[重复应用清理](duplicate-app-cleanup.json)四文件摘要与正式安装一致，精确删除本次打包副本并保留正式应用；前序两个 UE 夹具不归入本轮采样或本轮失败。

## 结论限制

旧 Junie 两次 `parse_error` 的产生原因仍未证明。新路径本次连接成功提供修复后的正向结果，不能证明路径冒号是旧失败的唯一原因。新根卸载、版本切换、失败取消及其他分发的新根安装旅程只有受控覆盖，本轮未实际重测；账号成功、首条回复、续接和旧三个入口的实际登录/配置均未完成。

[前端复用收据](frontend-check-reuse.json)核对 314 输入未变后复用 1,266 项及类型、构建结果；[Rust](checks-rust.json)、[格式](checks-format.json)与[重新打包](checks-bundle.json)是工程检查，分别于安装旅程陈述，不替代上述未测项。
