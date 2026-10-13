"""Prepare the PDF-search input union for the unchanged seven-check runner.

Only reads source/saved synthetic evidence and writes one exclusive input plan.
No check command, browser, application, Agent or database is started or opened.
"""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path('/Users/tw/Desktop/farfold')
OUT = ROOT / 'output/2026-10-14-pdf-search-integration'
BASELINE = 'b4cce76e6d8ab38988e78fc11580818bd167391c'
BASE = ROOT / 'output/2026-10-14-xlsx-search-integration/inventory-plan-final.json'
BASE_SHA = '32d00ac07782aa18692465eb059252b60f7de67c65a9f73913bca5dd0fe8926a'
HELPER = ROOT / 'output/2026-10-13-xlsx-input-checks-preparation/inventory.py'
HELPER_SHA = '7784a38803fb1c10da014755cde9901f9deba982ffb01ab1076dfd2060e3e076'
RUNNER = ROOT / 'output/2026-10-13-xlsx-input-checks-preparation/runner-v4/run_checks.py'
RUNNER_SHA = '0cf4b3fd62d3d94f1781119f65d87f68a9fd26a6afb5e95ca7e56bda3f140a0c'
DOCS = ['docs/status.md', 'docs/architecture.md', 'plans/agent-access.md',
        'docs/evidence/2026-10-09-capability-hardening/README.md']
AUXILIARY = ['output/2026-10-14-pdf-search-integration/prepare_inventory.py']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe(relative):
    path = inv.safe_file(ROOT, relative)
    assert all(not item.is_symlink() for item in (path, *path.parents)), relative
    return path


def conditions(text):
    originals, added = {}, {}
    for line in text.splitlines():
        if not re.match(r'^\|\s*(?:ARCH-\d\d|[PH]\d\d|NEW-\d\d)\s*\|', line):
            continue
        cells = [value.strip() for value in line.strip().strip('|').split('|')]
        target = added if cells[0].startswith('NEW-') else originals
        assert len(cells) == (3 if target is added else 4) and cells[0] not in target
        target[cells[0]] = cells[-1] if target is added else [cells[1], cells[-1]]
    assert len(originals) == 122 and len(added) == 28
    return originals, added


def physical():
    paths = []
    for top in ('src', 'src-tauri'):
        assert not (ROOT / top).is_symlink()
        for directory, dirs, files in os.walk(ROOT / top, followlinks=False):
            kept = []
            for name in dirs:
                item = Path(directory) / name
                relative = item.relative_to(ROOT).as_posix()
                if relative in ('src-tauri/target', 'src-tauri/gen'):
                    continue
                assert not item.is_symlink(), relative
                kept.append(name)
            dirs[:] = kept
            for name in files:
                relative = (Path(directory) / name).relative_to(ROOT).as_posix()
                safe(relative)
                paths.append(relative)
    return sorted(paths)


def pinned(argument):
    path, digest = argument.rsplit('=', 1)
    assert re.fullmatch('[a-f0-9]{64}', digest) and sha(safe(path)) == digest, path
    return path, digest


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--owner', action='append', required=True, help='Backend/frontend freeze path=sha256')
parser.add_argument('--browser', action='append', required=True, help='Saved Chromium/WebKit result path=sha256; use only its input map')
parser.add_argument('--pin', action='append', default=[], help='Additional final reviewed receipt path=sha256')
parser.add_argument('--extra', action='append', default=[], help='Exact final source/evidence input, e.g. completed public records')
parser.add_argument('--out', required=True)
args = parser.parse_args()
assert Path(__file__).resolve().parent == OUT
assert all(not p.is_symlink() for p in (ROOT, OUT, *ROOT.parents))
assert sha(BASE) == BASE_SHA and sha(HELPER) == HELPER_SHA and sha(RUNNER) == RUNNER_SHA
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip() == BASELINE
spec = importlib.util.spec_from_file_location('pdf_search_inventory', HELPER)
inv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inv)
base = json.loads(BASE.read_bytes())
assert base['inputCount'] == 1842 == len(base['paths'])
prior_plan = subprocess.check_output(['git', 'show', BASELINE + ':plans/agent-access.md'], cwd=ROOT).decode()
assert conditions(prior_plan) == conditions(safe('plans/agent-access.md').read_text())
assert inv.snapshot(ROOT, list(inv.PROTECTED)) == inv.PROTECTED

