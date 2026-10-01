# Autohand 伴随程序准备：安装版部分验证

2026-10-01，源码提交 `d76e7bb`，正式应用 `/Applications/Farfold.app`。二进制 SHA-256 `edd1dc62c592d93a5672ebf581954bee9e9d63eb2bebc7477e7c70fae36188f9`；[安装记录](candidate-install.json)核对四个发布文件及签名。11:17 启动，11:26 正常退出；[445 项输入](candidate-source.json)至退出保持不变。

本片为现有 Autohand 0.2.1 组件增加官方 `autohand-cli` 程序准备和共享受管安装能力。程序命令按官方组件三种执行路径交付；新伴随程序目录避免冒号分隔冲突，保留旧程序收据与选择。工作位置已有同名文件时，在启动前拒绝，避免官方解析器将它误当成命令参数。具体边界、受控证据及回归见[实现记录](implementation.md)。

| 安装版实际操作             | 结果与证据                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 从设置进入 Autohand 程序页 | 缺少 CLI、组件版本、受管位置与检查命令可见；两个安装入口可达，[截图 01](01-autohand-missing-program.png)。尚未运行新 CLI 安装。                         |
| 检查已有组件连接           | initialize 成功；原“Install Autohand CLI”登录方法因目标不一致保持禁用，[截图 02](02-connected-install-method-stays-disabled.png)。未调用 authenticate。 |
| 切到模型页                 | 缺少必要程序时，读取模型和使用此 Agent 均禁用，[截图 03](03-model-read-blocked-by-missing-program.png)。未自动创建 Autohand 会话或发送请求。            |
| 暂时返回并退出设置         | 返回原 Amp / 沿用已有设置的空草稿，[截图 04](04-return-to-original-draft.png)。未选择新模型、推理等级或来源。                                           |

[无正文协议记录](protocol-metadata-final.json)有两条连接：启动时既有 Amp 草稿的 initialize / session/new，以及显式 Autohand initialize；没有 prompt 或 authenticate。Autohand 缺少程序的阻断不妨碍仅检查组件连接。安装页两按钮被说明文字压缩导致中文断行，保留为本候选已观察的界面缺陷，下一片单独修复。

[退出核对](after-exit.json)：原 35 条会话索引、37 个 Agent 启动配置及原未发字段保持；46 项设置中仅 `agentSetup.v1` 准备进度变化，没有新增索引或 Agent。[三个采样身份](all-observed-processes.json)均已全局结束，协议清理也记录两个子进程组结束。[删除证明](duplicate-app-cleanup.json)仅移除与正式应用四文件一致的重复构建 bundle，正式应用保留。

工程检查：527 Rust 通过、3 既有忽略，fmt/clippy、全工程格式和打包通过；312 项前端输入未变，[复用](frontend-reuse.json)前片 1,213 前端、类型及构建。官方组件纯解析函数的 13 项受控命令交付实验均符合预期，未运行真实 CLI；这些结果不代替实际安装和模型请求。

**仍未验证：** 新 CLI 安装已到具体入口，因电脑操作工具要求确认安装新软件，等待用户对官方 npm `autohand-cli` 受管安装的答复。实际 CLI 版本检查、选择/升级、登录目标、真实首发与冷续接均未完成。没有输入或保存凭据。Messages 云端账号条件和全目录最终同候选验收继续开放。
