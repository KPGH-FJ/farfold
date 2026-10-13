"""Closed engineering inputs; no user-data discovery and no command execution."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path('/Users/tw/Desktop/farfold')
PREP = ROOT / 'output/2026-10-13-xlsx-input-checks-preparation'
BASE = 'output/2026-10-13-docx-input-checks/inputs-before.json'
A = 'output/2026-10-13-document-input-next/implementation-a/source-freeze.json'
B = 'output/2026-10-13-xlsx-input-integration/source-freeze-v1.json'
ORACLE = 'docs/evidence/2026-10-09-capability-hardening/xlsx-input/fixtures/oracle.json'
PROTECTED = {
    'PRODUCT.md': 'c571fe2afcd6f06efff3da1aea5f5c879bcb69cbeab10cec3569f0d33718cfe7',
    'docs/evidence/2026-10-08-reliability-ui-review/README.md': '2a2a3127cc0e97e62ff64eaf067033c37af6878dc7d32fcfa67dd19dbafc2d45',
    'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md': 'f2d6cedc87d969d63d17507c85c6f5abd7424a7a3edb9cfcd940520553429cd7',
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path: Path):
    return json.loads(path.read_text())


def write_exclusive(path: Path, value):
    with path.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write('\n')


def safe_file(root: Path, relative: str) -> Path:
    rel = Path(relative)
    if rel.is_absolute() or '..' in rel.parts or not relative:
        raise ValueError(f'Unsafe inventory path: {relative}')
    path = root / rel
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Missing/nonregular inventory file: {relative}')
    return path


def snapshot(root: Path, paths: list[str]) -> dict[str, str]:
    if len(paths) != len(set(paths)):
        raise ValueError('Duplicate inventory paths')
    return {rel: sha(safe_file(root, rel)) for rel in sorted(paths)}


def live_source_paths(root: Path) -> list[str]:
    result = subprocess.run(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'src-tauri'],
        cwd=root, capture_output=True, check=True,
    )
    paths = set()
    for item in result.stdout.decode('utf-8').split('\0'):
        if not item or item.startswith(('src-tauri/target/', 'src-tauri/gen/')):
            continue
        path = root / item
        if path.is_file():
            safe_file(root, item)
            paths.add(item)
    return sorted(paths)


def pins(root: Path):
    a, b = read(root / A), read(root / B)
    pinned = {p: v['sha256'] for p, v in a['sources'].items()}
    pinned.update({p: v['sha256'] for p, v in a['fixtures'].items()})
    for item in b['ownedFiles']:
        pinned[item['path']] = item['sha256']
    return pinned


def oracle_exception(root: Path):
    entries = (root / '.prettierignore').read_text().splitlines()
    if entries.count(ORACLE) != 1:
        raise ValueError('Exact oracle exception must appear once')
    # Production source must not receive a new broad exception for this slice.
    blocked = [entry for entry in entries if entry.strip() in
               {'src', 'src/', 'src/**', 'src/runtime/xlsx*', 'src/runtime/xlsx_input*'}]
    if blocked:
        raise ValueError(f'Production-source formatting exemptions: {blocked}')
    return {'path': ORACLE, 'exactCount': 1, 'line': entries.index(ORACLE) + 1}


def make_plan(root: Path):
    base = read(root / BASE)
    if len(base) != 1605:
        raise ValueError('DOCX baseline must retain exactly 1605 paths')
    a = read(root / A)
    current_source = live_source_paths(root)
    fixtures = sorted(a['fixtures'])
    closed = sorted(set(base) | set(current_source) | set(fixtures))
    protected = snapshot(root, list(PROTECTED))
    if protected != PROTECTED:
        raise ValueError('Protected PRODUCT/user-dirty README bytes differ')
    observed = snapshot(root, closed)
    actual_pins = snapshot(root, list(pins(root)))
    if actual_pins != pins(root):
        raise ValueError('A/B frozen source or exact fixture bytes differ')
    return {
        'schema': 1, 'phase': 'PREPARATION_ONLY_NOT_FINAL_C_FREEZE',
        'base': {'path': BASE, 'sha256': sha(root / BASE), 'count': len(base)},
        'inputCount': len(closed), 'paths': closed, 'observedHashes': observed,
        'addedSourcePaths': sorted(set(current_source) - set(base)),
        'addedFixedFixturePaths': sorted(set(fixtures) - set(base)),
        'currentSourcePaths': current_source,
        'pinReceipts': {p: sha(root / p) for p in (A, B)},
        'ownedSourceAndFixturePins': pins(root), 'protected': protected,
        'exactOracleException': oracle_exception(root),
        'excluded': ['unrelated untracked/output', 'user-dirty README from sourceInputs (separately protected)',
                     'src-tauri/target', 'src-tauri/gen', 'user database/Agent config/credentials',
                     'generated dist/tsbuildinfo/vite.config.js/vite.config.d.ts'],
        'scope': 'DOCX closed1605 plus current git-cached/new source/support under src/src-tauri and exact A fixed XLSX fixtures; output evidence is never execution authority.',
    }


if __name__ == '__main__':
    plan = make_plan(ROOT)
    write_exclusive(PREP / 'inventory-plan.json', plan)
    print(json.dumps({'phase': plan['phase'], 'inputCount': plan['inputCount'],
                      'addedSource': len(plan['addedSourcePaths']), 'addedFixtures': len(plan['addedFixedFixturePaths'])}))
