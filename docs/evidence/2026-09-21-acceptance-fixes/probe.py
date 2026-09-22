"""Bounded real-process diagnosis; no application/config edits or raw-content logs."""
import asyncio
import collections
import datetime
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
DB = Path.home() / 'Library/Application Support/ai.farfold.desktop/farfold.sqlite3'
MARKER = 'FARFOLD-DIAG-OK'


class Probe:
    def __init__(self, name):
        self.name = name
        self.started = time.monotonic()
        self.events = []
        self.responses = {}
        self.counts = collections.Counter()
        self.marker = asyncio.Event()
        self.agent_end = asyncio.Event()
        self.text = ''

    def note(self, **value):
        self.events.append(dict(seconds=round(time.monotonic()-self.started, 3), **value))

    async def start(self, argv, env):
        cwd = ROOT / self.name
        cwd.mkdir(exist_ok=True)
        self.proc = await asyncio.create_subprocess_exec(*argv, cwd=cwd, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=2**22)
        self.reader = asyncio.create_task(self.read())
        self.note(action='spawn', pid=self.proc.pid)

    async def read(self):
        async for line in self.proc.stdout:
            try:
                value = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                self.counts['non_json_line'] += 1
                continue
            kind = value.get('type') or value.get('method') or 'response'
            self.counts[kind] += 1
            if 'id' in value and (kind == 'response' or 'result' in value or 'error' in value):
                self.responses[value['id']] = value
                self.note(response_id=value['id'], result_keys=list(value.get('result', {})),
                    stopReason=value.get('result', {}).get('stopReason'), rpc_success=value.get('success'),
                    error_code=value.get('error', {}).get('code') if isinstance(value.get('error'),dict) else None)
            update = value.get('params', {}).get('update', {})
            if update:
                self.counts['update:'+str(update.get('sessionUpdate'))] += 1
                if update.get('sessionUpdate') == 'agent_message_chunk':
                    self.text += update.get('content', {}).get('text', '')
                    if MARKER in self.text:
                        self.marker.set()
            encoded = json.dumps(value)
            if MARKER in encoded and kind != 'response':
                self.marker.set()
            if 'requires a newer version of Codex' in encoded:
                self.note(observation='model_requires_newer_cli', carrier=kind,
                    update=update.get('sessionUpdate'))
            if kind in ('agent_end', 'agent_settled', 'turn_end'):
                self.note(native_event=kind)
                if kind == 'agent_end':
                    self.agent_end.set()
            for meta in (update.get('_meta', {}), value.get('result', {}).get('_meta', {})):
                failure = meta.get('jetbrains', {}).get('air', {}).get('sessionFailure')
                if failure:
                    self.note(structured_failure={k:failure.get(k) for k in ('category','severity','recoverable')},
                        carrier=kind, terminal_meta=kind=='response')
            if 'method' in value and 'id' in value:
                self.note(agent_request=value['method'])
                if value['method'] == 'session/request_permission':
                    await self.send({'jsonrpc':'2.0','id':value['id'],'result':{'outcome':{'outcome':'cancelled'}}})
                else:
                    await self.send({'jsonrpc':'2.0','id':value['id'],'error':{'code':-32601,'message':'Not supported by diagnosis probe'}})

    async def send(self, value):
        self.proc.stdin.write((json.dumps(value)+'\n').encode())
        await self.proc.stdin.drain()

    async def response(self, id, seconds=20):
        end = time.monotonic()+seconds
        while time.monotonic()<end:
            if id in self.responses:
                return self.responses[id]
            await asyncio.sleep(.05)
        self.note(timeout_response_id=id, timeout_seconds=seconds)
        return None

    async def acp(self, method, params, id=None):
        value = {'jsonrpc':'2.0','method':method,'params':params}
        if id is not None:
            value['id']=id
        await self.send(value)

    async def close(self):
        rows = subprocess.check_output(['ps','-axo','pid,ppid'],text=True).splitlines()[1:]
        ids = {self.proc.pid}
        for _ in range(10):
            for row in rows:
                pid,ppid=map(int,row.split())
                if ppid in ids:
                    ids.add(pid)
        for pid in sorted(ids,reverse=True):
            try: os.kill(pid,signal.SIGTERM)
            except ProcessLookupError: pass
        await asyncio.sleep(1)
        for pid in sorted(ids,reverse=True):
            try: os.kill(pid,signal.SIGKILL)
            except ProcessLookupError: pass
        await self.proc.wait()
        self.reader.cancel()
        remaining={int(x) for x in subprocess.check_output(['ps','-axo','pid='],text=True).split()}
        self.note(cleanup_survivors=sorted(ids & remaining))
        result={'name':self.name,'at':datetime.datetime.now().astimezone().isoformat(),
            'event_counts':dict(self.counts),'observations':self.events}
        (ROOT/(self.name+'.json')).write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result),flush=True)


