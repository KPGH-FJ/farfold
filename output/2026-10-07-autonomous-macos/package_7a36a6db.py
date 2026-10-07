import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/Users/tw/Desktop/farfold')
OWN = ROOT / 'output/2026-10-07-autonomous-macos/package-7a36a6db'
RECEIPT = ROOT / 'docs/evidence/2026-10-06-macos-batch1/package-7a36a6db-receipt.json'
MANIFEST = OWN / 'source-inputs-7a36a6db.json'
LOG = OWN / 'package-7a36a6db-build.log'
HEAD = '7a36a6db284beb7d653eeeb1e8d7bc475959c44c'
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
ARCHIVE = ROOT / 'src-tauri/target/internal-candidate/2026-10-07-7a36a6db/Farfold-0.1.7-7a36a6db.zip'
OLD = json.loads((ROOT / 'docs/evidence/2026-10-06-macos-batch1/package-416d8142-receipt.json').read_text())
SCOPES = ['src', 'assets', 'public', 'scripts', 'src-tauri/src', 'src-tauri/native',
          'src-tauri/capabilities', 'src-tauri/icons', 'src-tauri/resources']
TOP = ['index.html', 'package.json', 'pnpm-lock.yaml', 'tsconfig.app.json',
       'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts',
       'src-tauri/Cargo.lock', 'src-tauri/Cargo.toml', 'src-tauri/build.rs',
       'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json']
owns_receipt = False
record = {'phase': 'candidatePreparationStarted', 'recordedAtUtc': datetime.now(timezone.utc).isoformat(),
          'sourceCommit': HEAD, 'command': 'corepack pnpm tauri:build:internal',
          'candidateApp': str(APP), 'formalApp': str(FORMAL), 'archive': str(ARCHIVE),
          'formalAppReplaced': False, 'runningAppStopped': False, 'installed': False,
          'notarized': False,
          'buildScript':'source/Git/full path and content preflight; no old generated app' }


def persist():
    if not owns_receipt:
        raise RuntimeError('receipt ownership was not acquired')
    RECEIPT.write_text(json.dumps(record, indent=2, ensure_ascii=False) + '\n')


def command(args):
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('verification command failed: ' + args[0] + ' (exit ' + str(result.returncode) + ')')
    return (result.stdout + result.stderr).strip()


def collect_toolchain(args):
    try:
        result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
        return {'exitCode': result.returncode, 'output': (result.stdout + result.stderr).strip()}
    except OSError as error:
        return {'exitCode': None, 'errorKind': type(error).__name__}


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError('non-regular input: ' + str(path.relative_to(ROOT)))
    return info


def enumerate_inputs():
    result = list(TOP)
    for scope in SCOPES:
        base = ROOT / scope
        if not stat.S_ISDIR(base.lstat().st_mode):
            raise RuntimeError('source root is not a real directory: ' + scope)
        for directory, directories, files in os.walk(base, followlinks=False):
            for name in directories:
                if not stat.S_ISDIR((Path(directory) / name).lstat().st_mode):
                    raise RuntimeError('non-directory source entry')
            for name in files:
                if name == '.DS_Store':
                    continue
                path = Path(directory) / name
                regular(path)
                result.append(str(path.relative_to(ROOT)))
    return sorted(set(result))


def source_snapshot(paths):
    content, metadata = {}, {}
    for name in paths:
        path = ROOT / name
        info = regular(path)
        content[name] = sha(path)
        metadata[name] = [info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino]
    return content, metadata


def source_stats(paths):
    result = {}
    for name in paths:
        info = regular(ROOT / name)
        result[name] = [info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino]
    return result


