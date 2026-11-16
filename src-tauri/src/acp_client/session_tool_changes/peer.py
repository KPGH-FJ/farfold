"""Owned synthetic peer; no network, model, tool execution or real Agent data."""
import copy
import json
import os
import pathlib
import signal
import sys
import threading
import time

lock = threading.Lock()
stored = [{"extensionKey": "original-key", "extension": {"type": "platform", "name": "developer"}}]
live = {}
selected_model = "selected-a"

def flag(name):
    return pathlib.Path(name).exists()

def send(message, value=None, error=False):
    result = {"jsonrpc": "2.0", "id": message["id"]}
    result["error" if error else "result"] = {"code": -32603, "message": "PRIVATE_ERROR_CANARY"} if error else value
    with lock:
        print(json.dumps(result), flush=True)

def handle(message):
    global selected_model
    method = message["method"]
    params = message.get("params", {})
    if method == "initialize":
        send(message, {"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "mcpCapabilities": {"http": True}}, "authMethods": []})
    elif method in ("session/new", "session/load"):
        send(message, {"sessionId": "owned-change", "configOptions": options()})
    elif method == "session/set_config_option":
        selected_model = params["value"]
        send(message, {"configOptions": options()})
    elif method.endswith("session/extensions/list"):
        pathlib.Path("list-started").write_text("yes")
        while flag("hold-list"):
            time.sleep(0.005)
        if flag("seed-http") and not flag("seeded"):
            stored.append({"extensionKey":"prior-key", "extension":{"type":"mcp", "server":{"type":"http","name":"Prior","url":"https://example.invalid/?secret=PRIVATE_URL_CANARY","headers":[]}}})
            if flag("duplicate-name"):
                stored.append({"extensionKey":"another-prior-key", "extension":{"type":"mcp", "server":{"type":"http","name":"P R I O R","url":"https://second.invalid/","headers":[]}}})
            pathlib.Path("seeded").write_text("yes")
        if flag("drift-before-remove") and not flag("drifted"):
            stored.append({"extensionKey":"external-key", "extension":{"type":"platform","name":"External"}})
            pathlib.Path("drifted").write_text("yes")
        if flag("invalid-list"):
            send(message, {"extensions": [None]})
        else:
            send(message, {"extensions": copy.deepcopy(stored)})
    elif method.endswith("session/extensions/add"):
        if flag("unsupported-add"):
            with lock:
                print(json.dumps({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":"PRIVATE_ERROR_CANARY"}}),flush=True)
            return
        entry = {"extensionKey": "assigned-exact-key", "extension": copy.deepcopy(params["extension"])}
        live[entry["extensionKey"]] = entry
        if not flag("save-failure"):
            stored.append(entry)
        pathlib.Path("mutation-applied").write_text("yes")
        while flag("hold-add"):
            time.sleep(0.005)
        if flag("transport-loss"):
            os.close(1)
            while not flag("end-process"):
                time.sleep(0.005)
            os._exit(0)
        if flag("drift-after-add"):
            stored.append({"extensionKey": "external-key", "extension": {"type": "platform", "name": "External"}})
        send(message, {}, error=flag("save-failure"))
    elif method.endswith("session/extensions/remove"):
        key = params["extensionKey"]
        live.pop(key, None)
        if flag("remove-save-failure"):
            send(message, error=True)
        else:
            stored[:] = [entry for entry in stored if entry["extensionKey"] != key]
            send(message, {})
    elif method == "_goose/unstable/tools/list":
        if flag("invalid-tools"):
            send(message, {"tools": [None]})
        elif flag("hidden-tools"):
            send(message, {"tools": []})
        else:
            tools = [] if params.get("extensionName") else [{"name": "developer__read"}]
            if live:
                tools.append({"name": "owned__report"})
            send(message, {"tools": tools})
    elif method == "session/close":
        send(message, {})
    elif method == "session/prompt":
        send(message, {"stopReason": "end_turn"})
    else:
        send(message, error=True)

def options():
    if not flag("choices"):
        return []
    return [{"id":"model", "name":"Model", "category":"model", "type":"select", "currentValue":selected_model,
             "options":[{"value":value,"name":value} for value in ("selected-a","selected-b")]}]

def inject_configuration():
    global selected_model
    while True:
        if flag("inject-configuration"):
            selected_model = "selected-b"
            with lock:
                print(json.dumps({"jsonrpc":"2.0", "method":"session/update", "params":{"sessionId":"owned-change", "update":{"sessionUpdate":"config_option_update", "configOptions":options()}}}), flush=True)
            pathlib.Path("inject-configuration").unlink()
            pathlib.Path("configuration-injected").write_text("yes")
        time.sleep(0.005)

threading.Thread(target=inject_configuration, daemon=True).start()

for line in sys.stdin:
    message = json.loads(line)
    with open("trace.jsonl", "a") as trace:
        trace.write(json.dumps({"method": message.get("method"), "params": message.get("params")}) + "\n")
    if message.get("method", "").endswith("session/extensions/add"):
        if flag("transport-loss"):
            signal.signal(signal.SIGTERM, lambda *args: None)
        threading.Thread(target=handle, args=(message,), daemon=True).start()
    else:
        handle(message)
