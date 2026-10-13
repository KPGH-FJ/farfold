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
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/attachment-search-candidate'
BASE = ROOT / 'docs/evidence/2026-10-09-capability-hardening'
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
BASELINE_COMMIT = '36c56a827f9bf2146e913bf0d2a2d072f51d89b8'
BASELINE = BASE / 'audio-input-candidate/candidate.json'
BASELINE_SHA = '4d9ef1fc8aca8d97d1193a98810bbdb933eea0a24e46788b870d47a1dff7f637'
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
SOURCE_COMMIT = '9c278d82c758176370efea8a7a17a8d2ab0bf697'
ENGINEERING_SHA = '5cf3ca7ab074641fa7b14faaf863184b9f55a3553e392049e57bc8f4cf5a3f1a'
PRIVATE_ENGINEERING_SHA = '61d677491bb52e5ffc5da1d1b972ba38675f77f6d0e7fba040fd58f64b849037'
ENGINEERING_PATH = ROOT / 'docs/evidence/2026-10-09-capability-hardening/attachment-search-checks/verification.json'
PRIVATE_ENGINEERING_REL = 'output/2026-10-13-attachment-search-integration/checks-run/summary.json'
PRIVATE_ENGINEERING = ROOT / PRIVATE_ENGINEERING_REL
BASELINE_INSTALL = BASE / 'audio-input-candidate/install-independent-final.json'
BASELINE_INSTALL_SHA = '77fbaaf786a7d4da5595c63abaf0c6f2ede556a45bbc6afbc256f42c0ccf919a'
TOP += [str((BASE / suffix).relative_to(ROOT)) for suffix in (
    'mcp-management/backend/actual-wire.json', 'mcp-management/backend/final-wire.json',
    'mcp-add/backend/actual-wire.json', 'mcp-remove/backend/actual-wire.json',
    'mcp-http-add/backend/actual-wire.json', 'attachment-archive/backend/actual-wire.json',
    'attachment-archive/backend/canonical-wire.json', 'history-search/backend/actual-wire.json',
    'history-search/backend/final-wire.json', 'claude-history/backend/actual-wire.json')]


def configured():
    need(isinstance(SOURCE_COMMIT, str) and re.fullmatch('[0-9a-f]{40}', SOURCE_COMMIT), 'Preparation only: SOURCE_COMMIT is UNSET')
    need(all(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v) for v in (ENGINEERING_SHA, PRIVATE_ENGINEERING_SHA, ENGINEERING_PLAN_SHA, INVENTORY_SHA)), 'Preparation only: fresh engineering hashes are UNSET')
    need(isinstance(EXPECTED_INPUT_COUNT, int) and not isinstance(EXPECTED_INPUT_COUNT, bool) and EXPECTED_INPUT_COUNT > 0, 'Preparation only: final closed input count is UNSET')
    need(PRIVATE_ENGINEERING_REL == 'output/2026-10-13-attachment-search-integration/checks-run/summary.json', 'Preparation only: exact successful run path is UNSET')
    need(ENGINEERING_PLAN_REL == 'output/2026-10-13-attachment-search-integration/checks-freeze/freeze.json', 'Preparation only: final execution plan path is UNSET')



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
    return ROOT / f'src-tauri/target/internal-candidate/2026-10-13-attachment-search-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip'


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
    need(freeze_path == ROOT / 'output/2026-10-13-attachment-search-integration/checks-freeze/freeze.json' and preflight_record['passed'] is True and preflight_record['freezeSha256'] == original['freezeSha256'], 'Actual-run final freeze path/preflight differs')
    need(sha(freeze_path) == original['freezeSha256'], 'Actual-run final source freeze changed')
    freeze = read(freeze_path)
    need(freeze['inputCount'] == EXPECTED_INPUT_COUNT and freeze['inputs'] == inputs and freeze['groups'] == plan['groups'], 'Actual-run frozen inputs/commands differ')
    need(freeze['inventoryPlan']['sha256'] == plan['inventoryPlan']['sha256'] and relative_or_absolute(freeze['inventoryPlan']['path']) == relative_or_absolute(plan['inventoryPlan']['path']), 'Closed inventory plan reference differs')
    need(read(relative_or_absolute(freeze['inventoryPlan']['path']))['paths'] == sorted(inputs), 'Frozen closed input membership differs')
    need(relative_or_absolute(freeze['inventoryPlan']['path']) == INVENTORY_PATH and sha(INVENTORY_PATH) == INVENTORY_SHA, 'Exact new inventory pin differs')
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
    need(actual == (prior['candidateFiles'], prior['candidateModes']), 'Formal files/modes differ from source36c baseline')
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

