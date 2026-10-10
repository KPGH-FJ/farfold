"""Prepare and verify the exact committed candidate. Never install or quit apps."""
from pathlib import Path
import hashlib
import json
import plistlib
import stat
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
EXPECTED = sys.argv[1]
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
ARCHIVE = ROOT / f'src-tauri/target/internal-candidate/2026-10-10-{EXPECTED[:8]}/Farfold-0.1.7-{EXPECTED[:8]}.zip'
RECEIPT = OUT / 'candidate.json'
SCOPES = ['src/', 'assets/', 'public/', 'scripts/', 'src-tauri/src/', 'src-tauri/native/', 'src-tauri/capabilities/', 'src-tauri/icons/', 'src-tauri/resources/', 'docs/evidence/2026-10-09-capability-hardening/docx-fixtures/', 'docs/evidence/2026-10-09-capability-hardening/docx/public-samples/']
TOP = ['docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/copy-status-wire.json', 'docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg', '.prettierignore', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/01-unicode-lists.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/02-table-images-stories.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/03-sections.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/expectations.json', 'index.html', 'package.json', 'pnpm-lock.yaml', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/Info.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json']

TOP += ['docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/' + name for name in ('positions-v1.xlsx', 'positions-v2.xlsx', 'positions-v1-nonordinal-ids.xlsx', 'oracle.json')]
TOP += ['docs/evidence/2026-10-09-capability-hardening/docx-feedback/' + name for name in ('fixtures/repeated-locations.docx', 'fixtures/oracle.json', 'independent/supported-choice-markers.docx', 'independent/nested-choice-fallback.docx', 'independent/hidden-notice-boundaries.docx', 'independent/oracle-supplement.json', 'independent/window-boundaries.docx', 'independent/window-oracle.json')]



def run(args):
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: {result.stderr[-1000:]}')
    return (result.stdout + result.stderr).strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def files(root):
    entries = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise RuntimeError(f'Unexpected symlink in {root.name}')
        if path.is_file():
            entries[str(path.relative_to(root))] = sha(path)
    if not entries:
        raise RuntimeError(f'Empty bundle {root.name}')
    return entries


def source():
    entries = set(TOP)
    for name in SCOPES:
        entries.update(str(p.relative_to(ROOT)) for p in (ROOT / name).rglob('*') if p.is_file() and p.name != '.DS_Store')
    tracked = set(run(['git', 'ls-tree', '-r', '--name-only', EXPECTED]).splitlines())
    expected_paths = {name for name in tracked if name in TOP or any(name.startswith(scope) for scope in SCOPES)}
    if entries != expected_paths:
        raise RuntimeError('Source inventory differs from requested commit')
    hashes = {}
    for name in sorted(entries):
        path = ROOT / name
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
            raise RuntimeError('Unexpected source file type')
        raw = path.read_bytes()
        expected_blob = run(['git', 'rev-parse', f'{EXPECTED}:{name}'])
        actual_blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        if actual_blob != expected_blob:
            raise RuntimeError('Source differs from commit: ' + name)
        hashes[name] = hashlib.sha256(raw).hexdigest()
    return hashes


if any(path.exists() for path in (RECEIPT, APP, ARCHIVE, OUT / 'candidate-inputs.json', OUT / 'checks/candidate-build.txt')):
    raise RuntimeError('Candidate destination already exists; will not overwrite it')
# Acquire this run's receipt exclusively. Failed preflight must not replace old evidence.
receipt_handle = RECEIPT.open('x')
record = {'sourceCommit': EXPECTED, 'startedAt': datetime.now(timezone.utc).isoformat(), 'formalAppReplaced': False, 'installed': False, 'realAgentInvoked': False, 'command': 'corepack pnpm tauri:build:internal'}
try:
    if run(['git', 'rev-parse', 'HEAD']) != EXPECTED:
        raise RuntimeError('HEAD differs from requested commit')
    original_formal = files(FORMAL)
    before = source()
    with (OUT / 'candidate-inputs.json').open('x') as inputs_handle:
        inputs_handle.write(json.dumps(before, indent=2) + '\n')
    record['sourceInputCount'] = len(before)
    record['sourceScope'] = {'directories': SCOPES, 'files': TOP, 'claim': 'Application source/configuration inputs and tests in those scopes, including committed DOCX test fixtures; excluding dependencies/toolchain and rendered visual references'}
    with (OUT / 'checks/candidate-build.txt').open('x') as log:
        result = subprocess.run(['corepack', 'pnpm', 'tauri:build:internal'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    record['buildExitCode'] = result.returncode
    if result.returncode:
        raise RuntimeError('Internal candidate build failed')
    if source() != before or run(['git', 'rev-parse', 'HEAD']) != EXPECTED:
        raise RuntimeError('Source changed during build')
    record['sourceMatchesCommitBeforeAndAfter'] = True
    info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == 'ai.farfold.desktop'
    assert info['CFBundleShortVersionString'] == '0.1.7'
    assert info['CFBundleExecutable'] == 'farfold'
    record['architecture'] = run(['lipo', '-archs', str(APP / 'Contents/MacOS/farfold')])
    assert record['architecture'] == 'arm64'
    record['codesignVerify'] = run(['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(APP)])
    record['codesignDetails'] = run(['codesign', '-d', '--verbose=4', str(APP)])
    assert 'Signature=adhoc' in record['codesignDetails']
    record['candidateFiles'] = files(APP)
    record['bundleIdentifier'] = info['CFBundleIdentifier']
    record['version'] = info['CFBundleShortVersionString']
    record['candidateApp'] = str(APP)
    record['signature'] = 'ad-hoc; not notarized or public distribution signed'
    ARCHIVE.parent.mkdir(parents=True)
    run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(APP), str(ARCHIVE)])
    with zipfile.ZipFile(ARCHIVE) as archive:
        assert archive.testzip() is None
        archived_files = {entry.filename.removeprefix('Farfold.app/'): hashlib.sha256(archive.read(entry)).hexdigest() for entry in archive.infolist() if not entry.is_dir() and not entry.filename.startswith('__MACOSX/')}
        assert archived_files == record['candidateFiles']
    assert files(FORMAL) == original_formal
    record.update(phase='internalCandidatePreparedNotInstalled', formalFilesUnchanged=True, formalFiles=original_formal, archive=str(ARCHIVE), archiveSha256=sha(ARCHIVE), archiveBytes=ARCHIVE.stat().st_size, archiveMatchesBundle=True)
except Exception as error:
    record.update(phase='failed', error=str(error))
    raise
finally:
    record['completedAt'] = datetime.now(timezone.utc).isoformat()
    receipt_handle.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    receipt_handle.close()
