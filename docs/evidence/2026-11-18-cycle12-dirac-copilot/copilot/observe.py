from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parent
fixture = json.loads((root / 'fixture.json').read_text())


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as handle:
        json.dump(value, handle, indent=2)
        handle.write('\n')
        handle.flush()
        import os
        os.fsync(handle.fileno())
    temporary.replace(path)


def sample(label):
    folder = root / label
    result = {'runnerUnchanged': hashlib.sha256((folder / 'run-foreground.sh').read_bytes()).hexdigest() == fixture[label]['runnerSha256']}
    if not (folder / 'started.txt').is_file():
        return result
    parent, child, start, duration = map(int, (folder / 'started.txt').read_text().split())
    result.update({'parentPid': parent, 'childPid': child, 'startUnixSeconds': start, 'sleepSeconds': duration})
    ps = subprocess.run(['/bin/ps', '-p', f'{parent},{child}', '-o', 'pid=,ppid=,pgid=,state=,lstart=,comm='], capture_output=True, text=True)
    if ps.returncode not in (0, 1) or ps.stderr:
        raise RuntimeError('ps returned an error')
    table = {}
    for line in ps.stdout.splitlines():
        pid, ppid, group, state, weekday, month, day, clock, year, command = line.split(maxsplit=9)
        table[int(pid)] = {'ppid': int(ppid), 'pgid': int(group), 'state': state, 'creation': ' '.join([weekday, month, day, clock, year]), 'command': command}
    result.update({'parent': table.get(parent), 'child': table.get(child)})
    if (folder / 'result.txt').is_file():
        data = (folder / 'result.txt').read_bytes()
        result['result'] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'expectedBytes': data == (fixture[label]['expectedMarker'] + '\n').encode()}
    return result


def live(sample):
    parent, child = sample.get('parent'), sample.get('child')
    return (bool(parent and child) and not parent['state'].startswith('Z') and not child['state'].startswith('Z')
            and child['ppid'] == sample['parentPid'] and Path(child['command']).name == 'sleep')


def same_live(before, after):
    return live(after) and all(before[key] == after[key] for key in ('parentPid', 'childPid')) and all(
        before[role]['creation'] == after[role]['creation'] and before[role]['pgid'] == after[role]['pgid'] for role in ('parent', 'child'))


operation = sys.argv[1]
if operation == 'status':
    path = root / 'latest.json'
    print(path.read_text() if path.is_file() else 'Monitor has not recorded a sample')
    sys.exit(0)
if operation == 'mark-will-click-stop-a':
    state = {label: sample(label) for label in fixture}
    if not all(live(side) for side in state.values()):
        sys.exit('Both original script and sleep processes must be alive before the stop click')
    path = root / 'will-click-stop-a.json'
    with path.open('x') as handle:
        json.dump({'observedAtUtc': now(), 'observedAtUnix': time.time(), 'sides': state}, handle, indent=2)
        handle.write('\n')
        handle.flush()
        import os
        os.fsync(handle.fileno())
    print(path)
    sys.exit(0)
if operation != 'watch':
    sys.exit('Expected watch, status, or mark-will-click-stop-a')

import os
began = time.monotonic()
previous = None
last_logged = began
first_overlap = None
first_a_gone = None
b_while_a_gone = None
consecutive_a_gone = 0
status = 'deadline reached'
with (root / 'process-observations.jsonl').open('x') as log:
    while True:
        stamp = now()
        wall = time.time()
        sides = {key: sample(key) for key in fixture}
        a, b = sides['A'], sides['B']
        record = {'observedAtUtc': stamp, 'observedAtUnix': wall, 'sides': sides}
        write_json(root / 'latest.json', record)
        if sides != previous or time.monotonic() - last_logged >= 5:
            log.write(json.dumps(record) + '\n')
            log.flush()
            os.fsync(log.fileno())
            previous, last_logged = sides, time.monotonic()
        if first_overlap is None and live(a) and live(b):
            first_overlap = record
        stop_mark = root / 'will-click-stop-a.json'
        if stop_mark.is_file() and first_overlap is not None and not first_a_gone:
            try:
                mark = json.loads(stop_mark.read_text())
            except json.JSONDecodeError:
                mark = None
            if mark and a.get('parentPid') == mark['sides']['A']['parentPid'] and a.get('childPid') == mark['sides']['A']['childPid']:
                if not a.get('parent') and not a.get('child') and 'result' not in a and wall < a['startUnixSeconds'] + a['sleepSeconds'] - 2:
                    consecutive_a_gone += 1
                    if consecutive_a_gone >= 2:
                        first_a_gone = record
                        b_while_a_gone = same_live(mark['sides']['B'], b)
                else:
                    consecutive_a_gone = 0
        if first_a_gone and b.get('result', {}).get('expectedBytes'):
            status = 'observed A parent and child gone early, B original processes continued and B result matched' if b_while_a_gone and 'result' not in a and all(side['runnerUnchanged'] for side in sides.values()) else 'partial observation; see process and result records'
            break
        if a.get('result'):
            status = 'A wrote its completion marker; observed stop proof did not pass'
            break
        if time.monotonic() - began >= 420:
            break
        time.sleep(.45)
summary = {'status': status, 'firstOverlap': first_overlap, 'firstEarlyAbsenceConfirmed': first_a_gone, 'bSameProcessWhileAAbsent': b_while_a_gone, 'final': record, 'fixture': fixture}
write_json(root / 'summary.json', summary)
print(json.dumps({'path': str(root / 'summary.json'), 'status': status}))
