"""Visual-area selection and historical-anchor recovery installation verifier, using ten scoped checks.

Run only after root confirms installation and completed retention evidence.
Never opens the original database, installs, launches, quits, or deletes a bundle.
Only an exclusive receipt and disposable private SQLite copies are written.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
from contextlib import closing
from datetime import datetime, timezone
import zipfile

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
PRIVATE = ROOT / 'output/2026-10-10-visual-area-install'
EXPECTED = sys.argv[1]
FORMAL = Path('/Applications/Farfold.app')
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
NAMES = {'farfold.sqlite3', 'farfold.sqlite3-wal', 'farfold.sqlite3-shm'}

# This reviewed module defines read-only helpers; its exclusive receipt main is
# protected by __name__ and is not executed by this import.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('candidate_read_helpers', OUT / 'verify-candidate.py')
candidate_helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate_helpers)
require = candidate_helpers.require
sha = candidate_helpers.sha
read = candidate_helpers.read_json
regular = candidate_helpers.regular
files = candidate_helpers.bundle_files


def run(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=30)
    require(result.returncode == 0, 'Read-only inspection command failed')
    return (result.stdout + result.stderr).strip()


def ref(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'bytes': path.stat().st_size}


def process_absent():
    result = subprocess.run(['/usr/bin/pgrep', '-fal', '^/Applications/Farfold.app/Contents/MacOS/farfold'], capture_output=True, timeout=30)
    require(result.returncode == 1 and not result.stdout.strip(), 'Formal app is running or process check failed')
    return {'passed': True, 'exitCode': result.returncode, 'matched': 0}


def signature(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def manifest(phase):
    path = PRIVATE / f'install-data-{phase}.jsonl'
    regular(path)
    before = path.stat()
    require(stat.S_IMODE(before.st_mode) == 0o600 and before.st_uid == os.getuid(), 'Private manifest ownership/mode differs')
    summary = read(PRIVATE / f'install-data-{phase}-summary.json')
    require(set(summary) == {'counts', 'sha256'}, 'Incomplete manifest summary')
    counts = {root: dict.fromkeys(('directory', 'file', 'symlink', 'special'), 0) for root in ('appData', 'webkit', 'cache')}
    roots, captured = set(), {}
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as handle:
        require(signature(os.fstat(handle.fileno())) == signature(before), 'Manifest changed before opening')
        for line in handle:
            digest.update(line)
            item = json.loads(line)
            root, kind = item['root'], item['kind']
            require(root in counts and kind in counts[root], 'Invalid manifest entry')
            require(isinstance(item['path'], str), 'Invalid manifest path')
            counts[root][kind] += 1
            if item['path'] == '.':
                require(kind == 'directory' and root not in roots, 'Duplicate/invalid manifest root')
                roots.add(root)
            if root == 'appData' and item['path'] in {'./' + name for name in NAMES}:
                name = item['path'][2:]
                require(kind == 'file' and name not in captured, 'Invalid retained metadata manifest entry')
                captured[name] = item['sha256']
        require(signature(os.fstat(handle.fileno())) == signature(before), 'Manifest changed during reading')
    require(signature(path.stat()) == signature(before), 'Manifest path changed')
    require(roots == set(counts) and counts == summary['counts'] and digest.hexdigest() == summary['sha256'], 'Manifest count/hash mismatch')
    return summary, captured, {'phase': phase, 'sha256': digest.hexdigest(), 'bytes': before.st_size, 'entries': sum(sum(c.values()) for c in counts.values()), 'mode': '0600'}


def logical_copy_digest(directory, name):
    with closing(sqlite3.connect(directory / name)) as connection:
        connection.execute('PRAGMA query_only=ON')
        require(connection.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'Disposable metadata copy integrity failed')
        digest = hashlib.sha256()
        for line in connection.iterdump():
            digest.update(line.encode('utf-8'))
            digest.update(b'\n')
        return digest.hexdigest()


def verify_metadata(backup, captured_maps):
    captured = backup['capturedFiles']
    require(set(captured) <= NAMES and 'farfold.sqlite3' in captured, 'Unexpected captured metadata set')
    require(backup['sourceAndCaptureUnchanged'] is True and backup['integrity'] == 'ok' and backup['privateMode'] == '0600', 'Backup receipt not verified')
    require(all(item == captured for item in captured_maps), 'Captured metadata does not match installation manifests')
    retained = PRIVATE / 'metadata-source'
    regular(retained, directory=True)
    require({p.name for p in retained.iterdir()} == set(captured), 'Unexpected retained copy members')
    retained_paths = {name: retained / name for name in captured}
    backup_path = PRIVATE / 'metadata-before.sqlite3'
    expected = {**{p: captured[n] for n, p in retained_paths.items()}, backup_path: backup['backupSha256']}
    for path, digest in expected.items():
        require(sha(path) == digest and stat.S_IMODE(path.stat().st_mode) == 0o600, 'Retained metadata hash/mode differs')
    with tempfile.TemporaryDirectory(prefix='install-independent-', dir=PRIVATE) as raw:
        temp = Path(raw)
        left, right = temp / 'captured', temp / 'backup'
        left.mkdir(mode=0o700)
        right.mkdir(mode=0o700)
        for name, path in retained_paths.items():
            shutil.copyfile(path, left / name, follow_symlinks=False)
            os.chmod(left / name, 0o600)
            require(sha(left / name) == captured[name], 'Disposable copy differs')
        shutil.copyfile(backup_path, right / 'farfold.sqlite3', follow_symlinks=False)
        os.chmod(right / 'farfold.sqlite3', 0o600)
        require(sha(right / 'farfold.sqlite3') == backup['backupSha256'], 'Disposable backup copy differs')
        require(logical_copy_digest(left, 'farfold.sqlite3') == logical_copy_digest(right, 'farfold.sqlite3'), 'Captured and backup logical contents differ')
    require(all(sha(path) == digest for path, digest in expected.items()), 'Retained metadata changed during verification')
    return {'passed': True, 'method': 'Read retained captured main/WAL/SHM and backup hashes; SQLite integrity/iterdump digest only on second disposable private copies; original database never opened.', 'captureHashesMatchAllThreeManifests': True, 'capturedFileCount': len(captured), 'capturedAndBackupIntegrity': 'ok', 'logicalContentsEqual': True, 'originalRetainedCopyHashesUnchanged': True, 'backupSha256': backup['backupSha256'], 'rawRowsPrintedOrSaved': False}


def main():
    require(len(EXPECTED) == 40 and all(c in '0123456789abcdef' for c in EXPECTED), 'A full candidate commit is required')
    require(OUT == ROOT / 'docs/evidence/2026-10-09-capability-hardening/visual-area-candidate', 'Unexpected verifier directory')
    regular(PRIVATE, directory=True)
    require(PRIVATE.stat().st_uid == os.getuid(), 'Private directory owner differs')
    receipt_path = OUT / 'install-independent.json'
    descriptor = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    record = {'checkedAtUtc': datetime.now(timezone.utc).isoformat(), 'sourceCommit': EXPECTED, 'result': 'failed', 'failures': [], 'checks': {}, 'methodOrigin': 'Adapted from the reviewed workbook-range ten-check verifier with corrected previousNativeReceipt schema; this is the visual-area invocation.'}
    stage = 'receiptChain'
    with os.fdopen(descriptor, 'w') as handle:
        try:
            names = ['candidate.json', 'candidate-inputs.json', 'candidate-independent.json', 'installed-data-retention.json']
            private_names = ['install-operation.json', 'normal-exit-observation.json', 'metadata-backup-receipt.json']
            private_names += [f'install-data-{p}-summary.json' for p in ('before', 'preinstall', 'after')]
            paths = [OUT / n for n in names] + [PRIVATE / n for n in private_names]
            initial = {p: sha(p) for p in paths}
            candidate, inputs, independent, retention = [read(OUT / n) for n in names]
            operation, normal, backup = [read(PRIVATE / n) for n in private_names[:3]]
            require(candidate['sourceCommit'] == independent['sourceCommit'] == retention['sourceCommit'] == EXPECTED, 'Candidate chain commit differs')
            require(candidate['phase'] == 'internalCandidatePreparedNotInstalled' and candidate['buildExitCode'] == 0, 'Candidate preparation incomplete')
            require(independent['result'] == 'passed' and independent['failures'] == [] and len(independent['checks']) == 9 and all(c['passed'] is True for c in independent['checks'].values()), 'Candidate independent checks incomplete')
            require(independent['inputReceipts'] == {'candidateJsonSha256': initial[OUT / names[0]], 'candidateInputsJsonSha256': initial[OUT / names[1]]}, 'Candidate input receipt hashes differ')
            require(retention['candidateIndependentSha256'] == initial[OUT / names[2]], 'Retention candidate independent hash differs')
            for name, digest in retention['privateEvidence'].items():
                require(Path(name).name == name and sha(PRIVATE / name) == digest, 'Retention private evidence hash differs')
            record['inputReceipts'] = {str(p.relative_to(ROOT)): h for p, h in initial.items()}
            record['checks'][stage] = {'passed': True, 'candidateChecks': 9, 'candidateIndependent': ref(OUT / names[2])}

            stage = 'normalExitAndInstall'
            require(normal['userAuthorizedContinuousDevelopment'] is True and normal['normalQuitObserved'] is True and normal['forcedQuit'] is False and normal['formalProcessCountAfter'] == 0, 'Normal exit observation missing')
            prior_native = normal['previousNativeReceipt']
            require(isinstance(prior_native, dict) and set(prior_native) == {'path', 'sha256'} and isinstance(prior_native['path'], str) and prior_native['path'].startswith('docs/evidence/'), 'Invalid prior normal-exit evidence reference')
            require(sha(ROOT / prior_native['path']) == prior_native['sha256'], 'Prior normal-exit evidence differs')
            require(operation['candidateCommit'] == EXPECTED and operation['phase'] == 'installedVerifiedNotLaunched' and operation['installed'] is True and operation['copyStarted'] is True and operation['launched'] is False and operation['forcedQuit'] is False, 'Install operation did not finish closed')
            require(operation['formalAppProcessesBefore'] == operation['formalAppProcessesAfter'] == 0, 'Install process gate not satisfied')
            require(operation['receiptHashes'] == {'candidate': initial[OUT / names[0]], 'inputs': initial[OUT / names[1]], 'independent': initial[OUT / names[2]]}, 'Install input receipt chain differs')
            require(retention['phase'] == operation['phase'] and retention['normalExit']['forcedQuit'] is False and retention['bundleMatchesCandidate'] is True, 'Public retention phase differs')
            record['checks'][stage] = {'passed': True, 'normalExitObservedBy': 'Root; independent review verifies records/hashes, not a second native observation.', 'operation': ref(PRIVATE / private_names[0]), 'phase': operation['phase'], 'copyStarted': True, 'dataRetentionComparisonPending': 'Historical installer flag; completed aggregate and independent raw manifest checks below close this step.'}

            stage = 'completePrivateManifests'
            snapshots = [manifest(p) for p in ('before', 'preinstall', 'after')]
            require(snapshots[0][0] == snapshots[1][0] == snapshots[2][0], 'Installation manifests differ')
            summary = snapshots[0][0]
            require(retention['dataRetention']['allThreeSnapshotsEqual'] is True and retention['dataRetention']['sha256'] == summary['sha256'] and retention['dataRetention']['counts'] == summary['counts'] and retention['dataRetention']['entries'] == snapshots[0][2]['entries'], 'Public aggregate differs from complete manifests')
            record['checks'][stage] = {'passed': True, 'snapshots': [s[2] for s in snapshots], 'counts': summary['counts'], 'allThreeEqual': True, 'contentsPrinted': False}

            stage = 'metadataCopyProtection'
            record['checks'][stage] = verify_metadata(backup, [s[1] for s in snapshots])
            stage = 'formalCandidateExactFiles'
            bundle = files(FORMAL)
            require(bundle == files(APP) == candidate['candidateFiles'] == operation['installedFiles'] == retention['installedFiles'], 'Formal/candidate/install files differ')
            modes = {n: oct(stat.S_IMODE((FORMAL / n).stat().st_mode)) for n in bundle}
            require(all(stat.S_IMODE((FORMAL / n).stat().st_mode) == stat.S_IMODE((APP / n).stat().st_mode) for n in bundle), 'Formal/candidate modes differ')
            record['checks'][stage] = {'passed': True, 'exactFileCount': len(bundle), 'hashes': bundle, 'modes': modes}

            stage = 'archive'
            archive_path = ROOT / f'src-tauri/target/internal-candidate/2026-10-10-{EXPECTED[:8]}/Farfold-0.1.7-{EXPECTED[:8]}.zip'
            require(candidate['archive'] == str(archive_path) and sha(archive_path) == candidate['archiveSha256'] == operation['archiveSha256'] and archive_path.stat().st_size == candidate['archiveBytes'], 'Archive identity differs')
            with zipfile.ZipFile(archive_path) as archive:
                require(archive.testzip() is None, 'Archive CRC failed')
                entries = [e for e in archive.infolist() if not e.is_dir() and not e.filename.startswith('__MACOSX/')]
                require(len(entries) == 5 and len({e.filename for e in entries}) == 5, 'Archive payload set differs')
                archived = {}
                for entry in entries:
                    require(entry.filename.startswith('Farfold.app/'), 'Archive payload outside bundle')
                    name = entry.filename.removeprefix('Farfold.app/')
                    mode = entry.external_attr >> 16
                    require(name in bundle and stat.S_ISREG(mode) and oct(stat.S_IMODE(mode)) == modes[name], 'Archive member/mode differs')
                    archived[name] = hashlib.sha256(archive.read(entry)).hexdigest()
                require(archived == bundle, 'Archive bytes differ')
            record['checks'][stage] = {'passed': True, **ref(archive_path), 'crc': 'passed', 'exactFiveContentsAndModes': True}

            stage = 'formalIdentitySignature'
            info = plistlib.loads((FORMAL / 'Contents/Info.plist').read_bytes())
            require(info['CFBundleIdentifier'] == 'ai.farfold.desktop' and info['CFBundleShortVersionString'] == '0.1.7' and info['CFBundleExecutable'] == 'farfold', 'Formal identity differs')
            require(info['CFBundleDevelopmentRegion'] == 'zh_CN' and 'zh-Hans' in info['CFBundleLocalizations'], 'Formal localization differs')
            require(sha(FORMAL / 'Contents/Resources/release-manifest.json') == sha(ROOT / 'src-tauri/resources/release-manifest.json'), 'Embedded manifest differs')
            arch = run(['/usr/bin/lipo', '-archs', str(FORMAL / 'Contents/MacOS/farfold')])
            require(arch == 'arm64', 'Formal architecture differs')
            signed = run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(FORMAL)])
            details = run(['/usr/bin/codesign', '-d', '--verbose=4', str(FORMAL)])
            require('Signature=adhoc' in details and 'Identifier=ai.farfold.desktop' in details, 'Formal signature differs')
            record['checks'][stage] = {'passed': True, 'identifier': info['CFBundleIdentifier'], 'version': info['CFBundleShortVersionString'], 'architecture': arch, 'strictCodesign': signed, 'distribution': 'ad-hoc; no public signing/notarization claim'}

            stage = 'exactCandidateSource'
            source = candidate_helpers.verify_source(inputs)
            require(source['inputCount'] == candidate['sourceInputCount'] == operation['sourceInputsVerified'], 'Source count differs')
            record['checks'][stage] = {'passed': True, 'commit': EXPECTED, **source, 'currentBytesAndGitBlobsMatch': True}
            stage = 'formalProcessAbsent'
            record['checks'][stage] = process_absent()
            stage = 'verificationInputsStable'
            candidate_helpers.verify_source(inputs)
            require(all(sha(p) == h for p, h in initial.items()), 'Receipt changed during verification')
            require(all(sha(PRIVATE / f'install-data-{s[2]["phase"]}.jsonl') == s[2]['sha256'] for s in snapshots), 'Private manifest changed during verification')
            require(files(FORMAL) == files(APP) == bundle and sha(archive_path) == candidate['archiveSha256'], 'Artifact changed during verification')
            process_absent()
            record['checks'][stage] = {'passed': True, 'publicAndPrivateReceiptHashesUnchanged': True, 'formalCandidateArchiveRechecked': True}
            record['reviewedHelpers'] = [ref(p) for p in [Path(__file__), OUT / 'verify-candidate.py', OUT / 'verify-data-retention.py', PRIVATE / 'install_verified_candidate.py', PRIVATE / 'backup_metadata.py', PRIVATE / 'install_data_snapshot.py']]
            record['boundaries'] = ['Disk/hash/ZIP/signature/manifests and disposable SQLite verification only; root observed Cmd-Q.', 'No original database opened with SQLite; no rows or credentials printed or saved.', 'No app launch, replacement, quit, or duplicate bundle deletion by this verifier.', 'Installed PDF/image region interaction, historical-anchor recovery journey and real-Agent acceptance remain untested in this receipt.', 'Snapshot equivalence includes captured WAL; no claim beyond captured stable-source checks and equal installation manifests.']
            record['nativeReadyAfterRootDuplicateCleanup'] = True
            record['result'] = 'passed'
        except Exception as error:
            record['failures'].append(stage)
            # Exception details can contain private values; publish type and stage only.
            record['checks'][stage] = {'passed': False, 'errorType': type(error).__name__}
        finally:
            record['completedAtUtc'] = datetime.now(timezone.utc).isoformat()
            handle.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
    print(json.dumps({'result': record['result'], 'checks': len(record['checks']), 'failures': record['failures'], 'receipt': str(receipt_path)}))
    return 0 if record['result'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
