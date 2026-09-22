"""Read-only ACP restore of the dedicated prior test. Never sends continuation."""
import asyncio,importlib.util,json,os,sqlite3,re
from pathlib import Path
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('base',ROOT.parent/'2026-09-21-acceptance-fixes/probe.py');base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base);base.ROOT=ROOT
async def main():
 with sqlite3.connect('file:'+str(base.DB)+'?mode=ro',uri=True) as db:
  cmd,args,vals=db.execute('select command,args,env from agents where id="codex"').fetchone()
  cwd,sid=db.execute('select cwd,native_session_id from sessions where title="Reasoning restore readiness"').fetchone()
 env=dict(os.environ);env.update(json.loads(vals));p=base.Probe('restore-diagnosis');out={}
 try:
  await p.start([cmd,*json.loads(args)],env)
  await p.acp('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-check','version':'1'},'clientCapabilities':{}},1);await p.response(1,60)
  await p.acp('session/load',{'sessionId':sid,'cwd':cwd,'mcpServers':[]},2);r=await p.response(2,60)
  out={'error':r.get('error') if r else 'timeout','config':[{k:o.get(k) for k in ['id','category','currentValue']} for o in (r or {}).get('result',{}).get('configOptions',[])]}
 finally:await p.close()
 # Only this dedicated test's structured response; no history, config, or credentials.
 (ROOT/'restore-response.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out),flush=True)
asyncio.run(main())
