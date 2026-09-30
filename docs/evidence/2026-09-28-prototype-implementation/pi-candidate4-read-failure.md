# C4 Pi 模型读取失败与重试边界

核对日期：2026-09-28，时区 Asia/Shanghai（UTC+8）。只读检查现有安全日志、已安装软件源码及凭据文件属性；没有启动新的 Agent、登录或模型请求，没有读取秘密、修改配置或升级 Pi。

## 实际结果

C4 的 Pi 连接成功，但模型选项读取仍失败。根任务在界面完成首次读取后，从模型页切到账号页再返回，错误保持可见，没有重新进入读取状态；随后明确点击一次“重新读取模型”。

对应安全日志为 [protocol-v1-1790535081157-1.jsonl](/Users/tw/Library/Logs/Farfold/protocol-v1-1790535081157-1.jsonl)。

| 只读快照时间（CST） | 日志行数 | `session/new` | 协议错误 | `session/prompt` | 最后事件（CST） |
| ------------------- | -------: | ------------: | -------: | ---------------: | --------------- |
| 02:52:24.215        |        5 |             1 |        1 |                0 | 02:51:30.073    |
| 02:53:09.685        |        8 |             2 |        2 |                0 | 02:52:36.836    |
| 02:54:03.317        |        8 |             2 |        2 |                0 | 02:52:36.836    |

第二份快照距离最后事件约 32.8 秒，仍只有首次读取加一次手动重试；第三份快照距离最后事件约 86.5 秒，计数继续不变。这证明本次界面返回没有造成原来的自动重试循环。它不证明 Pi 模型读取成功，也不代表所有错误条件下都不会重试。

作为失败历史保留，C3 的 [protocol-v1-1790533664424-3.jsonl](/Users/tw/Library/Logs/Farfold/protocol-v1-1790533664424-3.jsonl) 在 02:27:44.425–02:32:05.092 共 1001 行：成功初始化一次，`session/new` 333 次、标准错误输出 333 次、协议错误 333 次、`session/prompt` 0 次。C4 的结果没有改写这段失败。

## 可确认的兼容性条件

已安装 `pi-acp` 包的版本为 0.0.34；其随包 [README 第 45 行](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/pi/install-t261dt/node_modules/pi-acp/README.md:45>) 要求本机 Pi 0.81.0 或更新版本，并通过 `PATH` 调用 `pi`。

本机 `/Users/tw/.local/bin/pi` 指向 `@earendil-works/pi-coding-agent/dist/cli.js`，该包的 [package.json](/Users/tw/.local/lib/node_modules/@earendil-works/pi-coding-agent/package.json:3) 为 0.80.5。因此当前版本组合不满足该适配包声明的最低要求。这里只核对安装文件，没有执行 `pi`；版本差异不是本次失败已经确定的根因。

仅检查文件属性确认 `~/.pi/agent/auth.json` 与 `~/.pi/agent/models.json` 均存在、权限为 `0600`。未打开或解析它们的内容。文件存在不能证明所选服务有有效凭据，也不能证明登录、额度或网络可用。

## 精确原因与恢复边界

安全日志只有 `version`、`ts`、`dir`、`event`、`bytes`、`error`，不保存错误码或消息正文；这是 [tap.rs](/Users/tw/Desktop/farfold/src-tauri/src/acp_client/tap.rs:28) 的既有设计。因此，无法从现有日志还原本次具体错误文本。不得根据错误帧字节数推断原因，也不得套用先前 Pi 的网络失败或 Claude 的账号限制。

当前可执行的恢复顺序是：先取得调整外部 Pi 程序版本的授权，使其满足该包的官方要求，再单次读取模型选项；如果仍失败，再取得当次错误或通过 Pi 官方界面确认服务状态。此次没有执行这些恢复动作，不建议在原因未明时反复准备、删除或重填现有凭据，也不改变用户模型选择。
