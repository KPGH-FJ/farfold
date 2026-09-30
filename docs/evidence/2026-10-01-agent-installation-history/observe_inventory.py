"""Read only the Auggie test target's public launch and owned installation metadata."""
import datetime
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
data = Path.home() / "Library/Application Support/ai.farfold.desktop"
target = "registry:auggie"
with sqlite3.connect(f"file:{data / 'farfold.sqlite3'}?mode=ro", uri=True) as connection:
    row = connection.execute("SELECT command,args,version FROM agents WHERE id=?", (target,)).fetchone()
    saved = connection.execute("SELECT value FROM settings WHERE key=?", ("installations.v1",)).fetchone()
    previous = connection.execute("SELECT value FROM settings WHERE key=?", (f"installPrevious.{target}",)).fetchone()
items = [item for item in json.loads(saved[0]) if item.get("agentId") == target] if saved else []
prior = json.loads(previous[0]) if previous else None
if isinstance(prior, dict):
    prior = {key: prior.get(key) for key in ["command", "args", "version", "source", "programPath"]}
roots = []
parent = data / "agents" / target
for root in sorted(parent.iterdir()):
    if not root.is_dir():
        continue
    entry = root / "node_modules/@augmentcode/auggie/augment.mjs"
    roots.append({"path": str(root), "entryExists": entry.is_file(),
                  "entrySHA256": hashlib.sha256(entry.read_bytes()).hexdigest() if entry.is_file() else None})
result = {"at": datetime.datetime.now().astimezone().isoformat(), "agentId": target,
          "selected": {"command": row[0], "args": json.loads(row[1]), "version": row[2]} if row else None,
          "previous": prior, "items": items, "directories": roots}
out = base / sys.argv[1]
if out.exists():
    raise SystemExit("Observation already exists; use a new label")
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result, ensure_ascii=False))
