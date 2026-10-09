"""Read-only independent candidate checks; writes only its exclusive JSON receipt.

Run only after the parent reports candidate preparation succeeded. Never builds,
extracts, installs, launches, quits, deletes, or accesses user data/credentials.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
from datetime import datetime, timezone
import zipfile

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
EXPECTED = sys.argv[1]
SCOPES = ['src/', 'assets/', 'public/', 'scripts/', 'src-tauri/src/', 'src-tauri/native/', 'src-tauri/capabilities/', 'src-tauri/icons/', 'src-tauri/resources/']
TOP = ['index.html', 'package.json', 'pnpm-lock.yaml', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/Info.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json']
BUNDLE_FILES = {'Contents/Info.plist', 'Contents/MacOS/farfold', 'Contents/Resources/icon.icns', 'Contents/Resources/release-manifest.json', 'Contents/_CodeSignature/CodeResources'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def regular(path, directory=False):
    for entry in (path, *path.parents):
        require(not entry.is_symlink(), 'Unexpected symlink in inspected path')
    mode = path.lstat().st_mode
    require(stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode), 'Unexpected inspected file type')


def sha(path):
    regular(path)
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def read_json(path):
    regular(path)
    return json.loads(path.read_text())


def run(args):
    process = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
    require(process.returncode == 0, f'{args[0]} returned {process.returncode}: {process.stderr[-1200:]}')
    return (process.stdout + process.stderr).strip()


def bundle_files(path):
    regular(path, directory=True)
    files = {}
    for entry in sorted(path.rglob('*')):
        require(not entry.is_symlink(), 'Unexpected bundle symlink')
        mode = entry.lstat().st_mode
        require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), 'Unexpected bundle entry')
        if stat.S_ISREG(mode):
            files[str(entry.relative_to(path))] = sha(entry)
    require(set(files) == BUNDLE_FILES, 'Expected exact five-file application bundle')
    return files


def verify_source(inputs):
    require(run(['/usr/bin/git', 'rev-parse', 'HEAD']) == EXPECTED, 'HEAD differs from candidate commit')
    tree = subprocess.run(['/usr/bin/git', 'ls-tree', '-r', '-z', EXPECTED], cwd=ROOT, capture_output=True, check=True).stdout
    tracked = {}
    for entry in tree.split(b'\0'):
        if not entry:
            continue
        metadata, raw_name = entry.split(b'\t', 1)
        mode, kind, blob = metadata.split()
        name = raw_name.decode()
        if name in TOP or any(name.startswith(scope) for scope in SCOPES):
            require(kind == b'blob' and mode in (b'100644', b'100755'), 'Unexpected committed source kind')
            tracked[name] = blob.decode()
    disk = set(TOP)
    for scope in SCOPES:
        disk.update(str(path.relative_to(ROOT)) for path in (ROOT / scope).rglob('*') if path.is_file() and path.name != '.DS_Store')
    require(set(inputs) == set(tracked) == disk, 'Application source inventory differs')
    for name, oid in tracked.items():
        path = ROOT / name
        regular(path)
        raw = path.read_bytes()
        actual_oid = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        require(actual_oid == oid, 'Source differs from committed blob: ' + name)
        require(hashlib.sha256(raw).hexdigest() == inputs[name], 'Source differs from candidate input receipt: ' + name)
    return {'inputCount': len(inputs), 'scope': 'Application source/configuration and tests; dependencies and toolchain not claimed'}


def main():
    require(len(EXPECTED) == 40 and all(c in '0123456789abcdef' for c in EXPECTED), 'Expected a full commit SHA')
    regular(OUT, directory=True)
    receipt_path = OUT / 'candidate-independent.json'
    descriptor = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    record = {
        'sourceCommit': EXPECTED,
        'startedAt': datetime.now(timezone.utc).isoformat(),
        'result': 'failed', 'failures': [], 'checks': {},
        'installed': False, 'launched': False, 'realAgentInvoked': False,
        'claim': 'Independent filesystem/source/signature/archive inspection only; no installed-app or real-Agent acceptance',
    }
    stage = 'candidateReceipts'
    with os.fdopen(descriptor, 'w') as output:
        try:
            candidate_path = OUT / 'candidate.json'
            inputs_path = OUT / 'candidate-inputs.json'
            candidate = read_json(candidate_path)
            inputs = read_json(inputs_path)
            archive_path = ROOT / f'src-tauri/target/internal-candidate/2026-10-09-{EXPECTED[:8]}/Farfold-0.1.7-{EXPECTED[:8]}.zip'
            require(candidate['sourceCommit'] == EXPECTED and candidate['phase'] == 'internalCandidatePreparedNotInstalled', 'Candidate is not a completed preparation for this commit')
            require(candidate['buildExitCode'] == 0 and candidate['installed'] is False and candidate['formalAppReplaced'] is False, 'Candidate preparation claims unexpected effects')
            require(candidate['candidateApp'] == str(APP) and candidate['archive'] == str(archive_path), 'Candidate artifact path differs')
            record['inputReceipts'] = {'candidateJsonSha256': sha(candidate_path), 'candidateInputsJsonSha256': sha(inputs_path)}
            record['checks'][stage] = {'passed': True}

            stage = 'exactSource'
            source_result = verify_source(inputs)
            require(candidate['sourceInputCount'] == source_result['inputCount'], 'Recorded source count differs')
            record['checks'][stage] = {'passed': True, **source_result}

            stage = 'bundleFiles'
            actual_files = bundle_files(APP)
            require(actual_files == candidate['candidateFiles'], 'Candidate bundle differs from preparation receipt')
            record['checks'][stage] = {'passed': True, 'files': actual_files}

            stage = 'plistAndEmbeddedManifest'
            info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
            require(info.get('CFBundleIdentifier') == 'ai.farfold.desktop', 'Bundle identifier differs')
            require(info.get('CFBundleExecutable') == 'farfold' and info.get('CFBundleShortVersionString') == '0.1.7', 'Bundle executable/version differs')
            require(info.get('CFBundleDevelopmentRegion') == 'zh_CN' and 'zh-Hans' in info.get('CFBundleLocalizations', []), 'Bundle localization differs')
            manifest = APP / 'Contents/Resources/release-manifest.json'
            require(sha(manifest) == sha(ROOT / 'src-tauri/resources/release-manifest.json'), 'Embedded manifest differs from source')
            require(read_json(manifest)['version'] == info['CFBundleShortVersionString'], 'Embedded manifest version differs')
            record['checks'][stage] = {'passed': True, 'identifier': info['CFBundleIdentifier'], 'version': info['CFBundleShortVersionString']}

            stage = 'architecture'
            architecture = run(['/usr/bin/lipo', '-archs', str(APP / 'Contents/MacOS/farfold')])
            require(architecture == 'arm64', 'Candidate architecture differs')
            record['checks'][stage] = {'passed': True, 'architecture': architecture}

            stage = 'signature'
            verified = run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(APP)])
            details = run(['/usr/bin/codesign', '-d', '--verbose=4', str(APP)])
            require('Signature=adhoc' in details and 'Identifier=ai.farfold.desktop' in details, 'Candidate signature differs')
            record['checks'][stage] = {'passed': True, 'strictVerification': verified, 'details': details, 'distribution': 'ad-hoc; not notarized or publicly signed'}

            stage = 'archive'
            require(sha(archive_path) == candidate['archiveSha256'] and archive_path.stat().st_size == candidate['archiveBytes'], 'Archive digest/size differs')
            with zipfile.ZipFile(archive_path) as archive:
                require(archive.testzip() is None, 'Archive CRC check failed')
                entries = [entry for entry in archive.infolist() if not entry.is_dir() and not entry.filename.startswith('__MACOSX/')]
                names = [entry.filename for entry in entries]
                require(len(names) == len(set(names)), 'Duplicate archive payload member')
                require(all(name.startswith('Farfold.app/') for name in names), 'Archive payload outside application')
                contents = {}
                modes = {}
                for entry in entries:
                    name = entry.filename.removeprefix('Farfold.app/')
                    require(name in BUNDLE_FILES, 'Unexpected archive payload')
                    mode = entry.external_attr >> 16
                    require(stat.S_ISREG(mode), 'Archive payload is not a regular file')
                    require(stat.S_IMODE(mode) == stat.S_IMODE((APP / name).stat().st_mode), 'Archive permissions differ from bundle')
                    contents[name] = hashlib.sha256(archive.read(entry)).hexdigest()
                    modes[name] = oct(stat.S_IMODE(mode))
                require(contents == actual_files, 'Archive contents differ from candidate bundle')
            record['checks'][stage] = {'passed': True, 'sha256': candidate['archiveSha256'], 'bytes': candidate['archiveBytes'], 'fileModes': modes}

            stage = 'formalAppUnchanged'
            require(bundle_files(FORMAL) == candidate['formalFiles'], 'Formal application changed since preparation')
            record['checks'][stage] = {'passed': True, 'formalAppReplaced': False}

            stage = 'verificationInputsStable'
            verify_source(inputs)
            require(bundle_files(APP) == actual_files and bundle_files(FORMAL) == candidate['formalFiles'], 'Application files changed during verification')
            require(sha(candidate_path) == record['inputReceipts']['candidateJsonSha256'] and sha(inputs_path) == record['inputReceipts']['candidateInputsJsonSha256'], 'Input receipts changed during verification')
            record['checks'][stage] = {'passed': True}
            record['result'] = 'passed'
        except Exception as error:
            record['checks'][stage] = {'passed': False, 'error': f'{type(error).__name__}: {error}'}
            record['failures'].append(stage)
        finally:
            record['completedAt'] = datetime.now(timezone.utc).isoformat()
            output.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
            output.flush()
            os.fsync(output.fileno())
    print(json.dumps({'result': record['result'], 'checks': len(record['checks']), 'failures': record['failures'], 'receipt': str(receipt_path)}))
    return 0 if record['result'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