async def run(name, row, native=False, typed=False):
    p=Probe(name)
    env=dict(os.environ)
    env.update(json.loads(row[3]))
    if native:
        argv=[env['PI_ACP_PI_COMMAND'],'--mode','rpc','--no-themes','--no-session']
    else:
        argv=[row[1],*json.loads(row[2])]
    await p.start(argv,env)
    try:
        if native:
            await p.send({'id':'state-before','type':'get_state'})
            state=await p.response('state-before')
            p.note(model={k:state['data'].get('model',{}).get(k) for k in ('provider','id')})
            await p.send({'id':'prompt','type':'prompt','message':f'Reply only {MARKER}. Do not use tools or modify files.'})
            await asyncio.wait_for(p.agent_end.wait(),45)
            await asyncio.sleep(2)
            await p.send({'id':'state-after','type':'get_state'})
            state=await p.response('state-after')
            p.note(native_is_streaming=state['data'].get('isStreaming'))
            await p.send({'id':'abort','type':'abort'})
            await p.response('abort')
            await asyncio.sleep(2)
        else:
            caps={'elicitation':{'form':{}},'auth':{'terminal':True},'_meta':{'terminal-auth':True}}
            if typed:
                caps['_meta']['jetbrains']={'air':{'version':1,'capabilities':['sessionFailure']}}
            await p.acp('initialize',{'protocolVersion':1,'clientInfo':{'name':'farfold-diagnosis','version':'0.1.7'},'clientCapabilities':caps},1)
            await p.response(1)
            await p.acp('session/new',{'cwd':str(ROOT/name),'mcpServers':[]},2)
            response=await p.response(2,30)
            if not response or 'result' not in response:
                return
            result=response['result'];sid=result['sessionId']
            for o in result.get('configOptions',[]):
                if o.get('category')=='model' or o.get('id')=='model':
                    p.note(model_option=o.get('id'), currentValue=o.get('currentValue'))
            await p.acp('session/prompt',{'sessionId':sid,'prompt':[{'type':'text','text':f'Reply only {MARKER}. Do not use tools or modify files.'}]},3)
            if name.startswith('pi'):
                await asyncio.wait_for(p.marker.wait(),45)
                p.note(marker_received=True)
                await p.response(3,8)
                await p.acp('session/cancel',{'sessionId':sid})
                p.note(cancel_sent=True)
                await p.response(3,8)
            else:
                await p.response(3,40)
    except Exception as e:
        p.note(probe_exception=type(e).__name__)
    finally:
        await p.close()


async def main():
    ROOT.mkdir(exist_ok=True)
    conn=sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True)
    rows={r[0]:r for r in conn.execute("SELECT id,command,args,env FROM agents WHERE id IN ('pi','codex')")}
    conn.close()
    cases={'pi-native':('pi',True,False),'pi-acp':('pi',False,False),
        'codex-acp':('codex',False,False),'codex-typed-failure':('codex',False,True)}
    selected=sys.argv[1:] or list(cases)
    await asyncio.gather(*(run(name,rows[cases[name][0]],native=cases[name][1],typed=cases[name][2]) for name in selected))


if __name__=='__main__':
    asyncio.run(main())
