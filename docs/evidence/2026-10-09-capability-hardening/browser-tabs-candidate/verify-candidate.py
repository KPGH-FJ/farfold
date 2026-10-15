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
OUT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/browser-tabs-candidate'
BASE = ROOT / 'docs/evidence/2026-10-09-capability-hardening'
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
BASELINE_COMMIT = 'fcd7b2669341b05f40c712b6c9fbbca26feb9031'
BASELINE = BASE / 'diff-summary-candidate/candidate.json'
BASELINE_SHA = '0d97f25bdea66bb111287343a5fb63d2575da93842bb3a276cd459b32422bdc9'
BUNDLE_FILES = {'Contents/Info.plist', 'Contents/MacOS/farfold', 'Contents/Resources/icon.icns', 'Contents/Resources/release-manifest.json', 'Contents/_CodeSignature/CodeResources'}
BUILD = ['corepack', 'pnpm', 'tauri:build:internal']
SCOPES = ['src/', 'assets/', 'public/', 'scripts/', 'src-tauri/src/', 'src-tauri/native/', 'src-tauri/capabilities/', 'src-tauri/icons/', 'src-tauri/resources/', 'docs/evidence/2026-10-09-capability-hardening/docx-fixtures/', 'docs/evidence/2026-10-09-capability-hardening/docx/public-samples/']




SCOPES += ['docs/evidence/2026-10-09-capability-hardening/workbook-range/fixtures/']
SCOPES += ['docs/evidence/2026-10-09-capability-hardening/visual-area/fixtures/']







# The qualified-name wire lives in src/runtime/fixtures and is included by src/.
COMMANDS = {'format-check': ['corepack', 'pnpm', 'format:check'], 'typecheck': ['corepack', 'pnpm', 'typecheck'], 'frontend-test': ['corepack', 'pnpm', 'test'], 'frontend-build': ['corepack', 'pnpm', 'build'], 'cargo-fmt': ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml'], 'cargo-clippy': ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings'], 'cargo-test': ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']}


sys.dont_write_bytecode = True
SOURCE_COMMIT = 'aabbbb063555c929f7f63a23d5d58a6b359e865e'
ENGINEERING_SHA = '762144f549cb6e1caa3b575d59b0e12d67f67dd232d4161e094da1ac6c0006e5'
PRIVATE_ENGINEERING_SHA = 'a1e8f815723a6a43f2187e6c15f99ba9cf82d1b706be7aef5e47154efae4b2f3'
ENGINEERING_PATH = ROOT / 'docs/evidence/2026-10-09-capability-hardening/browser-tabs-checks/verification.json'
PRIVATE_ENGINEERING_REL = 'output/2026-10-14-browser-tabs-integration/checks-run-03/summary.json'
PRIVATE_ENGINEERING = ROOT / PRIVATE_ENGINEERING_REL
BASELINE_INSTALL = BASE / 'diff-summary-candidate/install-independent-final.json'
BASELINE_INSTALL_SHA = '034446261d20db459a9999ea787d3edcb4341f4d4ed69d29c28e96503ad67900'



def configured():
    need(INPUT_SCOPE_READY is True, 'Preparation only: final inventory scope is UNSET')
    need(isinstance(SOURCE_COMMIT, str) and re.fullmatch('[0-9a-f]{40}', SOURCE_COMMIT), 'Preparation only: SOURCE_COMMIT is UNSET')
    need(all(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v) for v in (ENGINEERING_SHA, PRIVATE_ENGINEERING_SHA, ENGINEERING_PLAN_SHA, INVENTORY_SHA)), 'Preparation only: fresh engineering hashes are UNSET')
    need(isinstance(EXPECTED_INPUT_COUNT, int) and not isinstance(EXPECTED_INPUT_COUNT, bool) and EXPECTED_INPUT_COUNT > 0, 'Preparation only: final closed input count is UNSET')
    need(PRIVATE_ENGINEERING_REL == 'output/2026-10-14-browser-tabs-integration/checks-run-03/summary.json', 'Preparation only: exact successful run path is UNSET')
    need(ENGINEERING_PLAN_REL == 'output/2026-10-14-browser-tabs-integration/checks-freeze-03/freeze.json', 'Preparation only: final execution plan path is UNSET')



# P08 fixed source inputs; checked against the complete engineering inventory.


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
    return ROOT / f'src-tauri/target/internal-candidate/2026-10-14-browser-tabs-{commit[:8]}/Farfold-0.1.7-{commit[:8]}.zip'


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


def retained_prior_run_item_evidence(path, metadata, configured):
    """Pinned actual failed P30 run; never counted as the successful current seven."""
    retained = configured['metadata']
    private_ref, public_ref = configured['privateSummary'], retained['summary']
    need(metadata == retained, 'Retained failed-run metadata differs')
    private, public = [relative(item['path']) for item in (private_ref, public_ref)]
    need(public.is_relative_to(path.parent) and private != PRIVATE_ENGINEERING,
         'Retained failed run escaped this publication or equals current run')
    for actual, expected in ((private, private_ref), (public, public_ref)):
        need(actual.stat().st_size == expected['bytes'] and sha(actual) == expected['sha256'],
             'Retained failed-run summary bytes differ')
    need(private_ref['bytes'] == public_ref['bytes'] and private_ref['sha256'] == public_ref['sha256'],
         'Retained summary original/copy differs')
    prior = read(private)
    names = ['format-check', 'typecheck', 'frontend-test', 'frontend-build', 'cargo-fmt', 'cargo-clippy', 'cargo-test']
    need(prior['schema'] == 1 and prior['phase'] == 'ACTUAL_COMMAND_RESULTS'
         and prior['allPassed'] is False and type(prior['inputCount']) is int and prior['inputCount'] > 0
         and prior['interruptedSignal'] is None and prior['launchFailed'] == prior['runnerErrors'] == []
         and all(prior[k] is True for k in ('sourceStable', 'sourceMembershipStable', 'protectedUnchanged')),
         'Retained failure/stability is outside this supported recorded-completion schema')
    need([row['name'] for row in prior['checks']] == names, 'Retained failed-run stages differ')
    completed, failed, unstarted = [], [], []
    for index, row in enumerate(prior['checks']):
        need(row['argv'] == COMMANDS[row['name']]
             and row['group'] == ('frontend' if index < 4 else 'native'), 'Retained failed-run command differs')
        if row['state'] == 'COMPLETED':
            need(row['actualStageCompletion'] is True and row['processLaunched'] is True
                 and type(row['rawExitCode']) is int and row['cwd'] == str(ROOT),
                 'Retained actual completion differs')
            completed.append(row['name'])
            if row['rawExitCode'] != 0:
                failed.append(row['name'])
        else:
            need(row['state'] == 'NOT_STARTED' and row['actualStageCompletion'] is False
                 and row['processLaunched'] is False and row['rawExitCode'] is None,
                 'Retained unstarted work was misreported')
            unstarted.append(row['name'])
    need(failed and prior['failed'] == failed and prior['notStarted'] == unstarted
         and prior['completedCount'] == prior['requiredCommandsExecuted'] == len(completed),
         'Retained failed-run counts differ')
    refs = {str(p.relative_to(ROOT)): sha(p) for p in (private, public)}
    for prefix, count in (('inputs', prior['inputCount']), ('protected', 3)):
        before, after = [private.parent / (prefix + '-' + side + '.json') for side in ('before', 'after')]
        need(read(before) == read(after) and len(read(before)) == count,
             'Retained failed-run source/protected manifests differ')
        if prefix == 'protected':
            need(read(before) == read(ENGINEERING_PLAN)['protected'], 'Retained protected baseline differs')
        for item in (before, after):
            refs[str(item.relative_to(ROOT))] = sha(item)
    return refs


