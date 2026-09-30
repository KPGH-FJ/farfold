# M6 通用版本诊断与候选交互

2026-09-30；前端起点 `5a63463`，本记录对应其后的工作区差异。正式应用、账号、日常程序及全量检查由根任务负责；以下仅为前端实现与受控回归，不替代真实安装、版本探测、程序选用或请求验证。

## 已实现

- 共用 [AgentPrerequisites](../../../src/components/AgentPrerequisites.tsx) 显示实际程序版本、接入组件版本、官方要求及出处、满足/不满足/未知结果。缺少声明时不发明要求；版本诊断不参与程序 `ready` 或安装依赖布尔判定，低于要求仍可尝试。
- 显式“重新检查”通过现有 `agent_preparation` 传 `refresh=true`。打开页面只读准备信息；不会自动安装、连接或发送测试。
- 新“安装兼容候选”独立依赖 `canInstallCandidate`，即使已有程序为 ready 也可操作。它使用既有依赖安装与取消所有权，传 `mode=prepare_candidate`，跳过会断开连接并使准备失效的 `onBeforeInstall`。原缺失程序安装仍走 `install_missing` 和原保护。
- 候选成功只显示“已安装，尚未选用”。[AgentSetup](../../../src/components/AgentSetup.tsx) 的安装完成回调并行刷新目录与程序清单；目录刷新失败时，本地清单仍会尝试读取。不会应用全局草稿选择、读取新模型或自动发消息。
- [ProgramManager](../../../src/components/ProgramManager.tsx) 对未选程序显示“尚未选用”，仍沿用“使用这份程序”动作；连接未断开时保持既有选用限制。检查完成前保留原选择；用户可明确回选旧程序。程序版本与组件版本继续分开。
- 安装已成功但后续刷新失败时，保留已安装提示并报告清单刷新失败，避免把它写成安装失败。安装失败/取消仍保留原诊断、允许重试，不产生已安装声明。
- `access_strings.untestedReturnHint` 改为“当前选择尚无成功回复；请按测试结果继续准备。”，覆盖未测及已失败两种情况。

## 与后端对齐的字段

[runtime/preparation.ts](../../../src/runtime/preparation.ts) 对 `AgentDependency` 增加可选字段，旧返回值仍可读：

```ts
programVersion?: string | null;
componentVersion?: string | null;
versionRequirement?: {
  componentVersion: string | null;
  range: string;
  sourceUrl: string;
  state: "satisfied" | "unsatisfied" | "unknown";
} | null;
canInstallCandidate?: boolean;
```

准备读取增加可选 `refresh`；依赖安装增加 `mode: install_missing | prepare_candidate`，缺省使用旧模式。程序清单与显式选用/卸载 IPC 未变，前端不处理内部 Node 启动收据，也没有 Agent 品牌判断或版本阈值。

动作设计依据见[兼容性调查](../2026-09-30-agent-access-mechanisms/compatibility/README.md)。下载来源、版本解析、要求适用范围、候选发布、取消/回收及选用前再检查均由后端负责；本组前端受控响应不能证明这些后端行为。

## 已验证

[红测](frontend-red.log)：新增用例先复现版本信息不可见、ready 程序无候选动作等 6 处缺失；原 8 例依赖安装回归通过。

[绿测](frontend-green.log)：8 个定向文件共 75 例通过，包含状态/副作用测试、实际组件回调组合、既有选择与对话返回回归、字符串检查。

```sh
corepack pnpm exec vitest run src/components/AgentPrerequisites.install.test.tsx src/runtime/preparation.test.ts src/components/ProgramManager.test.tsx src/components/ProgramManager.selection.test.tsx src/components/AgentSetup.contract.test.tsx src/components/AgentSetup.selection.test.tsx src/components/AgentSetup.repair.test.tsx src/runtime/strings.test.ts
```

本片新增覆盖：

- 三种版本结论均不改变可执行程序的使用 readiness；明确重查传递刷新标志；未声明规则不虚构要求或安装动作。
- ready 程序可准备候选，重复点击只启动一次；同 Agent 候选与普通安装共用取消所有权。
- 候选取消在安装结果落定前保持忙状态；失败后旧版本仍可见，重试成功才显示未选候选。
- 候选安装不调用断开/选择/打开会话/消息请求；安装完成刷新不使当前准备失效、不修改原选择；目录刷新失败不跳过本地清单刷新。
- 连接中的程序不能被界面直接选换；断开后明确选用，检查期间原选择保留，成功可回选，失败保留两份程序和原选择。
- 已失败短测使用中性提示，不再声称从未测试。

本片文件格式与差异空白检查通过；`AgentSetup.tsx` 为 1386 行，其余修改文件也低于 1500 行。没有新建依赖、环境开关、品牌面板或持久操作账本。

根任务整合检查：首次全量测试 925 例通过、1 例因 `AgentHub.test.tsx` 仍断言旧“尚未测试实际回复”文案失败（[日志](final-frontend-1.log)）。对应断言更新为“当前选择尚无成功回复”后，116 个文件共 926 例通过，类型与生产前端构建通过，见[完整收据](checks-verified-frontend.json)。这项失败属于旧文案断言未同步，没有据此修改功能或请求判定。

## 尚未验证

正式安装版的 Pi 实际版本显示、候选下载/取消、已连接时安装候选不中断任务、显式选用与回选、原模型/推理保留、同选择首发及冷恢复，均等待根任务使用同一候选复验。本记录不把官方支持范围满足、安装完成或组件连接成功称为真实回复成功；前序 Pi 请求失败仍保留为独立问题。
