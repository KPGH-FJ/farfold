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
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/audio-input-candidate'
BASE = ROOT / 'docs/evidence/2026-10-09-capability-hardening'
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
BASELINE_COMMIT = 'e5995b219d2f3ed543d9a054911240122358d76b'
BASELINE = BASE / 'pdf-permission-candidate/candidate.json'
BASELINE_SHA = '8f5903a3a293ceef90f734f3a5ba7e74be41b361762f508d57cd1b68c4703b9e'
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
COMMANDS = {'format-check': ['corepack', 'pnpm', 'format:check'], 'typecheck': ['corepack', 'pnpm', 'typecheck'], 'frontend-test': ['corepack', 'pnpm', 'test'], 'frontend-build': ['corepack', 'pnpm', 'build'], 'cargo-fmt': ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml'], 'cargo-clippy': ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings'], 'cargo-test': ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']}


sys.dont_write_bytecode = True
SOURCE_COMMIT = '36c56a827f9bf2146e913bf0d2a2d072f51d89b8'
ENGINEERING_SHA = 'e890ba610c467238a839dc9f84f1d759a2c29b0e6b5d225a50e5836011a6c614'
PRIVATE_ENGINEERING_SHA = 'b1b03447754856c16eae8290880eec482e1a3f60b5bec0b10d20345b1ff46713'
ENGINEERING_PATH = ROOT / 'docs/evidence/2026-10-09-capability-hardening/audio-input-checks/verification.json'
PRIVATE_ENGINEERING_REL = 'output/2026-10-13-audio-input-integration/run-01/summary.json'
PRIVATE_ENGINEERING = ROOT / PRIVATE_ENGINEERING_REL
BASELINE_INSTALL = BASE / 'pdf-permission-candidate/install-independent-final.json'
BASELINE_INSTALL_SHA = 'e859b9a752eacf7b0dfeed43f54341c909bba22dfe618e39881471f2594298e9'
TOP += [str((BASE / suffix).relative_to(ROOT)) for suffix in (
    'mcp-management/backend/actual-wire.json', 'mcp-management/backend/final-wire.json',
    'mcp-add/backend/actual-wire.json', 'mcp-remove/backend/actual-wire.json',
    'mcp-http-add/backend/actual-wire.json', 'attachment-archive/backend/actual-wire.json',
    'attachment-archive/backend/canonical-wire.json', 'history-search/backend/actual-wire.json',
    'history-search/backend/final-wire.json', 'claude-history/backend/actual-wire.json')]


def configured():
    need(isinstance(SOURCE_COMMIT, str) and re.fullmatch('[0-9a-f]{40}', SOURCE_COMMIT), 'Preparation only: SOURCE_COMMIT is UNSET')
    need(all(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v) for v in (ENGINEERING_SHA, PRIVATE_ENGINEERING_SHA, ENGINEERING_PLAN_SHA)), 'Preparation only: fresh engineering hashes are UNSET')
    need(isinstance(EXPECTED_INPUT_COUNT, int) and not isinstance(EXPECTED_INPUT_COUNT, bool) and EXPECTED_INPUT_COUNT > 0, 'Preparation only: final closed input count is UNSET')
    need(PRIVATE_ENGINEERING_REL == 'output/2026-10-13-audio-input-integration/run-01/summary.json', 'Preparation only: exact successful run path is UNSET')
    need(ENGINEERING_PLAN_REL == 'output/2026-10-13-audio-input-integration/final-freeze/freeze.json', 'Preparation only: final execution plan path is UNSET')



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
    return ROOT / f'src-tauri/target/internal-candidate/2026-10-13-audio-input-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip'


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
    need(len(hashes) == EXPECTED_INPUT_COUNT, "Closed source scope count differs")
    return hashes


