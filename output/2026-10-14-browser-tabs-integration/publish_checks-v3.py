"""Prepare publication of a future successful P30 run and both original failures.

Existence of this script is not a test result. It performs all success, history,
source and exact-copy checks before creating a new public directory. It never
launches checks or application commands. Earlier publisher versions stay intact.
"""
from pathlib import Path
import datetime
import hashlib
import json
import re

ROOT = Path('/Users/tw/Desktop/farfold')
INTEGRATION = ROOT / 'output/2026-10-14-browser-tabs-integration'
RUN = INTEGRATION / 'checks-run-03'
FREEZE = INTEGRATION / 'checks-freeze-03/freeze.json'
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/browser-tabs-checks'
CURRENT_SCOPE = 'P30 engineering checks only; native browser pages, real Agent sharing, restart recovery and whole-plan acceptance remain separate. The reused runner raw boundary text is preserved unchanged.'
HISTORY_BOUNDARY = 'The successful current P30 run is separate from every retained failed formal run listed in retainedPriorRuns. Each original result remains unchanged; isolated or instrumented diagnoses are not repairs or substitutes for formal engineering. P18 historical failures are not relabeled as P30.'
PRIOR_RUNS = (
    {
        'run': 'checks-run', 'freeze': 'checks-freeze/freeze.json', 'published': 'run-01',
        'summarySha256': 'cf5ae2a88fd7d1834316a8876f02ba9d004fe2336be36540a033d92d79d39685',
        'freezeSha256': '424053c3ebbae4e6041cea3344a0f8e4dbab9fd8f2914d80887ca608f151918f',
        'actualRootExitCode': 1, 'actualRootChunk': 'a9baaa',
        'reason': 'Original P30 formal run 01 failed its three-second readiness guard with empty collected PTY output. The assertion did not distinguish elapsed timeout from a closed ready channel. Cause remains unresolved; the following mutex poison is secondary to the panic.',
    },
    {
        'run': 'checks-run-02', 'freeze': 'checks-freeze-02/freeze.json', 'published': 'run-02',
        'summarySha256': '9b830d61a4a44a7130dd7821f18af0e3128b55f34b0d38b945b09755d9236ee5',
        'freezeSha256': '3c498f0e173aa83292014037a729e167873a2ab9748f4adbb8964830f91a135b',
        'actualRootExitCode': 1, 'actualRootChunk': '174aac',
        'reason': 'Original P30 formal run 02 failed the same readiness guard after original sources were restored. Empty collected PTY output and the subsequent poison remain original failures; passing isolated or instrumented diagnoses do not establish a repair or their cause.',
    },
)
COMMANDS = {
    'format-check': ['corepack', 'pnpm', 'format:check'],
    'typecheck': ['corepack', 'pnpm', 'typecheck'],
    'frontend-test': ['corepack', 'pnpm', 'test'],
    'frontend-build': ['corepack', 'pnpm', 'build'],
    'cargo-fmt': ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml'],
    'cargo-clippy': ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings'],
    'cargo-test': ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked'],
}
BASE_FILES = ('summary.json', 'inputs-before.json', 'inputs-after.json',
              'protected-before.json', 'protected-after.json', 'preflight.json', 'events.jsonl')


def ref(path):
    assert path.is_file() and all(not p.is_symlink() for p in (path, *path.parents))
    data = path.read_bytes()
    return {'path': str(path.relative_to(ROOT)), 'bytes': len(data),
            'sha256': hashlib.sha256(data).hexdigest()}


def read(path):
    ref(path)
    return json.loads(path.read_bytes())


