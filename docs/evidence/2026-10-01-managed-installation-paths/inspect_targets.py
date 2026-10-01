"""Read only named targets' public launch/receipt fields; no environment values."""
import datetime
import json
from pathlib import Path
import sqlite3
import subprocess
import sys

base = Path(__file__).resolve().parent
data = Path.home() / "Library/Application Support/ai.farfold.desktop"
destination = base / sys.argv[1]
if destination.exists():
    raise SystemExit("Refusing to overwrite an observation")
targets = []
with sqlite3.connect(f"file:{data / 'farfold.sqlite3'}?mode=ro", uri=True) as db:
    saved = db.execute("SELECT value FROM settings WHERE key=?", ("installations.v1",)).fetchone()
    inventory = json.loads(saved[0]) if saved else []
    for agent_id in ["registry:junie", "registry:kilo", "registry:github-copilot-cli", "registry:goose"]:
        row = db.execute("SELECT name,command,args,version,handshake FROM agents WHERE id=?", (agent_id,)).fetchone()
        target = {"agentId": agent_id, "registered": row is not None}
        target["receipts"] = [{key: item.get(key) for key in ["id", "path", "command", "args", "version", "managedRoot", "programOnly"]}
                              for item in inventory if item.get("agentId") == agent_id]
        if row:
            name, command, args, version, raw = row
            handshake = json.loads(raw) if raw else {}
            info = handshake.get("agentInfo") or {}
            target.update(name=name, command=command, args=json.loads(args), version=version,
                          agentInfo={key: info[key] for key in ["name", "title", "version"] if key in info},
                          authMethods=[{key: method[key] for key in ["id", "name", "type"] if key in method}
                                       for method in handshake.get("authMethods", [])])
            entry = Path(command)
            if entry.is_file():
                target.update(resolvedCommand=str(entry.resolve()), mode=oct(entry.stat().st_mode & 0o777),
                              bytes=entry.stat().st_size,
                              fileFormat=subprocess.run(["file", "-b", str(entry)], capture_output=True, text=True).stdout.strip())
        targets.append(target)
result = {"at": datetime.datetime.now().astimezone().isoformat(), "targets": targets,
          "environmentValuesRead": False, "agentBinaryHashesComputed": False}
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"file": destination.name, "registered": [item["agentId"] for item in targets if item["registered"]]}))
