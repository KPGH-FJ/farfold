"""Installed-app numeric timing capture; no UI, Agent requests, or fixture changes.

Usage (run only after the existing formal app has exited normally):
  python3 performance_capture.py capture --run candidate4-perf
In another terminal, bracket each warmed-up round:
  python3 performance_capture.py start --run candidate4-perf --round history-r1 --scene history1000
  python3 performance_capture.py report --run candidate4-perf --round history-r1
  python3 performance_capture.py end --run candidate4-perf --round history-r1
  python3 performance_capture.py report --run candidate4-perf
  python3 performance_capture.py self-test

Only capture launches anything: the fixed installed application, with its existing
FARFOLD_PERF_TRACE switch and otherwise inherited environment. Keep this collector
alive until normal app exit. Ctrl-C/TERM do not kill the app or close its stderr.
All artifacts are new run-specific files next to this script; old runs are never
overwritten. Rounds select complete sample sequence numbers, not wall-clock time.
End a round only after the final expected samples have arrived. Timing results do
not themselves establish workload size, sustained dual streams, or acceptance.

2026-09-27 clock investigation: candidate4-perf used Apple Python 3.9.6.
Its captureStarted.monotonicNs was 183657333; a separate marking process returned
28208250, while the collector's 27th sample was 508358021625. These are different
process origins, not proof of a reboot. Python documents macOS cross-process
monotonic consistency only from 3.10: https://docs.python.org/3/library/time.html
Sequence boundaries preserve that live collector and its original sample bytes.
Boot UUID plus the installed process PID/executable/start identity guard against
stale runs; no wall-to-monotonic approximation or clock-jump tolerance is used.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
APP = Path('/Applications/Farfold.app/Contents/MacOS/farfold')
SCENES = ('text128_loaded', 'dual64_loaded', 'history1000', 'dual64_live')
REQUIRED_SCENES = ('text128_loaded', 'dual64_live', 'history1000')
METRICS = {
    'ShellReady', 'SidebarReady', 'PiResume', 'OpencodeResume', 'CodexResume',
    'PiEventPaint', 'OpencodeEventPaint', 'CodexEventPaint', 'InputPaint', 'ThreadSwitch',
}
LABEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')
TRACE = re.compile(
    r'\[farfold-perf\] ([A-Za-z]+) (\d+(?:\.\d+)?)ms '
    r'ready=(\d+(?:\.\d+)?) paint=(\d+(?:\.\d+)?) '
    r'visible=([01]) focused=([01]) visibility_changed=([01])\Z'
)


def stamp():
    return {'utc': dt.datetime.now(dt.timezone.utc).isoformat(),
            'monotonicNs': time.monotonic_ns()}


def label(value):
    if not LABEL.fullmatch(value):
        raise ValueError('Run and round labels require 1-64 ASCII letters, digits, _ or -.')
    return value


def paths(run):
    prefix = ROOT / ('performance-' + label(run))
    return {name: Path(str(prefix) + suffix) for name, suffix in (
        ('metadata', '.metadata.json'), ('samples', '.samples.jsonl'),
        ('rounds', '.rounds.jsonl'))}


def parse_sample(raw):
    # A prefix alone is insufficient: reject unknown metrics, trailing material,
    # nonnumeric fields and out-of-range values without ever persisting the line.
    try:
        line = raw.decode('ascii').rstrip('\r\n') if isinstance(raw, bytes) else raw.rstrip('\r\n')
    except UnicodeDecodeError:
        return None
    match = TRACE.fullmatch(line)
    if not match or match[1] not in METRICS:
        return None
    values = [float(match[i]) for i in (2, 3, 4)]
    if not all(math.isfinite(v) and 0 <= v <= 300000 for v in values):
        return None
    return {'line': line, 'metric': match[1], 'milliseconds': values[0],
            'readyMilliseconds': values[1], 'paintWaitMilliseconds': values[2],
            'visible': match[5] == '1', 'focused': match[6] == '1',
            'visibilityChanged': match[7] == '1'}


def bounded_lines(stream, limit=1024):
    pending = b''
    dropping = False
    while True:
        chunk = stream.read1(4096) if hasattr(stream, 'read1') else stream.read(4096)
        if not chunk:
            return  # A partial last line cannot be a complete diagnostic record.
        for part in chunk.splitlines(keepends=True):
            complete = part.endswith(b'\n')
            if not dropping:
                pending += part
                if len(pending) > limit:
                    pending = b''
                    dropping = True
            if complete:
                if not dropping:
                    yield pending
                pending = b''
                dropping = False


def installed_processes(ps_output):
    result = []
    for line in ps_output.splitlines():
        pieces = line.strip().split(None, 1)
        if len(pieces) != 2 or not pieces[0].isdigit():
            continue
        pid, command = pieces
        # comm is executable identity, never process arguments or environment.
        # Conservatively refuse another farfold executable as well.
        if command == str(APP) or Path(command).name.lower() == 'farfold':
            result.append(int(pid))
    return result


def ensure_no_app():
    check = subprocess.run(['/bin/ps', '-axo', 'pid=,comm=', '-ww'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           text=True, check=True)
    found = installed_processes(check.stdout)
    if found:
        raise RuntimeError('Refusing duplicate app launch; existing PID(s): ' + ', '.join(map(str, found)))


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_metadata(path, data):
    temporary = path.with_suffix('.pending')
    with temporary.open('w') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def boot_session_id():
    value = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'],
                                    stderr=subprocess.DEVNULL, text=True).strip()
    if not re.fullmatch(r'[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}', value):
        raise RuntimeError('Cannot establish the current boot identity.')
    return value.upper()


def inspect_app_process(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise RuntimeError('The run has no valid installed process identity.')
    environment = dict(os.environ, LC_ALL='C', TZ='UTC')
    result = subprocess.check_output(['/bin/ps', '-p', str(pid), '-o', 'lstart=,comm=', '-ww'],
                                     env=environment, stderr=subprocess.DEVNULL, text=True).strip()
    match = re.fullmatch(r'(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+)', result)
    if not match:
        raise RuntimeError('Cannot establish the installed process start identity.')
    started = dt.datetime.strptime(match[1], '%a %b %d %H:%M:%S %Y').replace(tzinfo=dt.timezone.utc)
    return {'pid': pid, 'application': match[2], 'startedUtc': started.isoformat()}


def verify_capture_identity(metadata, boot_id, process):
    if metadata.get('bootSessionUuid', boot_id) != boot_id:
        raise RuntimeError('The run belongs to a previous boot session.')
    if process['pid'] != metadata.get('pid') or process['application'] != str(APP):
        raise RuntimeError('The installed process no longer matches this run.')
    # Compare two recorded creation times, never elapsed time against today's wall
    # clock. Legacy live captures lack a boot UUID; PID + exact executable + start
    # identity still prevent accepting a stale metadata file after process reuse.
    original = dt.datetime.fromisoformat(metadata['processStarted']['utc'])
    actual = dt.datetime.fromisoformat(process['startedUtc'])
    if abs((actual - original).total_seconds()) >= 2:
        raise RuntimeError('The installed PID has been reused or its start cannot be verified.')


def ensure_collector_alive():
    with (ROOT / '.performance-capture.lock').open('r') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        fcntl.flock(lock, fcntl.LOCK_UN)
    raise RuntimeError('No live collector owns this run; refusing a new boundary.')


def capture(run):
    output = paths(run)
    ensure_no_app()
    if not APP.is_file():
        raise RuntimeError('The unique installed application does not exist.')
    with (ROOT / '.performance-capture.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another timing collector owns the launch lock.')
        ensure_no_app()
        if any(path.exists() for path in output.values()):
            raise RuntimeError('This run label already has evidence; choose a new label.')
        metadata = {'schemaVersion': 1, 'run': run, 'application': str(APP),
                    'installedSha256': digest(APP), 'captureStarted': stamp(),
                    'bootSessionUuid': boot_session_id(),
                    'pid': None, 'state': 'starting', 'samples': 0,
                    'clockMeaning': 'sample receipt time; duration comes from installed two-rAF trace',
                    'workloadVerifiedByCollector': False}
        # Exclusive reservations never replace earlier evidence.
        for path in output.values():
            with path.open('x'):
                pass
        write_metadata(output['metadata'], metadata)
        ensure_no_app()  # Final check immediately before starting the fixed app.
        environment = dict(os.environ)
        environment['FARFOLD_PERF_TRACE'] = '1'  # Existing numeric diagnostic only.
        try:
            child = subprocess.Popen([str(APP)], env=environment,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     start_new_session=True)
        except Exception as error:
            metadata.update(state='launch_failed', failureType=type(error).__name__, ended=stamp())
            write_metadata(output['metadata'], metadata)
            raise RuntimeError('Installed application launch failed; evidence retained.') from None
        metadata.update(pid=child.pid, processStarted=stamp(), state='running')
        # Do not let a terminal interrupt close the pipe or terminate user work.
        def keep_capturing(_signum, _frame):
            print('Collector remains active. Quit Farfold normally to finish capture.', file=sys.stderr, flush=True)
        signal.signal(signal.SIGINT, keep_capturing)
        signal.signal(signal.SIGTERM, keep_capturing)
        storage_failure = None
        try:
            write_metadata(output['metadata'], metadata)
        except OSError as error:
            storage_failure = type(error).__name__
        print(json.dumps({'pid': child.pid, 'run': run,
                          'installedSha256': metadata['installedSha256'],
                          'files': {k: str(v) for k, v in output.items()}}), flush=True)
        stream = None
        try:
            try:
                stream = output['samples'].open('a')
            except OSError as error:
                storage_failure = type(error).__name__
            for raw in bounded_lines(child.stderr):
                sample = parse_sample(raw)
                if sample is None:
                    continue  # Discard all other stderr, including Agent output.
                if storage_failure:
                    continue  # Keep draining; never kill the app on a disk error.
                sample.update(received=stamp(), sequence=metadata['samples'] + 1)
                try:
                    stream.write(json.dumps(sample, ensure_ascii=True) + '\n')
                    stream.flush()
                    metadata['samples'] += 1
                except OSError as error:
                    storage_failure = type(error).__name__
        finally:
            if stream:
                try:
                    stream.close()
                except OSError as error:
                    storage_failure = type(error).__name__
        metadata.update(exitCode=child.wait(), ended=stamp(), state='exited',
                        storageFailure=storage_failure)
        try:
            metadata['installedSha256AtEnd'] = digest(APP)
            metadata['installedUnchanged'] = metadata['installedSha256AtEnd'] == metadata['installedSha256']
        except OSError:
            metadata['installedUnchanged'] = False
        write_metadata(output['metadata'], metadata)
        print(json.dumps({'state': metadata['state'], 'exitCode': metadata['exitCode'],
                          'samples': metadata['samples'], 'storageFailure': storage_failure}), flush=True)
        return 0 if not storage_failure and metadata['installedUnchanged'] and metadata['exitCode'] == 0 else 1


def records(path):
    text = path.read_text()
    lines = text.splitlines(keepends=True)
    # A currently flushing final line is retried on the next read, never invented.
    return [json.loads(line) for line in lines if line.endswith('\n') and line.strip()]


def add_boundary(previous, kind, round_id, scene, when, after_sequence=None, boot_id=None):
    label(round_id)
    if after_sequence is not None:
        if not isinstance(after_sequence, int) or after_sequence < 0 or not boot_id:
            raise ValueError('Sequence boundaries require a nonnegative sequence and boot identity.')
        if any(r.get('bootSessionUuid') != boot_id for r in previous):
            raise ValueError('Round boundaries cannot cross boot sessions or mix clock bases.')
    starts = {r['round']: r for r in previous if r['kind'] == 'start'}
    ended = {r['round'] for r in previous if r['kind'] == 'end'}
    if kind == 'start':
        if scene not in SCENES or round_id in starts:
            raise ValueError('Invalid scene or duplicate round label.')
        if set(starts) - ended:
            raise ValueError('End the current round before starting another.')
    else:
        if round_id not in starts or round_id in ended:
            raise ValueError('No unique open round with this label.')
        start = starts[round_id]
        if after_sequence is not None:
            if 'afterSequence' not in start or after_sequence < start['afterSequence']:
                raise ValueError('Round sequence cannot rewind or mix clock bases.')
        elif 'afterSequence' in start or when['monotonicNs'] <= start['at']['monotonicNs']:
            raise ValueError('Round end must be after start on the same clock basis.')
        scene = starts[round_id]['scene']
    boundary = {'kind': kind, 'round': round_id, 'scene': scene, 'at': when}
    if after_sequence is not None:
        boundary.update(afterSequence=after_sequence, bootSessionUuid=boot_id,
                        selectionBasis='complete_sample_sequence')
    return boundary


def mark(run, kind, round_id, scene=None):
    output = paths(run)
    metadata = json.loads(output['metadata'].read_text())
    if metadata.get('state') != 'running':
        raise RuntimeError('Round boundaries require this collector to be running.')
    ensure_collector_alive()
    boot_id = boot_session_id()
    verify_capture_identity(metadata, boot_id, inspect_app_process(metadata['pid']))
    with output['rounds'].open('r+') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        previous = [json.loads(line) for line in stream if line.strip()]
        samples = records(output['samples'])
        after_sequence = samples[-1]['sequence'] if samples else 0
        boundary = add_boundary(previous, kind, round_id, scene, stamp(), after_sequence, boot_id)
        stream.seek(0, os.SEEK_END)
        stream.write(json.dumps(boundary) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps(boundary))
    return 0


def nearest_rank(values, percentile=0.95):
    if not values:
        return None
    return sorted(values)[max(0, math.ceil(percentile * len(values)) - 1)]


def summarize_round(samples, start, end):
    sequence_based = 'afterSequence' in start
    if end and sequence_based != ('afterSequence' in end):
        raise ValueError('Cannot summarize mixed boundary clock bases.')
    if sequence_based:
        if not start.get('bootSessionUuid') or (end and start['bootSessionUuid'] != end.get('bootSessionUuid')):
            raise ValueError('Cannot summarize boundaries from different boot sessions.')
        left = start['afterSequence']
        right = end['afterSequence'] if end else math.inf
        if right < left:
            raise ValueError('Round sequence cannot rewind.')
        within = [s for s in samples if left < s['sequence'] <= right]
    else:
        # Preserve the meaning of old evidence; never reinterpret stored markers.
        left = start['at']['monotonicNs']
        right = end['at']['monotonicNs'] if end else math.inf
        within = [s for s in samples if left <= s['received']['monotonicNs'] < right]
    target = [s for s in within if s['metric'] in ('InputPaint', 'ThreadSwitch')]
    valid = [s for s in target if s['visible'] and s['focused'] and not s['visibilityChanged']]
    result = {'round': start['round'], 'scene': start['scene'], 'start': start['at'],
              'end': end['at'] if end else None, 'closed': end is not None,
              'selectionBasis': 'complete_sample_sequence' if sequence_based else 'legacy_monotonic_clock',
              'excludedVisibilityOrFocus': len(target) - len(valid),
              'otherMetrics': len(within) - len(target), 'metrics': {}, 'failures': []}
    if end is None:
        result['failures'].append('round_has_no_end_boundary')
    for metric, required, budget in [('InputPaint', 100, 100), ('ThreadSwitch', 30, 200)]:
        values = [s['milliseconds'] for s in valid if s['metric'] == metric]
        p95 = nearest_rank(values)
        count_ok = len(values) == required
        result['metrics'][metric] = {'count': len(values), 'requiredCount': required,
                                      'p95Ms': p95, 'maxMs': max(values) if values else None,
                                      'budgetMs': budget,
                                      'pass': count_ok and p95 is not None and p95 <= budget}
        if not count_ok:
            result['failures'].append(metric + ('_insufficient_samples' if len(values) < required else '_unexpected_extra_samples'))
        if p95 is not None and p95 > budget:
            result['failures'].append(metric + '_p95_over_budget')
    result['timingPass'] = not result['failures']
    result['workloadAndLiveOverlapVerified'] = False
    return result


def report(run, only_round=None):
    output = paths(run)
    metadata = json.loads(output['metadata'].read_text())
    samples = records(output['samples'])
    boundaries = records(output['rounds'])
    starts = [r for r in boundaries if r['kind'] == 'start']
    ends = {r['round']: r for r in boundaries if r['kind'] == 'end'}
    if only_round:
        starts = [r for r in starts if r['round'] == only_round]
        if not starts:
            raise ValueError('Requested round was not found.')
    summaries = [summarize_round(samples, r, ends.get(r['round'])) for r in starts]
    matrix = {scene: {'rounds': sum(r['scene'] == scene for r in summaries),
                      'passed': sum(r['scene'] == scene and r['timingPass'] for r in summaries),
                      'requiredRounds': 3 if scene in REQUIRED_SCENES else 0} for scene in SCENES}
    selected_pass = bool(summaries) and all(r['timingPass'] for r in summaries)
    capture_ok = metadata.get('state') in ('running', 'exited') and not metadata.get('storageFailure') and metadata.get('installedUnchanged', True) and (metadata.get('state') == 'running' or metadata.get('exitCode') == 0)
    result = {'run': run, 'application': metadata['application'], 'pid': metadata['pid'],
              'installedSha256': metadata['installedSha256'], 'captureState': metadata['state'],
              'captureFinalized': metadata.get('state') == 'exited',
              'captureIntegrityPass': bool(capture_ok), 'rounds': summaries, 'matrix': matrix,
              'selectedRoundsTimingPass': selected_pass and bool(capture_ok),
              'requiredMatrixScenes': REQUIRED_SCENES,
              'completeMatrixTimingPass': not only_round and selected_pass and bool(capture_ok) and all(v['passed'] >= v['requiredRounds'] for v in matrix.values()),
              'overallProductAcceptance': 'not_determined',
              'limits': ['Two-rAF event-to-paint-opportunity durations, not CUA/OS/CPU timing.',
                         'New boundaries select complete saved sample sequences; timestamps are informational only.',
                         'Wait for final samples before ending; process-local monotonic clocks are never compared across new boundaries.',
                         'Validate load bytes/history rows and both live-stream intervals separately.',
                         'Loaded dual64 rounds never substitute for sustained dual64 rounds.',
                         'App trace stops after 4096 total samples; missing samples fail rather than being filled.']}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if (result['selectedRoundsTimingPass'] if only_round else result['completeMatrixTimingPass']) else 1


class PureDataTests(unittest.TestCase):
    def test_numeric_whitelist(self):
        s = parse_sample(b'[farfold-perf] InputPaint 25.0ms ready=1.0 paint=24.0 visible=1 focused=1 visibility_changed=0\n')
        self.assertEqual(s['milliseconds'], 25)
        self.assertTrue(s['focused'])

    def test_never_keeps_unapproved_stderr(self):
        for value in ('secret', '[farfold-perf] SECRET 1ms ready=0 paint=1 visible=1 focused=1 visibility_changed=0',
                      '[farfold-perf] InputPaint 1ms ready=0 paint=1 visible=1 focused=1 visibility_changed=0 secret',
                      '[farfold-perf] InputPaint 300001ms ready=0 paint=1 visible=1 focused=1 visibility_changed=0',
                      '[farfold-perf] InputPaint nanms ready=0 paint=1 visible=1 focused=1 visibility_changed=0'):
            self.assertIsNone(parse_sample(value))

    def test_bounded_lines_discard_oversize_and_partial(self):
        self.assertEqual(list(bounded_lines(io.BytesIO(b'x' * 5000 + b'\nok\npartial'))), [b'ok\n'])

    def test_process_detection_uses_executable_not_arguments(self):
        found = installed_processes(' 42 /Applications/Farfold.app/Contents/MacOS/farfold\n43 /usr/bin/python3\n44 farfold\n45 /tmp/other\n')
        self.assertEqual(found, [42, 44])

    def test_existing_app_refuses_launch_without_running_any_process(self):
        fake = subprocess.CompletedProcess([], 0, stdout='42 /Applications/Farfold.app/Contents/MacOS/farfold\n')
        with patch.object(subprocess, 'run', return_value=fake) as inspect, patch.object(subprocess, 'Popen') as launch:
            with self.assertRaises(RuntimeError):
                ensure_no_app()
            inspect.assert_called_once()
            launch.assert_not_called()

    def test_unsafe_labels(self):
        for value in ('../candidate', '', 'a/b', 'a b'):
            with self.assertRaises(ValueError):
                label(value)

    def test_p95_nearest_rank(self):
        self.assertEqual(nearest_rank(list(range(1, 101))), 95)
        self.assertEqual(nearest_rank(list(range(1, 31))), 29)
        self.assertIsNone(nearest_rank([]))

    def round_data(self):
        start = {'round': 'r1', 'scene': 'history1000', 'kind': 'start', 'at': {'monotonicNs': 10}}
        end = {'round': 'r1', 'kind': 'end', 'at': {'monotonicNs': 1000}}
        samples = [{'metric': metric, 'milliseconds': duration, 'visible': True,
                    'focused': True, 'visibilityChanged': False, 'received': {'monotonicNs': 100}}
                   for metric, count, duration in [('InputPaint', 100, 100), ('ThreadSwitch', 30, 200)] for _ in range(count)]
        return samples, start, end

    def test_exact_thresholds_pass(self):
        self.assertTrue(summarize_round(*self.round_data())['timingPass'])

    def test_missing_samples_fail_and_invalid_focus_is_excluded(self):
        samples, start, end = self.round_data()
        samples[0]['focused'] = False
        result = summarize_round(samples, start, end)
        self.assertFalse(result['timingPass'])
        self.assertEqual(result['metrics']['InputPaint']['count'], 99)
        self.assertEqual(result['excludedVisibilityOrFocus'], 1)

    def test_hidden_and_visibility_changed_samples_are_excluded(self):
        samples, start, end = self.round_data()
        samples[0]['visible'] = False
        samples[1]['visibilityChanged'] = True
        result = summarize_round(samples, start, end)
        self.assertEqual(result['metrics']['InputPaint']['count'], 98)
        self.assertEqual(result['excludedVisibilityOrFocus'], 2)
        self.assertFalse(result['timingPass'])

    def test_time_boundaries_are_half_open(self):
        samples, start, end = self.round_data()
        samples[0]['received']['monotonicNs'] = 9
        samples[1]['received']['monotonicNs'] = 1000
        self.assertEqual(summarize_round(samples, start, end)['metrics']['InputPaint']['count'], 98)

    def test_open_round_and_extra_samples_fail(self):
        samples, start, end = self.round_data()
        self.assertFalse(summarize_round(samples, start, None)['timingPass'])
        samples.append(dict(samples[0]))
        self.assertFalse(summarize_round(samples, start, end)['timingPass'])

    def test_over_budget_not_hidden(self):
        samples, start, end = self.round_data()
        for sample in samples[:6]:
            sample['milliseconds'] = 101
        self.assertFalse(summarize_round(samples, start, end)['timingPass'])

    def test_duplicate_and_overlapping_boundaries_rejected(self):
        first = add_boundary([], 'start', 'r1', 'history1000', {'monotonicNs': 10})
        with self.assertRaises(ValueError):
            add_boundary([first], 'start', 'r2', 'dual64_live', {'monotonicNs': 11})
        with self.assertRaises(ValueError):
            add_boundary([first], 'end', 'r1', None, {'monotonicNs': 9})
        end = add_boundary([first], 'end', 'r1', None, {'monotonicNs': 12})
        with self.assertRaises(ValueError):
            add_boundary([first, end], 'end', 'r1', None, {'monotonicNs': 13})

    def test_sequence_boundaries_ignore_process_local_clock_origins(self):
        samples, start, end = self.round_data()
        for sequence, sample in enumerate(samples, 1):
            sample.update(sequence=sequence, received={'monotonicNs': 508_000_000_000})
        start.update(afterSequence=0, bootSessionUuid='boot-a')
        end.update(afterSequence=130, bootSessionUuid='boot-a')
        start['at']['monotonicNs'] = 183_657_333
        end['at']['monotonicNs'] = 28_208_250
        self.assertTrue(summarize_round(samples, start, end)['timingPass'])

    def test_sequence_boundaries_exclude_before_start_and_after_end(self):
        samples, start, end = self.round_data()
        for sequence, sample in enumerate(samples, 1):
            sample['sequence'] = sequence
        start.update(afterSequence=1, bootSessionUuid='boot-a')
        end.update(afterSequence=129, bootSessionUuid='boot-a')
        result = summarize_round(samples, start, end)
        self.assertEqual(result['metrics']['InputPaint']['count'], 99)
        self.assertEqual(result['metrics']['ThreadSwitch']['count'], 29)
        self.assertFalse(result['timingPass'])

    def test_different_boot_and_mixed_boundary_bases_are_rejected(self):
        samples, start, end = self.round_data()
        start.update(afterSequence=0, bootSessionUuid='boot-a')
        with self.assertRaises(ValueError):
            summarize_round(samples, start, end)
        end.update(afterSequence=130, bootSessionUuid='boot-b')
        with self.assertRaises(ValueError):
            summarize_round(samples, start, end)

    def test_process_identity_accepts_legacy_run_but_rejects_pid_reuse_and_reboot(self):
        metadata = {'pid': 42, 'application': str(APP),
                    'processStarted': {'utc': '2026-09-27T07:14:26.113097+00:00'}}
        process = {'pid': 42, 'application': str(APP),
                   'startedUtc': '2026-09-27T07:14:26+00:00'}
        verify_capture_identity(metadata, 'boot-a', process)
        with self.assertRaises(RuntimeError):
            verify_capture_identity(metadata, 'boot-a', dict(process, startedUtc='2026-09-28T07:14:26+00:00'))
        with self.assertRaises(RuntimeError):
            verify_capture_identity(dict(metadata, bootSessionUuid='boot-b'), 'boot-a', process)
        with self.assertRaises(RuntimeError):
            verify_capture_identity(metadata, 'boot-a', dict(process, application='/tmp/farfold'))

    def test_sequence_end_allows_smaller_process_clock_but_not_sequence_rewind(self):
        first = add_boundary([], 'start', 'r1', 'history1000', {'monotonicNs': 200}, 12, 'boot-a')
        end = add_boundary([first], 'end', 'r1', None, {'monotonicNs': 20}, 142, 'boot-a')
        self.assertEqual(end['afterSequence'], 142)
        with self.assertRaises(ValueError):
            add_boundary([first], 'end', 'r1', None, {'monotonicNs': 300}, 11, 'boot-a')

    def test_mark_caller_keeps_sequence_with_wall_jump_and_process_local_clock(self):
        class MemoryFile(io.StringIO):
            def close(self):
                pass

            def fileno(self):
                return 123

        class MemoryPath:
            def __init__(self, text):
                self.stream = MemoryFile(text)

            def read_text(self):
                return self.stream.getvalue()

            def open(self, _mode):
                self.stream.seek(0)
                return self.stream

        metadata = {'state': 'running', 'pid': 42, 'application': str(APP),
                    'captureStarted': {'monotonicNs': 183_657_333},
                    'processStarted': {'utc': '2026-09-27T07:14:26.113097+00:00'}}
        process = {'pid': 42, 'application': str(APP), 'startedUtc': '2026-09-27T07:14:26+00:00'}
        output = {'metadata': MemoryPath(json.dumps(metadata)),
                  'samples': MemoryPath(json.dumps({'sequence': 27}) + '\n'),
                  'rounds': MemoryPath('')}
        when = {'utc': '2026-09-27T06:00:00+00:00', 'monotonicNs': 28_208_250}
        with patch(__name__ + '.paths', return_value=output), \
                patch(__name__ + '.ensure_collector_alive'), \
                patch(__name__ + '.boot_session_id', return_value='boot-a'), \
                patch(__name__ + '.inspect_app_process', return_value=process), \
                patch(__name__ + '.stamp', return_value=when), \
                patch.object(fcntl, 'flock'), patch.object(os, 'fsync'), patch('builtins.print'):
            self.assertEqual(mark('run', 'start', 'r1', 'history1000'), 0)
        marker = json.loads(output['rounds'].read_text())
        self.assertEqual(marker['afterSequence'], 27)
        self.assertEqual(marker['bootSessionUuid'], 'boot-a')
        self.assertEqual(marker['selectionBasis'], 'complete_sample_sequence')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('capture', 'start', 'end', 'report'):
        sub = commands.add_parser(name)
        sub.add_argument('--run', required=True, type=label)
        if name in ('start', 'end'):
            sub.add_argument('--round', required=True, type=label)
        if name == 'start':
            sub.add_argument('--scene', required=True, choices=SCENES)
        if name == 'report':
            sub.add_argument('--round', type=label)
    commands.add_parser('self-test')
    args = parser.parse_args()
    if args.command == 'self-test':
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(PureDataTests))
        return 0 if result.wasSuccessful() else 1
    try:
        if args.command == 'capture':
            return capture(args.run)
        if args.command == 'report':
            return report(args.run, args.round)
        return mark(args.run, args.command, args.round, getattr(args, 'scene', None))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
