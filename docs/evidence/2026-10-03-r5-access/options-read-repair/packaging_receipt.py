"""Freeze reviewed inputs and verify the exact signed app; no user data."""
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
APP = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
BASELINE = json.loads((OUT / 'source-after-build.json').read_text())['source']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


stage = sys.argv[1]
if stage not in ('before', 'after'):
    raise SystemExit('Use before or after')
files = {name: sha(ROOT / name) for name in BASELINE['files']}
if files != BASELINE['files']:
    raise SystemExit('STOP frozen source input changed')
result = {
    'atUtc': datetime.now(timezone.utc).isoformat(),
    'files': files,
    'summary': BASELINE['summary'],
    'matchesReviewedSourceCandidate': True,
}
(OUT / ('signed-source-' + stage + '-build.json')).write_text(json.dumps(result, indent=2) + '\n')
if stage == 'after':
    before = json.loads((OUT / 'signed-source-before-build.json').read_text())
    if before['files'] != files:
        raise SystemExit('STOP packaging inputs changed')
    bundle_files = {str(path.relative_to(APP)): sha(path) for path in sorted(APP.rglob('*')) if path.is_file()}
    expected_names = {
        'Contents/Info.plist', 'Contents/MacOS/farfold',
        'Contents/Resources/release-manifest.json', 'Contents/_CodeSignature/CodeResources',
    }
    if set(bundle_files) != expected_names:
        raise SystemExit('STOP bundle file set differs from four-file app')
    signature = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(APP)], capture_output=True, text=True)
    if signature.returncode:
        raise SystemExit('STOP candidate signature invalid')
    bundle = {
        'atUtc': result['atUtc'], 'path': str(APP), 'files': bundle_files,
        'summary': {
            'files': len(bundle_files),
            'manifestSha256': hashlib.sha256(json.dumps(bundle_files, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        },
        'signature': {'exitCode': signature.returncode, 'output': signature.stderr.strip()},
        'sourceManifestSha256': BASELINE['summary']['manifestSha256'],
        'sourceInputsSameBeforeAfter': True,
    }
    (OUT / 'built-bundle.json').write_text(json.dumps(bundle, indent=2) + '\n')
    print(json.dumps({'source': result['summary'], 'bundle': bundle['summary'], 'binarySha256': bundle_files['Contents/MacOS/farfold'], 'signatureExitCode': signature.returncode}))
else:
    print(json.dumps({'source': result['summary'], 'frozen': True}))
