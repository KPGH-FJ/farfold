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
EXPECTED = sys.argv[1] if len(sys.argv) in (2, 3) else ""
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
ENGINEERING_RECEIPT = ROOT / engineering_argument

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
        disk.update(str(path.relative_to(ROOT)) for path in (ROOT / scope).rglob('*') if path.is_file() and path.name != '.DS_Store' and '__pycache__' not in path.parts)
    require(set(inputs) == set(tracked) == disk, 'Application source inventory differs')
    for name, oid in tracked.items():
        path = ROOT / name
        regular(path)
        raw = path.read_bytes()
        actual_oid = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        require(actual_oid == oid, 'Source differs from committed blob: ' + name)
        require(hashlib.sha256(raw).hexdigest() == inputs[name], 'Source differs from candidate input receipt: ' + name)
    return {'inputCount': len(inputs), 'scope': 'Application source/configuration and tests; dependencies and toolchain not claimed'}



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


def main():
    require(len(sys.argv) == 3, 'Pass exact commit and current engineering receipt path')
    require(not engineering_argument.is_absolute() and '..' not in engineering_argument.parts and ENGINEERING_RECEIPT.is_relative_to(ENGINEERING_ROOT), 'Invalid current engineering receipt path')
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
            archive_path = ROOT / f'src-tauri/target/internal-candidate/2026-10-10-{EXPECTED[:8]}/Farfold-0.1.7-{EXPECTED[:8]}.zip'
            require(candidate['sourceCommit'] == EXPECTED and candidate['phase'] == 'internalCandidatePreparedNotInstalled', 'Candidate is not a completed preparation for this commit')
            require(candidate['buildExitCode'] == 0 and candidate['installed'] is False and candidate['formalAppReplaced'] is False, 'Candidate preparation claims unexpected effects')
            require(candidate['candidateApp'] == str(APP) and candidate['archive'] == str(archive_path), 'Candidate artifact path differs')
            record['inputReceipts'] = {'candidateJsonSha256': sha(candidate_path), 'candidateInputsJsonSha256': sha(inputs_path)}
            record['checks'][stage] = {'passed': True}

            stage = 'exactSource'
            source_result = verify_source(inputs)
            require(candidate['sourceInputCount'] == source_result['inputCount'], 'Recorded source count differs')
            engineering, engineering_refs = verify_engineering(inputs)
            require(candidate['engineeringVerification'] == engineering, 'Candidate engineering proof differs')
            record['engineeringVerification'] = engineering
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
            baseline = read_json(BASELINE_RECEIPT)
            require(baseline['sourceCommit'] == BASELINE_COMMIT and candidate['formalFiles'] == baseline['candidateFiles'], 'Formal baseline differs from the prior installed candidate')
            require(candidate['formalBaseline'] == {'sourceCommit': BASELINE_COMMIT, 'receipt': str(BASELINE_RECEIPT.relative_to(ROOT)), 'sha256': sha(BASELINE_RECEIPT)}, 'Formal baseline receipt differs')
            require(bundle_files(FORMAL) == candidate['formalFiles'], 'Formal application changed since preparation')
            record['checks'][stage] = {'passed': True, 'formalAppReplaced': False}

            stage = 'verificationInputsStable'
            verify_source(inputs)
            require(bundle_files(APP) == actual_files and bundle_files(FORMAL) == candidate['formalFiles'], 'Application files changed during verification')
            require(sha(candidate_path) == record['inputReceipts']['candidateJsonSha256'] and sha(inputs_path) == record['inputReceipts']['candidateInputsJsonSha256'], 'Input receipts changed during verification')
            require(all(sha(p) == h for p, h in engineering_refs.items()), 'Engineering referenced inputs changed during verification')
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
