"""Read only the test location's work fields; all unrelated policy content is hashed."""
import copy
import datetime
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

base = Path(__file__).resolve().parent
name = sys.argv[1] if len(sys.argv) > 1 else "policy-before.json"
if Path(name).name != name or not name.endswith(".json"):
    raise SystemExit("Use a JSON filename in this evidence directory")
path = base / name
if path.exists():
    raise SystemExit("Refusing to overwrite an observation")
target = json.loads((base / "target.json").read_text())
agent, cwd, thread = target["agentId"], target["cwd"], target["id"]
database = Path.home() / "Library/Application Support/ai.farfold.desktop/farfold.sqlite3"
with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
    def read(key):
        row = connection.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None
    policy = read("agentWorkPolicy.v1")
    legacy = read("agent." + agent + ".work")
    unsent = read("unsentWork.v1") or {}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def bool_field(value):
    return value if type(value) is bool or value is None else {"invalidType": type(value).__name__}


def queue_summary(value):
    if value is None:
        return {"queueEntries": 0, "queueShape": "absent", "queueKeys": []}
    if isinstance(value, dict) and isinstance(value.get("blocks"), list):
        return {"queueEntries": len(value["blocks"]), "queueShape": "object", "queueKeys": sorted(value)}
    return {"queueEntries": None, "queueShape": "unrecognized", "queueKeys": sorted(value) if isinstance(value, dict) else []}


remaining = copy.deepcopy(policy)
location = project = default = None
if isinstance(policy, dict):
    defaults, projects, locations = (policy.get(key, {}) for key in ["defaults", "projects", "locations"])
    if isinstance(defaults, dict):
        default = defaults.get(agent)
        remaining.get("defaults", {}).pop(agent, None)
    if isinstance(locations, dict):
        location = locations.get(cwd)
        remaining.get("locations", {}).pop(cwd, None)
    if isinstance(projects, dict) and isinstance(projects.get(cwd), dict):
        project = projects[cwd].get(agent)
        remaining["projects"][cwd].pop(agent, None)
        if not remaining["projects"][cwd]:
            del remaining["projects"][cwd]
composer = unsent.get("composers", {}).get("session:" + thread)
feedback = unsent.get("feedback", {}).get(thread, {})
queue = unsent.get("queues", {}).get(thread)
result = {
    "at": datetime.datetime.now().astimezone().isoformat(),
    "scope": "mode=ro; only exact task location/Agent policy fields; unrelated policy and unsent values hashed; no credentials or mutations",
    "targetId": thread, "agentId": agent, "cwd": cwd,
    "policyPresent": policy is not None,
    "version": policy.get("version") if isinstance(policy, dict) and type(policy.get("version")) is int else None,
    "targetFields": {"location": bool_field(location), "projectAgent": bool_field(project), "defaultAgent": bool_field(default)},
    "legacyAgentDefault": bool_field(legacy),
    "policySHA256": digest(policy), "unrelatedPolicySHA256": digest(remaining),
    "targetUnsentPresence": {"composerPresent": composer is not None,
                             "textCharacters": len(composer.get("text", "")) if isinstance(composer, dict) else 0,
                             "attachmentCount": len(composer.get("attachments", [])) if isinstance(composer, dict) else 0,
                             "feedbackEntries": len(feedback), **queue_summary(queue)},
    "unsentFieldDigests": {key: ({item: digest(value) for item, value in field.items()} if isinstance(field, dict) else digest(field))
                          for key, field in unsent.items()},
}
path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key != "unsentFieldDigests"}, ensure_ascii=False))
