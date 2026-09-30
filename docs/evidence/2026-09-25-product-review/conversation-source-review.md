# 对话、恢复与生命周期只读审查

日期：2026-09-25。当前源码检查；未修改业务代码、用户配置、Agent 或模型，未由本子任务操作界面或发出真实请求。本文件是根任务明确授权的证据目录写入。

## P2：正常空闲回收被显示为结果未知

- 后端 `src-tauri/src/acp_client/manager.rs:193–205` 每分钟检查连接；`IDLE_TIMEOUT` 为 30 分钟。`lifecycle.rs:123–144` 只有无工作、无操作且足够空闲的 READY 连接才进入回收。因此这条路径不等于在途结果丢失。
- `manager.rs:478–486` 已识别 requested close，但仍无条件调用 `pump::notify_connection_lost`；`pump.rs:863–869` 给每个会话发同一个无原因字段的 `connectionLost`。
- `src/runtime/session_projection.ts:504–524` 无条件标记 connectionLost；无运行任务时不会添加 unknown 结束项，但 `src/runtime/sidebar.ts:41–48` / `sessions.ts` 的 needsAttention 仍把有历史的连接断开算为待处理。
- `src/components/ThreadView.tsx:312` 起直接显示“连接中断，结果未知”；`EmptyState.tsx:334–344,532–542` 对空的预开草稿也禁用发送并显示相同提示和重试。
- 根任务的当前安装观测：闲置约 10 小时后，已完成验收对话出现“1 等你回应”和未知结果；显式重连保留历史、清除计数且不自动发送。空白新对话也出现未知结果。对应 `01-idle-interrupted.png`、`04-new-conversation-stale.png` 及同轮 AX。该现象符合此路径；因为事件不带关闭原因，不能仅据截图排除具体这次连接也发生过外部退出。
- 建议：区分正常空闲/显式关闭与异常丢失；只有真实在途结果或未决交互才进入未知结果语义。空草稿应呈现待重新准备状态。

## P2：普通恢复先解锁，晚到回放会错序并与新回复合并

- `src-tauri/src/acp_client/session_commands.rs:41–43` 普通 session_open 仅发送 Channel 内容。后端 pump 已有接收注册和回放排空保证（`pump.rs:616–617`），但这是送入 Channel 的完成，不是渲染端消费完成。
- `src/runtime/sessions.ts:398–405,411–479` 只等 invoke 与本地索引读取，没有同 Channel 的回放完成标记；将返回前 buffered 的历史时间设为 0 后即返回 fresh state。`queue.ts:19–33` 因而允许发消息。
- 若旧历史晚于 open 返回：新消息先经 `sessions.ts:598–627` 加入列表，再收到的旧消息追加其后；旧消息被 `session_projection.ts:110–143` 赋当前时间。若旧历史最后为 agent chunk，紧接新回复 agent chunk 会合并为一条。
- 对比：`src/runtime/history_import.ts:75–85` 已明确处理独立 invoke/Channel 到达顺序，用匹配的完成标记等待 renderer 消费回放；普通打开/恢复没有该保证。
- 现有 `sessions.history.test.tsx:27` 与 `sessions.regression.test.ts:520` 覆盖 body 先到、invoke 后到，未覆盖反序。下面探针确定性复现反序，无 sleep。
- 建议：普通恢复也等待同一有序 Channel 的完成边界，再清理历史时间、结束历史流并允许用户续发；失败路径保留可恢复状态与连接所有权。不能用延迟代替边界。

## 纯内存复现

