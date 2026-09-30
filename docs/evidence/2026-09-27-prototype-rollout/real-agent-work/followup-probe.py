"""Continue the existing Pi sample; separately test narrower Codex approval-mode persistence."""
import asyncio, importlib.util, json, os, sqlite3, datetime, subprocess, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('probe',ROOT/'acp-capability-probe.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

def config(agent):
    with sqlite3.connect('file:'+str(p.DB)+'?mode=ro',uri=True) as db:row=db.execute('select command,args,env from agents where id=?',(agent,)).fetchone()
    env=dict(os.environ);extra=json.loads(row[2]);env.update(extra)
    assert env.get('HOME')==str(Path.home())
    assert not any(str(v).startswith('__keychain__') for v in extra.values())
    return [row[0],*json.loads(row[1])],env

async def initialize(c):
    return await c.request('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-p1-probe','version':'0.1.7'},'clientCapabilities':p.CAPS})

async def pi_cold():
    old=json.loads((ROOT/'pi-probe.json').read_text());argv,env=config('pi')
    c=p.Client('pi','cold_load_existing',argv,env,Path(old['cwd']));await c.start()
    result={'agent':'pi','at':datetime.datetime.now().astimezone().isoformat(),'original_evidence':'pi-probe.json','original_first_prompt_note':'The initial probe counted the official startup prelude as reply text. Token arrived with end_turn and no tools; original strict aggregate result remains unchanged. This does not replay the first prompt.'}
    try:
        await initialize(c);c.sid=old['sessionId']
        loaded=await c.request('session/load',{'sessionId':c.sid,'cwd':old['cwd'],'mcpServers':[]},60);result['load']=p.clean(loaded)
        if not loaded or 'error' in loaded:return result
        current=p.selected(loaded['result'].get('configOptions',[]));result['selection']=current;result['same_selection']=current==old['initial_selection'];result['history_marker']=old['marker'] in c.text
        if result['same_selection']:
            c.text=''
            response=await c.request('session/prompt',{'sessionId':c.sid,'prompt':[{'type':'text','text':'Reply with only the exact token in my previous message. Do not use tools, inspect or modify files, execute commands, or change settings.'}]},120)
            result['continuation']={'response':p.clean(response),'exact_previous_marker':c.text.strip()==old['marker'],'text_chars':len(c.text),'response_excerpt':p.clean(c.text[:400]),'tools':c.tools}
        else:result['continuation']='not sent because selection changed or became unknown'
    finally:
        result['stage']=await c.close();(ROOT/'pi-cold-probe.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'agent':'pi','same_selection':result.get('same_selection'),'continuation':result.get('continuation')},ensure_ascii=False),flush=True)

async def codex_mode():
    argv,env=config('codex');cwd=ROOT/('codex-permission-'+uuid.uuid4().hex[:8]);cwd.mkdir()
    r={'agent':'codex','at':datetime.datetime.now().astimezone().isoformat(),'cwd':str(cwd),'operation':'new dedicated session; only narrower explicit human-approval mode; no tools; no global configuration edits','stages':[]}
    path=ROOT/'codex-permission-probe.json';c=p.Client('codex','mode_new',argv,env,cwd);await c.start();sid=None;baseline={};saved=False
    try:
        await initialize(c);opened=await c.request('session/new',{'cwd':str(cwd),'mcpServers':[]},60)
        if not opened or 'error' in opened:return r
        body=opened['result'];sid=body['sessionId'];c.sid=sid;r['sessionId']=sid;options=body.get('configOptions',[]);r['new_options']=p.clean(options);baseline=p.selected(options)
        mode=next((o for o in options if o.get('id')=='mode' and 'Approval and sandboxing' in o.get('description','')),None)
        target=next((x for x in (mode or {}).get('options',[]) if x.get('value')=='read-only' and x.get('name')=='Ask for approval'),None)
        if not target or mode.get('currentValue')!='agent':r['stopped']='Did not provide the verified narrower human-approval route';return r
        changed=await c.request('session/set_config_option',{'sessionId':sid,'configId':'mode','value':'read-only'})
        r['set_mode']=p.clean(changed)
        if not changed or 'error' in changed:return r
        returned=changed['result'].get('configOptions',[])
        if p.selected(returned)!=baseline:r['stopped']='model/thought changed';return r
        if next((o.get('currentValue') for o in returned if o.get('id')=='mode'),None)!='read-only':r['stopped']='mode not confirmed';return r
        c.text='';marker='FARFOLD-P1-PERMISSION-'+uuid.uuid4().hex[:8].upper()
        response=await c.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':f'Reply with only {marker}. Do not use tools, inspect or modify files, execute commands, or change settings.'}]},120)
        r['marker_reply']={'response':p.clean(response),'exact_marker':c.text.strip()==marker,'tools':c.tools};saved=bool(response and 'result' in response and c.text.strip()==marker and c.tools==0)
    finally:
        r['stages'].append(await c.close());path.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
    if saved:
        c=p.Client('codex','mode_cold_load',argv,env,cwd);await c.start()
        try:
            await initialize(c);c.sid=sid
            loaded=await c.request('session/load',{'sessionId':sid,'cwd':str(cwd),'mcpServers':[]},60);r['cold_load']=p.clean(loaded)
            if loaded and 'result' in loaded:
                options=loaded['result'].get('configOptions',[]);r['cold_selection']=p.selected(options);r['same_model_thought']=r['cold_selection']==baseline
                r['cold_mode']=next((o.get('currentValue') for o in options if o.get('id')=='mode'),None)
                r['permission_preserved']=r['cold_mode']=='read-only'
                r['post_load_prompt']='not sent; no escalation or reapplication'
        finally:r['stages'].append(await c.close());path.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'agent':'codex','permission_preserved':r.get('permission_preserved'),'cold_mode':r.get('cold_mode'),'same_model_thought':r.get('same_model_thought'),'output':str(path)},ensure_ascii=False),flush=True)
    return r

async def main():
    results=await asyncio.gather(pi_cold(),codex_mode(),return_exceptions=True)
    for result in results:
        if isinstance(result,Exception):print(json.dumps({'probe_exception':type(result).__name__,'detail':p.clean(str(result))}),flush=True)
asyncio.run(main())
