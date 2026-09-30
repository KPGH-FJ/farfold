"""Inspect only fixed diagnostic metadata in the UI-exported local ZIP."""
import datetime
import hashlib
import json
from pathlib import Path
import sys
import zipfile

base = Path(__file__).resolve().parent
path = Path(sys.argv[1])
before = json.loads((base / "protocol-before-export.json").read_text())
expected_errors = [event for item in before["files"] for event in item["events"]
                   if "protocolErrorClass" in event]
expected_startup = [next((event for event in reversed(item["events"])
                          if event["version"] == 2), None) for item in before["files"]]
expected_startup = [event for event in expected_startup if event]
v1 = {"version", "ts", "dir", "event", "bytes", "error"}
group = {"protocolErrorClass", "responseIdNull", "beforeInitializeAccepted"}
v2 = {"version", "ts", "event", "phase", "failurePhase", "startupOutcome",
      "initializeResponse", "candidateCleanup", "exitCode", "exitSignal",
      "initializeAccepted", "childStarted", "childReaped", "waitFailed",
      "termRequested", "killRequested", "exitObservedBeforeTerm", "groupEnded",
      "connectionRemoved"}
with zipfile.ZipFile(path) as archive:
    names = archive.namelist()
    log_names = [name for name in names if name.startswith("logs/protocol-")]
    contents = [archive.read(name).decode() for name in log_names]
    records = [json.loads(line) for content in contents for line in content.splitlines()]
    allowed_keys = all(set(record) <= (v1 | group if record.get("version") == 1 else v2)
                       for record in records)
    valid_groups = all(set(record) == v1 | group and record.get("dir") == "out"
                       and record.get("event") == "response" and record.get("error") == "protocol"
                       and record.get("protocolErrorClass") in {"parse_error", "invalid_request",
                           "method_not_found", "invalid_params", "internal_error", "other"}
                       and type(record.get("responseIdNull")) is bool
                       and type(record.get("beforeInitializeAccepted")) is bool
                       for record in records if set(record) & group)
    errors = [record for record in records if "protocolErrorClass" in record]
    startup = [record for record in records if record.get("version") == 2]
    manifest = json.loads(archive.read("manifest.json"))
preview = (base / "diagnostics-preview-expanded.txt").read_text()
excerpts = []
for section in preview.split(" text {")[1:]:
    excerpt = "{" + section.split("\n\t", 1)[0]
    excerpts.append(any(content.startswith(excerpt) for content in contents))
result = {
    "at": datetime.datetime.now().astimezone().isoformat(), "path": str(path),
    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "entries": names,
    "logBytes": sum(len(content.encode()) for content in contents),
    "metadataKeysOnly": allowed_keys, "completeValidErrorGroups": valid_groups,
    "newProtocolErrors": errors,
    "errorGroupsExactlyMatchPreExportCollection": errors == expected_errors,
    "candidateStartupSummariesMatchPreExportCollection": all(item in startup for item in expected_startup),
    "candidateStartupSummaryCount": len(expected_startup),
    "visiblePreviewExcerptsMatchZip": excerpts,
    "previewBoundary": "AX exposes truncated prefixes; not a full installed preview byte comparison.",
    "manifest": {key: manifest.get(key) for key in ["version", "generatedAt", "agentCount", "sessionCount", "logFiles", "limitedLogs", "includesUserNote"]},
}
(base / "diagnostics-export-check.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key not in ["entries", "newProtocolErrors"]}, ensure_ascii=False))
if not (allowed_keys and valid_groups and errors == expected_errors and expected_errors
        and all(item in startup for item in expected_startup) and excerpts and all(excerpts)):
    raise SystemExit(1)
