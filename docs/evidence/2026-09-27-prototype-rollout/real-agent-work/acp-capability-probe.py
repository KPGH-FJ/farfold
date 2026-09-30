"""Bounded ACP contract experiment. No config writes, credential reads, or client tools."""
import asyncio, collections, datetime, hashlib, json, os, re, signal, sqlite3, subprocess, sys, time, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent
DB=Path.home()/'Library/Application Support/ai.farfold.desktop/farfold.sqlite3'
CAPS={'auth':{'terminal':True},'elicitation':{'form':{}},'_meta':{'terminal-auth':True,'jetbrains':{'air':{'version':1,'capabilities':['sessionFailure']}}}}

def clean(value):
    if isinstance(value,dict):
        return {k:('[REDACTED]' if re.search(r'(secret|token|password|authorization|cookie|api.?key|credential)',k,re.I) else clean(v)) for k,v in value.items()}
    if isinstance(value,list): return [clean(v) for v in value]
    if isinstance(value,str):
        value=value.replace(str(Path.home()),'~')
        value=re.sub(r'(?i)(bearer\s+|api[_-]?key[=:\s]+|token[=:\s]+)[^\s,;\"\']+',r'\1[REDACTED]',value)
        value=re.sub(r'\b(?:sk-|eyJ)[A-Za-z0-9_./+-]{12,}', '[REDACTED]', value)
        value=re.sub(r'([?&](?:key|token|api_key|access_token)=)[^&\s]+',r'\1[REDACTED]',value)
        return value[:1200]
    return value

def selected(options):
    return {o['id']:{'category':o.get('category'),'value':o.get('currentValue')} for o in options if o.get('category') in ['model','thought_level'] or o.get('id') in ['model','reasoning_effort','thinking_level']}