def checked_run(run, freeze_path, passed, prefix):
    summary, freeze = read(run / 'summary.json'), read(freeze_path)
    assert summary['schema'] == 1 and summary['phase'] == 'ACTUAL_COMMAND_RESULTS'
    assert summary['allPassed'] is passed
    assert summary['completedCount'] == summary['requiredCommandsExecuted'] == len(COMMANDS)
    assert summary['runnerErrors'] == summary['launchFailed'] == summary['notStarted'] == []
    assert summary['interruptedSignal'] is None
    assert all(summary[k] is True for k in ('sourceStable', 'sourceMembershipStable', 'protectedUnchanged'))
    assert summary['inputCount'] == freeze['inputCount'] == len(freeze['inputs'])
    assert summary['freezeSha256'] == ref(freeze_path)['sha256']
    assert read(run / 'inputs-before.json') == read(run / 'inputs-after.json') == freeze['inputs']
    assert read(run / 'protected-before.json') == read(run / 'protected-after.json') == freeze['protected']
    assert len(freeze['protected']) == 3 and freeze['changesSincePreparation'] == []
    assert [item['name'] for item in summary['checks']] == list(COMMANDS)
    pairs = [(run / name, prefix + name + '.raw') for name in BASE_FILES]
    pairs.append((freeze_path, prefix + 'freeze.json.raw'))
    failed = []
    for index, item in enumerate(summary['checks']):
        name = item['name']
        assert item['argv'] == COMMANDS[name] and item['cwd'] == str(ROOT)
        assert item['group'] == ('frontend' if index < 4 else 'native')
        assert item['state'] == 'COMPLETED' and item['actualStageCompletion'] is True
        assert item['processLaunched'] is True and type(item['rawExitCode']) is int
        if item['rawExitCode'] != 0:
            failed.append(name)
        assert read(run / name / 'completed.json') == item
        started = read(run / name / 'started.json')
        assert all(item[k] == value for k, value in started.items())
        for leaf in ('started.json', 'completed.json', 'stdout.log', 'stderr.log'):
            source = run / name / leaf
            if leaf.endswith('.log'):
                assert ref(source)['sha256'] == item[leaf.split('.')[0] + 'Sha256']
            pairs.append((source, prefix + name + '/' + leaf + '.raw'))
    assert summary['failed'] == failed and bool(failed) is (not passed)
    assert len(pairs) == len(BASE_FILES) + 1 + len(COMMANDS) * 4
    return summary, freeze, pairs


def main():
    assert not OUT.exists()
    summary, freeze, pairs = checked_run(RUN, FREEZE, True, '')
    for mapping in (freeze['inputs'], freeze['protected']):
        for name, digest in mapping.items():
            assert ref(ROOT / name)['sha256'] == digest, name
    retained = []
    assert len({p['run'] for p in PRIOR_RUNS}) == len(PRIOR_RUNS)
    assert len({p['published'] for p in PRIOR_RUNS}) == len(PRIOR_RUNS)
    for previous in PRIOR_RUNS:
        prior, prior_freeze = INTEGRATION / previous['run'], INTEGRATION / previous['freeze']
        assert prior != RUN and prior_freeze != FREEZE
        assert ref(prior / 'summary.json')['sha256'] == previous['summarySha256']
        assert ref(prior_freeze)['sha256'] == previous['freezeSha256']
        _, old_freeze, old_pairs = checked_run(prior, prior_freeze, False, previous['published'] + '/')
        assert old_freeze['protected'] == freeze['protected']
        pairs.extend(old_pairs)
        retained.append(previous)
    prepared = [(source, relative, ref(source)) for source, relative in pairs]
    assert len({relative for _, relative, _ in prepared}) == len(prepared)
    assert len(prepared) == (len(PRIOR_RUNS) + 1) * (len(BASE_FILES) + 1 + len(COMMANDS) * 4)
    # All original receipts/log hashes and current frozen bytes pass before writes.
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
    front, rust = (RUN / 'frontend-test/stdout.log').read_text(), (RUN / 'cargo-test/stdout.log').read_text()
    counts = {
        'frontendSummaryLines': [line.strip() for line in front.splitlines() if re.search(r'Test Files|Tests\s+\d', line)],
        'rustSummaryLines': [line.strip() for line in rust.splitlines() if line.startswith('test result:')],
    }
    verification = {
        **summary, 'counts': counts, 'currentScope': CURRENT_SCOPE,
        'originalPrivateVerification': ref(RUN / 'summary.json'),
        'originalPublishedVerification': ref(OUT / 'summary.json.raw'),
        'publication': 'publication.json',
        'retainedPriorRuns': [
            {'summary': ref(OUT / old['published'] / 'summary.json.raw'),
             'actualRootExitCode': old['actualRootExitCode'], 'actualRootChunk': old['actualRootChunk'],
             'reason': old['reason']} for old in retained
        ],
        'runHistoryBoundary': HISTORY_BOUNDARY,
    }
    (OUT / 'verification.json').write_text(json.dumps(verification, indent=2) + '\n')
    (OUT / 'publication.json').write_text(json.dumps({
        'schema': 1, 'publishedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'files': copies, 'boundary': summary['boundary'],
    }, indent=2) + '\n')
    print(json.dumps({'path': str(OUT), 'count': len(copies), 'inputCount': summary['inputCount'], 'counts': counts}))


if __name__ == '__main__':
    main()
