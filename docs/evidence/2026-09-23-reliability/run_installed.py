"""Reuse the installed app's existing numeric performance trace; no new app flags."""
import json
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
label = sys.argv[1]
assert label in ("baseline", "candidate")
environment = dict(os.environ)
environment["FARFOLD_PERF_TRACE"] = "1"
process = subprocess.Popen(
    ["/Applications/Farfold.app/Contents/MacOS/farfold"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.PIPE,
    text=True,
    env=environment,
)
(root / f"{label}-process.json").write_text(json.dumps({"pid": process.pid}) + "\n")
with (root / f"{label}-performance.log").open("a") as stream:
    for line in process.stderr:
        if line.startswith("[farfold-perf]"):
            stream.write(line)
            stream.flush()
print("exit", process.wait())
