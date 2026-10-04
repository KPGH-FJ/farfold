"""Disposable stdio MCP shim to one already-running synthetic WK page.

Only the launcher selects a socket and supplies a fresh capability over an
anonymous pipe. Tool input cannot select a command, path, URL or JavaScript.
The shim never starts a native process. This is not a production broker.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import stat
import sys
import time
from pathlib import Path

PROTOCOL_VERSION = "2025-06-18"
MAX_MESSAGE = 65536
SCOPE = {"taskKey": "running-page-task", "label": "running-page", "generation": 1}
ARG_FIELDS = {"requestId", *SCOPE}
SNAPSHOT_FIELDS = ARG_FIELDS | {"instanceId", "revision", "readId", "nativeReadCount",
    "nativeCreateCount", "sameNativeInstance", "url", "title", "text", "observedAtMs"}


class ToolFailure(Exception):
    pass


def consume_capability(fd: int) -> str:
    if fd < 3:
        raise ToolFailure("页面读取暂不可用")
    with os.fdopen(fd, "rb", buffering=0) as pipe:
        raw = pipe.read(66)
    if re.fullmatch(rb"[0-9a-f]{64}\n?", raw) is None:
        raise ToolFailure("页面读取暂不可用")
    return raw.decode().strip()


class SocketBackend:
    def __init__(self, path: Path, capability: str):
        self.path = path
        self.capability = capability

    def read(self, arguments: dict) -> dict:
        if (not isinstance(arguments, dict) or set(arguments) != ARG_FIELDS
                or not isinstance(arguments["requestId"], str)
                or re.fullmatch(r"[A-Za-z0-9_-]{1,64}", arguments["requestId"]) is None
                or type(arguments["generation"]) is not int):
            raise ToolFailure("页面读取参数不正确")
        if any(arguments[key] != value for key, value in SCOPE.items()):
            raise ToolFailure("此页面当前不可读取")
        try:
            parent = self.path.parent.lstat()
            entry = self.path.lstat()
            if (not stat.S_ISDIR(parent.st_mode) or stat.S_IMODE(parent.st_mode) != 0o700
                    or parent.st_uid != os.getuid() or not stat.S_ISSOCK(entry.st_mode)
                    or stat.S_IMODE(entry.st_mode) != 0o600 or entry.st_uid != os.getuid()):
                raise ToolFailure("此页面当前不可读取")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(12)
                connection.connect(str(self.path))
                message = {"op": "snapshot", **arguments, "capability": self.capability}
                connection.sendall(json.dumps(message, separators=(",", ":")).encode() + b"\n")
                with connection.makefile("rb") as stream:
                    data = stream.readline(MAX_MESSAGE + 1)
                if len(data) > MAX_MESSAGE or not data.endswith(b"\n"):
                    raise ToolFailure("页面读取结果无法核对")
            result = json.loads(data)
            if not isinstance(result, dict) or result.get("ok") is not True:
                raise ToolFailure("此页面当前不可读取")
            if not SNAPSHOT_FIELDS <= result.keys():
                raise ToolFailure("页面读取结果无法核对")
            if any(result[key] != arguments[key] for key in ARG_FIELDS):
                raise ToolFailure("页面读取结果已失效")
            if (not isinstance(result["instanceId"], str) or not 1 <= len(result["instanceId"]) <= 80
                    or type(result["generation"]) is not int or type(result["revision"]) is not int
                    or type(result["readId"]) not in (int, str)
                    or type(result["nativeReadCount"]) is not int or result["nativeReadCount"] < 1
                    or type(result["nativeCreateCount"]) is not int or result["nativeCreateCount"] != 1
                    or result["sameNativeInstance"] is not True
                    or result["revision"] < 1 or result["url"] != "about:blank"
                    or not isinstance(result["title"], str) or len(result["title"]) > 512
                    or not isinstance(result["text"], str) or len(result["text"]) > 20000
                    or type(result["observedAtMs"]) is not int
                    or not 0 < result["observedAtMs"] <= int(time.time() * 1000) + 5000):
                raise ToolFailure("页面读取结果无法核对")
            return {key: result[key] for key in sorted(SNAPSHOT_FIELDS)}
        except ToolFailure:
            raise
        except Exception:
            raise ToolFailure("页面读取未完成") from None


def tool_descriptor():
    return {
        "name": "read_page_snapshot", "description": "Read the granted running synthetic page.",
        "inputSchema": {"type": "object", "additionalProperties": False,
            "properties": {"requestId": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
                "taskKey": {"type": "string", "const": SCOPE["taskKey"]},
                "label": {"type": "string", "const": SCOPE["label"]},
                "generation": {"type": "integer", "const": SCOPE["generation"]}},
            "required": sorted(ARG_FIELDS)},
        "annotations": {"readOnlyHint": True, "destructiveHint": False,
                        "idempotentHint": True, "openWorldHint": False},
    }


class Peer:
    def __init__(self, backend):
        self.backend = backend
        self.initialized = False
        self.ready = False

    @staticmethod
    def error(request_id, code, message):
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    def handle(self, message):
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return self.error(None, -32600, "Invalid request")
        request_id = message.get("id")
        method = message.get("method")
        if not isinstance(method, str) or ("id" in message and type(request_id) not in (int, str)):
            return self.error(None, -32600, "Invalid request")
        if "id" not in message:
            if method == "notifications/initialized" and self.initialized:
                self.ready = True
            return None
        params = message.get("params", {})
        if not isinstance(params, dict):
            return self.error(request_id, -32602, "Invalid params")
        if method == "initialize":
            if (self.initialized or not isinstance(params.get("protocolVersion"), str)
                    or not isinstance(params.get("capabilities"), dict)
                    or not isinstance(params.get("clientInfo"), dict)
                    or not isinstance(params["clientInfo"].get("name"), str)
                    or not isinstance(params["clientInfo"].get("version"), str)):
                return self.error(request_id, -32602, "Invalid initialization")
            self.initialized = True
            result = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}},
                      "serverInfo": {"name": "farfold-running-page-probe", "version": "0.0.0"}}
        elif method == "ping":
            result = {}
        elif not self.ready:
            return self.error(request_id, -32002, "Initialization required")
        elif method == "tools/list":
            result = {"tools": [tool_descriptor()]}
        elif method == "tools/call":
            if params.get("name") != "read_page_snapshot" or set(params) != {"name", "arguments"}:
                return self.error(request_id, -32602, "Unknown tool or invalid params")
            try:
                snapshot = self.backend.read(params["arguments"])
                result = {"content": [{"type": "text", "text": json.dumps(snapshot, ensure_ascii=False)}],
                          "structuredContent": snapshot, "isError": False}
            except ToolFailure as error:
                result = {"content": [{"type": "text", "text": str(error)}], "isError": True}
        else:
            return self.error(request_id, -32601, "Method not found")
        return {"jsonrpc": "2.0", "id": request_id, "result": result}


def serve(peer):
    while True:
        line = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
        if not line:
            return
        if len(line) > MAX_MESSAGE:
            print(json.dumps(peer.error(None, -32600, "Request too large")), flush=True)
            return
        try:
            message = json.loads(line)
        except (ValueError, UnicodeError):
            response = peer.error(None, -32700, "Parse error")
        else:
            response = peer.handle(message)
        if response is not None:
            print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("socket_path", type=Path)
    parser.add_argument("capability_fd", type=int)
    args = parser.parse_args()
    try:
        capability = consume_capability(args.capability_fd)
        serve(Peer(SocketBackend(args.socket_path, capability)))
    except Exception:
        # No traceback, command dump, environment or capability diagnostic.
        sys.exit(1)
