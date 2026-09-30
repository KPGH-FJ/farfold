"""Hash existing Farfold metadata and unsent fields without persisting their values."""
import datetime
import hashlib
import json
import sqlite3
from pathlib import Path

base = Path(__file__).resolve().parent
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
now = datetime.datetime.now().astimezone().isoformat()


def digest(value, *, sort_keys=False):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=sort_keys).encode()).hexdigest()


if (base / "data-before.json").exists() or (base / "unsent-before.json").exists():
    raise SystemExit("Baseline already exists; preserve the original observation")

with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    sessions = {row[0]: digest(list(row[1:])) for row in connection.execute(
        "SELECT id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at FROM sessions"
    )}
    agents = {row[0]: digest(list(row[1:])) for row in connection.execute(
        "SELECT id,name,source,command,args,env,version,created_at FROM agents"
    )}
    settings = {key: digest(value) for key, value in connection.execute("SELECT key,value FROM settings")}
    row = connection.execute("SELECT value FROM settings WHERE key = ?", ("unsentWork.v1",)).fetchone()
    unsent = json.loads(row[0]) if row else {}

fields = {
    name: ({key: digest(value, sort_keys=True) for key, value in field.items()}
           if isinstance(field, dict) else digest(field, sort_keys=True))
    for name, field in unsent.items()
}
(base / "data-before.json").write_text(json.dumps({"at": now, "sessions": sessions, "agents": agents, "settings": settings}, indent=2) + "\n")
(base / "unsent-before.json").write_text(json.dumps({"at": now, "fields": fields}, indent=2) + "\n")
print(json.dumps({"at": now, "sessions": len(sessions), "agents": len(agents), "settings": len(settings)}))
