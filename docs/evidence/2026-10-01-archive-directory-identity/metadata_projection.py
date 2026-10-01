"""Pure, content-free projection for the one task-owned archive target."""
import hashlib
import json

TARGET_ID = "opencode:/private/tmp/farfold-stop-queue-idn3cxh0:ses_f0a560db1ffeJTUeGpvCgi6hIG"
SESSION_FIELDS = ["id", "agent_id", "cwd", "native_session_id", "title",
                  "config_options", "pinned", "archived", "created_at", "updated_at"]
SESSION_QUERY = "SELECT " + ",".join(SESSION_FIELDS) + " FROM sessions"


def digest(value, *, sort_keys=False):
    return hashlib.sha256(json.dumps(
        value, ensure_ascii=False, sort_keys=sort_keys).encode()).hexdigest()


def target_session(rows):
    row = next((row for row in rows if row[0] == TARGET_ID), None)
    if row is None:
        return {"id": TARGET_ID, "present": False}
    return {
        "id": TARGET_ID, "present": True,
        "fieldHashes": {name: digest(value) for name, value in zip(SESSION_FIELDS, row)},
        "archived": bool(row[7]), "pinned": bool(row[6]),
        "createdAt": row[8], "updatedAt": row[9],
    }


def activity_projection(saved):
    activity = saved.get("activity") if isinstance(saved, dict) else None
    if not isinstance(activity, dict):
        return {"isObject": False, "target": {"key": TARGET_ID, "present": False},
                "otherKeyHashes": {}}
    present = TARGET_ID in activity
    item = activity.get(TARGET_ID)
    target = {"key": TARGET_ID, "present": present}
    if present:
        timestamp = item.get("lastActivityAt") if isinstance(item, dict) else None
        ended = item.get("ended") if isinstance(item, dict) else None
        valid = (type(timestamp) in (int, float) and 0 < timestamp < 2 ** 53
                 and type(ended) is bool)
        target.update({"sha256": digest(item, sort_keys=True), "shapeValid": valid,
                       "lastActivityAt": timestamp if valid else None,
                       "ended": ended if valid else None})
    return {
        "isObject": True, "target": target,
        "otherKeyHashes": {key: digest(value, sort_keys=True)
                           for key, value in activity.items() if key != TARGET_ID},
    }
