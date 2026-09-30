"""Record public Pi installation paths and selection, never environment secrets."""
import datetime
import json
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
data = Path.home() / "Library/Application Support/ai.farfold.desktop"
with sqlite3.connect(f"file:{data / 'farfold.sqlite3'}?mode=ro", uri=True) as connection:
    row = connection.execute("SELECT command,args,env,version FROM agents WHERE id=?", ("pi",)).fetchone()
    setting = connection.execute("SELECT value FROM settings WHERE key=?", ("installations.v1",)).fetchone()
environment = dict(json.loads(row[2])) if row and row[2] else {}
program = environment.get("PI_ACP_PI_COMMAND")
installations = json.loads(setting[0]) if setting else []
fields = ("id", "agentId", "path", "version", "source", "managedRoot", "programOnly", "nodeLaunch", "release")
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "registered": {"command": row[0], "args": json.loads(row[1]), "componentVersion": row[3], "programPath": program} if row else None,
    "installations": [{key: item[key] for key in fields if key in item} for item in installations if item.get("agentId") == "pi"],
    "managedChildren": sorted(path.name for path in (data / "agents/pi").iterdir()) if (data / "agents/pi").is_dir() else [],
}
(base / sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"programPath": program, "installationCount": len(result["installations"]), "managedChildren": result["managedChildren"]}))
