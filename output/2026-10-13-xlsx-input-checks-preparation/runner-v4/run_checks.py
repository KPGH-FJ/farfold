"""v4: seven actual commands once, frontend4 then native3 sequentially; never retry."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
import importlib.util
ROOT = Path('/Users/tw/Desktop/farfold')
PREP = Path(__file__).resolve().parent
PINNED_INVENTORY = ROOT / 'output/2026-10-13-xlsx-input-checks-preparation/inventory.py'
PINNED_INVENTORY_SHA = '7784a38803fb1c10da014755cde9901f9deba982ffb01ab1076dfd2060e3e076'
if hashlib.sha256(PINNED_INVENTORY.read_bytes()).hexdigest() != PINNED_INVENTORY_SHA:
    raise ValueError('Pinned prior inventory helper changed')
_inventory_spec = importlib.util.spec_from_file_location('xlsx_inventory_v4_pinned', PINNED_INVENTORY)
_inventory = importlib.util.module_from_spec(_inventory_spec)
_inventory_spec.loader.exec_module(_inventory)
PROTECTED = _inventory.PROTECTED
snapshot, live_source_paths = _inventory.snapshot, _inventory.live_source_paths
oracle_exception, read, sha = _inventory.oracle_exception, _inventory.read, _inventory.sha
safe_file, write_exclusive = _inventory.safe_file, _inventory.write_exclusive

GROUPS = {
    'frontend': [
        ('format-check', ['corepack', 'pnpm', 'format:check']),
        ('typecheck', ['corepack', 'pnpm', 'typecheck']),
        ('frontend-test', ['corepack', 'pnpm', 'test']),
        ('frontend-build', ['corepack', 'pnpm', 'build']),
    ],
    'native': [
        ('cargo-fmt', ['cargo', 'fmt', '--check', '--manifest-path', 'src-tauri/Cargo.toml']),
        ('cargo-clippy', ['cargo', 'clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--', '-D', 'warnings']),
        ('cargo-test', ['cargo', 'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']),
    ],
}


def utc():
    return datetime.now(timezone.utc).isoformat()


def tool_hashes():
    return {str(PINNED_INVENTORY): sha(PINNED_INVENTORY),
            str(Path(__file__).resolve()): sha(Path(__file__).resolve())}


def verify_tools(expected):
    if expected != tool_hashes():
        raise ValueError('Runner/inventory bytes changed after final freeze')


def prepare_freeze(plan_path: Path, output: Path):
    plan = read(plan_path)
    if plan['schema'] != 1 or len(plan['paths']) != plan['inputCount']:
        raise ValueError('Invalid closed inventory plan')
    if live_source_paths(ROOT) != plan['currentSourcePaths']:
        raise ValueError('Source membership changed; amend additive closed plan before freezing')
    actual = snapshot(ROOT, plan['paths'])
    if snapshot(ROOT, list(plan['ownedSourceAndFixturePins'])) != plan['ownedSourceAndFixturePins']:
        raise ValueError('Frozen A/B source/fixture changed; explicit reviewed new pin needed')
    if snapshot(ROOT, list(PROTECTED)) != PROTECTED:
        raise ValueError('Protected PRODUCT/user-dirty README changed')
    for relative, digest in plan['pinReceipts'].items():
        if sha(safe_file(ROOT, relative)) != digest:
            raise ValueError('Owner freeze receipt changed')
    exception = oracle_exception(ROOT)
    output.mkdir(exist_ok=False)
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, check=True).stdout.decode().strip()
    freeze = {
        'schema': 1, 'phase': 'FINAL_ROOT_FREEZE_NO_ENGINEERING_COMMAND_EXECUTED',
        'capturedAt': utc(), 'root': str(ROOT), 'sourceHEAD': head,
        'inputCount': len(actual), 'inputs': actual, 'sourcePaths': plan['currentSourcePaths'],
        'protected': PROTECTED, 'tools': tool_hashes(),
        'inventoryPlan': {'path': str(plan_path), 'sha256': sha(plan_path)},
        'ownerFreezeReceipts': plan['pinReceipts'], 'exactOracleException': exception,
        'changesSincePreparation': [p for p in actual if actual[p] != plan['observedHashes'][p]],
        'groups': GROUPS, 'requiredCommandsExecuted': False,
    }
    write_exclusive(output / 'freeze.json', freeze)
    print(json.dumps({'phase': freeze['phase'], 'inputCount': len(actual), 'sha256': sha(output / 'freeze.json'),
                      'changesSincePreparation': freeze['changesSincePreparation']}), flush=True)
    return freeze


class Execution:
    def __init__(self, root: Path, output: Path, groups):
        self.root, self.output, self.groups = root, output, groups
        self.stop = threading.Event()
        self.lock = threading.RLock()
        self.event_lock = threading.Lock()
        self.interrupted_signal = None
        self.fatal_errors = []
        self.states = {name: {'name': name, 'group': group, 'argv': argv, 'state': 'NOT_STARTED',
                              'actualStageCompletion': False, 'processLaunched': False, 'rawExitCode': None}
                       for group, commands in groups.items() for name, argv in commands}
        self.event_handle = (output / 'events.jsonl').open('x', encoding='utf-8')

    def event(self, value):
        event = {'at': utc(), 'monotonic': time.monotonic(), **value}
        with self.event_lock:
            self.event_handle.write(json.dumps(event, ensure_ascii=False) + '\n')
            self.event_handle.flush()
        print(json.dumps(event, ensure_ascii=False), flush=True)

    def interrupted(self, signum):
        self.interrupted_signal = signum
        self.stop.set()

    def run_group(self, group, commands):
        try:
            for name, argv in commands:
                with self.lock:
                    if self.stop.is_set():
                        break
                    stage = self.states[name]
                    stage_dir = self.output / name
                    stage_dir.mkdir(exist_ok=False)
                    started = {'name': name, 'group': group, 'argv': argv, 'displayCommand': shlex.join(argv),
                               'cwd': str(self.root), 'startedAt': utc(), 'monotonicStart': time.monotonic()}
                    write_exclusive(stage_dir / 'started.json', started)
                    stage.update({'state': 'STARTED', **started})
                    self.event({'event': 'started', 'name': name, 'group': group})
                    stdout = (stage_dir / 'stdout.log').open('xb')
                    stderr = (stage_dir / 'stderr.log').open('xb')
                    try:
                        process = subprocess.Popen(argv, cwd=self.root, stdout=stdout, stderr=stderr)
                        stage.update({'processLaunched': True, 'pid': process.pid})
                    except Exception as error:
                        stdout.close()
                        stderr.close()
                        self.stop.set()
                        stage.update({'state': 'LAUNCH_FAILED', 'launchError': type(error).__name__ + ': ' + str(error),
                                      'completedAt': utc(), 'actualStageCompletion': False})
                        write_exclusive(stage_dir / 'launch-failed.json', stage)
                        self.event({'event': 'launch-failed', 'name': name, 'rawExitCode': None})
                        break
                raw_exit = process.wait()
                stdout.close()
                stderr.close()
                with self.lock:
                    # Stop becomes visible before any next stage can acquire the launch lock.
                    if raw_exit != 0:
                        self.stop.set()
                    stage.update({'state': 'COMPLETED', 'completedAt': utc(), 'rawExitCode': raw_exit,
                                  'actualStageCompletion': True, 'elapsedSeconds': time.monotonic() - started['monotonicStart'],
                                  'stdoutSha256': sha(stage_dir / 'stdout.log'), 'stderrSha256': sha(stage_dir / 'stderr.log')})
                    write_exclusive(stage_dir / 'completed.json', stage)
                    self.event({'event': 'completed', 'name': name, 'group': group, 'rawExitCode': raw_exit,
                                'actualStageCompletion': True})
        except BaseException as error:
            with self.lock:
                self.stop.set()
                self.fatal_errors.append({'group': group, 'error': type(error).__name__ + ': ' + str(error)})
            self.event({'event': 'runner-group-error', 'group': group, 'error': str(error)})

    def run(self):
        # v4: frontend4 must actually finish before native3 starts. A failure or
        # external stop leaves every not-yet-started stage NOT_STARTED.
        for group, commands in self.groups.items():
            if self.stop.is_set():
                break
            self.run_group(group, commands)
        self.event_handle.close()
        return list(self.states.values())


def evaluate(stages, before, after, protected_before, protected_after, source_before, source_after,
             required_count, interrupted_signal=None, errors=None):
    return {
        'allPassed': len(stages) == required_count and all(s['actualStageCompletion'] and s['rawExitCode'] == 0 for s in stages)
                     and before == after and protected_before == protected_after and source_before == source_after
                     and interrupted_signal is None and not errors,
        'sourceStable': before == after, 'sourceMembershipStable': source_before == source_after,
        'protectedUnchanged': protected_before == protected_after,
        'completedCount': sum(s['actualStageCompletion'] for s in stages),
        'notStarted': [s['name'] for s in stages if s['state'] == 'NOT_STARTED'],
        'failed': [s['name'] for s in stages if s['actualStageCompletion'] and s['rawExitCode'] != 0],
        'launchFailed': [s['name'] for s in stages if s['state'] == 'LAUNCH_FAILED'],
    }


def execute(freeze_path: Path, output: Path):
    # Existence blocks duplicate/retry execution before any command is launched.
    output.mkdir(exist_ok=False)
    freeze = read(freeze_path)
    preflight = {'at': utc(), 'freezePath': str(freeze_path), 'freezeSha256': sha(freeze_path), 'passed': False}
    before, protected_before, source_before = {}, {}, []
    try:
        if (freeze['schema'] != 1 or freeze['root'] != str(ROOT)
                or freeze['inputCount'] != len(freeze['inputs'])
                or freeze['protected'] != PROTECTED
                or freeze['groups'] != json.loads(json.dumps(GROUPS))):
            raise ValueError('Invalid final freeze/required command set')
        verify_tools(freeze['tools'])
        plan_path = Path(freeze['inventoryPlan']['path'])
        if sha(plan_path) != freeze['inventoryPlan']['sha256']:
            raise ValueError('Closed inventory plan changed')
        plan = read(plan_path)
        if (sorted(freeze['inputs']) != plan['paths'] or freeze['sourcePaths'] != plan['currentSourcePaths']
                or freeze['ownerFreezeReceipts'] != plan['pinReceipts']):
            raise ValueError('Final freeze does not retain the closed inventory scope')
        before = snapshot(ROOT, list(freeze['inputs']))
        source_before = live_source_paths(ROOT)
        protected_before = snapshot(ROOT, list(PROTECTED))
        if before != freeze['inputs'] or source_before != freeze['sourcePaths'] or protected_before != freeze['protected']:
            raise ValueError('Source/protected bytes or closed membership differ from final freeze')
        if oracle_exception(ROOT) != freeze['exactOracleException']:
            raise ValueError('Oracle exact formatting exception differs')
        for relative, digest in freeze['ownerFreezeReceipts'].items():
            if sha(safe_file(ROOT, relative)) != digest:
                raise ValueError('Owner source-freeze receipt differs')
        preflight['passed'] = True
    except Exception as error:
        preflight['error'] = type(error).__name__ + ': ' + str(error)
        write_exclusive(output / 'preflight.json', preflight)
        write_exclusive(output / 'summary.json', {'phase': 'NOT_EXECUTED_PREFLIGHT_FAILED', 'allPassed': False,
                                                'requiredCommandsExecuted': 0, 'preflight': preflight})
        print(json.dumps(preflight), flush=True)
        return 2
    write_exclusive(output / 'preflight.json', preflight)
    write_exclusive(output / 'inputs-before.json', before)
    write_exclusive(output / 'protected-before.json', protected_before)
    execution = Execution(ROOT, output, GROUPS)
    previous_handlers = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, lambda signum, _frame: execution.interrupted(signum))
    try:
        stages = execution.run()
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    final_errors = list(execution.fatal_errors)
    try:
        after = snapshot(ROOT, list(before))
        protected_after = snapshot(ROOT, list(PROTECTED))
        source_after = live_source_paths(ROOT)
        verify_tools(freeze['tools'])
    except Exception as error:
        after, protected_after, source_after = {}, {}, []
        final_errors.append({'finalSnapshot': type(error).__name__ + ': ' + str(error)})
    write_exclusive(output / 'inputs-after.json', after)
    write_exclusive(output / 'protected-after.json', protected_after)
    outcome = evaluate(stages, before, after, protected_before, protected_after, source_before, source_after,
                       7, execution.interrupted_signal, final_errors)
    summary = {'schema': 1, 'phase': 'ACTUAL_COMMAND_RESULTS', 'capturedAt': utc(),
               'freezeSha256': sha(freeze_path), 'inputCount': len(before),
               'requiredCommandsExecuted': sum(s['processLaunched'] for s in stages),
               'checks': stages, 'interruptedSignal': execution.interrupted_signal, 'runnerErrors': final_errors,
               'testCounts': 'Not inferred from status; exact stdout/stderr are authoritative for counts.',
               'boundary': 'Engineering checks only; installed App, native document workflow, actual Agent, P08 or whole plan acceptance are separate.',
               **outcome}
    write_exclusive(output / 'summary.json', summary)
    print(json.dumps({key: summary[key] for key in ('phase', 'allPassed', 'inputCount', 'completedCount',
                                                  'sourceStable', 'sourceMembershipStable', 'protectedUnchanged',
                                                  'notStarted', 'failed', 'launchFailed')}), flush=True)
    return 130 if execution.interrupted_signal else (0 if outcome['allPassed'] else 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare-freeze', type=Path, metavar='INVENTORY_PLAN')
    mode.add_argument('--execute', type=Path, metavar='FINAL_FREEZE')
    parser.add_argument('--out', type=Path, required=True, help='New, previously absent directory under repository output/')
    args = parser.parse_args()
    if not args.out.resolve().is_relative_to((ROOT / 'output').resolve()):
        raise ValueError('New run output must remain under repository output/')
    if args.prepare_freeze:
        prepare_freeze(args.prepare_freeze.resolve(), args.out.resolve())
        return 0
    return execute(args.execute.resolve(), args.out.resolve())


if __name__ == '__main__':
    sys.exit(main())
