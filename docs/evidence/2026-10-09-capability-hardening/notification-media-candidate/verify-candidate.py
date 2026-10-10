"""Nine independent read-only checks. Only main writes its exclusive receipt.
Pure definitions are also imported by prepare; importing runs no commands or I/O.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
BASE = ROOT / 'docs/evidence/2026-10-09-capability-hardening'
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
BASELINE_COMMIT = '39955ec65a4274cdeac1bab9884f4073c792102a'
BASELINE = BASE / 'skills-qualified-names-candidate/candidate.json'
BASELINE_SHA = '1112fd0ad235c9d86d2e1c4d6ffc6c3032603e9f291bb5137dacbc84242d1048'
BUNDLE_FILES = {'Contents/Info.plist', 'Contents/MacOS/farfold', 'Contents/Resources/icon.icns', 'Contents/Resources/release-manifest.json', 'Contents/_CodeSignature/CodeResources'}
BUILD = ['corepack', 'pnpm', 'tauri:build:internal']
SCOPES = ['src/', 'assets/', 'public/', 'scripts/', 'src-tauri/src/', 'src-tauri/native/', 'src-tauri/capabilities/', 'src-tauri/icons/', 'src-tauri/resources/', 'docs/evidence/2026-10-09-capability-hardening/docx-fixtures/', 'docs/evidence/2026-10-09-capability-hardening/docx/public-samples/']
TOP = ['docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/copy-status-wire.json', 'docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg', '.prettierignore', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/01-unicode-lists.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/02-table-images-stories.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/03-sections.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/expectations.json', 'index.html', 'package.json', 'pnpm-lock.yaml', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/Info.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json']

TOP += ['docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/' + name for name in ('positions-v1.xlsx', 'positions-v2.xlsx', 'positions-v1-nonordinal-ids.xlsx', 'oracle.json')]
TOP += ['docs/evidence/2026-10-09-capability-hardening/docx-feedback/' + name for name in ('fixtures/repeated-locations.docx', 'fixtures/oracle.json', 'independent/supported-choice-markers.docx', 'independent/nested-choice-fallback.docx', 'independent/hidden-notice-boundaries.docx', 'independent/oracle-supplement.json', 'independent/window-boundaries.docx', 'independent/window-oracle.json')]
SCOPES += ['docs/evidence/2026-10-09-capability-hardening/workbook-range/fixtures/']
SCOPES += ['docs/evidence/2026-10-09-capability-hardening/visual-area/fixtures/']
TOP += ['src-tauri/examples/windows_process_fixture.rs', 'src-tauri/testdata/signed-update-metadata.json']
TOP += ['docs/evidence/2026-10-09-capability-hardening/worktree-remove/cold-recovery-fix/actual-wire.json']
TOP += ['docs/evidence/2026-10-09-capability-hardening/worktree-preparation/backend/preparation-wire.json']
TOP += ['docs/evidence/2026-10-09-capability-hardening/project-file-selection/backend/actual-wire.json']
TOP += ['docs/evidence/2026-10-09-capability-hardening/extension-inventory/backend/actual-wire.json']
TOP += ['docs/evidence/2026-10-09-capability-hardening/skills-inventory/backend/actual-wire.json']
# The qualified-name wire lives in src/runtime/fixtures and is included by src/.
COMMANDS = {
    'format': ['corepack', 'pnpm', 'format:check'],
    'typecheck': ['corepack', 'pnpm', 'typecheck'],
    'frontend': ['corepack', 'pnpm', 'test'],
    'build': ['corepack', 'pnpm', 'build'],
    'cargo-fmt': ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml'],
    'clippy': ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings'],
    'rust': ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked'],
}


def need(ok, message):
    if not ok:
        raise RuntimeError(message)


def regular(path, directory=False):
    need(all(not p.is_symlink() for p in (path, *path.parents)), 'Symlink: ' + str(path))
    mode = path.stat().st_mode
    need(stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode), 'Unexpected type: ' + str(path))


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def sha(path):
    regular(path)
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read(path):
    regular(path)
    return json.loads(path.read_text())


def relative(name):
    path = Path(name)
    need(not path.is_absolute() and '..' not in path.parts, 'Invalid relative evidence path')
    return ROOT / path


def run(argv):
    result = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True)
    need(result.returncode == 0, f'{argv[0]} exit {result.returncode}: {result.stderr[-1000:]}')
    return (result.stdout + result.stderr).strip()


def arguments():
    need(len(sys.argv) == 3 and re.fullmatch('[0-9a-f]{40}', sys.argv[1]), 'Expected exact 40-character SHA and engineering verification path')
    engineering = relative(sys.argv[2])
    need(engineering.is_relative_to(BASE / 'notification-media-checks'), 'Wrong engineering directory')
    return sys.argv[1], engineering


def archive_path(commit):
    return ROOT / f'src-tauri/target/internal-candidate/2026-10-10-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip'


def source(commit):
    need(run(['git', 'rev-parse', 'HEAD']) == commit, 'HEAD differs from requested commit')
    raw = subprocess.run(['git', 'ls-tree', '-r', '-z', commit], cwd=ROOT, check=True, capture_output=True).stdout
    tree = {}
    for entry in filter(None, raw.split(b'\0')):
        meta, name = entry.split(b'\t', 1)
        mode, kind, oid = meta.split()
        name = name.decode('utf-8')
        if name in TOP or any(name.startswith(s) for s in SCOPES):
            need(kind == b'blob' and mode in (b'100644', b'100755'), 'Nonregular committed input')
            tree[name] = oid.decode()
    paths = set(TOP)
    for scope in SCOPES:
        regular(ROOT / scope, True)
        for p in (ROOT / scope).rglob('*'):
            if p.name == '.DS_Store' or '__pycache__' in p.parts:
                continue
            regular(p, p.is_dir())
            if p.is_file():
                paths.add(str(p.relative_to(ROOT)))
    need(paths == set(tree), 'Disk/commit input inventories differ')
    hashes = {}
    for name in sorted(paths):
        p = ROOT / name
        regular(p)
        data = p.read_bytes()
        oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        need(oid == tree[name], 'Uncommitted input: ' + name)
        hashes[name] = digest(data)
    need('src/runtime/fixtures/skills-qualified-wire.json' in hashes, 'Qualified-name wire missing')
    return hashes


def engineering(path, inputs):
    receipt = read(path)
    need(all(receipt.get(k) is True for k in ('allPassed', 'sourceStable', 'protectedUnchanged')), 'Engineering incomplete')
    need(receipt['inputCount'] == len(inputs) and receipt.get('changedInputs') == [], 'Engineering input count/drift')
    checks = receipt['checks']
    need(len(checks) == 7 and {c['name'] for c in checks} == set(COMMANDS), 'Need seven actual checks')
    refs = {str(path.relative_to(ROOT)): sha(path)}
    for c in checks:
        p = relative(c['log'])
        need(c.get('executedInThisRun') is True and c['argv'] == COMMANDS[c['name']] and c['exitCode'] == 0, 'Check did not pass as specified')
        need(p.parent == path.parent and sha(p) == c['sha256'], 'Engineering log drift/scope')
        refs[c['log']] = c['sha256']
    for key, filename in (('inputsBefore', 'inputs-before.json'), ('inputsAfter', 'inputs-after.json')):
        ref = receipt.get(key)
        p = relative(ref['path']) if ref else path.parent / filename
        need(p.parent == path.parent and read(p) == inputs, 'Engineering input manifest mismatch')
        need(ref is None or sha(p) == ref['sha256'], 'Engineering manifest digest mismatch')
        refs[str(p.relative_to(ROOT))] = sha(p)
    return {'receipt': str(path.relative_to(ROOT)), 'sha256': sha(path), 'inputCount': len(inputs), 'references': refs}


def bundle(path):
    regular(path, True)
    files, modes = {}, {}
    for p in sorted(path.rglob('*')):
        regular(p, p.is_dir())
        if p.is_file():
            name = str(p.relative_to(path))
            files[name], modes[name] = sha(p), stat.S_IMODE(p.stat().st_mode)
    need(set(files) == BUNDLE_FILES, 'Bundle is not the exact five files')
    return files, modes


def baseline():
    need(sha(BASELINE) == BASELINE_SHA, 'Installed baseline receipt changed')
    b = read(BASELINE)
    need(b['sourceCommit'] == BASELINE_COMMIT and b['phase'] == 'internalCandidatePreparedNotInstalled', 'Wrong installed baseline')
    actual = bundle(FORMAL)
    need(actual[0] == b['candidateFiles'], 'Formal application differs from 39955ec6')
    return actual


def identity():
    info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
    need(info.get('CFBundleIdentifier') == 'ai.farfold.desktop' and info.get('CFBundleShortVersionString') == '0.1.7' and info.get('CFBundleExecutable') == 'farfold', 'Bundle identity mismatch')
    need(info.get('CFBundleDevelopmentRegion') == 'zh_CN' and 'zh-Hans' in info.get('CFBundleLocalizations', []), 'Localization mismatch')
    manifest = APP / 'Contents/Resources/release-manifest.json'
    need(sha(manifest) == sha(ROOT / 'src-tauri/resources/release-manifest.json') and read(manifest)['version'] == '0.1.7', 'Embedded manifest mismatch')
    return {'bundleIdentifier': info['CFBundleIdentifier'], 'version': info['CFBundleShortVersionString']}


def signature():
    verified = run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(APP)])
    details = run(['codesign', '-d', '--verbose=4', str(APP)])
    need('Signature=adhoc' in details and 'Identifier=ai.farfold.desktop' in details, 'Signature mismatch')
    return {'codesignVerify': verified, 'codesignDetails': details}


def zip_matches(path, files, modes):
    regular(path)
    with zipfile.ZipFile(path) as z:
        need(z.testzip() is None, 'Archive CRC failure')
        entries = z.infolist()
        need(len(entries) == len({e.filename for e in entries}), 'Duplicate ZIP member')
        need({e.filename for e in entries} == {'Farfold.app/' + n for n in files}, 'Unexpected ZIP members')
        for e in entries:
            name = e.filename[len('Farfold.app/'):]
            mode = e.external_attr >> 16
            need(stat.S_ISREG(mode) and stat.S_IMODE(mode) == modes[name], 'ZIP file mode differs')
            need(e.file_size == (APP / name).stat().st_size and digest(z.read(e)) == files[name], 'ZIP payload differs')
    return {'archiveSha256': sha(path), 'archiveBytes': path.stat().st_size}


def exclusive(path):
    regular(path.parent, True)
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w')


def save(handle, record):
    json.dump(record, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
    handle.flush()
    os.fsync(handle.fileno())


def now():
    return datetime.now(timezone.utc).isoformat()


def main():
    commit, proof = arguments()
    report = {'sourceCommit': commit, 'result': 'failed', 'failures': [], 'checks': {}, 'startedAt': now(), 'installed': False, 'launched': False, 'realAgentInvoked': False}
    stage = 'candidateReceipts'
    with exclusive(OUT / 'candidate-independent.json') as output:
        try:
            c, inputs = read(OUT / 'candidate.json'), read(OUT / 'candidate-inputs.json')
            watched = {str(p.relative_to(ROOT)): sha(p) for p in (OUT / 'candidate.json', OUT / 'candidate-inputs.json', OUT / 'candidate-inputs-after.json')}
            report['inputReceipts'] = {'candidateJsonSha256': watched[str((OUT / 'candidate.json').relative_to(ROOT))], 'candidateInputsJsonSha256': watched[str((OUT / 'candidate-inputs.json').relative_to(ROOT))]}
            need(c['sourceCommit'] == commit and c['phase'] == 'internalCandidatePreparedNotInstalled' and c['buildExitCode'] == 0, 'Incomplete candidate')
            need(c['installed'] is False and c['formalAppReplaced'] is False and c['sourceMatchesCommitBeforeAndAfter'] is True and c['formalFilesUnchanged'] is True, 'Unexpected preparation claims')
            need(c['candidateApp'] == str(APP) and c['archive'] == str(archive_path(commit)) and c['command'] == ' '.join(BUILD), 'Candidate path/command mismatch')
            log = OUT / 'checks/candidate-build.txt'
            need(sha(log) == c['buildLogSha256'] and read(OUT / 'candidate-inputs-after.json') == inputs, 'Build/input record drift')
            watched[str(log.relative_to(ROOT))] = sha(log)
            report['checks'][stage] = {'passed': True}
            stage = 'exactSourceAndEngineering'
            need(source(commit) == inputs and c['sourceInputCount'] == len(inputs), 'Source mismatch')
            proof_record = engineering(proof, inputs)
            need(proof_record == c['engineeringVerification'], 'Engineering receipt mismatch')
            watched.update(proof_record['references'])
            report['checks'][stage] = {'passed': True, 'inputCount': len(inputs)}
            stage = 'bundleFiles'
            files, modes = bundle(APP)
            need(files == c['candidateFiles'] and modes == c['candidateModes'], 'Bundle drift')
            report['checks'][stage] = {'passed': True, 'files': files}
            stage = 'plistAndEmbeddedManifest'
            report['checks'][stage] = {'passed': True, **identity()}
            stage = 'architecture'
            arch = run(['lipo', '-archs', str(APP / 'Contents/MacOS/farfold')])
            need(arch == c['architecture'] == 'arm64', 'Architecture mismatch')
            report['checks'][stage] = {'passed': True, 'architecture': arch}
            stage = 'signature'
            report['checks'][stage] = {'passed': True, **signature()}
            stage = 'archive'
            zip_record = zip_matches(archive_path(commit), files, modes)
            need(all(c[k] == v for k, v in zip_record.items()), 'Archive receipt mismatch')
            report['checks'][stage] = {'passed': True, **zip_record}
            stage = 'formalAppUnchanged'
            formal = baseline()
            need(formal == (c['formalFiles'], c['formalModes']), 'Formal bundle drift')
            need(c['formalBaseline'] == {'sourceCommit': BASELINE_COMMIT, 'receipt': str(BASELINE.relative_to(ROOT)), 'sha256': BASELINE_SHA}, 'Baseline proof mismatch')
            report['checks'][stage] = {'passed': True}
            stage = 'verificationInputsStable'
            need(source(commit) == inputs and bundle(APP) == (files, modes) and baseline() == formal, 'Verification input drift')
            need(zip_matches(archive_path(commit), files, modes) == zip_record and all(sha(relative(p)) == h for p, h in watched.items()), 'Evidence/archive drift')
            report['checks'][stage] = {'passed': True}
            report['result'] = 'passed'
        except Exception as error:
            report['checks'][stage] = {'passed': False, 'error': str(error)}
            report['failures'].append(stage)
        finally:
            report['completedAt'] = now()
            save(output, report)
    print(json.dumps({'result': report['result'], 'checks': len(report['checks']), 'failures': report['failures']}))
    return 0 if report['result'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