class Client:
    def __init__(self,agent,stage,argv,env,cwd):
        self.agent,self.stage,self.argv,self.env,self.cwd=agent,stage,argv,env,cwd
        self.pending={};self.counter=0;self.counts=collections.Counter();self.notes=[];self.text='';self.sid=None;self.tools=0;self.configs=[];self.stderr=[]
    async def start(self):
        self.proc=await asyncio.create_subprocess_exec(*self.argv,cwd=self.cwd,env=self.env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,start_new_session=True,limit=2**22)
        self.started=time.monotonic();self.reader=asyncio.create_task(self.read());self.errreader=asyncio.create_task(self.readerr())
    def note(self,**kw): self.notes.append({'seconds':round(time.monotonic()-self.started,3),**clean(kw)})
    async def send(self,value):
        self.proc.stdin.write((json.dumps(value)+'\n').encode());await self.proc.stdin.drain()
    async def request(self,method,params,timeout=40):
        self.counter+=1;rid=self.counter;f=asyncio.get_running_loop().create_future();self.pending[rid]=f
        self.note(method=method,request_id=rid)
        await self.send({'jsonrpc':'2.0','id':rid,'method':method,'params':params})
        try:
            response=await asyncio.wait_for(asyncio.shield(f),timeout)
            self.note(response_id=rid,error=response.get('error'),result_keys=list(response.get('result',{})),stopReason=response.get('result',{}).get('stopReason'),meta=response.get('result',{}).get('_meta'))
            return response
        except asyncio.TimeoutError:
            self.note(timeout_method=method,timeout_seconds=timeout)
            if self.sid:
                await self.send({'jsonrpc':'2.0','method':'session/cancel','params':{'sessionId':self.sid}})
                try:
                    response=await asyncio.wait_for(asyncio.shield(f),5);self.note(after_cancel=response);return response
                except asyncio.TimeoutError: pass
            return None
    async def read(self):
        try:
            async for line in self.proc.stdout:
                try:v=json.loads(line)
                except Exception:self.counts['non_json']+=1;continue
                method=v.get('method');self.counts[method or 'response']+=1
                if not method and v.get('id') in self.pending:
                    f=self.pending[v['id']]
                    if not f.done():f.set_result(v)
                update=v.get('params',{}).get('update',{});kind=update.get('sessionUpdate')
                if kind:
                    self.counts[kind]+=1
                    if kind=='agent_message_chunk':self.text+=update.get('content',{}).get('text','')
                    if kind=='config_option_update':self.configs.append(clean(update.get('configOptions')))
                    if kind in ['tool_call','tool_call_update']:
                        self.tools+=1
                        self.note(unexpected_tool=kind,tool_kind=update.get('kind'),tool_status=update.get('status'))
                        if self.sid:await self.send({'jsonrpc':'2.0','method':'session/cancel','params':{'sessionId':self.sid}})
                    if update.get('_meta'):self.note(update_meta=update['_meta'])
                if method and 'id' in v:
                    self.note(agent_request=method)
                    if method=='session/request_permission':answer={'result':{'outcome':{'outcome':'cancelled'}}}
                    else:answer={'error':{'code':-32601,'message':'Client tools unavailable in read-only experiment'}}
                    await self.send({'jsonrpc':'2.0','id':v['id'],**answer})
        except Exception as e:self.note(reader_error=type(e).__name__)
    async def readerr(self):
        async for line in self.proc.stderr:
            self.counts['stderr_lines']+=1
            text=line.decode(errors='replace').strip()
            if re.search(r'error|fail|warn|exception|retry|refused|timeout',text,re.I) and len(self.stderr)<30:
                self.stderr.append(clean(text))
    async def close(self):
        group=self.proc.pid
        try:
            self.proc.stdin.close()
            await asyncio.wait_for(self.proc.wait(),4)
            mode='stdin_closed'
        except (asyncio.TimeoutError,BrokenPipeError,ConnectionResetError):
            mode='owned_process_group_term'
            if self.proc.returncode is None and os.getpgid(group)==group:os.killpg(group,signal.SIGTERM)
            try:await asyncio.wait_for(self.proc.wait(),3)
            except asyncio.TimeoutError:
                mode='owned_process_group_kill'
                if self.proc.returncode is None and os.getpgid(group)==group:os.killpg(group,signal.SIGKILL)
                await self.proc.wait()
        self.reader.cancel();self.errreader.cancel()
        rows=subprocess.check_output(['ps','-axo','pid=,pgid='],text=True).splitlines()
        survivors=[int(p) for p,g in (r.split() for r in rows) if int(g)==group]
        self.note(cleanup=mode,exit_code=self.proc.returncode,process_group_survivors=survivors)
        return {'stage':self.stage,'pid':group,'counts':dict(self.counts),'notes':self.notes,'stderr_error_samples':self.stderr,'config_updates':self.configs,'tool_updates':self.tools}

