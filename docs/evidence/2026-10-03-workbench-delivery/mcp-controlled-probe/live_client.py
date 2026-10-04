"""One explicit controlled MCP client run; invokes the real synthetic page once."""
import json
import select
import subprocess
import sys
import time
from pathlib import Path

from page_server import PROTOCOL_VERSION, ROOT, SCOPE


def main():
    run_id = "mcp-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    evidence = ROOT / (run_id + ".json")
    # Refuse overwriting existing evidence before any native work.
    with evidence.open("x") as output:
        log = {"kind": "controlled-MCP-to-current-real-native-page", "runId": run_id,
               "realAgent": False, "productionSharing": False, "requests": [], "responses": [], "pass": False}
        process = subprocess.Popen([sys.executable, str(ROOT / "page_server.py")],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            def send(method, params=None, request_id=None):
                message = {"jsonrpc": "2.0", "method": method}
                if params is not None:
                    message["params"] = params
                if request_id is not None:
                    message["id"] = request_id
                log["requests"].append({"atMs": int(time.time() * 1000), "message": message})
                process.stdin.write((json.dumps(message) + "\n").encode())
                process.stdin.flush()
                if request_id is None:
                    return None
                if not select.select([process.stdout], [], [], 30)[0]:
                    raise RuntimeError("controlled response deadline exceeded")
                response = json.loads(process.stdout.readline())
                log["responses"].append({"atMs": int(time.time() * 1000), "message": response})
                assert response["id"] == request_id and response["jsonrpc"] == "2.0"
                return response

            initialization = send("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                "clientInfo": {"name": "farfold-controlled-client", "version": "0.0.0"}}, 1)
            assert initialization["result"]["protocolVersion"] == PROTOCOL_VERSION
            send("notifications/initialized")
            tool_list = send("tools/list", {}, 2)
            assert [tool["name"] for tool in tool_list["result"]["tools"]] == ["read_page_snapshot"]
            args = {"requestId": run_id, **SCOPE}
            def call(a, i):
                return send("tools/call", {"name": "read_page_snapshot", "arguments": a}, i)["result"]
            assert call({**args, "taskKey": "not-granted"}, 3)["isError"] is True
            assert call({**args, "revision": 0}, 4)["isError"] is True
            result = call(args, 5)
            assert result["isError"] is False, result
            snapshot = result["structuredContent"]
            assert json.loads(result["content"][0]["text"]) == snapshot
            assert snapshot["requestId"] == run_id
            assert snapshot["title"] == "Controlled seam page"
            assert "Controlled browser seam 42" in snapshot["text"]
            assert "SYNTHETIC_INPUT" not in snapshot["text"]
            assert call({**args, "requestId": run_id + "-closed"}, 6)["isError"] is True
            process.stdin.close()
            assert process.wait(timeout=5) == 0
            log["nativeEvidence"] = [json.loads(line) for line in process.stderr.read().decode().splitlines()]
            assert len(log["nativeEvidence"]) == 1
            native = json.loads(Path(log["nativeEvidence"][0]["nativeEvidence"]).read_text())
            assert native["pass"] is True and all(c["pass"] for c in native["checks"])
            assert native["parent"]["invokeRoundTrip"] is True
            assert native["parent"]["channelRoundTrip"] is True
            assert native["requestId"] == run_id
            log["nativeCheckCount"] = len(native["checks"])
            log["pass"] = True
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            json.dump(log, output, ensure_ascii=False, indent=2)
    print(json.dumps({"pass": log["pass"], "evidence": str(evidence),
                      "nativeCheckCount": log.get("nativeCheckCount")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
