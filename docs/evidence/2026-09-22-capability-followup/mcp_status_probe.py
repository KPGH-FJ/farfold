"""Inspect only MCP server/tool names and startup status, never full config or credentials."""
import asyncio
import json
import os
import sqlite3
from model_probe import ROOT, base, rpc
from capability_probe import CONFIG

async def main():
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro', uri=True) as db:
        env = dict(os.environ)
        env.update(json.loads(db.execute('SELECT env FROM agents WHERE id="codex"').fetchone()[0]))
    p = base.Probe('mcp-server-status')
    report = {}
    try:
        await p.start([env['CODEX_PATH'], 'app-server'], env)
        await rpc(p, 'initialize', {'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'capabilities': {'experimentalApi': True}}, 1)
        await p.acp('initialized', {})
        r = await rpc(p, 'thread/start', {'cwd': str(ROOT/'capability-project'), 'config': CONFIG}, 2)
        report['session_id'] = r['thread']['id']
        report['model'] = r.get('model')
        await asyncio.sleep(3)
        r = await rpc(p, 'mcpServerStatus/list', {}, 3)
        report['top_keys'] = list(r)
        report['servers'] = [{k: s.get(k) for k in ('name', 'authStatus')} | {'tools': list(s.get('tools', {}))} for s in r.get('data', [])]
        r = await rpc(p, 'config/read', {'includeLayers': False, 'cwd': str(ROOT/'capability-project')}, 4)
        c = r.get('config', {})
        report['native_feature_flags'] = c.get('features')
        report['native_default_model'] = c.get('model')
    finally:
        await p.close()
        (ROOT/'mcp-status.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
