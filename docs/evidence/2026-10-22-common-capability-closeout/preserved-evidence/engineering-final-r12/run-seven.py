from pathlib import Path
from hashlib import sha256
from datetime import datetime, timezone
import json, os, re, shutil, subprocess, sys, time

ROOT = Path('<private-mac-home:a2369e920572>')
OUT = Path(__file__).resolve().parent
PREFIXES = ('.github', '.design', 'assets', 'public', 'patches', '.cargo', 'src', 'src-tauri', 'scripts', 'docs', 'plans')
EXCLUDED = {'node_modules', 'target', 'gen', '.git'}
FIXED = ('AGENTS.md', 'PRODUCT.md', 'README.md', 'package.json', 'pnpm-lock.yaml',
         'pnpm-workspace.yaml', 'vite.config.ts', 'vitest.config.ts',
         'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'index.html',
         '.prettierignore', '.prettierrc', '.prettierrc.json', '.gitignore',
         'Cargo.toml', 'Cargo.lock', '.cargo/config.toml')
PROTECTED = {
    'docs/evidence/2026-10-08-reliability-ui-review/README.md':
        '2a2a3127cc0e97e62ff64eaf067033c37af6878dc7d32fcfa67dd19dbafc2d45',
    'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md':
        'f2d6cedc87d969d63d17507c85c6f5abd7424a7a3edb9cfcd940520553429cd7',
}
COMMANDS = (
    ('format', ['corepack', 'pnpm', 'format:check']),
    ('type', ['corepack', 'pnpm', 'typecheck']),
    ('frontend', ['corepack', 'pnpm', 'test']),
    ('build', ['corepack', 'pnpm', 'build']),
    ('rust-format', ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml']),
    ('rust-strict', ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings']),
    ('rust-tests', ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']),
)

def digest(p):
    return sha256(p.read_bytes()).hexdigest()

def reference(p):
    return {'path': str(p), 'bytes': p.stat().st_size, 'sha256': digest(p)}

def write(name, value):
    p = OUT / name
    with p.open('x') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
    return reference(p)

def snapshot():
    files = {ROOT / x for x in FIXED if (ROOT / x).is_file()}
    for p in ROOT.iterdir():
        if p.is_file() and (re.fullmatch(r'(?:[^/]+\.config\.[^/]+|tsconfig[^/]*\.json)', p.name)
                            or p.name in {'.npmrc', '.pnpmfile.cjs'}):
            files.add(p)
    for name in PREFIXES:
        for current, directories, names in os.walk(ROOT / name, followlinks=False):
            directories[:] = [x for x in directories if x not in EXCLUDED]
            for name in names:
                p = Path(current) / name
                if p.name == '.DS_Store' or p.suffix == '.log':
                    continue
                if p.is_file():
                    files.add(p)
    # All literal Rust includes, including frontend fixtures, are in the closure.
    for p in (ROOT / 'src-tauri/src').rglob('*.rs'):
        for relative in re.findall(r'include_(?:str|bytes)!\(\s*"([^"\n]+)"', p.read_text()):
            included = (p.parent / relative).resolve()
            assert included.is_relative_to(ROOT) and included.is_file(), included
            files.add(included)
    for name, expected in PROTECTED.items():
        assert digest(ROOT / name) == expected, name
    return {
        'files': {str(p.relative_to(ROOT)): {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in sorted(files)},
        'optionalAbsent': [name for name in FIXED if not (ROOT / name).is_file()],
        'protected': PROTECTED,
    }

def rust_idle():
    for line in subprocess.check_output(['/bin/ps', '-Ao', 'pid=,comm='], text=True).splitlines():
        values = line.strip().split(None, 1)
        if len(values) == 2:
            assert Path(values[1]).name not in {'cargo', 'rustc', 'clippy-driver', 'rustfmt', 'cargo-clippy', 'cargo-fmt'}, 'Other Rust writer active'

assert shutil.disk_usage(ROOT).free >= 4 * 1024**3
rust_idle()
before = snapshot()
before_ref = write('inputs-before.json', before)
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
results = []
steps = []
dist_baseline = None
def dist_inventory():
    return {str(p.relative_to(ROOT)): {'bytes': p.stat().st_size, 'sha256': digest(p)}
            for p in sorted((ROOT / 'dist').rglob('*')) if p.is_file()}
for number, (label, command) in enumerate(COMMANDS, 1):
    if command[0] == 'cargo':
        assert shutil.disk_usage(ROOT).free >= 4 * 1024**3, 'Under 4GiB: no further Cargo check started'
        rust_idle()
    start = datetime.now(timezone.utc).isoformat()
    started_unix = time.time()
    began = time.monotonic()
    raw = OUT / f'{number:02}.log'
    with raw.open('xb') as f:
        child_environment = os.environ.copy()
        child_environment["CARGO_INCREMENTAL"] = "0"
        child = subprocess.Popen(command, cwd=ROOT, stdout=f, stderr=subprocess.STDOUT, env=child_environment)
        code = child.wait()
    finished_unix = time.time()
    after = snapshot()
    stable = before == after
    if label == 'build' and code == 0:
        dist_baseline = dist_inventory()
    if command[0] == 'cargo' and dist_baseline is not None:
        stable = stable and dist_inventory() == dist_baseline
    result = {'label': label, 'command': command, 'atUtc': start,
              'naturalExit': code, 'naturalCompletionObserved': True,
              'elapsedSeconds': time.monotonic() - began, 'inputsStable': stable,
              'raw': reference(raw), 'freeBytesAfter': shutil.disk_usage(ROOT).free}
    results.append(result)
    steps.append({'command': command, 'exitCode': code,
                  'startedAtUnix': started_unix, 'finishedAtUnix': finished_unix,
                  'log': str(raw.relative_to(ROOT)), 'logSha256': digest(raw),
                  'inputsStable': stable})
    write(label + '-receipt.json', result)
    print(json.dumps(result), flush=True)
    if not stable:
        write(label + '-drift.json', after)
    if code != 0 or not stable:
        break
after = snapshot()
dist = dist_inventory()
after_ref = write('inputs-after.json', after)
dist_ref = write('dist-after.json', dist)
summary = {'scope': 'Actual seven commands on current source; no installed App or real Agent claim',
           'head': head, 'inputCount': len(before['files']), 'before': before_ref,
           'after': after_ref, 'inputsStable': before == after, 'results': results,
           'dist': dist_ref, 'runner': reference(Path(__file__).resolve()),
           'coverage': 'Listed product/design/docs/script roots and literal Rust includes; dependency runtime contents and generated Rust OUT_DIR are not a reproducibility archive.'}
summary['allSevenPassed'] = len(results) == 7 and before == after and all(x['naturalExit'] == 0 for x in results)
summary['allSevenPassed'] = summary['allSevenPassed'] and all(x['inputsStable'] for x in results)
legacy = {'scope': 'Actual seven required checks; no installed App or real Agent proof',
          'head': head, 'inputCount': len(before['files']),
          'before': {name: row['sha256'] for name, row in before['files'].items()},
          'steps': steps,
          'after': {name: row['sha256'] for name, row in after['files'].items()},
          'result': 'passed' if summary['allSevenPassed'] else 'failed'}
summary['legacyCompatibleActualSeven'] = write('legacy-seven.json', legacy)
ref = write('verification.json', summary)
print(json.dumps({'verification': ref, 'allSevenPassed': summary['allSevenPassed']}), flush=True)
sys.exit(0 if summary['allSevenPassed'] else 1)
