# 官方配置动作与准备选项：安装结果

2026-09-30，源码 `c22ed6c`，唯一正式应用 `/Applications/Farfold.app`，主程序 SHA256 `9ef0c6c9606d715d91f89c6c8ffdf705d9454fc9718db4407205cb230274e02f`。20:56:56 安装，378 项构建输入从冻结至 21:12:34 退出核对均未变；复制与签名通过，见 [安装收据](candidate-install.json)、[退出核对](after-quit.json)。

## 已测成功

- **Pi 选项恢复与呈现**：探索 → 管理 Pi → 检查连接，显示原 DeepSeek V4 Pro / Thinking off，模型读取结果可见，见 [截图 01](01-pi-model-restored.png)。通用顶层模式恢复通过标准模式接口，真实同名配置优先的具体参数路由有源码回归；无内容协议元数据中的 `other` 不自行标记为特定请求。未发送新消息，不改变前片 HTTP 402 失败。
- **Goose 配置入口**：当前受管 1.52.0 的账号页独立展示配置模型服务；审阅实际程序路径、`["configure"]`、原工作目录、官方来源和可能保存设置/发送测试请求的说明后才运行，见截图 [02](02-goose-reviewed-action.png)、[03](03-goose-reviewed-command.png)。原 `Configure Provider` 认证方法保留，不伪装成可用认证结果。
- **暂离与取消**：21:01:47 启动配置进程 98768，官方匿名遥测提示停在默认 Yes，未提交选择、未输入凭据。暂离重开仍是相同 PID、启动时间与命令，见截图 [04](04-goose-terminal-started.png)、[05](05-goose-terminal-reopened.png)及进程快照。点击 Farfold 取消后该进程结束，其他五个已记录进程不变，界面保留取消结果，见 [截图 06](06-goose-cancelled.png)。
- **连接检查与模型读取分开**：21:07:46 明确重查只替换 Goose 原目录连接，Pi/Amp 进程身份不变。模型页提示明确读取，程序/模型切页不自动读取，见 [截图 07](07-goose-explicit-model-gate.png)。21:08:44 点击重新读取模型后才发出一次 `session/new`，界面如实显示失败，见 [截图 08](08-goose-model-read-result.png)。取消结果仍可在账号页查看。
- **重试与非零退出**：再次审阅和运行启动新的配置进程 99561；在相同遥测提示处发送 Ctrl+C，官方输出 operation interrupted 并退出 1，Farfold 显示配置程序未正常结束，见截图 [09](09-goose-retry-started.png)、[10](10-goose-terminal-interrupted.png)。没有提交默认 Yes。21:10:35 再次重查、离开重进仍保留退出码 1 和连接检查结果，模型门控仍等待明确读取，见 [截图 11](11-goose-result-retained.png)、[重入状态](12-goose-reentered-gate.ax.txt)。

[无内容协议元数据](protocol-metadata-final.json)按五次连接的时间与 UI 操作对应：Amp/Pi 初次各读取一次，Goose 初次读取失败；第一次重查后只在明确点击时读取一次，第二次重查及重入没有新的读取。全部五份诊断均没有 `session/prompt`。这些观察覆盖本次未完成接入的 Goose；不外推为所有入口门控通过。

## 已测失败与仍未完成

- Goose 没有在本轮完成服务配置，明确读取模型继续失败；未把连接、程序退出或取消称为认证/实际请求成功。默认 `~/.config/goose/config.yaml` 两次操作后仍不存在，未审计全部位置覆盖或 Keychain。
- 目录卡片暂离时错误地写“登录尚未结束 / 查看登录进度”，实测反例已进入下一修复片。同源检查另发现完成配置后的断线结果页可达性，以及此前已完成接入的 Agent 经目录/新稿可能绕过明确重读门控；后两项在本候选是源码发现，不能写成真实安装复现。
- 新账号或新密钥输入、成功配置后实际请求、API 来源隔离、其他目录忙任务、启动瞬间取消/应用退出竞争等真实分支未覆盖；其中部分有受控回归，不能替代实测。
- Pi HTTP 402、Codex 模型恢复漂移、uvx 两个连接失败、全目录和完整 J1–J6 均继续开放。

## 数据与退出

返回原 Amp / Medium 空白未发稿，见 [截图 13](13-original-draft-restored.png)。最终 26 条会话、7 个 Agent 配置、16 项设置和原未发字段摘要全部与基线一致；中途 `agentSetup.v1` 仅随页签变化，返回模型后也恢复一致。没有新增会话索引。

[Pi 默认文件摘要与日常 CLI 核对](pi-external-after.json)均与既定基线一致；只比较列明默认文件摘要，不复制秘密内容。正式退出后，本轮累计记录的 **9 个进程身份全部结束**，见 [进程退出证明](process-exit-proof.json)。比较本轮重复 `.app` 全部文件与正式应用一致后，仅移除 `src-tauri/target/release/bundle/macos/Farfold.app`，见 [清理收据](cleanup.json)。正式应用保留，当前已退出。
