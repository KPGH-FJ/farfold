"""Separate frozen backend/frontend checks, then an exact current-input aggregate."""
from pathlib import Path
import datetime,hashlib,json,subprocess,sys,runpy,time,re
OUT=Path(__file__).resolve().parent; BASE=OUT.parent; ROOT=BASE.parents[2]
old=sys.argv
try:
 sys.argv=[str(BASE/'reported-files-checks/run-checks.py')]
 collector=runpy.run_path(sys.argv[0])['inputs']
finally: sys.argv=old
PROTECTED={
 'docs/evidence/2026-10-08-reliability-ui-review/README.md':'2a2a3127cc0e97e62ff64eaf067033c37af6878dc7d32fcfa67dd19dbafc2d45',
 'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md':'f2d6cedc87d969d63d17507c85c6f5abd7424a7a3edb9cfcd940520553429cd7'}
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def ref(p): return {'path':str(p.relative_to(ROOT)),'sha256':sha(p)}
def write(name,value):
 p=OUT/name
 with p.open('x') as s: s.write(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
 subprocess.run(['corepack','pnpm','exec','prettier','--write',str(p)],cwd=ROOT,stdout=subprocess.DEVNULL,check=True)
def inputs(kind):
 all=collector()
 if kind=='rust': return {p:h for p,h in all.items() if not p.startswith('src/') or '/fixtures/' in p}
 return all
# Rust's include_str/include_bytes front-end dependency is inside runtime/fixtures;
# all repository-backed non-frontend fixtures/config/native/build inputs also retained.
def protect(): return {p:sha(ROOT/p) for p in PROTECTED}==PROTECTED
def execute(name,argv):
 start=time.monotonic();p=OUT/(name+'.txt')
 with p.open('xb') as log: r=subprocess.run(argv,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
 result={'name':name,'argv':argv,'exitCode':r.returncode,'seconds':round(time.monotonic()-start,3),'log':str(p.relative_to(ROOT)),'sha256':sha(p),'executedInThisRun':True}
 print(json.dumps(result),flush=True);return result
COMMANDS={
 'rust': [('cargo-fmt',['cargo','fmt','--check','--manifest-path','src-tauri/Cargo.toml']),('clippy',['cargo','clippy','--manifest-path','src-tauri/Cargo.toml','--locked','--','-D','warnings']),('rust',['cargo','test','--manifest-path','src-tauri/Cargo.toml','--locked'])],
 'frontend':[('frontend',['corepack','pnpm','test']),('typecheck',['corepack','pnpm','typecheck']),('build',['corepack','pnpm','build'])]}
def group(kind):
 before=inputs(kind);assert protect();write(kind+'-inputs.json',before)
 checks=[execute(n,a) for n,a in COMMANDS[kind]]
 after=inputs(kind);write(kind+'-inputs-after.json',after)
 result={'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceBase':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'inputCount':len(before),'sourceStable':before==after,'changedInputs':sorted(p for p in set(before)|set(after) if before.get(p)!=after.get(p)),'protectedUnchanged':protect(),'checks':checks,'allPassed':before==after and protect() and all(c['exitCode']==0 for c in checks)}
 write(kind+'-verification.json',result);return result['allPassed']
def final():
 checks=[]
 for kind in COMMANDS:
  group_dir=OUT/(kind+'-final')
  d=json.loads((group_dir/(kind+'-verification.json')).read_text());assert d['allPassed']
  assert json.loads((group_dir/(kind+'-inputs.json')).read_text())==inputs(kind)
  for c in d['checks']: assert sha(ROOT/c['log'])==c['sha256']
  checks+=d['checks']
 assert protect();before=collector();write('inputs.json',before)
 checks+=[execute('format',['corepack','pnpm','format:check'])]
 after=collector();write('inputs-after.json',after)
 counts={}
 for n in ['frontend','rust']:
  raw=re.sub(r'\x1b\[[0-9;]*m','',(ROOT/next(c['log'] for c in checks if c['name']==n)).read_text())
  counts[n]=[l.strip() for l in raw.splitlines() if re.match(r'\s*(Test Files|Tests)\s+',l) or l.startswith('test result:')]
 record={'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceBase':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'inputCount':len(before),'sourceStable':before==after,'protectedUnchanged':protect(),'inputsBefore':ref(OUT/'inputs.json'),'inputsAfter':ref(OUT/'inputs-after.json'),'checks':checks,'counts':counts,'groups':[ref(OUT/(k+'-final')/(k+'-verification.json')) for k in COMMANDS],'priorRuns':[ref(OUT/'rust-verification.json'),ref(OUT/'frontend-verification.json'),ref(OUT/'rust-after-worker/rust-verification.json')],'allPassed':before==after and protect() and len(checks)==7 and all(c['exitCode']==0 for c in checks),'boundary':'All seven commands executed for this increment against verified current inputs. Earlier Rust failure remains in priorRuns and requires separate investigated attribution. Native harness, controlled browser, installation and real-Agent observations are separate. No Windows execution claim.'}
 write('final-verification.json',record);print(json.dumps({'allPassed':record['allPassed'],'counts':counts,'inputCount':len(before)}),flush=True);return record['allPassed']
if __name__=='__main__':
 mode=sys.argv[1] if len(sys.argv)==2 else ''
 assert mode in ('rust','rust-after-worker','frontend','rust-final','frontend-final','final')
 if mode in ('rust-after-worker','rust-final','frontend-final'):
  OUT=OUT/mode;OUT.mkdir(exist_ok=False);mode='frontend' if mode=='frontend-final' else 'rust'
 raise SystemExit(0 if (final() if mode=='final' else group(mode)) else 1)
