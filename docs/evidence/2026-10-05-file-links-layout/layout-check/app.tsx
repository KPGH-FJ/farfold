import {useState,useLayoutEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {MessageContent} from '/Users/tw/Desktop/farfold/src/components/MessageContent';
import {ArtifactPane} from '/Users/tw/Desktop/farfold/src/components/ArtifactPane';
import {browserSurfaceGuard} from '/Users/tw/Desktop/farfold/src/runtime/browser_surface';
import '/Users/tw/Desktop/farfold/src/styles.css';
import '/Users/tw/Desktop/farfold/src/styles-thread.css';
import '/Users/tw/Desktop/farfold/src/styles-content.css';
import '/Users/tw/Desktop/farfold/src/styles-artifact.css';
import '/Users/tw/Desktop/farfold/src/conversation-workspace.css';
import '/Users/tw/Desktop/farfold/src/desktop-workbench.css';
import './fixture-shell.css';
const w=window as any;
w.__layoutTrace=[];w.__layoutListeners=new Set();w.__layoutRaf=0;
const tick=()=>{w.__layoutRaf++;w.__layoutLastRaf=performance.now();requestAnimationFrame(tick)};requestAnimationFrame(tick);
function rect(el:any){if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};}
w.__layoutDOM=()=>({at:performance.now(),innerWidth,innerHeight,devicePixelRatio,visibility:document.visibilityState,raf:w.__layoutRaf,lastRaf:w.__layoutLastRaf,surface:rect(document.querySelector('.browser-workspace-surface')),controls:rect(document.querySelector('.browser-workspace-controls')),hint:rect(document.querySelector('.browser-workspace-controls > .browser-workspace-hint')),hintText:document.querySelector('.browser-workspace-controls > .browser-workspace-hint')?.textContent,phase:w.__layoutState?.phase,label:w.__layoutState?.label,statusText:document.querySelector('.browser-workspace-status')?.textContent,contentMode:w.__contentMode});
const fixtureRoot='/Users/tw/Documents/Codex/2026-10-03/task-3/html-workspace-followup-20261005/layout-check/fixture';
const source={};
const thread:any={key:'layout-controlled',cwd:fixtureRoot,items:[],artifactPaneTarget:null,artifactPaneSelection:null,artifactPaneOpen:true,fileDrafts:{},fileComments:{},queued:[]};
function App(){const [open,setOpen]=useState(true),[mode,setMode]=useState<'files'|'browser'>('browser'),[request,setRequest]=useState<any>(null);const seq=useRef(0);const returnFocusRef=useRef<HTMLElement|null>(null);w.__contentMode=mode;
 useLayoutEffect(()=>{w.__paneActions={setOpen,setMode};w.__layoutMounted=true;},[]);
 const openFile=(path:string,opener:HTMLElement)=>{w.__layoutTrace.push({stage:'file-click',path});returnFocusRef.current=opener;browserSurfaceGuard.runLatest(()=>{w.__layoutTrace.push({stage:'file-request-after-guard',path});setRequest({taskKey:thread.key,path,selection:++seq.current});setMode('files');setOpen(true);});};
 return <main className="product-app fixture-app"><header className="fixture-title">Farfold 文件链接 / 受控真实组件验证</header><section className="conversation-workspace fixture-workspace"><div className="thread-main fixture-chat"><h2>合成回复 · 没有用户数据</h2><MessageContent source={source} text={`做好了：[controlled.html](${fixtureRoot}/controlled.html)\n\n另一份：[alternate.html](${fixtureRoot}/alternate.html)\n\n文本：[notes.md](${fixtureRoot}/notes.md)`} onOpenFile={openFile}/><button id="fixture-show-content" onClick={()=>setOpen(true)}>展开内容（测试入口）</button></div><ArtifactPane thread={thread} open={open} active contentMode={mode} onContentModeChange={setMode} fileRequest={request} returnFocusRef={returnFocusRef} onBrowserStateChange={(state)=>{w.__layoutState=state;w.__layoutTrace.push({stage:'state',state,dom:w.__layoutDOM()});}}/></section></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