def engineering(path, inputs):
    configured()
    need(path == ENGINEERING_PATH and sha(path) == ENGINEERING_SHA and sha(PRIVATE_ENGINEERING) == PRIVATE_ENGINEERING_SHA, 'Fresh actual-seven proof hashes differ')
    report, original = read(path), read(PRIVATE_ENGINEERING)
    need(all(report.get(k) == value for k, value in original.items()), 'Published actual-seven summary changed original semantics')
    need(set(report) <= set(original) | {'originalPrivateVerification', 'originalPublishedVerification', 'counts', 'publication'}, 'Unknown publication fields')
    need(report['originalPrivateVerification'] == {'path': str(PRIVATE_ENGINEERING.relative_to(ROOT)), 'bytes': PRIVATE_ENGINEERING.stat().st_size, 'sha256': PRIVATE_ENGINEERING_SHA}, 'Original private summary reference differs')
    public_original = path.parent / 'summary.json.raw'
    need(report['originalPublishedVerification'] == {'path': str(public_original.relative_to(ROOT)), 'bytes': PRIVATE_ENGINEERING.stat().st_size, 'sha256': PRIVATE_ENGINEERING_SHA} and sha(public_original) == PRIVATE_ENGINEERING_SHA, 'Published raw original differs')
    references = {}
    def watch(p):
        references[str(p.relative_to(ROOT))] = sha(p)
    for p in (path, PRIVATE_ENGINEERING, public_original, ENGINEERING_PLAN):
        watch(p)
    need(sha(ENGINEERING_PLAN) == ENGINEERING_PLAN_SHA, 'Closed actual-seven command plan changed')
    plan = read(ENGINEERING_PLAN)
    commands = {name: argv for group in plan['groups'].values() for name, argv in group}
    groups = {name: group for group, stages in plan['groups'].items() for name, _argv in stages}
    need(commands == COMMANDS and len(commands) == 7 and plan['inputCount'] == EXPECTED_INPUT_COUNT, 'Actual-seven command or input scope differs')
    need(original['schema'] == 1 and original['phase'] == 'ACTUAL_COMMAND_RESULTS', 'Not actual command results')
    need(all(original.get(k) is True for k in ('allPassed', 'sourceStable', 'sourceMembershipStable', 'protectedUnchanged')), 'Engineering failed or drifted')
    need(original['requiredCommandsExecuted'] == original['completedCount'] == 7 and original['inputCount'] == len(inputs) == EXPECTED_INPUT_COUNT, 'Incomplete actual-seven execution')
    need(original['interruptedSignal'] is None and original['runnerErrors'] == [] and all(original[k] == [] for k in ('notStarted', 'failed', 'launchFailed')), 'Interrupted, failed or unknown engineering work')
    need(len(original['checks']) == 7 and {c['name'] for c in original['checks']} == set(commands), 'Missing or duplicated engineering command')
    preflight_path = PRIVATE_ENGINEERING.parent / 'preflight.json'
    preflight_record = read(preflight_path)
    freeze_path = relative_or_absolute(preflight_record['freezePath'])
    need(freeze_path == ROOT / 'output/2026-10-13-audio-input-integration/final-freeze/freeze.json' and preflight_record['passed'] is True and preflight_record['freezeSha256'] == original['freezeSha256'], 'Actual-run final freeze path/preflight differs')
    need(sha(freeze_path) == original['freezeSha256'], 'Actual-run final source freeze changed')
    freeze = read(freeze_path)
    need(freeze['inputCount'] == EXPECTED_INPUT_COUNT and freeze['inputs'] == inputs and freeze['groups'] == plan['groups'], 'Actual-run frozen inputs/commands differ')
    need(freeze['inventoryPlan']['sha256'] == plan['inventoryPlan']['sha256'] and relative_or_absolute(freeze['inventoryPlan']['path']) == relative_or_absolute(plan['inventoryPlan']['path']), 'Closed inventory plan reference differs')
    need(read(relative_or_absolute(freeze['inventoryPlan']['path']))['paths'] == sorted(inputs), 'Frozen closed input membership differs')
    need(sha(relative_or_absolute(freeze['inventoryPlan']['path'])) == freeze['inventoryPlan']['sha256'], 'Closed inventory plan bytes changed')
    need(sha(path.parent / 'freeze.json.raw') == sha(freeze_path), 'Published freeze bytes differ')
    watch(path.parent / 'freeze.json.raw')
    watch(freeze_path)
    watch(relative_or_absolute(freeze['inventoryPlan']['path']))
    for name, expected in {**freeze['tools'], **freeze['ownerFreezeReceipts']}.items():
        p = relative_or_absolute(name)
        need(sha(p) == expected, 'Actual-run tool/owner freeze changed')
        watch(p)
    for name in ('inputs-before.json', 'inputs-after.json', 'protected-before.json', 'protected-after.json'):
        private, public = PRIVATE_ENGINEERING.parent / name, path.parent / (name + '.raw')
        need(sha(private) == sha(public) and read(private) == read(public), 'Published frozen manifest changed original bytes')
        if name.startswith('inputs-'):
            need(read(private) == inputs, 'Actual-seven source manifest differs')
        else:
            expected_protected = {'PRODUCT.md', 'docs/evidence/2026-10-08-reliability-ui-review/README.md', 'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md'}
            need(set(read(private)) == expected_protected and read(private) == freeze['protected'] and all(sha(ROOT / p) == value for p, value in read(private).items()), 'Protected contract/user records differ')
        watch(private)
        watch(public)
    preflight = PRIVATE_ENGINEERING.parent / 'preflight.json'
    need(read(preflight)['passed'] is True and read(preflight)['freezeSha256'] == original['freezeSha256'], 'Actual-run preflight not passed')
    watch(preflight)
    counts = {}
    for stage in original['checks']:
        name = stage['name']
        need(stage['argv'] == commands[name] and stage['group'] == groups[name] and stage['cwd'] == str(ROOT), 'Actual command identity differs')
        need(stage['state'] == 'COMPLETED' and stage['actualStageCompletion'] is True and stage['processLaunched'] is True and stage['rawExitCode'] == 0, 'A stage was not actually completed successfully')
        private = PRIVATE_ENGINEERING.parent / name
        public = path.parent / name
        started, completed = read(private / 'started.json'), read(private / 'completed.json')
        need(completed == stage and all(stage[k] == value for k, value in started.items()), 'Actual stage start/completion receipts differ')
        need(stage['elapsedSeconds'] >= 0 and isinstance(stage['pid'], int) and stage['pid'] > 0, 'Actual process receipt missing')
        for file in ('started.json', 'completed.json', 'stdout.log', 'stderr.log'):
            public_file = public / (file + '.raw')
            need(sha(private / file) == sha(public_file), 'Published stage raw bytes differ')
            watch(private / file)
            watch(public_file)
        need(sha(private / 'stdout.log') == stage['stdoutSha256'] and sha(private / 'stderr.log') == stage['stderrSha256'], 'Actual stdout/stderr hash differs')
        text = (private / 'stdout.log').read_text() + (private / 'stderr.log').read_text()
        if name == 'frontend-test':
            clean = re.sub(r'\x1b\[[0-9;]*m', '', text)
            counts['frontendSummaryLines'] = [line.strip() for line in clean.splitlines() if re.match(r'\s*(Test Files|Tests)\s+', line)]
            need(counts['frontendSummaryLines'], 'Frontend counts missing from actual output')
        if name == 'cargo-test':
            counts['rustSummaryLines'] = [line.strip() for line in text.splitlines() if line.startswith('test result:')]
            need(counts['rustSummaryLines'] and all(line.startswith('test result: ok.') for line in counts['rustSummaryLines']), 'Native counts missing or failed')
    references.update(raw_publication_evidence(inputs))
    references.update(engineering_publication_evidence(path, report))
    if 'counts' in report:
        need(report['counts'] == counts, 'Published test counts not supported by actual output')
    return {'receipt': str(path.relative_to(ROOT)), 'sha256': sha(path), 'originalPrivateReceipt': {'path': str(PRIVATE_ENGINEERING.relative_to(ROOT)), 'sha256': sha(PRIVATE_ENGINEERING)}, 'inputCount': len(inputs), 'references': references, 'counts': counts, 'boundary': 'All seven commands actually executed once in this exact new run; every original start/completion/stdout/stderr and complete source/protected manifest is pinned. No reuse, candidate, installed workflow or real Agent acceptance inferred.'}


