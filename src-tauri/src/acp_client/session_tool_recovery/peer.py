"""Owned synthetic protocol peer. No model, network or actual tool activity."""
import json
import os
import pathlib
import sys
import threading
import time

write_lock = threading.Lock()

def handle(message):
    method = message.get("method")
    params = message.get("params", {})
    native = params.get("sessionId", "new")
    result = {}
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "mcpCapabilities": {"http": True}}, "authMethods": []}
    elif method in ("session/new", "session/load"):
        result = {"sessionId": native, "configOptions": []}
    elif method == "_goose/unstable/session/extensions/list":
        while pathlib.Path("hold-" + native).exists():
            time.sleep(0.005)
        result = json.loads(pathlib.Path("inventory-" + native + ".json").read_text())
    elif method == "session/prompt":
        result = {"stopReason": "end_turn"}
    with write_lock:
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    with open("recovery-trace.jsonl", "a") as trace:
        trace.write(json.dumps({"pid": os.getpid(), "method": message.get("method"), "params": message.get("params")}) + "\n")
    if "id" in message:
        threading.Thread(target=handle, args=(message,), daemon=True).start()
