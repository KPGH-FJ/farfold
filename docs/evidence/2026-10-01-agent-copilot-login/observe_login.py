"""Bounded observation of the selected login argv; never persist arbitrary argv."""
import datetime
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

base = Path(__file__).resolve().parent
destination = base / sys.argv[1]
if destination.exists():
    raise SystemExit("Refusing to overwrite an observation")
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    row = connection.execute(
        "SELECT command,args FROM agents WHERE id = ?", ("registry:github-copilot-cli",)
    ).fetchone()
if not row:
    raise SystemExit("Selected program is absent")
node, args = row[0], json.loads(row[1])
if len(args) != 2 or args[1] != "--acp":
    raise SystemExit("Selected program no longer has the verified launch shape")
loader = Path(args[0])
platform = loader.parent.parent / "copilot-darwin-arm64/copilot"
expected = {
    "loaderLogin": " ".join([node, str(loader), "login"]),
    "platformLogin": " ".join([str(platform), "login"]),
}
started = datetime.datetime.now().astimezone().isoformat()
deadline = time.monotonic() + min(float(sys.argv[2]) if len(sys.argv) > 2 else 45, 60)
observed = {}
while True:
    processes = {}
    for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,lstart=,comm="], text=True).splitlines():
        parts = line.strip().split(None, 7)
        if len(parts) == 8:
            processes[int(parts[0])] = {
                "parent": int(parts[1]), "started": " ".join(parts[2:7]), "command": parts[7]
            }
    selected = {pid for pid, value in processes.items()
                if value["command"] == "/Applications/Farfold.app/Contents/MacOS/farfold"}
    while True:
        more = {pid for pid, value in processes.items() if value["parent"] in selected}
        if more <= selected:
            break
        selected |= more
    for pid in sorted(selected):
        identity = f"{pid}:{processes[pid]['started']}"
        command = processes[pid]["command"]
        if identity not in observed:
            result = subprocess.run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True)
            observed[identity] = {
                "at": datetime.datetime.now().astimezone().isoformat(), "pid": pid,
                **processes[pid], "cwd": [line[1:] for line in result.stdout.splitlines() if line.startswith("n")],
                "lsofExitCode": result.returncode, "matchedLoginArgv": [],
            }
        if command in [node, str(platform)]:
            actual = subprocess.run(["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True)
            if actual.returncode == 0:
                for kind, value in expected.items():
                    if actual.stdout.strip() == value and kind not in observed[identity]["matchedLoginArgv"]:
                        observed[identity]["matchedLoginArgv"].append(kind)
    if time.monotonic() >= deadline:
        break
    time.sleep(0.25)
result = {"started": started, "finished": datetime.datetime.now().astimezone().isoformat(),
          "expected": expected, "processes": list(observed.values())}
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"file": destination.name, "observed": len(observed),
                  "matched": {kind: sum(kind in row["matchedLoginArgv"] for row in observed.values()) for kind in expected}}))