def retained_prior_run_evidence(path, report):
    """All explicitly pinned original failures remain separate from current success."""
    configured = [{'privateSummary': {'path': 'output/2026-10-14-browser-tabs-integration/checks-run/summary.json', 'bytes': 6358, 'sha256': 'cf5ae2a88fd7d1834316a8876f02ba9d004fe2336be36540a033d92d79d39685'}, 'metadata': {'summary': {'path': 'docs/evidence/2026-10-09-capability-hardening/browser-tabs-checks/run-01/summary.json.raw', 'bytes': 6358, 'sha256': 'cf5ae2a88fd7d1834316a8876f02ba9d004fe2336be36540a033d92d79d39685'}, 'actualRootExitCode': 1, 'actualRootChunk': 'a9baaa', 'reason': 'Original P30 formal run 01 failed its three-second readiness guard with empty collected PTY output. The assertion did not distinguish elapsed timeout from a closed ready channel. Cause remains unresolved; the following mutex poison is secondary to the panic.'}}, {'privateSummary': {'path': 'output/2026-10-14-browser-tabs-integration/checks-run-02/summary.json', 'bytes': 6351, 'sha256': '9b830d61a4a44a7130dd7821f18af0e3128b55f34b0d38b945b09755d9236ee5'}, 'metadata': {'summary': {'path': 'docs/evidence/2026-10-09-capability-hardening/browser-tabs-checks/run-02/summary.json.raw', 'bytes': 6351, 'sha256': '9b830d61a4a44a7130dd7821f18af0e3128b55f34b0d38b945b09755d9236ee5'}, 'actualRootExitCode': 1, 'actualRootChunk': '174aac', 'reason': 'Original P30 formal run 02 failed the same readiness guard after original sources were restored. Empty collected PTY output and the subsequent poison remain original failures; passing isolated or instrumented diagnoses do not establish a repair or their cause.'}}]
    need(report.get('currentScope') == 'P30 engineering checks only; native browser pages, real Agent sharing, restart recovery and whole-plan acceptance remain separate. The reused runner raw boundary text is preserved unchanged.'
         and report.get('runHistoryBoundary') == 'The successful current P30 run is separate from every retained failed formal run listed in retainedPriorRuns. Each original result remains unchanged; isolated or instrumented diagnoses are not repairs or substitutes for formal engineering. P18 historical failures are not relabeled as P30.',
         'Retained P30 runs must preserve exact current-scope and run-history boundaries')
    need(report.get('retainedPriorRuns') == [entry['metadata'] for entry in configured],
         'Retained failed-run list or order differs')
    references = {}
    for entry, metadata in zip(configured, report['retainedPriorRuns']):
        refs = retained_prior_run_item_evidence(path, metadata, entry)
        need(not set(references).intersection(refs), 'Retained failed runs reuse a source path')
        references.update(refs)
    return references


def engineering(path, inputs):
    configured()
    need(path == ENGINEERING_PATH and sha(path) == ENGINEERING_SHA and sha(PRIVATE_ENGINEERING) == PRIVATE_ENGINEERING_SHA, 'Fresh actual-seven proof hashes differ')
    report, original = read(path), read(PRIVATE_ENGINEERING)
    need(all(report.get(k) == value for k, value in original.items()), 'Published actual-seven summary changed original semantics')
    need(set(report) <= set(original) | {'originalPrivateVerification', 'originalPublishedVerification', 'counts', 'publication', 'retainedPriorRuns', 'runHistoryBoundary', 'currentScope'}, 'Unknown publication fields')
    need(report['originalPrivateVerification'] == {'path': str(PRIVATE_ENGINEERING.relative_to(ROOT)), 'bytes': PRIVATE_ENGINEERING.stat().st_size, 'sha256': PRIVATE_ENGINEERING_SHA}, 'Original private summary reference differs')
    public_original = path.parent / 'summary.json.raw'
    need(report['originalPublishedVerification'] == {'path': str(public_original.relative_to(ROOT)), 'bytes': PRIVATE_ENGINEERING.stat().st_size, 'sha256': PRIVATE_ENGINEERING_SHA} and sha(public_original) == PRIVATE_ENGINEERING_SHA, 'Published raw original differs')
    references = retained_prior_run_evidence(path, report)
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
    need(freeze_path == ROOT / 'output/2026-10-14-browser-tabs-integration/checks-freeze-03/freeze.json' and preflight_record['passed'] is True and preflight_record['freezeSha256'] == original['freezeSha256'], 'Actual-run final freeze path/preflight differs')
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
    need(actual == (prior['candidateFiles'], prior['candidateModes']), 'Formal files/modes differ from sourcefcd7 baseline (never launched)')
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


EXPECTED_INPUT_COUNT = 2538
BASELINE_NATIVE = ROOT / 'docs/evidence/2026-10-09-capability-hardening/file-dialog-native/installed-native-scoped.json'
BASELINE_NATIVE_SHA = '663cf0983a81cd8c80fd3497d996810a1e4cb1aa0e473e2ad48c540072572a96'
PRIOR_QUIT = ROOT / 'output/2026-10-13-file-dialog-investigation/native-run/transcript-receipts/24-call_ZEZOnBmsADcKmAIHpmZgGYZ9.jsonl.raw'
PRIOR_QUIT_SHA = '580df48ae00223df3b0f5200e07160d957a15c913ec86ddb46684f531feee6ad'
PRIOR_PROCESS = ROOT / 'output/2026-10-13-file-dialog-investigation/native-run/01-final-process.json'
PRIOR_PROCESS_SHA = '4cb4a39f6f27ec99e022e7aae0145b5e4952bbad473d3e5909dd28573792398c'
GENERATED_TOOLS = ROOT / 'output/2026-10-14-browser-tabs-install-preparation/generated-tools.json'
ENGINEERING_PLAN_REL = 'output/2026-10-14-browser-tabs-integration/checks-freeze-03/freeze.json'
ENGINEERING_PLAN = ROOT / ENGINEERING_PLAN_REL
ENGINEERING_PLAN_SHA = '85b63764754d11ea39f81bfeb50cd29766d42c04121523f0618cff1425365c53'


SCOPES += ['src-tauri/test-fixtures/audio-input/']


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
    """Validate saved NEW26 provenance only; never open a database or data root."""
    values, refs = {}, {}
    for name, item in LATEST_DATA_REFS.items():
        path = relative(item['path'])
        need(sha(path) == item['sha256'] and path.stat().st_size == item['bytes'], 'Latest NEW26 metadata provenance changed')
        refs[name] = item
        if name.endswith('.json'):
            values[name] = read(path)
    capture, final, execution = [values[name] for name in ('capture-receipt-private.json', 'final-verification-private.json', 'execution.json')]
    need(capture['sourceCommit'] == final['sourceCommit'] == LAST_RUNNING_COMMIT
         and capture['phase'] == 'capturedExactBytesNotAccepted'
         and capture['sourceFirstAndBaselineStable'] is True
         and capture['sourceBefore'] == capture['sourceAfter']
         and capture['firstRawCaptureBefore'] == capture['firstRawCaptureAfter'], 'Latest NEW26 capture is incomplete')
    source, first = capture['sourceAfter'], capture['firstRawCaptureAfter']
    need(set(source) == set(first) and 'farfold.sqlite3' in source
         and set(source) <= {'farfold.sqlite3', 'farfold.sqlite3-wal', 'farfold.sqlite3-shm'}
         and all(source[n]['sha256'] == first[n]['sha256'] and source[n]['bytes'] == first[n]['bytes'] for n in source), 'Latest raw capture differs from recorded source')
    normalization = capture['backupNormalization']
    need(capture['consolidated']['sha256'] == LATEST_DATA_CONSOLIDATED_SHA
         and capture['consolidated']['bytes'] == 512000 and normalization['integrity'] == 'ok'
         and normalization['modeAfter'] == 'delete' and normalization['connectionsClosedVerified'] is True
         and normalization['sidecarsAbsentAfterClose'] is True and normalization['deletedOrMovedSidecars'] is False
         and normalization['SQLiteOpenScope'] == 'secondWorkingAndNewConsolidatedOnly', 'Latest private backup provenance differs')
    need(final['captureSha256'] == refs['capture-receipt-private.json']['sha256']
         and final['comparisonSha256'] == refs['comparison-private.json']['sha256']
         and final['result'] == 'differencesRequireReview' and final['differenceCount'] == 1
         and final['sourceFirstAndBaselineStableAtFinalCheck'] is True
         and final['finalProcess']['formalProcessCount'] == 0
         and final['finalProcess']['exactExecutableSha256'] == digest(str(FORMAL / 'Contents/MacOS/farfold').encode())
         and execution['actualExitCode'] == 2 and execution['interrupted'] is False
         and execution['noAppActionSinceFinalQuit'] is True, 'Prior strict exit 2 must remain recorded')
    config = values['config.json']
    need(config['schema'] == 6 and config['installedSourceCommit'] == LAST_RUNNING_COMMIT
         and config['noAppActionAfterFinalCorrectPs'] is True
         and config['rawQuitContextPath'] == str(QUIT_CONTEXT.relative_to(ROOT))
         and config['rawQuitContextSha256'] == QUIT_CONTEXT_SHA
         and config['rawQuitEventPath'] == str(PRIOR_QUIT.relative_to(ROOT))
         and config['rawQuitEventSha256'] == PRIOR_QUIT_SHA
         and config['rawQuitManifestPath'] == str(QUIT_MANIFEST.relative_to(ROOT))
         and config['rawQuitManifestSha256'] == QUIT_MANIFEST_SHA
         and config['exactProcessReceiptPath'] == str(PRIOR_PROCESS.relative_to(ROOT))
         and config['exactProcessReceiptSha256'] == PRIOR_PROCESS_SHA
         and capture['configSha256'] == refs['config.json']['sha256'], 'Latest capture configuration/quit chain differs')
    expected_command = ['/usr/bin/python3', '-B', 'output/2026-10-14-file-dialog-data-preparation/capture_compare.py', '--config', str(ROOT / refs['config.json']['path']), '--config-sha', refs['config.json']['sha256']]
    need(execution['command'] == expected_command
         and execution['independentReview'] == {'path': refs['adapter-review.json']['path'], 'sha256': refs['adapter-review.json']['sha256']}, 'Actual saved capture execution differs')
    for name in ('stdout.raw', 'stderr.raw'):
        need(execution['outputs'][name] == {key: refs[name][key] for key in ('bytes', 'sha256')}, 'Actual saved capture output differs')
    need(quit_timestamp(read(PRIOR_ACTUAL_PROCESS)['timestamp']) <= quit_timestamp(execution['startedAtUtc'])
         <= quit_timestamp(final['checkedAtUtc']) <= quit_timestamp(execution['completedAtUtc']), 'Latest NEW26 stage order differs')
    return {'references': refs, 'sourceFiles': {name: {'sha256': value['sha256'], 'bytes': value['bytes']} for name, value in source.items()},
            'strictExitCode': 2, 'differencesAccepted': False,
            'boundary': 'Latest closed NEW26 provenance only. Preserve capture exit2/difference1 and earlier unaccepted strict2. New installation still requires fresh full manifests and raw backup.'}


