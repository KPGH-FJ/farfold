"""Record production inputs and signed Farfold bundles; never read Agent/user data."""
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
PRIOR = ROOT / 'docs/evidence/2026-10-03-r5-access/options-read-repair'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def manifest(base, paths):
    files = {str(path.relative_to(base)): sha(path) for path in sorted(paths)}
    return {'files': files, 'summary': {'files': len(files), 'manifestSha256': hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}}

def bundle(path):
    result = manifest(path, [p for p in path.rglob('*') if p.is_file()])
    check = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(path)], capture_output=True, text=True)
    result['signature'] = {'exitCode': check.returncode, 'output': check.stderr.strip()}
    if check.returncode:
        raise SystemExit('Bundle signature failed')
    return result

stage = sys.argv[1]
if stage not in ('before', 'after'):
    raise SystemExit('Use before or after')
paths = set()
for folder in ['assets','public','src','src-tauri/src','src-tauri/icons','src-tauri/capabilities','src-tauri/resources']:
    paths.update(p for p in (ROOT / folder).rglob('*') if p.is_file())
for name in ['index.html','package.json','pnpm-lock.yaml','src-tauri/Cargo.lock','src-tauri/Cargo.toml','src-tauri/build.rs','src-tauri/tauri.conf.json','tsconfig.app.json','tsconfig.json','tsconfig.node.json','vite.config.ts']:
    paths.add(ROOT / name)
source = manifest(ROOT, paths)
prior = json.loads((PRIOR / 'source-after-build.json').read_text())['source']['files']
result = {'atUtc': datetime.now(timezone.utc).isoformat(), 'source': source,
          'changesSinceInstalled': {'changed': sorted(k for k,v in prior.items() if k in source['files'] and source['files'][k] != v), 'added': sorted(set(source['files']) - set(prior)), 'removed': sorted(set(prior) - set(source['files']))},
          'formal': bundle(Path('/Applications/Farfold.app'))}
if stage == 'after':
    before = json.loads((OUT / 'source-before-build.json').read_text())
    if before['source']['files'] != source['files']:
        raise SystemExit('STOP production inputs changed during packaging')
    if before['formal']['files'] != result['formal']['files']:
        raise SystemExit('STOP installed application changed during packaging')
    result['candidate'] = bundle(ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app')
    result['productionInputsUnchanged'] = True
    result['formalUnchanged'] = True
(OUT / f'source-{stage}-build.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'source': source['summary'], 'binary': result.get('candidate', result['formal'])['files']['Contents/MacOS/farfold'], 'changes': result['changesSinceInstalled']}))
