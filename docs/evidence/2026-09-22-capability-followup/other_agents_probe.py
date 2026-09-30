"""Bounded real OpenCode/Pi ACP MCP and Skill samples; no private config edits."""
import asyncio
import json
import os
import sqlite3
from model_probe import ROOT, base, rpc, options, CAPS

async def sample(agent):
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro', uri=True) as db:
        command, args, values = db.execute('SELECT command,args,env FROM agents WHERE id=?', (agent,)).fetchone()
    env = dict(os.environ)
    env.update(json.loads(values))
    argv = [command, *json.loads(args)]
    report = []
    sid = None
    for phase in ('new', 'load'):
        p = base.Probe(agent+'-capability-'+phase)
        row = {'agent': agent, 'phase': phase}
        try:
            await p.start(argv, env)
            init = await rpc(p, 'initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'clientCapabilities': CAPS}, 1)
            row['agentInfo'] = init.get('agentInfo')
            params = {'cwd': str(ROOT/'capability-project'), 'mcpServers': [{'name': 'farfold_arithmetic_'+agent, 'command': '/usr/bin/python3', 'args': ['-u', str(ROOT/'mcp_fixture.py')], 'env': []}]}
            if sid:
                params['sessionId'] = sid
            r = await rpc(p, 'session/'+phase, params, 2)
            sid = sid or r['sessionId']
            row.update(session_id=sid, options=options(r))
            if phase == 'load' and row['options'].get('model') != report[0]['options'].get('model'):
                row['continuation_blocked_for_model_drift'] = True
                continue
            before = len((ROOT/'mcp-calls.jsonl').read_text().splitlines())
            p.text = ''
            done = await rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': 'Use only the farfold_arithmetic_'+agent+' multiply MCP tool to multiply 6 by 7. You may first discover/search for this specific tool. Reply with its product and exact fresh receipt. Do not use any other services or read/modify files; if unavailable say MCP-UNAVAILABLE.'}]}, 3)
            calls = [json.loads(s) for s in (ROOT/'mcp-calls.jsonl').read_text().splitlines()][before:]
            row['mcp'] = {'stop': done.get('stopReason'), 'receipt_matches_new_call': any(c['receipt'] in p.text for c in calls), 'tool_call_events': p.counts['update:tool_call'], 'unavailable': 'MCP-UNAVAILABLE' in p.text}
            if phase == 'new':
                p.text = ''
                done = await rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': 'Explicitly use the harmless project skill named farfold-local-proof. Read only its SKILL.md if needed, return its exact marker, and perform no other actions. If unavailable say SKILL-UNAVAILABLE.'}]}, 4)
                row['skill'] = {'stop': done.get('stopReason'), 'marker': 'FARFOLD-SKILL-49C71B-OK' in p.text, 'unavailable': 'SKILL-UNAVAILABLE' in p.text}
        except Exception as error:
            row['probe_failure'] = type(error).__name__
        finally:
            await p.close()
            report.append(row)
            (ROOT/(agent+'-capabilities.json')).write_text(json.dumps(report, indent=2)+'\n')
        if sid is None:
            break
    print(json.dumps(report, indent=2), flush=True)

async def main():
    await asyncio.gather(sample('opencode'), sample('pi'))

if __name__ == '__main__':
    asyncio.run(main())
