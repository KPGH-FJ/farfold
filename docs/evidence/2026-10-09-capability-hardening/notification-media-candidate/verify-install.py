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
PRIVATE = v.ROOT / 'output/2026-10-10-notification-media-install'
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


def verify_prior_baseline(normal, load):
    v.need(normal['userAuthorizedContinuousDevelopment'] is True and normal['normalQuitObserved'] is True and normal['forcedQuit'] is False and normal['formalProcessCountAfter'] == 0 and normal['sourceCommit'] == v.BASELINE_COMMIT, 'Normal exit missing')
    expected_refs = {
        'output/2026-10-10-skills-qualified-names-native/final-normal-exit.json': '9a4365ce9715bcfc7b79f6f9f793dea574298e4a1d1c87757450ff96a234f014',
        'output/2026-10-10-skills-qualified-names-native/freeze-release.json': '1a4b9b31c4b9fcfad83fb0f63888c8a273e34cc6782f0bd2a574a554fe2bb8d3',
        'output/2026-10-10-skills-qualified-names-native/final-data-comparison-independent.json': '172e42aca73e3045d2cb388871f3f6b8ed3c619b58fadb415e560acd44d2a805',
        'docs/evidence/2026-10-09-capability-hardening/skills-qualified-names-candidate/native-independent.json': 'ceb2cece610c3872c51d62740e44a7a28e904d939b117f36fe51f4296ea5c766',
        'docs/evidence/2026-10-09-capability-hardening/skills-qualified-names-candidate/installed-qualified-names.json': '1ec3e6b00d2c857363315b97cc858a5120b12c8c0d118d7000c05d24353e6e95',
    }
    v.need(normal['refs'] == expected_refs and bool(normal['normalQuitEvidence']), 'Exact normal-exit references missing or changed')
    records = {}
    for name, expected in expected_refs.items():
        path = v.relative(name)
        v.need(v.sha(path) == expected, 'Prior normal exit/data reference changed')
        records[path.name] = load(path)
    exit_record, release, data, independent, installed = [records[name] for name in ('final-normal-exit.json', 'freeze-release.json', 'final-data-comparison-independent.json', 'native-independent.json', 'installed-qualified-names.json')]
    v.need(all(record['sourceCommit'] == v.BASELINE_COMMIT for record in (exit_record, release, independent, installed)), 'Wrong prior source identity')
    v.need(exit_record['normalQuitObserved'] is True and exit_record['forcedQuit'] is False and exit_record['formalProcessCountAfter'] == 0, 'Wrong prior normal exit')
    v.need(exit_record['sourceInputCount'] == 1407 and exit_record['sourceInputsUnchanged'] is True and exit_record['formalFiveFilesUnchanged'] is True and exit_record['controlledDirectoriesUnchanged'] is True, 'Prior frozen identity not verified')
    v.need(exit_record['nativeResult']['modelPromptSubmitted'] is False and exit_record['nativeResult']['configurationWriteRequested'] is False, 'Prior controlled scope changed')
    v.need(release['sourceInputCount'] == 1407 and release['sourceInputsStillUnchanged'] is True and release['formalAppClosed'] is True, 'Prior release not complete')
    v.need(release['onlyAcceptedDataDelta'] == 'codex.updated_at 1791641241089 to 1791643265860; other nine Agent columns exact', 'Prior accepted delta differs')
    independent_name = str((v.BASELINE.parent / 'native-independent.json').relative_to(v.ROOT))
    v.need(release['nativeIndependent'] == {'path': independent_name, 'sha256': expected_refs[independent_name]}, 'Release independent review changed')
    v.need(independent['result'] == 'passedWithinStatedScope', 'Prior independent review incomplete')
    independent_refs = {ref['path']: ref['sha256'] for ref in independent['refs']}
    for name in expected_refs:
        if name.endswith(('/final-normal-exit.json', '/final-data-comparison-independent.json', '/installed-qualified-names.json')):
            v.need(independent_refs.get(name) == expected_refs[name], 'Independent review cross-reference differs')
    for name in expected_refs:
        if name.endswith(('/final-normal-exit.json', '/final-data-comparison-independent.json')):
            v.need(installed['privateEvidence'].get(name) == expected_refs[name], 'Root review cross-reference differs')
    root_agents = installed['dataAfterNative']['agents']
    v.need(root_agents == {'count': 40, 'wholeRowsUnchanged': 39, 'onlyChange': 'codex.updated_at', 'before': 1791641241089, 'after': 1791643265860, 'otherNineColumnsExact': True, 'rootDeltaDecision': 'Accepted metadata timestamp update; retained in place, no configuration change or database restoration.'}, 'Root data authorization differs')
    v.need(data['baseline']['wholeSessionRows'] == 130 and data['baseline']['unsentGroups'] == {'composers': 8, 'feedback': 8, 'queues': 3}, 'Prior retained data scope differs')
    v.need(all(data[key] is True for key in ('oldWholeRowsExact', 'unsentWholeObjectEqual', 'unsentSchemaKeysEqual', 'allSettingsRawValuesEqual', 'databaseSchemaEqual', 'retainedInputsUnchanged')), 'Prior protected data differs')
    v.need(all(data[key] == [] for key in ('sessionDifferences', 'addedSessions', 'activityDifferences', 'otherUnsentDifferences', 'otherSettingsDifferences', 'allSettingsDifferences')), 'Prior unreviewed data changes')
    v.need(all(data['oldUnsentGroupsExact'].values()) and all(not values for values in data['unsentGroupDifferences'].values()), 'Prior draft groups differ')
    catalogue = data['catalogue']
    v.need(catalogue['beforeVersion'] == catalogue['afterVersion'] == 3 and catalogue['beforeSha256'] == catalogue['afterSha256'] and catalogue['topLevelKeysEqual'] is True and catalogue['operation'] == catalogue['otherFields'] == [] and all(not values for values in catalogue['collections'].values()), 'Prior catalogue differs')
    v.need(set(data['allTables']) == {'agents', 'dismissed_sessions', 'sessions', 'settings'}, 'Prior table coverage differs')
    for name, count in (('dismissed_sessions', 168), ('sessions', 130), ('settings', 53)):
        table = data['allTables'][name]
        v.need(table['beforeRows'] == table['afterRows'] == count and table['schemaEqual'] is True and table['wholeRowsEqual'] is True and table['rowDifferences'] == [], 'Prior table changed: ' + name)
    agents = data['agentColumnComparison']
    columns = ['id', 'name', 'source', 'command', 'args', 'env', 'version', 'handshake', 'created_at', 'updated_at']
    v.need(agents['beforeRows'] == agents['afterRows'] == 40 and agents['columns'] == columns and agents['everyPriorRowComparedByEveryColumn'] is True and agents['equalColumnsAcrossAllPriorRows'] == columns[:-1], 'Prior Agent column coverage differs')
    v.need(agents['changedRows'] == [{'primaryKeySha256': 'e25eaf648dc7039953915d93cac78cc23b21b780b60f562ff1aaa53086f25364', 'identity': {'id': 'codex', 'name': 'Codex'}, 'changedValuesPrivateOnly': {'updated_at': {'before': 1791641241089, 'after': 1791643265860}}}], 'Prior delta exceeds reviewed timestamp')
    table = data['allTables']['agents']
    v.need(table['beforeRows'] == table['afterRows'] == 40 and table['schemaEqual'] is True and len(table['rowDifferences']) == 1 and table['rowDifferences'][0]['primaryKeySha256'] == agents['changedRows'][0]['primaryKeySha256'] and table['rowDifferences'][0]['changedColumns'] == ['updated_at'], 'Prior Agent table comparison differs')
    v.need(len(data['secondaryCopyChecks']) == 2 and all(item['fullIterdumpEqual'] is True and item['onlyDisposableSqliteCopiesOpened'] is True for item in data['secondaryCopyChecks']), 'Prior copy comparison incomplete')
    return {'passed': True, 'baselineCommit': v.BASELINE_COMMIT, 'reviewedDelta': 'codex.updated_at only', 'priorOriginalSessions': 130, 'priorUnsentGroups': {'composers': 8, 'feedback': 8, 'queues': 3}, 'priorRawSettingsExact': 53, 'zeroPromptBoundary': 'Prior controlled native actions and frozen query implementation; not inferred from database counts.'}


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
            report['checks'][stage] = verify_prior_baseline(normal, load)

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
