"""Export only validated content-free diagnostics from this installed run."""
import datetime
import json
from pathlib import Path

base = Path(__file__).resolve().parent
start = int(datetime.datetime.fromisoformat(json.loads((base / "candidate-install.json").read_text())["at"]).timestamp() * 1000)
allowed = {
    "initialize", "authenticate", "session/new", "session/load", "session/prompt",
    "session/update", "session/cancel", "session/request_permission",
    "session/set_config_option", "session/list", "response", "other",
}
files = []
for path in sorted((Path.home() / "Library/Logs/Farfold").glob("protocol-v1-*.jsonl")):
    try:
        stamp = int(path.name.split("-")[2])
    except ValueError:
        continue
    if stamp < start:
        continue
    events = []
    for line in path.read_text().splitlines():
        value = json.loads(line)
        if (value.get("version") == 1 and value.get("event") in allowed
                and value.get("dir") in ["in", "out", "err"]
                and value.get("error") in ["none", "stderr", "protocol"]
                and all(isinstance(value.get(key), int) for key in ["ts", "bytes"])):
            events.append({key: value[key] for key in ["version", "ts", "dir", "event", "bytes", "error"]})
    files.append({"file": path.name, "events": events})
result = {"at": datetime.datetime.now().astimezone().isoformat(), "files": files}
(base / "protocol-metadata-final.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"files": len(files), "sentPrompts": sum(event["dir"] == "out" and event["event"] == "session/prompt" for file in files for event in file["events"])}))
