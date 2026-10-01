# 入站协议错误有限分类：实现与受控验证

实现沿[只读方案](proposal.md)。真实入站 `RpcResponse::Error` 现在经原 inspection、普通队列、日志白名单、预览和导出保留固定类别；没有改变 SDK 帧、请求结果、认证、取消、清理、模型保护或 UI。没有执行官方 Agent、模型请求、应用、安装、用户配置或凭据操作。安装旅程尚待根任务验证，旧 VTCode 请求失败的具体原因仍未知。

## 生产改动

- [process.rs](../../../src-tauri/src/acp_client/process.rs) 在现有入站 bridge 回调中增加注解调用。只有已经观察到的 typed Error 会生成可选组，Result、本地 decode/EOF/timeout 不生成远端错误事实。
- [startup_diagnostics.rs](../../../src-tauri/src/acp_client/startup_diagnostics.rs) 复用原有限提取器；出站仍为原六类，入站增加 `auth_required`、`request_cancelled`、`resource_not_found`，其余未知码为 `other`。没有保存任意数值、message/data、ID 值或方法；`responseIdNull` 仅是布尔。
- [tap.rs](../../../src-tauri/src/acp_client/tap.rs) 按方向验证整个 v1 可选组；入站九类、出站六类，方向不符、未知类别、部分字段或类型错误剥离整组。基本 v1 仍可读取，v2 原实现不变。现有 writer 与 `safe_logs` 共用该白名单，无新导出旁路。

`beforeInitializeAccepted` 仅表示观察时尚未接受初始化。合法 null ID、cleanup/timeout 时点不能证明 handler 或对应方法；没有新增请求关联表或单槽。状态锁争用或失效仍通过 `try_lock` 省略整个可选组，不等待或填默认布尔。普通队列满、日志上限和导出窗口仍可能遗漏记录，缺记录不能证明未收到错误。

## 红绿证据

命令、UTC 起止时间及退出码见各 JSON 收据，原始 stdout/stderr 测试日志均保留；测试只使用自有临时目录和受控 Python 协议对端，日志中的 canary 是测试构造值。

| 范围                           | 结果                      | 收据 / 原始日志                                                                                                               |
| ------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 代表性入站 bridge + 白名单红测 | 0 通过 / 3 失败，exit 101 | [incoming-red.json](incoming-red.json) / [incoming-red.log](incoming-red.log)                                                 |
| 首次入站绿测                   | 7 通过，exit 0            | [incoming-green.json](incoming-green.json) / [incoming-green.log](incoming-green.log)                                         |
| 最终新旧协议错误组             | 20 通过，exit 0           | [protocol-final.json](protocol-final.json) / [protocol-final.log](protocol-final.log)                                         |
| 受影响启动失败组               | 6 通过，exit 0            | [startup-failure-related.json](startup-failure-related.json) / [startup-failure-related.log](startup-failure-related.log)     |
| 受影响启动观察组               | 16 通过，exit 0           | [startup-observer-related.json](startup-observer-related.json) / [startup-observer-related.log](startup-observer-related.log) |
| 日志窗口与真实预览 / ZIP 组    | 8 通过，exit 0            | [log-export-related.json](log-export-related.json) / [log-export-related.log](log-export-related.log)                         |
| 六文件 rustfmt 检查、diff 检查 | 均 exit 0                 | [source-checks.json](source-checks.json)                                                                                      |

这些过滤范围有重叠，不把行数相加作为独立测试总数。作者未运行全套检查；根任务随后完成全量 **535 Rust 通过、3 既有忽略**，fmt/clippy 均退出 0，见 [checks-rust.json](checks-rust.json) 和原始 `rust-0/1/2.log`。312 前端输入未变，[复用](frontend-reuse.json)布局片的 1,213 前端、类型和构建；安装验证另行记录。

## 有意义的受控边界

[真实 bridge 测试](../../../src-tauri/src/acp_client/protocol_error_tests.rs) 使用 manager → 官方 SDK → 自有子进程 → 实际 tap 文件：接受初始化后收到五类标准错误；未知数值和 null ID 仅保留 `other` / 布尔；初始化前独立 null Error 后正常 initialize 仍成功并记录 `matched_result`，而精确 ID 的初始化 Error 仍返回原 `AGENT_INITIALIZE_FAILED`，旧注册行不变。合法 Result 导致本地解码失败、EOF 和有界等待超时均没有入站 Error 分类。

[有限提取测试](../../../src-tauri/src/acp_client/startup_diagnostics/tests.rs) 验证全部九类、旧出站语义、canary/数字不留存、非 Error 不分类、锁争用/失效省略整组，以及迟到观察不改 timeout/cancelled 结果。[白名单测试](../../../src-tauri/src/acp_client/tap.rs) 验证入站三种新增类别不能扩大到出站，未知/部分/类型错误与错误上下文均剥离。

[导出回归](../../../src-tauri/src/diagnostics/log_tests.rs) 经过实际 `safe_logs → preview → ZIP`：旧无分类 v1、旧出站组、新入站组、v2 共存；message/data/ID/method/env/argv/code 扩展不留存；未知类别和伪出站新增类只留下基本元数据。预览之后追加入站记录与启动摘要不进入已审阅 ZIP。

六个源码与测试文件的精确 SHA、字节数、行数见[source-final.json](source-final.json)。这只是本片文件范围，不是整个安装候选身份；六文件均低于 1500 行，Cargo 已释放。源文件冻结后仅继续补本证据说明与独立审查。

根任务为本片派生有限元数据收集器，按方向保留同样的分类，拒绝未完整换行的尾行，并限制本轮起止时间。20 项分类清洗、6 项基本类型反例和 [5 项实际脚本读取流程](collector-flow-validation.json)均通过；后者只使用自有临时合成文件，未运行 Agent 或读取正式日志，临时目录已清理。收集器仅读当前 `.jsonl`，不含旋转副本，不替代产品诊断预览或 ZIP 验收。
