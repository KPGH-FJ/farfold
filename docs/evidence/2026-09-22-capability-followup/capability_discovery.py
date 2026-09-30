"""Follow-up: permit tool discovery explicitly and test a harmless native skill."""
import asyncio
import json
import os
import sqlite3
from model_probe import ROOT, base, rpc, options, CAPS
from capability_probe import CONFIG

async def main():
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro', uri=True) as db:
        command, args, values = db.execute('SELECT command,args,env FROM agents WHERE id="codex"').fetchone()
    env = dict(os.environ)
    env.update(json.loads(values))
    assert 'CODEX_CONFIG' not in env
    env['CODEX_CONFIG'] = json.dumps(CONFIG)
    argv = [command, *json.loads(args)]
    cwd = str(ROOT/'capability-project')
    report = []
    sid = None
    for phase in ('new', 'load'):
        p = base.Probe('discovery-'+phase)
        try:
            await p.start(argv, env)
            await rpc(p, 'initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'clientCapabilities': CAPS}, 1)
            params = {'cwd': cwd, 'mcpServers': []}
            if sid:
                params['sessionId'] = sid
            r = await rpc(p, 'session/'+phase, params, 2)
            sid = sid or r['sessionId']
            before = len((ROOT/'mcp-calls.jsonl').read_text().splitlines())
            p.text = ''
            done = await rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': 'Use the farfold_arithmetic multiply MCP tool to multiply 6 by 7. If tools require discovery, search for this specific tool first. Reply with its product and exact fresh receipt. Do not use any other services or read/modify files; if unavailable say MCP-UNAVAILABLE.'}]}, 3)
            calls = [json.loads(s) for s in (ROOT/'mcp-calls.jsonl').read_text().splitlines()][before:]
            row = {'phase': phase, 'session_id': sid, 'options': options(r), 'stop': done.get('stopReason'), 'new_service_calls': len(calls), 'receipt_in_reply': bool(calls) and calls[-1]['receipt'] in p.text, 'tool_call_events': p.counts['update:tool_call'], 'unavailable': 'MCP-UNAVAILABLE' in p.text}
            p.text = ''
            previous_tools = p.counts['update:tool_call']
            done = await rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': '$farfold-local-proof Please execute only this harmless project skill. Read its SKILL.md through the normal skill mechanism, return its exact marker, and perform no other actions.'}]}, 4)
            row['skill'] = {'marker': 'FARFOLD-SKILL-49C71B-OK' in p.text, 'stop': done.get('stopReason'), 'tool_call_events': p.counts['update:tool_call']-previous_tools}
            report.append(row)
        finally:
            await p.close()
            (ROOT/'capability-discovery.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
