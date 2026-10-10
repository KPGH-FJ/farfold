"""Synthetic fixed exchange; writes only the test's temporary JSON state."""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
stage = sys.argv[3]
state_path = root / "state.json"
state = json.loads(state_path.read_text())


def save():
    state_path.write_text(json.dumps(state))


def send(request, result=None, error=None):
    value = {"id": request["id"]}
    value["error" if error is not None else "result"] = error if error is not None else result
    print(json.dumps(value), flush=True)


if stage == "get":
    if state["writes"] and mode == "postget-fail":
        sys.exit(9)
    if state["writes"] and mode == "postget-wait":
        __import__("signal").signal(__import__("signal").SIGTERM, __import__("signal").SIG_IGN)
        (root / "postget-waiting").write_text(str(__import__("os").getpid()))
        __import__("time").sleep(60)
    result = state["report"]
    result["enabled"] = state["config"]["layers"][0]["config"]["mcp_servers"][state["name"]].get("enabled", True)
    if state["writes"] and mode == "postget-filter-drift":
        result["enabled_tools"] = ["changed-after-configuration-read"]
    if state["writes"] and mode == "policy-disabled":
        result["enabled"] = False
        result["disabled_reason"] = "requirements (synthetic)"
    print(json.dumps(result), flush=True)
    sys.exit(0)

for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    state["methods"].append(method)
    save()
    if method == "initialize":
        send(request, {"userAgent": "synthetic-only"})
    elif method == "initialized":
        pass
    elif method == "config/read":
        result = json.loads(json.dumps(state["config"]))
        if request["params"]["cwd"] is not None and mode == "project-conflict":
            result["layers"].insert(0, {"name": {"type": "project", "file": "/synthetic/project.toml"}, "version": "p1", "config": {"mcp_servers": {state["name"]: {"enabled": False}}}})
        send(request, result)
    elif method == "config/value/write":
        params = request["params"]
        state["writeParams"] = params
        if mode == "refused":
            send(request, error={"code": -32600, "message": "synthetic private error", "data": {"config_write_error_code": "configVersionConflict"}})
            continue
        # Verify the literal segment; never split an embedded dot into parents.
        encoded_name = state["name"].replace("\\", "\\\\").replace('"', '\\"')
        assert params["keyPath"] == 'mcp_servers."' + encoded_name + '".enabled'
        assert params["value"] in (True, False)
        assert params["mergeStrategy"] == "replace"
        assert params["filePath"] == state["config"]["layers"][0]["name"]["file"]
        state["config"]["layers"][0]["config"]["mcp_servers"][state["name"]]["enabled"] = params["value"]
        state["config"]["layers"][0]["version"] = "after-v1"
        state["writes"] += 1
        if mode == "changed-other":
            state["config"]["layers"][0]["config"]["other"]["future"] = "changed"
        save()
        if mode == "lost-ack":
            sys.exit(0)
        if mode == "postwrite-error":
            send(request, error={"code": -32600, "message": "synthetic private error", "data": {"config_write_error_code": "userLayerNotFound"}})
        else:
            send(request, {"status": "ok", "version": "after-v1", "filePath": params["filePath"]})
    else:
        raise AssertionError("unexpected method")
