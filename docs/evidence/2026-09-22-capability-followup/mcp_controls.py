"""Explicit ACP MCP and model controls; keeps earlier failed observations intact."""
import asyncio
import json
import os
import sqlite3
from model_probe import ROOT, base, rpc, options, CAPS

async def main():
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro', uri=True) as db:
        command, args, values = db.execute('SELECT command,args,env FROM agents WHERE id="codex"').fetchone()
    env = dict(os.environ)
    env.update(json.loads(values))
    argv = [command, *json.loads(args)]
    report = []
    for label, model in [('explicit-astra', 'gpt-6-astra'), ('explicit-55', 'gpt-5.5')]:
        p = base.Probe(label)
        try:
            await p.start(argv, env)
            await rpc(p, 'initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'clientCapabilities': CAPS}, 1)
            r = await rpc(p, 'session/new', {'cwd': str(ROOT/'capability-project'), 'mcpServers': [{'name': 'farfold_arithmetic', 'command': '/usr/bin/python3', 'args': ['-u', str(ROOT/'mcp_fixture.py')], 'env': []}]}, 2)
            sid = r['sessionId']
            if options(r).get('model') != model:
                await rpc(p, 'session/set_config_option', {'sessionId': sid, 'configId': 'model', 'value': model}, 3)
            before = (ROOT/'mcp-calls.jsonl').read_text().splitlines() if (ROOT/'mcp-calls.jsonl').exists() else []
            p.text = ''
            done = await rpc(p, 'session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': 'Use the farfold_arithmetic multiply MCP tool to multiply 6 by 7. If tools require discovery, search for this specific tool first. Reply with its product and exact fresh receipt. Do not use any other services or read/modify files; if unavailable say MCP-UNAVAILABLE.'}]}, 4)
            calls = [json.loads(s) for s in (ROOT/'mcp-calls.jsonl').read_text().splitlines()][len(before):] if (ROOT/'mcp-calls.jsonl').exists() else []
            report.append({'case': label, 'model': model, 'session_id': sid, 'stop': done.get('stopReason'), 'new_service_calls': len(calls), 'receipt_in_reply': bool(calls) and calls[-1]['receipt'] in p.text, 'tool_call_events': p.counts['update:tool_call'], 'unavailable': 'MCP-UNAVAILABLE' in p.text})
        finally:
            await p.close()
            (ROOT/'mcp-controls.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
