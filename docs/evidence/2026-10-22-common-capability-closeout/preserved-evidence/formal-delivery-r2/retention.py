"""Fresh closed-observed byte retention; never launch/quit/install/restore.
Usage: python3 -B retention.py before|preinstall|after <source-commit> <this-file-sha256>
Only before makes a new metadata backup. Every destination is exclusive.
"""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import types

sys.dont_write_bytecode = True
ROOT = Path('<private-mac-home:a2369e920572>')
PREP = ROOT / 'output/2026-10-22-common-capability-closeout/formal-delivery-r2'
OUT = ROOT / 'output/2026-10-22-common-capability-closeout/formal-delivery-r2/install'
SOURCE = Path('<private-mac-home:8fcded45688e> Support/ai.farfold.desktop')
NAMES = ('farfold.sqlite3', 'farfold.sqlite3-wal', 'farfold.sqlite3-shm')
SHARED = {
    'snapshot': ('output/2026-10-14-browser-tabs-install/install_data_snapshot.py', 'cc12f49d05b666cc75b8cf804fa689bdd9b5b010c969d0105738ca7b1c1fc6b6'),
    'manifest': ('output/2026-10-14-browser-tabs-install/data_manifest.py', '1178b92a5528e05c35edcadc84e511fbdb2ff0113fde06c168f25951bf71b662'),
    'io': ('output/2026-10-14-browser-tabs-native-data-preparation/revision-2026-10-15/io_support.py', '3a1488a0c9ba0a9cf5bc34952d2b7df0861792b65eb168ce04f9bebc02acfb1a'),
}


# Only fixed literals from this helper and its three pinned modules may enter failure receipts.
ERROR_CODES = frozenset((
    'Capture directory must be owner-held 0700', 'Complete manifest needs all three roots',
    'Copy reviewed tools to the exact new installation directory before execution',
    'Directory changed while opening', 'Directory changed while reading', 'Directory path differs',
    'Duplicate manifest entry', 'Expected exact capture phase and normal-exit flag', 'File changed while opening',
    'File changed while reading', 'Formal app is running; normal exit is required',
    'Formal app started during snapshot; preserve partial evidence', 'Manifest ancestor is symbolic',
    'Manifest changed while opening', 'Manifest changed while reading', 'Manifest count differs',
    'Manifest entry fields differ', 'Manifest entry is not an object', 'Manifest file size or hash differs',
    'Manifest kind and type disagree', 'Manifest line is incomplete', 'Manifest mode or type is invalid',
    'Manifest must be owner-held 0600', 'Manifest parent is absent or not a directory', 'Manifest path is invalid',
    'Manifest path is not canonical', 'Manifest root must be a directory', 'Manifest root or kind differs',
    'Manifest special type differs', 'Manifest symlink target is invalid',
    'Preparation only: SOURCE_COMMIT is UNSET', 'Special entry changed while reading',
    'Symlink changed while reading', 'Tool source pins disagree', 'after-private-integrity',
    'capture-directory-private-mode', 'copied-bytes-differ', 'directory-path', 'exact-private-backup-paths',
    'expected-phase-and-tool-pin', 'file-changed-on-open', 'file-changed-on-read', 'formal-process-present',
    'fresh-before-receipt-required', 'json-size-limit', 'main-database-absent', 'manifest-metadata-disagree',
    'manifest-sidecars-disagree', 'manifest-validation-differs', 'metadata-drift-at-final-check',
    'metadata-drift-during-manifest', 'metadata-source-owner', 'original-or-raw-drift', 'pinned-file-changed',
    'private-backup-checkpoint-incomplete', 'private-backup-connection-still-open',
    'private-backup-delete-mode-failed', 'private-backup-mode-not-delete',
    'private-backup-not-exclusive-before-wal', 'private-backup-sidecars-after-close',
    'private-backup-still-has-wal', 'private-backup-transaction-open', 'process-observation-failed',
    'regular-owner-file-required', 'second-copy-drift', 'sha-pin-unset', 'shared-path', 'shared-pin',
    'shared-tool-drift', 'source-changed-before-copy', 'source-changed-during-copy', 'source-changed-on-copy-open',
    'source-or-first-copy-drift', 'tool-drift', 'tool-pin-or-path', 'source-commit-unbound', 'source-commit-drift',
))


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def shared(name):
    relative, expected = SHARED[name]; path = ROOT / relative
    require(all(not p.is_symlink() for p in (path, *path.parents)) and path.is_file(), 'shared-path')
    raw = path.read_bytes(); require(hashlib.sha256(raw).hexdigest() == expected, 'shared-pin')
    module = types.ModuleType('retention_' + name); module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)  # Pinned import-safe module; never __main__.
    return module


