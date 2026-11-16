"""Finite synthetic config peer. All reads/writes stay in the supplied fixture."""
import json
from pathlib import Path
import sys
import time

root = Path(sys.argv[1])
cwd, target, mode = sys.argv[2:5]
state_path = root / "state.json"
state = json.loads(state_path.read_text())


def save():
    state_path.write_text(json.dumps(state))


def emit(identifier, result=None, error=None):
    value = {"id": identifier}
    value["error" if error is not None else "result"] = error if error is not None else result
    print(json.dumps(value), flush=True)


for line in sys.stdin:
    message = json.loads(line)
    method, params, identifier = message["method"], message.get("params", {}), message.get("id")
    state.setdefault("methods", []).append(method)
    save()
    if method == "initialize":
        emit(identifier, {"userAgent": "owned-skill-preference-removal-peer"})
    elif method == "initialized":
        assert identifier is None
    elif method == "config/read":
        assert params == {"includeLayers": True, "cwd": None}
        emit(identifier, state["config"])
    elif method == "skills/list":
        assert params == {"cwds": [cwd], "forceReload": True}
        skills = [] if mode == "missing-after" and state["writes"] else [{
            "name": "fixture", "path": target, "scope": "user",
            "enabled": state["enabled"], "description": "Owned synthetic fixture",
        }]
        emit(identifier, {"data": [{"cwd": cwd, "skills": skills, "errors": []}]})
    elif method == "config/value/write":
        user = next(row for row in state["config"]["layers"] if row["name"]["type"] == "user")
        assert set(params) == {"keyPath", "value", "mergeStrategy", "filePath", "expectedVersion"}
        assert params["keyPath"] == "skills.config" and params["mergeStrategy"] == "replace"
        assert params["filePath"] == user["name"]["file"] and params["expectedVersion"] == user["version"]
        if mode == "reject":
            emit(identifier, error={"code": -32600, "message": "PRIVATE_ERROR_CANARY", "data": {"config_write_error_code": "configVersionConflict"}})
            continue
        state["writes"] += 1
        state["writeParams"] = params
        if mode != "keep-rule":
            if params["value"] is None:
                del user["config"]["skills"]["config"]
                if mode == "drop-empty-parent" and not user["config"]["skills"]:
                    del user["config"]["skills"]
            else:
                user["config"]["skills"]["config"] = params["value"]
        if mode == "corrupt-other":
            user["config"]["private"]["canary"] = "CHANGED"
        user["version"] = "after-write"
        # A lower-priority/name rule may still disable the skill after removal.
        state["enabled"] = mode != "reported-disabled"
        save()
        if mode == "lost-ack":
            sys.exit(0)
        if mode == "hold-after-write":
            (root / "write-seen").write_text("owned gate")
            limit = time.monotonic() + 5
            while not (root / "release").exists() and time.monotonic() < limit:
                time.sleep(0.01)
        emit(identifier, {"status": "ok", "version": user["version"], "filePath": user["name"]["file"]})
    else:
        raise AssertionError("unexpected fixed method")
