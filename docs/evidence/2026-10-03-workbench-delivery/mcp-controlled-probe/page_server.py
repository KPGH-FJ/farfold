"""Disposable MCP stdio validation peer. Not installed or injected into Farfold.

Only the fixed synthetic native probe can be launched. No model, Agent, login,
network, arbitrary JavaScript, URL, file read, or general command tool exists.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent
NATIVE = ROOT.parent / "browser-seam-validation" / "seam-probe"
PROTOCOL_VERSION = "2025-06-18"
MAX_LINE = 65536
SCOPE = {"taskKey": "mcp-controlled-task", "label": "mcp-controlled-page", "revision": 1}
FIELDS = {"requestId", "taskKey", "label", "revision"}
SNAPSHOT_FIELDS = FIELDS | {"url", "title", "text", "observedAtMs"}


class ToolFailure(Exception):
    """Safe public error; never includes backend exception details."""


@dataclass(eq=False)
class Grant:
    task_key: str
    label: str
    revision: int


class ControlledRead:
    """Probe-local grant check, not evidence of a production sharing/secret gate.

    Revocation during a submitted operation discards its eventual result. The
    native operation is not represented as cancelled. Resuming creates a fresh
    grant, so an old in-flight read cannot regain authority after pause/resume.
    """

    def __init__(self, backend: Callable[[dict], dict]):
        self.backend = backend
        self.grant: Grant | None = Grant(SCOPE["taskKey"], SCOPE["label"], SCOPE["revision"])

    def revoke(self):
        self.grant = None

    def grant_again_for_test(self):
        self.grant = Grant(SCOPE["taskKey"], SCOPE["label"], SCOPE["revision"])

    def read(self, arguments: dict) -> dict:
        if (
            not isinstance(arguments, dict)
            or set(arguments) != FIELDS
            or not isinstance(arguments["requestId"], str)
            or re.fullmatch(r"[A-Za-z0-9_-]{1,64}", arguments["requestId"]) is None
            or type(arguments["revision"]) is not int
        ):
            raise ToolFailure("页面读取参数不正确")
        grant = self.grant
        if grant is None or (
            arguments["taskKey"], arguments["label"], arguments["revision"]
        ) != (grant.task_key, grant.label, grant.revision):
            raise ToolFailure("此页面当前不可读取")
        try:
            try:
                snapshot = self.backend(dict(arguments))
            except Exception:
                raise ToolFailure("页面读取未完成") from None
            if self.grant is not grant:
                raise ToolFailure("此页面当前不可读取")
            if not isinstance(snapshot, dict) or not SNAPSHOT_FIELDS <= snapshot.keys():
                raise ToolFailure("页面读取结果无法核对")
            if any(snapshot[field] != arguments[field] for field in FIELDS):
                raise ToolFailure("页面读取结果已失效")
            if (
                snapshot["url"] != "about:blank"
                or not isinstance(snapshot["title"], str)
                or len(snapshot["title"]) > 512
                or not isinstance(snapshot["text"], str)
                or len(snapshot["text"]) > 20000
                or type(snapshot["observedAtMs"]) is not int
                or not 0 < snapshot["observedAtMs"] <= int(time.time() * 1000) + 5000
            ):
                raise ToolFailure("页面读取结果无法核对")
            return {field: snapshot[field] for field in sorted(SNAPSHOT_FIELDS)}
        finally:
            # Submitted one-shot work consumes its original grant on success or
            # failure. Never clear a fresh grant issued while it was running.
            if self.grant is grant:
                self.grant = None


class NativeBackend:
    def __call__(self, arguments: dict) -> dict:
        # The path, page, and argv format are controlled by this validation work
        # package. Nothing in MCP input can select a command, output file or URL.
        if not NATIVE.is_file():
            raise ToolFailure("页面读取暂不可用")
        directory = tempfile.mkdtemp(prefix="native-call-", dir=ROOT)
        try:
            result_path = Path(directory) / "result.json"
            started_ms = int(time.time() * 1000)
            completed = subprocess.run(
                [str(NATIVE), str(result_path), arguments["requestId"],
                 arguments["taskKey"], arguments["label"], str(arguments["revision"])],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=25, check=False,
            )
            if completed.returncode != 0 or not result_path.is_file():
                raise ToolFailure("页面读取未完成")
            if result_path.stat().st_size > 100000:
                raise ToolFailure("页面读取结果无法核对")
            receipt = json.loads(result_path.read_text())
            if receipt.get("pass") is not True or receipt.get("observedAtMs", 0) < started_ms:
                raise ToolFailure("页面读取结果无法核对")
            # Native extra checks remain in separate browser evidence; only the
            # explicit page snapshot crosses this narrow tool response boundary.
            return receipt
        finally:
            # Evidence contains only this probe's synthetic page and checks.
            # Preserve the current native result, never substitute prior output.
            print(json.dumps({"nativeEvidence": str(Path(directory) / "result.json"),
                              "requestId": arguments["requestId"]}), file=sys.stderr, flush=True)


def tool_descriptor():
    return {
        "name": "read_page_snapshot",
        "description": "Read the currently granted synthetic validation page once.",
        "inputSchema": {
            "type": "object", "additionalProperties": False,
            "properties": {
                "requestId": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
                "taskKey": {"type": "string", "const": SCOPE["taskKey"]},
                "label": {"type": "string", "const": SCOPE["label"]},
                "revision": {"type": "integer", "const": SCOPE["revision"]},
            }, "required": sorted(FIELDS),
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False,
                        "idempotentHint": True, "openWorldHint": False},
    }


class Peer:
    def __init__(self, reader: ControlledRead):
        self.reader = reader
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
                      "serverInfo": {"name": "farfold-controlled-page-probe", "version": "0.0.0"}}
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
                snapshot = self.reader.read(params["arguments"])
                result = {"content": [{"type": "text", "text": json.dumps(snapshot, ensure_ascii=False)}],
                          "structuredContent": snapshot, "isError": False}
            except ToolFailure as error:
                result = {"content": [{"type": "text", "text": str(error)}], "isError": True}
        else:
            return self.error(request_id, -32601, "Method not found")
        return {"jsonrpc": "2.0", "id": request_id, "result": result}


def serve(peer: Peer):
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not line:
            break
        if len(line) > MAX_LINE:
            response = peer.error(None, -32600, "Request too large")
            print(json.dumps(response), flush=True)
            break
        try:
            message = json.loads(line)
        except (ValueError, UnicodeError):
            response = peer.error(None, -32700, "Parse error")
        else:
            response = peer.handle(message)
        if response is not None:
            print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    serve(Peer(ControlledRead(NativeBackend())))
