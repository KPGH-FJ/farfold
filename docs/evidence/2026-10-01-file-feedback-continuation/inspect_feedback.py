"""Read exact task feedback and hash all other unsent data; never write the database."""
import datetime
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
name = sys.argv[1] if len(sys.argv) > 1 else "before-cold-feedback.json"
if Path(name).name != name or not name.endswith(".json"):
    raise SystemExit("Use a JSON filename in this evidence directory")
destination = base / name
if destination.exists():
    raise SystemExit("Refusing to overwrite an observation")
target = json.loads((base / "target.json").read_text())
thread = target["id"]
composer_key = "session:" + thread
original = json.loads((base / "unsent-before.json").read_text())["fields"]
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    row = connection.execute(
        "SELECT value FROM settings WHERE key = ?", ("unsentWork.v1",)
    ).fetchone()
unsent = json.loads(row[0]) if row else {}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def text_summary(value):
    if not isinstance(value, str):
        return {"validString": False}
    return {
        "characters": len(value),
        "sha256": hashlib.sha256(value.encode()).hexdigest(),
        "markers": re.findall(r"FARFOLD-[A-Za-z0-9_-]+|\bBASE\b", value),
    }


fields = {
    field: ({key: digest(value) for key, value in values.items()}
            if isinstance(values, dict) else digest(values))
    for field, values in unsent.items()
}
changes = {}
added = {}
for field in sorted(set(original) | set(fields)):
    old, new = original.get(field), fields.get(field)
    if isinstance(old, dict) and isinstance(new, dict):
        changes[field] = [key for key, value in old.items() if new.get(key) != value]
        added[field] = sorted(set(new) - set(old))
    else:
        changes[field] = old != new
        added[field] = []
allowed = {"composers": {composer_key}, "feedback": {thread}, "activity": {thread}}
unexpected = {}
for field in set(changes) | set(added):
    changed = changes[field]
    if isinstance(changed, list):
        keys = sorted((set(changed) | set(added[field])) - allowed.get(field, set()))
        if keys:
            unexpected[field] = keys
    elif changed:
        unexpected[field] = True
composer = unsent.get("composers", {}).get(composer_key)
feedback = unsent.get("feedback", {}).get(thread, {})
entries = []
for key, entry in feedback.items():
    if not isinstance(entry, dict):
        entries.append({"entryKeySHA256": digest(key), "validObject": False})
        continue
    selection = entry.get("selection")
    line_input = entry.get("lineInput")
    entries.append({
        "entryKeySHA256": digest(key),
        "pathMatchesTaskFile": entry.get("path") == target["artifact"]["path"],
        "text": text_summary(entry.get("text")),
        "contentId": entry.get("contentId"),
        "scope": entry.get("scope"),
        "selection": ({name: selection[name] for name in ["side", "line", "endLine"] if name in selection}
                      if isinstance(selection, dict) else None),
        "lineInput": ({name: line_input[name] for name in ["side", "text"] if name in line_input}
                      if isinstance(line_input, dict) else None),
    })
artifact = Path(target["artifact"]["path"])
if artifact.is_symlink() or artifact.resolve() != artifact:
    raise SystemExit("Task artifact path identity changed")
artifact_bytes = artifact.read_bytes()
artifact_sha = hashlib.sha256(artifact_bytes).hexdigest()
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "targetId": thread,
    "scope": "Exact task-owned thread markers and feedback positions only; all other unsent values are hashes; no database writes",
    "composer": ({"present": True, "text": text_summary(composer.get("text")),
                  "attachmentCount": len(composer.get("attachments", [])),
                  "snapshotSHA256": digest(composer)} if isinstance(composer, dict) else {"present": False}),
    "feedback": entries,
    "artifact": {"path": str(artifact), "bytes": len(artifact_bytes), "sha256": artifact_sha,
                 "matchesPreparedFinal": artifact_sha == target["artifact"]["sha256"]},
    "unsentFieldDigests": fields,
    "changedOrMissingOriginalFields": changes,
    "addedFieldKeys": added,
    "unexpectedUnsentChanges": unexpected,
    "onlyTargetUnsentChanges": not unexpected,
}
destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"file": name, "at": result["at"], "composer": result["composer"],
                  "feedback": entries, "onlyTargetUnsentChanges": not unexpected,
                  "unexpectedUnsentChanges": unexpected,
                  "artifactMatchesPreparedFinal": result["artifact"]["matchesPreparedFinal"]}, ensure_ascii=False))
