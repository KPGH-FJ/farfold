"""Publish actual completed engineering originals without rewriting them."""
import datetime, hashlib, json, pathlib, re
ROOT = pathlib.Path('/Users/tw/Desktop/farfold')
RUN = ROOT / 'output/2026-10-14-diff-summary-integration/checks-run-02'
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/diff-summary-checks'
def ref(path):
    b = path.read_bytes()
    return {'path': str(path.relative_to(ROOT)), 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
def copy(src, rel):
    target = OUT / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as f: f.write(src.read_bytes())
    assert target.read_bytes() == src.read_bytes()
    return {'original': ref(src), 'published': ref(target)}
s = json.loads((RUN / 'summary.json').read_text())
assert s['allPassed'] and s['completedCount'] == 7 and s['requiredCommandsExecuted'] == 7
assert s['sourceStable'] and s['sourceMembershipStable'] and s['protectedUnchanged']
assert not OUT.exists()
OUT.mkdir()
refs = []
# Preserve the failed first integration attempt independently of this successful run.
prior = ROOT / 'output/2026-10-14-diff-summary-integration/checks-run'
failed = json.loads((prior / 'summary.json').read_text())
assert not failed['allPassed'] and failed['completedCount'] == 3
assert [row['rawExitCode'] for row in failed['checks']] == [0, 0, 1, None, None, None, None]
for path in sorted(prior.rglob('*')):
    if path.is_file():
        assert not path.is_symlink()
        refs.append(copy(path, 'run-01/' + path.relative_to(prior).as_posix() + '.raw'))
refs.append(copy(ROOT / 'output/2026-10-14-diff-summary-integration/checks-freeze/freeze.json', 'run-01/freeze.json.raw'))
for name in ['summary.json','inputs-before.json','inputs-after.json','protected-before.json','protected-after.json','preflight.json','events.jsonl']:
    path = RUN / name
    if path.exists(): refs.append(copy(path, name + '.raw'))
refs.append(copy(ROOT / 'output/2026-10-14-diff-summary-integration/checks-freeze-02/freeze.json', 'freeze.json.raw'))
for stage in s['checks']:
    assert stage['actualStageCompletion'] and stage['rawExitCode'] == 0
    for name in ['started.json','completed.json','stdout.log','stderr.log']:
        path = RUN / stage['name'] / name
        if name in ['stdout.log','stderr.log']:
            assert ref(path)['sha256'] == stage[name.split('.')[0] + 'Sha256']
        refs.append(copy(path, stage['name'] + '/' + name + '.raw'))
front = (RUN / 'frontend-test/stdout.log').read_text()
rust = (RUN / 'cargo-test/stdout.log').read_text()
counts = {'frontendSummaryLines': [x.strip() for x in front.splitlines() if re.search(r'Test Files|Tests\s+\d', x)], 'rustSummaryLines': [x.strip() for x in rust.splitlines() if x.startswith('test result:')]}
result = {**s, 'counts': counts, 'originalPrivateVerification': ref(RUN / 'summary.json'), 'originalPublishedVerification': ref(OUT / 'summary.json.raw'), 'publication': 'publication.json', 'retainedPriorRun': {'summary': ref(OUT / 'run-01/summary.json.raw'), 'actualRootExitCode': 1, 'actualRootChunk': 'a04fbb', 'reason': 'Only an old SSR assertion expected completed wording for an unknown tool; production code unchanged and exact test-only correction separately reviewed.'}}
(OUT / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
(OUT / 'publication.json').write_text(json.dumps({'schema': 1, 'publishedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': refs, 'boundary': s['boundary']}, indent=2) + '\n')
print(json.dumps({'path': str(OUT), 'count':len(refs), 'inputCount':s['inputCount'], 'counts':counts}))
