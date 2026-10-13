import primaryCaptures from './captures.json';
import supplement from '../2026-10-14-docx-search-independent/supplement-capture.json';
const captures=[...primaryCaptures,supplement];
import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import App from'/src/App';import{DraftStartup}from'/src/components/DraftStartup';import{StorageStartup}from'/src/components/StorageRecovery';import{threads,freshThreadState}from'/src/runtime/sessions';import{composerDrafts,newConversationChoice,draftPersistence,fileFeedbackDrafts}from'/src/runtime/drafts';
import {attachmentSearch}from'/src/runtime/attachment_search';
import '@xterm/xterm/css/xterm.css';import'/src/styles.css';import'/src/styles-settings.css';import'/src/styles-content.css';import'/src/styles-thread.css';import'/src/styles-artifact.css';import'/src/product-shell.css';import'/src/conversation-workspace.css';import'/src/history-import.css';import'/src/desktop-workbench.css';
const w=window as any,clone=(v:any)=>structuredClone(v),settings=new Map<string,any>(),seed=w.fixtureSeed??{},held:any[]=[];
if(seed.budget)captures.push(...(await import('./budget-captures.json')).default);
const agent={id:'attachment-fixture',name:'Controlled attachment Agent',source:'custom',command:'/controlled/never-executed',args:[],env:[],version:null,handshake:null,createdAt:1,updatedAt:1};
const rows=['A','B','COLD'].map((n,i)=>({id:'attachment-'+n,agentId:agent.id,cwd:'/controlled',nativeSessionId:'native-'+n,title:'P32_'+n,configOptions:null,pinned:false,archived:false,createdAt:1,updatedAt:10-i}));
const values:any={'a.txt':'北京 😀 needle <img src="https://example.invalid/P32"> <script>window.BAD=1</script>\nNeedLE second','z.txt':'This full file has no matching term.','folded.txt':'folded needle original','bad.txt':'bad\0needle','unsupported.bin':'invalid UTF8 placeholder','huge.txt':'too large','one.txt':'needle'+'x'.repeat(1024*1024-6)};
if(seed.flood)values['a.txt']='needle '.repeat(250);
if(seed.aggregate)for(let i=0;i<(seed.aggregateCount??17);i++)values['large'+i+'.txt']=values['one.txt'];
const files=new Map<string,any>();for(const[name,text]of Object.entries(values)){const bytes=new TextEncoder().encode(text as string),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');const path='/controlled/'+name;files.set(path,{root:'/controlled',path,resolvedPath:path,name,size:bytes.length,sha256,version:'controlled-'+name});}
for(const capture of captures)files.set(capture.file.path,capture.file);
let mode:any={hold:false,stage:'inspect',changed:false,pending:false},active=0,maxActive=0;
const response=async(stage:string,value:any)=>{active++;maxActive=Math.max(maxActive,active);try{return mode.hold&&mode.stage===stage?await new Promise(resolve=>held.push({resolve,value:clone(value)})):clone(value);}finally{active--;}};
w.testInvoke=async(cmd:string,args:any)=>{
 const {channel,...captured}=args??{};w.calls.push({cmd,args:clone(captured)});
 if(cmd==='settings_get')return args.key==='autoArchiveDays'?0:settings.get(args.key)??null;
 if(cmd==='settings_set'){settings.set(args.key,clone(args.value));return;}
 if(cmd==='storage_recovery_status')return{ready:true,issue:null,dataDirectory:'/controlled/data',databaseReplacementAvailable:false,databaseReplacement:null};
 if(cmd==='app_initial_snapshot')return{agents:[agent],settings:{}};
 if(cmd==='app_default_working_directory')return '/controlled';
 if(cmd==='session_index_list')return clone(rows);
 if(['catalog_list','catalog_scan','credential_list','desktop_notification_take_pending','prompt_templates_list','agent_status'].includes(cmd))return[];
 if(['app_drafts_ready','host_performance_sample','session_mark_read','session_index_mark_read','plugin:event|unlisten'].includes(cmd))return;
 if(cmd==='host_performance_origin')return null;if(cmd==='plugin:event|listen')return 1;
 if(cmd==='agent_work_get')return{cwd:args.cwd,enabled:{},locationEnabled:true};
 if(cmd==='desktop_notifications_get')return{enabled:false,successEnabled:false,sound:false};
 if(cmd==='worktree_list')return{locations:[],archives:[],recoveries:[],materials:[],operation:null};
 if(cmd==='browser_share_status')return{taskKey:args.taskKey,label:args.label,agentId:agent.id,phase:'unshared',revision:0,reason:null,pendingRequest:null};
 if(cmd==='file_delivery_inspect_text'){if(mode.pending)throw{code:'pending'};if(args.path.endsWith('/huge.txt'))throw{code:'tooLarge'};const f=files.get(args.path);if(!f)throw{code:'missing'};return response('inspect',f);}
 if(cmd==='file_delivery_read_docx_search'){if(mode.docxError)throw{code:mode.docxError};const capture=captures.find(c=>c.file.path===args.file.path);if(!capture)throw{code:'unreadable'};return response('capture',{...capture,file:{...capture.file,...(mode.captureChanged?{version:'other-version'}:{})}});}
 if(cmd==='file_delivery_read_text'){if(args.file.name==='unsupported.bin')throw'此文件无法作为文字预览，请另存或使用其他应用打开';return response('read',{file:args.file,text:values[args.file.name]});}
 if(cmd==='file_delivery_check_text_revision'&&mode.checkError)throw{code:mode.checkError};
 if(cmd==='file_delivery_check_text_revision')return response('check',{kind:'verified',file:{...args.file,...(mode.changed?{version:'changed'}:{})}});
 w.unexpected.push(cmd);throw Error('Unexpected P32 controlled IPC '+cmd);
};
await draftPersistence.load();newConversationChoice.cwd=null;newConversationChoice.agentId=null;
const attach=(name:string)=>({name,kind:'resource_link',uri:'file:///controlled/'+name});
const a=freshThreadState(rows[0].id,agent.id,'/controlled','native-A');a.identity='established';a.title='P32_A';a.items=[{kind:'user',id:'A-message',text:'KEEP_A_MESSAGE',time:1,streaming:false,attachments:seed.budget?['budget-a.docx','budget-b.docx','a.txt'].map(attach):seed.aggregate?Array.from({length:seed.aggregateCount??17},(_,i)=>attach('large'+i+'.txt')):[attach('author.docx'),attach('second.docx'),attach('image-and-cell-barriers.docx'),attach('a.txt'),{name:'remote.txt',uri:'https://example.invalid/remote.txt'},{name:'received-only.txt',text:'needle already received'},attach('z.txt'),attach('folded.txt')]}];
const b=freshThreadState(rows[1].id,agent.id,'/controlled','native-B');b.identity='established';b.title='P32_B';b.items=[{kind:'agent',id:'B-message',text:'KEEP_B_MESSAGE',time:1,streaming:false,attachments:['bad.txt','unsupported.bin','huge.txt','one.txt'].map(attach)}];
threads.getSnapshot().threads.set(a.key,a);threads.getSnapshot().threads.set(b.key,b);
composerDrafts.update('session:'+a.key,()=>({text:'P32_KEEP_UNSENT',attachments:[]}));fileFeedbackDrafts.update(a.key,'/controlled/opinion.txt',{text:'P32_KEEP_OPINION',selection:null});await draftPersistence.flush();const protectedValue=JSON.stringify({draft:composerDrafts.read('session:'+a.key),opinion:fileFeedbackDrafts.entries(a.key)});
w.fixture={current:()=>({workers:clone(w.workerEvents),calls:clone(w.calls),unexpected:clone(w.unexpected),held:held.length,active,maxActive,search:clone(attachmentSearch.snapshot()),busy:attachmentSearch.busy(),protectedUnchanged:JSON.stringify({draft:composerDrafts.read('session:'+a.key),opinion:fileFeedbackDrafts.entries(a.key)})===protectedValue}),mode:(value:any)=>Object.assign(mode,value),release:()=>{mode.hold=false;held.splice(0).forEach(p=>p.resolve(p.value));},sourceChange:()=>{a.items[0]={...a.items[0],attachments:[...a.items[0].attachments]};(threads as any).emit();},indexChange:async()=>{rows[0]={...rows[0],cwd:'/other'};await threads.refreshIndex();},refresh:()=>threads.refreshIndex(),forget:()=>{threads.getSnapshot().threads.delete(a.key);(threads as any).emit();},files:()=>Object.fromEntries(files)};
createRoot(document.getElementById('root')!).render(<StrictMode><StorageStartup><DraftStartup><App/></DraftStartup></StorageStartup></StrictMode>);
