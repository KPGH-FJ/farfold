"""Bounded synthetic Tauri GUI probe. Reads no user profile or application data."""
from pathlib import Path
import subprocess
import json
import datetime

root = Path(__file__).resolve().parent
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
result = root / 'results' / f'seam-{stamp}.json'
log = root / 'results' / f'execution-{stamp}.log'
command = [str(root/'seam-probe'), str(result), f'seam-{stamp}', 'synthetic-task', 'synthetic-page', '1']
with log.open('w') as output:
    try:
        execution = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, timeout=25, check=False)
        returncode = execution.returncode
    except subprocess.TimeoutExpired:
        returncode = 124
        output.write('\nOUTER_TIMEOUT_25_SECONDS\n')
record = {'command':command,'returncode':returncode,'result':str(result),'log':str(log)}
(root/'results'/'latest-run.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record,indent=2))
if result.exists():
    value=json.loads(result.read_text())
    print(json.dumps({'pass':value.get('pass'),'checks':len(value.get('checks',[])),'parent':value.get('parent')},indent=2))
raise SystemExit(returncode)
