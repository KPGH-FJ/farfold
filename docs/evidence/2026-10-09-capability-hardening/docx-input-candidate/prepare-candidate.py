"""Build exactly one candidate; never install, quit or start an application.
Usage: python3 prepare-candidate.py <40-character commit> <engineering.json>
The adjacent verifier is import-safe and owns the small, shared read-only checks.
"""
import importlib.util
from pathlib import Path
import subprocess
import sys
import zipfile

sys.dont_write_bytecode = True


spec = importlib.util.spec_from_file_location('candidate_checks', Path(__file__).with_name('verify-candidate.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def main():
    commit, proof = v.arguments()
    archive = v.archive_path(commit)
    inputs_path = v.OUT / 'candidate-inputs.json'
    after_path = v.OUT / 'candidate-inputs-after.json'
    log = v.OUT / 'checks/candidate-build.txt'
    v.need(not any(p.exists() or p.is_symlink() for p in (v.APP, archive, inputs_path, after_path, log)), 'Candidate destination exists; preserve it and use a new audited run')
    record = {'sourceCommit': commit, 'startedAt': v.now(), 'phase': 'failed', 'formalAppReplaced': False, 'installed': False, 'realAgentInvoked': False, 'command': ' '.join(v.BUILD)}
    with v.exclusive(v.OUT / 'candidate.json') as output:
        try:
            formal = v.baseline()
            record['formalBaseline'] = {'sourceCommit': v.BASELINE_COMMIT, 'receipt': str(v.BASELINE.relative_to(v.ROOT)), 'sha256': v.BASELINE_SHA}
            record['formalFiles'], record['formalModes'] = formal
            before = v.source(commit)
            proof_record = v.engineering(proof, before)
            record['engineeringVerification'] = proof_record
            record['sourceInputCount'] = len(before)
            record['sourceScope'] = {'directories': v.SCOPES, 'files': v.TOP, 'claim': 'Exact commit source/configuration/tests and scoped fixtures; dependencies/toolchain and native acceptance excluded'}
            with v.exclusive(inputs_path) as handle:
                v.save(handle, before)
            log.parent.mkdir(exist_ok=True)
            with v.exclusive(log) as handle:
                result = subprocess.run(v.BUILD, cwd=v.ROOT, stdout=handle, stderr=subprocess.STDOUT)
            record['buildExitCode'] = result.returncode
            record['buildLogSha256'] = v.sha(log)
            v.need(result.returncode == 0, 'Internal candidate build failed; raw log retained')
            after = v.source(commit)
            with v.exclusive(after_path) as handle:
                v.save(handle, after)
            v.need(after == before and v.engineering(proof, after) == proof_record, 'Build source/evidence drift')
            record['sourceMatchesCommitBeforeAndAfter'] = True
            record.update(v.identity())
            record['architecture'] = v.run(['lipo', '-archs', str(v.APP / 'Contents/MacOS/farfold')])
            v.need(record['architecture'] == 'arm64', 'Wrong architecture')
            record.update(v.signature())
            record['signature'] = 'ad-hoc; not notarized or public distribution signed'
            files, modes = v.bundle(v.APP)
            record.update(candidateApp=str(v.APP), candidateFiles=files, candidateModes=modes)
            archive.parent.mkdir(parents=True, exist_ok=True)
            v.regular(archive.parent, True)
            # Exclusive ZIP, regular files only, preserving exact Unix permission modes.
            # Parent directories are implicit; no resource-fork or other ignored payloads.
            with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as z:
                for name in sorted(files):
                    z.write(v.APP / name, 'Farfold.app/' + name)
            record.update(archive=str(archive), **v.zip_matches(archive, files, modes))
            v.need(v.bundle(v.APP) == (files, modes) and v.baseline() == formal, 'Candidate or formal app changed')
            v.need(v.source(commit) == before and v.engineering(proof, before) == proof_record, 'Final source/evidence drift')
            record.update(phase='internalCandidatePreparedNotInstalled', formalFilesUnchanged=True, archiveMatchesBundle=True)
        except Exception as error:
            record['error'] = str(error)
        finally:
            record['completedAt'] = v.now()
            v.save(output, record)
    print(v.json.dumps({'phase': record['phase'], 'receipt': str(v.OUT / 'candidate.json')}))
    return 0 if record['phase'] == 'internalCandidatePreparedNotInstalled' else 1


if __name__ == '__main__':
    sys.exit(main())
