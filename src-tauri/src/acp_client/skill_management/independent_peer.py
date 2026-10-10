"""Synthetic JSONL peer for independent tests; never reads Agent configuration.

The caller creates a private fixture directory. Every durable write below is to
that directory, including the fake configuration and an audit of received RPCs.
"""

import copy
import json
import os
from pathlib import Path
import signal
import sys
import time


root = Path(sys.argv[1]).resolve(strict=True)
fixture = json.loads((root / "peer-fixture.json").read_text())
mode = fixture["mode"]
state_path = root / "peer-state.json"
state = (
    json.loads(state_path.read_text())
    if state_path.exists()
    else {"config": fixture["config"], "enabled": True, "writes": 0}
)


def save():
    state_path.write_text(json.dumps(state))


def emit(request_id, result=None, error=None):
    envelope = {"id": request_id}
    envelope["error" if error is not None else "result"] = (
        error if error is not None else result
    )
    print(json.dumps(envelope), flush=True)


def error(request_id, code):
    emit(
        request_id,
        error={
            "code": -32600,
            "message": "SYNTHETIC_PRIVATE_ERROR_MUST_NOT_BE_PUBLISHED",
            "data": {"config_write_error_code": code},
        },
    )


def skills():
    return {
        "data": [
            {
                "cwd": str(root),
                "skills": [
                    {
                        "name": "independent-skill",
                        "description": "Synthetic independent fixture",
                        "path": fixture["target"],
                        "scope": "repo",
                        "enabled": state["enabled"],
                        "pluginId": None,
                    }
                ],
                "errors": [],
            }
        ]
    }


save()
for line in sys.stdin:
    message = json.loads(line)
    with (root / "peer-audit.jsonl").open("a") as audit:
        audit.write(json.dumps(message) + "\n")
    method = message["method"]
    params = message.get("params", {})
    request_id = message.get("id")
    if method == "initialize":
        emit(request_id, {"userAgent": "independent-synthetic-peer"})
    elif method == "initialized":
        assert request_id is None
    elif method == "config/read":
        assert params == {"includeLayers": True, "cwd": None}
        emit(request_id, state["config"])
    elif method == "skills/list":
        assert params == {"cwds": [str(root)], "forceReload": True}
        emit(request_id, skills())
    elif method == "config/value/write":
        user = next(
            row for row in state["config"]["layers"] if row["name"]["type"] == "user"
        )
        assert set(params) == {
            "keyPath", "value", "mergeStrategy", "filePath", "expectedVersion"
        }
        assert params["keyPath"] == "skills.config"
        assert params["mergeStrategy"] == "replace"
        assert params["filePath"] == user["name"]["file"]
        assert params["expectedVersion"] == user["version"]
        if mode.startswith("reject:"):
            error(request_id, mode.split(":", 1)[1])
            continue
        state["writes"] += 1
        user["config"].setdefault("skills", {})["config"] = copy.deepcopy(params["value"])
        user["version"] = "after-independent-write"
        state["enabled"] = params["value"][-1]["enabled"]
        if mode == "non_target_corruption":
            user["config"]["independentUnknown"]["keep"] = "CORRUPTED"
        if mode == "skill_mismatch":
            state["enabled"] = not state["enabled"]
        save()
        if mode == "postwrite_user_layer_missing":
            error(request_id, "userLayerNotFound")
        elif mode == "postwrite_internal":
            emit(request_id, error={"code": -32603, "message": "synthetic after write"})
        elif mode == "postwrite_malformed_rejection":
            emit(request_id, error={"data": {"config_write_error_code": "configValidationError"}})
        elif mode == "postwrite_lost_ack":
            sys.exit(0)
        elif mode == "postwrite_held_child":
            child = os.fork()
            if child == 0:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                (root / "held-child.pid").write_text(str(os.getpid()))
                end = time.monotonic() + 5
                while not (root / "release-child").exists() and time.monotonic() < end:
                    time.sleep(0.01)
                os._exit(0)
            (root / "leader-exiting").write_text(str(os.getpid()))
            os._exit(0)
        else:
            emit(
                request_id,
                {
                    "status": "okOverridden" if mode == "overridden" else "ok",
                    "version": user["version"],
                    "filePath": user["name"]["file"],
                    "overriddenMetadata": None,
                },
            )
    else:
        raise AssertionError("unexpected method: " + method)
