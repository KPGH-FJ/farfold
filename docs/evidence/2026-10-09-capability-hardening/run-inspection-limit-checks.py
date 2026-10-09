"""Recheck changed frontend; reuse Rust results only with identical inputs."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import subprocess

ROOT = Path('/Users/tw/Desktop/farfold')
BASE = Path(__file__).resolve().parent
OUT = BASE / 'inspection-limit-checks'
OLD = json.loads((BASE / 'large-file-checks/inputs.json').read_text())
NEW = 'src/runtime/file_delivery.inspect-errors.test.ts'
ALLOWED = {NEW, 'src/runtime/file_delivery.ts', 'src/components/OpenedFileView.test.tsx'}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot():
    return {name: sha(ROOT / name) for name in sorted(set(OLD) | {NEW})}


OUT.mkdir()
before = snapshot()
changed = {name for name, digest in before.items() if OLD.get(name) != digest}
assert changed == ALLOWED, changed
assert all(before[name] == digest for name, digest in OLD.items() if name not in ALLOWED)
(OUT / 'inputs.json').write_text(json.dumps(before, indent=2) + '\n')
owner = json.loads((BASE / 'large-file-inspection-limit/implementation.json').read_text())
assert all(before[item['path']] == item['sha256'] for item in owner['sourceFiles'])
commands = [('format', ['corepack', 'pnpm', 'format:check']),
            ('frontend', ['corepack', 'pnpm', 'test']),
            ('build', ['corepack', 'pnpm', 'build'])]


def execute(item):
    name, argv = item
    log = OUT / (name + '.txt')
    with log.open('x') as stream:
        result = subprocess.run(argv, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
    return {'name': name, 'argv': argv, 'exitCode': result.returncode,
            'log': str(log.relative_to(ROOT)), 'sha256': sha(log), 'executedNow': True}


with ThreadPoolExecutor(max_workers=3) as executor:
    checks = list(executor.map(execute, commands))
assert snapshot() == before
prior = json.loads((BASE / 'large-file-checks-final/final-verification.json').read_text())
for check in prior['checks']:
    if check['name'] in ('cargo-fmt', 'clippy', 'rust'):
        assert sha(ROOT / check['log']) == check['sha256'] and check['exitCode'] == 0
        checks.append({**check, 'executedNow': False,
                       'reason': 'All Rust source/config/tests and shared fixtures exactly unchanged from prior successful checks.'})
typecheck = next(item for item in owner['tests'] if item['argv'] == ['corepack', 'pnpm', 'typecheck'])
assert typecheck['result'] == 'exit0' and sha(ROOT / typecheck['log']['path']) == typecheck['log']['sha256']
checks.append({'name': 'typecheck', 'exitCode': 0, **typecheck['log'],
               'executedNow': False, 'reason': 'Owner ran after formatting on exact current three changed inputs.'})
record = {'checkedAtUtc': datetime.now(timezone.utc).isoformat(),
          'baseCommit': 'f71a3434f00e14fed5d7fd473217b4e074462961',
          'inputCount': len(before), 'sourceStable': True, 'changedInputs': sorted(changed),
          'checks': checks, 'allPassed': all(c['exitCode'] == 0 for c in checks),
          'boundary': 'Exact-input reuse is explicit; not claiming all seven checks rerun. Native notice retest remains pending.'}
(OUT / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'inputCount': len(before), 'checks': [(c['name'], c['exitCode']) for c in checks]}))
raise SystemExit(0 if record['allPassed'] else 1)
