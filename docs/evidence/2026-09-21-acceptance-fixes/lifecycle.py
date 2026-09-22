"""Real registered ACP lifecycle checks; no config files or credentials recorded."""
import asyncio,json,os,sqlite3
import probe as base

async def lifecycle(agent,model):
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro',uri=True) as db:
        row=db.execute('SELECT id,command,args,env FROM agents WHERE id=?',(agent,)).fetchone()
    env=dict(os.environ);env.update(json.loads(row[3]));argv=[row[1],*json.loads(row[2])]
    name=agent+'-lifecycle';p=base.Probe(name);sid=None
    caps={'auth':{'terminal':True},'_meta':{'terminal-auth':True,'jetbrains':{'air':{'version':1,'capabilities':['sessionFailure']}}}}
    try:
        await p.start(argv,env)
        await p.acp('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-acceptance','version':'0.1.7'},'clientCapabilities':caps},1);await p.response(1)
        await p.acp('session/new',{'cwd':str(base.ROOT/name),'mcpServers':[]},2)
        result=(await p.response(2,40))['result'];sid=result['sessionId']
        opts=result.get('configOptions',[])
        p.note(options=[{k:o.get(k) for k in ('id','category','currentValue')} for o in opts])
        o=next(o for o in opts if o.get('category')=='model' or o['id']=='model')
        if o['currentValue']!=model:
            await p.acp('session/set_config_option',{'sessionId':sid,'configId':o['id'],'value':model},10)
            configured=await p.response(10,30)
            assert configured and 'result' in configured,'selected_model_not_available'
            p.note(selected_model=model)
        p.text='';p.marker.clear()
        await p.acp('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':f'Reply only {base.MARKER}. Do not use tools or modify files.'}]},3)
        result=await p.response(3,90)
        p.note(first_reply_marker=base.MARKER in p.text, first_stop=(result or {}).get('result',{}).get('stopReason'))
        before=p.counts['update:tool_call']
        await p.acp('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Run the harmless shell command sleep 20, then reply WAIT-DONE. Do not modify files.'}]},4)
        for _ in range(150):
            if p.counts['update:tool_call']>before or 4 in p.responses:break
            await asyncio.sleep(.1)
        await p.acp('session/cancel',{'sessionId':sid});p.note(cancel_sent=True)
        result=await p.response(4,45)
        p.note(cancel_stop=(result or {}).get('result',{}).get('stopReason'))
    except Exception as e:p.note(probe_exception=type(e).__name__)
    finally:await p.close()
    if not sid:return
    r=base.Probe(agent+'-reload')
    try:
        await r.start(argv,env)
        await r.acp('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-acceptance','version':'0.1.7'},'clientCapabilities':caps},1);await r.response(1)
        await r.acp('session/load',{'cwd':str(base.ROOT/name),'sessionId':sid,'mcpServers':[]},2)
        result=(await r.response(2,45))['result']
        r.note(restored_options=[{k:o.get(k) for k in ('id','category','currentValue')} for o in result.get('configOptions',[])])
        restored_model=next((o.get('currentValue') for o in result.get('configOptions',[]) if o.get('category')=='model'),None)
        if restored_model != model:
            r.note(model_drift=True, continuation_blocked=True)
            return
        r.text='';r.marker.clear()
        await r.acp('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':f'Reply only {base.MARKER}. No tools.'}]},3)
        result=await r.response(3,90)
        r.note(restored_reply_marker=base.MARKER in r.text, restored_stop=(result or {}).get('result',{}).get('stopReason'))
    except Exception as e:r.note(probe_exception=type(e).__name__)
    finally:await r.close()

async def main():await lifecycle('pi','zai-coding-cn/glm-4.5-air')
if __name__=='__main__':asyncio.run(main())
