"""Read one specified native conversation and content-free protocol metadata.

Does not launch an Agent, inspect configuration, or persist raw error text.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path


SESSION_ID = "01a0f211-a0f1-7194-a8fe-83a72f89f70f"
USER_ROOT = Path("/Users/tw")
CWD = USER_ROOT / "Library/Application Support/ai.farfold.desktop/conversations"
MAPPING = USER_ROOT / ".pi/pi-acp/session-map.json"
NATIVE = USER_ROOT / (
    ".pi/agent/sessions/"
    "--Users-tw-Library-Application Support-ai.farfold.desktop-conversations--/"
    "2026-09-30T11-27-16-721Z_" + SESSION_ID + ".jsonl"
)
PROTOCOL = USER_ROOT / "Library/Logs/Farfold/protocol-v1-1790767636450-5.jsonl"
EXPECTED_TIMESTAMP = "2026-09-30T11:27:48.585Z"
EVENTS = {
    "initialize", "authenticate", "session/new", "session/load", "session/prompt",
    "session/update", "session/cancel", "session/request_permission",
    "session/set_config_option", "session/list", "response", "other",
}


def collect():
    mapping = json.loads(MAPPING.read_text())
    selected = mapping["sessions"][SESSION_ID]
    assert selected["sessionId"] == SESSION_ID, "Target mapping changed"
    assert selected["cwd"] == str(CWD), "Target directory changed"
    assert selected["sessionFile"] == str(NATIVE), "Target file changed"
    rows = [json.loads(line) for line in NATIVE.read_text().splitlines()]
    assert rows[0]["id"] == SESSION_ID, "Native identity changed"
    assert rows[0]["cwd"] == str(CWD), "Native directory changed"
    matched = [
        (index + 1, row) for index, row in enumerate(rows)
        if row.get("timestamp") == EXPECTED_TIMESTAMP
        and row.get("type") == "message"
        and row.get("message", {}).get("role") == "assistant"
    ]
    assert len(matched) == 1, "Expected assistant result was not unique"
    line, row = matched[0]
    message = row["message"]
    error = message.get("errorMessage", "")
    assert isinstance(error, str), "Unexpected native error shape"
    leading_status = re.match(r"\s*([45][0-9]{2})(?=\s|:|\{|$)", error)
    # Agent errors can embed a quoted object representation rather than JSON.
    # Match only this fixed field and known labels; never emit other values.
    code = next((candidate for candidate in (
        "invalid_request_error", "authentication_error", "permission_error",
        "rate_limit_error", "insufficient_quota", "server_error",
    ) if re.search(r"[\"']code[\"']\s*:\s*[\"']" + candidate + r"[\"']", error)), None)
    safe_events = []
    for raw in PROTOCOL.read_text().splitlines():
        record = json.loads(raw)
        assert record["version"] == 1, "Unexpected metadata version"
        assert record["dir"] in {"in", "out", "err"}, "Unexpected direction"
        assert record["event"] in EVENTS, "Unexpected metadata event"
        assert record["error"] in {"none", "stderr", "protocol"}, "Unexpected category"
        assert type(record["ts"]) is int and type(record["bytes"]) is int
        safe_events.append({
            "timestampUtc": datetime.fromtimestamp(
                record["ts"] / 1000, timezone.utc
            ).isoformat(timespec="milliseconds"),
            **{key: record[key] for key in ("dir", "event", "bytes", "error")},
        })
    return {
        "readAtUtc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "candidateFromInstalledValidation": "6b02dae",
        "nativeSessionId": SESSION_ID,
        "nativeFile": str(NATIVE),
        "nativeFileBytesAtRead": NATIVE.stat().st_size,
        "nativeResult": {
            "line": line,
            "timestampUtc": EXPECTED_TIMESTAMP,
            "stopReason": message.get("stopReason")
            if message.get("stopReason") in {"error", "stop", "length", "aborted"}
            else "other",
            "contentCount": len(message.get("content", [])),
            "providerMatchesSelectedDeepseek": message.get("provider") == "deepseek",
            "leadingHttpStatus": int(leading_status[1]) if leading_status else None,
            "allowlistedErrorCode": code,
        },
        "protocolFile": str(PROTOCOL),
        "protocolMetadata": safe_events,
        "rawErrorPersisted": False,
        "configurationRead": False,
        "agentExecuted": False,
    }


if __name__ == "__main__":
    try:
        result = collect()
        output = Path(__file__).with_name("safe-request.json")
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print("Saved allowlisted request evidence")
    except Exception as error:
        print("Extraction stopped: " + type(error).__name__)
        raise SystemExit(1) from None