def private_standalone_backup(working_path, consolidated_path):
    # Reused io_support function; only its exact two output paths change.
    require(working_path == OUT / 'second-working-copy' / NAMES[0] and consolidated_path == OUT / 'metadata-before.sqlite3', 'exact-private-backup-paths')
    with closing(sqlite3.connect(working_path)) as work_db:
        with closing(sqlite3.connect(consolidated_path)) as merged_db:
            locking_before = merged_db.execute('PRAGMA locking_mode=EXCLUSIVE').fetchone()[0]
            require(locking_before == 'exclusive', 'private-backup-not-exclusive-before-wal')
            work_db.backup(merged_db)
            require(not merged_db.in_transaction, 'private-backup-transaction-open')
            mode_before = merged_db.execute('PRAGMA journal_mode').fetchone()[0]
            checkpoint_before = merged_db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
            require(len(checkpoint_before) == 3 and checkpoint_before[0] == 0 and checkpoint_before[1] == checkpoint_before[2], 'private-backup-checkpoint-incomplete')
            require(merged_db.execute('PRAGMA journal_mode=DELETE').fetchone() == ('delete',), 'private-backup-delete-mode-failed')
            checkpoint_after = merged_db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
            require(checkpoint_after == (0, -1, -1), 'private-backup-still-has-wal')
            mode_after = merged_db.execute('PRAGMA journal_mode').fetchone()[0]
            require(mode_after == 'delete', 'private-backup-mode-not-delete')
            require(merged_db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'after-private-integrity')
    for closed_db in (work_db, merged_db):
        try:
            closed_db.execute('SELECT 1')
        except sqlite3.ProgrammingError:
            pass
        else:
            raise RuntimeError('private-backup-connection-still-open')
    require(not any(Path(str(consolidated_path) + suffix).exists() or Path(str(consolidated_path) + suffix).is_symlink() for suffix in ('-wal', '-shm')), 'private-backup-sidecars-after-close')
    return {'lockingBeforeBackupOrFirstWalAccess': locking_before, 'modeBefore': mode_before, 'checkpointBeforeDelete': list(checkpoint_before), 'modeAfter': mode_after, 'checkpointAfterDelete': list(checkpoint_after), 'integrity': 'ok', 'connectionsClosedVerified': True, 'sidecarsAbsentAfterClose': True, 'deletedOrMovedSidecars': False, 'SQLiteOpenScope': 'secondWorkingAndNewConsolidatedOnly'}


def backup(io, output, source, initial, handles):
    folders = []
    for name in ('metadata-source', 'second-working-copy'):
        os.mkdir(name, mode=0o700, dir_fd=output)
        fd = os.open(name, io.DIR_FLAGS, dir_fd=output); handles.append(fd); io.private_directory(fd); folders.append(fd)
    first, working = folders
    for name, expected in initial.items():
        io.copy_file(source, first, name, expected)
    captured = io.inventory(first)
    require(io.same_bytes(initial, captured) and io.inventory(source) == initial, 'source-or-first-copy-drift')
    for name, expected in captured.items():
        io.copy_file(first, working, name, expected)
    require(io.same_bytes(captured, io.inventory(working)), 'second-copy-drift')
    io.write_bytes(output, 'metadata-before.sqlite3', b'')
    normalized = private_standalone_backup(OUT / 'second-working-copy' / NAMES[0], OUT / 'metadata-before.sqlite3')
    require(io.inventory(source) == initial and io.inventory(first) == captured, 'original-or-raw-drift')
    return {'sourceFiles': initial, 'firstCaptureFiles': captured, 'backup': io.read_file(output, 'metadata-before.sqlite3'), 'backupNormalization': normalized, 'sourceAndFirstCaptureUnchanged': True}


def capture(io, snapshot, manifest, output, phase, progress):
    name = 'install-data-' + phase + '.jsonl'
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output)
    digest = hashlib.sha256(); counts = {root: dict.fromkeys(('directory', 'file', 'symlink', 'special'), 0) for root in snapshot.ROOTS}
    with os.fdopen(fd, 'wb') as writer:
        for root, value in snapshot.ROOTS.items():
            progress['stage'] = 'three-root-' + root + '-before-snapshot'
            path = Path(value); parent = snapshot.open_directory(path.parent)
            try:
                progress['stage'] = 'three-root-' + root + '-snapshot'
                snapshot.inspect(writer, digest, counts, parent, path.name, root, '.')
                progress['stage'] = 'three-root-' + root + '-after-snapshot'
            finally:
                os.close(parent)
        progress['stage'] = 'three-root-manifest-flush'
        writer.flush(); os.fsync(writer.fileno())
    progress['stage'] = 'three-root-manifest-validation'
    summary, entries = manifest.validated_manifest(OUT / name)
    progress['stage'] = 'three-root-manifest-summary-check'
    require(summary == {'counts': counts, 'sha256': digest.hexdigest()}, 'manifest-validation-differs')
    return summary, entries


