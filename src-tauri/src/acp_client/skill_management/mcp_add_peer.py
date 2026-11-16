"""Fixed synthetic peer. Never launches the new command; only owns temporary state."""
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


def transport(entry):
    if "url" in entry:
        return {"type": "streamable_http", "url": entry["url"], "bearer_token_env_var": None,
                "http_headers": None, "env_http_headers": {}, "http_headers_helper": None}
    return {"type": "stdio", "command": entry["command"], "args": entry["args"], "env": None, "env_vars": [], "cwd": None}


if stage == "list":
    rows = list(state["listed"])
    entry = state["config"]["layers"][0]["config"].get("mcp_servers", {}).get(state["name"])
    if entry:
        rows.append({"name": state["name"], "enabled": entry["enabled"], "transport": transport(entry), "auth_status": "unsupported"})
    if mode == "fresh-collision":
        rows = [{"name": state["name"], "enabled": False, "transport": {"type": "future"}, "auth_status": "unsupported"}]
    print(json.dumps(rows), flush=True)
    sys.exit(0)
if stage == "get":
    if mode == "postget-fail":
        sys.exit(9)
    if mode == "postget-wait":
        import os
        import signal
        import time
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        temporary = root / "waiting.tmp"
        temporary.write_text(str(os.getpid()))
        temporary.replace(root / "waiting")
        time.sleep(60)
    entry = state["config"]["layers"][0]["config"].get("mcp_servers", {}).get(state["name"])
    if entry is None:
        sys.exit(4)
    result_transport = transport(entry)
    if mode == "postget-args-drift":
        result_transport["args"] = ["changed-after-config-read"]
    if mode == "postget-env-drift":
        result_transport["env"] = {"PRIVATE": "never-public"}
    if mode == "postget-url-drift":
        result_transport["url"] = entry["url"] + "&changed=1"
    if mode == "postget-header-drift":
        result_transport["http_headers"] = {"Authorization": "PRIVATE_HEADER_CANARY"}
    if mode == "postget-helper-drift":
        result_transport["http_headers_helper"] = "<redacted>"
    print(json.dumps({"name": state["name"], "enabled": entry["enabled"], "disabled_reason": None, "transport": result_transport, "enabled_tools": None, "disabled_tools": None, "startup_timeout_sec": None, "tool_timeout_sec": None}), flush=True)
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
        state.setdefault("readScopes", []).append(request["params"]["cwd"])
        save()
        value = json.loads(json.dumps(state["config"]))
        if mode == "directory-drift" and state["writes"] and request["params"]["cwd"] is not None:
            value["layers"][0]["config"]["future"] = "directory-drift"
        if mode == "disabled-layer" and request["params"]["cwd"] is not None:
            value["layers"].append({"name": {"type": "project", "file": "/synthetic/project.toml"}, "version": "p", "config": {"mcp_servers": {state["name"]: {"command": "/other"}}}, "disabledReason": "not trusted"})
        send(request, value)
    elif method == "config/value/write":
        params = request["params"]
        state["writeParams"] = params
        if mode == "refused":
            send(request, error={"code": -32600, "message": "private error", "data": {"config_write_error_code": "configVersionConflict"}})
            continue
        assert params["keyPath"] == 'mcp_servers."' + state["name"] + '"'
        assert params["value"]["enabled"] is False
        assert set(params["value"]) == ({"enabled", "url"} if "url" in params["value"] else {"enabled", "command", "args"})
        assert params["mergeStrategy"] == "replace"
        assert params["expectedVersion"] == state["config"]["layers"][0]["version"]
        assert params["filePath"] == state["config"]["layers"][0]["name"]["file"]
        state["config"]["layers"][0]["config"].setdefault("mcp_servers", {})[state["name"]] = params["value"]
        state["config"]["layers"][0]["version"] = "v2"
        state["writes"] += 1
        if mode == "changed-other":
            state["config"]["layers"][0]["config"]["future"] = "changed"
        save()
        if mode == "lost-ack":
            sys.exit(0)
        if mode == "postwrite-error":
            send(request, error={"code": -32600, "message": "private error", "data": {"config_write_error_code": "userLayerNotFound"}})
        else:
            send(request, {"status": "ok", "version": "v2", "filePath": params["filePath"]})
    else:
        raise AssertionError("unexpected method")
