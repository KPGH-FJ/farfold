"""One exclusive internal candidate build; never install, launch, quit or access user data.
Usage: python3 -B candidate.py parameters.json <parameters-sha256>
Bundle/signature/ZIP checks reuse the prior candidate's explicit pure algorithms.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import time
import zipfile

ROOT = Path('<private-mac-home:a2369e920572>')
PREP = ROOT / 'output/2026-10-22-common-capability-closeout/formal-delivery-r2'
OUT = PREP / 'candidate-output'
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
BUILD = ['corepack', 'pnpm', 'tauri:build:internal', '--bundles', 'app']
SCOPES = ('src/', 'assets/', 'public/', 'scripts/', 'patches/', '.cargo/',
          'src-tauri/src/', 'src-tauri/native/', 'src-tauri/capabilities/',
          'src-tauri/icons/', 'src-tauri/resources/', 'src-tauri/.cargo/')
FILES = {'Contents/Info.plist', 'Contents/MacOS/farfold', 'Contents/Resources/icon.icns',
         'Contents/Resources/release-manifest.json', 'Contents/_CodeSignature/CodeResources'}
COMMANDS = [['corepack', 'pnpm', name] for name in ('format:check', 'typecheck', 'test', 'build')] + [
    ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml'],
    ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings'],
    ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']]


def need(ok, message):
    if not ok:
        raise RuntimeError(message)


def regular(path, directory=False):
    need(all(not p.is_symlink() for p in (path, *path.parents)), 'Symlink refused')
    need(stat.S_ISDIR(path.stat().st_mode) if directory else stat.S_ISREG(path.stat().st_mode), 'Wrong file type')


def sha(path):
    regular(path)
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def relative(name):
    need(type(name) is str and name and not Path(name).is_absolute() and '..' not in Path(name).parts, 'Relative path required')
    return ROOT / name


def pinned(name, expected, refs):
    path = relative(name)
    need(type(expected) is str and re.fullmatch('[0-9a-f]{64}', expected), 'SHA pin unbound')
    need(sha(path) == expected, 'Pinned evidence changed')
    refs[path] = expected
    return json.loads(path.read_bytes())


def run(argv):
    result = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)
    need(result.returncode == 0, f'{argv[0]} failed with exit {result.returncode}')
    return (result.stdout + result.stderr).strip()


def admitted(name):
    return any(name.startswith(scope) for scope in SCOPES) or bool(re.fullmatch(
        r'(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|index\.html|tsconfig[^/]*\.json|'
        r'[^/]+\.config\.[^/]+|\.npmrc|\.pnpmfile\.cjs|src-tauri/[^/]+\.(rs|json|toml|lock|plist))', name))


def source(commit, inputs):
    need(run(['git', 'rev-parse', 'HEAD']) == commit, 'HEAD differs from explicit commit')
    need(not any((ROOT / name).exists() or (ROOT / name).is_symlink() for name in
                 ('.env', '.env.local', '.env.production', '.env.production.local')), 'Unfrozen build environment file present')
    tree = {}
    raw = subprocess.run(['git', 'ls-tree', '-r', '-z', commit], cwd=ROOT, check=True, capture_output=True).stdout
    for entry in filter(None, raw.split(b'\0')):
        meta, name = entry.split(b'\t', 1); mode, kind, oid = meta.split(); name = name.decode()
        if admitted(name):
            need(kind == b'blob' and mode in (b'100644', b'100755'), 'Nonregular committed source')
            tree[name] = (mode, oid.decode())
    disk = set()
    for base in (ROOT, ROOT / 'src-tauri'):
        for path in base.iterdir():
            if admitted(str(path.relative_to(ROOT))) and (path.is_file() or path.is_symlink()):
                disk.add(str(path.relative_to(ROOT)))
    for scope in SCOPES:
        base = ROOT / scope
        if not base.exists():
            need(not base.is_symlink(), 'Broken source scope symlink'); continue
        regular(base, True)
        for path in base.rglob('*'):
            if path.name == '.DS_Store' or '__pycache__' in path.parts:
                continue
            regular(path, path.is_dir())
            if path.is_file():
                disk.add(str(path.relative_to(ROOT)))
    need(disk == set(tree) and disk, 'Disk/commit production path set differs')
    hashes = {}
    for name in sorted(disk):
        path = ROOT / name; regular(path); data = path.read_bytes()
        mode, oid = tree[name]
        need(hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == oid, 'Uncommitted production source')
        need(bool(path.stat().st_mode & 0o111) == (mode == b'100755'), 'Source executable mode changed')
        hashes[name] = hashlib.sha256(data).hexdigest()
        need(inputs.get(name) == hashes[name], 'Production source differs from engineering input')
    need({'package.json', 'pnpm-lock.yaml', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'} <= disk, 'Required config missing')
    return hashes


def engineering(config, refs, commit):
    need(set(config) == {'schema', 'receiptPath', 'sha256'}, 'Unknown engineering configuration')
    need(config['schema'] == 'p40-scoped-query-actual-seven-v1', 'Engineering schema unbound or unsupported')
    report = pinned(config['receiptPath'], config['sha256'], refs)
    need(set(report) == {'scope', 'head', 'inputCount', 'before', 'steps', 'after', 'result'}, 'Unknown engineering report shape')
    need(report['head'] == commit, 'Engineering source differs from selected candidate commit')
    need(type(report['before']) is dict and report['before'] and report['before'] == report['after'], 'Engineering input drift or missing inputs')
    need(report['result'] == 'passed' and type(report['inputCount']) is int and report['inputCount'] == len(report['before']), 'Engineering incomplete')
    need(all(type(n) is str and type(h) is str and re.fullmatch('[0-9a-f]{64}', h) for n, h in report['before'].items()), 'Invalid engineering input hashes')
    need(type(report['steps']) is list and len(report['steps']) == 7, 'All seven actual commands required; no reuse')
    previous = float('-inf')
    for index, (step, command) in enumerate(zip(report['steps'], COMMANDS), 1):
        need(set(step) == {'command', 'exitCode', 'startedAtUnix', 'finishedAtUnix', 'log', 'logSha256', 'inputsStable'}, 'Unknown actual check shape')
        need(step['command'] == command and type(step['exitCode']) is int and step['exitCode'] == 0 and step['inputsStable'] is True, 'Wrong actual check result')
        start, end = step['startedAtUnix'], step['finishedAtUnix']
        need(type(start) in (int, float) and type(end) in (int, float) and float('-inf') < start and previous <= start <= end < float('inf'), 'Incomplete or nonsequential check timing')
        previous = end
        path = relative(step['log'])
        need(path.parent == relative(config['receiptPath']).parent and path.name == f'{index:02}.log', 'Check log must belong to this actual run')
        need(sha(path) == step['logSha256'], 'Actual check log changed'); refs[path] = step['logSha256']
    return report['before']


def bundle(path):
    regular(path, True); files, modes = {}, {}
    for item in sorted(path.rglob('*')):
        regular(item, item.is_dir())
        if item.is_file():
            name = str(item.relative_to(path)); files[name] = sha(item); modes[name] = stat.S_IMODE(item.stat().st_mode)
    need(set(files) == FILES, 'Bundle is not the exact five files')
    return files, modes


def identity():
    info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
    need((info.get('CFBundleIdentifier'), info.get('CFBundleShortVersionString'), info.get('CFBundleExecutable')) == ('ai.farfold.desktop', '0.1.7', 'farfold'), 'Wrong app identity')
    need(info.get('CFBundleDevelopmentRegion') == 'zh_CN' and 'zh-Hans' in info.get('CFBundleLocalizations', []), 'Wrong localization')
    manifest = APP / 'Contents/Resources/release-manifest.json'
    need(sha(manifest) == sha(ROOT / 'src-tauri/resources/release-manifest.json') and json.loads(manifest.read_bytes())['version'] == '0.1.7', 'Embedded manifest differs')
    need(run(['lipo', '-archs', str(APP / 'Contents/MacOS/farfold')]) == 'arm64', 'Wrong architecture')
    verify = run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(APP)])
    details = run(['codesign', '-d', '--verbose=4', str(APP)])
    need({'Signature=adhoc', 'Identifier=ai.farfold.desktop'} <= set(details.splitlines()), 'Wrong signature')
    return {'architecture': 'arm64', 'codesignVerify': verify, 'codesignDetails': details}


def exclusive(path):
    regular(path.parent, True)
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb')


def archive(path, files, modes):
    path.parent.mkdir(mode=0o700, exist_ok=False); regular(path.parent, True)
    with exclusive(path) as stream, zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        for name in sorted(files):
            zipped.write(APP / name, 'Farfold.app/' + name)
    with zipfile.ZipFile(path) as zipped:
        entries = zipped.infolist()
        need(zipped.testzip() is None and len(entries) == len(files) and {e.filename for e in entries} == {'Farfold.app/' + n for n in files}, 'ZIP CRC/membership differs')
        for entry in entries:
            name = entry.filename[len('Farfold.app/'):]; mode = entry.external_attr >> 16
            need(stat.S_ISREG(mode) and stat.S_IMODE(mode) == modes[name] and entry.file_size == (APP / name).stat().st_size and hashlib.sha256(zipped.read(entry)).hexdigest() == files[name], 'ZIP mode/payload differs')
    return {'archiveSha256': sha(path), 'archiveBytes': path.stat().st_size}


def main():
    need(len(sys.argv) == 3 and Path(__file__).absolute().parent == PREP, 'Expected parameter file and SHA')
    refs = {}; config_path = Path(sys.argv[1]).absolute(); regular(config_path)
    need(config_path.parent == PREP and '..' not in config_path.parts, 'Wrong parameter location')
    need(re.fullmatch('[0-9a-f]{64}', sys.argv[2]) and sha(config_path) == sys.argv[2], 'Parameter pin differs')
    refs[config_path] = sys.argv[2]; config = json.loads(config_path.read_bytes()); commit = config['sourceCommit']
    need(set(config) == {'schema', 'sourceCommit', 'engineering', 'formalBaseline'}, 'Unknown parameter schema')
    need(config['schema'] == 1 and type(commit) is str and re.fullmatch('[0-9a-f]{40}', commit), 'Real source commit unbound')
    inputs = engineering(config['engineering'], refs, commit)
    baseline = config['formalBaseline']
    need(set(baseline) == {'receiptPath', 'sha256', 'installedReceiptPath', 'installedSha256', 'binarySha256'}, 'Unknown baseline configuration')
    prior = pinned(baseline['receiptPath'], baseline['sha256'], refs)
    installed = pinned(baseline['installedReceiptPath'], baseline['installedSha256'], refs)
    need(prior['sourceCommit'] == installed['sourceCommit'] == '420e5a3c0e7ab4889ba1b5e1d7b505bbe936e331', 'Wrong installed baseline')
    need(prior['phase'] == 'internalCandidatePreparedNotInstalled', 'Baseline candidate incomplete')
    need(installed['phase'] == 'installed-10-independent-checks' and installed['passed'] == installed['total'] == 10 and installed['failures'] == [] and len(installed['checks']) == 10 and all(x['passed'] is True for x in installed['checks']), 'Baseline installation incomplete')
    formal = bundle(FORMAL); need(formal == (prior['candidateFiles'], prior['candidateModes']), 'Formal baseline changed')
    need(type(baseline['binarySha256']) is str and re.fullmatch('[0-9a-f]{64}', baseline['binarySha256']) and baseline['binarySha256'] == prior['candidateFiles']['Contents/MacOS/farfold'] == formal[0]['Contents/MacOS/farfold'], 'Explicit formal binary baseline differs')
    before = source(commit, inputs); need(not APP.exists() and not APP.is_symlink(), 'Duplicate App already exists; preserve it')
    need(all(not p.is_symlink() for p in APP.parents), 'Candidate destination symlink refused')
    OUT.mkdir(mode=0o700, exist_ok=False); regular(OUT, True)
    record = {'phase': 'failed', 'sourceCommit': commit, 'startedAtUnix': time.time(), 'buildCommand': BUILD, 'installed': False, 'formalAppReplaced': False}
    with exclusive(OUT / 'candidate.json') as receipt:
        try:
            lock_path = ROOT / 'src-tauri/target/.farfold-candidate-build.lock'
            regular(lock_path.parent, True)
            with os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'r+b') as lock:
                need(os.fstat(lock.fileno()).st_uid == os.getuid() and stat.S_ISREG(os.fstat(lock.fileno()).st_mode), 'Invalid candidate lock')
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                need(source(commit, inputs) == before and bundle(FORMAL) == formal and not APP.exists(), 'Prebuild drift')
                with exclusive(OUT / 'build.log') as log:
                    result = subprocess.run(BUILD, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
                record.update(buildExitCode=result.returncode, buildLogSha256=sha(OUT / 'build.log'))
                need(result.returncode == 0, 'Candidate build failed; preserve log and partial App')
                need(source(commit, inputs) == before, 'Production source changed during build')
                record.update(identity()); files, modes = bundle(APP)
                archive_path = ROOT / f'src-tauri/target/internal-candidate/2026-10-22-common-capability-closeout-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip'
                record.update(archive=str(archive_path.relative_to(ROOT)), **archive(archive_path, files, modes))
                need(bundle(APP) == (files, modes) and source(commit, inputs) == before and bundle(FORMAL) == formal, 'Final source/bundle/formal drift')
                need(all(sha(p) == pin for p, pin in refs.items()), 'Pinned evidence changed during build')
                record.update(phase='internalCandidatePreparedNotInstalled', productionInputs=before, candidateFiles=files, candidateModes=modes, evidencePins={str(p.relative_to(ROOT)): pin for p, pin in refs.items()})
        except Exception as error:
            record['error'] = str(error)
        finally:
            record['completedAtUnix'] = time.time(); receipt.write((json.dumps(record, ensure_ascii=False, indent=2) + '\n').encode()); receipt.flush(); os.fsync(receipt.fileno())
    print(json.dumps({'phase': record['phase'], 'receipt': str((OUT / 'candidate.json').relative_to(ROOT))}))
    return 0 if record['phase'] == 'internalCandidatePreparedNotInstalled' else 1


if __name__ == '__main__':
    raise SystemExit(main())