def main():
    require(len(sys.argv) == 4 and sys.argv[1] in ('before', 'preinstall', 'after'), 'expected-phase-and-tool-pin')
    phase, source_commit, tool_pin = sys.argv[1:]; script = Path(__file__).absolute()
    require(len(source_commit) == 40 and all(c in '0123456789abcdef' for c in source_commit), 'source-commit-unbound')
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == source_commit, 'source-commit-drift')
    require(script.parent == PREP and len(tool_pin) == 64 and hashlib.sha256(script.read_bytes()).hexdigest() == tool_pin, 'tool-pin-or-path')
    io, snapshot, manifest = [shared(name) for name in ('io', 'snapshot', 'manifest')]
    observations = [io.process_zero()]  # Exact executable absence; no normal-quit claim.
    OUT.mkdir(mode=0o700, exist_ok=True)
    handles = []; output = source = None; progress = {'stage': 'output-gates'}
    try:
        output = io.open_directory(OUT); handles.append(output); io.private_directory(output)
        if phase != 'before':
            require((OUT / 'retention-before-receipt.json').is_file(), 'fresh-before-receipt-required')
        io.write_json(output, 'retention-' + phase + '-operation.json', {'phase': phase, 'sourceCommit': source_commit, 'startedAtUtc': io.now(), 'closedObserved': True, 'normalQuitEvidence': None})
        progress['stage'] = 'metadata-directory-gate'
        source = io.open_directory(SOURCE); handles.append(source)
        require(os.fstat(source).st_uid == os.getuid(), 'metadata-source-owner')
        progress['stage'] = 'metadata-inventory-before-manifest'
        initial = io.inventory(source)
        summary, entries = capture(io, snapshot, manifest, output, phase, progress)
        progress['stage'] = 'post-manifest-process-zero'
        observations.append(io.process_zero())
        progress['stage'] = 'metadata-inventory-after-manifest'
        require(io.inventory(source) == initial, 'metadata-drift-during-manifest')
        progress['stage'] = 'metadata-versus-manifest-check'
        for name, value in initial.items():
            entry = entries.get(('appData', name), {})
            require((entry.get('sha256'), entry.get('size')) == (value['sha256'], value['bytes']), 'manifest-metadata-disagree')
        require({name for name in NAMES if ('appData', name) in entries} == set(initial), 'manifest-sidecars-disagree')
        record = {'schema': 1, 'phase': phase, 'sourceCommit': source_commit, 'checkedAtUtc': io.now(), 'closedObserved': True, 'normalQuitEvidence': None, 'manifest': summary, 'metadataRawFiles': initial, 'sharedToolPins': {path: pin for path, pin in SHARED.values()}, 'toolSha256': tool_pin}
        if phase == 'before':
            progress['stage'] = 'fresh-second-only-metadata-backup'; record['metadataBackup'] = backup(io, output, source, initial, handles)
        else:
            progress['stage'] = 'fresh-before-manifest-validation'
            prior, _ = manifest.validated_manifest(OUT / 'install-data-before.jsonl')
            record['matchesFreshBeforeManifest'] = summary == prior
        progress['stage'] = 'metadata-inventory-final'
        require(io.inventory(source) == initial, 'metadata-drift-at-final-check')
        progress['stage'] = 'tool-pins-final'
        require(hashlib.sha256(script.read_bytes()).hexdigest() == tool_pin, 'tool-drift')
        for path, pin in SHARED.values():
            require(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == pin, 'shared-tool-drift')
        progress['stage'] = 'final-process-zero'
        observations.append(io.process_zero()); record['processObservations'] = observations
        require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == source_commit, 'source-commit-drift')
        progress['stage'] = 'success-receipts'
        io.write_json(output, 'install-data-' + phase + '-summary.json', summary)
        io.write_json(output, 'retention-' + phase + '-receipt.json', record)
        safe = {**summary, 'receiptSha256': io.read_file(output, 'retention-' + phase + '-receipt.json')['sha256']}
        if phase == 'before':
            safe['backupSha256'] = record['metadataBackup']['backup']['sha256']
        print(json.dumps(safe, sort_keys=True))
        return 0 if phase == 'before' or record['matchesFreshBeforeManifest'] else 2
    except Exception as error:
        error_code = error.args[0] if type(error) is RuntimeError and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in ERROR_CODES else None
        if output is not None:
            io.write_json(output, 'retention-' + phase + '-failure.json', {'stage': progress['stage'], 'errorClass': type(error).__name__, 'errorCode': error_code, 'checkedAtUtc': io.now(), 'preservePartialOutputs': True, 'automaticRetry': False})
        print(json.dumps({'result': 'failed', 'stage': progress['stage'], 'errorClass': type(error).__name__, 'errorCode': error_code})); return 1
    finally:
        for fd in reversed(handles):
            os.close(fd)


if __name__ == '__main__':
    raise SystemExit(main())
