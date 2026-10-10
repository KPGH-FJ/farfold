import React,{StrictMode,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {extensionInventory} from '/src/runtime/extension_inventory_controller';
import {skillManagement} from '/src/runtime/skill_management_controller';
import {AgentExtensionInventoryResult} from '/src/components/AgentExtensionInventoryResult';
import {SkillChangeReview} from '/src/components/SkillChangeReview';
import '/src/styles.css';import '/src/styles-settings.css';import '/src/desktop-workbench.css';
import '/src/components/AgentExtensionInventory.css';
const w=window as any;
const wire=await fetch('/docs/evidence/2026-10-09-capability-hardening/skill-management/backend/actual-wire.json').then(r=>r.json());
const mode=new URLSearchParams(location.search).get('mode')??'normal';
const ops=Object.fromEntries(wire.operations.map((x:any)=>[x.label,x.value]));
const inspection=ops[mode==='unknown'?'confirmUnknownInspection':'inspectReady'];
const confirmed=ops[mode==='unknown'?'confirmUnknown':'confirmVerified'];
const checked=ops[mode==='unknown'?'unknownReadonlyObserved':'readonlyObserved'];
const ids=[wire.inventory.requestId,inspection.requestId,confirmed.requestId,checked.requestId];
// Replay original serialized identities and expiry using a controlled clock, never alter wire values.
crypto.randomUUID=()=>{const id=ids.shift();if(!id)throw Error('unexpected identity allocation');return id;};
Date.now=()=>inspection.review.observedAtMs+1000;
let live=true,statusValue=confirmed;
const owner={agentId:wire.inventory.agentId,token:{},current:()=>live};
const expected=(condition:boolean)=>{if(!condition)throw Error('wire request mismatch');};
w.calls=[];
w.testInvoke=async(cmd:string,args:any)=>{
 w.calls.push({cmd,args});
 expected(args.agentId===owner.agentId);
 if(cmd==='agent_extension_inventory_read'){expected(args.requestId===wire.inventory.requestId&&args.cwd===wire.inventory.cwd&&args.kind==='skills');return wire.inventory;}
 if(cmd==='agent_extension_inventory_cancel')return{agentId:args.agentId,requestId:args.requestId,cancelRequested:true,operation:wire.inventory};
 if(cmd==='agent_skill_change_inspect'){expected(args.requestId===inspection.requestId&&args.inventoryRequestId===wire.inventory.requestId&&args.itemId===inspection.target.itemId);return inspection;}
 if(cmd==='agent_skill_change_confirm'){expected(args.requestId===confirmed.requestId&&args.reviewId===inspection.review.reviewId);return mode==='normal'?ops.confirmPendingCleanup:confirmed;}
 if(cmd==='agent_skill_change_status'){expected(args.requestId===confirmed.requestId);return statusValue;}
 if(cmd==='agent_skill_change_recheck'){expected(args.requestId===checked.requestId&&args.operationId===confirmed.requestId);return checked;}
 if(cmd==='agent_skill_change_cancel')return{agentId:args.agentId,requestId:args.requestId,cancelRequested:true,operation:null};
 throw Error('unexpected wire command '+cmd);
};
extensionInventory.begin(owner,wire.inventory.cwd,wire.inventory.requestId,'skills');
function Fixture(){const state=useSyncExternalStore(extensionInventory.subscribe,()=>extensionInventory.get(owner.agentId));const result=state.results.skills;return <main style={{maxWidth:600,padding:16,margin:'auto'}}><h1>Controlled Rust serialization replay</h1>{result&&<AgentExtensionInventoryResult result={result} stale={result.stale} management={{enabled:extensionInventory.isCurrentResult(owner,result),inspect:item=>skillManagement.inspect({owner,result,item,current:()=>extensionInventory.isCurrentResult(owner,result),changed:()=>extensionInventory.markStale(result)})}}/>}<SkillChangeReview agentId={owner.agentId} owner={owner} active={true}/></main>;}
w.wireFixture={current:()=>({calls:w.calls,view:skillManagement.get(owner.agentId),inventory:extensionInventory.get(owner.agentId),mode}),missing:()=>{statusValue=ops.readonlyMissing;},close:()=>{live=false;extensionInventory.retire(owner);skillManagement.retire(owner);}};
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);
