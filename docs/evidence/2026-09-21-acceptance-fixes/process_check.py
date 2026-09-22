"""Track this installed app's process tree, without persisting argv or environment."""
import datetime
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
EXISTING = {3076, 31388}
APP = '/Applications/Farfold.app/Contents/MacOS/farfold'


def processes():
    rows = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,comm='], text=True).splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3:
            rows[int(fields[0])] = (int(fields[1]), fields[2])
    return rows


candidate, phase = sys.argv[1:]
rows = processes()
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
before = ROOT / f'candidate-{candidate}-before-quit.json'
if phase == 'before':
    roots = {pid for pid, (_, name) in rows.items() if name == APP and pid not in EXISTING}
    assert len(roots) == 1, f'Expected one current installed app, got {len(roots)}'
    tracked = set(roots)
    while True:
        expanded = tracked | {pid for pid, (ppid, _) in rows.items() if ppid in tracked}
        if expanded == tracked:
            break
        tracked = expanded
    result = {'at': now, 'candidate': int(candidate), 'roots': sorted(roots),
              'excludedPreExisting': sorted(EXISTING),
              'processes': [{'pid': pid, 'ppid': rows[pid][0], 'executable': Path(rows[pid][1]).name} for pid in sorted(tracked)]}
    before.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'roots': sorted(roots), 'tracked': len(tracked)}))
elif phase == 'after':
    previous = json.loads(before.read_text())
    survivors = [r['pid'] for r in previous['processes'] if r['pid'] in rows]
    result = {'at': now, 'candidate': int(candidate), 'trackedCount': len(previous['processes']),
              'survivors': survivors, 'preExistingStillPresent': sorted(EXISTING & rows.keys())}
    (ROOT / f'candidate-{candidate}-after-quit.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
else:
    raise ValueError('phase must be before or after')