pins, reviewed = {}, {}
assert len(args.owner) == 2
owner_counts = []
for argument in args.owner:
    path, digest = pinned(argument)
    assert path not in pins
    pins[path] = digest
    receipt = json.loads(safe(path).read_bytes())
    files = receipt.get('files', receipt.get('ownedFiles'))
    assert type(files) is list
    owner_counts.append(len(files))
    for item in files:
        relative = item['path']
        actual = safe(relative)
        assert actual.stat().st_size == item['bytes'] and sha(actual) == item['sha256'], relative
        assert relative not in reviewed or reviewed[relative] == item['sha256']
        reviewed[relative] = item['sha256']
assert all(count > 0 for count in owner_counts) and len(reviewed) == sum(owner_counts)
for argument in args.pin:
    path, digest = pinned(argument)
    assert path not in pins
    pins[path] = digest

# Results are provenance, not source members or owner pins. The after maps are
# the exact browser inputs; result screenshots/logs and future records stay out.
assert len(args.browser) == 2
browser_refs, browser_inputs, engines = [], None, set()
for argument in args.browser:
    path, digest = pinned(argument)
    result = json.loads(safe(path).read_bytes())
    assert result['engine'] in ('chromium', 'webkit') and result['engine'] not in engines
    engines.add(result['engine'])
    assert result['passed'] is True and result['stable'] is True
    assert result['errors'] == [] and result['externalRequests'] == []
    assert result['before'] == result['after']
    assert browser_inputs is None or browser_inputs == result['after']
    browser_inputs = result['after']
    assert inv.snapshot(ROOT, list(browser_inputs)) == browser_inputs
    browser_refs.append({'path': path, 'sha256': digest, 'inputCount': len(browser_inputs)})

current = inv.live_source_paths(ROOT)
assert physical() == current
changed = subprocess.check_output(['git', 'diff', '--name-only', BASELINE, '--', 'src', 'src-tauri'], cwd=ROOT).decode().splitlines()
assert (set(changed) | (set(current) - set(base['currentSourcePaths']))) <= set(reviewed), 'Unreviewed source delta'
paths = sorted(set(base['paths']) | set(current) | set(DOCS) | set(pins)
               | set(reviewed) | set(browser_inputs) | set(AUXILIARY) | set(args.extra))
for path in paths:
    safe(path)
hashes = inv.snapshot(ROOT, paths)
assert all(hashes[path] == digest for path, digest in {**reviewed, **browser_inputs}.items())
assert current == inv.live_source_paths(ROOT) == physical()
assert all(sha(safe(path)) == digest for path, digest in pins.items())
assert all(sha(safe(item['path'])) == item['sha256'] for item in browser_refs)
adapter = str(Path(__file__).resolve().relative_to(ROOT))
pins[adapter] = sha(Path(__file__))
functional = (set(current) | set(reviewed) | set(browser_inputs) | set(AUXILIARY)
              | set(args.extra)) - set(DOCS)
# Documentation is snapshotted now and at final freeze, but can finish editing
# before that freeze without changing reviewed functional source.
plan = {'schema': 1, 'phase': 'PDF_SEARCH_PREPARATION_NOT_FINAL_FREEZE',
        'baselineCommit': BASELINE, 'inputCount': len(paths), 'paths': paths,
        'observedHashes': hashes, 'currentSourcePaths': current,
        'physicalSourceMembershipMatched': True,
        'ownedSourceAndFixturePins': {path: hashes[path] for path in sorted(functional)},
        'pinReceipts': pins, 'protected': inv.PROTECTED,
        'base': {'path': str(BASE.relative_to(ROOT)), 'sha256': BASE_SHA, 'count': 1842},
        'addedPaths': sorted(set(paths) - set(base['paths'])),
        'removedPaths': sorted(set(base['paths']) - set(paths)),
        'changedFromBasePaths': sorted(path for path in base['paths'] if base['observedHashes'][path] != hashes[path]),
        'original122TitlesConditionsHeld': True, 'new28ConditionsHeld': True,
        'currentDocs': DOCS, 'ownerSourceCount': len(reviewed), 'browserInputProvenance': browser_refs,
        'runner': {'path': str(RUNNER.relative_to(ROOT)), 'sha256': RUNNER_SHA},
        'helper': {'path': str(HELPER.relative_to(ROOT)), 'sha256': HELPER_SHA},
        'boundary': 'Preparation only. Browser results are not source inputs/pins; their exact before/after input maps are. Four docs may finish before root final freeze; explicit extras are final pinned inputs. No input is silently excluded from candidate commit requirements. Full checks not run.'}
out = Path(args.out).absolute()
assert out.parent == OUT and out.suffix == '.json' and not out.is_symlink()
inv.write_exclusive(out, plan)
print(json.dumps({'path': str(out.relative_to(ROOT)), 'inputCount': len(paths),
                  'added': len(plan['addedPaths']), 'removed': len(plan['removedPaths']), 'sha256': sha(out)}))
