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
EXPECTED = sys.argv[1] if len(sys.argv) == 2 else ""
SCOPES = ['src/', 'assets/', 'public/', 'scripts/', 'src-tauri/src/', 'src-tauri/native/', 'src-tauri/capabilities/', 'src-tauri/icons/', 'src-tauri/resources/', 'docs/evidence/2026-10-09-capability-hardening/docx-fixtures/', 'docs/evidence/2026-10-09-capability-hardening/docx/public-samples/']
TOP = ['docs/evidence/2026-10-09-capability-hardening/large-file-segments/text-block-wire.json', 'docs/evidence/2026-10-09-capability-hardening/large-file-segments/copy-status-wire.json', 'docs/evidence/2026-10-09-capability-hardening/docx/browser/authored-portrait.jpg', '.prettierignore', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/01-unicode-lists.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/02-table-images-stories.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/03-sections.docx', 'docs/evidence/2026-10-09-capability-hardening/docx-compatibility/expectations.json', 'index.html', 'package.json', 'pnpm-lock.yaml', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/Info.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json']

TOP += ['docs/evidence/2026-10-09-capability-hardening/workbook-feedback/fixtures/' + name for name in ('positions-v1.xlsx', 'positions-v2.xlsx', 'positions-v1-nonordinal-ids.xlsx', 'oracle.json')]
TOP += ['docs/evidence/2026-10-09-capability-hardening/docx-feedback/' + name for name in ('fixtures/repeated-locations.docx', 'fixtures/oracle.json', 'independent/supported-choice-markers.docx', 'independent/nested-choice-fallback.docx', 'independent/hidden-notice-boundaries.docx', 'independent/oracle-supplement.json', 'independent/window-boundaries.docx', 'independent/window-oracle.json')]

SCOPES += ['docs/evidence/2026-10-09-capability-hardening/workbook-range/fixtures/']
SCOPES += ['docs/evidence/2026-10-09-capability-hardening/visual-area/fixtures/']
TOP += ['src-tauri/examples/windows_process_fixture.rs', 'src-tauri/testdata/signed-update-metadata.json']
BASELINE_COMMIT = '394bb91af050c5944cc479c40f62e9559a367560'
BASELINE_RECEIPT = ROOT / 'docs/evidence/2026-10-09-capability-hardening/reported-files-candidate/candidate.json'
ENGINEERING = ROOT / 'docs/evidence/2026-10-09-capability-hardening/browser-search-checks'
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


