"""One read-config-only ACP diagnosis, fixed current model/off; sanitized results only."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile

OUT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('existing_probe', OUT.parent/'2026-09-21-acceptance-fixes/probe.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
MARKER = 'FARFOLD-PI-FAILURE-PROBE-OK'

def shape(value):
    if isinstance(value, dict):
        return {key:shape(item) for key,item in value.items()}
    if isinstance(value, list):
        return [shape(value[0])] if value else []
    return type(value).__name__

async def main():
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro', uri=True) as db:
        row = db.execute("SELECT command,args,env FROM agents WHERE id='pi'").fetchone()
    env = dict(os.environ)
    env.update(json.loads(row[2]))
    assert not any(value.startswith('__keychain__') for value in env.values()), 'requires_keychain_resolution'
    argv = [row[0], *json.loads(row[1])]
    with tempfile.TemporaryDirectory(prefix='farfold-pi-failure-') as tmp:
        base.ROOT = Path(tmp)
        p = base.Probe('pi-failure-acp')
        await p.start(argv, env)
        try:
            p.note(executable=argv[0], adapter_version='0.0.33', native_pi_version='0.80.5', home_unchanged=env.get('HOME')==str(Path.home()), config_modified=False)
            caps = {'auth':{'terminal':True}, 'elicitation':{'form':{}}, '_meta':{'terminal-auth':True, 'jetbrains':{'air':{'version':1, 'capabilities':['sessionFailure']}}}}
            await p.acp('initialize', {'protocolVersion':1,'clientInfo':{'name':'farfold-reliability-diagnosis','version':'0.1.7'},'clientCapabilities':caps}, 1)
            init = await p.response(1, 30)
            if not init or 'error' in init:
                p.note(stage='initialize_failed'); return
            await p.acp('session/new', {'cwd':str(base.ROOT/p.name),'mcpServers':[]}, 2)
            opened = await p.response(2, 30)
            if not opened or 'error' in opened:
                p.note(stage='open_failed'); return
            result = opened['result']
            options = [{key:option.get(key) for key in ('id','category','currentValue')} for option in result.get('configOptions',[])]
            model = next((option['currentValue'] for option in options if option['category']=='model'), None)
            thought = next((option['currentValue'] for option in options if option['category']=='thought_level'), None)
            p.note(options=options)
            if not model or model.split('/')[-1]!='glm-4.5-air' or thought!='off':
                p.note(stage='current_configuration_mismatch_prompt_not_sent'); return
            await p.acp('session/prompt', {'sessionId':result['sessionId'], 'prompt':[{'type':'text','text':'Reply only '+MARKER+'. Do not use tools, inspect files, change settings, or modify files.'}]}, 3)
            reply = await p.response(3, 120)
            p.note(stage='prompt_finished' if reply else 'prompt_timeout', marker_received=MARKER in p.text,
                retry_start_count=p.text.count('Retrying (attempt '), retry_finished_count=p.text.count('Retry finished, resuming.'),
                other_response_text_present=bool(p.text.replace('Retry finished, resuming.','').strip()) and not p.text.startswith('Retrying (attempt '),
                terminal_response_shape=shape(reply) if reply else None,
                terminal_stop_reason=(reply or {}).get('result',{}).get('stopReason'))
            if not reply:
                await p.acp('session/cancel', {'sessionId':result['sessionId']})
                await p.response(3, 5)
        except Exception as error:
            p.note(probe_exception=type(error).__name__)
        finally:
            await p.close()
            (OUT/'pi-failure-acp.json').write_text((base.ROOT/'pi-failure-acp.json').read_text())

if __name__=='__main__':
    asyncio.run(main())
