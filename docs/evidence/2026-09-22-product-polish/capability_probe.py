"""Read-only config, bounded real ACP probes. Never persist raw messages or env."""
import asyncio, importlib.util, json, os, sqlite3
from pathlib import Path
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('probe',ROOT.parent/'2026-09-21-acceptance-fixes/probe.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
base.ROOT=ROOT
caps={'auth':{'terminal':True},'elicitation':{'form':{}},'_meta':{'terminal-auth':True,'jetbrains':{'air':{'version':1,'capabilities':['sessionFailure']}}}}
PROMPT='Use the already configured node_repl MCP tool to evaluate 6*7 and print FARFOLD-MCP-42. Do not use other tools, browse, modify files, inspect credentials, or change settings. If that MCP tool is unavailable reply MCP-UNAVAILABLE.'
async def agent_probe(agent):
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro',uri=True) as db:
        row=db.execute('SELECT command,args,env FROM agents WHERE id=?',(agent,)).fetchone()
    env=dict(os.environ);env.update(json.loads(row[2]));argv=[row[0],*json.loads(row[1])]
    assert not any(v.startswith('__keychain__') for v in env.values()),'requires_keychain_resolution'
    sid=None;model=None;cwd=ROOT/('w3-'+agent+'-new');cwd.mkdir(exist_ok=True)
    for phase in ['new','load']:
        if phase=='load' and not sid:break
        p=base.Probe('w3-'+agent+'-'+phase)
        try:
            await p.start(argv,env)
            await p.acp('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-capability-check','version':'0.1.7'},'clientCapabilities':caps},1)
            init=(await p.response(1,30))['result']
            p.note(capabilities=init.get('agentCapabilities'),auth=[{'id':m.get('id'),'type':m.get('type'),'envDeclared':bool(m.get('_meta',{}).get('api-key',{}).get('env'))} for m in init.get('authMethods',[])])
            params={'cwd':str(cwd),'mcpServers':[]}
            if phase=='load':params['sessionId']=sid
            await p.acp('session/'+phase,params,2)
            result=(await p.response(2,45))['result'];sid=result.get('sessionId',sid)
            options=[{k:o.get(k) for k in ['id','category','currentValue']} for o in result.get('configOptions',[])]
            p.note(options=options)
            actual=next((o['currentValue'] for o in options if o['category']=='model'),None)
            if phase=='new':model=actual
            elif model!=actual:
                p.note(model_drift=True,continuation_blocked=True);continue
            prompt=PROMPT if agent=='codex' else 'Reply only FARFOLD-CAPABILITY-OK. Do not use tools or modify files.'
            p.text=''
            await p.acp('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':prompt}]},3)
            response=await p.response(3,120)
            p.note(promptFinished=response is not None,stopReason=(response or {}).get('result',{}).get('stopReason'),mcpMarker='FARFOLD-MCP-42' in p.text,unavailable='MCP-UNAVAILABLE' in p.text,basicMarker='FARFOLD-CAPABILITY-OK' in p.text)
        except Exception as e:p.note(exception=type(e).__name__)
        finally:await p.close()
async def main():
    for agent in ['opencode','codex','pi']:await agent_probe(agent)
if __name__=='__main__':asyncio.run(main())
