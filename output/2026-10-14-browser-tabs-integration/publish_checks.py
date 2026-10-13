"""Publish the first P30 seven-check run only after its actual completion.

Exact preflighted copies; no checks or application commands are launched here.
If the first run fails, preserve it and explicitly adapt this script for a later
run. Never silently drop a failed attempt or reuse P18's retained failure.
"""
from pathlib import Path
import datetime
import hashlib
import json
import re

ROOT = Path('/Users/tw/Desktop/farfold')
RUN = ROOT / 'output/2026-10-14-browser-tabs-integration/checks-run'
FREEZE = ROOT / 'output/2026-10-14-browser-tabs-integration/checks-freeze/freeze.json'
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
        'retainedPriorRun': None,
        'runHistoryBoundary': 'This is the first completed P30 full engineering run. Earlier targeted/browser failures remain in browser-tabs implementation evidence. P18 failed engineering run remains in its original evidence.',
    }
    (OUT / 'verification.json').write_text(json.dumps(verification, indent=2) + '\n')
    (OUT / 'publication.json').write_text(json.dumps({
        'schema': 1, 'publishedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'files': copies, 'boundary': summary['boundary'],
    }, indent=2) + '\n')
    print(json.dumps({'path': str(OUT), 'count': len(copies), 'inputCount': summary['inputCount'], 'counts': counts}))


if __name__ == '__main__':
    main()
