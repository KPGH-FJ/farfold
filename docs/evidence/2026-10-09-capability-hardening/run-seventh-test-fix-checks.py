"""Verify the reviewed test-only isolation refinement without repeating unchanged frontend checks."""
from pathlib import Path
import datetime, hashlib, json, runpy, subprocess, time
BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
OUT = BASE / 'seventh-test-fix-checks'
OUT.mkdir(exist_ok=False)
shared = runpy.run_path(str(BASE / 'run-seventh-checks.py'))
inputs = shared['inputs']
before = inputs()
full = json.loads((BASE / 'seventh-checks-final/inputs.json').read_text())
changed = sorted(p for p in set(before) | set(full) if before.get(p) != full.get(p))
assert changed == ['src-tauri/src/acp_client/process_stdio_tests.rs'], changed
(OUT / 'inputs.json').write_text(json.dumps(before, indent=2) + '\n')
checks = [
 ('cargo-fmt', ['cargo','fmt','--check','--manifest-path','src-tauri/Cargo.toml']),
 ('clippy', ['cargo','clippy','--manifest-path','src-tauri/Cargo.toml','--locked','--','-D','warnings']),
 ('rust', ['cargo','test','--manifest-path','src-tauri/Cargo.toml','--locked']),
 ('format', ['corepack','pnpm','format:check']),
]
results = []
for name,args in checks:
 started=time.monotonic()
 with (OUT/(name+'.txt')).open('xb') as log:
  result=subprocess.run(args,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
 item={'name':name,'argv':args,'exitCode':result.returncode,'seconds':round(time.monotonic()-started,3),'log':name+'.txt'}
 results.append(item);print(json.dumps(item),flush=True)
after=inputs()
record={'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'inputCount':len(before),'sourceUnchanged':before==after,'changedSinceFullChecks':changed,'checks':results,'passed':before==after and all(r['exitCode']==0 for r in results),'coverage':'Frontend type/test/build results from seventh-checks-final remain applicable: only the reviewed cfg(test) Rust file changed; all Rust checks and full formatting rerun here.'}
(OUT/'receipt.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'passed':record['passed'],'sourceUnchanged':record['sourceUnchanged']}),flush=True)
raise SystemExit(0 if record['passed'] else 1)
