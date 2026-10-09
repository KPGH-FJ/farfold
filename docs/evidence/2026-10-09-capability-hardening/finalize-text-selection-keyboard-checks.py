"""Rebuild the CSS-only delta, then close deferred repository formatting.

Run after source and concurrent evidence writers are frozen. Existing check
logs and receipts are never rewritten; reused results retain executedNow=false.
"""
from pathlib import Path
import datetime
import hashlib
import importlib.util
import json
import subprocess

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
OUT = BASE / 'text-selection-keyboard-checks-final'
PRIOR = BASE / 'text-selection-keyboard-checks'
spec = importlib.util.spec_from_file_location('checks', BASE / 'run-text-selection-keyboard-checks.py')
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--write', str(path)],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)


def execute(name, argv):
    path = OUT / (name + '.txt')
    with path.open('xb') as stream:
        result = subprocess.run(argv, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
    return {'name': name, 'argv': argv, 'exitCode': result.returncode,
            'executedNow': True, 'log': str(path.relative_to(ROOT)), 'sha256': sha(path)}


before = checks.inputs()
old = json.loads((PRIOR / 'inputs.json').read_text())
delta = sorted(path for path in before.keys() | old.keys() if before.get(path) != old.get(path))
assert delta == ['src/components/TextBlockPreview.css'], delta
prior = json.loads((PRIOR / 'receipt.json').read_text())
assert prior['allPassed'] and prior['sourceStable'] and len(prior['checks']) == 6
assert json.loads((PRIOR / 'receipt.raw.txt').read_text()) == prior
for check in prior['checks']:
    assert check['exitCode'] == 0 and sha(ROOT / check['log']) == check['sha256']
OUT.mkdir(exist_ok=False)
save(OUT / 'inputs.json', before)
results = [execute('build', ['corepack', 'pnpm', 'build'])]
results.append(execute('format', ['corepack', 'pnpm', 'format:check']))
for check in prior['checks']:
    if check['name'] == 'build':
        continue
    results.append({**check, 'executedNow': False,
                    'reason': 'Only the verified TextBlockPreview.css delta changed since these successful inputs; all TS/TSX, Rust, configuration and shared fixtures match exactly.'})
after = checks.inputs()
record = {
    'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceBase': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'inputCount': len(before), 'sourceStable': before == after,
    'changedInputsSinceFullFrontendCheck': delta,
    'priorReceipt': {'path': str((PRIOR / 'receipt.json').relative_to(ROOT)), 'sha256': sha(PRIOR / 'receipt.json')},
    'originalFormatFailure': {'path': str((PRIOR / 'format-receipt.json').relative_to(ROOT)), 'sha256': sha(PRIOR / 'format-receipt.json')},
    'checks': results,
    'allPassed': before == after and len(results) == 7 and all(item['exitCode'] == 0 for item in results),
    'boundary': 'Engineering checks only. CSS was rebuilt; unchanged frontend/type/Rust results are explicitly reused. Original in-progress evidence formatting failure remains retained. Controlled-browser and native receipts are separate.',
}
save(OUT / 'final-verification.json', record)
subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--check', str(OUT / 'final-verification.json')], cwd=ROOT, check=True)
print(json.dumps({'allPassed': record['allPassed'], 'inputCount': len(before)}), flush=True)
raise SystemExit(0 if record['allPassed'] else 1)
