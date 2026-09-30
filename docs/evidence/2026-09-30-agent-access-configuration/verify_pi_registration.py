"""Compare all registered Pi fields except the explicitly selected program path."""
import datetime
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    row = list(connection.execute(
        "SELECT id,name,source,command,args,env,version,created_at FROM agents WHERE id=?", ("pi",)
    ).fetchone())
environment = dict(json.loads(row[5]))
program = environment.pop("PI_ACP_PI_COMMAND", None)
row[5] = sorted(environment.items())
value = hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
result = {"at": datetime.datetime.now().astimezone().isoformat(),
          "nonProgramFieldsSHA256": value, "programPath": program}
baseline = base / "pi-registration-before.json"
if sys.argv[1] == "baseline":
    if baseline.exists():
        raise SystemExit("Refusing to overwrite the original registration baseline")
    destination = baseline
else:
    result["nonProgramFieldsUnchanged"] = value == json.loads(baseline.read_text())["nonProgramFieldsSHA256"]
    destination = base / sys.argv[1]
destination.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
