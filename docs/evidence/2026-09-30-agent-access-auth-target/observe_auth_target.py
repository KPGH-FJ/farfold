"""Record only exact public login argv matches among the formal app's descendants."""
import datetime
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    row = connection.execute(
        "SELECT command,env,handshake FROM agents WHERE id = ?", (sys.argv[1],)
    ).fetchone()
if row is None:
    raise SystemExit("Selected registration is missing")
if sys.argv[1] == "registry:kilo":
    expected = row[0] + " auth login"
elif sys.argv[1] == "registry:amp-acp":
    methods = json.loads(row[2]).get("authMethods", [])
    method = next((m for m in methods if m.get("id") == "setup"), {})
    declaration = method.get("_meta", {}).get("terminal-auth", {})
    if declaration == {"command": row[0], "args": ["--setup"], "label": "Amp API Key Setup"}:
        expected = row[0] + " --setup"
    else:
        raise SystemExit("Live Amp declaration differs from the observed public setup route")
else:
    raise SystemExit("Unsupported observation target")

processes = {}
for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,lstart=,comm="], text=True).splitlines():
    parts = line.strip().split(None, 7)
    if len(parts) == 8:
        processes[int(parts[0])] = {"parent": int(parts[1]), "started": " ".join(parts[2:7]), "command": parts[7]}
selected = {pid for pid, info in processes.items() if info["command"] == "/Applications/Farfold.app/Contents/MacOS/farfold"}
while True:
    more = {pid for pid, info in processes.items() if info["parent"] in selected}
    if more <= selected:
        break
    selected |= more
matches = []
for pid in selected:
    # Inspect argv only in memory; never persist arbitrary arguments or output.
    result = subprocess.run(["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True)
    if result.returncode == 0 and result.stdout.strip() == expected:
        matches.append({"pid": pid, **processes[pid]})
receipt = {"at": datetime.datetime.now().astimezone().isoformat(), "agentId": sys.argv[1], "expectedPublicArgv": expected, "exactMatches": matches, "formalDescendantCount": len(selected)}
(base / sys.argv[2]).write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
