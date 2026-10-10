"""Prepare and verify the exact committed candidate. Never install or quit apps."""
from pathlib import Path
import hashlib
import json
import plistlib
import re
import stat
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
if len(sys.argv) != 3 or not re.fullmatch(r"[0-9a-f]{40}", sys.argv[1]):
    raise RuntimeError("Pass exact committed 40-character SHA and current engineering receipt path")
EXPECTED = sys.argv[1]
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
ARCHIVE = ROOT / f'src-tauri/target/internal-candidate/2026-10-10-{EXPECTED[:8]}/Farfold-0.1.7-{EXPECTED[:8]}.zip'
RECEIPT = OUT / 'candidate.json'
SCOPES = ['src/', 'assets/', 'public/', 'scripts/', 'src-tauri/src/', 'src-tauri/native/', 'src-tauri/capabilities/', 'src-tauri/icons/', 'src-tauri/resources/', 'docs/evidence/2026-10-09-capability-hardening/docx-fixtures/', 'docs/evidence/2026-10-09-capability-hardening/docx/public-samples/']
TOP = ['docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/copy-status-wire.json', 'docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg', '.prettierignore', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/01-unicode-lists.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/02-table-images-stories.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/03-sections.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/expectations.json', 'index.html', 'package.json', 'pnpm-lock.yaml', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/Info.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json']

TOP += ['docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/' + name for name in ('positions-v1.xlsx', 'positions-v2.xlsx', 'positions-v1-nonordinal-ids.xlsx', 'oracle.json')]
TOP += ['docs/evidence/2026-10-09-capability-hardening/docx-feedback/' + name for name in ('fixtures/repeated-locations.docx', 'fixtures/oracle.json', 'independent/supported-choice-markers.docx', 'independent/nested-choice-fallback.docx', 'independent/hidden-notice-boundaries.docx', 'independent/oracle-supplement.json', 'independent/window-boundaries.docx', 'independent/window-oracle.json')]
SCOPES += ['docs/evidence/2026-10-09-capability-hardening/workbook-range/fixtures/']
SCOPES += ['docs/evidence/2026-10-09-capability-hardening/visual-area/fixtures/']
TOP += ['src-tauri/examples/windows_process_fixture.rs', 'src-tauri/testdata/signed-update-metadata.json']
BASELINE_COMMIT = '8780df9effd3832c1d73a494e8b447f91a2949b8'
BASELINE_RECEIPT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/worktree-task-candidate/candidate.json'

ENGINEERING_ROOT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/worktree-recycle-checks'
engineering_argument = Path(sys.argv[2]) if len(sys.argv) == 3 else Path('missing-engineering-receipt')
if engineering_argument.is_absolute() or '..' in engineering_argument.parts:
    raise RuntimeError('Pass an engineering receipt path relative to the checkout')
ENGINEERING_RECEIPT = ROOT / engineering_argument
if not ENGINEERING_RECEIPT.is_relative_to(ENGINEERING_ROOT):
    raise RuntimeError('Engineering receipt must belong to worktree-recycle-checks')


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
        entries.update(str(p.relative_to(ROOT)) for p in (ROOT / name).rglob('*') if p.is_file() and p.name != '.DS_Store' and '__pycache__' not in p.parts)
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



