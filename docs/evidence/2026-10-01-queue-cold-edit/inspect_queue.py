"""Read the exact test queue/editor; persist hashes and planned marker counts only.

Requires this batch's baseline. Does not mutate settings, dispatch requests,
read Agent configuration, or save arbitrary text/attachment bodies.
"""
import datetime
import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def shape(value):
    return "absent" if value is None else type(value).__name__


def text_summary(value, markers):
    if not isinstance(value, str):
        return {"shape": shape(value), "sha256": digest(value)}
    return {
        "shape": "str", "characters": len(value), "sha256": digest(value),
        "markerCounts": {name: value.count(marker) for name, marker in markers.items()},
    }


def blocks_summary(value, markers):
    result = {"shape": shape(value), "sha256": digest(value)}
    if not isinstance(value, list):
        return result
    items = []
    for block in value:
        if not isinstance(block, dict):
            items.append({"shape": shape(block), "sha256": digest(block)})
            continue
        kind = block.get("type")
        item = {
            "type": kind if isinstance(kind, str) and kind in {"text", "image", "resource", "resource_link"} else "unrecognized",
            "sha256": digest(block),
        }
        if kind == "text":
            item["text"] = text_summary(block.get("text"), markers)
        items.append(item)
    result.update({"blockCount": len(value), "blocks": items})
    return result


def composer_summary(value, markers):
    result = {"present": value is not None, "shape": shape(value), "sha256": digest(value)}
    if not isinstance(value, dict):
        return result
    attachments = value.get("attachments")
    result.update({
        "text": text_summary(value.get("text"), markers),
        "attachmentCount": len(attachments) if isinstance(attachments, list) else None,
        "attachmentsSHA256": digest(attachments),
        "sendPending": value.get("sendPending") is True,
        "pendingConversationPresent": value.get("pendingConversation") is not None,
        "queueEditPresent": value.get("queueEdit") is not None,
    })
    editing = value.get("queueEdit")
    if isinstance(editing, dict):
        index = editing.get("index")
        result["queueEdit"] = {
            "index": index if type(index) is int and index >= 0 else None,
            "original": blocks_summary(editing.get("original"), markers),
            "sha256": digest(editing),
        }
    return result


def queue_summary(value, markers):
    result = {"present": value is not None, "shape": shape(value), "sha256": digest(value)}
    if not isinstance(value, dict):
        return result
    blocks = value.get("blocks")
    uncertain = value.get("uncertainIndex")
    result.update({
        "queueEntries": len(blocks) if isinstance(blocks, list) else None,
        "uncertainIndex": uncertain if uncertain is None or type(uncertain) is int else "invalid",
        "entries": [blocks_summary(item, markers) for item in blocks] if isinstance(blocks, list) else [],
    })
    # Runtime queuePaused is deliberately not inferred from persisted fields.
    return result


def field_digests(unsent):
    if not isinstance(unsent, dict):
        return {}
    return {
        name: ({key: digest(value) for key, value in field.items()}
               if isinstance(field, dict) else digest(field))
        for name, field in unsent.items()
    }


def compare_fields(original, current):
    changed, added = {}, {}
    for field, old in original.items():
        now = current.get(field)
        if isinstance(old, dict):
            values = now if isinstance(now, dict) else {}
            changed[field] = [key for key, value in old.items() if values.get(key) != value]
        else:
            changed[field] = now != old
    for field, now in current.items():
        if isinstance(now, dict):
            old = original.get(field)
            added[field] = sorted(set(now) - set(old if isinstance(old, dict) else {}))
    return {"changedOrMissingOriginalKeys": changed, "addedKeys": added,
            "addedRootFields": sorted(set(current) - set(original))}


def main():
    base = Path(__file__).resolve().parent
    if not (base / "data-before.json").is_file() or not (base / "unsent-before.json").is_file():
        raise SystemExit("This batch has no baseline; do not observe the previous active run")
    name = sys.argv[1] if len(sys.argv) == 2 else ""
    if not name or Path(name).name != name or not name.endswith(".json"):
        raise SystemExit("Provide one new JSON filename in this evidence directory")
    output = base / name
    if output.exists():
        raise SystemExit("Refusing to overwrite an observation")
    target = json.loads((base / "target.json").read_text())
    thread = target["id"]
    main_key, edit_key = "session:" + thread, "queue-edit:" + thread
    database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT value FROM settings WHERE key=?", ("unsentWork.v1",)).fetchone()
        unsent = json.loads(row[0]) if row else None
    if not isinstance(unsent, dict):
        raise SystemExit("Unsent root is unavailable or not an object; no values recorded")
    composers, queues = unsent.get("composers"), unsent.get("queues")
    if not isinstance(composers, dict) or not isinstance(queues, dict):
        raise SystemExit("Unsent containers are not objects; no values recorded")
    markers = target["plannedMarkers"]
    queue, editor = queues.get(thread), composers.get(edit_key)
    original = json.loads((base / "unsent-before.json").read_text())["fields"]
    fields = field_digests(unsent)
    comparison = compare_fields(original, fields)
    allowed = {"composers": {main_key, edit_key}, "queues": {thread}, "activity": {thread}}
    unrelated_changes = {
        field: [key for key in keys if key not in allowed.get(field, set())]
        if isinstance(keys, list) else keys
        for field, keys in comparison["changedOrMissingOriginalKeys"].items()
    }
    unrelated_added = {
        field: [key for key in keys if key not in allowed.get(field, set())]
        for field, keys in comparison["addedKeys"].items()
    }
    result = {
        "at": datetime.datetime.now().astimezone().isoformat(),
        "scope": "read-only exact task queue/main/editor; hashes and planned marker counts only; no arbitrary text, file bodies, Agent configuration or credentials",
        "targetId": thread,
        "mainComposer": composer_summary(composers.get(main_key), markers),
        "queueEditor": composer_summary(editor, markers),
        "queue": queue_summary(queue, markers),
        "unsentFieldDigests": fields,
        "baselineComparison": comparison,
        "unrelatedOriginalChanges": unrelated_changes,
        "unrelatedAddedKeys": unrelated_added,
        "unrelatedOriginalsPreserved": not any(unrelated_changes.values()),
        "newKeysLimitedToTask": not any(unrelated_added.values()) and not comparison["addedRootFields"],
        "coldTargetIdentityCanBeInferred": False,
        "runtimeQueuePauseObserved": False,
    }
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"file": name, "queueEntries": result["queue"].get("queueEntries", 0),
                      "editorPresent": result["queueEditor"]["present"],
                      "unrelatedOriginalsPreserved": result["unrelatedOriginalsPreserved"]}))


if __name__ == "__main__":
    main()
