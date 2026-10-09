"""Read completed private manifests and publish aggregate installation evidence only."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import subprocess

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
PRIVATE = ROOT / 'output/2026-10-10-text-selection-keyboard-install'

def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def read(path):
    return json.loads(path.read_text())

summaries = []
for phase in ('before', 'preinstall', 'after'):
    manifest = PRIVATE / f'install-data-{phase}.jsonl'
    summary = read(PRIVATE / f'install-data-{phase}-summary.json')
    assert sha(manifest) == summary['sha256']
    counts = {root: dict.fromkeys(('directory', 'file', 'symlink', 'special'), 0)
              for root in summary['counts']}
    with manifest.open() as handle:
        for line in handle:
            entry = json.loads(line)
            counts[entry['root']][entry['kind']] += 1
    assert counts == summary['counts']
    summaries.append(summary)
assert summaries[0] == summaries[1] == summaries[2]
process = subprocess.run(['pgrep', '-fal', '^/Applications/Farfold.app/Contents/MacOS/farfold'], capture_output=True)
assert process.returncode == 1 and not process.stdout.strip()
operation = read(PRIVATE / 'install-operation.json')
assert operation['phase'] == 'installedVerifiedNotLaunched' and operation['installed']
candidate = read(OUT / 'candidate.json')
formal = Path('/Applications/Farfold.app')
assert {str(p.relative_to(formal)): sha(p) for p in formal.rglob('*') if p.is_file()} == candidate['candidateFiles']
backup = read(PRIVATE / 'metadata-backup-receipt.json')
assert backup['sourceAndCaptureUnchanged'] and backup['integrity'] == 'ok'
assert sha(PRIVATE / 'metadata-before.sqlite3') == backup['backupSha256']
private_names = ['normal-exit-observation.json', 'metadata-backup-receipt.json',
                 'backup_metadata.py', 'install_verified_candidate.py', 'install-operation.json']
private_names += [f'install-data-{phase}.jsonl' for phase in ('before', 'preinstall', 'after')]
record = {
    'checkedAtUtc': datetime.now(timezone.utc).isoformat(),
    'sourceCommit': candidate['sourceCommit'], 'version': candidate['version'],
    'architecture': candidate['architecture'], 'formalApp': str(formal),
    'phase': 'installedVerifiedNotLaunched',
    'normalExit': {'observedByRoot': True, 'forcedQuit': False,
                   'processesBefore': operation['formalAppProcessesBefore'],
                   'processesAfter': operation['formalAppProcessesAfter']},
    'bundleMatchesCandidate': True, 'installedFiles': candidate['candidateFiles'],
    'dataRetention': {'allThreeSnapshotsEqual': True,
                      'entries': sum(sum(v.values()) for v in summaries[0]['counts'].values()),
                      **summaries[0],
                      'scope': 'App data, WebKit and cache before/preinstall/after; formal app not launched between manifests.'},
    'metadataRecoveryCopy': {key: backup[key] for key in ('integrity', 'method', 'sourceAndCaptureUnchanged', 'backupSha256', 'privateMode')},
    'privateEvidence': {name: sha(PRIVATE / name) for name in private_names},
    'candidateIndependentSha256': sha(OUT / 'candidate-independent.json'),
    'installedInteractionVerified': False, 'realAgentAcceptance': False,
    'remaining': ['Installed text selection, historical version ownership and unsent feedback retention', 'Desktop access wait NEW-01',
                  'All remaining capability and Agent standards', 'Public distribution remains deferred'],
}
with (OUT / 'installed-data-retention.json').open('x') as handle:
    handle.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'entries': record['dataRetention']['entries'], 'allThreeEqual': True, 'formalAppRunning': False}))