def relative_or_absolute(name):
    value = Path(name)
    if value.is_absolute():
        need(value.is_relative_to(ROOT), 'Evidence escaped repository')
        return value
    return relative(name)


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
    prior_exit_evidence()
    need(prior['sourceCommit'] == installed['sourceCommit'] == BASELINE_COMMIT, 'Wrong formal baseline source')
    need(prior['phase'] == 'internalCandidatePreparedNotInstalled' and installed['result'] == 'passed' and installed['failures'] == [], 'Incomplete baseline')
    need(len(installed['checks']) == 10 and all(c['passed'] is True for c in installed['checks'].values()), 'Baseline installed checks incomplete')
    actual = bundle(FORMAL)
    need(actual == (prior['candidateFiles'], prior['candidateModes']), 'Formal files/modes differ from sourcee599 baseline')
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



SCOPES += ['docs/evidence/2026-10-09-capability-hardening/xlsx-input/fixtures/']
SCOPES += ['docs/evidence/2026-10-09-capability-hardening/pdf-input/fixtures/']
TOP += ['docs/status.md', 'docs/architecture.md', 'plans/agent-access.md', 'docs/evidence/2026-10-09-capability-hardening/README.md', 'docs/evidence/2026-10-09-capability-hardening/pdf-input/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/xlsx-input-candidate/installed-native-scoped.json']

