"""Synthetic byte fixtures and static public-source checks; never runs an Agent."""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import textwrap
import unittest

from stderr_classifier import LIMIT, TEMPLATES, classify_stderr


PUBLIC_ROOT = Path(
    "/Users/tw/Library/Application Support/ai.farfold.desktop/uv/cache/archive-v0/"
    "OQ2oi8KstG9JTZc2/fast_agent"
)


class ClassifierTests(unittest.TestCase):
    def test_static_headings_and_suggestions_exist_in_official_0101_source(self):
        source = (PUBLIC_ROOT / "core/fastagent.py").read_text()
        literal_strings = {
            node.value for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        for heading, suggestion in TEMPLATES.values():
            self.assertIn(heading[:-1], literal_strings)
            if suggestion:
                self.assertIn(suggestion, literal_strings)

    def test_every_fixed_heading_and_pair(self):
        for key, (heading, suggestion) in TEMPLATES.items():
            with self.subTest(key=key):
                message = "\n" + heading + "\nSYNTHETIC_PRIVATE_MESSAGE\n"
                if suggestion:
                    message += "\n" + suggestion + "\n"
                result = classify_stderr(message.encode())
                self.assertEqual(result["matchedFixedHeadingIds"], [key])
                self.assertEqual(result["matchedFixedHeadingAndSuggestionIds"], [key] if suggestion else [])
                self.assertNotIn("SYNTHETIC_PRIVATE_MESSAGE", json.dumps(result))

    def test_ansi_and_wrapped_fixed_suggestion(self):
        heading, suggestion = TEMPLATES["provider_configuration"]
        message = "\x1b[1;31m" + heading + "\x1b[0m\nPRIVATE\n" + textwrap.fill(suggestion, 45)
        result = classify_stderr(message.encode())
        self.assertEqual(result["matchedFixedHeadingAndSuggestionIds"], ["provider_configuration"])

    def test_hyperlink_target_is_not_retained(self):
        message = "\x1b]8;;https://private.invalid/?token=SYNTHETIC_KEY\x07Model Configuration Error:\x1b]8;;\x07\n"
        result = classify_stderr(message.encode())
        self.assertEqual(result["matchedFixedHeadingIds"], ["model_configuration"])
        self.assertNotIn("SYNTHETIC_KEY", json.dumps(result))
        self.assertNotIn("private.invalid", json.dumps(result))

    def test_rich_click_panel_is_only_format_not_a_cause(self):
        result = classify_stderr("╭─ Error ─────────╮\n│ PRIVATE VALUE │\n╰────────────────╯\n".encode())
        self.assertEqual(result["formatMarkers"], ["rich_error_panel"])
        self.assertTrue(result["categoryUnclassified"])

    def test_plain_click_message_is_only_format(self):
        result = classify_stderr(b"Error: Invalid value for PRIVATE: SYNTHETIC_KEY\n")
        self.assertEqual(result["formatMarkers"], ["plain_error_prefix"])
        self.assertTrue(result["categoryUnclassified"])
        self.assertNotIn("SYNTHETIC_KEY", json.dumps(result))

    def test_quoted_or_embedded_heading_is_not_accepted(self):
        for message in [b"message includes Provider Configuration Error:\n", b"'Provider Configuration Error:'\n"]:
            self.assertEqual(classify_stderr(message)["matchedFixedHeadingIds"], [])

    def test_heading_without_suggestion_does_not_claim_pair(self):
        result = classify_stderr(b"Provider Configuration Error:\nPRIVATE\n")
        self.assertEqual(result["matchedFixedHeadingAndSuggestionIds"], [])

    def test_public_exception_class_without_message_or_unknown_class(self):
        result = classify_stderr(b"ProviderKeyError: SYNTHETIC_KEY\nPrivateClass: OTHER_PRIVATE\n")
        self.assertEqual(result["observedPublicExceptionClasses"], ["ProviderKeyError"])
        self.assertNotIn("SYNTHETIC_KEY", json.dumps(result))
        self.assertNotIn("PrivateClass", json.dumps(result))

    def test_source_code_and_body_containing_class_name_are_not_traceback_class(self):
        result = classify_stderr(b"raise ProviderKeyError: PRIVATE\ncomment ModelConfigError: PRIVATE\n")
        self.assertEqual(result["observedPublicExceptionClasses"], [])

    def test_dynamic_body_content_never_changes_observed_marker_ids(self):
        heading, suggestion = TEMPLATES["generic_error"]
        bodies = ["secret=X", "/Users/private/file.yaml", "https://private.invalid/?token=Y", "A" * 10000]
        results = []
        for body in bodies:
            result = classify_stderr((heading + "\n" + body + "\n" + suggestion).encode())
            result.pop("inputBytes")
            results.append(result)
        self.assertTrue(all(result == results[0] for result in results))

    def test_bounded_input_does_not_find_tail_markers(self):
        result = classify_stderr(b"x" * LIMIT + b"\nModel Configuration Error:\n")
        self.assertTrue(result["classificationInputTruncated"])
        self.assertEqual(result["matchedFixedHeadingIds"], [])

    def test_empty_and_invalid_utf8_are_unknown(self):
        for data in [b"", b"\xff\xfe\x00"]:
            self.assertTrue(classify_stderr(data)["categoryUnclassified"])

    def test_server_stop_and_traceback_formats_do_not_classify_unknown_body(self):
        result = classify_stderr(b"Traceback (most recent call last):\nServer stopped with error: PRIVATE\n")
        self.assertEqual(result["formatMarkers"], ["fast_agent_server_stop_prefix", "python_traceback_header"])
        self.assertTrue(result["categoryUnclassified"])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ClassifierTests)
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    receipt = {
        "scope": "Synthetic classifier fixtures and static cached official-source AST only; no Agent imports or execution",
        "testsRun": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "success": result.wasSuccessful(),
        "sourceVersion": "fast-agent-mcp 0.10.1",
        "sourceSha256": hashlib.sha256((PUBLIC_ROOT / "core/fastagent.py").read_bytes()).hexdigest(),
    }
    Path(__file__).with_name("classifier-tests.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    raise SystemExit(0 if result.wasSuccessful() else 1)
