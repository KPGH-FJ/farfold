# Dirac 0.5.17 模型读取失败：短只读核对

2026-10-01。对象为 [登记收据](dirac-registration.json)中的正式候选 `423aed4` 所装 `dirac-cli@0.5.17`。只读已装公开包源码、Farfold 关闭路径与[本批协议元数据](protocol-metadata-final.json)；未运行 Agent、认证、请求或应用，未读取用户配置、原始日志或凭据，未修改产品源码。本次固定模型读取失败的具体运行原因仍未知。

## 关闭接口没有发现具体不兼容

已装 `dist/source/cli/src/agent/DiracAgent.ts:1198` 广告 `sessionCapabilities.close: {}`，与收据一致。[AcpAgent.ts:408](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:dirac/install-vRKF11/node_modules/dirac-cli/dist/source/cli/src/acp/AcpAgent.ts:408>)确实实现标准 `closeSession`，交给 [DiracAgent.ts:2046](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:dirac/install-vRKF11/node_modules/dirac-cli/dist/source/cli/src/agent/DiracAgent.ts:2046>)释放资源后返回 `{}`，再移除订阅和初始化记录。

已装 JS SDK 的 [acp.js:1027](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:dirac/install-vRKF11/node_modules/@agentclientprotocol/sdk/dist/acp.js:1027>)按 `implementation.closeSession` 注册标准 `schema.AGENT_METHODS.session_close`。`AcpAgent.ts:283` 的 `dev.dirac/session.close` 仅是通往同一方法的扩展入口，并非唯一入口。Farfold [session.rs](../../../src-tauri/src/acp_client/session.rs)依据 close 能力发送关闭控制，[pump.rs:942](../../../src-tauri/src/acp_client/pump.rs#L942)发送 `session/close`；静态接口匹配，不能据扩展方法存在而归因标准关闭不受支持。

## 初始字段可出现，但不证明读取已完成

[DiracAgent.ts:1277](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:dirac/install-vRKF11/node_modules/dirac-cli/dist/source/cli/src/agent/DiracAgent.ts:1277>)的 `newSession` 生成配置选项并返回 `configOptions` 与 `modes`；[AcpAgent.ts:348](</Users/tw/Library/Application Support/ai.farfold.desktop/agents/registry:dirac/install-vRKF11/node_modules/dirac-cli/dist/source/cli/src/acp/AcpAgent.ts:348>)在该结果后订阅并安排设置更新。这条公开实现能解释界面先获得模型、Reasoning 与 Thinking 字段，但不能证明后续读取和准备流程成功，也没有依据把这些初始字段当成首发成功。

本批 Dirac 模型读取对应的 `protocol-v1-1790792141329-4.jsonl` 元数据记录 initialize 成功、`session/new` 成功及两次 `session/update`，未见协议错误或后续发出记录。诊断事件白名单没有专名 `session/close`，其发出将分类为 `other`；当前导出保留 `other`，该文件也没有相应发出项。因此这些元数据不能证明失败发生在关闭阶段，更不能恢复具体错误正文或判断认证、服务、模型选择及后续配置更新中的哪一项失败。

结论限于：本次模型读取已测失败，关闭接口静态匹配，没有确认可修的关闭兼容缺陷。保持实际模型和推理选择，暂不修改关闭路由，也不新增请求、配置或登录来推断根因。
