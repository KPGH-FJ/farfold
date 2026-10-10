"""Seal one sequential seven-command run after the diagnostic-only test change.

The independent agent executed the first three Rust commands. Preserve their
actual receipts and raw bytes, then execute the four frontend/format commands.
"""
import datetime
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('http_checks', BASE / 'run-checks.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
r = module.runner
PRIVATE = r.ROOT / 'output/2026-10-11-mcp-http-add-independent/dependency-environment-debug'
OUT = BASE / 'run-02'
EXPECTED = {
 'rust':['cargo','test','--manifest-path','src-tauri/Cargo.toml','--locked'],
 'cargo-fmt':['cargo','fmt','--check','--manifest-path','src-tauri/Cargo.toml'],
 'clippy':['cargo','clippy','--manifest-path','src-tauri/Cargo.toml','--locked','--','-D','warnings'],
}

def main():
    data=json.loads((PRIVATE/'final-commands.json').read_text())
    commands=data['checks']
    before=json.loads((PRIVATE/'full-rust-inputs-before.json').read_text())
    assert len(commands)==3 and {('cargo-fmt' if c['name']=='rustfmt' else c['name']) for c in commands}==set(EXPECTED)
    assert data['sourceStable'] and data['protectedUnchanged']
    assert before==json.loads((PRIVATE/'final-inputs-after.json').read_text())==module.inputs()
    assert r.protected()
    OUT.mkdir(exist_ok=False)
    r.write(OUT/'inputs-before.json',before)
    checks=[]
    for original in commands:
        name='cargo-fmt' if original['name']=='rustfmt' else original['name'];source=r.ROOT/original['log']
        assert original['argv']==EXPECTED[name] and original['exitCode']==0
        assert original['executedInThisRun'] is True and r.sha(source)==original['sha256']
        dest=OUT/(name+'.txt');shutil.copyfile(source,dest)
        check={k:original[k] for k in ('name','argv','exitCode','seconds','sha256')}
        check.update(name=name,originalName=original['name'],log=str(dest.relative_to(r.ROOT)),executedInThisRun=True,executor='independent agent, actual command on this frozen input set; root preserved exact output',originalLog=original['log'])
        checks.append(check)
    original_receipt=OUT/'independent-commands.json.raw.txt';shutil.copyfile(PRIVATE/'final-commands.json',original_receipt)
    for name,argv in [
      ('typecheck',['corepack','pnpm','typecheck']),
      ('frontend',['corepack','pnpm','test']),
      ('build',['corepack','pnpm','build']),
      ('format',['corepack','pnpm','format:check']),
    ]:
        check=r.execute(OUT,name,argv);check['executor']='root';checks.append(check)
    after=module.inputs();r.write(OUT/'inputs-after.json',after)
    counts={}
    for c in checks:
        if c['name'] in ('frontend','rust'):
            raw=re.sub(r'\x1b\[[0-9;]*m','',(r.ROOT/c['log']).read_text())
            counts[c['name']]=[line.strip() for line in raw.splitlines() if re.match(r'\s*(Test Files|Tests)\s+',line) or line.startswith('test result:')]
    value={'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceBase':subprocess.check_output(['git','rev-parse','HEAD'],text=True,cwd=r.ROOT).strip(),'inputCount':len(before),'sourceStable':before==after,'changedInputs':sorted(p for p in before.keys()|after.keys() if before.get(p)!=after.get(p)),'protectedUnchanged':r.protected(),'checks':checks,'counts':counts,'allPassed':before==after and r.protected() and all(c['exitCode']==0 for c in checks),'independentCommands':{'path':str(original_receipt.relative_to(r.ROOT)),'sha256':r.sha(original_receipt)},'boundary':'Seven actual sequential commands on the same input set, with executor provenance. The only change since failed run01 is bounded test diagnostics, not a production timeout fix. Original intermittent failure remains unlocalized; later pass is not causal proof. Engineering only, not installed/official Agent/product acceptance.'}
    module.prior_write(OUT/'verification.json',value)
    print(json.dumps({k:value[k] for k in ('allPassed','inputCount','counts')}),flush=True)
    return 0 if value['allPassed'] else 1

if __name__=='__main__':raise SystemExit(main())
