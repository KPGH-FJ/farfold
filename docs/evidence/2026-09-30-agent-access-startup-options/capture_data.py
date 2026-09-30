"""Capture content-free metadata after the separately recorded Kilo installation."""
import datetime
import hashlib
import json
import sqlite3
from pathlib import Path

base = Path(__file__).resolve().parent
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"


def digest(value, *, ordered=False):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=ordered).encode()).hexdigest()


for name in ["data-before.json", "unsent-before.json"]:
    old = base / name
    saved = base / name.replace("-before", "-before-kilo")
    if saved.exists():
        raise SystemExit("Baseline already refreshed; refusing to overwrite evidence")
    old.rename(saved)

now = datetime.datetime.now().astimezone().isoformat()
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    sessions = {row[0]: digest(list(row[1:])) for row in connection.execute("SELECT id,agent_id,cwd,native_session_id,title,config_options,pinned,archived,created_at FROM sessions")}
    agents = {row[0]: digest(list(row[1:])) for row in connection.execute("SELECT id,name,source,command,args,env,version,created_at FROM agents")}
    settings = {key: digest(value) for key, value in connection.execute("SELECT key,value FROM settings")}
    unsent_row = connection.execute("SELECT value FROM settings WHERE key = ?", ("unsentWork.v1",)).fetchone()
unsent = json.loads(unsent_row[0]) if unsent_row else {}
fields = {
    key: ({item: digest(value, ordered=True) for item, value in field.items()}
          if isinstance(field, dict) else digest(field, ordered=True))
    for key, field in unsent.items()
}
(base / "data-before.json").write_text(json.dumps({"at": now, "sessions": sessions, "agents": agents, "settings": settings}, ensure_ascii=False, indent=2) + "\n")
(base / "unsent-before.json").write_text(json.dumps({"at": now, "fields": fields}, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"at": now, "sessions": len(sessions), "agents": len(agents), "settings": len(settings)}))