def prior_exit_evidence():
    """Validate original NEW26 save/quit23/24 and lowercase process03, never App/DB."""
    need(sha(BASELINE_NATIVE) == BASELINE_NATIVE_SHA and read(BASELINE_NATIVE)['sourceCommit'] == LAST_RUNNING_COMMIT,
         'Prior installed source record changed')
    expected = ((QUIT_CONTEXT, QUIT_CONTEXT_SHA), (PRIOR_QUIT, PRIOR_QUIT_SHA),
                (QUIT_MANIFEST, QUIT_MANIFEST_SHA), (PRIOR_PROCESS, PRIOR_PROCESS_SHA),
                (PRIOR_ACTUAL_PROCESS, PRIOR_ACTUAL_PROCESS_SHA))
    need(all(sha(p) == value for p, value in expected), 'Latest actual quit/process receipt changed')
    context, quit, manifest, process, process_source = [read(p) for p, _ in expected]
    ctx_payload, ctx_item, ctx_text = completed_quit_text(context, 'call_uuooA1Gh1QJrWmJl4RZLWkJd')
    quit_payload, quit_item, quit_text = completed_quit_text(quit, 'call_ZEZOnBmsADcKmAIHpmZgGYZ9')
    need(ctx_item['arguments']['code'] == "await pickerNativeApp.pressKey('super+q'); await pickerNativeApp.getAXState();"
         and digest(ctx_text.encode()) == 'dce4810b5f67e49bf3126ee5994ae0725502a72b2ddb6eab2f33e33050bb8a8d'
         and '196 按钮 保存并退出' in ctx_text and quit_item['arguments']['code'] == 'await pickerNativeApp.click(196);'
         and quit_text == '' and quit['timestamp'] == '2026-10-13T16:05:25.650Z', 'Actual save/quit action differs')
    need(manifest['sourceThreadId'] == ctx_payload['thread_id'] == quit_payload['thread_id'] and manifest['sourceCommit'] == LAST_RUNNING_COMMIT, 'Quit raw source thread differs')
    for event, path, pin, call_id in ((context, QUIT_CONTEXT, QUIT_CONTEXT_SHA, ctx_item['id']),
                                      (quit, PRIOR_QUIT, PRIOR_QUIT_SHA, quit_item['id'])):
        entries = [row for row in manifest['entries'] if row['path'] == str(path.relative_to(ROOT))]
        need(len(entries) == 1 and entries[0]['sha256'] == pin and entries[0]['callId'] == call_id
             and entries[0]['status'] == 'completed' and entries[0]['timestamp'] == event['timestamp'], 'Quit raw manifest differs')
    actual_ref = manifest['finalProcessExecution']
    need(actual_ref['path'] == str(PRIOR_ACTUAL_PROCESS.relative_to(ROOT))
         and actual_ref['sha256'] == PRIOR_ACTUAL_PROCESS_SHA
         and actual_ref['bytes'] == PRIOR_ACTUAL_PROCESS.stat().st_size
         and actual_ref['executionId'] == 'exec-78cdd4b8-6093-4c70-8d2d-e6fc758e3580'
         and actual_ref['exitCode'] == 0 and actual_ref['status'] == 'completed'
         and actual_ref['timestamp'] == process_source['timestamp']
         and actual_ref['receipt'] == {'path': str(PRIOR_PROCESS.relative_to(ROOT)), 'bytes': PRIOR_PROCESS.stat().st_size, 'sha256': PRIOR_PROCESS_SHA}, 'Actual process manifest differs')
    payload = process_source.get('payload', {})
    item = payload.get('item', {})
    command = item.get('command', [])
    need(process_source.get('type') == 'event_msg' and payload.get('type') == 'item_completed'
         and payload.get('thread_id') == ctx_payload['thread_id'] and item.get('type') == 'CommandExecution'
         and item.get('id') == 'exec-78cdd4b8-6093-4c70-8d2d-e6fc758e3580'
         and item.get('status') == 'completed' and type(item.get('exit_code')) is int and item['exit_code'] == 0
         and digest(json.dumps(command, separators=(',', ':')).encode()) == '384e284af82e031d300cb02b4b4d857063b13e7d038a66928dee30880c89def0'
         and command[:2] == ['/bin/zsh', '-lc'] and len(command) == 3
         and "partition(' ')[2].strip()=='" + str(FORMAL / 'Contents/MacOS/farfold') + "'" in command[2],
         'Actual lowercase executable process command differs')
    need(json.loads(item['aggregated_output']) == {'formalProcessCount': 0, 'formalFileCount': 5, 'receipt': str(PRIOR_PROCESS.relative_to(ROOT))}
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
            'latestClosedDataStage': latest_data_evidence(),
            'previousUnlaunchedInstallation': previous_installation_evidence()}


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
    need(quit_timestamp(observed['observedAtUtc']) >= quit_timestamp(read(relative(PREVIOUS_INSTALL_REFS['installed']['path']))['completedAt']), 'Fresh observation predates previous installed gate')
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
        need(original.is_relative_to(ROOT / 'output/2026-10-14-browser-tabs-integration') and public.is_relative_to(path.parent) and public.name.endswith('.raw') and public not in seen, 'Engineering publication escaped this exact run or duplicated an entry')
        need(item['original']['sha256'] == item['published']['sha256'] == sha(original) == sha(public) and item['original']['bytes'] == item['published']['bytes'] == original.stat().st_size == public.stat().st_size, 'Engineering publication raw bytes differ')
        seen.add(public)
        refs[str(original.relative_to(ROOT))] = sha(original)
        refs[str(public.relative_to(ROOT))] = sha(public)
    return refs