EXPECTED_INPUT_COUNT = 1736
BASELINE_NATIVE = ROOT / 'docs/evidence/2026-10-09-capability-hardening/pdf-permission-candidate/installed-native-scoped.json'
BASELINE_NATIVE_SHA = '16af55cdac1582353df25d6b0ad9cbb0d83b189530f0def4b8d3c6c1f6d5cae9'
PRIOR_QUIT = ROOT / 'output/2026-10-13-pdf-permission-native/46-final-normal-quit-event.json'
PRIOR_QUIT_SHA = '9a8e70e8dd6e5abea0bd2367619c1a9c805dc72070f7131812b87034e04b8f75'
PRIOR_PROCESS = ROOT / 'output/2026-10-13-pdf-permission-native/47-final-exact-process-receipt.json'
PRIOR_PROCESS_SHA = '426466502c2b4e018302576906cd2564a9c825858caef87b53a01cea7bdf9a5a'
GENERATED_TOOLS = ROOT / 'output/2026-10-13-audio-input-install-preparation/generated-tools.json'
ENGINEERING_PLAN_REL = 'output/2026-10-13-audio-input-integration/final-freeze/freeze.json'
ENGINEERING_PLAN = ROOT / ENGINEERING_PLAN_REL
ENGINEERING_PLAN_SHA = 'a9c357458d99b0ad0e40afaca1ab8a872f8e2fea66d1b9f6eb9ca8fb2aab985c'


SCOPES += ['src-tauri/test-fixtures/audio-input/']
TOP += ['docs/evidence/2026-10-09-capability-hardening/audio-input/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/frontend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/backend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/independent/publication.json']

def prior_exit_evidence():
    """Read only the actual e599 quit/process receipts, never App or data files."""
    need(sha(BASELINE_NATIVE) == BASELINE_NATIVE_SHA, 'Formal native record changed')
    native = read(BASELINE_NATIVE)
    need(native['sourceCommit'] == BASELINE_COMMIT, 'Prior native source differs')
    need('normal save and quit with exact process count zero' in native['nativePassed'], 'Prior native quit not recorded')
    need(sha(PRIOR_QUIT) == PRIOR_QUIT_SHA and sha(PRIOR_PROCESS) == PRIOR_PROCESS_SHA, 'Actual prior quit/process bytes changed')
    prior, process = read(PRIOR_QUIT), read(PRIOR_PROCESS)
    need(prior['sourceCommit'] == process['sourceCommit'] == BASELINE_COMMIT, 'Prior quit/process source differs')
    need(prior['normalExitVia'] == 'CUA 保存并退出' and prior['forcedQuit'] is False and prior['unknownWorkNotClassifiedCompletedOrStopped'] is True, 'Not an observed normal save and quit')
    need(prior['action']['api'] == 'app.click' and prior['action']['label'] == '保存并退出' and prior['action']['returnedSuccessfully'] is True, 'Actual quit action incomplete')
    need(prior['historicalUnknownResultPreserved'] is True and prior['noSendActionPerformed'] is True, 'Prior work boundary changed')
    need(prior['postActionObservation'] == {'method': 'cua.listApps', 'apps': []}, 'Prior post-quit observation differs')
    need(process['actualExitCode'] == 0 and process['exactFormalProcesses'] == [] and process['exactExecutable'] == str(FORMAL / 'Contents/MacOS/farfold') and process['command'] == ['/bin/ps', '-axo', 'pid=,comm='], 'Actual prior exact process observation incomplete')
    need(process['normalQuitEventPath'] == str(PRIOR_QUIT.relative_to(ROOT)) and process['normalQuitEventSha256'] == PRIOR_QUIT_SHA, 'Prior process quit pointer differs')
    need(datetime.fromisoformat(process['observedAtUtc'].replace('Z', '+00:00')) >= datetime.fromisoformat(prior['observedAtUtc'].replace('Z', '+00:00')), 'Prior process observation predates quit')
    for private, expected, suffix in ((PRIOR_QUIT, PRIOR_QUIT_SHA, 'final-normal-quit.json.raw'), (PRIOR_PROCESS, PRIOR_PROCESS_SHA, 'final-process.json.raw')):
        published = BASELINE_NATIVE.parent / 'native-scoped' / suffix
        ref = {'originalPath': str(private.relative_to(ROOT)), 'publishedPath': str(published.relative_to(ROOT)), 'sha256': expected, 'bytes': private.stat().st_size}
        need(native['references'].count(ref) == 1 and sha(published) == expected and published.stat().st_size == ref['bytes'], 'Native publication differs from actual prior evidence')
    return {'originalNormalExit': {'path': str(PRIOR_QUIT.relative_to(ROOT)), 'sha256': PRIOR_QUIT_SHA}, 'originalExactExecutableProcessReceipt': {'path': str(PRIOR_PROCESS.relative_to(ROOT)), 'sha256': PRIOR_PROCESS_SHA}, 'formalBaselineNative': {'path': str(BASELINE_NATIVE.relative_to(ROOT)), 'sha256': BASELINE_NATIVE_SHA}}


