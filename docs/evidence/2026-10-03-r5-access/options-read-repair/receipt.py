"""Record repository inputs and four formal app files; never read user data."""

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
BASELINE = OUT.parent / 'default-choice-repair'


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manifest(base, paths):
    files = {str(path.relative_to(base)): sha256(path) for path in sorted(paths)}
    return {
        'summary': {
            'files': len(files),
            'manifestSha256': hashlib.sha256(
                json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
            ).hexdigest(),
        },
        'files': files,
    }


stage = sys.argv[1]
if stage not in ('before', 'after'):
    raise SystemExit('Use before or after; this script does not build or install.')

paths = set()
for folder in [
    'assets', 'public', 'src', 'src-tauri/src', 'src-tauri/icons',
    'src-tauri/capabilities', 'src-tauri/resources',
]:
    paths.update(path for path in (ROOT / folder).rglob('*') if path.is_file())
paths.update(ROOT / name for name in [
    'index.html', 'package.json', 'pnpm-lock.yaml', 'src-tauri/Cargo.lock',
    'src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json',
    'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts',
])
source = manifest(ROOT, paths)
prior = json.loads((BASELINE / 'source-after-build.json').read_text())['files']
source['scopeSinceInstalledCandidate'] = {
    'changed': sorted(name for name in prior if name in source['files'] and prior[name] != source['files'][name]),
    'added': sorted(set(source['files']) - set(prior)),
    'removed': sorted(set(prior) - set(source['files'])),
}

app = Path('/Applications/Farfold.app')
formal = manifest(app, [app / name for name in [
    'Contents/Info.plist', 'Contents/MacOS/farfold',
    'Contents/Resources/release-manifest.json', 'Contents/_CodeSignature/CodeResources',
]])
prior_app = json.loads((BASELINE / 'built-bundle.json').read_text())['files']
formal['matchesInstalledCandidate'] = formal['files'] == prior_app
signature = subprocess.run(
    ['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app)],
    capture_output=True, text=True,
)
formal['signature'] = {'exitCode': signature.returncode, 'output': signature.stderr.strip()}
result = {
    'at': datetime.now(timezone.utc).isoformat(),
    'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'source': source,
    'formal': formal,
    'duplicateBundleAbsent': not (ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app').exists(),
    'frontendOnly': True,
    'appBuiltOrInstalled': False,
}
if stage == 'after':
    before = json.loads((OUT / 'source-before-build.json').read_text())
    result['sourceInputsUnchangedByFrontendBuild'] = before['source']['files'] == source['files']
    result['formalFilesUnchangedDuringTask'] = before['formal']['files'] == formal['files']
target = OUT / ('source-' + stage + '-build.json')
target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({
    'receipt': target.name,
    'source': source['summary'],
    'scope': source['scopeSinceInstalledCandidate'],
    'formalMatchesInstalledCandidate': formal['matchesInstalledCandidate'],
    'signatureExitCode': signature.returncode,
    'duplicateBundleAbsent': result['duplicateBundleAbsent'],
    'sourceInputsUnchangedByFrontendBuild': result.get('sourceInputsUnchangedByFrontendBuild'),
    'formalFilesUnchangedDuringTask': result.get('formalFilesUnchangedDuringTask'),
}, ensure_ascii=False))
if not formal['matchesInstalledCandidate'] or signature.returncode:
    raise SystemExit('Formal application differs or signature check failed.')
if stage == 'after' and not (
    result['sourceInputsUnchangedByFrontendBuild'] and result['formalFilesUnchangedDuringTask']
):
    raise SystemExit('Source inputs or formal application changed during checks.')
