"""Publish a later successful P30 run and retain the actual first failed run.

Exact preflighted copies; no checks or application commands are launched here.
The first failed P30 run is preserved explicitly. This prepares run-02 only;
it does not assert that run-02 has started or passed, and never reuses P18's
retained failure.
"""
from pathlib import Path
import datetime
import hashlib
import json
import re

ROOT = Path('/Users/tw/Desktop/farfold')
RUN = ROOT / 'output/2026-10-14-browser-tabs-integration/checks-run-02'
FREEZE = ROOT / 'output/2026-10-14-browser-tabs-integration/checks-freeze-02/freeze.json'
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/browser-tabs-checks'
COMMANDS = {
    'format-check': ['corepack', 'pnpm', 'format:check'],
    'typecheck': ['corepack', 'pnpm', 'typecheck'],
    'frontend-test': ['corepack', 'pnpm', 'test'],
    'frontend-build': ['corepack', 'pnpm', 'build'],
    'cargo-fmt': ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml'],
    'cargo-clippy': ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings'],
    'cargo-test': ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked'],
}


def ref(path):
    assert path.is_file() and all(not p.is_symlink() for p in (path, *path.parents))
    data = path.read_bytes()
    return {'path': str(path.relative_to(ROOT)), 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()}


def main():
    assert not OUT.exists()
    summary = json.loads((RUN / 'summary.json').read_text())
    freeze = json.loads(FREEZE.read_text())
    assert summary['allPassed'] and summary['completedCount'] == 7
    assert summary['requiredCommandsExecuted'] == 7
    assert summary['sourceStable'] and summary['sourceMembershipStable'] and summary['protectedUnchanged']
    assert summary['inputCount'] == freeze['inputCount'] == len(freeze['inputs'])
    assert summary['freezeSha256'] == ref(FREEZE)['sha256']
    assert json.loads((RUN / 'inputs-before.json').read_text()) == freeze['inputs']
    assert json.loads((RUN / 'inputs-after.json').read_text()) == freeze['inputs']
    assert json.loads((RUN / 'protected-before.json').read_text()) == freeze['protected']
    assert json.loads((RUN / 'protected-after.json').read_text()) == freeze['protected']
    assert len(freeze['protected']) == 3
    for name, digest in freeze['protected'].items():
        assert ref(ROOT / name)['sha256'] == digest, name
    for name, digest in freeze['inputs'].items():
        assert ref(ROOT / name)['sha256'] == digest, name
    assert [item['name'] for item in summary['checks']] == list(COMMANDS)
    pairs = [(RUN / name, name + '.raw') for name in (
        'summary.json', 'inputs-before.json', 'inputs-after.json',
        'protected-before.json', 'protected-after.json', 'preflight.json', 'events.jsonl')]
    pairs.append((FREEZE, 'freeze.json.raw'))
    prior = ROOT / 'output/2026-10-14-browser-tabs-integration/checks-run'
    prior_freeze = ROOT / 'output/2026-10-14-browser-tabs-integration/checks-freeze/freeze.json'
    failed = json.loads((prior / 'summary.json').read_text())
    old_freeze = json.loads(prior_freeze.read_text())
    assert failed['allPassed'] is False and failed['completedCount'] == 7
    assert failed['requiredCommandsExecuted'] == 7 and failed['failed'] == ['cargo-test']
    assert failed['sourceStable'] and failed['sourceMembershipStable'] and failed['protectedUnchanged']
    assert failed['freezeSha256'] == ref(prior_freeze)['sha256']
    assert failed['inputCount'] == old_freeze['inputCount'] == 2392
    assert json.loads((prior / 'inputs-before.json').read_text()) == old_freeze['inputs']
    assert json.loads((prior / 'inputs-after.json').read_text()) == old_freeze['inputs']
    assert json.loads((prior / 'protected-before.json').read_text()) == old_freeze['protected']
    assert json.loads((prior / 'protected-after.json').read_text()) == old_freeze['protected'] == freeze['protected']
    assert [item['name'] for item in failed['checks']] == list(COMMANDS)
    assert [item['rawExitCode'] for item in failed['checks']] == [0, 0, 0, 0, 0, 0, 101]
    for leaf in ('summary.json', 'inputs-before.json', 'inputs-after.json',
                 'protected-before.json', 'protected-after.json', 'preflight.json', 'events.jsonl'):
        pairs.append((prior / leaf, 'run-01/' + leaf + '.raw'))
    pairs.append((prior_freeze, 'run-01/freeze.json.raw'))
    for item in failed['checks']:
        name = item['name']
        assert item['argv'] == COMMANDS[name] and item['cwd'] == str(ROOT)
        assert item['state'] == 'COMPLETED' and item['actualStageCompletion'] and item['processLaunched']
        assert json.loads((prior / name / 'completed.json').read_text()) == item
        for leaf in ('started.json', 'completed.json', 'stdout.log', 'stderr.log'):
            source = prior / name / leaf
            if leaf.endswith('.log'):
                assert ref(source)['sha256'] == item[leaf.split('.')[0] + 'Sha256']
            pairs.append((source, 'run-01/' + name + '/' + leaf + '.raw'))
    for item in summary['checks']:
        name = item['name']
        assert item['argv'] == COMMANDS[name] and item['cwd'] == str(ROOT)
        assert item['state'] == 'COMPLETED' and item['processLaunched']
        assert item['actualStageCompletion'] and item['rawExitCode'] == 0
        assert json.loads((RUN / name / 'completed.json').read_text()) == item
        for leaf in ('started.json', 'completed.json', 'stdout.log', 'stderr.log'):
            source = RUN / name / leaf
            if leaf.endswith('.log'):
                assert ref(source)['sha256'] == item[leaf.split('.')[0] + 'Sha256']
            pairs.append((source, name + '/' + leaf + '.raw'))
    # Resolve and hash the entire explicit list before the first public write.
    prepared = [(source, relative, ref(source)) for source, relative in pairs]
    assert len({relative for _, relative, _ in prepared}) == len(prepared)
    OUT.mkdir()
    copies = []
    for source, relative, original in prepared:
        assert ref(source) == original
        target = OUT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as handle:
            handle.write(source.read_bytes())
        published = ref(target)
        assert (original['bytes'], original['sha256']) == (published['bytes'], published['sha256'])
        copies.append({'original': original, 'published': published})
    front = (RUN / 'frontend-test/stdout.log').read_text()
    rust = (RUN / 'cargo-test/stdout.log').read_text()
    counts = {
        'frontendSummaryLines': [line.strip() for line in front.splitlines()
                                 if re.search(r'Test Files|Tests\s+\d', line)],
        'rustSummaryLines': [line.strip() for line in rust.splitlines() if line.startswith('test result:')],
    }
    verification = {
        **summary, 'counts': counts,
        'currentScope': 'P30 engineering checks only; native browser pages, real Agent sharing, restart recovery and whole-plan acceptance remain separate. The reused runner raw boundary text is preserved unchanged.',
        'originalPrivateVerification': ref(RUN / 'summary.json'),
        'originalPublishedVerification': ref(OUT / 'summary.json.raw'),
        'publication': 'publication.json',
        'retainedPriorRun': {
            'summary': ref(OUT / 'run-01/summary.json.raw'),
            'actualRootExitCode': 1,
            'actualRootChunk': 'a9baaa',
            'reason': 'The original full run failed in an existing PTY fixture: its three-second readiness wait saw empty output. The following poisoned mutex is a panic consequence. An isolated unchanged test passed; the first failure remains a failure and its cause is not inferred from that isolated pass.',
        },
        'runHistoryBoundary': 'This successful P30 run is separate from the retained first full run with six successful stages and cargo-test exit101. Targeted/browser failures and subsequent PTY diagnosis remain separate evidence. P18 historical failures are not relabeled as P30.',
    }
    (OUT / 'verification.json').write_text(json.dumps(verification, indent=2) + '\n')
    (OUT / 'publication.json').write_text(json.dumps({
        'schema': 1, 'publishedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'files': copies, 'boundary': summary['boundary'],
    }, indent=2) + '\n')
    print(json.dumps({'path': str(OUT), 'count': len(copies), 'inputCount': summary['inputCount'], 'counts': counts}))


if __name__ == '__main__':
    main()