def validate_normal_observation(observed):
    for key, value in prior_exit_evidence().items():
        need(observed[key] == value, 'Actual prior normal-exit reference differs')
    need(observed['sourceCommit'] == SOURCE_COMMIT and observed['userAuthorizedContinuousDevelopment'] is True and observed['normalQuitObserved'] is True and observed['forcedQuit'] is False and observed['formalProcessCountAfter'] == 0 and observed['newQuitPerformed'] is False, 'Fresh normal-exit observation incomplete')
    need(observed['rootConfirmedNoAppRestartSincePriorQuit'] is True and observed['unconfirmedWorkMarkedComplete'] is False, 'Normal-exit continuity or unknown work boundary absent')
    process = observed['processCheck']
    need(process['argv'] == ['/bin/ps', '-axo', 'pid=,comm='] and process['exitCode'] == 0 and process['exactExecutable'] == str(FORMAL / 'Contents/MacOS/farfold') and process['matchingPids'] == [], 'Fresh exact process observation incomplete')
    need(datetime.fromisoformat(observed['observedAtUtc']) >= datetime.fromisoformat(read(PRIOR_PROCESS)['observedAtUtc']), 'Fresh observation predates actual prior process receipt')
    return observed


def raw_publication_evidence(inputs):
    """Verify only the explicitly published synthetic records and their raw copies."""
    refs = {}
    for group, key, source_key, public_key in (('backend', 'references', 'source', 'public'), ('frontend', 'entries', 'sourcePath', 'publishedPath'), ('independent', 'files', 'source', 'public')):
        p = BASE / 'audio-input' / group / 'publication.json'
        need(sha(p) == inputs[str(p.relative_to(ROOT))], 'Frozen audio publication changed')
        value = read(p)
        seen = set()
        for item in value[key]:
            original, public = relative(item[source_key]), relative(item[public_key])
            need(original.is_relative_to(ROOT / 'output') and original.parts[len(ROOT.parts) + 1].startswith('2026-10-13-audio-input-'), 'Raw source escaped this synthetic audio slice')
            need(public.is_relative_to(p.parent) and public.name.endswith('.raw') and public not in seen, 'Published raw scope or membership differs')
            need(sha(original) == sha(public) == item['sha256'] and original.stat().st_size == public.stat().st_size == item['bytes'], 'Published audio raw bytes differ')
            seen.add(public)
            refs[str(original.relative_to(ROOT))] = item['sha256']
            refs[str(public.relative_to(ROOT))] = item['sha256']
        refs[str(p.relative_to(ROOT))] = sha(p)
    return refs


def engineering_publication_evidence(path, report):
    need(report['publication'] == 'publication.json', 'Unexpected engineering publication path')
    publication = path.parent / 'publication.json'
    value = read(publication)
    need(value['schema'] == 1 and value['files'], 'Missing engineering raw publication')
    refs, seen = {str(publication.relative_to(ROOT)): sha(publication)}, set()
    for item in value['files']:
        original, public = relative(item['original']['path']), relative(item['published']['path'])
        need(original.is_relative_to(ROOT / 'output/2026-10-13-audio-input-integration') and public.is_relative_to(path.parent) and public.name.endswith('.raw') and public not in seen, 'Engineering publication escaped this exact run or duplicated an entry')
        need(item['original']['sha256'] == item['published']['sha256'] == sha(original) == sha(public) and item['original']['bytes'] == item['published']['bytes'] == original.stat().st_size == public.stat().st_size, 'Engineering publication raw bytes differ')
        seen.add(public)
        refs[str(original.relative_to(ROOT))] = sha(original)
        refs[str(public.relative_to(ROOT))] = sha(public)
    return refs


if __name__ == '__main__':
    sys.exit(main())
