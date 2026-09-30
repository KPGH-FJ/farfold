"""Real Codex/ACP calls with an official process-local config and a harmless MCP service."""
import asyncio
import json
import os
import sqlite3
from model_probe import ROOT, base, rpc, options, CAPS

CONFIG = {'mcp_servers': {'farfold_arithmetic': {'command': '/usr/bin/python3', 'args': ['-u', str(ROOT/'mcp_fixture.py')]}}}

async def main():
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro', uri=True) as db:
        command, args, values = db.execute('SELECT command,args,env FROM agents WHERE id="codex"').fetchone()
    env = dict(os.environ)
    env.update(json.loads(values))
    assert 'CODEX_CONFIG' not in env
    env['CODEX_CONFIG'] = json.dumps(CONFIG)
    argv = [command, *json.loads(args)]
    cwd = str(ROOT/'capability-project')
    os.makedirs(cwd, exist_ok=True)
    report = []
    sid = None
    for phase in ('new', 'load'):
        p = base.Probe('capability-'+phase)
        try:
            await p.start(argv, env)
            await rpc(p, 'initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'clientCapabilities': CAPS}, 1)
            params = {'cwd': cwd, 'mcpServers': []}
            if sid:
                params['sessionId'] = sid
            r = await rpc(p, 'session/'+phase, params, 2)
            sid = sid or r['sessionId']
            p.text = ''
            done = await rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': 'Use the farfold_arithmetic multiply MCP tool to multiply 6 by 7. Reply with its product and exact fresh receipt. Do not use any other tools or read/modify files; if unavailable say MCP-UNAVAILABLE.'}]}, 3)
            calls = [json.loads(s) for s in (ROOT/'mcp-calls.jsonl').read_text().splitlines()] if (ROOT/'mcp-calls.jsonl').exists() else []
            report.append({'phase': phase, 'session_id': sid, 'options': options(r), 'stop': done.get('stopReason'), 'receipt_in_reply': bool(calls) and calls[-1]['receipt'] in p.text, 'tool_call_events': p.counts['update:tool_call'], 'unavailable': 'MCP-UNAVAILABLE' in p.text})
        finally:
            await p.close()
            (ROOT/'capability-results.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