EXPECTED_INPUT_COUNT = 1756
BASELINE_NATIVE = ROOT / 'docs/evidence/2026-10-09-capability-hardening/audio-input-candidate/installed-native-scoped.json'
BASELINE_NATIVE_SHA = 'ce11e2407738527c7274c303cda57e16e8909ecb9785e1d20c38b568002a9034'
PRIOR_QUIT = ROOT / 'output/2026-10-13-pdf-at-route-native/transcript-receipts/31-call_0f3f762f921247e7a35609d749cd655d.jsonl.raw'
PRIOR_QUIT_SHA = 'a031f8c66c1b09684e883d6c67aeb4de0852fb2a3ad6ee4d0154810d06cd6ee3'
PRIOR_PROCESS = ROOT / 'output/2026-10-13-pdf-at-route-native/03-final-normal-quit-process.json'
PRIOR_PROCESS_SHA = 'da6547ed47cba2eb761f461beabe315f3f6e99e278bbdc140f3b3865a524d8d3'
GENERATED_TOOLS = ROOT / 'output/2026-10-13-attachment-search-install-preparation/generated-tools.json'
ENGINEERING_PLAN_REL = 'output/2026-10-13-attachment-search-integration/checks-freeze/freeze.json'
ENGINEERING_PLAN = ROOT / ENGINEERING_PLAN_REL
ENGINEERING_PLAN_SHA = '3143092192b9f9e0b822867dbac68dce7115a706effa68a5f53040eb03ef0320'


SCOPES += ['src-tauri/test-fixtures/audio-input/']
TOP += ['docs/evidence/2026-10-09-capability-hardening/audio-input/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/frontend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/backend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/independent/publication.json']

def completed_quit_text(event, call_id):
    payload = event.get('payload', {})
    item = payload.get('item', {})
    need(event.get('type') == 'event_msg' and payload.get('type') == 'item_completed'
         and item.get('type') == 'McpToolCall' and item.get('id') == call_id
         and item.get('server') == 'cua_repl' and item.get('tool') == 'js'
         and item.get('status') == 'completed', 'Actual CUA call is not completed')
    result = item.get('result', {})
    content = result.get('content')
    need(result.get('isError') is False and type(content) is list and len(content) == 1
         and content[0].get('type') == 'text' and type(content[0].get('text')) is str,
         'Actual CUA result differs')
    return payload, item, content[0]['text']


def quit_timestamp(value):
    value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    need(value.tzinfo is not None and value <= datetime.now(timezone.utc), 'Unzoned or future exit evidence')
    return value


def latest_data_evidence():
    """Prior phase provenance only; no database or private comparison body is read."""
    values, refs = {}, {}
    for name, item in LATEST_DATA_REFS.items():
        path = relative(item['path'])
        need(sha(path) == item['sha256'] and path.stat().st_size == item['bytes'], 'Latest PDF data provenance changed')
        values[name] = read(path)
        refs[name] = item
    capture = values['capture-receipt-private.json']
    final = values['final-verification-private.json']
    execution = values['execution.json']
    need(capture['sourceCommit'] == final['sourceCommit'] == BASELINE_COMMIT
         and capture['phase'] == 'capturedExactBytesNotAccepted'
         and capture['sourceFirstAndBaselineStable'] is True
         and capture['sourceBefore'] == capture['sourceAfter']
         and capture['firstRawCaptureBefore'] == capture['firstRawCaptureAfter'], 'Latest PDF capture is incomplete')
    source = capture['sourceAfter']
    first = capture['firstRawCaptureAfter']
    need(set(source) == set(first) and 'farfold.sqlite3' in source
         and set(source) <= {'farfold.sqlite3', 'farfold.sqlite3-wal', 'farfold.sqlite3-shm'}
         and all(source[n]['sha256'] == first[n]['sha256'] and source[n]['bytes'] == first[n]['bytes'] for n in source),
         'Latest raw capture bytes differ from recorded source')
    normalization = capture['backupNormalization']
    need(capture['consolidated']['sha256'] == LATEST_DATA_CONSOLIDATED_SHA
         and capture['consolidated']['bytes'] == 512000 and normalization['integrity'] == 'ok'
         and normalization['modeAfter'] == 'delete' and normalization['connectionsClosedVerified'] is True
         and normalization['sidecarsAbsentAfterClose'] is True and normalization['deletedOrMovedSidecars'] is False
         and normalization['SQLiteOpenScope'] == 'secondWorkingAndNewConsolidatedOnly', 'Latest private backup provenance differs')
    need(final['captureSha256'] == refs['capture-receipt-private.json']['sha256']
         and final['result'] == 'differencesRequireReview' and final['differenceCount'] == 2
         and final['sourceFirstAndBaselineStableAtFinalCheck'] is True
         and final['finalProcess']['formalProcessCount'] == 0
         and final['finalProcess']['exactExecutableSha256'] == digest(str(FORMAL / 'Contents/MacOS/farfold').encode())
         and execution['actualExitCode'] == 2 and execution['runCount'] == 1
         and execution['frozenInputsStable'] is True
         and execution['freezeSha256Before'] == execution['freezeSha256After'], 'Prior strict exit 2 must remain recorded')
    need(quit_timestamp(read(PRIOR_ACTUAL_PROCESS)['timestamp']) <= quit_timestamp(execution['startedAtUtc'])
         <= quit_timestamp(final['checkedAtUtc']) <= quit_timestamp(execution['completedAtUtc']), 'Latest PDF stage order differs')
    return {'references': refs, 'sourceFiles': {name: {'sha256': value['sha256'], 'bytes': value['bytes']} for name, value in source.items()},
            'strictExitCode': 2, 'differencesAccepted': False,
            'boundary': 'Latest closed-app PDF phase provenance only. Preserve original strict exit 2; this is not a new installation manifest or acceptance of earlier differences.'}