def verify_test_format_followup(inputs, final, closure):
    changed = 'src/runtime/loaded_search_dom.test.tsx'
    followup = final['testFormattingFollowup']
    require(followup['path'] == changed, 'Unexpected test formatting followup')
    refs = {}
    for kind in ('frontend', 'rust'):
        folder = ENGINEERING / (kind + '-final')
        group_path = folder / (kind + '-verification.json')
        group = read_json(group_path)
        before_path = folder / (kind + '-inputs.json')
        after_path = folder / (kind + '-inputs-after.json')
        before, after = read_json(before_path), read_json(after_path)
        require(group['allPassed'] is True and group['sourceStable'] is True and before == after, 'Reused check group was not stable and successful')
        require(group['inputCount'] == len(before), 'Reused group inventory count differs')
        for path in (group_path, before_path, after_path):
            refs[path] = sha(path)
        for check in group['checks']:
            require(check['exitCode'] == 0 and sha(ROOT / check['log']) == check['sha256'], 'Reused group log differs')
            require(any(c['name'] == check['name'] and c['log'] == check['log'] and c['sha256'] == check['sha256'] and c['executedInThisRun'] is False for c in final['checks']), 'Final group reuse attribution differs')
            refs[ROOT / check['log']] = check['sha256']
        if kind == 'rust':
            require(before == {p: h for p, h in inputs.items() if not p.startswith('src/') or '/fixtures/' in p}, 'Rust inputs changed since successful full checks')
        else:
            require({p for p in set(before) | set(inputs) if before.get(p) != inputs.get(p)} == {changed}, 'Frontend reuse includes changes beyond the reformatted test')
            old_path = ENGINEERING / 'loaded_search_dom.test.tsx.before-format.txt'
            require(sha(old_path) == before[changed] == followup['beforeSha256'], 'Original test bytes differ')
            require(inputs[changed] == followup['afterSha256'], 'Final test bytes differ')
            refs[old_path] = before[changed]
    detail = closure['testFormatOnlyFollowup']
    require(detail['path'] == changed and detail['before']['sha256'] == followup['beforeSha256'] and detail['after']['sha256'] == followup['afterSha256'], 'Source closure formatting attribution differs')
    for name in ('equivalence', 'targeted'):
        check = followup[name]
        path = ROOT / check['log']
        require(check['exitCode'] == 0 and sha(path) == check['sha256'], 'Formatting followup check did not pass or changed')
        refs[path] = check['sha256']
    equivalent = read_json(ROOT / followup['equivalence']['log'])
    require(equivalent['syntaxTreeAndLeafTextEqual'] is True, 'No successful syntax and leaf-text comparison')
    require(followup['targeted']['argv'] == ['corepack', 'pnpm', 'exec', 'vitest', 'run', changed], 'Targeted test command differs')
    prior_path = ENGINEERING / 'final-verification-first-format-failure.json'
    require(final['priorFailedAggregate'] == {'path': str(prior_path.relative_to(ROOT)), 'sha256': sha(prior_path)}, 'Original failed aggregate differs')
    prior = read_json(prior_path)
    require(prior['allPassed'] is False and [c['name'] for c in prior['checks'] if c['exitCode'] != 0] == ['format'], 'Original format-only failure attribution differs')
    for check in prior['checks']:
        path = ROOT / check['log']
        require(sha(path) == check['sha256'], 'Original aggregate log changed')
        refs[path] = check['sha256']
    for receipt in prior['groups'] + prior['priorRuns'] + [prior['inputsBefore'], prior['inputsAfter']]:
        path = ROOT / receipt['path']
        require(sha(path) == receipt['sha256'], 'Original aggregate input or group changed')
        refs[path] = receipt['sha256']
    refs[prior_path] = final['priorFailedAggregate']['sha256']
    return refs


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
            archive_path = ROOT / f'src-tauri/target/internal-candidate/2026-10-10-{EXPECTED[:8]}/Farfold-0.1.7-{EXPECTED[:8]}.zip'
            require(candidate['sourceCommit'] == EXPECTED and candidate['phase'] == 'internalCandidatePreparedNotInstalled', 'Candidate is not a completed preparation for this commit')
            require(candidate['buildExitCode'] == 0 and candidate['installed'] is False and candidate['formalAppReplaced'] is False, 'Candidate preparation claims unexpected effects')
            require(candidate['candidateApp'] == str(APP) and candidate['archive'] == str(archive_path), 'Candidate artifact path differs')
            record['inputReceipts'] = {'candidateJsonSha256': sha(candidate_path), 'candidateInputsJsonSha256': sha(inputs_path)}
            record['checks'][stage] = {'passed': True}

            stage = 'exactSource'
            source_result = verify_source(inputs)
            require(candidate['sourceInputCount'] == source_result['inputCount'], 'Recorded source count differs')
            final_path = ENGINEERING / 'final-verification.json'
            final = read_json(final_path)
            require(final['allPassed'] is True and final['sourceStable'] is True and final['protectedUnchanged'] is True, 'Engineering checks are incomplete')
            require(final['inputCount'] == len(inputs) and len(final['checks']) == 7, 'Engineering input/check count differs')
            require({c['name'] for c in final['checks']} == {'frontend', 'typecheck', 'build', 'format', 'cargo-fmt', 'clippy', 'rust'}, 'Engineering check set differs')
            engineering_refs = {}
            for check in final['checks']:
                require(check['exitCode'] == 0 and sha(ROOT / check['log']) == check['sha256'], 'Engineering check log differs')
                engineering_refs[ROOT / check['log']] = check['sha256']
            final_inputs_path = ROOT / final['inputsBefore']['path']
            after_inputs_path = ROOT / final['inputsAfter']['path']
            require(final_inputs_path == ENGINEERING / 'inputs-final.json' and after_inputs_path == ENGINEERING / 'inputs-final-after.json', 'Engineering inventory path differs')
            for path, receipt in ((final_inputs_path, final['inputsBefore']), (after_inputs_path, final['inputsAfter'])):
                require(sha(path) == receipt['sha256'] and read_json(path) == inputs, 'Engineering source differs from candidate')
                engineering_refs[path] = receipt['sha256']
            closure_path = ENGINEERING / 'source-closure.json'
            closure = read_json(closure_path)
            require(final['sourceClosure'] == {'path': str(closure_path.relative_to(ROOT)), 'sha256': sha(closure_path)}, 'Final source closure receipt differs')
            engineering_refs.update(verify_test_format_followup(inputs, final, closure))
            previous = read_json(BASELINE_RECEIPT.parent / 'candidate-inputs.json')
            delta = {p for p in set(previous) | set(inputs) if previous.get(p) != inputs.get(p)}
            require(closure['priorInstalledCommit'] == BASELINE_COMMIT, 'Source closure baseline differs')
            require(delta == set(closure['files']) and len(delta) == closure['fileCount'], 'Source closure is not the exact complete input delta')
            for path, item in closure['files'].items():
                require(inputs.get(path) == item['sha256'] and len((ROOT / path).read_text().splitlines()) == item['lines'] <= 1500, 'Source closure hashes/line limits differ')
            for proof in closure['proofs']:
                path = ROOT / proof['path']
                require(sha(path) == proof['sha256'], 'Source closure evidence differs')
                engineering_refs[path] = proof['sha256']
            protected = {
                'docs/evidence/2026-10-08-reliability-ui-review/README.md': '2a2a3127cc0e97e62ff64eaf067033c37af6878dc7d32fcfa67dd19dbafc2d45',
                'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md': 'f2d6cedc87d969d63d17507c85c6f5abd7424a7a3edb9cfcd940520553429cd7',
            }
            require(closure['protectedUnchanged'] == protected and all(sha(ROOT / p) == h for p, h in protected.items()), 'Protected review files differ')
            engineering_refs.update({ROOT / p: h for p, h in protected.items()})
            engineering = {'receipt': str(final_path.relative_to(ROOT)), 'sha256': sha(final_path),
                           'inputs': str(final_inputs_path.relative_to(ROOT)), 'inputsSha256': sha(final_inputs_path),
                           'sourceClosure': str(closure_path.relative_to(ROOT)), 'sourceClosureSha256': sha(closure_path), 'inputCount': len(inputs)}
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
            require(sha(final_path) == engineering['sha256'] and sha(final_inputs_path) == engineering['inputsSha256'] and sha(closure_path) == engineering['sourceClosureSha256'], 'Engineering receipts changed during verification')
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
