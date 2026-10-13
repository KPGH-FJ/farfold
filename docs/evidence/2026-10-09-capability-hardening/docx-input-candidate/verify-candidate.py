"""Nine independent read-only checks. Only main writes its exclusive receipt.
Pure definitions are also imported by prepare; importing runs no commands or I/O.
"""
import hashlib
import importlib.util
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
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/docx-input-candidate'
BASE = ROOT / 'docs/evidence/2026-10-09-capability-hardening'
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
BASELINE_COMMIT = '3bcd43dcd86713748d95f9255f2653e656772b3a'
BASELINE = BASE / 'claude-history-origin-fix-candidate/candidate.json'
BASELINE_SHA = '1abbf0411d5abb1370d7b66faeaf7deb9c1b8b81dd8534cf8023a4b2872b5469'
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
TOP += ['docs/evidence/2026-10-09-capability-hardening/skill-management/backend/actual-wire.json']
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


sys.dont_write_bytecode = True
SOURCE_COMMIT = 'b862b79dc1c97e19b688da9c6d031f6ad3856476'
ENGINEERING_SHA = 'b37b1ddc995df2866e50cc2065dbc59a39432ec1c1fad510edb5ea8ab25998bb'
PRIVATE_ENGINEERING_SHA = '0e533f356e13a9ce783aa6a36ef70bf3a72464c5c77a0881feac998441613ac8'
ENGINEERING_PATH = ROOT / 'docs/evidence/2026-10-09-capability-hardening/docx-input-checks/verification.json'
PRIVATE_ENGINEERING = ROOT / 'output/2026-10-13-docx-input-checks/run-02/verification.json'
RUN01 = ROOT / 'output/2026-10-13-docx-input-checks/verification.json'
RUN01_SHA = '736d290aadd299271a2344201b0ed749ac4ef2ab9c6f4dd292a41be8b73157f0'
ONLY_CHANGED_INPUT = 'src/components/Composer.project-files.test.tsx'
CHANGED_BEFORE = '8a5d2620245b4cca0f6ffcafdd4ff2c96e5bd5be15e1397fc4201b623b901d86'
CHANGED_AFTER = '0c307b6ec5e5231f43a560383537c479dd6be1f0527e17f427e263fc25279d60'
BASELINE_INSTALL = BASE / 'claude-history-origin-fix-candidate/install-independent-final.json'
BASELINE_INSTALL_SHA = '3a26c8e52d22b1fe198b3b4b70b9c88e253e0ce11d7c2d52f6cee6cc4778166e'
TOP += [str((BASE / suffix).relative_to(ROOT)) for suffix in (
    'mcp-management/backend/actual-wire.json', 'mcp-management/backend/final-wire.json',
    'mcp-add/backend/actual-wire.json', 'mcp-remove/backend/actual-wire.json',
    'mcp-http-add/backend/actual-wire.json', 'attachment-archive/backend/actual-wire.json',
    'attachment-archive/backend/canonical-wire.json', 'history-search/backend/actual-wire.json',
    'history-search/backend/final-wire.json', 'claude-history/backend/actual-wire.json')]


def configured():
    need(isinstance(SOURCE_COMMIT, str) and re.fullmatch('[0-9a-f]{40}', SOURCE_COMMIT), 'Preparation only: SOURCE_COMMIT is UNSET')
    need(re.fullmatch('[0-9a-f]{64}', ENGINEERING_SHA) and re.fullmatch('[0-9a-f]{64}', PRIVATE_ENGINEERING_SHA), 'Preparation only: fresh engineering hashes are UNSET')



# P08 fixed source inputs; checked against the complete engineering inventory.
TOP += ['docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/complete.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/active-object.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/image-empty-note.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/literal-marker.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/partial-hidden.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/oracle.json', 'docs/evidence/2026-10-09-capability-hardening/docx-input/make-fixtures.py']

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
    configured()
    need(len(sys.argv) == 3 and sys.argv[1] == SOURCE_COMMIT, 'Expected the pinned exact source commit and proof')
    proof = relative(sys.argv[2])
    need(proof == ENGINEERING_PATH, 'Wrong exact engineering path')
    return SOURCE_COMMIT, proof