def prior_exit_evidence():
    """Validate original PDF save/quit30/31 and lowercase process03, never App/DB."""
    need(sha(BASELINE_NATIVE) == BASELINE_NATIVE_SHA and read(BASELINE_NATIVE)['sourceCommit'] == BASELINE_COMMIT,
         'Prior installed source record changed')
    expected = ((QUIT_CONTEXT, QUIT_CONTEXT_SHA), (PRIOR_QUIT, PRIOR_QUIT_SHA),
                (QUIT_MANIFEST, QUIT_MANIFEST_SHA), (PRIOR_PROCESS, PRIOR_PROCESS_SHA),
                (PRIOR_ACTUAL_PROCESS, PRIOR_ACTUAL_PROCESS_SHA))
    need(all(sha(p) == value for p, value in expected), 'Latest actual quit/process receipt changed')
    context, quit, manifest, process, process_source = [read(p) for p, _ in expected]
    ctx_payload, ctx_item, ctx_text = completed_quit_text(context, 'call_197e7efb8c3244ee812683f3464afe9c')
    quit_payload, quit_item, quit_text = completed_quit_text(quit, 'call_0f3f762f921247e7a35609d749cd655d')
    need(ctx_item['arguments']['code'] == "await pdfNativeApp.pressKey('super+q'); await pdfNativeApp.getAXState();"
         and digest(ctx_text.encode()) == '06d02844674c9c6f3c40bbac7e5288e43a0fae27a638c09009a47a87895a3053'
         and '97 按钮 保存并退出' in ctx_text and quit_item['arguments']['code'] == 'await pdfNativeApp.click(97);'
         and quit_text == '' and quit['timestamp'] == '2026-10-13T14:52:36.263Z', 'Actual save/quit action differs')
    need(manifest['sourceThreadId'] == ctx_payload['thread_id'] == quit_payload['thread_id'], 'Quit raw source thread differs')
    for event, path, pin, call_id in ((context, QUIT_CONTEXT, QUIT_CONTEXT_SHA, ctx_item['id']),
                                      (quit, PRIOR_QUIT, PRIOR_QUIT_SHA, quit_item['id'])):
        entries = [row for row in manifest['entries'] if row['path'] == str(path.relative_to(ROOT))]
        need(len(entries) == 1 and entries[0]['sha256'] == pin and entries[0]['callId'] == call_id
             and entries[0]['status'] == 'completed' and entries[0]['timestamp'] == event['timestamp'], 'Quit raw manifest differs')
    payload = process_source.get('payload', {})
    item = payload.get('item', {})
    command = item.get('command', [])
    need(process_source.get('type') == 'event_msg' and payload.get('type') == 'item_completed'
         and payload.get('thread_id') == ctx_payload['thread_id'] and item.get('type') == 'CommandExecution'
         and item.get('id') == 'exec-47acc09e-0f4c-4d46-a441-872c9bef3417'
         and item.get('status') == 'completed' and type(item.get('exit_code')) is int and item['exit_code'] == 0
         and digest(json.dumps(command, separators=(',', ':')).encode()) == '1ad6f25b3d73f8891a0845bd0fe2037d42b8c54ee5b959327b0212f224cc7df0'
         and command[:2] == ['/bin/zsh', '-lc'] and len(command) == 3
         and "partition(' ')[2].strip()=='" + str(FORMAL / 'Contents/MacOS/farfold') + "'" in command[2],
         'Actual lowercase executable process command differs')
    need(json.loads(item['aggregated_output']) == {'formalProcessCount': 0, 'receipt': str(PRIOR_PROCESS.relative_to(ROOT))}
         and process['command'] == ['/bin/ps', '-axo', 'pid=,comm=']
         and type(process['actualExitCode']) is int and process['actualExitCode'] == 0
         and process['exactFormalProcessMatches'] == [], 'Actual precise process observation differs')
    need(quit_timestamp(context['timestamp']) <= quit_timestamp(quit['timestamp']) <= quit_timestamp(process['atUtc'])
         <= quit_timestamp(process_source['timestamp']), 'Quit/process time order differs')
    refs = {'originalNormalExit': (PRIOR_QUIT, PRIOR_QUIT_SHA),
            'originalQuitContext': (QUIT_CONTEXT, QUIT_CONTEXT_SHA), 'originalQuitManifest': (QUIT_MANIFEST, QUIT_MANIFEST_SHA),
            'originalExactExecutableProcessReceipt': (PRIOR_PROCESS, PRIOR_PROCESS_SHA),
            'originalProcessExecution': (PRIOR_ACTUAL_PROCESS, PRIOR_ACTUAL_PROCESS_SHA),
            'formalBaselineNative': (BASELINE_NATIVE, BASELINE_NATIVE_SHA)}
    return {**{key: {'path': str(p.relative_to(ROOT)), 'sha256': pin} for key, (p, pin) in refs.items()},
            'latestClosedDataStage': latest_data_evidence()}


