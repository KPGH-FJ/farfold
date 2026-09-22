"""Official process config + ACP empty mcpServers, new/cold-load sample."""
import asyncio,importlib.util,json,os,sqlite3
from pathlib import Path
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('base',ROOT.parent/'2026-09-21-acceptance-fixes/probe.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base);base.ROOT=ROOT
CONFIG={'mcp':{'farfold_arithmetic':{'type':'local','command':['/usr/bin/python3','-u',str(ROOT/'mcp_fixture.py')],'enabled':True}}}
async def rpc(p,m,v,i):
 await p.acp(m,v,i);r=await p.response(i,90)
 if not r or 'result' not in r: raise RuntimeError(m+' failed')
 return r['result']
async def main():
 with sqlite3.connect('file:'+str(base.DB)+'?mode=ro',uri=True) as db:
  cmd,args,values=db.execute('select command,args,env from agents where id="opencode"').fetchone()
 env=dict(os.environ);env.update(json.loads(values));env['OPENCODE_CONFIG_CONTENT']=json.dumps(CONFIG,separators=(',',':'))
 (ROOT/'opencode-test-args.txt').write_text('OPENCODE_CONFIG_CONTENT='+env['OPENCODE_CONFIG_CONTENT']+' '+cmd+' '+' '.join(json.loads(args)))
 (ROOT/'project').mkdir(exist_ok=True)
 report=[];sid=None
 for phase in ['new','load']:
  p=base.Probe('opencode-config-'+phase);row={'phase':phase,'mcpServers':[]}
  try:
   await p.start([cmd,*json.loads(args)],env)
   await rpc(p,'initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-check','version':'1'},'clientCapabilities':{}},1)
   params={'cwd':str(ROOT/'project'),'mcpServers':[]}
   if sid:params['sessionId']=sid
   r=await rpc(p,'session/'+phase,params,2);sid=sid or r['sessionId'];row['sessionId']=sid
   row['config']={o['id']:o.get('currentValue') for o in r.get('configOptions',[]) if o.get('category') in ('model','thought_level')}
   if report and row['config']!=report[0]['config']:row['blocked_for_drift']=True;continue
   before=len((ROOT/'mcp-calls.jsonl').read_text().splitlines()) if (ROOT/'mcp-calls.jsonl').exists() else 0
   p.text='';r=await rpc(p,'session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Call only farfold_arithmetic multiply with a=9,b=7. Reply with exact product and fresh receipt. Do not read or modify files or use other tools.'}]},3)
   calls=[json.loads(l) for l in (ROOT/'mcp-calls.jsonl').read_text().splitlines()][before:] if (ROOT/'mcp-calls.jsonl').exists() else []
   row.update(stop=r.get('stopReason'),receipt_matches=any(c['receipt'] in p.text for c in calls),calls=len(calls))
  except Exception as e:row['error']=str(e)
  finally:
   await p.close();report.append(row);(ROOT/'opencode-config-result.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report),flush=True)
if __name__=='__main__':asyncio.run(main())
