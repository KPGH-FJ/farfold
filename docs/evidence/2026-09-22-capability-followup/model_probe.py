"""Real ACP vs official app-server controls. Output only diagnostic whitelisted fields."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('base', ROOT.parent/'2026-09-21-acceptance-fixes/probe.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.ROOT = ROOT
CAPS = {'auth': {'terminal': True}, '_meta': {'terminal-auth': True}}
REPORT = {}

def save():
    (ROOT/'model-results.json').write_text(json.dumps(REPORT, indent=2)+'\n')

def options(result):
    return {o['id']: o.get('currentValue') for o in result.get('configOptions', [])}

async def rpc(p, method, params, ident):
    await p.acp(method, params, ident)
    response = await p.response(ident, 90)
    assert response and 'result' in response, (method, (response or {}).get('error', {}).get('code'))
    return response['result']

def history_models(sid):
    # Read only this newly created test's native file. Never persist message content.
    paths = list((Path.home()/'.codex/sessions').glob('**/*'+sid+'*.jsonl'))
    result = []
    for path in paths:
        for line in path.open():
            obj = json.loads(line)
            if obj.get('type') == 'turn_context':
                payload = obj.get('payload', {})
                result.append({k: payload.get(k) for k in ('model', 'effort', 'turn_id')})
    return result

async def main():
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro', uri=True) as db:
        command, args, values = db.execute('SELECT command,args,env FROM agents WHERE id="codex"').fetchone()
    env = dict(os.environ)
    env.update(json.loads(values))
    argv = [command, *json.loads(args)]
    cwd = str(ROOT/'model-new')
    p = base.Probe('model-new')
    try:
        await p.start(argv, env)
        init = await rpc(p, 'initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'clientCapabilities': CAPS}, 1)
        REPORT['agent'] = init.get('agentInfo')
        new = await rpc(p, 'session/new', {'cwd': cwd, 'mcpServers': []}, 2)
        sid = new['sessionId']
        REPORT['session_id'] = sid
        REPORT['initial'] = options(new)
        changed = await rpc(p, 'session/set_config_option', {'sessionId': sid, 'configId': 'model', 'value': 'gpt-5.5'}, 3)
        REPORT['selected'] = options(changed)
        changed = await rpc(p, 'session/set_config_option', {'sessionId': sid, 'configId': 'reasoning_effort', 'value': 'low'}, 4)
        REPORT['selected_with_effort'] = options(changed)
        done = await rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': 'Reply exactly FARFOLD-DIAG-OK. Do not use tools, read or modify files.'}]}, 5)
        REPORT['first_reply'] = {'marker': base.MARKER in p.text, 'stop': done.get('stopReason')}
    finally:
        await p.close()
        save()
    REPORT['native_before_resume'] = history_models(sid)
    save()
    # Separate processes prevent an in-memory ACP model from hiding cold-resume behavior.
    for label, extra in [('server-default', {}), ('server-explicit', {'model': 'gpt-5.5', 'config': {'model_reasoning_effort': 'low'}})]:
        p = base.Probe(label)
        try:
            await p.start([env['CODEX_PATH'], 'app-server'], env)
            await rpc(p, 'initialize', {'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'capabilities': {'experimentalApi': True}}, 1)
            await p.acp('initialized', {})
            r = await rpc(p, 'thread/resume', {'threadId': sid, 'cwd': cwd, 'excludeTurns': True, **extra}, 2)
            REPORT[label] = {k: r.get(k) for k in ('model', 'reasoningEffort', 'modelProvider')}
            REPORT[label]['thread_id_matches'] = r.get('thread', {}).get('id') == sid
            # No turn/start: a differing model must never receive continuation content.
        finally:
            await p.close()
            save()
    p = base.Probe('model-acp-reload')
    try:
        await p.start(argv, env)
        await rpc(p, 'initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'clientCapabilities': CAPS}, 1)
        r = await rpc(p, 'session/load', {'sessionId': sid, 'cwd': cwd, 'mcpServers': []}, 2)
        REPORT['acp_reload'] = options(r)
        REPORT['continuation_sent_after_drift'] = False
    finally:
        await p.close()
        REPORT['native_after_resume'] = history_models(sid)
        save()
    print(json.dumps(REPORT, indent=2), flush=True)

if __name__ == '__main__':
    asyncio.run(main())
