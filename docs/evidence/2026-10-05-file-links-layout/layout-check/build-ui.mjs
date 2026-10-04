import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const sourceInputs=new Map();
const digest=(p)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const record={name:'controlled-source-record',enforce:'pre',load(id){const p=id.split('?')[0];if(p.startsWith('/Users/tw/Desktop/farfold/src/')&&/\.(tsx?|css)$/.test(p))sourceInputs.set(p,digest(p));return null;}};
import { build } from '/Users/tw/Desktop/farfold/node_modules/vite/dist/node/index.js';
import react from '/Users/tw/Desktop/farfold/node_modules/@vitejs/plugin-react/dist/index.js';
await build({configFile:false,define:{"process.env.NODE_ENV":"\"production\""},root:process.cwd(),plugins:[record,react()],resolve:{alias:[
{find:"@tauri-apps/api/core",replacement:process.cwd()+"/fixture-core.ts"},
{find:"../runtime/sessions",replacement:process.cwd()+"/fixture-sessions.ts"},
{find:"@tauri-apps/api/event",replacement:process.cwd()+"/fixture-events.ts"},
{find:/^react$/,replacement:'/Users/tw/Desktop/farfold/node_modules/react/index.js'},
{find:/^react\/jsx-runtime$/,replacement:'/Users/tw/Desktop/farfold/node_modules/react/jsx-runtime.js'},
{find:/^react-dom\/client$/,replacement:'/Users/tw/Desktop/farfold/node_modules/react-dom/client.js'}]},
build:{outDir:'ui-dist',emptyOutDir:true,lib:{entry:'app.tsx',name:'HtmlLayoutProbe',formats:['iife'],fileName:()=> 'app.js',cssFileName:'app'},minify:false,rollupOptions:{output:{inlineDynamicImports:true}}}});

for(const [p,h]of sourceInputs)if(digest(p)!==h)throw new Error('source changed during bundle: '+p);
writeFileSync('ui-dist/source-inputs.json',JSON.stringify(Object.fromEntries([...sourceInputs].map(([p,h])=>[p.replace('/Users/tw/Desktop/farfold/',''),h])),null,2)+'\n');
