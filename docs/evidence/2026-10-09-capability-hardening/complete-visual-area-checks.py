"""Complete formatting after browser evidence freeze; reuse exact source checks."""
from pathlib import Path
import datetime
import hashlib
import json
import runpy
import subprocess

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
OUT = BASE / 'visual-area-checks-complete'
PREVIOUS = BASE / 'visual-area-checks-final'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def formatted_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--write', str(path)], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)


OUT.mkdir(exist_ok=False)
collector = runpy.run_path(str(BASE / 'run-visual-area-checks.py'))['inputs']
inputs = collector()
old_inputs = json.loads((PREVIOUS / 'inputs.json').read_text())
prior = json.loads((PREVIOUS / 'final-verification.json').read_text())
assert prior['sourceStable'] and inputs == old_inputs and len(inputs) == prior['inputCount']
checks = []
for item in prior['checks']:
    assert sha(ROOT / item['log']) == item['sha256']
    if item['name'] != 'format':
        assert item['exitCode'] == 0
        checks.append({**item, 'executedInThisCompletion': False})
assert len(checks) == 6
formatted_json(OUT / 'inputs.json', inputs)
log = OUT / 'format.txt'
command = ['corepack', 'pnpm', 'format:check']
with log.open('xb') as handle:
    result = subprocess.run(command, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT)
checks.append({'name': 'format', 'argv': command, 'exitCode': result.returncode,
               'log': str(log.relative_to(ROOT)), 'sha256': sha(log),
               'executedNow': True, 'executedInThisCompletion': True})
after = collector()
record = {
    'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceBase': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'inputCount': len(inputs), 'sourceStable': inputs == after,
    'priorReceipt': {'path': str((PREVIOUS / 'final-verification.json').relative_to(ROOT)), 'sha256': sha(PREVIOUS / 'final-verification.json')},
    'checks': checks,
    'allPassed': inputs == after and len(checks) == 7 and all(c['exitCode'] == 0 for c in checks),
    'boundary': 'Final seven-check aggregate at exact stable inputs. Only formatting rerun after browser capture JSON formatting. Frontend/type/build and current-slice Rust checks retain their actual execution origin and original failed records. No native or real-Agent claim.'
}
formatted_json(OUT / 'final-verification.json', record)
print(json.dumps({'allPassed': record['allPassed'], 'inputCount': len(inputs), 'sourceStable': record['sourceStable']}))
raise SystemExit(0 if record['allPassed'] else 1)
