"""Freeze build inputs and compare original metadata without copying secret values."""
import datetime
import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
repo = base.parents[2]


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def source_files():
    roots = ["src", "public", "src-tauri/src", "src-tauri/capabilities", "src-tauri/resources", "src-tauri/icons"]
    paths = [path for root in roots for path in (repo / root).rglob("*") if path.is_file()]
    paths += [repo / name for name in ["package.json", "pnpm-lock.yaml", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json"]]
    return {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(paths) if path.is_file()}


manifest = base / "candidate-source.json"
now = datetime.datetime.now().astimezone().isoformat()
if sys.argv[1] == "freeze":
    result = {"at": now, "files": source_files()}
    manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"sourceFiles": len(result["files"])}))
    raise SystemExit()

original = json.loads((base / "data-before.json").read_text())
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    sessions = {row[0]: digest(list(row[1:])) for row in connection.execute("SELECT id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at FROM sessions")}
    agents = {row[0]: digest(list(row[1:])) for row in connection.execute("SELECT id,name,source,command,args,env,version,created_at FROM agents")}
    settings = {key: digest(value) for key, value in connection.execute("SELECT key,value FROM settings")}
    unsent_row = connection.execute("SELECT value FROM settings WHERE key = ?", ("unsentWork.v1",)).fetchone()
unsent = json.loads(unsent_row[0]) if unsent_row else {}
unsent_original = json.loads((base / "unsent-before.json").read_text())["fields"] if (base / "unsent-before.json").exists() else {}
unsent_fields = {
    key: ({item: hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest() for item, value in field.items()}
          if isinstance(field, dict) else hashlib.sha256(json.dumps(field, ensure_ascii=False, sort_keys=True).encode()).hexdigest())
    for key, field in unsent.items()
}

processes = {}
for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,comm="], text=True).splitlines():
    parts = line.strip().split(None, 2)
    if len(parts) == 3:
        processes[int(parts[0])] = {"parent": int(parts[1]), "command": parts[2]}
selected = {pid for pid, info in processes.items() if info["command"] == "/Applications/Farfold.app/Contents/MacOS/farfold"}
while True:
    more = {pid for pid, info in processes.items() if info["parent"] in selected}
    if more <= selected:
        break
    selected |= more

saved_files = json.loads(manifest.read_text())["files"] if manifest.exists() else {}
current_files = source_files()
result = {
    "at": now,
    "sessionCount": len(sessions),
    "originalSessionCount": len(original["sessions"]),
    "changedOrMissingOriginalSessions": [key for key, value in original["sessions"].items() if sessions.get(key) != value],
    "newSessions": sorted(set(sessions) - set(original["sessions"])),
    "changedOrMissingOriginalAgents": [key for key, value in original["agents"].items() if agents.get(key) != value],
    "changedOrMissingOriginalSettingKeys": [key for key, value in original["settings"].items() if settings.get(key) != value],
    "addedSettingKeys": sorted(set(settings) - set(original["settings"])),
    "sourceChanges": [name for name in sorted(set(saved_files) | set(current_files)) if saved_files.get(name) != current_files.get(name)] if saved_files else None,
    "sourceFiles": len(saved_files),
    "binarySHA256": hashlib.sha256(Path("/Applications/Farfold.app/Contents/MacOS/farfold").read_bytes()).hexdigest(),
    "processes": {str(pid): processes[pid] for pid in sorted(selected)},
    "originalUnsentFieldChanges": {
        field: ([key for key, value in values.items() if unsent_fields.get(field, {}).get(key) != value]
                if isinstance(values, dict) else unsent_fields.get(field) != values)
        for field, values in unsent_original.items()
    },
}
if len(sys.argv) > 2:
    previous = json.loads((base / sys.argv[2]).read_text())
    result["previousProcessesStillPresent"] = {pid: info for pid, info in previous["processes"].items() if processes.get(int(pid)) == info}
(base / sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))
