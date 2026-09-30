"""Observe actual cwd for formal-app descendants; never read process environments."""
import datetime
import json
import subprocess
import sys
import time
from pathlib import Path

base = Path(__file__).resolve().parent
destination = base / sys.argv[1]
if destination.exists():
    raise SystemExit("Refusing to overwrite an observation")
duration = float(sys.argv[2]) if len(sys.argv) > 2 else 0
started = datetime.datetime.now().astimezone().isoformat()
deadline = time.monotonic() + min(max(duration, 0), 60)
observed = {}
while True:
    processes = {}
    for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,lstart=,comm="], text=True).splitlines():
        parts = line.strip().split(None, 7)
        if len(parts) == 8:
            processes[int(parts[0])] = {"parent": int(parts[1]), "started": " ".join(parts[2:7]), "command": parts[7]}
    selected = {pid for pid, value in processes.items() if value["command"] == "/Applications/Farfold.app/Contents/MacOS/farfold"}
    while True:
        more = {pid for pid, value in processes.items() if value["parent"] in selected}
        if more <= selected:
            break
        selected |= more
    for pid in sorted(selected):
        identity = f"{pid}:{processes[pid]['started']}"
        if identity in observed:
            continue
        result = subprocess.run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True)
        observed[identity] = {
            "at": datetime.datetime.now().astimezone().isoformat(), "pid": pid,
            **processes[pid], "cwd": [line[1:] for line in result.stdout.splitlines() if line.startswith("n")],
            "lsofExitCode": result.returncode,
        }
    if time.monotonic() >= deadline:
        break
    time.sleep(0.25)
result = {"started": started, "finished": datetime.datetime.now().astimezone().isoformat(), "processes": list(observed.values())}
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"file": destination.name, "observed": len(observed)}))
