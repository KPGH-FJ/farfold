"""Launch the installed candidate with its existing opt-in numeric timing, no new flag."""
import json,os,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
env=dict(os.environ);env['FARFOLD_PERF_TRACE']='1'
p=subprocess.Popen(['/Applications/Farfold.app/Contents/MacOS/farfold'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,env=env)
(root/'app-process.json').write_text(json.dumps({'pid':p.pid,'path':'/Applications/Farfold.app','existing_perf_trace':True},indent=2)+'\n')
print('installed candidate PID',p.pid,flush=True)
with (root/'performance-samples.log').open('a') as f:
 for line in p.stderr:
  if line.startswith('[farfold-perf]'): f.write(line);f.flush()
print('exit',p.wait(),flush=True)