async def run(agent,row):
    env=dict(os.environ);extra=json.loads(row[2]);env.update(extra)
    if any(str(v).startswith('__keychain__') for v in extra.values()):raise RuntimeError('Keychain resolution is not authorized')
    assert env.get('HOME')==str(Path.home())
    argv=[row[0],*json.loads(row[1])];tag=uuid.uuid4().hex[:10]
    cwd=ROOT/(agent+'-'+tag);cwd.mkdir()
    marker='FARFOLD-P1-'+agent.upper()+'-'+tag.upper()
    result={'agent':agent,'at':datetime.datetime.now().astimezone().isoformat(),'cwd':str(cwd),'source':'registered command; inherited environment; no HOME or config override','marker':marker,'stages':[]}
    sid=None;initial={};first_success=False;can_load=False
    client=Client(agent,'new',argv,env,cwd);await client.start()
    try:
        init=await client.request('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-p1-probe','version':'0.1.7'},'clientCapabilities':CAPS})
        result['initialize']=clean((init or {}).get('result',{}));can_load=result['initialize'].get('agentCapabilities',{}).get('loadSession') is True
        if not init or 'error' in init:return result
        opened=await client.request('session/new',{'cwd':str(cwd),'mcpServers':[]},60)
        if not opened or 'error' in opened:return result
        body=opened['result'];sid=body['sessionId'];client.sid=sid;result['sessionId']=sid
        options=body.get('configOptions',[]);result['new_options']=clean(options);result['new_modes']=clean(body.get('modes'));initial=selected(options);result['initial_selection']=initial
        permission=next((o for o in options if 'approval' in o.get('description','').lower() and 'sandbox' in o.get('description','').lower()),None)
        if permission:
            reply=await client.request('session/set_config_option',{'sessionId':sid,'configId':permission['id'],'value':permission['currentValue']})
            result['permission_same_value_set']=clean(reply)
            if not reply or 'error' in reply:return result
            returned=reply['result'].get('configOptions',[])
            if selected(returned)!=initial:
                result['stopped']='same-value permission response changed model/thought';return result
        else:result['permission_same_value_set']='No explicit approval+sandbox option declared; no mode mutation attempted'
        if not any(v['category']=='model' or k=='model' for k,v in initial.items()):
            result['stopped']='Model selection not authoritatively supplied';return result
        prompt=f'Reply with only the exact token {marker}. Do not use tools, inspect or modify files, execute commands, change settings, or access external services beyond answering this message.'
        response=await client.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':prompt}]},120)
        result['first_prompt']={'response':clean(response),'exact_marker':client.text.strip()==marker,'text_chars':len(client.text),'text_sha256':hashlib.sha256(client.text.encode()).hexdigest(),'response_excerpt':clean(client.text[:300]),'tools':client.tools}
        first_success=bool(response and 'result' in response and response['result'].get('stopReason')=='end_turn' and client.text.strip()==marker and client.tools==0)
    finally:
        result['stages'].append(await client.close());(ROOT/(agent+'-probe.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    if not first_success or not can_load:
        result['cold_resume']='skipped because initial prompt was not successful or load unsupported'
    else:
        cold=Client(agent,'cold_load',argv,env,cwd);await cold.start()
        try:
            init=await cold.request('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-p1-probe','version':'0.1.7'},'clientCapabilities':CAPS})
            if not init or 'error' in init:return result
            cold.sid=sid
            loaded=await cold.request('session/load',{'sessionId':sid,'cwd':str(cwd),'mcpServers':[]},60)
            result['cold_load']=clean(loaded)
            if loaded and 'result' in loaded:
                current=selected(loaded['result'].get('configOptions',[]));result['cold_selection']=current;result['same_selection']=current==initial;result['history_marker']=marker in cold.text
                if current==initial:
                    cold.text=''
                    response=await cold.request('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':'Reply with only the exact token in my previous message. Do not use tools, read or modify files, execute commands, or change settings.'}]},120)
                    result['continuation']={'response':clean(response),'exact_previous_marker':cold.text.strip()==marker,'text_chars':len(cold.text),'response_excerpt':clean(cold.text[:300]),'tools':cold.tools}
                else:result['continuation']='not sent: model/thought drift or missing authority'
        finally:result['stages'].append(await cold.close())
    (ROOT/(agent+'-probe.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'agent':agent,'first':result.get('first_prompt'),'same_selection':result.get('same_selection'),'continuation':result.get('continuation'),'output':str(ROOT/(agent+'-probe.json'))},ensure_ascii=False),flush=True)
    return result

async def main():
    names=sys.argv[1:] or ['codex','opencode','pi']
    with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as db:rows={aid:(cmd,args,env) for aid,cmd,args,env in db.execute('select id,command,args,env from agents') if aid in names}
    results=await asyncio.gather(*(run(a,rows[a]) for a in names),return_exceptions=True)
    for a,r in zip(names,results):
        if isinstance(r,Exception):print(json.dumps({'agent':a,'probe_exception':type(r).__name__,'message':clean(str(r))}),flush=True)

if __name__=='__main__':asyncio.run(main())
