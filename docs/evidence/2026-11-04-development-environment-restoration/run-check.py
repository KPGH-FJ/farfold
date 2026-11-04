#!/usr/bin/env python3
"""Capture one explicitly selected local engineering command and its exit status."""
import datetime
import json
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parents[3]
evidence = pathlib.Path(__file__).resolve().parent
label, *command = sys.argv[1:]
if not label or not command or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in label):
    raise SystemExit("invalid check arguments")
checks = evidence / "checks"
checks.mkdir(exist_ok=True)
receipt = checks / (label + ".json")
log = checks / (label + ".log")
if receipt.exists() or log.exists():
    raise SystemExit("check output already exists; use a new attempt label")
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
clock = time.monotonic()
with log.open("wb") as out:
    result = subprocess.run(command, cwd=root, stdout=out, stderr=subprocess.STDOUT)
record = {
    "label": label,
    "command": command,
    "cwd": str(root),
    "startedAt": started,
    "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "durationSeconds": round(time.monotonic() - clock, 3),
    "exitCode": result.returncode,
    "log": str(log.relative_to(root)),
}
receipt.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(record, ensure_ascii=False))
raise SystemExit(result.returncode)
