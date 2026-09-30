"""Public registration projection; omit all environment values and arbitrary metadata."""
import datetime
import json
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
data = Path.home() / "Library/Application Support/ai.farfold.desktop"
target = "registry:" + sys.argv[1]
with sqlite3.connect(f"file:{data / 'farfold.sqlite3'}?mode=ro", uri=True) as connection:
    row = connection.execute("SELECT id,name,command,args,version,handshake FROM agents WHERE id=?", (target,)).fetchone()
    inventory = connection.execute("SELECT value FROM settings WHERE key=?", ("installations.v1",)).fetchone()
result = {"at": datetime.datetime.now().astimezone().isoformat(), "agentId": target, "registered": bool(row)}
if row:
    handshake = json.loads(row[5]) if row[5] else {}
    result.update({"name": row[1], "command": row[2], "args": json.loads(row[3]), "packageVersion": row[4],
                   "agentInfo": handshake.get("agentInfo"), "agentCapabilities": handshake.get("agentCapabilities"),
                   "publicAuthFormat": handshake.get("farfoldAuthFormat"),
                   "authMethods": [{**{key: method[key] for key in ["id", "name", "type"] if key in method},
                                    "envNames": [item["name"] for item in method.get("vars", []) if isinstance(item, dict) and isinstance(item.get("name"), str)],
                                    "containsExecutionFields": any(key in method for key in ["args", "env", "_meta"])}
                                   for method in handshake.get("authMethods", [])]})
    result["managedRoots"] = [item.get("managedRoot") for item in json.loads(inventory[0]) if item.get("agentId") == target] if inventory else []
parent = data / "agents" / target
result["directories"] = [str(path) for path in sorted(parent.iterdir()) if path.is_dir()] if parent.is_dir() else []
out = base / sys.argv[2]
if out.exists():
    raise SystemExit("Observation already exists")
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))
