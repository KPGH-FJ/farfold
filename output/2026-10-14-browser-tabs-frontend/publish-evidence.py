"""Publish only a reviewed, pinned explicit list. Default is read-only validation."""
from pathlib import Path
import argparse, datetime, hashlib, json
ROOT = Path(__file__).resolve().parents[2]
DEST = Path('docs/evidence/2026-10-09-capability-hardening/browser-tabs')
ALLOWED = tuple('output/2026-10-14-browser-tabs-'+x+'/' for x in ('frontend','backend','browser','independent','research'))

def read(path):
    p = Path(path)
    assert not p.is_absolute() and '..' not in p.parts, path
    full = ROOT / p
    assert full.resolve().is_relative_to(ROOT) and not full.is_symlink(), path
    return full.read_bytes()

def check_ref(ref):
    b = read(ref['path'])
    assert len(b) == ref['bytes'] and hashlib.sha256(b).hexdigest() == ref['sha256'], ref['path']
    return b

def exact_event(ref, code, result_path=None):
    event = json.loads(check_ref(ref))
    assert event['type'] == 'event_msg' and event['payload']['type'] == 'item_completed'
    item = event['payload']['item']
    assert item['type'] == 'CommandExecution' and item['exit_code'] == code
    assert item['status'] == ('completed' if code == 0 else 'failed')
    assert event['payload']['completed_at_ms'] >= event['payload']['started_at_ms']
    if result_path:
        lines = item['aggregated_output'].splitlines()
        records = []
        for line in lines:
            try: records.append(json.loads(line))
            except ValueError: pass
        assert any(isinstance(r,dict) and r.get('path') == result_path and r.get('passed') is True for r in records)
    return item

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--selection', default='output/2026-10-14-browser-tabs-frontend/publication-selection-v2.json')
    parser.add_argument('--selection-sha', required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    selection_bytes = read(args.selection)
    assert hashlib.sha256(selection_bytes).hexdigest() == args.selection_sha
    selection = json.loads(selection_bytes)
    assert selection['destination'] == str(DEST)
    records = selection['records']
    assert 0 < len(records) <= 400
    payloads = {}
    source_map = {}
    for r in records:
        assert r['source'].startswith(ALLOWED), r['source']
        target = Path(r['published'])
        assert target.is_relative_to(DEST) and '..' not in target.parts
        assert r['source'] not in source_map and str(target) not in payloads
        data = check_ref({'path':r['source'],'bytes':r['bytes'],'sha256':r['sha256']})
        payloads[str(target)] = data
        source_map[r['source']] = r
    def selected_ref(ref):
        assert ref['path'] in source_map, ref['path']
        r = source_map[ref['path']]
        assert (r['bytes'],r['sha256']) == (ref['bytes'],ref['sha256'])
        return check_ref(ref)
    freezes = []
    for key in ('currentFrontendFreeze','currentBackendFreeze'):
        assert selection[key] in source_map
        freeze = json.loads(read(selection[key]))
        for source in freeze['files'] + freeze.get('unchangedShared',[]): check_ref(source)
        freezes.append(freeze)
    assert len(freezes[0]['files']) == 17 and len(freezes[1]['files']) == 14
    # Null/UNSET final pins reject here, before mkdir/copy. Historical green does
    # not satisfy the final source requirement.
    final = json.loads(selected_ref(selection['finalBrowser']))
    assert final['sourceFreeze']['path'] == selection['currentFrontendFreeze']
    selected_ref(final['sourceFreeze'])
    runs = final['runs']
    assert len(runs) == 2
    engines = set(); maps = []
    for run in runs:
        result = json.loads(selected_ref(run))
        engines.add(result['engine'])
        assert run['actualExitCode'] == 0 and result['passed'] is True
        assert result['inputsStable'] is True and result['before'] == result['after']
        assert not result['errors'] and not result['externalRequests']
        assert len(result['checks']) == run['checks'] and all(c['pass'] is True for c in result['checks'])
        assert len(result['scenarios']) == run['scenarios'] and len(result['before']) == run['inputs']
        selected_ref(run['completedCommand'])
        exact_event(run['completedCommand'], 0, run['path'])
        for shot in run['screenshots']: selected_ref(shot)
        for p,digest in result['before'].items():
            assert p.startswith(('src/','output/2026-10-14-browser-tabs-browser/')) or p in ('package.json','pnpm-lock.yaml','vite.config.ts','output/2026-10-14-browser-tabs-research/manual-oracle-v2.json','output/2026-10-14-browser-tabs-research/revision-v2.json'), p
            assert hashlib.sha256(read(p)).hexdigest() == digest, p
        for source in freezes[0]['files']: assert result['before'][source['path']] == source['sha256']
        maps.append(result['before'])
    assert engines == {'chromium','webkit'} and maps[0] == maps[1]
    selected_ref(selection['finalBrowserCompletionManifest'])
    stopped = json.loads(selected_ref(selection['finalServerStopped']))
    assert stopped['stopSignal'] == 'SIGTERM' and stopped['actualExitCode'] == 143
    assert stopped['processAbsent'] is True and stopped['listenerAbsent'] is True
    selected_ref(stopped['completion']); exact_event(stopped['completion'],143)
    summary = {'schema':'browser-tabs-publication/v1','atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'selection':{'path':args.selection,'bytes':len(selection_bytes),'sha256':args.selection_sha},'records':records,'files':[{'original':{'path':r['source'],'bytes':r['bytes'],'sha256':r['sha256']},'published':{'path':r['published'],'bytes':r['bytes'],'sha256':r['sha256']}} for r in records],'scope':'Versioned source, controlled tests, synthetic full App browser evidence and actual command receipts. No native/Agent/Windows/installation or restart recovery proof.'}
    def published(path):
        r=source_map[path]
        return {'path':r['published'],'bytes':r['bytes'],'sha256':r['sha256']}
    verification = {'phase':'P30 runtime browser tabs, frontend v5/backend v2','scope':selection['finalBoundary'],'frontend':published(selection['currentFrontendFreeze']),'backend':published(selection['currentBackendFreeze']),'browser':published(selection['finalBrowser']['path']),'serverStopped':published(selection['finalServerStopped']['path']),'validation':{'backend':{'tests':178,'actualExitCode':0},'frontendV4':{'files':11,'tests':241,'actualExitCode':0},'frontendV5Delta':{'files':3,'tests':74,'actualExitCode':0,'scope':'one guard dependency and regression; v4 target set not rerun'},'browser':[{'engine':json.loads(read(r['path']))['engine'],'checks':r['checks'],'scenarios':r['scenarios'],'inputs':r['inputs'],'actualExitCode':0} for r in runs]},'historicalCorrection':'Original 138 green omitted reverse task B preservation; run5-7 true product failures and diagnostic cause remain raw. v4/v5 141 results are separate. Early driver assumptions, visual defects, test fixture errors and source defects retain their original classifications.','publication':'publication.json','notComplete':['P30 restart browser state restoration','Native WebView/installed App acceptance','Real Agent and NEW24','Windows execution','Whole seven checks and install for this slice']}
    # All validation precedes the first public write. A nonempty/existing target
    # is rejected; never overwrite or remove an earlier publication.
    destination = ROOT / DEST
    assert not destination.exists(), destination
    if args.publish:
        destination.mkdir(parents=True,exist_ok=False)
        for p,data in payloads.items():
            target=ROOT/p; target.parent.mkdir(parents=True,exist_ok=True)
            with target.open('xb') as f:f.write(data)
            assert target.read_bytes()==data
        for name,value in [('publication.json',summary),('verification.json',verification)]:
            with (destination/name).open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
    print(json.dumps({'mode':'published' if args.publish else 'checked-only','records':len(records),'rawBytes':sum(map(len,payloads.values())),'destination':str(DEST),'sourceFiles':31,'engines':sorted(engines)}))
if __name__ == '__main__':main()