def archive_path(commit):
    return ROOT / f'src-tauri/target/internal-candidate/2026-10-13-docx-input-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip'


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
    configured()
    need(path == ENGINEERING_PATH and sha(path) == ENGINEERING_SHA and sha(PRIVATE_ENGINEERING) == PRIVATE_ENGINEERING_SHA, 'Pinned fresh engineering receipts differ')
    report, original = read(path), read(PRIVATE_ENGINEERING)
    refs = {str(p.relative_to(ROOT)): sha(p) for p in (path, PRIVATE_ENGINEERING)}
    need(all(report.get(k) == v for k, v in original.items() if k != 'checks'), 'Published verification changed original semantics')
    need(report['originalPrivateVerification'] == {'path': str(PRIVATE_ENGINEERING.relative_to(ROOT)), 'sha256': PRIVATE_ENGINEERING_SHA}, 'Private original verification reference differs')
    original_public = path.parent / 'verification-original.json.raw'
    need(report['originalPublishedVerification'] == {'path': str(original_public.relative_to(ROOT)), 'sha256': PRIVATE_ENGINEERING_SHA} and sha(original_public) == PRIVATE_ENGINEERING_SHA, 'Published raw original differs')
    refs[str(original_public.relative_to(ROOT))] = sha(original_public)
    required_flags = ('allPassed', 'sourceStable', 'protectedUnchanged')
    for record in (report, original):
        need(all(record.get(k) is True for k in required_flags), 'Engineering not fully passing/stable')
        need(record.get('changedInputsDuringRun') == [] and record['inputCount'] == len(inputs), 'Incomplete or drifting engineering')
        need(len(record['checks']) == 7 and {c['name'] for c in record['checks']} == set(COMMANDS), 'Need seven traceable actual checks')
    need(report['counts'] == original['counts'], 'Published counts differ from original')
    prior = read(RUN01)
    need(sha(RUN01) == RUN01_SHA and prior['allPassed'] is False and prior['sourceStable'] is True and prior['protectedUnchanged'] is True and prior['changedInputs'] == [], 'Run-01 failed/frontend and successful/native boundary differs')
    need(prior['notExecuted'] == ['build'] and len(prior['checks']) == 6 and {c['name'] for c in prior['checks']} == set(COMMANDS) - {'build'}, 'Run-01 execution boundary differs')
    prior_ref = {'path': str(RUN01.relative_to(ROOT)), 'sha256': sha(RUN01), 'bytes': RUN01.stat().st_size}
    refs[prior_ref['path']] = prior_ref['sha256']
    expected_delta = [{'path': ONLY_CHANGED_INPUT, 'before': CHANGED_BEFORE, 'after': CHANGED_AFTER}]
    need(report['onlyChangedInput'] == expected_delta[0], 'Published only changed input differs')
    failure_public = path.parent / 'run-01/verification-original.json.raw'
    failed = report['firstRunFailure']
    need(failed['path'] == str(failure_public.relative_to(ROOT)) and failed['sha256'] == RUN01_SHA and sha(failure_public) == RUN01_SHA and failed['frontendActualExit'] == 1 and failed['sourceStable'] is True and failed['buildNotExecuted'] is True, 'Run-01 public actual failure boundary differs')
    refs[str(failure_public.relative_to(ROOT))] = sha(failure_public)
    for record in (report, original):
        need(record['priorVerification'] == prior_ref and record['changesSinceRun01'] == expected_delta and record['unchangedOtherInputCount'] == len(inputs) - 1, 'Native reuse provenance differs')
    before_inputs = read(RUN01.parent / 'inputs-before.json')
    need(before_inputs == read(RUN01.parent / 'inputs-after.json') and set(before_inputs) == set(inputs) and prior['inputCount'] == len(inputs), 'Run-01 input manifest differs')
    need([p for p in sorted(inputs) if before_inputs[p] != inputs[p]] == [ONLY_CHANGED_INPUT] and before_inputs[ONLY_CHANGED_INPUT] == CHANGED_BEFORE and inputs[ONLY_CHANGED_INPUT] == CHANGED_AFTER, 'Native reuse contains a changed production/configuration input')
    for old in prior['checks']:
        need(old['argv'] == COMMANDS[old['name']] and old['executedInThisRun'] is True and old['exitCode'] == (1 if old['name'] == 'frontend' else 0), 'Run-01 actual outcome differs')
        raw = relative(old['log'])
        need(raw == RUN01.parent / (old['name'] + '.txt') and sha(raw) == old['sha256'], 'Run-01 original log differs')
        refs[str(raw.relative_to(ROOT))] = sha(raw)
    for name in ('inputs-before.json', 'inputs-after.json', 'protected-before.json', 'protected-after.json'):
        public, private = path.parent / name, PRIVATE_ENGINEERING.parent / name
        need(read(public) == read(private) and sha(public) == sha(private), 'Published manifest differs from original bytes')
        refs[str(public.relative_to(ROOT))] = sha(public)
        refs[str(private.relative_to(ROOT))] = sha(private)
        if name.startswith('inputs-'):
            need(read(public) == inputs, 'Engineering source manifest differs')
    protected = read(path.parent / 'protected-before.json')
    expected_protected = {'PRODUCT.md', 'docs/evidence/2026-10-08-reliability-ui-review/README.md', 'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md'}
    need(set(protected) == expected_protected and protected == read(path.parent / 'protected-after.json') and all(sha(ROOT / p) == h for p, h in protected.items()), 'Protected contract/user changes differ')
    need(protected == read(RUN01.parent / 'protected-before.json') == read(RUN01.parent / 'protected-after.json'), 'Run-01 protected inputs differ')
    for name in ('inputs-before.json', 'inputs-after.json', 'protected-before.json', 'protected-after.json'):
        refs[str((RUN01.parent / name).relative_to(ROOT))] = sha(RUN01.parent / name)
    for check in report['checks']:
        name = check['name']
        old = next(c for c in original['checks'] if c['name'] == name)
        need(check.get('originalLog') == old['log'] and {k: v for k, v in check.items() if k not in ('log', 'originalLog')} == {k: v for k, v in old.items() if k != 'log'}, 'Published check changed original semantics')
        native = name in ('cargo-fmt', 'clippy', 'rust')
        for current in (check, old):
            need(current['argv'] == COMMANDS[name] and current['exitCode'] == 0, 'Check is not the specified actual pass')
            need(current.get('executedInThisRun') is (not native) and current.get('executionRun') == ('run-01' if native else 'run-02'), 'Check execution provenance differs')
            if native:
                actual = next(c for c in prior['checks'] if c['name'] == name)
                need(current.get('executedInRun01') is True and current.get('originalReceipt') == prior_ref and all(current[k] == actual[k] for k in ('argv', 'exitCode', 'sha256', 'startedAtUtc', 'seconds')), 'Native check original record differs')
        raw = relative(old['log'])
        published = relative(check['log'])
        need(raw == (RUN01 if native else PRIVATE_ENGINEERING).parent / (name + '.txt') and published == path.parent / ('run-01/' if native else '') / (name + '.txt'), 'Wrong exact raw/published log path')
        need(sha(raw) == old['sha256'] == check['sha256'] == sha(published), 'Log bytes differ from original')
        refs[str(raw.relative_to(ROOT))], refs[str(published.relative_to(ROOT))] = sha(raw), sha(published)
    ansi = re.compile(r'\x1b\[[0-9;]*m')
    frontend = [line.strip() for line in ansi.sub('', (PRIVATE_ENGINEERING.parent / 'frontend.txt').read_text()).splitlines() if re.match(r'\s*(Test Files|Tests)\s+', line)]
    rust = [line.strip() for line in (RUN01.parent / 'rust.txt').read_text().splitlines() if line.startswith('test result:')]
    need(frontend and report['counts']['frontend'] == frontend, 'Frontend count not supported by raw log')
    need(rust and all(line.startswith('test result: ok.') for line in rust) and report['counts']['rustReusedFromRun01'] == prior['counts']['rust'] == rust, 'Native count not supported by original raw log')
    return {'receipt': str(path.relative_to(ROOT)), 'sha256': sha(path), 'originalPrivateReceipt': {'path': str(PRIVATE_ENGINEERING.relative_to(ROOT)), 'sha256': sha(PRIVATE_ENGINEERING)}, 'inputCount': len(inputs), 'references': refs, 'boundary': 'Four frontend commands executed in run-02; three native actual passes explicitly reused from this slice run-01, with only the pinned frontend shallow test locator changed and all other inputs byte-identical. Run-01 frontend failure/build-not-executed are retained. Candidate, installed UI and actual Agent use remain separate.'}


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
    need(sha(BASELINE) == BASELINE_SHA and sha(BASELINE_INSTALL) == BASELINE_INSTALL_SHA, 'Installed baseline proof changed')
    prior, installed = read(BASELINE), read(BASELINE_INSTALL)
    need(prior['sourceCommit'] == installed['sourceCommit'] == BASELINE_COMMIT, 'Wrong formal baseline source')
    need(prior['phase'] == 'internalCandidatePreparedNotInstalled' and installed['result'] == 'passed' and installed['failures'] == [], 'Incomplete baseline')
    need(len(installed['checks']) == 10 and all(c['passed'] is True for c in installed['checks'].values()), 'Baseline installed checks incomplete')
    actual = bundle(FORMAL)
    need(actual == (prior['candidateFiles'], prior['candidateModes']), 'Formal files/modes differ from source3bcd baseline')
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
