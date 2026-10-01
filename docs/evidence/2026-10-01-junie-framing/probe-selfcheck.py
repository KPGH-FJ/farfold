"""Pure in-memory checks. Never spawn, download, inspect user data, or import Junie."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("framing_probe", BASE / "initialize-framing-probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FramingChecks(unittest.TestCase):
    def test_valid_result_is_shape_only(self):
        raw = json.dumps({"id": probe.REQUEST["id"], "result": {"secret": "CANARY"}}).encode()
        result = probe.classify(raw, True)
        self.assertEqual(result["messageShape"], "initialize_result")
        self.assertNotIn("CANARY", json.dumps(result))
        self.assertNotIn(probe.REQUEST["id"], json.dumps(result))

    def test_non_json_canary_has_only_fixed_shape(self):
        result = probe.classify(b"CANARY-private-output", True)
        self.assertEqual(result["jsonSyntax"], "expected_value")
        self.assertNotIn("CANARY", json.dumps(result))

    def test_truncated_object_marks_eof_position(self):
        result = probe.classify(b'{"public":', False)
        self.assertEqual(result["jsonErrorOffset"], 10)
        self.assertTrue(result["errorAtEnd"])
        self.assertFalse(result["newlineTerminated"])

    def test_bom_is_observed_without_stripping(self):
        result = probe.classify(b"\xef\xbb\xbf{}", True)
        self.assertTrue(result["bomAtStart"])
        self.assertEqual(result["jsonSyntax"], "bom_rejected")

    def test_invalid_utf8_has_no_decode_error_body(self):
        result = probe.classify(b"ok\xffCANARY", False)
        self.assertFalse(result["utf8"])
        self.assertEqual(result["utf8ErrorOffset"], 2)
        self.assertNotIn("CANARY", json.dumps(result))

    def test_blank_crlf_and_escape_are_fixed_flags(self):
        self.assertTrue(probe.classify(b" \r", True)["blank"])
        self.assertTrue(probe.classify(b"{}\r", True)["carriageReturnAtEnd"])
        self.assertTrue(probe.classify(b"\x1b[31mCANARY", True)["ansiEscape"])

    def test_nonstandard_python_constants_rejected(self):
        for raw in (b"NaN", b"Infinity", b"-Infinity"):
            self.assertEqual(probe.classify(raw, True)["jsonSyntax"], "constant_or_depth_rejected")

    def test_python_shape_is_not_sdk_acceptance(self):
        # Python permits these; no claim is made that serde/schema accept them.
        for raw in (b"1e400", b'"\\ud800"', b'{"id":"other","result":[]}'):
            self.assertEqual(probe.classify(raw, True)["jsonSyntax"], "valid_json")
        self.assertEqual(probe.classify(b"[" * 129 + b"0" + b"]" * 129, True)["jsonSyntax"], "valid_json")

    def test_request_and_batch_stop_without_response(self):
        for raw, expected in ((b'{"id":7,"method":"CANARY"}\n', "request"),
                              (b"[]\n", "batch_not_handled")):
            capture = probe.Capture()
            capture.feed("stdout", raw)
            self.assertEqual(capture.stop, expected)
            self.assertNotIn("CANARY", json.dumps(capture.records))

    def test_split_input_preserves_real_line_boundary(self):
        capture = probe.Capture()
        capture.feed("stdout", b'{"x":')
        self.assertEqual(capture.records, [])
        capture.feed("stdout", b'1}\nlast')
        capture.finish()
        self.assertEqual(len(capture.records), 2)
        self.assertEqual(capture.records[0]["jsonSyntax"], "valid_json")
        self.assertFalse(capture.records[1]["newlineTerminated"])

    def test_limits_and_stderr_never_become_protocol_actions(self):
        capture = probe.Capture()
        capture.feed("stderr", b'{"id":7,"method":"CANARY"}\n')
        self.assertIsNone(capture.stop)
        capture.feed("stdout", b"a" * (probe.MAX_LINE + 1))
        self.assertEqual(capture.stop, "line_limit")
        self.assertEqual(capture.buffers["stdout"], b"")

    def test_wire_defaults_match_schema_and_old_length(self):
        capabilities = probe.REQUEST["params"]["clientCapabilities"]
        self.assertEqual(capabilities["fs"], {"readTextFile": False, "writeTextFile": False})
        self.assertFalse(capabilities["terminal"])
        self.assertEqual(capabilities["auth"], {"terminal": True})
        self.assertEqual(capabilities["elicitation"], {"form": {}})
        self.assertEqual(len(json.dumps(probe.REQUEST, separators=(",", ":")).encode()), 404)


if __name__ == "__main__":
    unittest.main()
