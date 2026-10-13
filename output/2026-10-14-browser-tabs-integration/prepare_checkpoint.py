"""Prepare an exact P30 checkpoint list; never stage, commit, copy or run checks.

All final receipts are explicit path=SHA256 arguments. This script is prepared
before final checks/publication; its existence is not evidence those passed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess

ROOT = Path('/Users/tw/Desktop/farfold')
OUT = ROOT / 'output/2026-10-14-browser-tabs-integration'
DOCS = {'docs/status.md', 'docs/architecture.md', 'plans/agent-access.md',
        'docs/evidence/2026-10-09-capability-hardening/README.md', '.prettierignore'}
PROTECTED = {
    'PRODUCT.md': 'c571fe2afcd6f06efff3da1aea5f5c879bcb69cbeab10cec3569f0d33718cfe7',
    'docs/evidence/2026-10-08-reliability-ui-review/README.md': '2a2a3127cc0e97e62ff64eaf067033c37af6878dc7d32fcfa67dd19dbafc2d45',
    'docs/evidence/2026-10-08-reliability-ui-review/annotated/README.md': 'f2d6cedc87d969d63d17507c85c6f5abd7424a7a3edb9cfcd940520553429cd7',
}
PUBLIC = 'docs/evidence/2026-10-09-capability-hardening/'
GROUPS = {
    'frontend': [
        ['format-check', ['corepack', 'pnpm', 'format:check']],
        ['typecheck', ['corepack', 'pnpm', 'typecheck']],
        ['frontend-test', ['corepack', 'pnpm', 'test']],
        ['frontend-build', ['corepack', 'pnpm', 'build']],
    ],
    'native': [
        ['cargo-fmt', ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml']],
        ['cargo-clippy', ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings']],
        ['cargo-test', ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']],
    ],
}


def git(*argv, input_bytes=None):
    return subprocess.check_output(['git', *argv], cwd=ROOT, input=input_bytes)


def relative(name):
    p = PurePosixPath(name)
    assert str(p) == name and not p.is_absolute() and '..' not in p.parts, name
    assert name and not any(c in name for c in '\n\r\x00'), name
    return name


def safe(name):
    p = ROOT / relative(name)
    assert all(not x.is_symlink() for x in (p, *p.parents)), name
    assert stat.S_ISREG(p.lstat().st_mode), name
    return p


def ref(name):
    data = safe(name).read_bytes()
    return {'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def pinned(argument):
    name, digest = argument.rsplit('=', 1)
    assert re.fullmatch('[a-f0-9]{64}', digest), argument
    item = ref(name)
    assert item['sha256'] == digest, name
    return item


def read(item):
    assert ref(item['path']) == item, item['path']
    return json.loads(safe(item['path']).read_bytes())


def check_ref(item):
    actual = ref(item['path'])
    assert all(actual[k] == item[k] for k in actual), item['path']
    return actual


def physical_source():
    names = []
    for top in ('src', 'src-tauri'):
        assert not (ROOT / top).is_symlink()
        for directory, dirs, files in os.walk(ROOT / top, followlinks=False):
            for child in list(dirs):
                p = Path(directory) / child
                name = p.relative_to(ROOT).as_posix()
                if name in ('src-tauri/target', 'src-tauri/gen'):
                    dirs.remove(child)
                else:
                    assert not p.is_symlink(), name
            for child in files:
                name = (Path(directory) / child).relative_to(ROOT).as_posix()
                safe(name)
                names.append(name)
    return sorted(names)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, help='Current pre-checkpoint HEAD, not a future commit')
    for name in ('inventory', 'freeze', 'summary', 'verification'):
        parser.add_argument('--' + name, required=True, help='Final receipt path=sha256')
    parser.add_argument('--owner', action='append', required=True, help='Final source-freeze path=sha256, in owner-count order')
    parser.add_argument('--owner-count', action='append', type=int, required=True)
    parser.add_argument('--publication', action='append', required=True, help='Final files[{original,published}] manifest path=sha256')
    parser.add_argument('--record', action='append', default=[], help='Additional exact public metadata path=sha256; no directory scans')
    parser.add_argument('--required-copy', action='append', required=True, help='Required original failed/verify-public receipt path=sha256, which must have a public exact copy')
    parser.add_argument('--aux-root', action='append', default=[], help='Exact reviewed output directory allowed for changed/new frozen auxiliary inputs')
    parser.add_argument('--out', required=True, help='New plan JSON directly in this integration directory; also writes .paths.nul')
    args = parser.parse_args()
    assert Path(__file__).absolute().parent == OUT and not OUT.is_symlink()
    assert re.fullmatch('[a-f0-9]{40}', args.base)
    assert git('rev-parse', 'HEAD').decode().strip() == args.base
    assert not git('diff', '--cached', '--name-only', '-z'), 'Index must remain empty'
    pinned_args = {k: pinned(getattr(args, k)) for k in ('inventory', 'freeze', 'summary', 'verification')}
    plan, freeze, summary, verification = (read(pinned_args[k]) for k in ('inventory', 'freeze', 'summary', 'verification'))
    assert plan['baselineCommit'] == freeze['sourceHEAD'] == args.base
    assert freeze['inventoryPlan'] == {'path': str(ROOT / pinned_args['inventory']['path']), 'sha256': pinned_args['inventory']['sha256']}
    assert not freeze['changesSincePreparation'] and freeze['groups'] == GROUPS
    inputs = freeze['inputs']
    assert len(inputs) == freeze['inputCount'] == plan['inputCount'] == len(plan['paths']) == summary['inputCount']
    assert set(inputs) == set(plan['paths']) and freeze['protected'] == PROTECTED
    assert freeze['sourcePaths'] == plan['currentSourcePaths'] == physical_source()
    assert summary['freezeSha256'] == pinned_args['freeze']['sha256']
    assert all(summary[k] is True for k in ('allPassed', 'sourceStable', 'sourceMembershipStable', 'protectedUnchanged'))
    assert summary['completedCount'] == summary['requiredCommandsExecuted'] == 7
    assert summary['runnerErrors'] == [] and not summary['failed'] and not summary['notStarted']
    assert summary['interruptedSignal'] is None and not summary['launchFailed']
    assert all(verification[k] == value for k, value in summary.items()), 'Public verification must preserve actual summary'
    fixed = {name: ref(name) for name in set(inputs) | set(PROTECTED)}
    assert all(fixed[name]['sha256'] == digest for name, digest in {**inputs, **PROTECTED}.items())

    selected = set(DOCS)
    assert DOCS <= set(inputs)
    owned, owner_refs = {}, []
    assert len(args.owner) == len(args.owner_count) == 2 and all(n > 0 for n in args.owner_count)
    for argument, count in zip(args.owner, args.owner_count):
        owner = pinned(argument)
        rows = read(owner)
        rows = rows.get('files', rows.get('ownedFiles'))
        assert isinstance(rows, list) and len(rows) == count
        for row in rows:
            name = row['path']
            assert name.startswith(('src/', 'src-tauri/')) and name not in owned, name
            owned[name] = check_ref(row)
            assert inputs[name] == owned[name]['sha256'], name
        assert freeze['ownerFreezeReceipts'][owner['path']] == owner['sha256']
        owner_refs.append(owner)
        selected.add(owner['path'])
    assert len(owned) == sum(args.owner_count) == plan['ownerSourceCount']
    selected.update(owned)
    changed_source = set(filter(None, git('diff', '--name-only', '-z', args.base, '--', 'src', 'src-tauri').decode().split('\0')))
    untracked_source = set(filter(None, git('ls-files', '-z', '--others', '--exclude-standard', '--', 'src', 'src-tauri').decode().split('\0')))
    assert changed_source | untracked_source <= set(owned), 'Unreviewed source change'

    copies, publication_refs = {}, []
    for argument in args.publication:
        manifest = pinned(argument)
        assert manifest['path'].startswith(PUBLIC)
        publication_refs.append(manifest)
        selected.add(manifest['path'])
        for pair in read(manifest)['files']:
            original, published = (check_ref(pair[k]) for k in ('original', 'published'))
            assert published['path'].startswith(PUBLIC) and published['path'] != original['path']
            assert (original['bytes'], original['sha256']) == (published['bytes'], published['sha256'])
            copies.setdefault(original['path'], []).append(published)
            selected.add(published['path'])
    required = [pinned(a) for a in args.required_copy]
    run = Path(pinned_args['summary']['path']).parent
    assert len(summary['checks']) == 7
    required.append(pinned_args['summary'])
    required.append(pinned_args['freeze'])
    commands = {name: (group, argv) for group, rows in GROUPS.items() for name, argv in rows}
    assert {c['name'] for c in summary['checks']} == set(commands)
    for check in summary['checks']:
        group, argv = commands[check['name']]
        assert check['argv'] == argv and check['group'] == group and check['cwd'] == str(ROOT)
        assert check['state'] == 'COMPLETED' and check['actualStageCompletion'] is True and check['processLaunched'] is True and check['rawExitCode'] == 0
        completed = ref((run / check['name'] / 'completed.json').as_posix())
        assert read(completed) == check
        required.append(completed)
        for stream in ('stdout', 'stderr'):
            log = ref((run / check['name'] / (stream + '.log')).as_posix())
            assert log['sha256'] == check[stream + 'Sha256']
            required.append(log)
    for item in required:
        assert item['path'] in copies, 'Missing required public exact copy: ' + item['path']
        assert all((p['bytes'], p['sha256']) == (item['bytes'], item['sha256']) for p in copies[item['path']])
    records = [pinned_args['verification']] + [pinned(a) for a in args.record]
    assert all(item['path'].startswith(PUBLIC) for item in records)
    selected.update(item['path'] for item in records)

    # Every frozen input must already match HEAD or enter this exact checkpoint.
    # Existing tracked auxiliary changes are included, not only untracked files.
    head = {}
    for entry in git('ls-tree', '-r', '-z', args.base).split(b'\0'):
        if entry:
            meta, name = entry.split(b'\t', 1)
            mode, kind, oid = meta.decode().split()
            if kind == 'blob':
                head[name.decode()] = (mode, oid)
    names = sorted(inputs)
    assert all(not n.startswith('"') for n in names)
    hashes = git('hash-object', '--stdin-paths', input_bytes=('\n'.join(names) + '\n').encode()).decode().splitlines()
    assert len(hashes) == len(names)
    roots = [relative(n).rstrip('/') + '/' for n in args.aux_root]
    assert all(r.startswith('output/') and len(PurePosixPath(r).parts) >= 2 for r in roots)
    auxiliary = []
    for name, oid in zip(names, hashes):
        mode = '100755' if safe(name).stat().st_mode & stat.S_IXUSR else '100644'
        if head.get(name) != (mode, oid):
            if name not in selected:
                assert name.startswith('output/') and any(name.startswith(r) for r in roots), 'Changed input requires exact reviewed selection/root: ' + name
                auxiliary.append(name)
            selected.add(name)
    assert not selected.intersection(PROTECTED)
    script = Path(__file__).absolute().relative_to(ROOT).as_posix()
    selected.add(script)
    files = [ref(name) for name in sorted(selected)]
    for item in list(fixed.values()) + files + list(pinned_args.values()) + owner_refs + publication_refs + required + records:
        assert ref(item['path']) == item, 'Drift: ' + item['path']
    assert physical_source() == freeze['sourcePaths']
    assert git('rev-parse', 'HEAD').decode().strip() == args.base and not git('diff', '--cached', '--name-only', '-z')
    out = Path(args.out).absolute()
    nul = out.with_suffix('.paths.nul')
    assert out.parent == OUT and out.suffix == '.json' and not out.exists() and not nul.exists()
    result = {'schema': 1, 'phase': 'EXACT_CHECKPOINT_PLAN_NOT_STAGED', 'base': args.base,
              'files': files, 'count': len(files), 'ownerCounts': args.owner_count,
              'sourceCount': len(owned), 'inputCount': len(inputs), 'auxiliaryInputs': auxiliary,
              'receipts': pinned_args, 'owners': owner_refs, 'publications': publication_refs,
              'requiredCopies': required, 'protected': PROTECTED,
              'boundary': 'Selection only. No stage/commit, check rerun, public copying, App, process or database access. Existing unrelated paths remain unselected. Raw failures are preserved byte-for-byte; no result is rewritten.'}
    with out.open('x') as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    with nul.open('xb') as handle:
        handle.write(b'\0'.join(item['path'].encode() for item in files) + b'\0')
    print(json.dumps({'plan': ref(out.relative_to(ROOT).as_posix()), 'paths': ref(nul.relative_to(ROOT).as_posix()), 'count': len(files)}))


if __name__ == '__main__':
    main()
