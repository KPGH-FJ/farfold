"""Observe one already identified installed-app fixture child; never signal it."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parent
PID = 30331
started = time.monotonic()
observations = []
initial = subprocess.check_output(['ps', '-p', str(PID), '-o', 'lstart='], text=True).strip()
for index in range(34):
    result = subprocess.run(['ps', '-p', str(PID), '-o', 'lstart='], text=True, capture_output=True)
    same = result.returncode == 0 and result.stdout.strip() == initial
    observations.append({'at': datetime.datetime.now().astimezone().isoformat(),
                         'seconds': round(time.monotonic() - started, 2), 'same_process_alive': same})
    (ROOT / 'idle-process.json').write_text(json.dumps({'pid': PID, 'initial_start': initial,
        'observations': observations}, indent=2)+'\n')
    if not same:
        print(json.dumps(observations[-1]), flush=True)
        break
    time.sleep(60)
else:
    print('still_alive_after_observation_window', flush=True)
