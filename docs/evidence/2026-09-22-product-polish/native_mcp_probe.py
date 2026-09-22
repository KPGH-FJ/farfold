"""Same read-only MCP request through the configured official CLI."""
import asyncio, json, os, sqlite3, signal, time
from pathlib import Path
from capability_probe import ROOT, base, PROMPT
async def main():
    with sqlite3.connect('file:'+str(base.DB)+'?mode=ro',uri=True) as db:row=db.execute("SELECT env FROM agents WHERE id='codex'").fetchone()
    env=dict(os.environ);env.update(json.loads(row[0]));cli=env.get('CODEX_PATH')
    assert cli,'no_explicit_cli'
    cwd=ROOT/'w3-codex-new'
    proc=await asyncio.create_subprocess_exec(cli,'exec','--json','--skip-git-repo-check','-C',str(cwd),'-m','gpt-6-astra','-c','model_reasoning_effort="high"',PROMPT,env=env,stdin=asyncio.subprocess.DEVNULL,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,start_new_session=True)
    result={'tier':'official_cli','mcpCalls':0,'marker':False,'unavailable':False,'errors':0,'timedOut':False}
    async def read():
        async for line in proc.stdout:
            try:v=json.loads(line)
            except ValueError:continue
            item=v.get('item',{});text=item.get('text','')
            if item.get('type')=='mcp_tool_call':
                result['mcpCalls']+=1;result['mcpServer']=item.get('server');result['mcpTool']=item.get('tool');result['mcpStatus']=item.get('status')
            result['marker'] |= 'FARFOLD-MCP-42' in text
            result['unavailable'] |= 'MCP-UNAVAILABLE' in text
            result['errors']+=int(v.get('type')=='error')
        result['exitCode']=await proc.wait()
    try:await asyncio.wait_for(read(),180)
    except asyncio.TimeoutError:result['timedOut']=True
    finally:
        try:os.killpg(proc.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        await proc.wait()
    (ROOT/'w3-codex-native-mcp.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
asyncio.run(main())
