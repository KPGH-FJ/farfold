"""Continue the interrupted run; retain five observed exits and all partial output."""
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('http_checks', BASE / 'run-checks.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
r = module.runner
OUT = BASE / 'run-01'
# These exact command exits/durations/hashes were returned by the original runner
# to the parent before external interruption. Raw logs and inputs are rechecked.
OBSERVED = [
 ('typecheck', ['corepack','pnpm','typecheck'],12.054,'5c01491b1d6eac7573d9000dc623e005710d14e952e6b2b20286269b90045f39'),
 ('frontend', ['corepack','pnpm','test'],75.972,'7dbcc767a065d10040cf6a73e11c8f58071db25bee6e0f2507b58c376202a0c2'),
 ('build', ['corepack','pnpm','build'],13.64,'3914354840623ad245ac57ab39a2e63ca83e2b4f7af8beaad49b596842408915'),
 ('cargo-fmt',['cargo','fmt','--check','--manifest-path','src-tauri/Cargo.toml'],1.781,'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
 ('clippy',['cargo','clippy','--manifest-path','src-tauri/Cargo.toml','--locked','--','-D','warnings'],0.816,'182e0273ab1d85020feb801d5e48b162fe456a7158fff856876f75864df8bcb0'),
]

def main():
    before = json.loads((OUT/'inputs-before.json').read_text())
    assert before == module.inputs() and r.protected()
    assert not (OUT/'verification.json').exists()
    checks=[]
    for name,argv,seconds,digest in OBSERVED:
        log=OUT/(name+'.txt')
        assert r.sha(log)==digest
        checks.append({'name':name,'argv':argv,'exitCode':0,'seconds':seconds,'log':str(log.relative_to(r.ROOT)),'sha256':digest,'executedInThisRun':True,'executionSegment':'before external interruption; observed runner result retained'})
    partial=OUT/'rust.txt'
    assert r.sha(partial)=='7a37ba844051d0e31ca69ce68b7c9f43e093557e127645cc618109c4db3af192'
    r.write(OUT/'interruption.json',{'status':'externalInterruptionDuringRustNoFinalVerdict','observedCompletedChecks':checks,'partialRust':{'path':str(partial.relative_to(r.ROOT)),'sha256':r.sha(partial)},'inputCount':len(before),'inputsUnchangedAtResume':True,'priorRunnerAndCargoProcessesAbsent':True,'continuation':'Execute complete Rust suite again and the not-yet-run format check; retain original partial Rust log unchanged. No test success inferred from partial output.'})
    rust=r.execute(OUT,'rust-resumed',['cargo','test','--manifest-path','src-tauri/Cargo.toml','--locked'])
    rust['name']='rust';rust['executionSegment']='after interruption, full command rerun'
    checks.append(rust)
    checks.append(r.execute(OUT,'format',['corepack','pnpm','format:check']))
    after=module.inputs();r.write(OUT/'inputs-after.json',after)
    counts={}
    for c in checks:
        if c['name'] in ('frontend','rust'):
            raw=re.sub(r'\x1b\[[0-9;]*m','',(r.ROOT/c['log']).read_text())
            counts[c['name']]=[line.strip() for line in raw.splitlines() if re.match(r'\s*(Test Files|Tests)\s+',line) or line.startswith('test result:')]
    value={'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceBase':subprocess.check_output(['git','rev-parse','HEAD'],text=True,cwd=r.ROOT).strip(),'inputCount':len(before),'sourceStable':before==after,'changedInputs':sorted(p for p in before.keys()|after.keys() if before.get(p)!=after.get(p)),'protectedUnchanged':r.protected(),'checks':checks,'counts':counts,'allPassed':before==after and r.protected() and all(c['exitCode']==0 for c in checks),'interruption':{'path':str((OUT/'interruption.json').relative_to(r.ROOT)),'sha256':r.sha(OUT/'interruption.json')},'boundary':'All seven exact commands completed on unchanged1509 inputs across one interrupted/resumed run. First five actual exits retained with exact hashes; incomplete Rust not counted and complete command rerun; final format executed. Engineering only, not installed/official Agent/product acceptance.'}
    module.prior_write(OUT/'verification.json',value)
    print(json.dumps({k:value[k] for k in ('allPassed','inputCount','counts')}),flush=True)
    return 0 if value['allPassed'] else 1

if __name__=='__main__':raise SystemExit(main())
