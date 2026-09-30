"""Read-only source, prototype and original-data verification for this candidate."""
import datetime
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
repo = base.parents[2]
original = json.loads((base / "before-install.json").read_text())


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def source_files():
    roots = ["src", "public", "src-tauri/src", "src-tauri/capabilities", "src-tauri/resources", "src-tauri/icons"]
    paths = [path for root in roots for path in (repo / root).rglob("*") if path.is_file()]
    paths += [repo / name for name in ["package.json", "pnpm-lock.yaml", "index.html", "vite.config.ts", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json"]]
    return {str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(paths) if path.is_file()}


manifest = base / "candidate-source.json"
if sys.argv[1] == "freeze":
    result = {"at": datetime.datetime.now().astimezone().isoformat(), "files": source_files()}
    manifest.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"sourceFiles": len(result["files"])}))
    raise SystemExit()

database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    sessions = {row[0]: digest(list(row[1:])) for row in connection.execute("SELECT id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at FROM sessions")}
    agents = {row[0]: digest(list(row[1:])) for row in connection.execute("SELECT id,name,source,command,args,env FROM agents")}
    settings = {key: digest(value) for key, value in connection.execute("SELECT key,value FROM settings")}
saved_files = json.loads(manifest.read_text())["files"]
current_files = source_files()
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "sessionCount": len(sessions),
    "originalSessionCount": original["sessionCount"],
    "changedOrMissingOriginalSessions": [key for key, value in original["sessions"].items() if sessions.get(key) != value],
    "changedOrMissingOriginalAgentLaunches": [key for key, value in original["agentLaunches"].items() if agents.get(key) != value],
    "changedOrMissingOriginalSettingKeys": [key for key, value in original["settings"].items() if settings.get(key) != value],
    "addedSettingKeys": sorted(set(settings) - set(original["settings"])),
    "sourceChanges": [name for name in sorted(set(saved_files) | set(current_files)) if saved_files.get(name) != current_files.get(name)],
    "sourceFiles": len(saved_files),
    "prototypeChanges": [name for name, value in original["prototypeFiles"].items() if not (repo / name).is_file() or hashlib.sha256((repo / name).read_bytes()).hexdigest() != value],
    "binarySHA256": hashlib.sha256(Path("/Applications/Farfold.app/Contents/MacOS/farfold").read_bytes()).hexdigest(),
}
(base / sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))
