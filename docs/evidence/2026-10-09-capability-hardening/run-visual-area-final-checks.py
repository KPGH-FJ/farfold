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
OUTPUT_NAME = sys.argv[1] if len(sys.argv) > 1 else 'visual-area-checks-final'
if OUTPUT_NAME not in ('visual-area-checks-final',):
    raise ValueError('Unknown check output directory')
OUT = Path(__file__).resolve().parent / OUTPUT_NAME
SCOPES = ('src', 'src-tauri/src', 'src-tauri/native', 'src-tauri/capabilities',
          'src-tauri/resources', 'src-tauri/icons', 'scripts', 'assets', 'public')
TOP = ('docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/copy-status-wire.json', 'docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg', '.prettierignore', 'package.json', 'pnpm-lock.yaml', 'index.html', 'tsconfig.json',
       'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts',
       'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs',
       'src-tauri/Info.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json')



WORKBOOK_FIXTURES = tuple('docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/' + name for name in ('positions-v1.xlsx', 'positions-v2.xlsx', 'positions-v1-nonordinal-ids.xlsx', 'oracle.json'))
DOCX_FEEDBACK_FIXTURES = tuple('docs/evidence/2026-10-09-capability-hardening/docx-feedback/' + name for name in (
    'fixtures/repeated-locations.docx', 'fixtures/oracle.json',
    'independent/supported-choice-markers.docx',
    'independent/nested-choice-fallback.docx',
    'independent/hidden-notice-boundaries.docx',
    'independent/oracle-supplement.json',
    'independent/window-boundaries.docx', 'independent/window-oracle.json'))
TOP = TOP + WORKBOOK_FIXTURES + DOCX_FEEDBACK_FIXTURES

RANGE_FIXTURES = 'docs/evidence/2026-10-09-capability-hardening/workbook-range/fixtures'
EXTERNAL_FIXTURES = ('docs/evidence/2026-10-09-capability-hardening/visual-area/fixtures', RANGE_FIXTURES, 'docs/evidence/2026-10-09-capability-hardening/docx-fixtures',
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


def group(commands):
    return [execute(command) for command in commands]


if __name__ == '__main__':
    OUT.mkdir(exist_ok=False)
    before = inputs()
    prior_dir = OUT.parent / 'visual-area-checks'
    old = json.loads((prior_dir / 'inputs.json').read_text())
    prior = json.loads((prior_dir / 'final-verification.json').read_text())
    expected_delta = {'.prettierignore', 'src/components/VisualFilePreview.tsx', 'src/components/VisualFilePreview.area.test.tsx'}
    delta = {p for p in set(old) | set(before) if old.get(p) != before.get(p)}
    assert delta == expected_delta, sorted(delta)
    # The first run changed only a frontend test during execution; all Rust,
    # shared fixtures, locks, build scripts and production config remained exact.
    assert prior['changedInputs'] == ['src/components/VisualFilePreview.area.test.tsx']
    (OUT / 'inputs.json').write_text(json.dumps(before, indent=2) + '\n')
    subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--write', str(OUT / 'inputs.json')], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        checks = list(pool.map(execute, [('frontend', ['corepack', 'pnpm', 'test']), ('typecheck', ['corepack', 'pnpm', 'typecheck'])]))
    checks.append(execute(('build', ['corepack', 'pnpm', 'build'])))
    checks.append(execute(('format', ['corepack', 'pnpm', 'format:check'])))
    for check in prior['checks']:
        if check['name'] in ('cargo-fmt', 'clippy', 'rust'):
            assert check['exitCode'] == 0 and sha(ROOT / check['log']) == check['sha256']
            checks.append({**check, 'executedNow': False, 'reason': 'All Rust/shared fixture/config/lock inputs exactly match first-run hashes. First-run drift was solely a frontend test. Final delta is two frontend files and one exact formatting exclusion for a frozen historical receipt.'})
    after = inputs()
    record = {
        'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'sourceBase': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'inputCount': len(before), 'sourceStable': before == after,
        'changedInputsSinceFirstRun': sorted(delta),
        'changedInputsDuringFinalRun': sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p)),
        'priorReceipt': {'path': str((prior_dir / 'final-verification.json').relative_to(ROOT)), 'sha256': sha(prior_dir / 'final-verification.json')},
        'checks': checks,
        'allPassed': before == after and len(checks) == 7 and all(c['exitCode'] == 0 for c in checks),
        'boundary': 'Engineering only. First-run failure and browser-discovered one-pixel PDF defect retained. Frontend/type/build/format rerun after repair; unchanged Rust checks explicitly reused. Full-App, candidate, native and real Agent evidence remain separate.'
    }
    (OUT / 'final-verification.json').write_text(json.dumps(record, indent=2) + '\n')
    subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--write', str(OUT / 'final-verification.json')], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    print(json.dumps({'allPassed': record['allPassed'], 'inputCount': len(before)}), flush=True)
    raise SystemExit(0 if record['allPassed'] else 1)

