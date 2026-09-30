"""Union the process identities actually sampled during this batch."""
import datetime
import json
from pathlib import Path

base = Path(__file__).resolve().parent
processes = {}
sources = []
for path in sorted(base.glob("*.json")):
    if path.name in {"all-observed-processes.json", "after-exit.json"}:
        continue
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or "processes" not in value:
        continue
    rows = value["processes"]
    if isinstance(rows, list):
        rows = {str(row["pid"]): row for row in rows if "started" in row and "command" in row}
    sources.append(path.name)
    for pid, row in rows.items():
        if "started" not in row or "command" not in row:
            continue
        kept = {key: row[key] for key in ["parent", "started", "command"]}
        if pid in processes:
            assert all(processes[pid][key] == kept[key] for key in ["started", "command"]), "PID reused: preserve both identities explicitly"
        processes[pid] = kept
result = {"at": datetime.datetime.now().astimezone().isoformat(), "sources": sources, "processes": processes}
(base / "all-observed-processes.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"observedIdentities": len(processes), "sources": len(sources)}))
