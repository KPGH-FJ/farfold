import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def pin(path):
    source = ROOT / path
    if not source.exists():
        return {"path": path, "exists": False}
    data = source.read_bytes()
    return {"path": path, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def write(path, value):
    with path.open("x") as output:
        output.write(json.dumps(value, indent=2) + "\n")


name, *command = sys.argv[1:]
assert name.replace("-", "").isalnum() and command[0] == "cargo"
folder = OUT / name
folder.mkdir()
baseline = json.loads((OUT / "baseline.json").read_text())
paths = sorted(item["path"] for item in baseline["ownedBefore"] + baseline["unchangedShared"])
before = [pin(path) for path in paths]
started = now()
write(folder / "started.json", {"command": command, "cwd": str(ROOT), "startedAtUtc": started, "files": before})
timer = time.monotonic()
with (folder / "stdout.log").open("xb") as stdout, (folder / "stderr.log").open("xb") as stderr:
    process = subprocess.Popen(command, cwd=ROOT, stdout=stdout, stderr=stderr)
    print(json.dumps({"stage": name, "pid": process.pid, "startedAtUtc": started}), flush=True)
    code = process.wait()
after = [pin(path) for path in paths]
receipt = {"command": command, "cwd": str(ROOT), "startedAtUtc": started, "completedAtUtc": now(), "pid": process.pid, "actualExitCode": code, "elapsedSeconds": time.monotonic() - timer, "sourceStable": before == after, "files": after, "stdout": pin(str((folder / "stdout.log").relative_to(ROOT))), "stderr": pin(str((folder / "stderr.log").relative_to(ROOT)))}
write(folder / "completed.json", receipt)
print(json.dumps({"stage": name, "actualExitCode": code, "sourceStable": before == after}), flush=True)
raise SystemExit(code if before == after else 125)