def validate_normal_observation(observed):
    for key, value in prior_exit_evidence().items():
        need(observed[key] == value, 'Actual prior normal-exit or latest data reference differs')
    need(observed['sourceCommit'] == SOURCE_COMMIT and observed['userAuthorizedContinuousDevelopment'] is True
         and observed['normalQuitObserved'] is True and observed['forcedQuit'] is False
         and observed['formalProcessCountAfter'] == 0 and observed['newQuitPerformed'] is False,
         'Fresh normal-exit observation incomplete')
    need(observed['rootConfirmedNoAppRestartSincePriorQuit'] is True and observed['unconfirmedWorkMarkedComplete'] is False,
         'Normal-exit continuity or unknown work boundary absent')
    process = observed['processCheck']
    need(process['argv'] == ['/bin/ps', '-axo', 'pid=,comm='] and type(process['exitCode']) is int
         and process['exitCode'] == 0 and process['exactExecutable'] == str(FORMAL / 'Contents/MacOS/farfold')
         and process['matchingPids'] == [], 'Fresh exact process observation incomplete')
    need(quit_timestamp(observed['observedAtUtc']) >= quit_timestamp(read(PRIOR_PROCESS)['atUtc'])
         and quit_timestamp(observed['observedAtUtc']) >= quit_timestamp(read(relative(LATEST_DATA_REFS['execution.json']['path']))['completedAtUtc']),
         'Fresh observation predates latest actual closed stage')
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
        need(original.is_relative_to(ROOT / 'output/2026-10-13-attachment-search-integration') and public.is_relative_to(path.parent) and public.name.endswith('.raw') and public not in seen, 'Engineering publication escaped this exact run or duplicated an entry')
        need(item['original']['sha256'] == item['published']['sha256'] == sha(original) == sha(public) and item['original']['bytes'] == item['published']['bytes'] == original.stat().st_size == public.stat().st_size, 'Engineering publication raw bytes differ')
        seen.add(public)
        refs[str(original.relative_to(ROOT))] = sha(original)
        refs[str(public.relative_to(ROOT))] = sha(public)
    return refs


