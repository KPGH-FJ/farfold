# 工作台状态与数据所有权审查

日期：2026-09-25。范围：App、导航、对话库、分组、草稿、文件内容、搜索与设置。产品源码只读；仅本证据文件写入。安装身份以同目录 [identity.json](identity.json) 为准。

审查先核对 `AGENTS.md`、`PRODUCT.md`、架构、状态、活动计划第 00 章与当前源码。下文将安装观察、确定性源码探针、已有测试和未复现风险分开；不把本次检查当成完整 J1–J6 验收。

## 确认问题

### P1：进行中或待回应的对话可从其他入口归档，并从活动入口消失

- 触发：在进行中或等待批准的对话中，通过顶栏更多操作或命令面板执行归档，再离开当前对话。
- 原因：对话库禁止归档非空闲对话，但顶栏和命令面板没有同样限制。归档字段一旦设为 `true`，列表计算先排除该行，侧栏的正在执行、需要处理数量也不再包含它。
- 影响：工作仍可继续执行，待处理请求仍可存在，但通常用于找回它的活动入口消失；用户必须改去已归档列表查找。没有证据表明归档会终止执行或删除历史。
- 源码：`src/App.tsx:241–249`；`src/components/CommandPalette.tsx:137–147`；`src/runtime/sidebar.ts:117–118,147–148`；`src/runtime/collections.ts:225–230`；`src/components/Sidebar.tsx:48–60`。对照限制在 `src/components/ConversationLibrary.tsx:335–343,495–499`。后端 `src-tauri/src/acp_client/session_commands.rs:457–468` 仅修改归档元数据，没有活动状态检查。
- 证据类别：**当前生产函数的纯内存确定性探针 + 源码已确认**。本轮没有归档真实运行任务，不标为安装端到端复现。
- 修复方向：统一所有归档入口的活动保护，并让待处理或运行中的对话不会被归档过滤吞掉。

### P1：正常退出并重启会丢失未发送草稿

- 触发：输入未发送内容，页面往返仍保留；正常退出 Farfold，再启动。
- 原因：`src/runtime/drafts.ts:20–25` 的草稿仅存进程内 `Map`，`64–69` 的新对话 Agent、目录和服务选择也仅在内存。`src/App.tsx:295–304` 冷启动重建页面状态，没有恢复草稿流程。
- 影响：未发送文字、附件及本次新对话选择没有重启恢复能力。源码中的按对话草稿隔离、迟到发送不清除新输入，解决的是本次运行内的状态保护，不能覆盖退出后恢复。
- 证据类别：**主审在当前安装版实证 + 源码一致**。页面往返见 [06-draft-navigation-retained.png](06-draft-navigation-retained.png)，重启后为空见 [07-draft-restart-lost.png](07-draft-restart-lost.png) 与 [AX 记录](07-draft-restart-lost-ax.txt)。本分支只读取这些证据，没有操作安装界面。
- 已有边界：`docs/architecture.md:11` 已明确记载重启不恢复草稿；这不是新发现的持久化实现回归，但仍是连续使用时的用户数据丢失缺口。
- 修复方向：明确草稿持久化及敏感附件边界，并提供可恢复草稿或退出时的明确保护。

### P2：侧栏与库内的同维度筛选叠加，产生误导的空结果

- 触发：侧栏选择 Codex，再在对话库的 Agent 下拉框选择 Pi。分组入口再选另一个分组，也存在相同结构。
- 原因：`src/components/ConversationLibrary.tsx:108–119` 同时要求满足外部 `filter` 与本地 `agent/group` 状态；`src/runtime/collections.ts:245–246` 分别做相等过滤。两者冲突时不可能匹配同一条记录。切换侧栏时本地下拉状态清空，但外部范围仍生效（`ConversationLibrary.tsx:82–89`）。
- 影响：标题保留 Codex、下拉显示 Pi，结果为零，容易被误解为历史不存在或查找失败。
- 证据类别：**主审在当前安装版复现 + 源码一致**。实测侧栏 Codex 19 条、Pi 7 条，组合后显示 Codex 标题、0 段、没有匹配；见 [05-conflicting-filters.png](05-conflicting-filters.png)。
- 修复方向：同一筛选维度使用一个权威值；改变下拉应更新侧栏范围及标题，或清晰呈现并允许移除当前限定。

## 已核对的边界与反例

- **删除分组不会删除对话。** `src/runtime/collections.ts:138–144` 只移除分组及其归属映射；`94–116` 串行写入 `conversationGroups.v1`，保存成功才发布新状态，失败保留旧状态并报错。`src/components/Sidebar.tsx:81–100,313–327` 有删除确认和可见失败提示。`ConversationLibrary.tsx:96–102` 对已删除分组回到全部。现有测试覆盖身份、目录不变及迟到成功/失败隔离，没有发现误删会话路径。
- **运行内草稿保护成立。** `src/runtime/drafts.ts:44–46` 只在仍是原发送快照时清空，`71–81` 的内容反馈只加入指定对话草稿，不自动发送。已运行的定向测试验证这些行为；不外推为重启恢复。
- **自动归档是临时视图计算。** `src/runtime/sidebar.ts:79–85,108–113` 只对本次运行中已观察到明确完成、足够旧且无待处理工作的记录生效，冷启动没有该内存状态时又出现在普通列表。这是源码明确的现有设计边界，不等同手工归档。探针同时否定“手动恢复一定无效”：恢复命令更新 `updated_at`（`session_commands.rs:467`），新时间会使其返回普通列表。
- **文件预览未发现新的权限泄漏。** `src/runtime/artifact_view.ts:146–158` 静态预览禁脚本、网络、子框架、表单与基础 URL，并清除导航属性；`src/components/FileArtifactView.tsx:228–243` 使用空 `sandbox` 和不发送 referrer 的 iframe。Markdown 链接和图片不直接外连（同文件 `36–51`）。输入参数保守标为片段，反馈只入对应草稿。此结论来自源码及已有测试，不是完整浏览器攻击面测试。
- **搜索能力有限。** 对话库检索标题、目录、Agent 与分组；对话顶栏只查当前已呈现内容，没有持久化全文搜索。这是能力范围，不标成缺失历史正文的存储错误。

