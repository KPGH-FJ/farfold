"""One-factor app-server resume controls; never start a turn or rewrite user config."""
import asyncio
import json
import os
import sqlite3
from model_probe import ROOT, base, rpc

async def main():
    data = json.loads((ROOT/'model-results.json').read_text())
    sid = data['session_id']
    cwd = str(ROOT/'model-new')
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro', uri=True) as db:
        env = dict(os.environ)
        env.update(json.loads(db.execute('SELECT env FROM agents WHERE id="codex"').fetchone()[0]))
    results = []
    controls = [
        ('empty-config', {'config': {}}),
        ('provider-only', {'modelProvider': 'openai'}),
        ('feature-only', {'config': {'features': {'cwd_relative_turn_diffs': False}}}),
        ('trust-only', {'config': {'projects': {cwd: {'trust_level': 'trusted'}}}}),
        ('adapter-equivalent', {'modelProvider': 'openai', 'config': {'features': {'cwd_relative_turn_diffs': False}, 'projects': {cwd: {'trust_level': 'trusted'}}}}),
        ('adapter-with-model', {'model': 'gpt-5.5', 'modelProvider': 'openai', 'config': {'model_reasoning_effort': 'low', 'features': {'cwd_relative_turn_diffs': False}, 'projects': {cwd: {'trust_level': 'trusted'}}}}),
        ('default-again', {}),
    ]
    for name, overrides in controls:
        p = base.Probe('matrix-'+name)
        try:
            await p.start([env['CODEX_PATH'], 'app-server'], env)
            await rpc(p, 'initialize', {'clientInfo': {'name': 'farfold-diagnosis', 'version': '1'}, 'capabilities': {'experimentalApi': True}}, 1)
            await p.acp('initialized', {})
            request = {'threadId': sid, 'cwd': cwd, 'excludeTurns': True, **overrides}
            r = await rpc(p, 'thread/resume', request, 2)
            results.append({'case': name, 'request': request, 'response': {k: r.get(k) for k in ('model', 'reasoningEffort', 'modelProvider')}})
        finally:
            await p.close()
            (ROOT/'resume-matrix.json').write_text(json.dumps(results, indent=2)+'\n')
    print(json.dumps(results, indent=2))

if __name__ == '__main__':
    asyncio.run(main())
