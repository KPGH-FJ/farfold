# Gemini 官方目录安装补验

2026-09-30 23:20–23:24，复用已安装 `0b6d74c`，二进制 SHA256 为 `3525b983c77d3c9293dc82bde36c9338f6aa0f740b5a6e51d5759871dac7ade0`。工作区认证修复尚未安装。本轮无重新打包或新增应用副本；身份见 [观察入口](candidate-install.json) 与其中指向的原安装收据。

## 已测结果

- 从探索目录打开 Gemini CLI 管理，安装官方 `@google/gemini-cli@0.62.0` 成功；实际程序由 Node 22.22.3 启动官方 `bundle/gemini.js --acp`，没有额外环境配置。见 [目录快照](catalog.json)、[安装登记](registered-installation.json)、[安装前](01-before-install.png)、[程序版本](05-installed-program.png)。
- 连接成功，准备流程自动尝试读取模型后进入“需要登录”。账号列表实际显示 Google、Gemini API key、Vertex AI、AI API Gateway 四项；只展开查看，未选中任何账号方式。见 [账号条件](02-connected-auth-required.png)、[选项](03-auth-options.png)。
- 模型页显示读取失败与认证要求，保留登录和重新读取入口，“使用此 Agent”不可用。见 [模型页](04-model-auth-required.png)。这不是模型读取或登录成功。
- 暂时返回目录，再返回原对话，Amp 空草稿及 Medium 选择保留。见 [原稿](06-original-draft.png)。

## 数据、协议与退出

[退出前](before-quit.json) / [退出后](after-quit.json) 核对原 26 条会话、8 个 Agent 配置及原未发字段均不变，无新增 Farfold 会话索引；新增 `registry:gemini`，Agent 总数为 9。`installations.v1`、`agentSetup.v1` 改变，新增 `installPrevious.registry:gemini`，不声称所有设置不变。

[协议元数据](protocol-metadata-final.json) 共 3 份，发送 `initialize` 3 次、`session/new` 2 次，`authenticate` 与 `session/prompt` 均为 0；包括冷启动恢复 Amp 的准备连接和 Gemini 安装检查/选用后的连接。读取模型可能创建外部记录，因此不称本轮只读。实际错误文本和账号内容未复制到证据。

23:24:22 正式应用及观察到的 Amp、Gemini 两个 Node 进程共 4 个进程身份全部结束。源码冻结沿用原候选：本目录验证器的 `sourceChanges: null` 表示未重新冻结当前开发工作区，不代表新源码已验证。

## 未完成

四种认证路线、新 API 服务交付、模型读取成功、首条真实回复、续接仍未测。账号选择框的系统默认外观已反馈给认证修复片，待新安装候选观察；此次截图保留原状。不能将连接成功扩展为全流程接入成功。
