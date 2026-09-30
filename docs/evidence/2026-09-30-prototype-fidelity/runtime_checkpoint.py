"""Record bounded runtime/data evidence without recording message bodies or secrets."""
import datetime
import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    settings = dict(connection.execute("SELECT key,value FROM settings"))
unsent = json.loads(settings.get("unsentWork.v1", "{}"))
original = json.loads((base / "before-unsent.json").read_text())["fields"]
fields = {
    field: {key: digest(value) for key, value in unsent.get(field, {}).items()}
    for field in original
}
processes = {}
for line in subprocess.check_output(["ps", "-axo", "pid=,ppid=,comm="], text=True).splitlines():
    parts = line.strip().split(None, 2)
    if len(parts) == 3:
        processes[int(parts[0])] = {"parent": int(parts[1]), "command": parts[2]}
selected = {pid for pid, info in processes.items() if info["command"] == "/Applications/Farfold.app/Contents/MacOS/farfold"}
while True:
    more = {pid for pid, info in processes.items() if info["parent"] in selected}
    if more <= selected:
        break
    selected |= more
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "originalUnsentChanges": {
        field: [key for key, value in values.items() if fields[field].get(key) != value]
        for field, values in original.items() if field != "choice"
    },
    "unsentFields": fields,
    "settingHashes": {key: digest(value) for key, value in settings.items()},
    "newConversationChoice": unsent.get("choice"),
    "processes": {str(pid): processes[pid] for pid in sorted(selected)},
}
if len(sys.argv) > 2:
    before = json.loads((base / sys.argv[2]).read_text())
    result["previousProcessesStillPresent"] = {
        pid: info for pid, info in before["processes"].items()
        if processes.get(int(pid)) == info
    }
    result["changedSettingKeysSincePrevious"] = sorted(
        key for key in set(settings) | set(before["settingHashes"])
        if result["settingHashes"].get(key) != before["settingHashes"].get(key)
    )
(base / sys.argv[1]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({
    "processCount": len(selected),
    "originalUnsentChanges": result["originalUnsentChanges"],
    "remainingProcessCount": len(result.get("previousProcessesStillPresent", {})),
    "changedSettingKeysSincePrevious": result.get("changedSettingKeysSincePrevious"),
}, ensure_ascii=False))
