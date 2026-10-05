import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = ROOT / 'docs/evidence/2026-10-03-r5-access'
OUT.mkdir(parents=True, exist_ok=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def receipt(base, paths):
    files = {str(path.relative_to(base)): digest(path) for path in sorted(paths)}
    return {
        'at': datetime.now(timezone.utc).isoformat(),
        'summary': {
            'files': len(files),
            'manifestSha256': hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        },
        'files': files,
    }

stage = sys.argv[1]
if stage in ('before', 'after'):
    paths = set()
    for folder in ['assets', 'public', 'src', 'src-tauri/src', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/resources']:
        paths.update(path for path in (ROOT / folder).rglob('*') if path.is_file())
    paths.update(ROOT / name for name in ['index.html', 'package.json', 'pnpm-lock.yaml', 'src-tauri/Cargo.lock', 'src-tauri/Cargo.toml', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'tsconfig.app.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts'])
    result = receipt(ROOT, paths)
    result['head'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    target = OUT / ('source-' + stage + '-build.json')
elif stage == 'bundle':
    base = ROOT / 'src-tauri/target/release/bundle/macos/Farfold.app'
    result = receipt(base, [base / name for name in ['Contents/Info.plist', 'Contents/MacOS/farfold', 'Contents/Resources/release-manifest.json', 'Contents/_CodeSignature/CodeResources']])
    result['path'] = str(base)
    signature = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', str(base)], capture_output=True, text=True)
    result['signature'] = {'exitCode': signature.returncode, 'output': signature.stderr.strip()}
    if signature.returncode:
        raise SystemExit('Candidate signature verification failed')
    installed = Path('/Applications/Farfold.app/Contents/MacOS/farfold')
    result['installedBinarySha256'] = digest(installed)
    result['installedApplicationChanged'] = result['installedBinarySha256'] != '9e0c1ac2954e6bfa3e7eb5b79eb4bd4b6179136f9f342461121b39b7b96804a7'
    target = OUT / 'built-bundle.json'
else:
    raise SystemExit('Unknown stage')
target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(target.name, json.dumps(result['summary']))
if stage == 'bundle':
    print('binary', result['files']['Contents/MacOS/farfold'])
    print('signature', result['signature']['exitCode'], 'installedChanged', result['installedApplicationChanged'])
if stage == 'after':
    before = json.loads((OUT / 'source-before-build.json').read_text())
    comparison = {'at': result['at'], 'same': before['files'] == result['files'], 'before': before['summary'], 'after': result['summary']}
    (OUT / 'source-comparison.json').write_text(json.dumps(comparison, indent=2) + '\n')
    print('beforeAfterSame', comparison['same'])
    if not comparison['same']:
        raise SystemExit('Packaging input changed')
