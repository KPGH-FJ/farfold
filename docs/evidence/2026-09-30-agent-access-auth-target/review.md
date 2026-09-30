# 认证目标片独立审查

2026-09-30，只读审查当前源码。未运行 Cargo、Agent、登录命令或正式应用；未修改生产代码。本片目标范围内未发现新增阻断，以下结论不代表真实登录成功。

- [统一路线判定](../../../src-tauri/src/acp_client/auth_route.rs) 保留标准 Terminal 优先；未知、畸形旧终端声明不可转成协议认证。[执行入口](../../../src-tauri/src/auth.rs) 在读取 `environment_for`、Keychain 和创建终端之前拒绝不可执行方法，实际执行使用派生的绝对命令，不再二次查找 PATH。[协议入口](../../../src-tauri/src/acp_client/manager.rs) 共用 `protocol_method`，防止从另一调用入口绕过。
- 简单解释器入口按同一绝对脚本校验；已补 Python 跨脚本与已知解释器 `-c`、`-e`、前置参数反例，同脚本正例保留。范围为源码列出的解释器名称和简单脚本形状，不声称解析任意包装器。对应 [路线回归](../../../src-tauri/src/acp_client/auth_route/tests.rs) 与 [展示回归](../../../src-tauri/src/auth/target_tests.rs) 均为自有夹具。
- Amp 伴随程序沿已核实依赖选择，显式坏路径不回退；Kilo 补充要求固定目录身份、版本、精确错误声明和已有受管收据，验证受管根及父目录；Qwen 保留已有入口核验和有效声明环境。依据为 [配方](../../../src-tauri/src/acp_client/recipes.rs)、[依赖解析](../../../src-tauri/src/acp_client/preparation.rs) 和 [Qwen 兼容入口](../../../src-tauri/src/acp_client/auth_compat.rs)。
- Kilo 的无 `type` 条件仅约束归一化对象。SDK 的 Agent 序列化会省略显式 `type: agent`，新增 roundtrip 回归明确这一边界；不得据此宣称能区分初始报文的显式与缺省类型。补充证明依赖固定版本、收据、方法 ID 与精确参数。
- [前端通用不可执行原因及样式检查](frontend.md) 与后端可选 `unavailableReason` 字段一致。根任务下拉框修改后完成的 [最终前端检查收据](checks-frontend-select-final.json) 记录类型检查、完整前端测试和构建均退出 0，原始 [测试日志](frontend-select-final-1.log) 可复核。全量 Rust 与安装验收由根任务执行，本审查不将作者定向测试或进行中的命令记为全量通过。

## 继承的早取消缺口

[attempts](../../../src-tauri/src/auth/attempts.rs) 已将先到或进行中的 `auth_cancel` 写入同一 `Operation.abandoned`；但 [auth_run](../../../src-tauri/src/auth.rs) 的终端分支没有读取此标记，且仍调用 [PtyManager::spawn](../../../src-tauri/src/pty.rs)，后者另建初始为 false 的停止标记。[手动登录](../../../src-tauri/src/manual_auth.rs) 同样如此。因此用户在启动等待期取消后，后台仍可能读取环境并创建终端，再由前端迟到的关闭请求回收。这是继承缺口，未在本片修复；普通安装版取消成功不能作为该竞态的修复证明。

下一片可复用 [配置终端](../../../src-tauri/src/acp_client/preparation_actions.rs) 已有路径：启动前检查同一操作标记，向 `spawn_controlled` 传递该标记；继续由实际子进程退出帧释放现有账号和配置保护，不新增取消登记或生命周期。必要受控反例是先取消再预留操作、等待配置保护时取消、创建子进程后取消；分别检查自有启动标记缺失、没有终端，以及精确进程组回收和退出确认。当前只记录修复落点，等待本片安装验收后再实施。
