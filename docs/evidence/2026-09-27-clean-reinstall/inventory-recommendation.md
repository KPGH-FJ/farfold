# 清空重装前只读范围盘点

本记录对应 `inventory-recommendation.json` 的 2026-09-27 14:27:32 UTC 快照，不代表清理后的状态。用户已明确授权删除 Farfold 会话、草稿等自身数据并重装；本独立调查没有删除文件、操作界面或读取凭据值。主线程执行结果另行记录。

## Farfold 自身数据

下列路径均位于 `/Users/tw/Library/`，快照时根路径均不是符号链接。大小为分配字节数，不等同于可释放空间预测。

| 精确相对路径                                 |      分配字节 | 归属与处理范围                                                                                 |
| -------------------------------------------- | ------------: | ---------------------------------------------------------------------------------------------- |
| `Application Support/ai.farfold.desktop`     | 1,712,177,152 | 正式应用数据；包括索引、设置、草稿、自有会话工作目录、托管程序及旧数据库，属于本次完整重置范围 |
| `Application Support/ai.farfold.desktop.dev` |       176,128 | 旧开发标识的独立应用数据，属于本次重置范围                                                     |
| `Caches/ai.farfold.desktop`                  |         8,192 | 正式应用缓存                                                                                   |
| `Caches/ai.farfold.desktop.dev`              |         8,192 | 旧开发应用缓存                                                                                 |
| `WebKit/ai.farfold.desktop`                  |       499,712 | 正式应用网页存储                                                                               |
| `WebKit/ai.farfold.desktop.dev`              |       417,792 | 旧开发应用网页存储                                                                             |
| `WebKit/farfold`                             |     1,024,000 | 可执行文件同名存储；归属为名称推断，弱于 bundle 标识对应关系                                   |
| `Preferences/ai.farfold.desktop.plist`       |         4,096 | 正式应用偏好                                                                                   |
| `Logs/Farfold`                               |    12,763,136 | 源码明确指定的应用日志目录                                                                     |

限定检查的 HTTPStorages、Saved Application State，以及补查的 Preferences/ByHost、Logs/DiagnosticReports 未发现 Farfold 对应条目。已按历史记录核对 `ai.farfold.desktop`、`.dev`、`.dpiqa`、`.p6qa`、`.p6qa.shared` 的常规路径；未做全磁盘扫描。JSON 保留缺失路径及目录元数据。

源码归属依据为 `tauri.conf.json:5`、`lib.rs:65–96`、`meta_store.rs:129–130`、`logging.rs:83–88`、`conversation_directory.rs:8–21`、`agent_install.rs:161`、`node_runtime.rs:123,183`、`agent_catalog.rs:266`、`supervisor.rs:53`。历史标识依据 `docs/maintenance/2026-09-21-single-app.json`。

## 已核实的旧应用包

以下三个精确叶节点均为真实目录，无符号链接，Info.plist 版本均为 `0.1.6`。属于旧重复应用，可按本次授权清理；**各自父恢复目录及其中所有其他材料保留**。

| 精确路径                                                                               | Bundle 标识               |    逻辑字节 |    分配字节 |
| -------------------------------------------------------------------------------------- | ------------------------- | ----------: | ----------: |
| `/Users/tw/Desktop/farfold/src-tauri/target/paired-recovery-9f13/backup-9f13ba.app`    | `ai.farfold.desktop.dev`  | 472,211,721 | 510,607,360 |
| `/Users/tw/Desktop/farfold/src-tauri/target/paired-recovery-p6qa-829c/backup-829c.app` | `ai.farfold.desktop.p6qa` | 436,374,894 | 474,767,360 |
| `/Users/tw/Desktop/farfold/src-tauri/target/paired-recovery-6fe6/backup-6fe6.app`      | `ai.farfold.desktop.dev`  | 475,728,649 | 514,121,728 |

`src-tauri/target/release/bundle/macos/Farfold.app` 在快照时是新生成的 `ai.farfold.desktop`、`0.1.7` 包，不能当作旧残留提前删除；主线程安装并验证后，可依单一正式应用约定清理重复输出。JSON 保存各包 inode、device、时间、文件数和身份。

## Keychain 元数据边界

`auth.rs:277–347` 表明 Farfold 通用密码使用 account `farfold`。当前服务名由 `credentials.rs:84–93` 生成 `farfold.credential.{secretRef}`；旧服务名为 `auth.rs:40–41` 的 `farfold.agent.{agent_id}.{env_name}`。测试另有 `farfold.test.roundtrip.{millis}`，仅源码存在不能证明实际存有条目。

对正式及旧开发数据库只读查询 `credentials.v1` 的引用 ID/退役引用，以及旧 Agent 环境中值为 `__keychain__` 的键名，得到以下四个精确引用服务名，account 均为 `farfold`：

- `farfold.credential.18d81ccda01cbee0-0`
- `farfold.credential.18d7d756776ee4a8-0`
- `farfold.credential.18d81ce84edf17b0-1`
- `farfold.credential.18d7e5f69a022d78-0`

这些是数据库引用，**不是四条实际 Keychain 存在记录**。本调查没有调用 Keychain，没有读取秘密，也没有枚举孤立条目。主线程后续仅属性枚举与删除结果应以其证据为准。仅删除应用数据不会自动删除 Keychain 条目；删除时须限定已核实的 account/service。

## 保护范围与局限

项目源码、Git、原型、全部验收证据和恢复目录中的非应用材料保留。`src-tauri/target` 混有恢复数据，不能整体删除；本清单仅将上表三个已核实旧应用叶节点列为可清理项。独立 Agent 的 HOME、账号、配置、历史和不属于 Farfold 的程序目录保留，包括 `~/.codex`、`~/.pi`、`~/.opencode`、`~/.config`、`~/.local/share`。没有读取这些目录中的正文或秘密。

目录大小来自不跟随符号链接的元数据遍历，同一根内硬链接去重。快照期间主线程可能打包或清理，实际操作前应使用精确路径复核类型与使用状态；本报告不把前置盘点描述为删除后验证。历史保全证据继续保留，即使用户本次已授权清空相应实时数据。
