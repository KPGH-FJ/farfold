"""Read-only installation verification; private manifests never become public output."""
import importlib.util
import hashlib
import os
import shutil
import sqlite3
import stat
import tempfile
from contextlib import closing
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('candidate_checks', Path(__file__).with_name('verify-candidate.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
PRIVATE = v.ROOT / 'output/2026-10-10-skills-qualified-names-install'
NAMES = {'farfold.sqlite3', 'farfold.sqlite3-wal', 'farfold.sqlite3-shm'}


def absent():
    result = subprocess.run(['pgrep', '-fal', '^/Applications/Farfold.app/Contents/MacOS/farfold'], capture_output=True, timeout=30)
    v.need(result.returncode == 1 and not result.stdout, 'Formal application is running or process check failed')


def signature(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def manifest(phase):
    path = PRIVATE / f'install-data-{phase}.jsonl'
    v.regular(path)
    before = path.stat()
    v.need(stat.S_IMODE(before.st_mode) == 0o600 and before.st_uid == os.getuid(), 'Private manifest ownership/mode differs')
    summary = v.read(PRIVATE / f'install-data-{phase}-summary.json')
    v.need(set(summary) == {'counts', 'sha256'}, 'Incomplete manifest summary')
    counts = {root: dict.fromkeys(('directory', 'file', 'symlink', 'special'), 0) for root in ('appData', 'webkit', 'cache')}
    roots, captured = set(), {}
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        v.need(signature(os.fstat(handle.fileno())) == signature(before), 'Manifest changed before opening')
        for line in handle:
            digest.update(line)
            item = v.json.loads(line)
            root, kind = item['root'], item['kind']
            v.need(root in counts and kind in counts[root], 'Invalid manifest entry')
            v.need(isinstance(item['path'], str), 'Invalid manifest path')
            counts[root][kind] += 1
            if item['path'] == '.':
                v.need(kind == 'directory' and root not in roots, 'Duplicate/invalid manifest root')
                roots.add(root)
            if root == 'appData' and item['path'] in {'./' + name for name in NAMES}:
                name = item['path'][2:]
                v.need(kind == 'file' and name not in captured, 'Invalid retained metadata manifest entry')
                captured[name] = item['sha256']
        v.need(signature(os.fstat(handle.fileno())) == signature(before), 'Manifest changed during reading')
    v.need(signature(path.stat()) == signature(before), 'Manifest path changed')
    v.need(roots == set(counts) and counts == summary['counts'] and digest.hexdigest() == summary['sha256'], 'Manifest count/hash mismatch')
    return summary, captured, {'phase': phase, 'sha256': digest.hexdigest(), 'bytes': before.st_size, 'entries': sum(sum(c.values()) for c in counts.values()), 'mode': '0600'}


def logical_copy_digest(directory, name):
    v.regular(directory / name)
    with closing(sqlite3.connect(directory / name)) as connection:
        connection.execute('PRAGMA query_only=ON')
        v.need(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'Disposable metadata copy integrity failed')
        digest = hashlib.sha256()
        for line in connection.iterdump():
            digest.update(line.encode('utf-8'))
            digest.update(b'\n')
        return digest.hexdigest()


def verify_metadata(backup, captured_maps):
    captured = backup['capturedFiles']
    v.need(set(captured) <= NAMES and 'farfold.sqlite3' in captured, 'Unexpected captured metadata set')
    v.need(backup['sourceAndCaptureUnchanged'] is True and backup['integrity'] == 'ok' and backup['privateMode'] == '0600', 'Backup receipt not verified')
    v.need(all(item == captured for item in captured_maps), 'Captured metadata does not match installation manifests')
    retained = PRIVATE / 'metadata-source'
    v.regular(retained, directory=True)
    v.need({p.name for p in retained.iterdir()} == set(captured), 'Unexpected retained copy members')
    retained_paths = {name: retained / name for name in captured}
    backup_path = PRIVATE / 'metadata-before.sqlite3'
    expected = {**{p: captured[n] for n, p in retained_paths.items()}, backup_path: backup['backupSha256']}
    for path, digest in expected.items():
        v.need(v.sha(path) == digest and stat.S_IMODE(path.stat().st_mode) == 0o600, 'Retained metadata hash/mode differs')
    with tempfile.TemporaryDirectory(prefix='install-independent-', dir=PRIVATE) as raw:
        temp = Path(raw)
        left, right = temp / 'captured', temp / 'backup'
        left.mkdir(mode=0o700)
        right.mkdir(mode=0o700)
        for name, path in retained_paths.items():
            shutil.copyfile(path, left / name, follow_symlinks=False)
            v.regular(left / name)
            os.chmod(left / name, 0o600)
            v.need(v.sha(left / name) == captured[name], 'Disposable copy differs')
        shutil.copyfile(backup_path, right / 'farfold.sqlite3', follow_symlinks=False)
        v.regular(right / 'farfold.sqlite3')
        os.chmod(right / 'farfold.sqlite3', 0o600)
        v.need(v.sha(right / 'farfold.sqlite3') == backup['backupSha256'], 'Disposable backup copy differs')
        v.need(logical_copy_digest(left, 'farfold.sqlite3') == logical_copy_digest(right, 'farfold.sqlite3'), 'Captured and backup logical contents differ')
    v.need(all(v.sha(path) == digest for path, digest in expected.items()), 'Retained metadata changed during verification')
    return {'passed': True, 'method': 'Read retained captured main/WAL/SHM and backup hashes; SQLite integrity/iterdump digest only on second disposable private copies; original database never opened.', 'captureHashesMatchAllThreeManifests': True, 'capturedFileCount': len(captured), 'capturedAndBackupIntegrity': 'ok', 'logicalContentsEqual': True, 'originalRetainedCopyHashesUnchanged': True, 'backupSha256': backup['backupSha256'], 'rawRowsPrintedOrSaved': False}


def main():
    commit, proof = v.arguments()
    report = {'sourceCommit': commit, 'result': 'failed', 'checks': {}, 'failures': [], 'startedAt': v.now(), 'launched': False}
    watched = {}

    def load(path):
        watched[str(path.relative_to(v.ROOT))] = v.sha(path)
        return v.read(path)

    stage = 'candidateChain'
    with v.exclusive(v.OUT / 'install-independent.json') as handle:
        try:
            c = load(v.OUT / 'candidate.json')
            inputs = load(v.OUT / 'candidate-inputs.json')
            independent = load(v.OUT / 'candidate-independent.json')
            operation = load(PRIVATE / 'install-operation.json')
            v.need(c['sourceCommit'] == independent['sourceCommit'] == operation['candidateCommit'] == commit, 'Candidate identity mismatch')
            v.need(c['phase'] == 'internalCandidatePreparedNotInstalled' and c['buildExitCode'] == 0, 'Candidate preparation failed')
            v.need(independent['result'] == 'passed' and independent['failures'] == [] and len(independent['checks']) == 9 and all(x['passed'] for x in independent['checks'].values()), 'Candidate verification incomplete')
            v.need(independent['inputReceipts'] == {'candidateJsonSha256': v.sha(v.OUT / 'candidate.json'), 'candidateInputsJsonSha256': v.sha(v.OUT / 'candidate-inputs.json')}, 'Candidate references changed')
            report['checks'][stage] = {'passed': True, 'candidateChecks': 9}

            stage = 'normalExitAndDataBaseline'
            normal = load(PRIVATE / 'normal-exit-observation.json')
            v.need(normal['userAuthorizedContinuousDevelopment'] is True and normal['normalQuitObserved'] is True and normal['forcedQuit'] is False and normal['formalProcessCountAfter'] == 0 and normal['sourceCommit'] == v.BASELINE_COMMIT, 'Normal exit missing')
            expected_refs = {
                'output/2026-10-10-skills-inventory-native/final-normal-exit.json': '4b194e36e2e837fe13b1872828523b8a97a1f5076f0d722fd3ab4fcb5e1065f5',
                'output/2026-10-10-skills-inventory-native/freeze-release.json': '6a26f003a04c88929588bf1a35c0f65c0f97c4b2bfb28e9c12319d984222aa16',
                'output/2026-10-10-skills-inventory-native/final-data-comparison-independent.json': '965499093bfd6a8daa07dab8dff9a4dce18788668d85ad0abcc4b029bd094e3b',
                'output/2026-10-10-skills-inventory-native/final-agent-columns-independent.json': 'd98c37383b478e10517ee8a35059195a435f484a309c93d5960e1688e9a39218',
            }
            v.need(normal['refs'] == expected_refs and bool(normal['normalQuitEvidence']), 'Exact normal-exit references missing or changed')
            for name, expected in normal['refs'].items():
                path = v.relative(name)
                v.need(v.sha(path) == expected, 'Normal exit reference changed')
                load(path)
            prior = v.ROOT / 'output/2026-10-10-skills-inventory-native'
            exit_record, release, data, agents = [load(prior / n) for n in ('final-normal-exit.json', 'freeze-release.json', 'final-data-comparison-independent.json', 'final-agent-columns-independent.json')]
            v.need(exit_record['sourceCommit'] == release['sourceCommit'] == v.BASELINE_COMMIT and exit_record['normalQuitObserved'] and not exit_record['forcedQuit'] and exit_record['formalProcessCountAfter'] == 0, 'Wrong prior normal exit')
            v.need(release['released'] and release['formalClosed'] and bool(release['rootAcceptedDataDelta']), 'Prior data review not complete')
            v.need(release['sourceAndFormalStableThroughRecordedExit'] is True and release['sourceInputCount'] == 1404, 'Prior frozen identity not verified')
            for name, expected in release['refs'].items():
                path = v.relative(name)
                v.need(v.sha(path) == expected, 'Freeze reference changed')
                load(path)
            v.need(all(release['refs'].get(name) == expected for name, expected in expected_refs.items() if not name.endswith('/freeze-release.json')), 'Freeze belongs to a different data review')
            comparison_name = str((prior / 'final-data-comparison-independent.json').relative_to(v.ROOT))
            v.need(agents['mainComparison'] == {'path': comparison_name, 'sha256': expected_refs[comparison_name]}, 'Agent column review belongs to a different comparison')
            v.need(data['baseline']['wholeSessionRows'] == 130 and data['baseline']['unsentGroups'] == {'composers': 8, 'feedback': 8, 'queues': 3} and data['sessionDifferences'] == data['addedSessions'] == [] and data['allSettingsDifferences'] == [], 'Prior retained data scope differs')

            v.need(data['oldWholeRowsExact'] and data['unsentWholeObjectEqual'] and data['allSettingsRawValuesEqual'] and data['retainedInputsUnchanged'], 'Prior protected data differs')
            v.need(agents['allStoredAgentConfigurationColumnsExact'] and agents['storedModelReasoningChoicesExact'] and agents['inputsUnchanged'], 'Prior Agent configuration differs')
            v.need(len(agents['differences']) == 1 and agents['differences'][0]['id'] == 'codex' and agents['differences'][0]['changedColumns'] == ['updated_at'], 'Prior delta exceeds reviewed timestamp')
            report['checks'][stage] = {'passed': True, 'baselineCommit': v.BASELINE_COMMIT, 'reviewedDelta': 'codex.updated_at only'}

            stage = 'completeDataManifests'
            snapshots, captured_maps = [], []
            for phase in ('before', 'preinstall', 'after'):
                summary, captured, detail = manifest(phase)
                path = PRIVATE / ('install-data-' + phase + '.jsonl')
                load(PRIVATE / ('install-data-' + phase + '-summary.json'))
                watched[str(path.relative_to(v.ROOT))] = detail['sha256']
                snapshots.append((summary, detail))
                captured_maps.append(captured)
            v.need(snapshots[0][0] == snapshots[1][0] == snapshots[2][0], 'Data changed across installation')
            report['checks'][stage] = {'passed': True, 'snapshots': [x[1] for x in snapshots], 'entryCountEach': snapshots[0][1]['entries'], 'allRecordedContentTypesModesAndLinkTargetsEqual': True}

            stage = 'privateMetadataBackup'
            backup = load(PRIVATE / 'metadata-backup-receipt.json')
            report['checks'][stage] = verify_metadata(backup, captured_maps)
            watched[str((PRIVATE / 'metadata-before.sqlite3').relative_to(v.ROOT))] = backup['backupSha256']
            for name, expected in backup['capturedFiles'].items():
                watched[str((PRIVATE / 'metadata-source' / name).relative_to(v.ROOT))] = expected

            stage = 'installedExactBundle'
            files, modes = v.bundle(v.FORMAL)
            v.need((files, modes) == (c['candidateFiles'], c['candidateModes']) == v.bundle(v.APP), 'Installed files/modes differ')
            v.need(operation['phase'] == 'installedVerifiedNotLaunched' and operation['installed'] and operation['installedExactFiveFiles'] and operation['installedFiles'] == files and operation['launched'] is False and operation['realAgentInvoked'] is False and operation['forcedQuit'] is False and operation['formalAppProcessesBefore'] == operation['formalAppProcessesAfter'] == 0, 'Install operation incomplete')
            v.need(operation['receiptHashes'] == {'candidate': v.sha(v.OUT / 'candidate.json'), 'inputs': v.sha(v.OUT / 'candidate-inputs.json'), 'independent': v.sha(v.OUT / 'candidate-independent.json')}, 'Install receipt references differ')
            report['checks'][stage] = {'passed': True, 'files': files}

            stage = 'archive'
            archive = v.zip_matches(v.archive_path(commit), files, modes)
            v.need(all(c[k] == value for k, value in archive.items()) and operation['archiveSha256'] == archive['archiveSha256'], 'Archive changed')
            report['checks'][stage] = {'passed': True, **archive}

            stage = 'identitySignature'
            # Identity content is byte-identical to the independently verified candidate.
            identity = v.identity()
            architecture = v.run(['lipo', '-archs', str(v.FORMAL / 'Contents/MacOS/farfold')])
            v.need(architecture == 'arm64', 'Formal architecture')
            signature = v.run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(v.FORMAL)])
            report['checks'][stage] = {'passed': True, **identity, 'architecture': architecture, 'strictCodesign': signature, 'distribution': 'ad-hoc only'}

            stage = 'exactSourceAndEngineering'
            v.need(v.source(commit) == inputs and c['sourceInputCount'] == operation['sourceInputsVerified'] == len(inputs), 'Current source changed')
            engineering = v.engineering(proof, inputs)
            v.need(engineering == c['engineeringVerification'], 'Engineering changed')
            watched.update(engineering['references'])
            report['checks'][stage] = {'passed': True, 'inputCount': len(inputs)}

            stage = 'formalProcessAbsent'
            absent()
            report['checks'][stage] = {'passed': True}
            stage = 'verificationInputsStable'
            v.need(v.source(commit) == inputs and v.bundle(v.FORMAL) == (files, modes) and v.bundle(v.APP) == (files, modes), 'Source/bundle drift during verification')
            v.need(all(v.sha(v.relative(p)) == h for p, h in watched.items()) and v.zip_matches(v.archive_path(commit), files, modes) == archive, 'Evidence drift during verification')
            absent()
            report['checks'][stage] = {'passed': True}
            report.update(result='passed', inputReceipts=watched)
        except Exception as error:
            report['checks'][stage] = {'passed': False, 'error': str(error)}
            report['failures'].append(stage)
        finally:
            report['completedAt'] = v.now()
            v.save(handle, report)
    print(v.json.dumps({'result': report['result'], 'checks': len(report['checks']), 'failures': report['failures']}))
    return 0 if report['result'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
