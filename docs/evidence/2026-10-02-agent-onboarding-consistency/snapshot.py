"""Record candidate inputs and hash metadata without copying credential values."""
import datetime
import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
repo = base.parents[2]
destination = base / sys.argv[1]
if destination.exists():
    raise SystemExit("Preserve the previous observation")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


roots = ["src", "public", "src-tauri/src", "src-tauri/capabilities", "src-tauri/resources", "src-tauri/icons"]
paths = [p for root in roots for p in (repo / root).rglob("*") if p.is_file()]
paths += [repo / name for name in ["package.json", "pnpm-lock.yaml", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json"]]
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "files": {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths) if p.is_file()},
    "installedBinary": hashlib.sha256(Path("/Applications/Farfold.app/Contents/MacOS/farfold").read_bytes()).hexdigest(),
}
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    connection.row_factory = sqlite3.Row
    for table, key in [("sessions", "id"), ("agents", "id"), ("settings", "key")]:
        rows = [dict(row) for row in connection.execute(f"SELECT * FROM {table}")]
        result[table] = {str(row[key]): {field: digest(value) for field, value in row.items() if field != key} for row in rows}
    for setting in ["unsentWork.v1", "agentSetup.v1"]:
        row = connection.execute("SELECT value FROM settings WHERE key=?", (setting,)).fetchone()
        value = json.loads(row[0]) if row else {}
        result[setting] = {
            field: {str(k): digest(v) for k, v in content.items()} if isinstance(content, dict) else digest(content)
            for field, content in value.items()
        } if isinstance(value, dict) else digest(value)

processes = {}
for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,lstart=,comm="], text=True).splitlines():
    parts = line.strip().split(None, 7)
    if len(parts) == 8:
        processes[int(parts[0])] = {"parent": int(parts[1]), "started": " ".join(parts[2:7]), "command": parts[7]}
selected = {pid for pid, p in processes.items() if p["command"] == "/Applications/Farfold.app/Contents/MacOS/farfold"}
while True:
    more = {pid for pid, p in processes.items() if p["parent"] in selected}
    if more <= selected:
        break
    selected |= more
result["processes"] = {str(pid): processes[pid] for pid in sorted(selected)}
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"file": destination.name, "sourceFiles": len(result["files"]), "sessions": len(result["sessions"]), "agents": len(result["agents"]), "settings": len(result["settings"]), "processes": len(selected)}))