def match_git(paths):
    raw = subprocess.check_output(['git', 'ls-tree', '-r', '-z', HEAD], cwd=ROOT)
    tree = {}
    for item in raw.split(b'\0'):
        if item:
            entry, path = item.split(b'\t', 1)
            mode, kind, oid = entry.decode().split()
            tree[path.decode()] = (mode, kind, oid)
    if command(['git', 'rev-parse', '--show-object-format']) != 'sha1':
        raise RuntimeError('unexpected Git object format')
    expected = {name for name in tree if name in TOP or any(name.startswith(scope + '/') for scope in SCOPES)}
    if set(paths) != expected:
        raise RuntimeError('complete source scope differs from Git path set')
    mismatches = []
    for name in paths:
        tracked = tree.get(name)
        data = (ROOT / name).read_bytes()
        oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        actual_mode = '100755' if regular(ROOT / name).st_mode & 0o111 else '100644'
        if tracked != (actual_mode, 'blob', oid):
            mismatches.append(name)
    if mismatches:
        record['sourceGitMismatches'] = mismatches
        raise RuntimeError('source inputs do not exactly match claimed Git commit')
    return True


def app_files(base):
    if not stat.S_ISDIR(base.lstat().st_mode):
        raise RuntimeError('app root is not a real directory')
    result = {}
    for directory, directories, files in os.walk(base, followlinks=False):
        for name in directories:
            if not stat.S_ISDIR((Path(directory) / name).lstat().st_mode):
                raise RuntimeError('non-directory bundle entry')
        for name in files:
            path = Path(directory) / name
            if not stat.S_ISREG(path.lstat().st_mode):
                raise RuntimeError('non-regular bundle entry')
            result[str(path.relative_to(base))] = sha(path)
    return dict(sorted(result.items()))


