"""Read-only comparison against this rollout's original data and candidate."""
import datetime
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
repository = base.parents[2]
original = json.loads((base / "before-install.json").read_text())
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


sessions = {
    row[0]: digest(list(row[1:]))
    for row in connection.execute(
        "SELECT id,agent_id,cwd,native_session_id,title,config_options,pinned,"
        "archived,created_at FROM sessions"
    )
}
agents = {
    row[0]: digest(list(row[1:]))
    for row in connection.execute("SELECT id,name,source,command,args,env FROM agents")
}
settings = {
    key: digest(value)
    for key, value in connection.execute("SELECT key,value FROM settings")
}
candidate_name = sys.argv[2] if len(sys.argv) > 2 else "candidate2-source.json"
candidate = json.loads((base / candidate_name).read_text())
source_changes = [
    name
    for name, saved in candidate["files"].items()
    if hashlib.sha256((repository / name).read_bytes()).hexdigest() != saved
]
report = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "sessionCount": len(sessions),
    "originalSessionCount": original["sessionCount"],
    "changedOrMissingOriginalSessions": [
        key for key, saved in original["sessions"].items() if sessions.get(key) != saved
    ],
    "changedOrMissingOriginalAgentLaunches": [
        key for key, saved in original["agentLaunches"].items() if agents.get(key) != saved
    ],
    "changedOrMissingOriginalSettingKeys": [
        key for key, saved in original["settings"].items() if settings.get(key) != saved
    ],
    "addedSettingKeys": sorted(set(settings) - set(original["settings"])),
    "settings": settings,
    "sourceFiles": len(candidate["files"]),
    "sourceManifest": candidate_name,
    "sourceChanges": source_changes,
    "binarySHA256": hashlib.sha256(
        Path("/Applications/Farfold.app/Contents/MacOS/farfold").read_bytes()
    ).hexdigest(),
}
(base / sys.argv[1]).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({key: value for key, value in report.items() if key != "settings"}))
