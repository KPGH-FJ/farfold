"""Record only the two catalog targets and public launch facts; no secret reads."""
import datetime
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
data = Path.home() / "Library/Application Support/ai.farfold.desktop"
destination = base / sys.argv[1]
if destination.exists():
    raise SystemExit("Refusing to overwrite an observation")
targets = []
with sqlite3.connect(f"file:{data / 'farfold.sqlite3'}?mode=ro", uri=True) as db:
    for agent_id in ["registry:factory-droid", "registry:grok-build"]:
        row = db.execute(
            "SELECT name,command,args,version,handshake FROM agents WHERE id=?", (agent_id,)
        ).fetchone()
        parent = data / "agents" / agent_id
        target = {"agentId": agent_id, "registered": row is not None,
                  "candidateDirectories": sorted(str(p) for p in parent.iterdir()) if parent.exists() else []}
        if row:
            name, command, args, version, raw = row
            handshake = json.loads(raw) if raw else {}
            target.update(name=name, command=command, args=json.loads(args), packageVersion=version,
                          handshakeKeys=sorted(handshake), agentInfo=handshake.get("agentInfo"),
                          authMethods=[{k: method[k] for k in ["id", "name", "type"] if k in method}
                                       for method in handshake.get("authMethods", [])])
            entry = Path(command)
            if entry.is_file():
                target.update(resolvedCommand=str(entry.resolve()), mode=oct(entry.stat().st_mode & 0o777),
                              bytes=entry.stat().st_size,
                              fileFormat=subprocess.run(["file", "-b", str(entry)], text=True, capture_output=True).stdout.strip())
        targets.append(target)
result = {"observedAt": datetime.datetime.now().astimezone().isoformat(), "targets": targets,
          "environmentValuesRead": False, "agentBinaryHashesComputed": False}
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))
