#!/usr/bin/env python3
"""Read only the separate 4/7 Git launch controls from already downloaded artifacts."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
DEPENDENCY = Path(__file__).with_name('read_focused_native.py')
DEPENDENCY_SHA = 'abb9a7ac8543e86010622fb3664ba83941b29d38a7f618975126d8b2dd2cc8b8'
if hashlib.sha256(DEPENDENCY.read_bytes()).hexdigest() != DEPENDENCY_SHA:
    raise RuntimeError('Previously reviewed focused reader changed')
loader = importlib.util.spec_from_file_location('git_controls_focused_reader', DEPENDENCY)
focused = importlib.util.module_from_spec(loader)
loader.loader.exec_module(focused)
legacy = focused.legacy
SCRIPT = '.github/scripts/windows-recovery-followup-git-controls.ps1'

def specs(source):
    values = re.findall(r"@\{ name = '([a-z0-9-]+)'; test = '([A-Za-z0-9_:]+)'; marker = (\$null|'[^'\r\n]+') \}", source)
    if len(values) != 11 or len({v[0] for v in values}) != 11 or len({v[1] for v in values}) != 11:
        raise ValueError('Exact 4/7 source inventory changed; review scope before reading')
    result = [{'name': n, 'test': t, 'marker': None if m == '$null' else m[1:-1]} for n,t,m in values]
    if not all(x['test'].startswith('windows_process::') and x['marker'] is None for x in result[:4]):
        raise ValueError('Launch contract scope changed')
    if not all(x['test'].startswith('worktrees::git::settlement_tests::') and x['marker'] for x in result[4:]):
        raise ValueError('Original settlement scope changed')
    return {'LaunchContracts': result[:4], 'GitSettlement': result[4:]}

def raw_case(spec, record, out, err, head, mode):
    record = focused.obj(record)
    issues = []
    if record.get('head') != head or record.get('mode') != mode or record.get('name') != spec['name'] or record.get('filter') != spec['test']:
        issues.append('case ownership/name differs or receipt absent')
    for key, value in [('exactFilter', True), ('explicitIgnored', False), ('invocationReturned', True), ('terminationRequestedByRunner', False)]:
        if record.get(key) is not value:
            issues.append('case lifecycle flag invalid: ' + key)
    for kind, text in [('stdout', out), ('stderr', err)]:
        if text is None:
            issues.append('raw ' + kind + ' missing/invalid')
    observed = legacy.parse_log(out or '', err or '', spec['marker'])
    terminal = focused.terminal(observed, spec['test'], record.get('exitCode'))
    marker = spec['marker']
    matches = (err or '').splitlines().count(marker) if marker else 0
    if record.get('expectedPhaseMarker') != marker or type(record.get('phaseMarkerMatches')) is not int or record['phaseMarkerMatches'] != matches:
        issues.append('marker receipt disagrees with raw')
    if marker and matches != 1:
        issues.append('actual required settlement phase missing/duplicate')
    if record.get('exactPassed') is not (terminal['classification'] == 'named_pass' and (marker is None or matches == 1)):
        issues.append('recorded pass is inconsistent with raw terminal')
    return {'name': spec['name'], 'filter': spec['test'], 'terminal': terminal, 'marker': marker, 'markerMatches': matches, 'issues': issues}

def report(repo, run_id, head, attempt, directory):
    if not re.fullmatch('[0-9a-f]{40}', head) or not run_id.isdecimal() or not attempt.isdecimal():
        raise ValueError('Explicit head/run/attempt required')
    if legacy.git(repo, 'rev-parse', '--verify', head + '^{commit}').decode().strip() != head:
        raise ValueError('Commit identity mismatch')
    artifacts = focused.Artifacts(directory)
    base = focused.context(repo, run_id, head, attempt, artifacts, 'recovery')
    source = focused.source(repo, head, SCRIPT)
    inventory = specs(source.decode())
    runner_forms = legacy.hash_forms(source)
    _, build_before = artifacts.json('inputs-before.json')
    _, build_after = artifacts.json('inputs-after.json')
    modes = []
    for mode, expected in inventory.items():
        prefix = 'git-launch-controls-' + mode
        aggregate_file, aggregate = artifacts.json(prefix + '.result.json')
        aggregate = focused.obj(aggregate)
        _, before = artifacts.json(prefix + '.inputs-before.json')
        _, after = artifacts.json(prefix + '.inputs-after.json')
        issues = list(base['issues'])
        if not isinstance(before, dict) or not before or before != after or before != build_before or before != build_after:
            issues.append('mode source maps differ/missing or do not equal selected build')
        if aggregate.get('head') != head or aggregate.get('finalHead') != head or aggregate.get('mode') != mode:
            issues.append('aggregate ownership differs or absent')
        for flag in ['headStable', 'inputsStable', 'sourceMapMatchesSelectedBuild']:
            if aggregate.get(flag) is not True:
                issues.append('aggregate evidence flag invalid: ' + flag)
        for count in ['selectedTests', 'groupCount']:
            if type(aggregate.get(count)) is not int or aggregate[count] != len(expected):
                issues.append('aggregate exact count invalid: ' + count)
        if aggregate.get('selectedCaseNames') != [x['name'] for x in expected]:
            issues.append('aggregate selected names differ')
        if not legacy.matching_form(aggregate.get('runnerScriptSha256'), runner_forms):
            issues.append('runner hash differs from requested-head source')
        for key in ['testBinarySha256', 'fixtureSha256']:
            value, selected = aggregate.get(key), base['buildSelection'].get(key)
            if not isinstance(value, str) or not isinstance(selected, str) or value.lower() != selected.lower():
                issues.append('program receipt hash differs: ' + key)
        aggregate_groups = aggregate.get('groups')
        if not isinstance(aggregate_groups, list) or len(aggregate_groups) != len(expected):
            issues.append('aggregate group inventory missing/incorrect')
            aggregate_groups = []
        rows = []
        for index, spec in enumerate(expected):
            name = prefix + '-' + spec['name']
            _, record = artifacts.json(name + '.result.json')
            out_file, out = artifacts.text(name + '.stdout.log')
            err_file, err = artifacts.text(name + '.stderr.log')
            row = raw_case(spec, record, out, err, head, mode)
            for kind, item in [('stdout', out_file), ('stderr', err_file)]:
                stated = focused.obj(record).get(kind + 'Sha256')
                if not isinstance(stated, str) or stated.lower() != item.get('sha256'):
                    row['issues'].append('raw hash missing/mismatched: ' + kind)
            if index >= len(aggregate_groups) or aggregate_groups[index] != record:
                row['issues'].append('aggregate does not equal original per-case receipt')
            row['status'] = 'passed' if not issues and not row['issues'] and row['terminal']['classification'] == 'named_pass' else 'failed' if not issues and not row['issues'] and row['terminal']['classification'] == 'named_failure' else 'unverified'
            rows.append(row)
        all_passed = all(x['status'] == 'passed' for x in rows)
        if aggregate.get('exactAllPassed') is not all_passed:
            issues.append('aggregate pass claim differs from qualified raw evidence')
            all_passed = False
            for row in rows:
                row['status'] = 'unverified'
        modes.append({'mode': mode, 'issues': issues, 'aggregateFile': aggregate_file, 'cases': rows, 'counts': dict(Counter(x['status'] for x in rows)), 'allPassed': all_passed})
    changed = artifacts.changes()
    return {'schema': 1, 'createdAtUtc': datetime.now(timezone.utc).isoformat(), 'requested': {'head': head, 'runId': run_id, 'attempt': attempt}, 'context': base, 'runnerSource': {'path': SCRIPT, 'gitBlobSha256': legacy.sha(source)}, 'modes': modes, 'inputsStableDuringRead': not changed, 'changedDuringRead': changed, 'allElevenVerifiedPassed': not changed and all(x['allPassed'] for x in modes), 'rawFiles': [v[0] for v in artifacts.cache.values()], 'limits': ['Independent four launch/seven settlement controls only; not original recovery7, null8, current140 or legacy inventories.', 'Original binary hashes are receipt identity; no binary is loaded, downloaded or executed.', 'No installed product, arbitrary process timing, Agent or whole Windows acceptance claim.']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['repo', 'run-id', 'head', 'attempt', 'artifacts', 'output']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if output.exists() or output.is_relative_to(Path(args.artifacts).resolve()):
        raise ValueError('New report must be outside immutable artifact directory')
    result = report(Path(args.repo), args.run_id, args.head, args.attempt, Path(args.artifacts))
    result['reader'] = {'path': str(Path(__file__).resolve()), 'sha256': legacy.sha(Path(__file__).read_bytes()), 'dependencySha256': DEPENDENCY_SHA}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(output)

if __name__ == '__main__':
    main()