try:
    if RECEIPT.exists() or MANIFEST.exists() or LOG.exists() or ARCHIVE.parent.exists():
        raise RuntimeError('new candidate output already exists; do not overwrite')
    with RECEIPT.open('x') as output:
        output.write(json.dumps(record, indent=2, ensure_ascii=False) + '\n')
    owns_receipt = True
    if command(['git', 'rev-parse', 'HEAD']) != HEAD:
        raise RuntimeError('HEAD no longer matches requested commit')
    formal = app_files(FORMAL)
    if formal != OLD['candidateFiles']:
        raise RuntimeError('formal app has changed since known receipt')
    if os.path.lexists(APP):
        raise RuntimeError('generated bundle unexpectedly present before new build')
    old_archive = Path(OLD['archive'])
    if not stat.S_ISREG(old_archive.lstat().st_mode) or sha(old_archive) != OLD['archiveSha256']:
        raise RuntimeError('old archive changed or missing')
    formal_entries = [str(path) for path in Path('/Applications').glob('Farfold*.app')]
    if formal_entries != [str(FORMAL)]:
        raise RuntimeError('unexpected Farfold app entry in /Applications')
    sensitive_inputs = ['.env', '.env.local', '.env.production', '.env.production.local']
    if any(os.path.lexists(ROOT / name) for name in sensitive_inputs):
        raise RuntimeError('untracked build environment file exists; values not read')
    optional_configs = ['.cargo/config', '.cargo/config.toml', '.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs']
    if any(os.path.lexists(ROOT / name) for name in optional_configs):
        raise RuntimeError('additional build configuration requires boundary review')
    environment_keys = ['FARFOLD_UPDATE_ENDPOINT', 'FARFOLD_UPDATE_PUBLIC_KEY', 'TAURI_CONFIG',
                        'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET']
    record['compileEnvironmentPresence'] = {name: name in os.environ for name in environment_keys}
    if any(record['compileEnvironmentPresence'].values()):
        raise RuntimeError('compile environment override present; value not read or emitted')
    record['toolchain'] = {name: collect_toolchain(args) for name, args in {
        'node': ['node', '--version'], 'pnpm': ['corepack', 'pnpm', '--version'],
        'rustc': ['rustc', '--version'], 'cargo': ['cargo', '--version'],
        'developerDirectory': ['xcode-select', '-p'], 'clang': ['xcrun', '--sdk', 'macosx', 'clang', '--version'],
        'macosSdk': ['xcrun', '--sdk', 'macosx', '--show-sdk-version']}.items()}
    paths = enumerate_inputs()
    before, before_stats = source_snapshot(paths)
    old_inputs = json.loads(Path(OLD['sourceInputManifest']).read_text())
    record.update(sourceInputs=len(paths), sourceInputDigest=digest(before),
                  sourceInputDigestAlgorithm='SHA256 of UTF-8 compact JSON with sorted keys',
                  sourceInputStatDigestBefore=digest(before_stats), sourceInputsMatchGitBefore=match_git(paths),
                  newSourcePaths=sorted(set(paths) - set(old_inputs)),
                  removedSourcePaths=sorted(set(old_inputs) - set(paths)),
                  sourceInputManifest=str(MANIFEST), formalAppFilesBeforeBuild=formal,
                  generatedBundleAbsentBeforeBuild=True,
                  oldArchive={'path': str(old_archive), 'sha256': OLD['archiveSha256']},
                  applicationsFarfoldEntries=formal_entries, diskFreeBytesBefore=shutil.disk_usage(ROOT).free,
                  sourceInputScope={'recursive': SCOPES, 'files': TOP, 'excluded': ['target', 'node_modules', 'dist', 'output', '.DS_Store'],
                                    'claim': 'Repository application build sources and existing source/test files in these roots; not an inventory of every CI/test fixture or external toolchain/dependency input.'})
    with MANIFEST.open('x') as output:
        output.write(json.dumps(before, indent=2, ensure_ascii=False) + '\n')
    if owns_receipt:
        persist()
    print(json.dumps({'event': 'prebuildVerified', 'sourceInputs': len(paths), 'sourceDigest': digest(before),
                      'diskFreeBytes': record['diskFreeBytesBefore']}), flush=True)
    started = time.monotonic()
    observed_changes = set()
    with LOG.open('x') as output:
        build = subprocess.Popen(['corepack', 'pnpm', 'tauri:build:internal'], cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)
        try:
            record['buildPid'] = build.pid
            persist()
            while build.poll() is None:
                current_stats = source_stats(paths)
                observed_changes.update(name for name in paths if current_stats[name] != before_stats[name])
                time.sleep(1)
        finally:
            # Never leave this owned build running after a monitor exception.
            # Let it finish; do not stop unrelated apps or Agent processes.
            exit_code = build.wait()
            record.update(buildExitCode=exit_code, buildDurationSeconds=round(time.monotonic() - started, 3),
                          buildLog=str(LOG), buildEndedAtUtc=datetime.now(timezone.utc).isoformat())
            persist()
    after_paths = enumerate_inputs()
    after, after_stats = source_snapshot(after_paths)
    record.update(buildExitCode=exit_code, buildDurationSeconds=round(time.monotonic() - started, 3), buildLog=str(LOG),
                  sourceCommitAfterBuild=command(['git', 'rev-parse', 'HEAD']), sourceInputDigestAfterBuild=digest(after),
                  sourceInputStatDigestAfterBuild=digest(after_stats), changedSourcePaths=sorted(set(paths) ^ set(after_paths) | {name for name in paths if before[name] != after.get(name)}),
                  observedSourceStatChanges=sorted(observed_changes), sourceInputStatsUnchanged=before_stats == after_stats,
                  sourceInputsMatchGitAfterBuild=match_git(after_paths), diskFreeBytesAfterBuild=shutil.disk_usage(ROOT).free)
    persist()
    if exit_code:
        raise RuntimeError('actual internal build failed')
    if before != after or before_stats != after_stats or observed_changes:
        raise RuntimeError('source input changed during candidate build')
    record['sourceInputsStableThroughoutObservedBuild'] = True
    files = app_files(APP)
    if len(files) != 5 or set(files) != set(OLD['candidateFiles']):
        raise RuntimeError('unexpected candidate bundle file inventory')
    with (APP / 'Contents/Info.plist').open('rb') as source:
        info = plistlib.load(source)
    if info.get('CFBundleIdentifier') != 'ai.farfold.desktop' or info.get('CFBundleShortVersionString') != '0.1.7' or info.get('CFBundleExecutable') != 'farfold':
        raise RuntimeError('unexpected candidate identity')
    binary = APP / 'Contents/MacOS/farfold'
    architecture = command(['lipo', '-archs', str(binary)])
    if architecture != 'arm64':
        raise RuntimeError('candidate architecture not arm64 only')
    signature_result = command(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(APP)])
    signature = command(['codesign', '-d', '--verbose=4', str(APP)])
    requirement = command(['codesign', '-d', '-r-', str(APP)])
    cdhash = re.search(r'^CDHash=([0-9a-f]+)$', signature, re.M)
    if not cdhash or 'Signature=adhoc' not in signature or 'Identifier=ai.farfold.desktop' not in signature:
        raise RuntimeError('unexpected signature details')
    record.update(strictCodesignPassed=True, codesignExitCode=0, codesignResult=signature_result.splitlines(),
                  designatedRequirement=requirement, signature='adhoc', cdHash=cdhash.group(1),
                  bundleIdentifier=info['CFBundleIdentifier'], version=info['CFBundleShortVersionString'],
                  architecture=architecture, binarySha256=files['Contents/MacOS/farfold'], candidateFileCount=5, candidateFiles=files)
    ARCHIVE.parent.mkdir()
    command(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(APP), str(ARCHIVE)])
    with zipfile.ZipFile(ARCHIVE) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('candidate archive CRC failure')
        payload = {}
        for entry in archive.infolist():
            if entry.is_dir() or entry.filename.startswith('__MACOSX/'):
                continue
            if not entry.filename.startswith('Farfold.app/'):
                raise RuntimeError('unexpected archive payload')
            name = entry.filename[len('Farfold.app/'):]
            if name not in files or name in payload:
                raise RuntimeError('unexpected or duplicate archive bundle file')
            payload[name] = hashlib.sha256(archive.read(entry)).hexdigest()
        if payload != files:
            raise RuntimeError('archive file bytes do not match candidate')
    if app_files(FORMAL) != formal or sha(old_archive) != OLD['archiveSha256']:
        raise RuntimeError('formal app or old ZIP unexpectedly changed')
    record.update(phase='internalCandidatePreparedNotInstalled', completedAtUtc=datetime.now(timezone.utc).isoformat(),
                  archiveBytes=ARCHIVE.stat().st_size, archiveSha256=sha(ARCHIVE), archiveCrcPassed=True,
                  archiveFileBytesMatchCandidate=True, formalAppFilesUnchangedAcrossCandidateBuildAndChecks=True,
                  oldZipPreservedAndHashUnchanged=True, diskFreeBytesAfterPackage=shutil.disk_usage(ROOT).free,
                  duplicateAppCleanup='Not performed before installation; only this generated bundle may be removed after root installs and verifies it.',
                  scope='7a36a6db source-stable macOS internal candidate only; no app replacement, app quit, user-data scan, or installed/real-Agent acceptance.')
    persist()
    print(json.dumps({'event': 'candidatePrepared', 'sourceInputs': len(paths), 'buildExitCode': exit_code,
                      'binarySha256': record['binarySha256'], 'cdHash': record['cdHash'],
                      'archiveSha256': record['archiveSha256'], 'archiveBytes': record['archiveBytes'],
                      'receipt': str(RECEIPT)}), flush=True)
except Exception as error:
    record.update(phase='candidatePreparationFailed', completedAtUtc=datetime.now(timezone.utc).isoformat(),
                  verificationFailure=str(error))
    if owns_receipt:
        persist()
    print(json.dumps({'event': 'candidatePreparationFailed', 'reason': str(error), 'receipt': str(RECEIPT)}), flush=True)
    raise