def verify_engineering(current):
    def must(condition, message):
        if not condition:
            raise RuntimeError(message)
    def evidence_path(name):
        path = Path(name)
        must(not path.is_absolute() and ".." not in path.parts, "Invalid engineering reference")
        path = ROOT / path
        must(path.is_file() and not path.is_symlink(), "Engineering reference is not a regular file")
        return path
    final_path = ENGINEERING_RECEIPT
    must(final_path.is_file() and not final_path.is_symlink(), "Engineering receipt is missing")
    final = json.loads(final_path.read_text())
    must(final.get("allPassed") is True and final.get("sourceStable") is True and final.get("protectedUnchanged") is True, "Engineering checks are incomplete")
    must(final.get("inputCount") == len(current), "Engineering inventory count differs")
    expected_commands = {
        "format": ["corepack", "pnpm", "format:check"],
        "typecheck": ["corepack", "pnpm", "typecheck"],
        "frontend": ["corepack", "pnpm", "test"],
        "build": ["corepack", "pnpm", "build"],
        "cargo-fmt": ["cargo", "fmt", "--check", "--manifest-path", "src-tauri/Cargo.toml"],
        "clippy": ["cargo", "clippy", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--", "-D", "warnings"],
        "rust": ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"],
    }
    checks = final.get("checks", [])
    must(len(checks) == 7 and {c["name"] for c in checks} == set(expected_commands), "Engineering requires all seven actual commands")
    refs = {final_path: sha(final_path)}
    for check in checks:
        path = evidence_path(check["log"])
        must(check.get("executedInThisRun") is True and check["argv"] == expected_commands[check["name"]], "Unexpected reused or partial engineering command")
        must(check["exitCode"] == 0 and sha(path) == check["sha256"], "Engineering log failed or changed")
        refs[path] = check["sha256"]
    inventory_paths = []
    for key, filename in (("inputsBefore", "inputs-before.json"), ("inputsAfter", "inputs-after.json")):
        reference = final.get(key)
        if reference is not None:
            path = evidence_path(reference["path"])
            must(sha(path) == reference["sha256"], "Engineering inventory reference changed")
        else:
            path = final_path.parent / filename
            must(path.is_file() and not path.is_symlink(), "Raw run inventory missing")
        must(path.is_relative_to(ENGINEERING_ROOT), "Inventory outside current engineering evidence")
        must(json.loads(path.read_text()) == current, "Engineering inventory differs from candidate inputs")
        inventory_paths.append(path)
        refs[path] = sha(path)
    closure_paths = [p for p in (final_path.parent / "source-closure.json", final_path.parent.parent / "source-closure.json") if p.is_file()]
    must(len(closure_paths) == 1, "Missing or ambiguous source closure")
    closure_path = closure_paths[0]
    must(closure_path == ENGINEERING_ROOT / "source-closure.json", "Unexpected closure location")
    closure = json.loads(closure_path.read_text())
    previous_path = BASELINE_RECEIPT.parent / "candidate-inputs.json"
    previous = json.loads(previous_path.read_text())
    must(json.loads(BASELINE_RECEIPT.read_text())["sourceCommit"] == BASELINE_COMMIT, "Installed baseline receipt differs")
    delta = {p for p in set(previous) | set(current) if previous.get(p) != current.get(p)}
    must(closure["priorInstalledCommit"] == BASELINE_COMMIT, "Source closure uses wrong installed baseline")
    must(set(closure["files"]) == delta and closure["fileCount"] == len(delta), "Source closure omits or adds changed inputs")
    for name, item in closure["files"].items():
        must(name in current and current[name] == item["sha256"], "Source closure hash differs")
        lines = len((ROOT / name).read_text().splitlines())
        must(lines == item["lines"] <= 1500, "Source closure line count/limit differs")
    protected = {
        "docs/evidence/2026-10-08-reliability-ui-review/README.md": "2a2a3127cc0e97e62ff64eaf067033c37af6878dc7d32fcfa67dd19dbafc2d45",
        "docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md": "f2d6cedc87d969d63d17507c85c6f5abd7424a7a3edb9cfcd940520553429cd7",
    }
    must(closure["protectedUnchanged"] == protected, "Protected evidence baseline differs")
    for name, expected in protected.items():
        path = ROOT / name
        must(sha(path) == expected, "Protected evidence changed")
        refs[path] = expected
    must(isinstance(closure.get("proofs"), list) and closure["proofs"], "Source closure lacks supporting receipts")
    for proof in closure["proofs"]:
        path = evidence_path(proof["path"])
        must(sha(path) == proof["sha256"], "Source closure proof changed")
        refs[path] = proof["sha256"]
    refs[closure_path] = sha(closure_path)
    refs[previous_path] = sha(previous_path)
    refs[BASELINE_RECEIPT] = sha(BASELINE_RECEIPT)
    return ({"receipt": str(final_path.relative_to(ROOT)), "sha256": sha(final_path),
             "inputs": str(inventory_paths[0].relative_to(ROOT)), "inputsSha256": sha(inventory_paths[0]),
             "inputsAfter": str(inventory_paths[1].relative_to(ROOT)), "inputsAfterSha256": sha(inventory_paths[1]),
             "sourceClosure": str(closure_path.relative_to(ROOT)), "sourceClosureSha256": sha(closure_path),
             "inputCount": len(current)}, refs)


if any(path.exists() for path in (RECEIPT, APP, ARCHIVE, OUT / 'candidate-inputs.json', OUT / 'checks/candidate-build.txt')):
    raise RuntimeError('Candidate destination already exists; will not overwrite it')
# Acquire this run's receipt exclusively. Failed preflight must not replace old evidence.
receipt_handle = RECEIPT.open('x')
record = {'sourceCommit': EXPECTED, 'startedAt': datetime.now(timezone.utc).isoformat(), 'formalAppReplaced': False, 'installed': False, 'realAgentInvoked': False, 'command': 'corepack pnpm tauri:build:internal'}
try:
    if run(['git', 'rev-parse', 'HEAD']) != EXPECTED:
        raise RuntimeError('HEAD differs from requested commit')
    original_formal = files(FORMAL)
    baseline = json.loads(BASELINE_RECEIPT.read_text())
    assert baseline['sourceCommit'] == BASELINE_COMMIT and baseline['candidateFiles'] == original_formal, 'Formal application is not the expected installed baseline'
    record['formalBaseline'] = {'sourceCommit': BASELINE_COMMIT, 'receipt': str(BASELINE_RECEIPT.relative_to(ROOT)), 'sha256': sha(BASELINE_RECEIPT)}
    before = source()
    engineering, engineering_refs = verify_engineering(before)
    record['engineeringVerification'] = engineering
    with (OUT / 'candidate-inputs.json').open('x') as inputs_handle:
        inputs_handle.write(json.dumps(before, indent=2) + '\n')
    record['sourceInputCount'] = len(before)
    record['sourceScope'] = {'directories': SCOPES, 'files': TOP, 'claim': 'Application source/configuration inputs and tests in those scopes, including committed DOCX, workbook rectangle and visual-area fixtures, Rust example/testdata and their frozen reference images; exactly matches the current worktree archive/restore engineering inventory; excluding dependencies/toolchain and other rendered references'}
    (OUT / 'checks').mkdir(exist_ok=True)
    with (OUT / 'checks/candidate-build.txt').open('x') as log:
        result = subprocess.run(['corepack', 'pnpm', 'tauri:build:internal'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    record['buildExitCode'] = result.returncode
    if result.returncode:
        raise RuntimeError('Internal candidate build failed')
    if source() != before or run(['git', 'rev-parse', 'HEAD']) != EXPECTED:
        raise RuntimeError('Source changed during build')
    assert verify_engineering(before) == (engineering, engineering_refs)
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