在仓库根运行以下命令。Vite 只用于加载当前 TypeScript 源码；Tauri invoke/Channel 完全替换为内存桩，middleware 模式不监听服务端口。没有真实 Tauri IPC、外部 Agent、网络请求、历史持久化或业务代码写入。第一项探针验证前端收到关闭事件后的结果；正常回收产生该事件由上述后端源码与现有生命周期测试佐证。第二项人为控制合法的 IPC 交付先后，证明此先后下的确定结果；不估计真实系统发生概率，也不声称本轮已在安装版重现该错序。

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createServer} from 'vite';
let channel;
const calls=[];
globalThis.__reviewIpc={invoke:async(cmd,args)=>{
 calls.push(cmd);
 if(cmd==='session_open'){channel=args.channel;return {cwd:'/review-probe',nativeSessionId:'late-replay',resumed:true,configOptions:[]};}
 if(cmd==='session_prompt')return {status:'accepted'};
 return cmd==='settings_get'?0:[];
}};
const server=await createServer({configFile:false,server:{middlewareMode:true,watch:null},optimizeDeps:{noDiscovery:true},ssr:{noExternal:['@tauri-apps/api']},plugins:[{name:'review-readonly-ipc',enforce:'pre',resolveId(id){if(id==='@tauri-apps/api/core')return '\0review-ipc';},load(id){if(id==='\0review-ipc')return 'export const invoke=(...args)=>globalThis.__reviewIpc.invoke(...args); export class Channel { onmessage=()=>{} }';}}]});
try {
 const {threads,freshThreadState,applyUpdate,applyTurnEnd,applyConnectionLost}=await server.ssrLoadModule('/src/runtime/sessions.ts');
 const done=freshThreadState('fixture:/review-probe:idle','fixture','/review-probe','idle');
 applyUpdate(done,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ALREADY COMPLETED'}});
 applyTurnEnd(done,{stopReason:'end_turn'});
 applyConnectionLost(done);
 const empty=freshThreadState('fixture:/review-probe:draft','fixture','/review-probe','draft');
 applyConnectionLost(empty);
 console.log('idle completed:',JSON.stringify({running:done.running,queued:done.queued.length,pendingPermissions:done.pendingPermissions.length,connectionLost:done.connectionLost,needsAttention:threads.needsAttention(done),settled:done.items.filter(i=>i.kind==='settled').map(i=>i.status)}));
 console.log('idle empty draft:',JSON.stringify({identity:empty.identity,items:empty.items.length,running:empty.running,connectionLost:empty.connectionLost}));
 assert.equal(threads.needsAttention(done),true);
 assert.equal(done.items.filter(i=>i.kind==='settled').at(-1).status,'done');
 const s=await threads.open({agentId:'fixture',cwd:'/review-probe',nativeSessionId:'late-replay'});
 console.log('open before replay:',JSON.stringify({items:s.items.length,reconnecting:s.reconnecting,connectionLost:s.connectionLost}));
 await threads.send(s.key,[{type:'text',text:'NEW USER REQUEST'}]);
 for(const [kind,text] of [['user','OLD USER HISTORY'],['agent','OLD ASSISTANT HISTORY'],['agent','NEW ASSISTANT REPLY']])channel.onmessage({update:{sessionUpdate:`${kind}_message_chunk`,content:{type:'text',text}}});
 const items=s.items.map(i=>({kind:i.kind,text:i.text,timeIsCurrent:typeof i.time==='number'&&i.time>0}));
 console.log('late replay items:',JSON.stringify(items));
 console.log('commands:',JSON.stringify(calls));
 assert.deepEqual(s.items.map(i=>i.text),['NEW USER REQUEST','OLD USER HISTORY','OLD ASSISTANT HISTORYNEW ASSISTANT REPLY']);
}finally{await server.close();delete globalThis.__reviewIpc;}
JS
```

实际输出（exit 0）：

```text
idle completed: {"running":false,"queued":0,"pendingPermissions":0,"connectionLost":true,"needsAttention":true,"settled":["done"]}
idle empty draft: {"identity":"draft","items":0,"running":false,"connectionLost":true}
open before replay: {"items":0,"reconnecting":false,"connectionLost":false}
late replay items: [{"kind":"user","text":"NEW USER REQUEST","timeIsCurrent":true},{"kind":"user","text":"OLD USER HISTORY","timeIsCurrent":true},{"kind":"agent","text":"OLD ASSISTANT HISTORYNEW ASSISTANT REPLY","timeIsCurrent":true}]
commands: ["session_open","session_index_list","session_index_list","settings_get","session_prompt"]
```

## 已跑针对验证

```text
corepack pnpm exec vitest run src/runtime/sessions.regression.test.ts src/runtime/sessions.test.ts src/runtime/sessions.history.test.tsx src/runtime/permission_shortcuts.test.ts src/runtime/history_import.test.ts
5 files, 75 passed, exit 0

cargo test --manifest-path src-tauri/Cargo.toml --locked acp_client -- --test-threads=4
59 passed, 2 ignored, 128 filtered out, exit 0
```

Rust 覆盖的是现有可控协议子进程/单元测试；两个需真实 Agent 的 e2e 默认忽略。通过项包括多来源路由隔离、并发交互、停止清理、配置漂移防发、放弃操作保留所有权、注册先于 load、批量回放先于导入完成标记、预览失败清理、退出等待子进程。不能据此宣布最新安装候选完整 J2–J5 通过；上述两项缺口不在既有覆盖内。

## 当前源码与旧恢复失败的边界

- `model_guard.rs:83–132,138–199` 仍比较已有模型/推理选择与恢复汇报值并阻止漂移；这证明保护已实现，不证明外部 Agent 已能恢复原选择。
- 本轮未重新请求旧 high→ultra 样本或 Pi 服务，不把旧报告当作本轮复现。最新文档中的 Codex ultra→ultra 成功，也不能覆盖旧 high 样本及其他服务。
- 根任务另已观察正常退出重启后草稿及 Agent 选择丢失；源码 `src/runtime/drafts.ts:20–25,64–69` 确实只有进程内 Map/对象。前台页面往返保留不代表跨重启持久化；此项不与上述回放错误混为一个原因。
