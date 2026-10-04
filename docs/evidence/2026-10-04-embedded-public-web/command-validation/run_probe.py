from pathlib import Path
import datetime, subprocess, json, sys
root=Path(__file__).resolve().parent
mode=sys.argv[1]
assert mode in ('destroy','exit')
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
result=root/'results'/f'{mode}-{stamp}.json'
log=root/'results'/f'{mode}-{stamp}.log'
with log.open('x') as stream:
    run=subprocess.run([str(root/'command-probe'),str(result),mode],cwd=root,stdout=stream,stderr=subprocess.STDOUT,timeout=65)
if result.exists():
    data=json.loads(result.read_text());print(json.dumps({'result':str(result),'processExit':run.returncode,'pass':data['pass'],'reportError':data['report'].get('error'),'steps':data['report'].get('steps'),'cleanup':data['cleanup']},ensure_ascii=False))
else:
    print(json.dumps({'resultMissing':str(result),'processExit':run.returncode,'log':str(log)}))