## 未复现风险，不计入确认缺陷

重命名、收藏和归档命令分别 `get_session` 后再整行 `upsert_session`（`src-tauri/src/acp_client/session_commands.rs:428–434,445–451,462–468`），而 `src-tauri/src/meta_store.rs:426–434` 更新标题、配置、收藏与归档等全部字段。如果读取与写回间并发发生其他元数据更新，存在旧快照覆盖其他字段的可能。尚未构造符合当前命令调度的确定性竞态，也未在安装版复现，因此仅保留为需要核查的风险；不能声称已经丢失配置或整理结果。

## 纯内存探针

下面命令从当前 TypeScript 源码在内存转译并调用真实 `groupSidebarRows`；夹具只存在于本进程，没有调用 Tauri、真实 Agent、数据库或文件写入。它证明列表函数的结果，不证明安装 UI 的按钮操作或远端生命周期。

```sh
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const cache = new Map();
function sourceModule(name) {
  const file = path.resolve('src/runtime', name + '.ts');
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', js)(
    (id) => {
      if (id !== './session_types') throw new Error('Unexpected import: ' + id);
      return sourceModule('session_types');
    }, module, module.exports,
  );
  return module.exports;
}
const { groupSidebarRows } = sourceModule('sidebar');
const id = 'review-only';
const old = Date.now() - 10 * 86400000;
const row = { id, agentId: 'review-agent', cwd: '/review-only', nativeSessionId: 'review-native', title: 'Review fixture', pinned: false, archived: false, updatedAt: old };
const state = { key: id, running: true, items: [], queued: [], pendingPermissions: [], pendingElicitations: [] };
const live = new Map([[id, state]]);
const brief = (groups) => groups.flatMap(g => g.rows.map(r => ({ key: r.key, status: r.status })));
const archived = { ...row, archived: true };
const approval = new Map([[id, { ...state, running: false, pendingPermissions: [{ requestId: 'review-permission', status: 'pending' }] }]]);
console.log(JSON.stringify({
  runningBeforeArchive: brief(groupSidebarRows([row], live)),
  runningAfterArchive: brief(groupSidebarRows([archived], live)),
  runningArchivedTab: brief(groupSidebarRows([archived], live, { archived: true })),
  approvalAfterArchive: brief(groupSidebarRows([archived], approval, { attentionOnly: true })),
}));
const settled = new Map([[id, { ...state, running: false, items: [{ kind: 'settled', status: 'complete', time: old }] }]]);
console.log(JSON.stringify({
  autoArchivedLive: brief(groupSidebarRows([row], settled, { archived: true, autoArchiveDays: 7 })),
  afterRestart: groupSidebarRows([row], new Map(), { autoArchiveDays: 7 }).flatMap(g => g.rows.map(r => r.key)),
  manualRestoreWithUpdatedTime: brief(groupSidebarRows([{ ...row, updatedAt: Date.now() }], settled, { autoArchiveDays: 7 })),
}));
NODE
```

实际输出：

```json
{"runningBeforeArchive":[{"key":"review-only","status":"run"}],"runningAfterArchive":[],"runningArchivedTab":[{"key":"review-only","status":"run"}],"approvalAfterArchive":[]}
{"autoArchivedLive":[{"key":"review-only","status":"idle"}],"afterRestart":["review-only"],"manualRestoreWithUpdatedTime":[{"key":"review-only","status":"idle"}]}
```

## 定向回归

```sh
corepack pnpm test src/runtime/collections.test.ts src/runtime/drafts.test.ts src/runtime/artifact_view.test.ts src/components/FileArtifactView.test.tsx
```

2026-09-25 21:50 本地执行：4 个文件、27 项测试通过。覆盖分组元数据、异步动作归属、运行内草稿、文件内容与静态预览边界；没有针对本次三个问题新增测试或修改源码。测试通过不能否定上面的安装发现与生产函数反例。

## 阶段判断

这些模块已具备可操作的产品主体：共享对话与编辑器、跨页草稿、独立分组元数据、真实文件内容与受限预览，并有针对所有权的回归保护。当前属于**可连续试用的 Alpha、功能整合后的稳定性收口阶段**，尚不适合声称稳定 Beta 或完整产品出口：正常重启仍可丢未发送工作，活动对话可被另一归档入口隐藏，同维度筛选仍会互相冲突。优先统一状态及操作语义、保护未发送工作，再扩大功能面。全产品成熟度及真实 Agent 旅程以主审汇总为准。
