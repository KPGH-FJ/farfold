"""Synthetic fixed official responses; operates only on this test's temp state."""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
mode, stage = sys.argv[2:4]
path = root / "state.json"
state = json.loads(path.read_text())


def save():
    path.write_text(json.dumps(state))


def send(request, value=None, error=None):
    print(json.dumps({"id": request["id"], "error" if error else "result": error or value}), flush=True)


def report(entry):
    if "url" in entry:
        transport = {"type": "streamable_http", "url": entry["url"], "http_headers": entry.get("http_headers")}
    else:
        transport = {"type": "stdio", "command": entry["command"], "args": entry.get("args", []), "env": entry.get("env")}
    return {"name": state["name"], "enabled": entry.get("enabled", True), "disabled_reason": None, "transport": transport, "auth_status": "unsupported", "enabled_tools": entry.get("enabled_tools")}


raw = state["config"]["layers"][0]["config"]
if stage == "get":
    state["gets"] += 1
    save()
    entry = raw.get("mcp_servers", {}).get(state["name"])
    if entry is None:
        sys.exit(4)
    value = report(entry)
    if mode == "get-drift":
        value["enabled_tools"] = ["changed"]
    if mode == "policy-disabled":
        value["disabled_reason"] = "policy"
    print(json.dumps(value), flush=True)
    sys.exit(0)
if stage == "list":
    state["lists"] += 1
    save()
    if mode == "postlist-fail":
        sys.exit(9)
    if mode == "postlist-wait":
        import os
        import signal
        import time
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        (root / "waiting").write_text(str(os.getpid()))
        time.sleep(60)
    entry = raw.get("mcp_servers", {}).get(state["name"])
    rows = [report(entry)] if entry else []
    if mode == "present-false":
        rows = [{"name": state["name"], "enabled": False, "transport": {"type": "future"}, "auth_status": "unsupported"}]
    if mode == "duplicate-list":
        rows = [{"name": "hidden/name", "enabled": False, "transport": {"type": "future"}, "auth_status": "unsupported"}] * 2
    if mode == "malformed-list":
        print('[{"name":"hidden/name","enabled":false}]', flush=True)
    elif mode == "trailing-list":
        print("[] trailing", flush=True)
    else:
        print(json.dumps(rows), flush=True)
    sys.exit(0)
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    state["methods"].append(method)
    save()
    if method == "initialize":
        send(request, {"userAgent": "synthetic"})
    elif method == "initialized":
        pass
    elif method == "config/read":
        value = json.loads(json.dumps(state["config"]))
        if mode == "disabled-layer" and request["params"]["cwd"] is not None:
            value["layers"].append({"name": {"type": "project", "file": "/synthetic/project.toml"}, "version": "p", "config": {"mcp_servers": {state["name"]: {"command": "/other"}}}, "disabledReason": "not trusted"})
        if mode == "split-parents" and state["writes"] and request["params"]["cwd"] is not None:
            value["layers"][0]["config"].pop("mcp_servers", None)
        send(request, value)
    elif method == "config/value/write":
        params = request["params"]
        state["writeParams"] = params
        if mode == "refused":
            save()
            send(request, error={"code": -32600, "message": "PRIVATE_ERROR", "data": {"config_write_error_code": "configVersionConflict"}})
            continue
        assert params["keyPath"] == 'mcp_servers.' + json.dumps(state["name"], ensure_ascii=False)
        assert params["value"] is None
        assert params["mergeStrategy"] == "replace"
        assert params["expectedVersion"] == state["config"]["layers"][0]["version"]
        assert params["filePath"] == state["config"]["layers"][0]["name"]["file"]
        table = state["config"]["layers"][0]["config"]["mcp_servers"]
        del table[state["name"]]
        if mode == "absent-parent" and not table:
            del state["config"]["layers"][0]["config"]["mcp_servers"]
        if mode == "new-sibling":
            table["external"] = {"command": "/not-executed", "enabled": False}
        if mode == "other-drift":
            state["config"]["layers"][0]["config"]["future"] = "changed"
        state["config"]["layers"][0]["version"] = "v2"
        state["writes"] += 1
        save()
        if mode == "lost-ack":
            sys.exit(0)
        if mode == "postwrite-error":
            send(request, error={"code": -32600, "message": "PRIVATE_ERROR", "data": {"config_write_error_code": "userLayerNotFound"}})
        else:
            send(request, {"status": "ok", "version": "v2", "filePath": params["filePath"]})
    else:
        raise AssertionError("unexpected method")
