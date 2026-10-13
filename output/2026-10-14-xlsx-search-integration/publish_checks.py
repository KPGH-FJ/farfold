"""Publish actual completed engineering originals without rewriting them."""
import datetime, hashlib, json, pathlib, re
ROOT = pathlib.Path('/Users/tw/Desktop/farfold')
RUN = ROOT / 'output/2026-10-14-xlsx-search-integration/checks-run'
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/xlsx-search-checks'
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
for name in ['summary.json','inputs-before.json','inputs-after.json','protected-before.json','protected-after.json','preflight.json','events.jsonl']:
    path = RUN / name
    if path.exists(): refs.append(copy(path, name + '.raw'))
refs.append(copy(ROOT / 'output/2026-10-14-xlsx-search-integration/checks-freeze/freeze.json', 'freeze.json.raw'))
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
result = {**s, 'counts': counts, 'originalPrivateVerification': ref(RUN / 'summary.json'), 'originalPublishedVerification': ref(OUT / 'summary.json.raw'), 'publication': 'publication.json'}
(OUT / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
(OUT / 'publication.json').write_text(json.dumps({'schema': 1, 'publishedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': refs, 'boundary': s['boundary']}, indent=2) + '\n')
print(json.dumps({'path': str(OUT), 'count':len(refs), 'inputCount':s['inputCount'], 'counts':counts}))
