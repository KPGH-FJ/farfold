"""Replace only the exact formal Farfold app after normal exit."""
import hashlib
import json
import plistlib
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from safe_state import snapshot

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = Path(__file__).resolve().parent
INSTALLED = OUT / 'installed'
BUILT = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
FORMAL = Path('/Applications/Farfold.app')
EXPECTED_OLD = '72e1539d77b10d668691e37451f68c0abad04be621eb5dda5d8a561d2486719d'
INSTALLED.mkdir(exist_ok=True)


def app_files(base):
    return {str(path.relative_to(base)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(base.rglob('*')) if path.is_file()}


def write(name, value):
    (INSTALLED / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


running = subprocess.run(['/usr/bin/pgrep', '-x', 'farfold'], capture_output=True)
if running.returncode != 1:
    raise SystemExit('STOP Farfold still running or process check failed')
preflight = json.loads((INSTALLED / 'preflight.json').read_text())
if not preflight['safeToRequestNormalExit']:
    raise SystemExit('STOP current safe-exit preflight missing')
for base in [BUILT, FORMAL]:
    if base.is_symlink() or not base.is_dir() or any(path.is_symlink() for path in base.rglob('*')):
        raise SystemExit('STOP unexpected exact app path')
    info = plistlib.loads((base / 'Contents/Info.plist').read_bytes())
    if info['CFBundleIdentifier'] != 'ai.farfold.desktop':
        raise SystemExit('STOP app identity differs')
source = json.loads((OUT / 'signed-source-after-build.json').read_text())
for name, expected in source['files'].items():
    if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('STOP frozen source input changed: ' + name)
bundle_receipt = json.loads((OUT / 'built-bundle.json').read_text())
candidate = app_files(BUILT)
if candidate != bundle_receipt['files']:
    raise SystemExit('STOP candidate changed after review')
previous = app_files(FORMAL)
if previous['Contents/MacOS/farfold'] != EXPECTED_OLD or set(previous) != set(candidate):
    raise SystemExit('STOP formal app differs from reviewed previous app')
subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(BUILT)], check=True)
before = snapshot()
write('before-install-data.json', before)
subprocess.run(['/usr/bin/ditto', str(BUILT), str(FORMAL)], check=True)
actual = app_files(FORMAL)
if actual != candidate:
    raise SystemExit('STOP installed files differ')
signature = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(FORMAL)], capture_output=True, text=True)
if signature.returncode:
    raise SystemExit('STOP installed signature failed')
after = snapshot()
write('after-install-data.json', after)
if before != after:
    raise SystemExit('STOP application replacement changed data')
result = {
    'atUtc': datetime.now(timezone.utc).isoformat(), 'atLocal': datetime.now().astimezone().isoformat(),
    'installed': str(FORMAL), 'bundleIdentifier': 'ai.farfold.desktop',
    'oldBinarySha256': previous['Contents/MacOS/farfold'], 'binarySha256': actual['Contents/MacOS/farfold'],
    'sourceManifestSha256': source['summary']['manifestSha256'], 'files': actual,
    'dataBeforeAfterEqual': True, 'signature': {'exitCode': signature.returncode, 'output': signature.stderr.strip()},
    'appNotStartedYet': True, 'userSafeUpdatePreviouslyConfirmed': True,
    'currentSafeStateRechecked': True, 'exitRequestedThroughNormalMenu': True,
}
write('installation.json', result)
print(json.dumps({key: value for key, value in result.items() if key != 'files'}, ensure_ascii=False))
print(json.dumps({'counts': {name: value['count'] for name, value in before['tables'].items()}}))
