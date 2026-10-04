"""Synthetic AF_UNIX fixture checks; no native application, network or Agent."""
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from page_server import ARG_FIELDS, Peer, SCOPE, SocketBackend, ToolFailure, consume_capability

CAPABILITY = "a" * 64  # Only this test's synthetic token, never a real credential.


def arguments(**changes):
    return {"requestId": "fixture-read", **SCOPE, **changes}


def snapshot(args):
    return {"ok": True, **args, "instanceId": "fixture-instance", "revision": 1, "readId": 1,
        "nativeReadCount": 1, "nativeCreateCount": 1, "sameNativeInstance": True,
        "url": "about:blank", "title": "Fixture",
        "text": "Fixture body", "observedAtMs": int(time.time() * 1000)}


class FixtureSocket:
    def __init__(self, callback):
        self.directory = tempfile.TemporaryDirectory(prefix="ff-mcp-test-")
        self.path = Path(self.directory.name) / "s"
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(str(self.path))
        os.chmod(self.path, 0o600)
        self.socket.listen(1)
        self.requests = []
        def run():
            connection, _ = self.socket.accept()
            with connection, connection.makefile("rb") as stream:
                request = json.loads(stream.readline())
                self.requests.append(request)
                connection.sendall(json.dumps(callback(request)).encode() + b"\n")
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def close(self):
        self.socket.close()
        self.thread.join(timeout=1)
        self.directory.cleanup()


class BackendTests(unittest.TestCase):
    def with_fixture(self, callback):
        fixture = FixtureSocket(callback)
        self.addCleanup(fixture.close)
        return fixture, SocketBackend(fixture.path, CAPABILITY)

    def test_current_result_and_private_auth_never_appear_in_dto(self):
        fixture, backend = self.with_fixture(lambda request: snapshot(arguments()))
        result = backend.read(arguments())
        self.assertEqual(result["text"], "Fixture body")
        self.assertEqual(fixture.requests[0]["capability"], CAPABILITY)
        self.assertEqual(fixture.requests[0]["op"], "snapshot")
        self.assertNotIn("capability", result)

    def test_host_revoke_and_close_errors_do_not_return_snapshot(self):
        for error in ("REVOKED", "CLOSED"):
            with self.subTest(error=error):
                _, backend = self.with_fixture(lambda request: {"ok": False, "error": error})
                with self.assertRaises(ToolFailure):
                    backend.read(arguments())

    def test_response_scope_and_identity_must_match(self):
        _, backend = self.with_fixture(lambda request: snapshot(arguments(requestId="old-read")))
        with self.assertRaises(ToolFailure):
            backend.read(arguments())

    def test_unexpected_page_and_creation_count_rejected(self):
        for change in ({"url": "https://example.invalid"}, {"nativeCreateCount": 2}, {"sameNativeInstance": False}):
            with self.subTest(change=change):
                _, backend = self.with_fixture(lambda request: {**snapshot(arguments()), **change})
                with self.assertRaises(ToolFailure):
                    backend.read(arguments())

    def test_extra_inputs_and_wrong_scope_rejected_without_socket(self):
        backend = SocketBackend(Path("/missing-synthetic-socket"), CAPABILITY)
        for change in ({"taskKey": "wrong"}, {"generation": True}, {"path": "any"},
                       {"url": "any"}, {"eval": "any"}, {"command": "any"}):
            with self.subTest(change=change), self.assertRaises(ToolFailure):
                backend.read(arguments(**change))

    def test_bad_socket_permissions_rejected_before_connect(self):
        with tempfile.TemporaryDirectory(prefix="ff-mcp-mode-") as directory:
            path = Path(directory) / "s"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(path))
                os.chmod(path, 0o666)
                with self.assertRaises(ToolFailure):
                    SocketBackend(path, CAPABILITY).read(arguments())

    def test_transport_failure_returns_fixed_error_without_auth(self):
        backend = SocketBackend(Path("/missing-synthetic-socket"), CAPABILITY)
        with self.assertRaises(ToolFailure) as raised:
            backend.read(arguments())
        self.assertNotIn(CAPABILITY, str(raised.exception))
        self.assertNotIn("missing-synthetic", str(raised.exception))

    def test_capability_consumed_only_from_separate_pipe(self):
        reader, writer = os.pipe()
        os.write(writer, (CAPABILITY + "\n").encode())
        os.close(writer)
        self.assertEqual(consume_capability(reader), CAPABILITY)
        with self.assertRaises(OSError):
            os.fstat(reader)


class ProtocolTests(unittest.TestCase):
    def test_only_read_tool_exposed_after_initialization(self):
        peer = Peer(None)
        self.assertIn("error", peer.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        init = peer.handle({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "test", "version": "0"}}})
        self.assertEqual(init["result"]["capabilities"], {"tools": {}})
        peer.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = peer.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})["result"]["tools"]
        self.assertEqual([tool["name"] for tool in tools], ["read_page_snapshot"])
        self.assertEqual(set(tools[0]["inputSchema"]["properties"]), ARG_FIELDS)
        for name in ("mutate", "revoke", "close", "eval"):
            result = peer.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                                  "params": {"name": name, "arguments": {}}})
            self.assertEqual(result["error"]["code"], -32602)


if __name__ == "__main__":
    unittest.main(verbosity=2)
