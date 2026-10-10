"""Verify the workbook content-type compatibility repair and close formatting."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
PRIOR = BASE / 'workbook-range-checks'
OUT = BASE / 'workbook-range-checks-final'
TEST = 'src/components/DocxReadingWindows.test.tsx'
RAW = BASE / 'docx-reading-position-repair/DocxReadingWindows.before-format.raw.txt'
spec = importlib.util.spec_from_file_location('range_checks', BASE / 'run-workbook-range-checks.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    with path.open('x') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--write', str(path)],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)


before = collector.inputs()
old = json.loads((PRIOR / 'inputs.json').read_text())
prior = json.loads((PRIOR / 'final-verification.json').read_text())
delta = sorted(p for p in before.keys() | old.keys() if before.get(p) != old.get(p))
allowed = {TEST, 'src/runtime/xlsx_parse.ts', 'src/runtime/xlsx_content_types.ts', 'src/runtime/xlsx_content_types.test.ts'}
assert delta and set(delta) <= allowed, delta
assert any(p != TEST for p in delta), 'Expected the real writer compatibility repair'
assert prior['sourceStable'] and prior['inputCount'] == len(old)
assert prior['allPassed'] is False and len(prior['checks']) == 7
assert sha(RAW) == old[TEST]
normalized = subprocess.run(
    ['corepack', 'pnpm', 'exec', 'prettier', '--stdin-filepath', TEST],
    cwd=ROOT, input=RAW.read_bytes(), capture_output=True, check=True,
).stdout
assert normalized == (ROOT / TEST).read_bytes(), 'Unexpected semantic source delta'
for check in prior['checks']:
    assert sha(ROOT / check['log']) == check['sha256']
    assert check['exitCode'] == (1 if check['name'] == 'format' else 0)
OUT.mkdir(exist_ok=False)
save(OUT / 'inputs.json', before)
def execute(job):
    name, argv = job
    log = OUT / (name + '.txt')
    with log.open('xb') as handle:
        result = subprocess.run(argv, cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT)
    value = {'name': name, 'argv': argv, 'exitCode': result.returncode,
             'executedNow': True, 'log': str(log.relative_to(ROOT)), 'sha256': sha(log)}
    print(json.dumps(value), flush=True)
    return value

with ThreadPoolExecutor(max_workers=2) as pool:
    checks = list(pool.map(execute, [('frontend', ['corepack', 'pnpm', 'test']),
                                    ('typecheck', ['corepack', 'pnpm', 'typecheck'])]))
checks.append(execute(('build', ['corepack', 'pnpm', 'build'])))
checks.append(execute(('format', ['corepack', 'pnpm', 'format:check'])))
for check in prior['checks']:
    if check['name'] in ('cargo-fmt', 'clippy', 'rust'):
        checks.append({**check, 'executedNow': False,
                       'reason': 'Delta is confined to the enumerated frontend parser/helper/tests plus a previously proved test formatting change. All Rust, configuration, shared fixtures and external fixtures remain byte-identical to the prior stable-input record; prior Rust reuse retains its original scope.'})
after = collector.inputs()
record = {
    'checkedAtUtc': datetime.now(timezone.utc).isoformat(),
    'sourceBase': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'inputCount': len(before), 'sourceStable': before == after,
    'changedInputsSinceFullChecks': delta,
    'formatOnlyProof': {'path': TEST, 'executedRaw': str(RAW.relative_to(ROOT)),
                        'executedSha256': sha(RAW), 'formattedSha256': before[TEST],
                        'prettierOfExecutedBytesExactlyMatchesCurrent': True},
    'priorReceipt': {'path': str((PRIOR / 'final-verification.json').relative_to(ROOT)),
                     'sha256': sha(PRIOR / 'final-verification.json')},
    'checks': checks,
    'allPassed': before == after and len(checks) == 7 and all(c['exitCode'] == 0 for c in checks),
    'boundary': 'Engineering evidence only. Four frontend/build/format checks rerun after the actual writer compatibility repair. Original green checks and format failure remain preserved at their input level. Browser, installation and real-Agent results remain separate.'}
save(OUT / 'final-verification.json', record)
print(json.dumps({'allPassed': record['allPassed'], 'inputCount': len(before)}), flush=True)
raise SystemExit(0 if record['allPassed'] else 1)
