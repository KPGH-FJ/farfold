"""Protocol fixtures only; this suite never launches native apps or Agents."""
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path

from page_server import ControlledRead, FIELDS, Peer, PROTOCOL_VERSION, SCOPE, ToolFailure


def arguments(**changes):
    return {"requestId": "controlled-read-1", **SCOPE, **changes}


def snapshot(args):
    return {**args, "url": "about:blank", "title": "Fixture only", "text": "synthetic fixture",
            "observedAtMs": int(time.time() * 1000)}


def request(method, params=None, request_id=1):
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}


def initialize(peer):
    result = peer.handle(request("initialize", {
        "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
        "clientInfo": {"name": "fixture-client", "version": "0"},
    }))
    peer.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
    return result


class ReadTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def backend(args):
            self.calls.append(args)
            return snapshot(args)
        self.read = ControlledRead(backend)

    def test_authorized_result_is_explicit_and_one_shot(self):
        result = self.read.read(arguments())
        self.assertEqual(result["text"], "synthetic fixture")
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(ToolFailure):
            self.read.read(arguments(requestId="again-after-close"))
        self.assertEqual(len(self.calls), 1)

    def test_wrong_task_label_revision_rejected_before_backend(self):
        for changed in ({"taskKey": "other"}, {"label": "other"}, {"revision": 0}):
            with self.subTest(changed=changed), self.assertRaises(ToolFailure):
                self.read.read(arguments(**changed))
        self.assertEqual(self.calls, [])

    def test_extra_url_eval_and_path_rejected_before_backend(self):
        for field in ("url", "javascript", "path", "command"):
            with self.subTest(field=field), self.assertRaises(ToolFailure):
                self.read.read(arguments(**{field: "untrusted-extra"}))
        self.assertEqual(self.calls, [])

    def test_boolean_revision_and_invalid_id_rejected(self):
        for changed in ({"revision": True}, {"requestId": "../result"}, {"requestId": ""}):
            with self.subTest(changed=changed), self.assertRaises(ToolFailure):
                self.read.read(arguments(**changed))
        self.assertEqual(self.calls, [])

    def test_revoked_before_read_never_calls_backend(self):
        self.read.revoke()
        with self.assertRaises(ToolFailure):
            self.read.read(arguments())
        self.assertEqual(self.calls, [])

    def test_revoked_while_submitted_discards_result(self):
        def backend(args):
            self.read.revoke()
            return snapshot(args)
        self.read.backend = backend
        with self.assertRaises(ToolFailure):
            self.read.read(arguments())
        self.assertIsNone(self.read.grant)

    def test_pause_resume_cannot_accept_prior_submitted_read(self):
        def backend(args):
            self.read.revoke()
            self.read.grant_again_for_test()
            return snapshot(args)
        self.read.backend = backend
        with self.assertRaises(ToolFailure):
            self.read.read(arguments())
        self.assertIsNotNone(self.read.grant)

    def test_mismatched_receipt_cannot_escape(self):
        self.read.backend = lambda args: snapshot({**args, "revision": 2})
        with self.assertRaises(ToolFailure):
            self.read.read(arguments())

    def test_unexpected_url_cannot_escape(self):
        self.read.backend = lambda args: {**snapshot(args), "url": "https://example.invalid"}
        with self.assertRaises(ToolFailure):
            self.read.read(arguments())

    def test_arbitrary_backend_error_not_returned(self):
        def failed(args):
            raise RuntimeError("SYNTHETIC_SECRET_CANARY")
        self.read.backend = failed
        with self.assertRaises(ToolFailure) as raised:
            self.read.read(arguments())
        self.assertNotIn("CANARY", str(raised.exception))

    def test_submitted_failure_consumes_one_shot_grant(self):
        calls = []
        def failed(args):
            calls.append(args)
            raise RuntimeError("synthetic timeout")
        self.read.backend = failed
        for _ in range(2):
            with self.assertRaises(ToolFailure):
                self.read.read(arguments())
        self.assertEqual(len(calls), 1)

    def test_invalid_receipt_consumes_one_shot_grant(self):
        calls = []
        def invalid(args):
            calls.append(args)
            return {"incomplete": True}
        self.read.backend = invalid
        for _ in range(2):
            with self.assertRaises(ToolFailure):
                self.read.read(arguments())
        self.assertEqual(len(calls), 1)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.peer = Peer(ControlledRead(snapshot))

    def test_initialize_required_and_notification_completes_negotiation(self):
        self.assertEqual(self.peer.handle(request("tools/list"))["error"]["code"], -32002)
        result = initialize(self.peer)["result"]
        self.assertEqual(result["protocolVersion"], PROTOCOL_VERSION)
        self.assertEqual(result["capabilities"], {"tools": {}})

    def test_list_exposes_only_constrained_read(self):
        initialize(self.peer)
        tools = self.peer.handle(request("tools/list"))["result"]["tools"]
        self.assertEqual([t["name"] for t in tools], ["read_page_snapshot"])
        self.assertEqual(set(tools[0]["inputSchema"]["properties"]), FIELDS)
        self.assertFalse(tools[0]["inputSchema"]["additionalProperties"])

    def test_call_returns_equal_text_and_structured_content(self):
        initialize(self.peer)
        result = self.peer.handle(request("tools/call", {
            "name": "read_page_snapshot", "arguments": arguments()
        }))["result"]
        self.assertFalse(result["isError"])
        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])

    def test_scope_failure_is_tool_error_without_snapshot(self):
        initialize(self.peer)
        result = self.peer.handle(request("tools/call", {
            "name": "read_page_snapshot", "arguments": arguments(taskKey="wrong")
        }))["result"]
        self.assertTrue(result["isError"])
        self.assertNotIn("structuredContent", result)

    def test_unknown_tools_and_methods_are_protocol_errors(self):
        initialize(self.peer)
        self.assertEqual(self.peer.handle(request("tools/call", {
            "name": "evaluate", "arguments": {}
        }))["error"]["code"], -32602)
        self.assertEqual(self.peer.handle(request("sampling/createMessage"))["error"]["code"], -32601)

    def test_stdio_utf8_and_jsonrpc_only_without_native_launch(self):
        messages = [request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                     "clientInfo": {"name": "stdio-fixture", "version": "0"}}),
                    {"jsonrpc": "2.0", "method": "notifications/initialized"}, request("tools/list"),
                    request("tools/call", {"name": "read_page_snapshot", "arguments": arguments(taskKey="wrong")})]
        done = subprocess.run([sys.executable, str(Path(__file__).with_name("page_server.py"))],
                              input="".join(json.dumps(m) + "\n" for m in messages), text=True,
                              capture_output=True, timeout=5, check=True)
        responses = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual(len(responses), 3)
        self.assertTrue(responses[-1]["result"]["isError"])
        self.assertEqual(done.stderr, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
