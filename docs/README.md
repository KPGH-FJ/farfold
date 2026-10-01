# 项目文档与目录

文档描述事实的层级与产品要求分开：产品契约规定应有行为，源码及对应验证说明实际行为；计划负责安排差距，历史只用于追溯。

| 入口                                          | 用途                                         |
| --------------------------------------------- | -------------------------------------------- |
| [PRODUCT.md](../PRODUCT.md)                   | 唯一产品契约；不随缺陷下调承诺               |
| [AGENTS.md](../AGENTS.md)                     | 仓库工作规则                                 |
| [architecture.md](architecture.md)            | 当前源码结构、数据和调用路径                 |
| [status.md](status.md)                        | 能力、验证范围、已知问题的当前基线           |
| [活动计划](../plans/agent-access.md)          | 唯一待执行序列                               |
| [首批 Agent 名单](agent-first-release.md)     | 探索目录范围、暂缓原因与恢复条件             |
| [INTERNAL-USE.md](../INTERNAL-USE.md)         | 当前内部使用说明                             |
| [设计说明](../.design/README.md)              | 唯一当前原型、运行方式与模拟边界             |
| [evidence/](evidence/README.md)               | 带边界说明的原始验证材料                     |
| [archive/](archive/README.md)                 | 冻结的旧计划、研究、交付说明、截图和设计探索 |
| [整理记录](maintenance/2026-09-20-cleanup.md) | 本轮迁移、删除、保留与检查结果               |

## 代码与资产

- `src/`：React 应用；`components/` 是统一界面，`runtime/` 是客户端状态与 IPC，不是 Agent 执行器。
- `src-tauri/src/`：Rust 桌面入口、ACP 客户端、安装与认证、元数据及进程管理。
- `scripts/`：仍由现有更新链路使用的签名工具及测试。
- `assets/`、`src-tauri/icons/`：应用图标源文件与导出资产。
- `.design/2026-09-26-agent-access-redesign/workbench/`：唯一当前原型；旧版本与历史设计报告已按 2026-09-28 授权删除。
- `dist/`、`node_modules/`、`src-tauri/gen/`：生成输出或依赖；不作为实现事实来源。
- `src-tauri/target/`：编译输出与历史本地备份混存，具体保护项见整理记录，禁止整体清空。

新状态与问题更新到现有状态页和活动计划，避免另建一份“当前执行入口”。新验收材料应放到 `docs/evidence/日期-主题/` 并说明提交、应用身份、真实操作及未覆盖项；不要长期依赖 `/tmp`。