QUIT_CONTEXT = ROOT / 'output/2026-10-13-file-dialog-investigation/native-run/transcript-receipts/23-call_uuooA1Gh1QJrWmJl4RZLWkJd.jsonl.raw'
QUIT_CONTEXT_SHA = 'b6bb997adbea13389eab605b1b38a50b782ae9a105c04de58b063ed4bfe51d14'
QUIT_MANIFEST = ROOT / 'output/2026-10-13-file-dialog-investigation/native-run/transcript-receipts/manifest.json'
QUIT_MANIFEST_SHA = 'd4a3e377389ac349f7592ac38f112851a44a0f7410659ffc5754ea2b1ed34942'
PRIOR_ACTUAL_PROCESS = ROOT / 'output/2026-10-13-file-dialog-investigation/native-run/03-final-process-exec.jsonl.raw'
PRIOR_ACTUAL_PROCESS_SHA = '5408a88ad6cc62a7207c5a6ec55e067d3c9079df411cfd67236470b0e6f62205'
LATEST_DATA_REFS = {'execution.json': {'path': 'output/2026-10-14-file-dialog-data/execution.json', 'bytes': 980, 'sha256': '803c0790ed7ea0a39f4721241f20f2c6b68fca61cf633df475f9b33ddca89bd6'}, 'capture-receipt-private.json': {'path': 'output/2026-10-14-file-dialog-data/capture-receipt-private.json', 'bytes': 10334, 'sha256': '7de7a6ad67f60922869b6dd4aea6a128b9030a2ca6d4c65c167cd1bf2bccde99'}, 'comparison-private.json': {'path': 'output/2026-10-14-file-dialog-data/comparison-private.json', 'bytes': 3936, 'sha256': 'a087bc3a57afe2e3fa41039e702e453e7b5ccdb40d9766f5b7b24a50a42592cc'}, 'final-verification-private.json': {'path': 'output/2026-10-14-file-dialog-data/final-verification-private.json', 'bytes': 792, 'sha256': 'dba4b6ac8b53b44f5e8f4447071c67ac5b039cc6534ed893478ec27fa259efd8'}, 'config.json': {'path': 'output/2026-10-14-file-dialog-data/config.json', 'bytes': 1321, 'sha256': '43356564b8c568dd0a30456c6d0207378df31635b6bc5abe00c9211cbe5f207e'}, 'stdout.raw': {'path': 'output/2026-10-14-file-dialog-data/stdout.raw', 'bytes': 93, 'sha256': '69f6e60483803dc5a06e45ed88cee6140936c57be9139f63fa673badd4c01ec3'}, 'stderr.raw': {'path': 'output/2026-10-14-file-dialog-data/stderr.raw', 'bytes': 0, 'sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}, 'adapter-review.json': {'path': 'output/2026-10-14-file-dialog-data-independent/adapter-review.json', 'bytes': 5912, 'sha256': '5e32b1c9f2e5331b6b440d5da04c4966d825daf9725a39599ebca4ed9c56b285'}}
LATEST_DATA_CONSOLIDATED_SHA = 'a70054804a5399ff5a1e38157d6008987c9c0e6218545545f3b3089f42b4cc24'
INVENTORY_PATH = ROOT / 'output/2026-10-14-browser-tabs-integration/inventory-plan-03.json'
INVENTORY_SHA = 'a3c5edb78b4a9ff1a192ad365a76e3d317e556d2dc28ff452ac5c304a33e364e'






INPUT_SCOPE_READY = True

LAST_RUNNING_COMMIT = '9c278d82c758176370efea8a7a17a8d2ab0bf697'
PREVIOUS_INSTALL_REFS = {'candidate': {'path': 'docs/evidence/2026-10-09-capability-hardening/diff-summary-candidate/candidate.json', 'bytes': 77341, 'sha256': '0d97f25bdea66bb111287343a5fb63d2575da93842bb3a276cd459b32422bdc9'}, 'candidateIndependent': {'path': 'docs/evidence/2026-10-09-capability-hardening/diff-summary-candidate/candidate-independent.json', 'bytes': 3060, 'sha256': '23d53fcd82e23ac2982cc0a0c2298e2d3ace628f4a7d73ffdc4c527a2d48dc19'}, 'inputs': {'path': 'docs/evidence/2026-10-09-capability-hardening/diff-summary-candidate/candidate-inputs.json', 'bytes': 251385, 'sha256': '3255b7c9ac6ec71e6cfc260c2a56bca8675946103c3a9366d6ac8223a38098e7'}, 'installed': {'path': 'docs/evidence/2026-10-09-capability-hardening/diff-summary-candidate/install-independent-final.json', 'bytes': 114708, 'sha256': '034446261d20db459a9999ea787d3edcb4341f4d4ed69d29c28e96503ad67900'}, 'operation': {'path': 'output/2026-10-14-diff-summary-install/install-operation.json', 'bytes': 3492, 'sha256': '06f7fbf36952d295557d3026616743e0959dca59ec35c0560d642e32c96fc811'}, 'backup': {'path': 'output/2026-10-14-diff-summary-install/metadata-backup-receipt.json', 'bytes': 1358, 'sha256': '668eb02c4bb457c1b3a93243be4e62a2df844d314e3c868e2d5e1ce09cca0afc'}, 'normal': {'path': 'output/2026-10-14-diff-summary-install/normal-exit-observation.json', 'bytes': 11196, 'sha256': 'c7763270157abf51ec818869cd940480d9b57c91adf39d7c68b56fcd3a7224b8'}, 'tools': {'path': 'output/2026-10-14-diff-summary-install-preparation/generated-tools.json', 'bytes': 5920, 'sha256': '6d91cdb295bb40deffb61852f11cf1b9408bd4a194fe06beb90cb5106a799a03'}, 'privateInstalled': {'path': 'output/2026-10-14-diff-summary-independent-install/install-final-review.json', 'bytes': 114495, 'sha256': 'dd81ec30d69ea25dc3042e2a1d63ad52f9229e1cb1c14dd21ed366686657b490'}, 'beforeSummary': {'path': 'output/2026-10-14-diff-summary-install/install-data-before-summary.json', 'bytes': 419, 'sha256': 'e42f5ce73eb58a4ebf1ab1f83d727d92ebf66949d9afb09c754aaf3c9d0498af'}, 'beforeExecution': {'path': 'output/2026-10-14-diff-summary-install/snapshot-before-execution.json', 'bytes': 620, 'sha256': '74dce120278ecbd4cebffd1347797afd103822b6ba041a096f1e10fac8c53fa9'}, 'preinstallSummary': {'path': 'output/2026-10-14-diff-summary-install/install-data-preinstall-summary.json', 'bytes': 419, 'sha256': 'e42f5ce73eb58a4ebf1ab1f83d727d92ebf66949d9afb09c754aaf3c9d0498af'}, 'preinstallExecution': {'path': 'output/2026-10-14-diff-summary-install/snapshot-preinstall-execution.json', 'bytes': 624, 'sha256': 'ac7dc8415cefb430e79b055e3808a71e49049bd8dfd6aa2a73e3647f76ec4075'}, 'afterSummary': {'path': 'output/2026-10-14-diff-summary-install/install-data-after-summary.json', 'bytes': 419, 'sha256': 'e42f5ce73eb58a4ebf1ab1f83d727d92ebf66949d9afb09c754aaf3c9d0498af'}, 'afterExecution': {'path': 'output/2026-10-14-diff-summary-install/snapshot-after-execution.json', 'bytes': 619, 'sha256': 'be36af355ed67fffa3e8f2bd1171ebd1e1dd7ca7011d49a9a1d7d28790c31493'}}
PREVIOUS_MANIFEST_SHA = 'eb77d4255cab06d3096378b2123365a9555c97e23aef3cf5b264185c504b6849'

def previous_installation_evidence():
    """Read saved fcd7 installation evidence; the last running App was still 9c.

    No process query, DB bytes, SQLite, current data manifest, or App operation.
    Original 10-check proof binds the saved manifests; fresh captures remain required.
    """
    values, refs = {}, {}
    for name, item in PREVIOUS_INSTALL_REFS.items():
        path = relative(item['path'])
        need(path.suffix == '.json' and sha(path) == item['sha256']
             and path.stat().st_size == item['bytes'], 'Previous installation evidence changed')
        values[name], refs[name] = read(path), item
    candidate, checked, independent, operation, backup, normal, tools = [values[k] for k in (
        'candidate', 'installed', 'candidateIndependent', 'operation', 'backup', 'normal', 'tools')]
    need(candidate['sourceCommit'] == checked['sourceCommit'] == independent['sourceCommit']
         == operation['candidateCommit'] == backup['sourceCommit'] == normal['sourceCommit']
         == tools['sourceCommit'] == BASELINE_COMMIT != LAST_RUNNING_COMMIT,
         'Installed source and last-running source must be distinct')
    need(candidate['phase'] == 'internalCandidatePreparedNotInstalled' and candidate['buildExitCode'] == 0
         and candidate['sourceMatchesCommitBeforeAndAfter'] is True
         and len(values['inputs']) == candidate['sourceInputCount'] == PREVIOUS_INPUT_COUNT,
         'Previous candidate source/build proof differs')
    for report, count in ((independent, 9), (checked, 10)):
        need(report['result'] == 'passed' and report['failures'] == []
             and len(report['checks']) == count
             and all(row['passed'] is True for row in report['checks'].values()),
             'Previous candidate/installed proof incomplete')
    need(independent['inputReceipts']['candidateJsonSha256'] == refs['candidate']['sha256']
         and independent['inputReceipts']['candidateInputsJsonSha256'] == refs['inputs']['sha256']
         and operation['receiptHashes'] == {name: refs[key]['sha256'] for name, key in (
             ('candidate', 'candidate'), ('inputs', 'inputs'), ('independent', 'candidateIndependent'))},
         'Previous source/candidate receipts differ')
    need(operation['phase'] == 'installedVerifiedNotLaunched' and operation['installed'] is True
         and operation['copyStarted'] is True and operation['launched'] is False
         and operation['realAgentInvoked'] is False and operation['onlyFormalAppReplaced'] is True
         and operation['installedExactFiveFiles'] is True
         and operation['formalAppProcessesBefore'] == operation['formalAppProcessesAfter'] == 0
         and operation['installedFiles'] == candidate['candidateFiles']
         and checked['checks']['candidateFormalFiveFiles']['files'] == candidate['candidateFiles']
         and checked['checks']['candidateFormalFiveFiles']['modes'] == candidate['candidateModes'],
         'Previous installation was not the saved unlaunched candidate')
    need(all(values['privateInstalled'][key] == checked[key] for key in values['privateInstalled']
             if key != 'refs') and refs['privateInstalled'] in checked['refs'],
         'Actual private/public installed proof differs')
    summaries = []
    for phase in ('before', 'preinstall', 'after'):
        summary, execution = values[phase + 'Summary'], values[phase + 'Execution']
        need(set(summary) == {'counts', 'sha256'} and summary['sha256'] == PREVIOUS_MANIFEST_SHA
             and sum(sum(counts.values()) for counts in summary['counts'].values()) == 217400
             and type(execution['exitCode']) is int and execution['exitCode'] == 0
             and execution['stderr'] == '' and json.loads(execution['stdout']) == summary,
             'Previous actual snapshot capture differs')
        need(execution['argv'][1:] == [str(ROOT / 'output/2026-10-14-diff-summary-install/install_data_snapshot.py'),
                                      phase, '--normal-window-close-observed'],
             'Previous snapshot command differs')
        manifest_path = 'output/2026-10-14-diff-summary-install/install-data-' + phase + '.jsonl'
        matched = [row for row in checked['refs'] if row['path'] == manifest_path]
        need(len(matched) == 1 and matched[0]['sha256'] == PREVIOUS_MANIFEST_SHA
             and matched[0]['bytes'] == operation['beforeSnapshot']['rawBytes'],
             'Previous installed proof manifest binding differs')
        summaries.append(summary)
    need(summaries[0] == summaries[1] == summaries[2]
         and checked['checks']['retainedDataEquality'] == {
             'passed': True, 'allThreeManifestsEqual': True, 'entriesEach': 217400, 'sha256': PREVIOUS_MANIFEST_SHA}
         and operation['beforeSnapshot']['counts'] == summaries[0]['counts']
         and operation['beforeSnapshot']['sha256'] == PREVIOUS_MANIFEST_SHA
         and operation['beforeSnapshot']['summarySha256'] == refs['preinstallSummary']['sha256'],
         'Previous three-manifest equality differs')
    stage = latest_data_evidence()
    need(backup['backupSha256'] == LATEST_DATA_CONSOLIDATED_SHA
         and backup['sourceAndCaptureUnchanged'] is True and backup['integrity'] == 'ok'
         and backup['sourceBeforeManifestSha256'] == PREVIOUS_MANIFEST_SHA
         and backup['capturedFiles'] == {name: row['sha256'] for name, row in stage['sourceFiles'].items()}
         and operation['privateBackup']['receiptSha256'] == refs['backup']['sha256']
         and operation['privateBackup']['backupSha256'] == LATEST_DATA_CONSOLIDATED_SHA,
         'Previous backup does not retain the sealed NEW26 bytes')
    normalization = backup['backupNormalization']
    need(normalization['integrity'] == 'ok' and normalization['modeAfter'] == 'delete'
         and normalization['SQLiteOpenScope'] == 'secondWorkingAndNewConsolidatedOnly'
         and normalization['connectionsClosedVerified'] is True
         and normalization['sidecarsAbsentAfterClose'] is True
         and normalization['deletedOrMovedSidecars'] is False, 'Previous backup normalization differs')
    need(normal['originalNormalExit'] == {'path': str(PRIOR_QUIT.relative_to(ROOT)), 'sha256': PRIOR_QUIT_SHA}
         and normal['rootConfirmedNoAppRestartSincePriorQuit'] is True and normal['newQuitPerformed'] is False
         and normal['latestClosedDataStage'] == stage and backup['normalExitSha256'] == refs['normal']['sha256'],
         'Previous install continuity differs from actual last-running 9c')
    need(tools['phase'] == 'fullyConfiguredForVerifiedInstallBeforeAppMutation'
         and tools['notYetKnownPins'] == [] and len(tools['tools']) == 9,
         'Previous tool seal incomplete')
    for tool in tools['tools']:
        path = relative(tool['path'])
        need(path.suffix == '.py' and sha(path) == tool['sha256'], 'Previous executed tool changed')
        refs['tool:' + path.name] = {'path': tool['path'], 'bytes': path.stat().st_size, 'sha256': tool['sha256']}
    need(quit_timestamp(read(PRIOR_QUIT)['timestamp']) <= quit_timestamp(normal['observedAtUtc'])
         <= quit_timestamp(operation['startedAtUtc']) <= quit_timestamp(operation['completedAtUtc'])
         <= quit_timestamp(checked['completedAt']), 'Previous install chronology differs')
    return {'installedSourceCommit': BASELINE_COMMIT, 'lastRunningSourceCommit': LAST_RUNNING_COMMIT,
            'installedButNotLaunchedAtRecordedGate': True, 'references': refs,
            'savedThreeManifestSha256': PREVIOUS_MANIFEST_SHA, 'savedBackupSha256': LATEST_DATA_CONSOLIDATED_SHA,
            'boundary': 'Saved fcd7 installation over last-running 9c, not a fabricated fcd7 quit. Root must confirm no later restart and obtain fresh exact process absence, captures, backup, and three-manifest equality.'}




PREVIOUS_INPUT_COUNT = 2059





TOP = ['.prettierignore', 'docs/architecture.md', 'docs/evidence/2026-10-09-capability-hardening/README.md', 'docs/evidence/2026-10-09-capability-hardening/attachment-archive/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-archive/backend/canonical-wire.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-content-search/backend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-content-search/frontend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-content-search/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/attachment-content-search/independent/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/backend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/frontend/publication.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/audio-input/independent/publication.json', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/baseline-v2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/baseline.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-01/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-01/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-01/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-02/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-02/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-02/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-03/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-03/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/browser-regression-03/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/fmt-check-01/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/fmt-check-01/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/fmt-check-01/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/fmt-check-02/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/fmt-check-02/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/fmt-check-02/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-01/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-01/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-01/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-02/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-02/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-02/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-03/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-03/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/format-write-03/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/green-01/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/green-01/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/green-01/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/handoff-v2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/handoff.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/interface.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/red-01/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/red-01/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/red-01/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-green-01/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-green-01/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-green-01/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-green-02/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-green-02/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-green-02/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-red-01/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-red-01/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-red-01/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-red-02/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-red-02/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/review-red-02/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/run_check.py.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/run_check_v2.py.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/source-freeze-v2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/source-freeze.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/source-v2.diff.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/backend/source.diff.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v1/fixture.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v1/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v1/transport.ts.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v2/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v2/transport.ts.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v3/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v4/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v4/transport.ts.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v5/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v6/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v6/transport.ts.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/authored-v7/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/bidirectional-retention-preparation.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run1.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run2-narrow-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run2-three-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run3.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run4.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run5.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run6.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run7.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run8-narrow-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run8-three-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run8.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run9-narrow-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run9-three-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/chromium-run9.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/diagnostic-before/fixture.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/diagnostic-before/transport.ts.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/diagnostic-cleanup.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/diagnostic-used/fixture.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/diagnostic-used/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/diagnostic-used/transport.ts.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/fixture.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/index.html.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/page-oracle.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/pages/a.html.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/pages/b.html.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/pages/c.html.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/port-before.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/preparation-v2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/preparation-v3.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/preparation-v4.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/preparation-v5.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/preparation-v6.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/preparation-v7.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/preparation.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/root-verification-final-v5.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/root-verification-final.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/root-verification.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/serve.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/server-owned-2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/server-owned-3.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/server-owned.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/server-stop-request.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/server-stopped-2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/server-stopped-3.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/server-stopped.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-diagnostics/chromium-run6-16298.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-diagnostics/chromium-run7-16334.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-diagnostics/manifest.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-final-v5/chromium-run9-16646.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-final-v5/manifest.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-final-v5/server-3-16658.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-final-v5/webkit-run5-16645.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-final/chromium-run8-16485.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-final/manifest.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-final/server-2-16516.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-final/webkit-run4-16488.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/chromium-run1-15760.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/chromium-run2-15855.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/chromium-run3-15976.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/chromium-run4-16027.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/chromium-run5-16174.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/manifest.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/webkit-run1-15883.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/webkit-run2-15975.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-history/webkit-run3-16021.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-receipts/manifest.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-receipts/record-16017.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-receipts/record-16021.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-receipts/record-16027.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-receipts/record-16039.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transcript-receipts/record-16058.jsonl.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/transport.ts.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run1.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run3.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run4-narrow-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run4-three-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run4.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run5-narrow-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run5-three-pages.png', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/browser/webkit-run5.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/App.navigation.route-order-v3.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/App.route-order-v3.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/BrowserWorkspace.presentation-v4.test.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/BrowserWorkspace.visual-v2.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/BrowserWorkspacePage.guard-v4.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/BrowserWorkspacePage.presentation-v3.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/browser-run1-navigation-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-01.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-01.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-01.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-02.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-02.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-02.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v2.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v2.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v2.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v5.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v5.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-check-v5.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-final.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-final.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-final.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-v2.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-v2.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-v2.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-write-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-write-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/format-write-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/guard-resume-green-v5.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/guard-resume-green-v5.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/guard-resume-green-v5.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/guard-resume-red-v5.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/guard-resume-red-v5.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/guard-resume-red-v5.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/hidden-close-red.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/hidden-close-red.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/hidden-close-red.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/hidden-select-red.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/hidden-select-red.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/hidden-select-red.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-green-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-green-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-green-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-investigation-v4.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-red-02-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-red-02-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-red-02-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-red-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-red-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/presentation-red-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/red-01.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/red-01.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/red-01.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/route-order-green-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/route-order-green-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/route-order-green-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/route-order-hypothesis-v4.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/route-order-red-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/route-order-red-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/route-order-red-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/run.py.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/source-before-v4.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/source-freeze-v2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/source-freeze-v3.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/source-freeze-v4.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/source-freeze-v5.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/source-freeze.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/source-v3-to-v4.diff.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/source-v4-to-v5.diff.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/summary-v2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/summary-v3.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/summary-v4.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/summary-v5.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/summary.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-01.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-01.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-01.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-02.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-02.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-02.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-03.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-03.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-03.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-04.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-04.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-04.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-final-before.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-final.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-final.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-final.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-v2.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-v2.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-v2.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/targeted-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-01.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-01.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-01.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-final.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-final.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-final.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v2.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v2.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v2.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v4.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v4.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v4.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v5.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v5.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/typecheck-v5.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-check-v3.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-check-v3.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-check-v3.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-v3.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-v3.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-v3.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-write-v3.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-write-v3.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-format-write-v3.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-targeted-v3.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-targeted-v3.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-targeted-v3.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-typecheck-v3.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-typecheck-v3.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-typecheck-v3.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/frontend/visual-v2-to-v3.diff.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/backend-v2-source-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/browser-driver-v3-static-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/browser-driver-v4-static-supplement.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/browser-preparation-static-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/browser-run1-attribution-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/browser-selector-and-boundary-supplement.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/browser-v4-final-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/browser-v5-final-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/cross-task-retention-cause-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/cross-task-retention-open-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/frontend-v2-source-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/frontend-v3-visual-delta-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/frontend-v4-source-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/frontend-v5-source-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/independent/original-138-completion-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/publication.json', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/research/manual-oracle-v1.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/research/manual-oracle-v2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/research/revision-v2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/browser-tabs/verification.json', 'docs/evidence/2026-10-09-capability-hardening/claude-history/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/diff-summary/publication.json', 'docs/evidence/2026-10-09-capability-hardening/diff-summary/verification.json', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/01-unicode-lists.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/02-table-images-stories.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/03-sections.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/expectations.json', 'docs/evidence/2026-10-09-capability-hardening/docx-content-search/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/docx-content-search/publication.json', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/fixtures/oracle.json', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/fixtures/repeated-locations.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/hidden-notice-boundaries.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/nested-choice-fallback.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/oracle-supplement.json', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/supported-choice-markers.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/window-boundaries.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-feedback/independent/window-oracle.json', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/active-object.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/complete.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/image-empty-note.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/literal-marker.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/oracle.json', 'docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/partial-hidden.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-input/make-fixtures.py', 'docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg', 'docs/evidence/2026-10-09-capability-hardening/extension-inventory/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/history-search/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/history-search/backend/final-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/copy-status-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-add/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-http-add/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-management/backend/final-wire.json', 'docs/evidence/2026-10-09-capability-hardening/mcp-remove/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/pdf-input/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/baseline.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/before/src-tauri/src/file_delivery.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/before/src-tauri/src/file_delivery/pdf_input.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/before/src-tauri/src/file_delivery_commands.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/before/src-tauri/src/lib.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/format-check/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/format-check/started.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/format-check/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/format-check/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/green-pdf-capture/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/green-pdf-capture/started.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/green-pdf-capture/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/green-pdf-capture/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/green-pdf-command/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/green-pdf-command/started.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/green-pdf-command/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/green-pdf-command/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-analysis.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-search-limit/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-search-limit/started.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-search-limit/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-search-limit/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-source/src-tauri/src/file_delivery.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-source/src-tauri/src/file_delivery/pdf_input.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-source/src-tauri/src/file_delivery/pdf_search_command_tests.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-source/src-tauri/src/file_delivery/pdf_search_tests.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-source/src-tauri/src/file_delivery_commands.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/red-source/src-tauri/src/lib.rs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/regression-read-pool/completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/regression-read-pool/started.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/regression-read-pool/stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/regression-read-pool/stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/run_check.py.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/source-freeze.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/backend/source.diff.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/captures.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run1-failure.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run1.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run2-failure.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run2-pdf-results.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run2-source-location.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run2.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run3-pdf-results.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run3-source-location.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/chromium-run3.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/dependency-reload-correction.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/fixture.tsx.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/index.html.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/input-provenance.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/no-text-assertion-correction.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/pre-run-corrections.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/run-before-no-text-assertion.mjs.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/run-prefix.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/run-tail.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/run.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/scenarios.mjs.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/serve-before-pdf-preload.mjs.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/serve.mjs.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/server-stop-request.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/webkit-run1-pdf-results.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/webkit-run1-source-location.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/browser/webkit-run1.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/finalize-failure.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/finalize-success.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/finalize-v1.py.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/finalize.py.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/finalizer-correction.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/fixture-provenance.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/format-01.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/format-01.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/format-01.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/format-final.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/format-final.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/format-final.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/red-01.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/red-01.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/red-01.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/route-green-01.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/route-green-01.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/route-green-01.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/run.py.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/source-freeze-v1.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/summary.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-02.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-02.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-02.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-03.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-03.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-03.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-final.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-final.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/targeted-final.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/format-01.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/format-final.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/manifest.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/red-01.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/route-green-01.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/targeted-02.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/targeted-03.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/targeted-final.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/transcript-receipts/typecheck-01.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/typecheck-01.completed.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/typecheck-01.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/frontend/typecheck-01.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/backend-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/browser-preparation-review-supplement.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/browser-preparation-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/browser-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/fixture-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/frontend-evidence-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/frontend-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/inventory-adapter-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/review-final-receipts.py.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/transcript-browser/chromium-run1.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/transcript-browser/chromium-run2.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/transcript-browser/chromium-run3.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/transcript-browser/dependency-reload-observation.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/transcript-browser/manifest.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/transcript-browser/server-stop.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/transcript-browser/webkit-run1.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/independent/verify-authored-fixtures.py.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/publication.json', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/authoring-validation.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/consent-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixture-freeze.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixture-summary.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixture-transcript-receipts/authoring-validation.completed.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixture-transcript-receipts/generation.completed.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixture-transcript-receipts/manifest.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixture-transcript-receipts/marker.completed.jsonl.raw.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixtures/07-page-item-barriers.pdf', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixtures/08-unicode-preservation.pdf', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixtures/09-terminal-page-damaged.pdf', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixtures/authoring-oracle.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/fixtures/hand-authored-textitems.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/generate_search_fixtures.py.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/handoff.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/legacy-provenance.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/raw-content/07-page-item-barriers-page1.bin.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/raw-content/07-page-item-barriers-page2.bin.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/raw-content/08-unicode-preservation-glyph.bin.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/raw-content/08-unicode-preservation-page1.bin.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/raw-content/08-unicode-preservation-to-unicode.bin.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/raw-content/09-terminal-page-damaged-page1.bin.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/raw-content/09-terminal-page-damaged-page2.bin.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/raw-content/09-terminal-page-damaged-page3-invalid.bin.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/07-page-item-barriers-1.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/07-page-item-barriers-2.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/07-page-item-barriers.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/07-page-item-barriers.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/08-unicode-preservation-1.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/08-unicode-preservation.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/08-unicode-preservation.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/09-terminal-page-damaged-1.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/09-terminal-page-damaged-2.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/09-terminal-page-damaged-3.png', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/09-terminal-page-damaged.stderr.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/renders/09-terminal-page-damaged.stdout.log.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/source-review.json.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/research/verify_authoring.py.raw', 'docs/evidence/2026-10-09-capability-hardening/pdf-search/verification.json', 'docs/evidence/2026-10-09-capability-hardening/project-file-selection/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/screenshot-unavailable/implementation.json', 'docs/evidence/2026-10-09-capability-hardening/skill-management/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/skills-inventory/backend/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/oracle.json', 'docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/positions-v1-nonordinal-ids.xlsx', 'docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/positions-v1.xlsx', 'docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/positions-v2.xlsx', 'docs/evidence/2026-10-09-capability-hardening/worktree-preparation/backend/preparation-wire.json', 'docs/evidence/2026-10-09-capability-hardening/worktree-remove/cold-recovery-fix/actual-wire.json', 'docs/evidence/2026-10-09-capability-hardening/xlsx-input-candidate/installed-native-scoped.json', 'docs/evidence/2026-10-09-capability-hardening/xlsx-search/publication.json', 'docs/evidence/2026-10-09-capability-hardening/xlsx-search/verification.json', 'docs/status.md', 'index.html', 'output/2026-10-13-attachment-search-frontend/browser/fixture.tsx', 'output/2026-10-13-attachment-search-frontend/browser/index.html', 'output/2026-10-13-attachment-search-frontend/browser/run.mjs', 'output/2026-10-13-attachment-search-frontend/browser/serve.mjs', 'output/2026-10-13-xlsx-input-checks-preparation/inventory.py', 'output/2026-10-13-xlsx-input-checks-preparation/runner-v4/run_checks.py', 'output/2026-10-14-audio-cancel-test-race/source-freeze.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/completed.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/conclusion.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/diagnostic-observations.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/original-sources.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/preparation.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/preparation_actions_tests.rs.original.raw', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/preparation_actions_tests.rs.patch', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/pty.rs.original.raw', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/pty.rs.patch', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/source-restored.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/started.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/stderr.log', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-02/stdout.log', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/completed.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/conclusion.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/diagnostic-observations.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/original-sources.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/preparation.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/preparation_actions_tests.rs.original.raw', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/preparation_actions_tests.rs.patch', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/pty.rs.original.raw', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/pty.rs.patch', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/source-restored.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/started.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/stderr.log', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic-03/stdout.log', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/command-completed.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/completed.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/conclusion.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/diagnostic-observations.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/diagnostic.patch', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/original-source.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/preparation.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/preparation_actions_tests.rs.original.raw', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/source-after-diagnostic.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/source-before.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/source-restored.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/started.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/stderr.log', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/stdout.log', 'output/2026-10-14-browser-tabs-backend/pty-ready-diagnostic/summary.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-probe/completed.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-probe/source-after.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-probe/source-before.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-probe/started.json', 'output/2026-10-14-browser-tabs-backend/pty-ready-probe/stderr.log', 'output/2026-10-14-browser-tabs-backend/pty-ready-probe/stdout.log', 'output/2026-10-14-browser-tabs-backend/source-freeze-v2.json', 'output/2026-10-14-browser-tabs-backend/source-freeze-v3.json', 'output/2026-10-14-browser-tabs-backend/source-v3-test-only.diff', 'output/2026-10-14-browser-tabs-backend/v3-readiness-review.json', 'output/2026-10-14-browser-tabs-browser/fixture.tsx', 'output/2026-10-14-browser-tabs-browser/index.html', 'output/2026-10-14-browser-tabs-browser/page-oracle.json', 'output/2026-10-14-browser-tabs-browser/pages/a.html', 'output/2026-10-14-browser-tabs-browser/pages/b.html', 'output/2026-10-14-browser-tabs-browser/pages/c.html', 'output/2026-10-14-browser-tabs-browser/root-verification-final-v5.json', 'output/2026-10-14-browser-tabs-browser/run.mjs', 'output/2026-10-14-browser-tabs-browser/serve.mjs', 'output/2026-10-14-browser-tabs-browser/transport.ts', 'output/2026-10-14-browser-tabs-frontend/publication-selection-v2.json', 'output/2026-10-14-browser-tabs-frontend/publish-evidence.py', 'output/2026-10-14-browser-tabs-frontend/source-freeze-v5.json', 'output/2026-10-14-browser-tabs-independent/backend-v2-source-review.json', 'output/2026-10-14-browser-tabs-independent/browser-v5-final-review.json', 'output/2026-10-14-browser-tabs-independent/checkpoint-selector-static-review.json', 'output/2026-10-14-browser-tabs-independent/engineering-workflow-v3-static-review.json', 'output/2026-10-14-browser-tabs-independent/failed-engineering-02-review.json', 'output/2026-10-14-browser-tabs-independent/failed-engineering-review.json', 'output/2026-10-14-browser-tabs-independent/frontend-v5-source-review.json', 'output/2026-10-14-browser-tabs-independent/implementation-publisher-static-review.json', 'output/2026-10-14-browser-tabs-independent/inventory-command-02-prepared.json', 'output/2026-10-14-browser-tabs-independent/inventory-command-03-prepared.json', 'output/2026-10-14-browser-tabs-independent/pty-diagnostic-02-review.json', 'output/2026-10-14-browser-tabs-independent/pty-diagnostic-restoration-review.json', 'output/2026-10-14-browser-tabs-independent/pty-fixture-and-docs-review.json', 'output/2026-10-14-browser-tabs-independent/pty-read-error-static-review.json', 'output/2026-10-14-browser-tabs-independent/seven-check-publisher-static-review.json', 'output/2026-10-14-browser-tabs-independent/seven-check-publisher-v2-static-review.json', 'output/2026-10-14-browser-tabs-independent/transcript-pty-diagnostic-02/command-completed.jsonl.raw', 'output/2026-10-14-browser-tabs-independent/transcript-pty-diagnostic-02/manifest.json', 'output/2026-10-14-browser-tabs-independent/transcript-pty-diagnostic-02/tool-completed.jsonl.raw', 'output/2026-10-14-browser-tabs-independent/transcript-seven-failed-02/manifest.json', 'output/2026-10-14-browser-tabs-independent/transcript-seven-failed-02/seven-check-command-completed.jsonl.raw', 'output/2026-10-14-browser-tabs-independent/transcript-seven-failed-02/seven-check-tool-output.jsonl.raw', 'output/2026-10-14-browser-tabs-independent/transcript-seven-failed/manifest.json', 'output/2026-10-14-browser-tabs-independent/transcript-seven-failed/seven-check-command-completed.jsonl.raw', 'output/2026-10-14-browser-tabs-independent/transcript-seven-failed/seven-check-tool-output.jsonl.raw', 'output/2026-10-14-browser-tabs-integration/checkpoint-argv-03-prepared.json', 'output/2026-10-14-browser-tabs-integration/checks-freeze-02/freeze.json', 'output/2026-10-14-browser-tabs-integration/checks-freeze/freeze.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-clippy/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-clippy/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-clippy/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-clippy/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-fmt/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-fmt/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-fmt/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-fmt/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-test/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-test/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-test/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/cargo-test/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/events.jsonl', 'output/2026-10-14-browser-tabs-integration/checks-run-02/format-check/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/format-check/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/format-check/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/format-check/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/frontend-build/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/frontend-build/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/frontend-build/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/frontend-build/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/frontend-test/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/frontend-test/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/frontend-test/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/frontend-test/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/inputs-after.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/inputs-before.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/preflight.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/protected-after.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/protected-before.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/summary.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/typecheck/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/typecheck/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run-02/typecheck/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run-02/typecheck/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-clippy/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-clippy/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-clippy/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-clippy/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-fmt/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-fmt/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-fmt/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-fmt/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-test/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-test/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-test/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run/cargo-test/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run/events.jsonl', 'output/2026-10-14-browser-tabs-integration/checks-run/format-check/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run/format-check/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run/format-check/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run/format-check/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run/frontend-build/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run/frontend-build/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run/frontend-build/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run/frontend-build/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run/frontend-test/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run/frontend-test/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run/frontend-test/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run/frontend-test/stdout.log', 'output/2026-10-14-browser-tabs-integration/checks-run/inputs-after.json', 'output/2026-10-14-browser-tabs-integration/checks-run/inputs-before.json', 'output/2026-10-14-browser-tabs-integration/checks-run/preflight.json', 'output/2026-10-14-browser-tabs-integration/checks-run/protected-after.json', 'output/2026-10-14-browser-tabs-integration/checks-run/protected-before.json', 'output/2026-10-14-browser-tabs-integration/checks-run/summary.json', 'output/2026-10-14-browser-tabs-integration/checks-run/typecheck/completed.json', 'output/2026-10-14-browser-tabs-integration/checks-run/typecheck/started.json', 'output/2026-10-14-browser-tabs-integration/checks-run/typecheck/stderr.log', 'output/2026-10-14-browser-tabs-integration/checks-run/typecheck/stdout.log', 'output/2026-10-14-browser-tabs-integration/prepare_checkpoint.py', 'output/2026-10-14-browser-tabs-integration/prepare_inventory.py', 'output/2026-10-14-browser-tabs-integration/publication-byte-verification.json', 'output/2026-10-14-browser-tabs-integration/publish_checks-v2-to-v3.diff', 'output/2026-10-14-browser-tabs-integration/publish_checks-v2.py', 'output/2026-10-14-browser-tabs-integration/publish_checks-v3.py', 'output/2026-10-14-browser-tabs-integration/publish_checks.py', 'output/2026-10-14-browser-tabs-integration/workflow-v3-preparation.json', 'output/2026-10-14-browser-tabs-research/manual-oracle-v2.json', 'output/2026-10-14-browser-tabs-research/revision-v2.json', 'output/2026-10-14-diff-summary-browser/fixture.tsx', 'output/2026-10-14-diff-summary-browser/index.html', 'output/2026-10-14-diff-summary-browser/run.mjs', 'output/2026-10-14-diff-summary-browser/serve.mjs', 'output/2026-10-14-diff-summary-frontend/oracle-correction.json', 'output/2026-10-14-diff-summary-frontend/oracle-v2.json', 'output/2026-10-14-diff-summary-frontend/post-full-suite-correction.json', 'output/2026-10-14-diff-summary-frontend/run.py', 'output/2026-10-14-diff-summary-frontend/source-freeze-v2.json', 'output/2026-10-14-diff-summary-independent/browser-oracle.json', 'output/2026-10-14-diff-summary-independent/browser-review.json', 'output/2026-10-14-diff-summary-independent/docs/report.json', 'output/2026-10-14-diff-summary-independent/frontend-final-review.json', 'output/2026-10-14-diff-summary-independent/test-only-browser-equivalence.json', 'output/2026-10-14-diff-summary-independent/verify-line-diff-oracle.mjs', 'output/2026-10-14-diff-summary-integration/prepare_checkpoint-v2.py', 'output/2026-10-14-diff-summary-integration/prepare_inventory-v3.py', 'output/2026-10-14-diff-summary-integration/publish_checks-v2.py', 'output/2026-10-14-diff-summary-integration/root-source-review.json', 'output/2026-10-14-diff-summary-research/oracle.json', 'output/2026-10-14-docx-search-backend/source-freeze.json', 'output/2026-10-14-docx-search-browser/author.docx', 'output/2026-10-14-docx-search-browser/budget-a.docx', 'output/2026-10-14-docx-search-browser/budget-b.docx', 'output/2026-10-14-docx-search-browser/budget-captures.json', 'output/2026-10-14-docx-search-browser/budget-oracle.json', 'output/2026-10-14-docx-search-browser/captures.json', 'output/2026-10-14-docx-search-browser/fixture.tsx', 'output/2026-10-14-docx-search-browser/generate-budget.py', 'output/2026-10-14-docx-search-browser/generate-fixtures.py', 'output/2026-10-14-docx-search-browser/index.html', 'output/2026-10-14-docx-search-browser/oracle.json', 'output/2026-10-14-docx-search-browser/run-v1.mjs', 'output/2026-10-14-docx-search-browser/run-v2.mjs', 'output/2026-10-14-docx-search-browser/run.mjs', 'output/2026-10-14-docx-search-browser/second.docx', 'output/2026-10-14-docx-search-browser/serve.mjs', 'output/2026-10-14-docx-search-doc-closeout/report.json', 'output/2026-10-14-docx-search-frontend/source-freeze-v2.json', 'output/2026-10-14-docx-search-independent/backend-review.json', 'output/2026-10-14-docx-search-independent/frontend-browser-supplement.json', 'output/2026-10-14-docx-search-independent/frontend-source-review.json', 'output/2026-10-14-docx-search-independent/image-and-cell-barriers.docx', 'output/2026-10-14-docx-search-independent/publication-review.json', 'output/2026-10-14-docx-search-independent/supplement-capture.json', 'output/2026-10-14-docx-search-independent/supplement-oracle.json', 'output/2026-10-14-docx-search-integration/publish_implementation.py', 'output/2026-10-14-docx-search-integration/reviewed-files-v2.json', 'output/2026-10-14-docx-search-integration/reviewed-files.json', 'output/2026-10-14-pdf-search-backend/run_check.py', 'output/2026-10-14-pdf-search-backend/source-freeze.json', 'output/2026-10-14-pdf-search-browser/captures.json', 'output/2026-10-14-pdf-search-browser/fixture.tsx', 'output/2026-10-14-pdf-search-browser/index.html', 'output/2026-10-14-pdf-search-browser/input-provenance.json', 'output/2026-10-14-pdf-search-browser/run.mjs', 'output/2026-10-14-pdf-search-browser/serve.mjs', 'output/2026-10-14-pdf-search-docs/report.json', 'output/2026-10-14-pdf-search-frontend/run.py', 'output/2026-10-14-pdf-search-frontend/source-freeze-v1.json', 'output/2026-10-14-pdf-search-independent/backend-review.json', 'output/2026-10-14-pdf-search-independent/browser-review.json', 'output/2026-10-14-pdf-search-independent/frontend-evidence-review.json', 'output/2026-10-14-pdf-search-independent/frontend-review.json', 'output/2026-10-14-pdf-search-integration/prepare_inventory.py', 'output/2026-10-14-pdf-search-integration/publish_checks.py', 'output/2026-10-14-pdf-search-integration/publish_implementation.py', 'output/2026-10-14-pdf-search-research/fixtures/authoring-oracle.json', 'output/2026-10-14-xlsx-search-backend/run_check.py', 'output/2026-10-14-xlsx-search-backend/source-freeze.json', 'output/2026-10-14-xlsx-search-browser/author.xlsx', 'output/2026-10-14-xlsx-search-browser/budget-a.xlsx', 'output/2026-10-14-xlsx-search-browser/budget-b.xlsx', 'output/2026-10-14-xlsx-search-browser/budget-captures.json', 'output/2026-10-14-xlsx-search-browser/budget-oracle.json', 'output/2026-10-14-xlsx-search-browser/captures.json', 'output/2026-10-14-xlsx-search-browser/fixture.tsx', 'output/2026-10-14-xlsx-search-browser/generate-fixtures.py', 'output/2026-10-14-xlsx-search-browser/index.html', 'output/2026-10-14-xlsx-search-browser/oracle.json', 'output/2026-10-14-xlsx-search-browser/run.mjs', 'output/2026-10-14-xlsx-search-browser/second.xlsx', 'output/2026-10-14-xlsx-search-browser/serve.mjs', 'output/2026-10-14-xlsx-search-frontend/run.py', 'output/2026-10-14-xlsx-search-frontend/source-freeze-v1.json', 'output/2026-10-14-xlsx-search-independent/captures.json', 'output/2026-10-14-xlsx-search-independent/decoding-fields.xlsx', 'output/2026-10-14-xlsx-search-independent/fixture-freeze.json', 'output/2026-10-14-xlsx-search-independent/generate-supplement.py', 'output/2026-10-14-xlsx-search-independent/hidden-only.xlsx', 'output/2026-10-14-xlsx-search-independent/oracle.json', 'output/2026-10-14-xlsx-search-independent/scope-barriers.xlsx', 'output/2026-10-14-xlsx-search-independent/verify-fixtures.py', 'output/2026-10-14-xlsx-search-integration/prepare_checkpoint.py', 'output/2026-10-14-xlsx-search-integration/prepare_inventory.py', 'output/2026-10-14-xlsx-search-integration/publish_checks.py', 'output/2026-10-14-xlsx-search-integration/publish_implementation.py', 'package.json', 'plans/agent-access.md', 'pnpm-lock.yaml', 'src-tauri/Cargo.lock', 'src-tauri/Cargo.toml', 'src-tauri/Info.plist', 'src-tauri/build.rs', 'src-tauri/examples/windows_process_fixture.rs', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json', 'src-tauri/testdata/signed-update-metadata.json', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts']

if __name__ == '__main__':
    sys.exit(main())
