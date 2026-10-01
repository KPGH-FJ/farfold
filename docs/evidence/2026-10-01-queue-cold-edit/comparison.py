"""Compare saved task receipts only; never open the application or database.

Missing future stages remain not_observed. Each run writes a new derived file
and records the exact hashes of every source receipt it used.
"""
import datetime
import hashlib
import json
import sys
from pathlib import Path


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


STAGES = ["queue-before", "before-cold", "after-cold", "after-keep", "after-explicit-save", "after-cleanup"]


def compare(base, output_name, through="after-cleanup"):
    inputs, checks, stages = {}, [], {}

    def read(name, required=False):
        path = base / name
        if not path.is_file():
            if required:
                raise ValueError("Required saved receipt is absent: " + name)
            return None
        raw = path.read_bytes()
        inputs[name] = hashlib.sha256(raw).hexdigest()
        return json.loads(raw)

    def check(name, passed):
        checks.append({"name": name, "passed": bool(passed)})

    target = read("target.json", True)
    baseline = read("unsent-before.json", True)["fields"]
    thread = target["id"]
    allowed = {
        "composers": {"session:" + thread, "queue-edit:" + thread},
        "queues": {thread}, "activity": {thread},
    }
    marker_names = set(target["plannedMarkers"])

    def text_is(summary, text, marker):
        counts = summary.get("markerCounts", {})
        return (summary.get("sha256") == digest(text)
                and summary.get("characters") == len(text)
                and set(counts) == marker_names
                and all(counts[name] == (1 if name == marker else 0) for name in marker_names))

    def entry_is(entry, text, marker):
        blocks = entry.get("blocks", [])
        return (entry.get("sha256") == digest([{"type": "text", "text": text}])
                and entry.get("blockCount") == 1 and len(blocks) == 1
                and blocks[0].get("type") == "text"
                and text_is(blocks[0].get("text", {}), text, marker))

    def scope(name, value):
        check(name + ":exact-target", value.get("targetId") == thread)
        current = value["unsentFieldDigests"]
        changes, additions = {}, {}
        for field, original in baseline.items():
            now = current.get(field)
            if isinstance(original, dict):
                changes[field] = [key for key, old in original.items()
                                  if not isinstance(now, dict) or now.get(key) != old]
            else:
                changes[field] = now != original
        for field, now in current.items():
            if isinstance(now, dict):
                old = baseline.get(field)
                additions[field] = sorted(set(now) - set(old if isinstance(old, dict) else {}))
        unrelated_changes = {
            field: [key for key in changed if key not in allowed.get(field, set())]
            if isinstance(changed, list) else changed
            for field, changed in changes.items()
        }
        unrelated_added = {
            field: [key for key in added if key not in allowed.get(field, set())]
            for field, added in additions.items()
        }
        check(name + ":original-unrelated-fields-preserved", not any(unrelated_changes.values()))
        check(name + ":new-keys-only-task", not any(unrelated_added.values()) and set(current) == set(baseline))
        for object_name, field, key in [
            ("mainComposer", "composers", "session:" + thread),
            ("queueEditor", "composers", "queue-edit:" + thread),
            ("queue", "queues", thread),
        ]:
            summary = value[object_name]
            mapping = current.get(field)
            check(name + ":" + object_name + "-digest-consistency",
                  isinstance(mapping, dict) and
                  (mapping.get(key) == summary.get("sha256") if summary.get("present") else key not in mapping))
        return {"changedOriginalFields": changes, "addedFields": additions}

    snapshots = {}
    for name in STAGES:
        if STAGES.index(name) > STAGES.index(through):
            stages[name] = {"status": "not_observed"}
            continue
        value = read(name + ".json", name in {"queue-before", "before-cold"})
        if value is None:
            stages[name] = {"status": "not_observed"}
            continue
        snapshots[name] = value
        stages[name] = {"status": "observed", "at": value["at"], **scope(name, value)}

    before, original = snapshots["before-cold"], snapshots["queue-before"]
    public = target["plannedInputs"]
    check("baseline-target-three-objects-absent", all(not original[key]["present"] for key in ["mainComposer", "queueEditor", "queue"]))
    check("before-cold-main-BASE-exact", text_is(before["mainComposer"]["text"], public["BASE"], "BASE"))
    check("before-cold-editor-B_EDIT-exact", text_is(before["queueEditor"]["text"], public["B_EDIT"], "B_EDIT"))
    entries = before["queue"].get("entries", [])
    check("before-cold-ordered-B-C", len(entries) == 2 and before["queue"].get("queueEntries") == 2
          and entry_is(entries[0], public["B"], "B") and entry_is(entries[1], public["C"], "C"))
    editing = before["queueEditor"].get("queueEdit", {})
    check("before-cold-original-is-exact-first-B", bool(entries) and editing.get("index") == 0
          and editing.get("original") == entries[0])
    check("before-cold-no-attachments-or-pending-send", all(
        before[key].get("attachmentCount") == 0 and not before[key].get("sendPending")
        and not before[key].get("pendingConversationPresent") for key in ["mainComposer", "queueEditor"])
          and before["queue"].get("uncertainIndex") is None)

    cold = snapshots.get("after-cold")
    if cold:
        for key in ["mainComposer", "queueEditor", "queue"]:
            check("cold-preserves-" + key, before[key] == cold[key])

    kept = snapshots.get("after-keep")
    if kept:
        main = kept["mainComposer"]
        expected_text = public["BASE"] + "\n\n" + public["B_EDIT"]
        check("keep-main-exact-once", main.get("text", {}).get("sha256") == digest(expected_text)
              and main.get("text", {}).get("characters") == len(expected_text)
              and main.get("text", {}).get("markerCounts") == {key: int(key in {"BASE", "B_EDIT"}) for key in marker_names})
        check("keep-no-attachments-or-send", main.get("attachmentCount") == 0 and not main.get("sendPending")
              and not main.get("pendingConversationPresent"))
        check("keep-clears-editor-only", not kept["queueEditor"]["present"] and kept["queue"] == before["queue"])

    saved = snapshots.get("after-explicit-save")
    if saved:
        changed = saved["queue"].get("entries", [])
        check("save-only-first-item-changed", len(changed) == 2 and saved["queue"].get("queueEntries") == 2
              and entry_is(changed[0], public["B_EDIT"], "B_EDIT") and changed[1] == entries[1])
        check("save-clears-editor-and-is-not-uncertain", not saved["queueEditor"]["present"]
              and saved["queue"].get("uncertainIndex") is None)
        if kept:
            check("save-preserves-main-draft", saved["mainComposer"] == kept["mainComposer"])

    cleaned = snapshots.get("after-cleanup")
    if cleaned:
        check("cleanup-restores-target-absence", all(not cleaned[key]["present"] for key in ["mainComposer", "queueEditor", "queue"]))

    protocol = {}
    expected_prompts = None
    for name in ["protocol-before-cold", "protocol-after-cold", "protocol-after-keep", "protocol-after-explicit-save", "protocol-after-cleanup"]:
        if STAGES.index(name.removeprefix("protocol-")) > STAGES.index(through):
            continue
        value = read(name + ".json")
        if value is None:
            continue
        requests = [(file["file"], row) for file in value["files"] for row in file["events"]
                    if row.get("version") == 1 and row.get("dir") == "out" and row.get("event") == "session/prompt"]
        if name == "protocol-before-cold":
            expected_prompts = requests
            check(name + ":single-explicit-request", len(requests) == 1)
        elif expected_prompts is not None:
            check(name + ":same-single-prompt-record", requests == expected_prompts)
        other = {event: sum(row.get("dir") == direction and row.get("event") == event
                           for file in value["files"] for row in file["events"])
                 for direction, event in [("out", "authenticate"), ("out", "session/cancel"), ("in", "session/request_permission")]}
        protocol[name] = {"windowStart": value["windowStart"], "windowEnd": value["windowEnd"],
                          "files": len(value["files"]), "promptCount": len(requests), **other,
                          "rejectedRecords": sum(file["rejectedRecords"] for file in value["files"])}

    result = {
        "at": datetime.datetime.now().astimezone().isoformat(),
        "scope": "derived only from saved allowlisted receipts; no database/app/protocol-body read; UI pause/disabled controls and process exit require separate evidence",
        "throughStage": through, "inputSHA256": inputs, "stages": stages, "checks": checks, "protocol": protocol,
        "observedChecksPassed": all(check["passed"] for check in checks),
        "pendingStages": [name for name, stage in stages.items() if stage["status"] == "not_observed"],
        "coldPersistedTripletUnchanged": all(before[key] == cold[key] for key in ["mainComposer", "queueEditor", "queue"]) if cold else None,
    }
    output = base / output_name
    if output.exists():
        raise ValueError("Refusing to overwrite a derived receipt")
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


if __name__ == "__main__":
    if len(sys.argv) not in [2, 3] or Path(sys.argv[1]).name != sys.argv[1] or not sys.argv[1].endswith(".json"):
        raise SystemExit("Provide one new JSON filename and optionally the last observed stage")
    through = sys.argv[2] if len(sys.argv) == 3 else "after-cleanup"
    if through not in STAGES[1:]:
        raise SystemExit("Unrecognized final stage")
    result = compare(Path(__file__).resolve().parent, sys.argv[1], through)
    print(json.dumps({"checks": len(result["checks"]), "passed": result["observedChecksPassed"], "pendingStages": result["pendingStages"]}))
