"""One 90s read-only observation window; main app owns all Agent lifecycle."""
from pathlib import Path
import datetime,json,os,re,subprocess,time
PARENT=54178
EXECUTABLE='/Users/tw/.opencode/bin/opencode'
HERE=Path(__file__).parent
PUBLIC=HERE/'opencode-gui-initialize-observation.json'
PRIVATE=Path('/Users/tw/Desktop/farfold/output/2026-10-09-continuous-development/opencode-gui-initialize-observation')
if PUBLIC.exists() or PRIVATE.exists():raise SystemExit('Observation already exists; no automatic retry')
PRIVATE.mkdir(mode=0o700)
def children():
 rows=subprocess.check_output(['/bin/ps','-axo','pid=,ppid=,comm='],text=True)
 result=[]
 for line in rows.splitlines():
  v=line.strip().split(None,2)
  if len(v)==3 and int(v[1])==PARENT and v[2]==EXECUTABLE:result.append(int(v[0]))
 return result
existing=set(children())
started=time.monotonic();pid=None
record={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'parentPid':PARENT,'windowSeconds':90,'readOnly':True,'streamContentRead':False,'processSignalsSent':False,'existingMatchingChildCount':len(existing),'snapshots':[]}
print('Read-only observer ready; waiting for a new matching child.',flush=True)
while time.monotonic()-started<90:
 candidates=set(children())-existing
 if len(candidates)==1:pid=candidates.pop();break
 if len(candidates)>1:
  record['result']='ambiguous_new_children';break
 time.sleep(0.2)
if pid is None:
 record.setdefault('result','no_new_matching_child')
else:
 print(json.dumps({'capturedPid':pid,'parentPid':PARENT}),flush=True)
 record['childPid']=pid;first=time.monotonic()
 def observe():
  result=subprocess.run(['/tmp/farfold-opencode-pipe-info-20261009',str(pid),str(PARENT)],capture_output=True,text=True,timeout=5)
  try:pipes=json.loads(result.stdout)
  except ValueError:pipes={'helperFailed':True}
  signals=subprocess.run(['/bin/ps','-p',str(pid),'-o','stat=,sigmask=,sig='],capture_output=True,text=True,timeout=5)
  fields=signals.stdout.strip().split()
  record['snapshots'].append({'elapsedSeconds':round(time.monotonic()-first,3),'pipes':pipes,'stateAndSignalMasks':fields if len(fields)==3 else []})
 observe()
 raw=PRIVATE/'sample.txt';out=PRIVATE/'sample-command.txt'
 raw.touch(mode=0o600)
 with out.open('x') as handle:
  os.chmod(out,0o600)
  sample=subprocess.run(['/usr/bin/sample',str(pid),'2','10','-mayDie','-file',str(raw)],stdout=handle,stderr=subprocess.STDOUT,timeout=12)
 os.chmod(raw,0o600)
 record['sampleReturnCode']=sample.returncode
 content=raw.read_text(errors='replace')
 allowed=['kevent','__read_nocancel','read','__write_nocancel','write','poll','__poll','select','__select','mach_msg2_trap','mach_msg','__ulock_wait','__ulock_wait2','pthread_cond_wait','__psynch_cvwait','__psynch_mutexwait','__semwait_signal','nanosleep','__fork','posix_spawn','sqlite3_step','sqlite3_prepare_v2']
 record['safeSampleSymbolPresence']={name:bool(re.search(r'\b'+re.escape(name)+r'\b',content)) for name in allowed}
 for offset in [5,15,35,55]:
  if time.monotonic()-started>=90:break
  while time.monotonic()-first<offset and time.monotonic()-started<90:
   if pid not in children():break
   time.sleep(0.5)
  if pid not in children():break
  observe()
 while pid in children() and time.monotonic()-started<90:time.sleep(0.5)
 record['childNoLongerPresent']=pid not in children()
 record['observationSeconds']=round(time.monotonic()-first,3)
 record['result']='observed'
PUBLIC.write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'result':record['result'],'childNoLongerPresent':record.get('childNoLongerPresent'),'receipt':str(PUBLIC)}),flush=True)
