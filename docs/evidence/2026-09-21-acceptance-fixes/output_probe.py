"""Record only terminal-output shapes and known markers from registered Codex."""
import asyncio, json, os, sqlite3
import probe as base

class OutputProbe(base.Probe):
    async def read(self):
        async for line in self.proc.stdout:
            try: value=json.loads(line)
            except (ValueError,UnicodeDecodeError): continue
            if 'id' in value and ('result' in value or 'error' in value):
                self.responses[value['id']]=value
            update=value.get('params',{}).get('update',{})
            if update.get('sessionUpdate')=='tool_call':
                self.note(tool_start={'kind':update.get('kind'),'contentTypes':[c.get('type') for c in update.get('content',[])]})
            for name in ('terminal_output','terminal_output_delta'):
                output=update.get('_meta',{}).get(name)
                if output:
                    self.note(output_extension=name,keys=sorted(output),marker='FARFOLD-OUTPUT-SHAPE-OK' in output.get('data',''),terminal_matches_call=output.get('terminal_id')==update.get('toolCallId'))
            if 'method' in value and 'id' in value:
                await self.send({'jsonrpc':'2.0','id':value['id'],'result':{'outcome':{'outcome':'cancelled'}}})

async def main():
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro',uri=True) as db:
        row=db.execute("SELECT command,args,env FROM agents WHERE id='codex'").fetchone()
    env=dict(os.environ); env.update(json.loads(row[2]))
    p=OutputProbe('codex-output-shape')
    try:
        await p.start([row[0],*json.loads(row[1])],env)
        await p.acp('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-acceptance','version':'0.1.7'},'clientCapabilities':{}},1)
        assert 'result' in await p.response(1)
        await p.acp('session/new',{'cwd':str(base.ROOT/p.name),'mcpServers':[]},2)
        result=(await p.response(2,40))['result']
        model=next(o['currentValue'] for o in result['configOptions'] if o.get('category')=='model')
        assert model=='gpt-6-astra'
        await p.acp('session/prompt',{'sessionId':result['sessionId'],'prompt':[{'type':'text','text':"Only run printf 'FARFOLD-OUTPUT-SHAPE-OK\\n'. Do not read or change files. Then reply DONE."}]},3)
        response=await p.response(3,90)
        p.note(stopReason=(response or {}).get('result',{}).get('stopReason'))
    finally:
        await p.close()

if __name__=='__main__': asyncio.run(main())
