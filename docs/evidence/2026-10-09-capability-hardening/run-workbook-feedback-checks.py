"""Frozen-input integration checks. Logs keep original stdout/stderr bytes."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import time
import sys

ROOT = Path(__file__).resolve().parents[3]
OUTPUT_NAME = sys.argv[1] if len(sys.argv) > 1 else 'workbook-feedback-checks'
if OUTPUT_NAME not in ('workbook-feedback-checks',):
    raise ValueError('Unknown check output directory')
OUT = Path(__file__).resolve().parent / OUTPUT_NAME
SCOPES = ('src', 'src-tauri/src', 'src-tauri/native', 'src-tauri/capabilities',
          'src-tauri/resources', 'src-tauri/icons', 'scripts', 'assets', 'public')
TOP = ('docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/copy-status-wire.json', 'docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg', '.prettierignore', 'package.json', 'pnpm-lock.yaml', 'index.html', 'tsconfig.json',
       'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts',
       'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs',
       'src-tauri/Info.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json')



WORKBOOK_FIXTURES = tuple('docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/' + name for name in ('positions-v1.xlsx', 'positions-v2.xlsx', 'positions-v1-nonordinal-ids.xlsx', 'oracle.json'))
TOP = TOP + WORKBOOK_FIXTURES

EXTERNAL_FIXTURES = ('docs/evidence/2026-10-09-capability-hardening/docx-fixtures',
                     'docs/evidence/2026-10-09-capability-hardening/docx/public-samples')
COMPATIBILITY = 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility'


def inputs():
    paths = {ROOT / path for path in TOP}
    for scope in SCOPES + EXTERNAL_FIXTURES:
        paths.update(path for path in (ROOT / scope).rglob('*')
                     if path.is_file() and path.name != '.DS_Store' and '__pycache__' not in path.parts)
    paths.update((ROOT / COMPATIBILITY).glob('*.docx'))
    paths.add(ROOT / COMPATIBILITY / 'expectations.json')
    if any(path.is_symlink() for path in paths):
        raise ValueError('Unexpected symlink in frozen inputs')
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}



def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def execute(command):
    name, argv = command
    started = time.monotonic()
    log = OUT / (name + '.txt')
    with log.open('xb') as stream:
        result = subprocess.run(argv, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
    item = {'name': name, 'argv': argv, 'exitCode': result.returncode,
            'seconds': round(time.monotonic()-started, 3),
            'log': str(log.relative_to(ROOT)), 'sha256': sha(log), 'executedNow': True}
    print(json.dumps(item), flush=True)
    return item


if __name__ == '__main__':
    OUT.mkdir(exist_ok=False)
    before = inputs()
    prior_dir = OUT.parent / 'text-selection-keyboard-checks-final'
    old = json.loads((prior_dir / 'inputs.json').read_text())
    changed = sorted(p for p in set(before) | set(old) if before.get(p) != old.get(p))
    # Only frontend source/tests changed; backend/config/shared wire inputs must be exact.
    assert changed and all(p.startswith('src/') or p in WORKBOOK_FIXTURES for p in changed), changed
    assert all(p not in old for p in WORKBOOK_FIXTURES), 'New XLSX fixture inventory must not mask a previous shared input change'
    (OUT / 'inputs.json').write_text(json.dumps(before, indent=2)+'\n')
    # Build already runs tsc; keep the explicit typecheck as its own required check,
    # sequential with build to avoid concurrent writes to compiler incremental state.
    commands = [('frontend', ['corepack','pnpm','test']),
                ('typecheck', ['corepack','pnpm','typecheck'])]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        checks = list(pool.map(execute, commands))
    checks.append(execute(('build', ['corepack','pnpm','build'])))
    prior = json.loads((prior_dir / 'final-verification.json').read_text())
    for check in prior['checks']:
        if check['name'] in ('cargo-fmt','clippy','rust'):
            assert check['exitCode'] == 0 and sha(ROOT/check['log']) == check['sha256']
            checks.append({'name': check['name'], 'exitCode':0, 'log':check['log'],
                           'sha256':check['sha256'], 'executedNow':False,
                           'reason':'All previous Rust/config/shared fixture inputs exactly match. Four added XLSX frontend-only test files are explicitly frozen; they are not read by Rust checks.'})
    after = inputs()
    record = {'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sourceBase': subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
              'inputCount':len(before), 'sourceStable': before == after, 'formatDeferredUntilEvidenceFreeze': True,
              'changedInputsFromPreviousCheck':changed, 'checks':checks,
              'allPassed':before == after and all(c['exitCode']==0 for c in checks),
              'boundary':'Frontend source and test checks rerun; identical Rust checks explicitly reused. Whole-repository formatting is deferred until concurrent evidence writers finish and is not included in allPassed here. No installed interaction or real Agent claim.'}
    (OUT/'receipt.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps({'allPassed':record['allPassed'],'inputCount':len(before)}),flush=True)
    raise SystemExit(0 if record['allPassed'] else 1)
