"""Controlled stdio peer for session-tools tests; no model, network or tool execution."""
import json
import os
import pathlib
import signal
import sys
import threading
import time

lock = threading.Lock()


def send(value):
    with lock:
        print(json.dumps(dict(jsonrpc="2.0", **value)), flush=True)


def reply(message, value):
    send({"id": message["id"], "result": value})


def tools(message):
    pathlib.Path("tools-started").write_text("started")
    while pathlib.Path("hold").exists():
        time.sleep(0.005)
    if pathlib.Path("unsupported").exists():
        send({"id": message["id"], "error": {"code": -32601, "message": "PRIVATE_ERROR_CANARY"}})
    elif pathlib.Path("rpc-error").exists():
        send({"id": message["id"], "error": {"code": -32603, "message": "PRIVATE_ERROR_CANARY", "data": {"secret": "PRIVATE_ERROR_CANARY"}}})
    elif pathlib.Path("invalid").exists():
        reply(message, {"tools": [{"name": True, "secret": "PRIVATE_SCHEMA_CANARY"}]})
    elif pathlib.Path("empty").exists():
        reply(message, {"tools": []})
    else:
        reply(message, {"tools": [{"name": "owned_readonly", "description": "Synthetic tool description", "permission": "never_allow", "parameters": ["PRIVATE_SCHEMA_CANARY"], "inputSchema": {"secret": "PRIVATE_SCHEMA_CANARY"}}]})
    pathlib.Path("tools-replied").write_text("replied")


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    with open("trace.jsonl", "a") as trace:
        trace.write(json.dumps({"method": method, "params": message.get("params")}) + "\n")
    if method == "initialize":
        reply(message, {"protocolVersion": 1, "agentCapabilities": {}, "authMethods": []})
    elif method == "session/new":
        reply(message, {"sessionId": "owned-tools", "configOptions": []})
    elif method == "_goose/unstable/tools/list":
        if pathlib.Path("transport-error").exists():
            signal.signal(signal.SIGTERM, lambda *args: None)
            os.close(1)
            while True:
                time.sleep(0.1)
        threading.Thread(target=tools, args=(message,), daemon=True).start()
    else:
        send({"id": message.get("id"), "error": {"code": -32601, "message": "PRIVATE_ERROR_CANARY"}})
