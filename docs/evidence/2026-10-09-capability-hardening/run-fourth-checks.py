"""Frozen-input integration checks. Logs keep original stdout/stderr bytes."""
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import time
import sys

ROOT = Path(__file__).resolve().parents[3]
OUTPUT_NAME = sys.argv[1] if len(sys.argv) > 1 else 'fourth-checks'
if OUTPUT_NAME not in ('fourth-checks', 'fourth-checks-final'):
    raise ValueError('Unknown check output directory')
OUT = Path(__file__).resolve().parent / OUTPUT_NAME
SCOPES = ('src', 'src-tauri/src', 'src-tauri/native', 'src-tauri/capabilities',
          'src-tauri/resources', 'src-tauri/icons', 'scripts', 'assets', 'public')
TOP = ('package.json', 'pnpm-lock.yaml', 'index.html', 'tsconfig.json',
       'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts',
       'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs',
       'src-tauri/Info.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json')


def inputs():
    paths = {ROOT / path for path in TOP}
    for scope in SCOPES:
        paths.update(path for path in (ROOT / scope).rglob('*')
                     if path.is_file() and path.name != '.DS_Store' and '__pycache__' not in path.parts)
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def run_group(group):
    results = []
    for name, args in group:
        started = time.monotonic()
        with (OUT / (name + '.txt')).open('xb') as log:
            completed = subprocess.run(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        results.append({'name': name, 'argv': args, 'exitCode': completed.returncode,
                        'seconds': round(time.monotonic() - started, 3), 'log': name + '.txt'})
        print(json.dumps(results[-1]), flush=True)
    return results


if __name__ == '__main__':
    OUT.mkdir(exist_ok=False)
    before = inputs()
    (OUT / 'inputs.json').write_text(json.dumps(before, indent=2) + '\n')
    groups = [
        [('format', ['corepack', 'pnpm', 'format:check']),
         ('typecheck', ['corepack', 'pnpm', 'typecheck']),
         ('frontend', ['corepack', 'pnpm', 'test']),
         ('build', ['corepack', 'pnpm', 'build'])],
        [('cargo-fmt', ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml']),
         ('clippy', ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings']),
         ('rust', ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked'])],
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        groups = list(pool.map(run_group, groups))
    results = [result for group in groups for result in group]
    after = inputs()
    receipt = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'sourceBase': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
               'inputCount': len(before), 'sourceUnchanged': before == after,
               'changedInputs': sorted(path for path in set(before) | set(after) if before.get(path) != after.get(path)),
               'checks': results, 'passed': before == after and all(r['exitCode'] == 0 for r in results)}
    (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'passed': receipt['passed'], 'sourceUnchanged': receipt['sourceUnchanged']}), flush=True)
    raise SystemExit(0 if receipt['passed'] else 1)
