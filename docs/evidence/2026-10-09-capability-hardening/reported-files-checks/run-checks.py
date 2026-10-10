"""P19 checks; source checks first, repository formatting after evidence freeze."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys
import time

OUT = Path(__file__).resolve().parent
BASE = OUT.parent
ROOT = BASE.parents[2]
PRIOR = BASE / 'visual-area-checks-complete'
CANDIDATE_COMMIT = 'a47a6652453f44eb4ac4c89faea0ccd386f11ae0'
PROTECTED = (
    'docs/evidence/2026-10-08-reliability-ui-review/README.md',
    'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md',
)
EXTRA = (
    'src-tauri/examples/windows_process_fixture.rs',
    'src-tauri/testdata/signed-update-metadata.json',
)
previous_argv = sys.argv
try:
    # The previous runner validates its own optional CLI argument at import.
    sys.argv = [str(BASE / 'run-visual-area-checks.py')]
    collector = runpy.run_path(sys.argv[0])['inputs']
finally:
    sys.argv = previous_argv


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reference(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path)}


def write_json(path, value):
    with path.open('x') as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    subprocess.run(['corepack', 'pnpm', 'exec', 'prettier', '--write', str(path)],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)


def inputs():
    result = collector()
    for path in EXTRA:
        assert not (ROOT / path).is_symlink()
        result[path] = sha(ROOT / path)
    return dict(sorted(result.items()))


def changed(before, after):
    return sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))


def protected():
    return {p: sha(ROOT / p) for p in PROTECTED}


def execute(name, argv):
    started = time.monotonic()
    log = OUT / (name + '.txt')
    with log.open('xb') as stream:
        result = subprocess.run(argv, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
    item = {'name': name, 'argv': argv, 'exitCode': result.returncode,
            'seconds': round(time.monotonic() - started, 3),
            'log': str(log.relative_to(ROOT)), 'sha256': sha(log),
            'executedInThisRun': True}
    print(json.dumps(item), flush=True)
    return item


def reuse_rust(before):
    prior = json.loads((PRIOR / 'final-verification.json').read_text())
    old = json.loads((PRIOR / 'inputs.json').read_text())
    assert prior['allPassed'] and prior['sourceStable']
    candidate = json.loads((BASE / 'visual-area-candidate/candidate-inputs.json').read_text())
    # Candidate uses the same flat path/hash inventory as the complete checks.
    assert candidate == old
    delta = changed(old, {p: h for p, h in before.items() if p not in EXTRA})
    assert all(p.startswith('src/') and '/fixtures/' not in p for p in delta), delta
    # Old inventory omitted two Rust inputs. Compare their bytes to both the
    # actual Rust-check source commit and the installed candidate commit.
    original = json.loads((BASE / 'visual-area-checks/final-verification.json').read_text())
    supplemental = []
    for path in EXTRA:
        git_hashes = {}
        for commit in (original['sourceBase'], CANDIDATE_COMMIT):
            data = subprocess.check_output(['git', 'show', f'{commit}:{path}'], cwd=ROOT)
            git_hashes[commit] = hashlib.sha256(data).hexdigest()
        assert all(h == before[path] for h in git_hashes.values())
        supplemental.append({'path': path, 'sha256': before[path], 'gitHashes': git_hashes})
    assert not subprocess.check_output(
        ['git', 'status', '--porcelain', '--untracked-files=all', '--', 'src-tauri',
         '.cargo', 'rust-toolchain', 'rust-toolchain.toml'], cwd=ROOT, text=True).strip()
    assert not (ROOT / '.cargo').exists()
    assert not (ROOT / 'rust-toolchain').exists()
    assert not (ROOT / 'rust-toolchain.toml').exists()
    checks = []
    for item in prior['checks']:
        if item['name'] in ('cargo-fmt', 'clippy', 'rust'):
            assert item['exitCode'] == 0 and sha(ROOT / item['log']) == item['sha256']
            checks.append({k: item[k] for k in ('name', 'argv', 'exitCode', 'seconds', 'log', 'sha256')})
            checks[-1].update({
                'executedInThisRun': False,
                'reused': True,
                'reason': 'All prior non-frontend, shared-fixture, Rust/config/lock inputs match exactly; added inventory coverage for two Rust inputs matches original Rust-check and a47 candidate commits. No Rust source or dependency change.',
                'originalExecutionReceipt': reference(BASE / 'visual-area-checks/final-verification.json'),
            })
    assert len(checks) == 3
    return checks, {'priorCompleteReceipt': reference(PRIOR / 'final-verification.json'),
                    'priorInputs': reference(PRIOR / 'inputs.json'),
                    'candidateInputs': reference(BASE / 'visual-area-candidate/candidate-inputs.json'),
                    'candidateCommit': CANDIDATE_COMMIT,
                    'changedPriorInputs': delta,
                    'supplementalRustInputs': supplemental,
                    'sharedFrontendFixturesUnchanged': True,
                    'rustWorkingTreeClean': True,
                    'boundary': 'Reuses actual prior cargo fmt/clippy/test output; not a new Rust execution, toolchain revalidation, or application/Agent verification.'}


def source_checks(final=False):
    before = inputs()
    guarded = protected()
    checks, rust = reuse_rust(before)
    suffix = '-final' if final else ''
    write_json(OUT / ('inputs' + suffix + '.json'), before)
    if not final:
        write_json(OUT / 'protected-before.json', guarded)
        write_json(OUT / 'rust-reuse.json', rust)
    else:
        assert guarded == json.loads((OUT / 'protected-before.json').read_text())
        write_json(OUT / 'rust-reuse-final.json', rust)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [('frontend' + suffix, ['corepack', 'pnpm', 'test']),
                ('typecheck' + suffix, ['corepack', 'pnpm', 'typecheck'])]
        checks += list(pool.map(lambda item: execute(*item), jobs))
    checks.append(execute('build' + suffix, ['corepack', 'pnpm', 'build']))
    for check in checks:
        if suffix and check['executedInThisRun']:
            check['name'] = check['name'].removesuffix(suffix)
    after = inputs()
    write_json(OUT / ('inputs-after-source' + suffix + '.json'), after)
    record = {'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sourceBase': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'inputCount': len(before), 'sourceStable': before == after,
              'changedInputs': changed(before, after),
              'protectedUnchanged': guarded == protected(),
              'checks': checks,
              'sourceChecksPassed': before == after and guarded == protected() and all(c['exitCode'] == 0 for c in checks),
              'formatPending': True}
    write_json(OUT / ('source' + suffix + '-verification.json'), record)
    print(json.dumps({'sourceChecksPassed': record['sourceChecksPassed'], 'inputCount': len(before)}), flush=True)
    return 0 if record['sourceChecksPassed'] else 1


def final_check():
    suffix = '-final' if (OUT / 'source-final-verification.json').exists() else ''
    input_path = OUT / ('inputs' + suffix + '.json')
    source_path = OUT / ('source' + suffix + '-verification.json')
    before = json.loads(input_path.read_text())
    guarded = json.loads((OUT / 'protected-before.json').read_text())
    source = json.loads(source_path.read_text())
    assert source['sourceChecksPassed'] and before == inputs() and guarded == protected()
    for check in source['checks']:
        assert sha(ROOT / check['log']) == check['sha256']
    checks = source['checks'] + [execute('format', ['corepack', 'pnpm', 'format:check'])]
    after = inputs()
    write_json(OUT / 'inputs-after-final.json', after)
    frontend = re.sub(r'\x1b\[[0-9;]*m', '', (ROOT / next(c['log'] for c in checks if c['name'] == 'frontend')).read_text())
    rust = re.sub(r'\x1b\[[0-9;]*m', '', (ROOT / next(c['log'] for c in checks if c['name'] == 'rust')).read_text())
    counts = {'frontendSummary': [line.strip() for line in frontend.splitlines() if re.match(r'\s*(Test Files|Tests)\s+', line)],
              'rustSummary': [line.strip() for line in rust.splitlines() if line.startswith('test result:')]}
    record = {**{k: source[k] for k in ('sourceBase', 'inputCount')},
              'checkedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'sourceStable': before == after, 'changedInputs': changed(before, after),
              'inputsBefore': reference(input_path),
              'inputsAfter': reference(OUT / 'inputs-after-final.json'),
              'protectedBefore': guarded, 'protectedAfter': protected(),
              'protectedUnchanged': guarded == protected(),
              'sourceStageReceipt': reference(source_path),
              'firstSourceStageReceipt': reference(OUT / 'source-verification.json'),
              'harnessStartupDiagnostic': reference(OUT / 'harness-start-note.json'),
              'assertionScopeRepair': reference(OUT / 'settled-assertion-repair.json'),
              'sourceClosure': reference(OUT / 'source-closure.json'),
              'runner': reference(Path(__file__).resolve()),
              'rustReuse': reference(OUT / ('rust-reuse' + suffix + '.json')),
              'checks': checks, 'counts': counts,
              'executedCheckCount': sum(c['executedInThisRun'] for c in checks),
              'reusedCheckCount': sum(not c['executedInThisRun'] for c in checks),
              'allPassed': before == after and guarded == protected() and len(checks) == 7 and all(c['exitCode'] == 0 for c in checks),
              'boundary': 'P19 engineering aggregate only. Frontend/type/build/format executed for this slice; unchanged Rust checks explicitly reuse prior exact-input evidence. Controlled full-App browser, candidate, installed/native and real-Agent acceptance remain separate.'}
    write_json(OUT / 'final-verification.json', record)
    print(json.dumps({'allPassed': record['allPassed'], 'inputCount': len(before), 'counts': counts}), flush=True)
    return 0 if record['allPassed'] else 1


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) == 2 else ''
    if mode not in ('source', 'source-final', 'final'):
        raise SystemExit('Specify source, source-final or final')
    raise SystemExit(final_check() if mode == 'final' else source_checks(mode == 'source-final'))
