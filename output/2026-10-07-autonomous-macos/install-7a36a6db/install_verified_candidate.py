import hashlib
import json
import stat
import subprocess
from datetime import datetime, timezone
from pathlib import Path

root = Path('/Users/tw/Desktop/farfold')
own = Path(__file__).parent
receipt = root / 'docs/evidence/2026-10-06-macos-batch1/package-7a36a6db-receipt.json'
candidate = json.loads(receipt.read_text())
app = Path(candidate['candidateApp'])
formal = Path('/Applications/Farfold.app')

def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def files(base):
    assert stat.S_ISDIR(base.lstat().st_mode)
    result = {}
    for path in base.rglob('*'):
        mode = path.lstat().st_mode
        assert stat.S_ISREG(mode) or stat.S_ISDIR(mode)
        if stat.S_ISREG(mode):
            result[str(path.relative_to(base))] = sha(path)
    return result

def process_count():
    value = subprocess.check_output(['ps', '-axo', 'pid=,comm='], text=True)
    return sum(line.split(None, 1)[1] == str(formal / 'Contents/MacOS/farfold')
               for line in value.splitlines() if len(line.split(None, 1)) == 2)

exit_observation = json.loads((own / 'normal-exit-observation.json').read_text())
assert exit_observation['fullMacTestAuthority'] is True and exit_observation['normalQuitObserved'] is True and exit_observation['forcedQuit'] is False
assert exit_observation['exactFormalExecutableProcessesAfter'] == 0
assert process_count() == 0
assert len(candidate['candidateFiles']) == 5
assert files(app) == candidate['candidateFiles']
assert files(formal) == candidate['formalAppFilesBeforeBuild']
archive = Path(candidate['archive'])
assert stat.S_ISREG(archive.lstat().st_mode)
assert sha(archive) == candidate['archiveSha256']
before = json.loads((own / 'install-data-before-summary.json').read_text())
assert set(before) == {'counts', 'sha256'} and len(before['sha256']) == 64
assert (own / 'install-data-before.jsonl').stat().st_mode & 0o777 == 0o600
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
assert process_count() == 0
subprocess.run(['ditto', str(app), str(formal)], check=True)
assert files(formal) == candidate['candidateFiles']
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(formal)], check=True)
assert subprocess.check_output(['lipo', '-archs', str(formal/'Contents/MacOS/farfold')], text=True).strip() == 'arm64'
assert process_count() == 0
record = {'installedAtUtc':datetime.now(timezone.utc).isoformat(),
          'candidateCommit':candidate['sourceCommit'], 'binarySha256':candidate['binarySha256'],
          'userConfirmedSavedNormalExit':False, 'latestUserFullMacTestAuthority':True,
          'normalQuitObservedByAgent':True, 'forcedQuit':False, 'formalAppProcessesBefore':0,
          'onlyFormalAppReplaced':True, 'installedExactFiveFiles':True,
          'strictCodesignExit':0, 'architecture':'arm64',
          'dataRetentionComparisonPending':True, 'launched':False}
with (own/'install-operation.json').open('x') as output:
    json.dump(record, output, indent=2)
    output.write('\n')
print(json.dumps(record), flush=True)