QUIT_CONTEXT = ROOT / 'output/2026-10-13-pdf-at-route-native/transcript-receipts/30-call_197e7efb8c3244ee812683f3464afe9c.jsonl.raw'
QUIT_CONTEXT_SHA = '56e65c9dd258f96f470a97127dded078bbe76b2a1faf90898f33ef15296ed87c'
QUIT_MANIFEST = ROOT / 'output/2026-10-13-pdf-at-route-native/transcript-receipts/manifest.json'
QUIT_MANIFEST_SHA = '183472ef193779894019c562df2e5c1d88a4e3673d45f6989a420c1cc3b7e89c'
PRIOR_ACTUAL_PROCESS = ROOT / 'output/2026-10-13-pdf-at-route-native/03-final-normal-quit-exec.jsonl.raw'
PRIOR_ACTUAL_PROCESS_SHA = '724ad73051eabafeb27784e0014f1802d53eb7417c1c922d9291191bde0d027c'
LATEST_DATA_REFS = {'execution.json': {'path': 'output/2026-10-13-pdf-at-route-data/execution.json', 'bytes': 1260, 'sha256': 'b7c1a8089c53fe9217bebdb7a691dd8fc16a2eed18593d67bb309e980fbeb988'}, 'capture-receipt-private.json': {'path': 'output/2026-10-13-pdf-at-route-data/capture-receipt-private.json', 'bytes': 10304, 'sha256': '1494a30fff2d02749e9648e5b42f18c66b67a2bb87f9058672cf30e8ef7ca3c4'}, 'final-verification-private.json': {'path': 'output/2026-10-13-pdf-at-route-data/final-verification-private.json', 'bytes': 792, 'sha256': 'f5ff866e0d6a886084f88ece3cb49d190dce5b87993a915aecc981eade64da5f'}}
LATEST_DATA_CONSOLIDATED_SHA = '90430bf5a59edb3f7f43dcc2e810e99a180008b3ba8bf35e2643c3a258dc0933'
INVENTORY_PATH = ROOT / 'output/2026-10-13-attachment-search-integration/inventory-plan.json'
INVENTORY_SHA = '71f90937fc08b0e984243d2a0b255ddf9416f490d4d22197d7ad58a006f2d6b1'


TOP = ['.prettierignore', 'docs/architecture.md', 'docs/evidence/2026-10-09-capability-hardening/README.md', 'docs/evidence/2026-10-09-capability-hardening/attachment-archive/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-archive/backend/canonical-wire.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-content-search/backend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-content-search/frontend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-content-search/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-content-search/independent/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/backend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/frontend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/independent/publication.json', 'docs/evidence/2026-10-09-capability-hardening/claude-history/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/01-unicode-lists.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/02-table-images-stories.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/03-sections.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/expectations.json', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/fixtures/oracle.json', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/fixtures/repeated-locations.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/hidden-notice-boundaries.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/nested-choice-fallback.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/oracle-supplement.json', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/supported-choice-markers.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/window-boundaries.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/window-oracle.json', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/active-object.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/complete.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/image-empty-note.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/literal-marker.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/oracle.json', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/partial-hidden.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/make-fixtures.py', 'docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg', 'docs/evidence/2026-10-09-capability-hardening/extension-inventory/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/history-search/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/history-search/backend/final-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/copy-status-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-add/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-http-add/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/final-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-remove/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/pdf-input/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/project-file-selection/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/screenshot-unavailable/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/skill-management/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/skills-inventory/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/oracle.json', 'docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/positions-v1-nonordinal-ids.xlsx', 'docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/positions-v1.xlsx', 'docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/positions-v2.xlsx', 'docs/evidence/2026-10-09-capability-hardening/worktree-preparation/backend/preparation-wire.json', 'docs/evidence/2026-10-09-capability-hardening/worktree-remove/cold-recovery-fix/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/xlsx-input-candidate/installed-native-scoped.json', 'docs/status.md', 'index.html', 'output/2026-10-13-attachment-search-frontend/browser/fixture.tsx', 'output/2026-10-13-attachment-search-frontend/browser/index.html', 'output/2026-10-13-attachment-search-frontend/browser/run.mjs', 'output/2026-10-13-attachment-search-frontend/browser/serve.mjs', 'package.json', 'plans/agent-access.md', 'pnpm-lock.yaml', 'src-tauri/Cargo.lock', 'src-tauri/Cargo.toml', 'src-tauri/Info.plist', 'src-tauri/build.rs', 'src-tauri/examples/windows_process_fixture.rs', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json', 'src-tauri/testdata/signed-update-metadata.json', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts']

if __name__ == '__main__':
    sys.exit(main())
